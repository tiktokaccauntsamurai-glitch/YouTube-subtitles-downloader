// Unit tests for the pure lib/ modules (no browser APIs involved):
//   node test/check.js

const fs = require("fs");
const vm = require("vm");
const path = require("node:path").join(__dirname, "..", "lib") + "/";
const ctx = vm.createContext({ console, URL, setTimeout });
for (const f of ["settings.js", "util.js", "parse.js", "markdown.js", "youtube.js", "inpage.js"]) {
  vm.runInContext(fs.readFileSync(path + f, "utf8"), ctx, { filename: f });
}
const YS = ctx.YS;
let fails = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { fails++; console.log("FAIL", name, "\n  got ", a, "\n  want", b); }
  else console.log("ok  ", name);
};

// --- extractJsonAfter
const html = `<script>var ytInitialPlayerResponse = {"a":"}{\\"", "b":{"c":1}};var x=1;</script>`;
eq("extractJsonAfter/nested+escapes", YS.extractJsonAfter(html, "ytInitialPlayerResponse"), { a: '}{"', b: { c: 1 } });
eq("extractJsonAfter/missing", YS.extractJsonAfter("nothing here", "ytInitialData"), null);

// a decoy assignment before the real payload, like the watch page has
const watchHtml = `<script>if (window.ytInitialPlayerResponse) {"noop":1}</script>` +
  `<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"abcdefghijk"}};</script>`;
eq("playerResponse skips the decoy", YS.playerResponse(watchHtml).videoDetails.videoId, "abcdefghijk");
eq("playerResponse/missing", YS.playerResponse("<html></html>"), null);
const listHtml = `<script>window["ytInitialData"] = {"contents":{"x":1}};</script>`;
eq("listData", YS.listData(listHtml), { contents: { x: 1 } });

// --- parsers
const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 1500, aAppend: 1, segs: [{ utf8: "ignored" }] },
    { tStartMs: 2000, segs: [{ utf8: "second\n line" }] },
    { tStartMs: 3000, segs: [{ utf8: "  " }] },
  ],
});
eq("json3", YS.parseSubtitles(json3, "json3"), [[0, "Hello world"], [2, "second line"]]);

const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000
hello

00:00:03.000 --> 00:00:05.000
hello there

