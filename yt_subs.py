#!/usr/bin/env python3
"""
YouTube -> Markdown subtitles.

The program expects only a link: a video or a playlist.
Subtitle track selection rules:
  1. Detect the video's native language.
  2. Target language: ru if the video is Russian, otherwise en.
  3. Priority: manual (author) subtitles in the target language ->
     automatic subtitles in the target language -> fallback options.
Result: a .md file in the Downloads folder (playlist -> subfolder named after it).
"""

import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError
except ImportError:
    print("yt-dlp is not installed. Run:  python -m pip install -U yt-dlp")
    sys.exit(1)


# ---------------------------------------------------------------- paths

def downloads_dir():
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                val, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
                path = os.path.expandvars(val)
                if os.path.isdir(path):
                    return path
        except OSError:
            pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def safe_name(text, limit=90):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", text or "")
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:limit].strip(" .") or "video"


def settings_path():
    """Per-user config file location, outside the project folder (so it's
    never accidentally committed to git and survives moving/updating the script)."""
    base = os.environ.get("APPDATA") if os.name == "nt" else None
    base = base or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "yt_subs", "settings.json")


def load_settings():
    try:
        with open(settings_path(), encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(settings):
    path = settings_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, indent=2)


# ---------------------------------------------------------------- track selection

def base_lang(code):
    return (code or "").split("-")[0].split("_")[0].lower()


def detect_language(info):
    """The video's native language."""
    lang = info.get("language")
    if lang:
        return base_lang(lang)
    # for multi-language videos, the original auto track carries an -orig suffix
    for code in info.get("automatic_captions") or {}:
        if code.endswith("-orig"):
            return base_lang(code)
    subs = [c for c in (info.get("subtitles") or {}) if c != "live_chat"]
    if len(subs) == 1:
        return base_lang(subs[0])
    return "en"


def match_lang(tracks, target, orig_first):
    """Key of the track in the given language; None if that language isn't present."""
    keys = [k for k in tracks if k != "live_chat" and base_lang(k) == target]
    if not keys:
        return None
    if orig_first:
        for k in keys:
            if k.endswith("-orig"):
                return k
    for k in keys:                      # exact match: ru, en
        if k.lower() == target:
            return k
    return sorted(keys, key=len)[0]


def choose_track(info, native, target_lang=None):
    """(language code, format list, label) following the priority rules.

    target_lang overrides the default ru/en target with any language code
    (e.g. "fr", "es", "de") — see --lang in main()."""
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    target = base_lang(target_lang) if target_lang else ("ru" if native == "ru" else "en")
    is_native = native == target

    plan = [
        (match_lang(subs, target, False), subs, "manual"),
        (match_lang(autos, target, is_native), autos, "automatic"),
    ]
    if not is_native:                   # the target language may not exist at all
        plan += [
            (match_lang(subs, native, False), subs, "manual (native language)"),
            (match_lang(autos, native, True), autos, "automatic (native language)"),
        ]
    for key, store, label in plan:
        if key:
            return key, store[key], label

    for store, label in ((subs, "manual (other language)"), (autos, "automatic (other language)")):
        keys = [k for k in store if k != "live_chat"]
        if keys:
            k = sorted(keys, key=len)[0]
            return k, store[k], label
    return None, None, None


def pick_format(track):
    for ext in ("json3", "srv3", "vtt", "ttml", "srv1"):
        for fmt in track:
            if fmt.get("ext") == ext and fmt.get("url"):
                return fmt
    return next((f for f in track if f.get("url")), None)


# ---------------------------------------------------------------- subtitle parsing

TAG = re.compile(r"<[^>]+>")


def parse_json3(raw):
    data = json.loads(raw)
    cues = []
    for ev in data.get("events") or []:
        if ev.get("aAppend"):           # internal "appends" to the rolling caption line
            continue
        text = "".join(s.get("utf8", "") for s in ev.get("segs") or [])
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            cues.append((ev.get("tStartMs", 0) / 1000.0, text))
    return cues


