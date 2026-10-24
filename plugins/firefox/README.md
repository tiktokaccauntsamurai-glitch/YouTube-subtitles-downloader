# Subtitles to Markdown for YouTube — Firefox add-on

The same tool as `yt_subs.py`, but running inside Firefox: paste a link (or just open a video), press the button, and the subtitles land in your `Downloads` folder as Markdown.

**Why a browser add-on:** the script needs a signed-in YouTube session for age-restricted videos and for the "confirm you're not a bot" check, which on the command line means exporting cookies with `--cookies`. In the browser there is nothing to export — requests go out from the add-on itself, or, when YouTube refuses those, from a content script on a youtube.com tab, so Firefox attaches the session itself. **The add-on never reads, stores or sends cookies anywhere**, and it talks to no server other than youtube.com.

## Install (temporary, for development)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `plugins/firefox/manifest.json`.
3. The icon appears on the toolbar. Temporary add-ons are removed when Firefox restarts — repeat the two steps after a restart.

For a permanent install the folder has to be zipped and signed at [addons.mozilla.org](https://addons.mozilla.org/developers/) (or `about:config` → `xpinstall.signatures.required=false` on Developer/Nightly builds).

## Use

| Field | Meaning |
| --- | --- |
| **Link** | A video, a playlist, or a channel. Pre-filled from the current tab when it is a YouTube page. |
| **Subtitle language** | `Auto` follows the rule from the settings page (default: `ru` for Russian videos, `en` for everything else). Your own languages from the settings are listed as quick choices; `Other code…` accepts any code (`ja`, `es`, …). |
| **Limit** | For playlists/channels: stop after N videos. `0` = all of them. |
| **Timestamps** | Off = plain flowing text without the `**[mm:ss]**` prefixes. |

Files go to `Downloads/<title> [<id>].md`; a playlist or channel gets its own subfolder named after the list. The settings are remembered between runs.

The job keeps running when the popup is closed — reopen it to see the log. **Stop** ends the run at the next step (it does not wait for a slow video to finish).

**Tabs.** A run opens at most one background youtube.com tab and closes it when done. If the video is already open in one of your tabs, that tab is used and nothing is opened at all; your own tabs are never navigated to another video or closed, and their player is left as it was (not muted, captions setting restored).

## How track selection works

Identical to the script (see the [main README](../../README.md#how-language--track-selection-works)):

1. Detect the video's spoken language — an auto-generated (ASR) caption track is the giveaway, otherwise the default audio track.
2. Target language: `ru` for Russian videos, `en` otherwise, unless overridden.
3. Priority: manual subtitles in the target language → automatic in the target language → the same pair in the native language → any track that exists.

The subtitle track itself is fetched as `json3`, falling back to `srv3` and `vtt` if that comes back empty.

## Files

```
manifest.json      MV3 manifest (Firefox 140+)
background.js      the job runner: link -> list of videos -> Markdown -> downloads
content.js         runs requests from inside a youtube.com tab when direct ones are refused
lib/settings.js    storage defaults shared by the background page, popup and settings page
lib/util.js        helpers + the balanced-brace scanner for YouTube's inline JSON
lib/parse.js       json3 / vtt / srv1 / srv3 / ttml -> cues
lib/markdown.js    cues -> paragraphs -> Markdown
lib/youtube.js     player-response and playlist-page knowledge, track selection
lib/inpage.js      functions injected into the youtube.com page (player capture, transcript panel)
popup/             the UI
options/           the settings page: preferred languages, automatic rule
test/check.js      unit tests for lib/ — `node test/check.js`, no browser needed
```

## Permissions it asks for

| Permission | What for |
| --- | --- |
| `*://*.youtube.com/*` | reading video/playlist pages and subtitle tracks; also lets the add-on see which tabs are on youtube.com (and only those) |
| `downloads` | writing the `.md` files |
| `scripting` | loading the request script into a youtube.com tab that was open before the add-on was installed; reading the subtitle request / transcript panel of the player page when YouTube refuses plain subtitle links |
| `storage` | remembering the language/timestamps/limit settings |
| `alarms` | keeping the background page awake during a long playlist run |

## Limits and notes

- A playlist run makes one page request per video with a random 1–3 s pause, the same pacing as the script. Very large channels are still better split across a few sessions.
- Channel pages are read from the `/videos` tab; videos are collected from the page payload and its continuations, so a shelf pinned to the tab (a trailer, for instance) can show up in the list.
- Whatever is still missing is missing for the script too: videos with no subtitles, private/removed videos, live streams that haven't ended.
- If nothing works at all, open youtube.com in a tab and check that you're signed in and the page loads normally — the add-on can only do what that tab can.