00:01:05.500 --> 00:01:07.000
<c>next</c> line
`;
eq("vtt/rolling dedup", YS.parseSubtitles(vtt, "vtt"), [[1, "hello there"], [65.5, "next line"]]);

const srv3 = `<?xml version="1.0"?><timedtext><body><p t="1500" d="2000">a &amp;<s>b</s></p><p t="4000">c</p></body></timedtext>`;
eq("srv3 ms + entities", YS.parseSubtitles(srv3, "srv3"), [[1.5, "a & b"], [4, "c"]]);
const srv1 = `<transcript><text start="4.5" dur="2">old &quot;style&quot;</text></transcript>`;
eq("srv1 seconds", YS.parseSubtitles(srv1, "srv1"), [[4.5, 'old "style"']]);
const ttml = `<tt><body><div><p begin="00:00:10.250" end="00:00:12">ttml cue</p></div></body></tt>`;
eq("ttml hh:mm:ss", YS.parseSubtitles(ttml, "ttml"), [[10.25, "ttml cue"]]);
eq("xml entities in one pass", YS.parseSubtitles('<p t="0">&amp;lt;b&amp;gt; it&#8217;s &#x41;&nbsp;B</p>', "srv3"),
  [[0, "&lt;b&gt; it’s A B"]]);
const vttReply = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nYes, I agree.\n\n" +
  "00:00:03.000 --> 00:00:04.000\nYes\n\n00:00:05.000 --> 00:00:06.000\nTom &amp; Jerry\n";
eq("vtt keeps a short reply + decodes entities", YS.parseSubtitles(vttReply, "vtt"),
  [[1, "Yes, I agree."], [3, "Yes"], [5, "Tom & Jerry"]]);
const vttRolling = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst line\n\n" +
  "00:00:02.000 --> 00:00:03.000\nfirst line\nsecond\n\n00:00:03.000 --> 00:00:03.010\nfirst line second\n";
eq("vtt rolling tail dropped", YS.parseSubtitles(vttRolling, "vtt"), [[1, "first line second"]]);
eq("empty payload", YS.parseSubtitles("", "json3"), []);
eq("broken json", YS.parseSubtitles("{nope", "json3"), []);

// --- urls
eq("url/video", YS.isPlaylistUrl("https://www.youtube.com/watch?v=abcdefghijk"), false);
eq("url/video in list", YS.isPlaylistUrl("https://www.youtube.com/watch?v=abcdefghijk&list=PL1"), false);
eq("url/playlist", YS.isPlaylistUrl("https://www.youtube.com/playlist?list=PL1"), true);
eq("url/channel", YS.isPlaylistUrl("https://www.youtube.com/@someone"), true);
eq("normalize/channel", YS.normalizeListUrl("https://www.youtube.com/@someone/"), "https://www.youtube.com/@someone/videos");
eq("normalize/videos tab", YS.normalizeListUrl("https://www.youtube.com/@someone/videos"), "https://www.youtube.com/@someone/videos");
eq("normalize/playlist", YS.normalizeListUrl("https://www.youtube.com/playlist?list=PL1"), "https://www.youtube.com/playlist?list=PL1");
eq("normalize/channel ?si=", YS.normalizeListUrl("https://www.youtube.com/@someone?si=abc"), "https://www.youtube.com/@someone/videos");
eq("normalize/featured tab", YS.normalizeListUrl("https://www.youtube.com/@someone/featured"), "https://www.youtube.com/@someone/videos");
eq("normalize/shorts tab kept", YS.normalizeListUrl("https://www.youtube.com/channel/UC123/shorts?si=x"), "https://www.youtube.com/channel/UC123/shorts");
eq("canonical/youtu.be", YS.canonicalUrl("https://youtu.be/dQw4w9WgXcQ?si=x&t=5"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
eq("canonical/youtu.be in a list", YS.canonicalUrl("https://youtu.be/dQw4w9WgXcQ?list=PL1"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1");
eq("youtu.be in a list is one video", YS.isPlaylistUrl(YS.canonicalUrl("https://youtu.be/dQw4w9WgXcQ?list=PL1")), false);
eq("canonical/shorts", YS.canonicalUrl("https://youtube.com/shorts/dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
eq("canonical/mobile", YS.canonicalUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&pp=1"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&pp=1");
eq("canonical/music playlist", YS.canonicalUrl("https://music.youtube.com/playlist?list=PL1"), "https://www.youtube.com/playlist?list=PL1");
eq("canonical/no trailing slash", YS.canonicalUrl("https://youtube.com"), "https://www.youtube.com/");
eq("canonical/foreign host", YS.canonicalUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ"), null);
eq("canonical/userinfo trick", YS.canonicalUrl("https://youtube.com@evil.example/"), null);
eq("canonical/not a url", YS.canonicalUrl("hello"), null);
eq("canonical/javascript:", YS.canonicalUrl("javascript:alert(1)//youtube.com/"), null);
eq("videoId/watch", YS.videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1"), "dQw4w9WgXcQ");
eq("videoId/short", YS.videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
eq("videoId/shorts", YS.videoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");

// --- track selection
const track = (languageCode, kind) => ({ languageCode, kind, baseUrl: `https://www.youtube.com/api/timedtext?lang=${languageCode}` });
const pr = (tracks, extra = {}) => Object.assign({
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
}, extra);

let p = pr([track("en", "asr"), track("ru")]);
eq("native from asr", YS.detectLanguage(p), "en");
eq("ru video -> manual ru? no: en native -> manual en missing -> auto en", YS.chooseTrack(p, "en").label, "automatic");
p = pr([track("ru", "asr"), track("ru")]);
eq("ru native", YS.detectLanguage(p), "ru");
eq("ru manual wins", YS.chooseTrack(p, "ru").label, "manual");
p = pr([track("de", "asr")]);
eq("de native, target en, only de asr", YS.chooseTrack(p, "de").label, "automatic (native language)");
eq("explicit target de", YS.chooseTrack(p, "de", "de").label, "automatic");
p = pr([track("fr")]);
eq("only other language", YS.chooseTrack(p, "en").label, "manual (other language)");
eq("no tracks", YS.chooseTrack(pr([]), "en"), null);
p = pr([track("de"), track("en", "asr"), track("ru", "asr")]);
eq("list: first language in order wins", YS.chooseTrack(p, "en", ["ru", "en"]).track.languageCode, "ru");
eq("list: second when first missing", YS.chooseTrack(pr([track("en")]), "ja", ["ru", "en"]).track.languageCode, "en");
eq("list: manual of a later language beats nothing", YS.chooseTrack(p, "en", ["fr", "de"]).label, "manual");
eq("list: no match and no fallback", YS.chooseTrack(pr([track("fr")]), "ja", ["ru", "en"], false), null);
eq("list: native still tried without fallback", YS.chooseTrack(pr([track("fr")]), "fr", ["ru"], false).label, "manual (native language)");
p = pr([track("en-US"), track("en-GB")]);
eq("prefers the first of equally long codes", YS.chooseTrack(p, "en").track.languageCode, "en-US");
p = pr([], { streamingData: { adaptiveFormats: [{ audioTrack: { id: "ja.4", audioIsDefault: true } }] } });
eq("native from audio track", YS.detectLanguage(p), "ja");