def to_seconds(value):
    parts = [float(p) for p in value.replace(",", ".").split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def parse_vtt(raw):
    cues, start, buf = [], None, []

    def flush():
        if start is None:
            return
        text = re.sub(r"\s+", " ", " ".join(buf)).strip()
        if text and (not cues or cues[-1][1] != text):
            cues.append((start, text))

    for line in raw.splitlines():
        line = line.strip()
        if "-->" in line:
            flush()
            start, buf = to_seconds(line.split("-->")[0].strip().split()[0]), []
        elif not line:
            flush()
            start, buf = None, []
        elif start is not None and not line.startswith(("WEBVTT", "NOTE", "Kind:", "Language:")):
            buf.append(TAG.sub("", line))
    flush()

    result = []                         # rolling auto-captions duplicate lines
    for t, text in cues:
        if result and text in result[-1][1]:
            continue
        if result and result[-1][1] in text:
            result[-1] = (result[-1][0], text)
            continue
        result.append((t, text))
    return result


ENTITIES = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " "}


def parse_xml(raw):
    cues = []
    for m in re.finditer(r"<(?:text|p)[^>]*?\b(start|begin|t)=\"([^\"]+)\"[^>]*>(.*?)</(?:text|p)>", raw, re.S):
        attr, value = m.group(1), m.group(2)
        if ":" in value:                # 00:01:05.500 (ttml)
            secs = to_seconds(value)
        else:                           # t="1500" is milliseconds (srv3),
            number = float(re.sub(r"[^\d.]", "", value) or 0)   # start="4"/"4s" is seconds
            secs = number / 1000.0 if attr == "t" else number
        text = re.sub(r"\s+", " ", TAG.sub(" ", m.group(3))).strip()
        for k, v in ENTITIES.items():
            text = text.replace(k, v)
        if text:
            cues.append((secs, text))
    return cues


def parse_subtitles(raw, ext):
    if ext == "json3":
        return parse_json3(raw)
    if ext in ("vtt", "srt"):
        return parse_vtt(raw)
    return parse_xml(raw)


# ---------------------------------------------------------------- markdown

def hhmmss(seconds):
    seconds = int(seconds)
    h, m, s = seconds // 3600, seconds % 3600 // 60, seconds % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def paragraphs(cues, soft=480, hard=900, gap=4.0):
    out, buf, start, prev = [], [], None, None
    for t, text in cues:
        if start is None:
            start = t
        length = sum(len(x) + 1 for x in buf)
        big_gap = prev is not None and t - prev > gap and length > 200
        ends_sentence = bool(buf) and buf[-1][-1:] in ".!?…»\"'"
        if buf and (length >= hard or (length >= soft and ends_sentence) or big_gap):
            out.append((start, " ".join(buf)))
            buf, start = [], t
        buf.append(text)
        prev = t
    if buf:
        out.append((start, " ".join(buf)))
    return out


