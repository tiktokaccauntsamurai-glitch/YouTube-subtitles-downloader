// Everything that knows about YouTube's page payloads.
// No network calls live here: the raw HTML/JSON is fetched by the content script
// (see content.js) so that every request runs on youtube.com with the session
// the browser already has.
var YS = globalThis.YS || (globalThis.YS = {});

const VIDEO_ID_RE = /^[\w-]{11}$/;
const CHANNEL_PATH_RE = /^\/(@[^/]+|c\/[^/]+|user\/[^/]+|channel\/[^/]+)(?:\/([^/]*))?/i;
const HOST_RE = /^((www|m|music)\.)?youtube\.com$/i;

// ---------------------------------------------------------------- urls

YS.videoIdFromUrl = function (url) {
  const m = /[?&]v=([\w-]{11})/.exec(url) ||
    /youtu\.be\/([\w-]{11})/.exec(url) ||
    /youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/.exec(url);
  return m ? m[1] : null;
};

// Any YouTube link -> the same thing on www.youtube.com, or null for anything else.
// Every request then goes to the one origin the worker tab is on, and youtu.be /
// shorts / live links become plain watch links (with their list= kept, so that
// "a video opened from a playlist" still means just that video).
YS.canonicalUrl = function (raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "youtu.be" && !HOST_RE.test(host)) return null;

  const list = url.searchParams.get("list");
  const short = host === "youtu.be"
    ? /^\/([\w-]{11})/.exec(url.pathname)
    : /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(url.pathname);
  if (short) {
    return YS.watchUrl(short[1]) + (list ? `&list=${encodeURIComponent(list)}` : "");
  }
  if (host === "youtu.be") return null;
  return `https://www.youtube.com${url.pathname}${url.search}`;
};

YS.isPlaylistUrl = function (url) {
  const u = new URL(url);
  if (u.searchParams.has("list")) {     // watch?v=..&list=.. is still just one video
    return u.pathname.startsWith("/playlist") || !u.searchParams.has("v");
  }
  return CHANNEL_PATH_RE.test(u.pathname);
};

// A channel link is redirected to its Videos tab (Shorts and Live are kept),
// otherwise YouTube returns the Home tab. Share junk like ?si=.. is dropped.
YS.normalizeListUrl = function (url) {
  const u = new URL(url);
  const m = CHANNEL_PATH_RE.exec(u.pathname);
  if (!m || u.searchParams.has("list")) return url;
  const tab = /^(videos|shorts|streams)$/i.test(m[2] || "") ? m[2].toLowerCase() : "videos";
  return `${u.origin}/${m[1]}/${tab}`;
};

YS.watchUrl = function (videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
};

// ---------------------------------------------------------------- watch page

// The name shows up in more than one place in the page source (a guard clause,
// a fallback assignment), so the candidates are tried until one parses into
// something that actually looks like the payload we want.
function extractPayload(html, markers, looksRight) {
  for (const marker of markers) {
    const data = YS.extractJsonAfter(html, marker);
    if (data && looksRight(data)) return data;
  }
  return null;
}

YS.playerResponse = function (html) {
  return extractPayload(
    html,
    ["var ytInitialPlayerResponse", "ytInitialPlayerResponse"],
    (d) => d.videoDetails || d.captions || d.playabilityStatus,
  );
};

YS.listData = function (html) {
  return extractPayload(
    html,
    ['var ytInitialData', 'window["ytInitialData"]', "ytInitialData"],
    (d) => d.contents || d.onResponseReceivedActions || d.metadata,
  );
};

YS.videoInfo = function (pr) {
  const details = pr.videoDetails || {};
  const micro = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
  const published = micro.publishDate || micro.uploadDate || "";
  return {
    id: details.videoId || "",
    title: details.title || "",
    uploader: details.author || micro.ownerChannelName || "",
    uploadDate: published.slice(0, 10),
    duration: Number(details.lengthSeconds || micro.lengthSeconds || 0),
  };
};

function captionTracks(pr) {
  const list = pr.captions &&
    pr.captions.playerCaptionsTracklistRenderer &&
    pr.captions.playerCaptionsTracklistRenderer.captionTracks;
  return Array.isArray(list) ? list.filter((t) => t && t.baseUrl) : [];
}

// The video's spoken language. Auto-captions only ever exist for it, so an ASR
// track is the most reliable signal; the default audio track is the fallback.
YS.detectLanguage = function (pr) {
  const tracks = captionTracks(pr);
  const asr = tracks.find((t) => t.kind === "asr");
  if (asr) return YS.baseLang(asr.languageCode);

  const audio = (pr.streamingData && pr.streamingData.adaptiveFormats || [])
    .find((f) => f.audioTrack && f.audioTrack.audioIsDefault);
  if (audio && audio.audioTrack.id) return YS.baseLang(audio.audioTrack.id.split(".")[0]);

  const manual = tracks.filter((t) => t.kind !== "asr");
  if (manual.length === 1) return YS.baseLang(manual[0].languageCode);
  return "en";
};

