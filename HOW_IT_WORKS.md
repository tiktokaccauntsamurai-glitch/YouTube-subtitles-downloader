# How yt_subs.py works

A detailed walkthrough of what happens inside the program from a pasted link to the finished `.md` file. Function references point at the current `yt_subs.py`.

## The general idea

The program doesn't download video. It talks to the same internal YouTube APIs the web player uses, through the `yt-dlp` library — that library handles the whole protocol side (parsing any link shape, fetching the list of available subtitle tracks). Our own code on top of it does three things:

1. decides **which** subtitle track to download (language/priority rules);
2. downloads and parses the subtitle file itself (yt-dlp isn't involved here — more on why below);
3. assembles the result into readable Markdown.

## One link's journey from input to file

```
Link (user input)
        │
        ▼
is_playlist_url()  ──── is it a playlist/channel? ────► normalize_list_url()
        │ no                                                   │
        ▼                                                      ▼
                                          extract_with_retry() — flat video list
                                                            │
                                                            ▼
                                          entry_video_id() on each entry
                                                            │
                                                            ▼
                                          loop: process_video() for each id
        │
        ▼
process_video()
        │
        ├─ extract_with_retry() → video metadata from YouTube (yt-dlp)
        ├─ detect_language()    → the video's native language
        ├─ choose_track()       → which track is needed (priority rules)
        ├─ pick_format()        → which format to download it in (json3/vtt/…)
        ├─ ydl.urlopen(...)     → downloading the raw subtitle file
        ├─ parse_subtitles()    → turning it into a (time, text) list
        ├─ paragraphs()         → merging cues into paragraphs
        └─ build_markdown()     → assembling the final text → writing the file
```

Now step by step in detail.

---

## 1. Classifying the link: video, playlist, or channel

`is_playlist_url(url)` (line ~360) looks at the link itself, before any request to YouTube:

- if the link has `list=` — it's a playlist, **except** for `watch?v=...&list=...`: someone most likely pasted a link to a specific video that just happened to open from within a playlist, so it's treated as a single video;
- if the link has `/@handle`, `/channel/...`, `/c/...`, or `/user/...` — it's a channel.

`normalize_list_url(url)` then redirects a channel link to its `/videos` tab (`https://www.youtube.com/@name` → `https://www.youtube.com/@name/videos`), because without that YouTube returns the list of channel tabs (Home, Videos, Shorts, Playlists...) instead of a list of videos.

For a playlist/channel, a **flat** request is made first (`extract_flat="in_playlist"` in `ydl_options`) — this is fast, since YouTube only returns IDs and titles without hitting every video individually. Full metadata (and subtitles) is requested per video, one at a time, in the processing loop.

`entry_video_id(entry)` (line ~373) extracts the actual 11-character video ID from a playlist entry — YouTube sometimes puts it in `entry['id']`, sometimes only inside `entry['url']` (as `watch?v=...` or `youtu.be/...`), so the function checks both. It also filters out entries that don't carry a video ID at all (nested playlists, channel tabs).

## 2. Detecting the video's native language

`detect_language(info)` (line ~68), in order of decreasing reliability:

1. the `language` field, which the uploader sometimes sets explicitly;
2. failing that — among the automatic tracks, look for a code with the `-orig` suffix (`ru-orig`, `en-orig`...) — this is how YouTube marks the auto track generated from the video's original audio track, which matters especially for multi-language videos with several dubs;
3. failing that, if the video has exactly one manual (author) subtitle track — treat its language as native;
4. otherwise — default to English (simply the most common case when nothing else is known).

## 3. Choosing the subtitle track: `choose_track`

This is the core logic the whole project exists for (line ~98). The rules, as discussed:

- **target language** = `ru` if the video is Russian, otherwise `en` — unless overridden by `--lang CODE` (see `target_lang` parameter below and the README's [language section](README.md#fixingoverriding-the-preferred-language));
- within the target language, priority is: **manual subtitles → automatic**;
- if the video has manual subtitles but not in the target language, they are **not used** — automatic subtitles in the target language are used instead (so for an English video whose only manual subtitles are French, the program downloads English auto-captions, not the French manual ones);
- if the target language doesn't exist at all: fallback — manual in the video's native language → automatic in the native language → whatever is available.

`choose_track(info, native, target_lang=None)` takes an optional `target_lang` — when it's `None` (the default, no `--lang` flag passed), the target is computed from the video's native language as above; when set, it's normalized through `base_lang()` (so `pt-BR` becomes `pt`) and used as the target outright, skipping the ru/en default entirely. Everything downstream — the manual-before-automatic priority, the native-language fallback if the requested language isn't available — works exactly the same either way, just against a different target language.

`match_lang(tracks, target, orig_first)` (line ~83) looks up a language code inside a track dictionary (`ru`, `ru-RU`, `en-US`...), comparing only the base part of the code via `base_lang()` (strips the region: `ru-RU` → `ru`). The `orig_first` flag makes it prefer the `xx-orig` auto-track variant when present — that's a more accurate match for multi-language videos than plain auto-generation.

`choose_track` returns `(lang, track, label)`, where `label` explains in plain words what was actually downloaded ("manual", "automatic", "manual (native language)", etc.) — this string ends up in the header of the resulting file.

## 4. The subtitle format itself: `pick_format`

Each track comes with several formats to choose from (`json3`, `srv3`, `vtt`, `ttml`, `srv1` — different ways to encode the same timed text). `pick_format` (line ~126) picks `json3` if available — the cleanest, most predictable format (plain JSON) — and only falls back to the others, in order of parsing convenience, if it isn't.

The raw file is then downloaded directly (`ydl.urlopen(fmt["url"])`), **without** going through yt-dlp's own subtitle-download machinery (`--write-sub`/`--write-auto-sub`) — that machinery saves a file to disk and requires a separate conversion step; it's simpler for us to get the text in memory and parse it ourselves right away.

## 5. Parsing subtitles into a list of cues

Four formats, four parsers, all returning the same `(start_seconds, text)` list:

- **`parse_json3`** — the simplest case, plain JSON with a list of `events`, each carrying its own text `segs`. Internal `aAppend` events are skipped (these are "appends" to the rolling caption line that duplicate text already shown).
- **`parse_vtt`** — a line-by-line `WEBVTT` parser: it looks for lines containing `-->` (the start/end timestamp of a cue), with the text between them stripped of styling HTML tags (`<c.colorXXXXXX>` and similar). A separate quirk of YouTube's auto-captions in this format is that they scroll as a "rolling" line, where almost every next cue repeats the tail of the previous one; after parsing, a deduplication pass collapses a cue into its neighbor whenever one is fully contained in the other.
- **`parse_xml`** — a shared parser for `srv1`/`srv3`/`ttml` (different XML dialects with a similar `<text>`/`<p>` structure). There's an important detail here that used to be a bug: the `start=` attribute is in **seconds** (`start="4"` = the 4th second), while the `t=` attribute (used by `srv3`) is in **milliseconds** (`t="1500"` = 1.5 seconds). `to_seconds()` additionally understands a `00:01:05.500`-style timestamp (used by `ttml`). After extracting the text, HTML entities (`&amp;`, `&lt;`, etc.) are decoded, since YouTube doesn't escape them consistently when serving XML.

`parse_subtitles(raw, ext)` is just a dispatcher that picks the right parser by format extension.

## 6. Assembling the Markdown

Subtitle cues come as short phrases a few seconds apart — reading that as a plain list of timestamps is unpleasant, so `paragraphs()` (line ~228) merges them into paragraphs using three conditions (whichever fires first ends the current paragraph):

| Condition | Meaning |
|---|---|
| paragraph length ≥ 900 characters | it's grown too long — cut it even mid-thought |
| length ≥ 480 characters **and** the previous cue ends with `. ! ? … » " '` | the paragraph is already a decent size and a sentence just ended — a good place to break |
| the gap between cues is over 4 seconds **and** the paragraph isn't too short already (>200 characters) | a meaningful pause in speech (topic change, edit cut) |

`build_markdown()` (line ~246) assembles the file header (title, link, channel, upload date, duration, detected video language, which exact track was downloaded, download date) plus the text as paragraphs, each with a starting timestamp `**[mm:ss]**` (or without one if `--no-ts` is passed).

## 7. Talking to yt-dlp: `ydl_options`

This is where all of yt-dlp's own settings live (line ~288); several of them are the result of debugging real YouTube issues encountered while building this program:

- `skip_download=True` — don't download the video file itself, only metadata;
- `cachedir=False` — disables yt-dlp's on-disk extractor cache. This guards against a situation where YouTube changes something on its side while yt-dlp keeps reusing a stale cached response — that's exactly what used to surface as **"The page needs to be reloaded"**;
- `ignore_no_formats_error=True` — tells yt-dlp not to treat it as fatal when a video has no downloadable video/audio format at all. Normally that's a hard error ("Requested format is not available"), but we don't need video formats at all — only subtitles — so that error shouldn't stop us;
- when `--cookies` is passed (a browser name or a `cookies.txt` file), `extractor_args: player_client=default,-tv_downgraded` is added. Here `-tv_downgraded` explicitly excludes one specific YouTube player client. Reason: once yt-dlp sees the request is using cookies (a signed-in session), it enables a default client set that includes `tv_downgraded` — and that particular client was, at the time this script was written, unstable on YouTube's side and failed with a "reload the page" error. Simply listing `player_client=default,web_embedded` doesn't fix this, because `default` for a signed-in session expands into a list that already includes `tv_downgraded` — so it has to be **explicitly excluded** with a `-`, not just supplemented with other clients.

`SilentLogger` (line ~272) is a stub that swallows yt-dlp's own text messages (by default it prints fairly verbose `ERROR:`/`WARNING:` lines straight to the console); the program builds its own short, readable messages via `short_error()`, so yt-dlp's raw logs aren't needed.

`extract_with_retry()` (line ~316) — if YouTube hiccups for a moment (the same "reload the page" error, a transient 5xx server error, a dropped connection), up to 3 attempts are made with a growing pause before showing the error to the user. Such YouTube glitches often clear up on their own after a couple of seconds.

Downloading a playlist adds one more safety measure, in `handle()` (line ~412): before every video after the first, the program sleeps a random, **non-integer** amount of time between 1 and 3 seconds (`time.sleep(random.uniform(1.0, 3.0))`). This isn't about correctness — it's there to avoid hammering YouTube with a steady, bot-like stream of back-to-back requests on large playlists, which is a common trigger for a captcha or a rate limit (see README's [Security notes](README.md#security-notes)). For playlists over 50 videos, the program also prints a short heads-up that this will take a bit longer because of the added delay.

## 8. Turning errors into something readable: `short_error`

yt-dlp raises exceptions with long technical text (often in English, with links to wiki pages). `short_error()` (line ~396) looks for known markers in that text (`KNOWN_ERRORS`) and replaces them with a short, plain explanation:

- **"Sign in to confirm you..."** → "YouTube is asking to confirm you're not a bot" — with a suggestion to run with `--cookies`, or, if cookies were already passed, a note that those specific cookies didn't help and what to try next (re-check the browser login, or export `cookies.txt`);
- **age restriction**, **private video**, **members-only video**, **video unavailable**, **stream/premiere not started yet** — each gets its own short explanation.

If no marker matches, the original error text is shown as-is, truncated to 180 characters.

## 9. Handling one link end to end: `handle`

`handle()` (line ~412) is the entry point for a single pasted link:

- if it isn't a playlist/channel — one call to `process_video()`, the result or error is printed right away;
- if it is — first a flat list of videos, then a **loop** over every found ID, each with its own `process_video()` call inside a single `YoutubeDL` session (to avoid reconnecting for every video). An error on one video doesn't stop the whole playlist — it's just marked as skipped, and a final counter ("Done: N of M") is printed at the end.

## 10. The command line: `main`

Two modes:

- **by arguments**: `python yt_subs.py "link1" "link2" ...` — process and exit;
- **interactive** (no arguments): prints a prompt and, in a loop, reads links via `input()` until an empty line or `q`/`exit`/`quit`.

The `--out`, `--no-ts`, `--cookies`, and `--lang` flags are parsed with `argparse` and apply the same way to both the one-shot and interactive modes — `args.lang` is threaded through `handle()` and `process_video()` down to `choose_track()` as `target_lang` on every single call, whether it's one video or every video in a playlist.

## 11. Remembering settings between runs

`settings_path()` (near the top of the file, next to `downloads_dir()`) points at a small JSON file kept **outside** the project folder — `%APPDATA%\yt_subs\settings.json` on Windows, `~/.config/yt_subs/settings.json` elsewhere — specifically so it's user/machine state rather than project state: it must never get swept up by `git add` or reset by re-cloning the repo. `load_settings()`/`save_settings()` are a thin, defensive JSON read/write pair (a missing or corrupt file just loads as `{}`).

In `main()`, right after parsing arguments (and before touching `--reset-settings`'s early-return path), `--out`/`--cookies`/`--lang` are merged with whatever was saved:

```python
for name, value in (("out", args.out), ("cookies", args.cookies), ("lang", args.lang)):
    if value is not None:
        settings[name] = value                  # explicitly passed -> becomes the new default
    elif settings.get(name):
        setattr(args, name, settings[name])      # not passed -> reuse the saved value
        print(f"Using saved --{name}: {settings[name]}")
```

Passing a flag always wins and overwrites what was saved; omitting it falls back to the last saved value, with a printed line so it's never a silent surprise. `--no-ts` is deliberately left out of this — as a plain `store_true` flag there's no way to tell "not passed, use the saved value" apart from "explicitly passed as off", so persisting it would make it impossible to turn back off without editing the settings file by hand. `--reset-settings` just deletes the settings file and exits before any of this runs.

Note what's *not* stored here: actual cookie bytes. `--cookies` only ever persists the browser name or the `cookies.txt` path — the string you'd have typed anyway — never anything read out of the browser or the file itself. yt-dlp still reads the live session (or the file) fresh on every run.

---

## Timeline of the real YouTube issues that shaped some of this

For the record — three issues hit while first running the program against real YouTube, and how each is handled in the code:

1. **"Sign in to confirm you're not a bot"** with no cookies at all — YouTube demands a not-a-bot confirmation for requests from certain IPs/networks. Fix: the `--cookies browser` flag — then the request carries a signed-in session.
2. **"Failed to decrypt with DPAPI"** with `--cookies chrome` — since Chrome 127+, Google encrypts cookies with a new scheme (App-Bound Encryption) that sometimes can't be decrypted even with the browser fully closed. This can't be fixed in code — only by switching browsers (`--cookies firefox`) or manually exporting `cookies.txt` through a browser extension.
3. **"The page needs to be reloaded"** even after cookies were successfully passed — a separate bug, unrelated to the previous one, in one specific YouTube player client (`tv_downgraded`) that's used by default for signed-in requests. Fixed by excluding that client (see section 7 above, `player_client=default,-tv_downgraded`).
4. **"Requested format is not available"** — surfaced right after fixing issue #3: once `tv_downgraded` is excluded, the remaining clients sometimes don't return a single usable video/audio format, and yt-dlp treats that as fatal by default. Fixed with the `ignore_no_formats_error=True` flag, since the program never needs video/audio formats in the first place.

All four issues trace back to YouTube's constantly shifting anti-automation defenses, not to the program's own logic — so if YouTube changes something again in the future, the first thing to check is `python -m pip install -U yt-dlp` (the yt-dlp maintainers usually ship fixes for new YouTube defenses quickly).