eq("trackUrl fmt", YS.trackUrl(track("en"), "json3"), "https://www.youtube.com/api/timedtext?lang=en&fmt=json3");
eq("trackUrl replaces fmt", YS.trackUrl({ baseUrl: "https://www.youtube.com/api/timedtext?fmt=srv3&lang=en" }, "json3"),
  "https://www.youtube.com/api/timedtext?fmt=json3&lang=en");

// --- playability
eq("playability ok", YS.playabilityError({ playabilityStatus: { status: "OK" } }), null);
eq("playability login", YS.playabilityError({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you are not a bot" } }),
  "YouTube asks for a sign-in — sign in to youtube.com in this browser (Sign in to confirm you are not a bot)");

// --- list scraping
const data = {
  metadata: { playlistMetadataRenderer: { title: "My list" } },
  contents: {
    items: [
      { playlistVideoRenderer: { videoId: "aaaaaaaaaaa", title: { runs: [{ text: "First" }] } } },
      { richItemRenderer: { content: { videoRenderer: { videoId: "bbbbbbbbbbb", title: { simpleText: "Second" } } } } },
      { playlistVideoRenderer: { videoId: "aaaaaaaaaaa", title: { runs: [{ text: "First again" }] } } },
      { adRenderer: { videoId: "cccccccccccXX" } },
      { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "TOKEN" } } } },
    ],
  },
};
const seen = new Set(), out = [];
YS.collectEntries(data, seen, out);
eq("entries", out, [{ id: "aaaaaaaaaaa", title: "First" }, { id: "bbbbbbbbbbb", title: "Second" }]);
eq("list title", YS.listTitle(data), "My list");
eq("continuation", YS.continuationToken(data), "TOKEN");
eq("innertube cfg", YS.innertubeConfig('x"INNERTUBE_API_KEY":"AIza-key","INNERTUBE_CONTEXT":{"client":{"hl":"en"}},'),
  { apiKey: "AIza-key", context: { client: { hl: "en" } } });

// --- markdown
eq("safeName", YS.safeName('a/b:c "d" .'), "abc d");
eq("safeName empty", YS.safeName("   "), "video");
eq("safeName backslash + dots", YS.safeName("AC\\DC ..\\..\\x"), "ACDC ....x");
eq("safeName reserved", [YS.safeName("CON"), YS.safeName("com1."), YS.safeName("Console")], ["_CON", "_com1", "Console"]);
eq("hhmmss", [YS.hhmmss(0), YS.hhmmss(75), YS.hhmmss(3723)], ["00:00", "01:15", "1:02:03"]);
const cues = [[0, "one."], [5, "two."], [60, "three."]];
const md = YS.buildMarkdown({ id: "abc", title: "T", uploader: "U", uploadDate: "2024-01-02", duration: 61 }, cues, "en", "en", "manual", true);
console.log("--- markdown sample ---\n" + md + "-----------------------");
eq("markdown has header", md.startsWith("# T\n"), true);
eq("markdown has timestamp", md.includes("**[00:00]** one. two. three."), true);
const mdNoTs = YS.buildMarkdown({ id: "abc" }, cues, "en", "en", "manual", false);
eq("markdown without timestamps", mdNoTs.includes("["), false);

// paragraph splitting on length
const many = Array.from({ length: 60 }, (_, i) => [i * 3, "sentence number " + i + "."]);
const paras = YS.paragraphs(many);
eq("paragraphs split", paras.length > 1, true);
eq("paragraphs keep all text", paras.map(p => p[1]).join(" ").split(" ").length, many.length * 3);

// --- regressions
const lockup = { a: { lockupViewModel: { contentId: "abcdefghijk", contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
  metadata: { lockupMetadataViewModel: { title: { content: "New layout" } } } } },
  b: { lockupViewModel: { contentId: "PLxxxxxxxxxxxxxxxxxxxxxx", contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" } } };
const found = [];
YS.collectEntries(lockup, new Set(), found);
eq("collectEntries/lockupViewModel (video only)", found, [{ id: "abcdefghijk", title: "New layout" }]);
eq("safeName/does not split emoji", YS.safeName("😀".repeat(100)).length, 180);
eq("renderText/content", YS.renderText({ content: "x" }), "x");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
