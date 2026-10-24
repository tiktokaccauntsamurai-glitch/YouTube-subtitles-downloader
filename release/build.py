"""Packs plugins/firefox into an addons.mozilla.org upload.

    python release/build.py

Writes ../store/firefox/<version>/<name>-<version>.zip with manifest.json at the archive root,
forward-slash paths (Windows' Compress-Archive writes backslashes, which AMO
rejects) and fixed timestamps, so the same sources always give the same zip.
"""
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "plugins" / "firefox"
# store versions live outside dev/ and outside the repo: <workspace>/store/firefox/<version>/
STORE = ROOT.parent / "store" / "firefox"

# runtime files only: tests and the developer README stay out of the package
INCLUDE = [
    "manifest.json",
    "background.js",
    "content.js",
    "icons/icon.svg",
    "lib/settings.js",
    "lib/util.js",
    "lib/parse.js",
    "lib/markdown.js",
    "lib/youtube.js",
    "lib/inpage.js",
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    "options/options.html",
    "options/options.css",
    "options/options.js",
]


def referenced(manifest):
    """Every file the manifest points at, so a missing one fails the build."""
    files = set(manifest["background"]["scripts"])
    for cs in manifest.get("content_scripts", []):
        files.update(cs.get("js", []))
        files.update(cs.get("css", []))
    action = manifest.get("action", {})
    files.update(filter(None, [action.get("default_popup"), action.get("default_icon")]))
    files.update(manifest.get("icons", {}).values())
    page = manifest.get("options_ui", {}).get("page")
    if page:
        files.add(page)
    return files


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    missing = sorted(referenced(manifest) - set(INCLUDE))
    if missing:
        sys.exit(f"manifest references files not in INCLUDE: {missing}")
    for rel in INCLUDE:
        if not (SRC / rel).is_file():
            sys.exit(f"missing file: {rel}")

    DIST = STORE / manifest["version"]
    DIST.mkdir(parents=True, exist_ok=True)
    out = DIST / f"subtitles-to-markdown-{manifest['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in INCLUDE:
            info = zipfile.ZipInfo(rel, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (SRC / rel).read_bytes())
    print(f"{out.relative_to(ROOT.parent)}  ({out.stat().st_size} bytes, {len(INCLUDE)} files)")


if __name__ == "__main__":
    main()