def build_markdown(info, cues, native, lang, label, timestamps=True):
    upload = info.get("upload_date") or ""
    if len(upload) == 8:
        upload = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}"
    lines = [
        f"# {info.get('title') or info.get('id')}",
        "",
        f"- **Link:** https://www.youtube.com/watch?v={info.get('id')}",
        f"- **Channel:** {info.get('uploader') or info.get('channel') or '—'}",
        f"- **Published:** {upload or '—'}",
        f"- **Duration:** {hhmmss(info.get('duration') or 0)}",
        f"- **Video language:** {native}",
        f"- **Subtitles:** {lang} ({label})",
        f"- **Downloaded:** {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "---",
        "",
    ]
    for start, text in paragraphs(cues):
        lines.append(f"**[{hhmmss(start)}]** {text}" if timestamps else text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------- runtime

class SilentLogger:
    """yt-dlp prints its own errors; we only want our own output."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def ydl_options(cookies_browser, flat=False):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "logger": SilentLogger(),
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": "in_playlist" if flat else False,
        "retries": 3,
        "ignoreerrors": False,
        "cachedir": False,                # avoid a stale player cache — a common cause of "page needs to be reloaded"
        "ignore_no_formats_error": True,  # we don't need video/audio, only metadata and subtitles
    }
    if cookies_browser:
        if os.path.isfile(cookies_browser):     # path to an exported cookies.txt
            opts["cookiefile"] = cookies_browser
        else:
            opts["cookiesfrombrowser"] = (cookies_browser,)
        # known yt-dlp bug (issue #17389, Aug 2026): once cookies are passed, the default
        # client set includes tv_downgraded, which is currently broken on YouTube's side
        # and returns "The page needs to be reloaded" — explicitly exclude it.
        opts["extractor_args"] = {"youtube": {"player_client": ["default", "-tv_downgraded"]}}
    return opts


TRANSIENT_ERRORS = ("needs to be reloaded", "HTTP Error 5", "Temporary failure", "timed out")


def extract_with_retry(ydl, url, attempts=3, delay=2.0):
    """YouTube sometimes answers with a transient error (asks to 'reload the page', etc.) —
    in most cases retrying after a couple of seconds resolves it on its own."""
    last = None
    for attempt in range(attempts):
        try:
            return ydl.extract_info(url, download=False)
        except Exception as exc:
            last = exc
            if attempt + 1 == attempts or not any(m in str(exc) for m in TRANSIENT_ERRORS):
                raise
            time.sleep(delay * (attempt + 1))
    raise last


def process_video(ydl, url, out_dir, timestamps=True, target_lang=None):
    info = extract_with_retry(ydl, url)
    if info and info.get("_type") == "playlist":
        info = next(iter(info.get("entries") or []), None)
    if not info:
        raise RuntimeError("could not fetch video data")

    native = detect_language(info)
    lang, track, label = choose_track(info, native, target_lang)
    if not track:
        raise RuntimeError("this video has neither manual nor automatic subtitles")

    fmt = pick_format(track)
    raw = ydl.urlopen(fmt["url"]).read().decode("utf-8", "replace")
    cues = parse_subtitles(raw, fmt.get("ext", ""))
    if not cues:
        raise RuntimeError(f"the {lang} track is empty")

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{safe_name(info.get('title') or info['id'])} [{info['id']}].md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(build_markdown(info, cues, native, lang, label, timestamps))
    return path, native, lang, label, len(cues)


CHANNEL_RE = re.compile(r"youtube\.com/(@[^/?#]+|c/|user/|channel/)", re.I)
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


def is_playlist_url(url):
    if "list=" in url:                  # watch?v=..&list=.. is still just one video
        return "/playlist" in url or "v=" not in url
    return bool(CHANNEL_RE.search(url))


def normalize_list_url(url):
    """A channel link is redirected to its Videos tab, otherwise yt-dlp returns the tab list."""
    if CHANNEL_RE.search(url) and not re.search(r"/(videos|shorts|streams|playlists)/?$", url):
        return url.rstrip("/") + "/videos"
    return url


def entry_video_id(entry):
    """Video ID from a playlist entry; None for nested playlists and tabs."""
    url = entry.get("url") or ""
    m = re.search(r"[?&]v=([\w-]{11})", url) or re.search(r"youtu\.be/([\w-]{11})", url)
    if m:
        return m.group(1)
    vid = entry.get("id") or ""
    return vid if VIDEO_ID_RE.match(vid) else None


KNOWN_ERRORS = [
    ("Sign in to confirm you", "YouTube is asking to confirm you're not a bot"),
    ("age-restricted", "age-restricted (18+) video"),
    ("Private video", "private video"),
    ("members-only", "members-only video"),
    ("Video unavailable", "video unavailable (removed or blocked in this region)"),
    ("This live event", "live stream hasn't ended yet"),
    ("Premieres in", "premiere hasn't started yet"),
]

NEEDS_LOGIN = {"YouTube is asking to confirm you're not a bot", "age-restricted (18+) video"}


def short_error(exc, cookies_browser=None):
    text = re.sub(r"\s+", " ", str(exc))
    text = re.sub(r"^ERROR:\s*", "", text)
    text = re.sub(r"\[[a-z:]+\]\s*[\w-]+:\s*", "", text)
    for marker, message in KNOWN_ERRORS:
        if marker in text:
            if message not in NEEDS_LOGIN:
                return message
            if not cookies_browser:
                return message + " — run with --cookies chrome (or firefox)"
            return (message + f" — the cookies you passed ({cookies_browser}) didn't help: "
                    "make sure you're signed in to youtube.com in that browser, "
                    "or export cookies.txt with a browser extension and pass its path")
    return text[:180]


def handle(url, out_root, cookies_browser, timestamps=True, target_lang=None):
    url = url.strip().strip('"').strip("'")
    if not url:
        return

    if not is_playlist_url(url):
        with YoutubeDL(ydl_options(cookies_browser)) as ydl:
            try:
                path, native, lang, label, count = process_video(
                    ydl, url, out_root, timestamps, target_lang)
            except Exception as exc:
                print(f"Error: {short_error(exc, cookies_browser)}\n")
                return
        print(f"OK: video language {native}, downloaded {label} subtitles [{lang}], {count} cues")
        print(f"File: {path}\n")
        return

    try:
        with YoutubeDL(ydl_options(cookies_browser, flat=True)) as ydl:
            playlist = extract_with_retry(ydl, normalize_list_url(url))
    except Exception as exc:
        print(f"Error: {short_error(exc, cookies_browser)}\n")
        return

    entries = [(entry_video_id(e), e.get("title") or "") for e in (playlist.get("entries") or []) if e]
    entries = [e for e in entries if e[0]]
    if not entries:
        print("Error: no available videos in this playlist\n")
        return
    out_dir = os.path.join(out_root, safe_name(playlist.get("title") or "playlist"))
    print(f"\nPlaylist: {playlist.get('title')} — videos: {len(entries)}")
    print(f"Folder: {out_dir}")
    if len(entries) > 50:
        print("Note: large playlist — a 1-3 sec delay was added between videos "
              "to avoid triggering a YouTube captcha/rate limit; this will take a while.")
    print()

    done, failed = 0, []
    with YoutubeDL(ydl_options(cookies_browser)) as ydl:
        for i, (video_id, title) in enumerate(entries, 1):
            name = title or video_id
            if i > 1:
                # random non-integer delay before each next video — avoid hammering
                # YouTube with a steady stream of requests (see RECOMMENDATIONS_safety.md)
                time.sleep(random.uniform(1.0, 3.0))
            try:
                _, native, lang, label, _ = process_video(
                    ydl, f"https://www.youtube.com/watch?v={video_id}", out_dir, timestamps, target_lang)
                done += 1
                print(f"[{i}/{len(entries)}] OK    {name} -> {lang} / {label} (video language {native})")
            except Exception as exc:
                failed.append(name)
                print(f"[{i}/{len(entries)}] SKIP  {name} -> {short_error(exc, cookies_browser)}")

    print(f"\nDone: {done} of {len(entries)}. Folder: {out_dir}")
    if failed:
        print(f"No subtitles / unavailable: {len(failed)}")
    print()


def main():
    ap = argparse.ArgumentParser(description="YouTube subtitles -> Markdown in the Downloads folder")
    ap.add_argument("urls", nargs="*", help="a video or playlist link")
    ap.add_argument("--out", default=None, help="save folder (default: Downloads)")
    ap.add_argument("--no-ts", action="store_true", help="text without timestamps")
    ap.add_argument("--cookies", default=None, metavar="BROWSER_OR_FILE",
                    help="if YouTube asks to confirm you're not a bot: a browser name "
                         "(chrome, edge, firefox) or a path to an exported cookies.txt")
    ap.add_argument("--lang", default=None, metavar="CODE",
                    help="override the target language (default: ru for Russian videos, "
                         "en otherwise) with any code, e.g. fr, es, de, ja")
    ap.add_argument("--reset-settings", action="store_true",
                    help="forget the saved --out/--cookies/--lang and exit")
    args = ap.parse_args()

    if args.reset_settings:
        try:
            os.remove(settings_path())
            print("Saved settings cleared.")
        except FileNotFoundError:
            print("No saved settings to clear.")
        return

    # --out/--cookies/--lang are remembered between runs: pass one explicitly to
    # use it and save it as the new default, or omit it to reuse the last saved
    # value. Run with --reset-settings to forget everything that was saved.
    settings = load_settings()
    for name, value in (("out", args.out), ("cookies", args.cookies), ("lang", args.lang)):
        if value is not None:
            settings[name] = value
        elif settings.get(name):
            setattr(args, name, settings[name])
            print(f"Using saved --{name}: {settings[name]}")
    save_settings(settings)

    out_root = args.out or downloads_dir()
    timestamps = not args.no_ts

    if args.urls:
        for url in args.urls:
            handle(url, out_root, args.cookies, timestamps, args.lang)
        return

    print("YouTube subtitles -> Markdown")
    print(f"Saving to: {out_root}")
    print("Paste a video or playlist link. Empty line or q to quit.\n")
    while True:
        try:
            url = input("Link: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not url or url.lower() in ("q", "exit", "quit"):
            return
        try:
            handle(url, out_root, args.cookies, timestamps, args.lang)
        except DownloadError as exc:
            print(f"Error: {short_error(exc, args.cookies)}\n")
        except Exception as exc:
            print(f"Error: {short_error(exc, args.cookies)}\n")


if __name__ == "__main__":
    main()