function matchLang(tracks, target) {
  const hits = tracks.filter((t) => YS.baseLang(t.languageCode) === target);
  if (!hits.length) return null;
  return hits.find((t) => String(t.languageCode).toLowerCase() === target) ||
    hits.sort((a, b) => a.languageCode.length - b.languageCode.length)[0];
}

// Priority: manual target -> automatic target -> the same pair in the native
// language -> anything that exists. `targetLang` overrides the ru/en default: a code,
// or an ordered list of codes (each tried manual-then-automatic before the next one).
// With anyFallback === false the last "anything that exists" step is skipped.
YS.chooseTrack = function (pr, native, targetLang, anyFallback = true) {
  const tracks = captionTracks(pr);
  if (!tracks.length) return null;

  const manual = tracks.filter((t) => t.kind !== "asr");
  const autos = tracks.filter((t) => t.kind === "asr");
  let targets = (Array.isArray(targetLang) ? targetLang : [targetLang])
    .map((c) => YS.baseLang(c)).filter(Boolean);
  targets = targets.filter((c, i) => targets.indexOf(c) === i);
  if (!targets.length) targets = [native === "ru" ? "ru" : "en"];

  const plan = [];
  for (const target of targets) plan.push([manual, target, "manual"], [autos, target, "automatic"]);
  if (!targets.includes(native)) {      // the target language may not exist at all
    plan.push([manual, native, "manual (native language)"],
              [autos, native, "automatic (native language)"]);
  }
  for (const [store, lang, label] of plan) {
    const track = matchLang(store, lang);
    if (track) return { track, label };
  }
  if (!anyFallback) return null;
  for (const [store, label] of [[manual, "manual (other language)"], [autos, "automatic (other language)"]]) {
    if (store.length) {
      const track = [...store].sort((a, b) => a.languageCode.length - b.languageCode.length)[0];
      return { track, label };
    }
  }
  return null;
};

YS.trackUrl = function (track, fmt) {
  const url = new URL(track.baseUrl, "https://www.youtube.com");
  url.searchParams.set("fmt", fmt);
  return url.toString();
};

// ---------------------------------------------------------------- playlists and channels

YS.listTitle = function (data) {
  const meta = data.metadata || {};
  return YS.renderText((meta.playlistMetadataRenderer || {}).title) ||
    YS.renderText((meta.channelMetadataRenderer || {}).title) ||
    YS.renderText(((data.header || {}).playlistHeaderRenderer || {}).title) ||
    (meta.playlistMetadataRenderer || {}).title ||
    (meta.channelMetadataRenderer || {}).title ||
    "playlist";
};

// Video renderers differ per surface (playlist / grid / shelf), so instead of
// matching each one we collect every node that carries a video id and a title
// (or a lockupViewModel of the video type).
YS.collectEntries = function (data, seen, out) {
  YS.walk(data, (node) => {
    // current surfaces (channel tabs, many playlists) use lockupViewModel
    if (node.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && typeof node.contentId === "string") {
      const lockupTitle = (((node.metadata || {}).lockupMetadataViewModel || {}).title || {}).content;
      if (VIDEO_ID_RE.test(node.contentId) && !seen.has(node.contentId)) {
        seen.add(node.contentId);
        out.push({ id: node.contentId, title: lockupTitle || "" });
      }
      return;
    }
    const id = node.videoId;
    if (typeof id !== "string" || !VIDEO_ID_RE.test(id) || seen.has(id)) return;
    if (!node.title && !node.headline) return;
    seen.add(id);
    out.push({ id, title: YS.renderText(node.title || node.headline) });
  });
};

YS.continuationToken = function (data) {
  let token = null;
  YS.walk(data, (node) => {
    const command = node.continuationCommand;
    if (command && command.token) token = command.token;
  });
  return token;
};

YS.innertubeConfig = function (html) {
  const key = /"INNERTUBE_API_KEY":"([\w-]+)"/.exec(html);
  return {
    apiKey: key ? key[1] : null,
    context: YS.extractJsonAfter(html, '"INNERTUBE_CONTEXT"'),
  };
};

// ---------------------------------------------------------------- errors

const PLAYABILITY = {
  LOGIN_REQUIRED: "YouTube asks for a sign-in — sign in to youtube.com in this browser",
  AGE_VERIFICATION_REQUIRED: "age-restricted (18+) video — sign in to youtube.com in this browser",
  UNPLAYABLE: "video unavailable (private, members-only or blocked in this region)",
  LIVE_STREAM_OFFLINE: "live stream hasn't started or hasn't ended yet",
  ERROR: "video unavailable (removed or blocked)",
};

YS.playabilityError = function (pr) {
  const status = pr.playabilityStatus || {};
  if (!status.status || status.status === "OK") return null;
  const reason = status.reason || YS.renderText((status.errorScreen || {}).reason) || "";
  const known = PLAYABILITY[status.status];
  if (!known) return reason || status.status;
  return reason && !/^\s*$/.test(reason) ? `${known} (${reason})` : known;
};
