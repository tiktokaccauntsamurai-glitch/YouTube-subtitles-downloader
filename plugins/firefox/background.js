// Job runner: turns a link into Markdown files in the Downloads folder.
//
// The background page never talks to youtube.com itself - it asks the content
// script on a youtube.com tab to do it, which keeps every request inside the
// session the browser already has (no cookie export, no login flow of our own).

const KEEPALIVE = "yt-subs-keepalive";
const SUB_FORMATS = ["json3", "srv3", "vtt"];
const MAX_LIST_PAGES = 200;

const state = {
  running: false,
  cancelled: false,
  log: [],
  summary: "",
};

const ports = new Set();
let workerTab = null;                   // { id, created }
let captureTab = null;                  // tab id where the player is asked for subtitles
let plainLinksWork = true;
let vrLinksWork = true;
let savedToken = null;                  // pot/c/cver from the last player-captured subtitle URL                 // same, for the android_vr player request              // false once a page link came back empty (per job)
let currentLimit = 0;                   // 0 = no limit; set per job

// ---------------------------------------------------------------- popup channel

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function emit(kind, text) {
  const entry = { kind, text };
  state.log.push(entry);
  if (state.log.length > 1000) state.log.shift();
  broadcast({ type: "log", entry });
}

function snapshot() {
  return { type: "state", running: state.running, summary: state.summary, log: state.log };
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.postMessage(snapshot());
});

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === "getState") return Promise.resolve(snapshot());
  if (msg.type === "stop") {
    state.cancelled = true;
    if (state.running) emit("info", "Stopping after the current video...");
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "start") {
    if (state.running) return Promise.resolve({ ok: false, error: "A job is already running." });
    runJob(msg.options || {});          // deliberately not awaited: the popup may close
    return Promise.resolve({ ok: true });
  }
  return false;
});

// ---------------------------------------------------------------- worker tab

async function ping(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: "ping" });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

async function ensureWorkerTab() {
  if (workerTab && await ping(workerTab.id)) return workerTab.id;
  workerTab = null;

  // www only: every URL is canonicalized to www.youtube.com, and a request from
  // m. or music. would be cross-origin
  const tabs = await browser.tabs.query({ url: "*://www.youtube.com/*" });
  for (const tab of tabs) {             // reuse a YouTube tab the user already has open
    if (await ping(tab.id)) {
      workerTab = { id: tab.id, created: false };
      return tab.id;
    }
  }
  for (const tab of tabs) {             // opened before the extension was installed
    try {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      if (await ping(tab.id)) {
        workerTab = { id: tab.id, created: false };
        return tab.id;
      }
    } catch {
      // a tab we may not script (an error page, for instance) - try the next one
    }
  }

  emit("info", "Opening a background youtube.com tab to run the requests in your session...");
  const tab = await browser.tabs.create({ url: "https://www.youtube.com/", active: false });
  for (let i = 0; i < 150; i++) {        // up to 45s: a VPN can make the first load slow
    await YS.sleep(300);
    if (await ping(tab.id)) {
      workerTab = { id: tab.id, created: true };
      return tab.id;
    }
  }
  try {
    await browser.tabs.remove(tab.id);
  } catch { /* already gone */ }
  throw new Error("could not reach youtube.com - check the connection and that the site is not blocked");
}

async function releaseWorkerTab() {
  if (workerTab && workerTab.created) {
    try {
      await browser.tabs.remove(workerTab.id);
    } catch { /* the user may have closed it */ }
  }
  workerTab = null;
}

async function viaTabId(tabId, message) {
  const res = await browser.tabs.sendMessage(tabId, message);
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res;
}

// Requests go out from the background page itself first - it has host permission for
// youtube.com and the browser attaches the session, so no tab needs to be opened. Only if
// that is refused (or returns a page without the video data, see leaveDirectMode) does the
// job switch to a youtube.com tab for the rest of the run.
let directMode = true;

function leaveDirectMode(why) {
  if (!directMode) return;
  directMode = false;
  emit("info", `Direct requests did not work (${why}) - using a youtube.com tab instead`);
}

async function viaTab(message) {
  if (directMode) {
    const res = await direct(message);
    if (res && res.ok) return res;
    leaveDirectMode((res && res.error) || "no answer");
  }
  const tabId = await ensureWorkerTab();
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, message);
  } catch {
    workerTab = null;                   // the tab died mid-job: get a fresh one and retry once
    const retryId = await ensureWorkerTab();
    res = await browser.tabs.sendMessage(retryId, message);
  }
  if (res && !res.ok && res.network) res = await direct(message);
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res;
}

// Last resort when the tab's requests can't get through: the background page has host
// permission for youtube.com and sends the browser's cookies along itself.
async function direct(message) {
  try {
    const post = message.type === "postJson";
    const res = await fetch(message.url, post ? {
      method: "POST",
      credentials: message.anonymous ? "omit" : "include",
      headers: { "Content-Type": "application/json", ...(message.headers || {}) },
      body: JSON.stringify(message.body),
    } : { credentials: "include", cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return post ? { ok: true, json: await res.json() } : { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: `network error, youtube.com is unreachable from the add-on (${errorText(err)}) - ` +
      "if the VPN is a browser extension, check that it is not limited to selected sites/tabs" };
  }
}

const ytFetch = async (url) => (await viaTab({ type: "fetchText", url })).text;
const ytPost = async (url, body, extra = {}) =>
  (await viaTab({ type: "postJson", url, body, ...extra })).json;

// ---------------------------------------------------------------- saving

async function download(markdown, filename) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  try {
    const id = await browser.downloads.download({ url, filename, conflictAction: "uniquify" });
    const done = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === "in_progress") return;
      browser.downloads.onChanged.removeListener(done);
      URL.revokeObjectURL(url);
    };
    browser.downloads.onChanged.addListener(done);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return id;
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function downloadPath(id) {
  try {
    const [item] = await browser.downloads.search({ id });
    return item ? item.filename : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- one video

// Runs inside the youtube.com page (MAIN world, so it can reach the player object).
// The player attaches a PO token to its own subtitle requests; plain links taken from
// the page source come back empty. So: ask the player to switch the track on, then read
// the URL it requested from the resource timing list. Called repeatedly until it is ready.
function playerCapture(videoId, lang, asr, allowSwitch) {
  // YouTube pages fill the default 250-entry resource buffer, and later requests are then
  // silently missing from getEntriesByType - so watch them as they happen instead.
  if (!window.__ysSeen) {
    window.__ysSeen = [];
    try {
      performance.setResourceTimingBufferSize(3000);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name.includes("/api/timedtext")) window.__ysSeen.push(e.name);
        }
      }).observe({ type: "resource" });
    } catch { /* falls back to the buffer alone */ }
  }
  const p = document.getElementById("movie_player");
  if (!p || typeof p.getPlayerResponse !== "function") return { state: "wait" };
  const pr = p.getPlayerResponse();
  if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) {
    // an already open player: switch the video inside the page instead of reloading it
    const nav = window.__ysNav || (window.__ysNav = {});
    if (allowSwitch && typeof p.loadVideoById === "function" && !nav[videoId]) {
      nav[videoId] = true;
      if (p.mute) p.mute();
      p.loadVideoById(videoId);
    }
    return { state: "wait" };
  }
  const base = (code) => String(code || "").split("-")[0].toLowerCase();
  const all = window.__ysSubs || (window.__ysSubs = {});
  const S = all[videoId] || (all[videoId] = { asked: 0, tries: 0, retries: 0 });

  const names = performance.getEntriesByType("resource").map((r) => r.name).concat(window.__ysSeen).reverse();
  for (const name of names) {
    if (!name.includes("/api/timedtext") || !name.includes("pot=")) continue;
    const u = new URL(name);
    if (u.searchParams.get("v") === videoId && base(u.searchParams.get("lang")) === base(lang) &&
        (u.searchParams.get("kind") === "asr") === asr && !u.searchParams.get("tlang")) {
      if (p.pauseVideo) p.pauseVideo();
      return { state: "ok", url: name };
    }
  }
  if (S.asked && Date.now() - S.asked < 4000) return { state: "wait" };
  if (S.asked && ++S.retries > 3) return { state: "error", error: "the player did not request the subtitles" };

  if (p.mute) p.mute();
  if (p.loadModule) p.loadModule("captions");
  // auto-generated tracks are left out of the list unless asked for explicitly
  const list = (p.getOption && p.getOption("captions", "tracklist", { includeAsr: true })) || [];
  if (!list.length) {
    if (S.tries % 10 === 5 && p.toggleSubtitlesOn) p.toggleSubtitlesOn();   // nudges the module to load
    return ++S.tries > 80 ? { state: "error", error: "the player lists no subtitle tracks" } : { state: "wait" };
  }
  const track = list.find((t) => t.languageCode === lang && (t.kind === "asr") === asr) ||
    list.find((t) => base(t.languageCode) === base(lang) && (t.kind === "asr") === asr);
  if (!track) {                          // the list may still belong to the previous video
    return ++S.tries > 80
      ? { state: "error", error: `the player has no ${lang} track (has: ${list.map((t) => t.languageCode + (t.kind === "asr" ? "/asr" : "")).join(", ")})` }
      : { state: "wait" };
  }
  if (S.asked) {                         // it may already be showing: switch off and on to force a request
    p.setOption("captions", "track", {});
    if (p.setOption) p.setOption("captions", "reload", true);
  }
  p.setOption("captions", "track", track);
  if (p.toggleSubtitlesOn && S.asked) p.toggleSubtitlesOn();
  S.asked = Date.now();
  return { state: "wait" };
}

async function pollPlayer(videoId, track, allowSwitch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !state.cancelled) {
    await YS.sleep(300);
    let out;
    try {
      out = await browser.scripting.executeScript({
        target: { tabId: captureTab },
        world: "MAIN",
        func: playerCapture,
        args: [videoId, track.languageCode, track.kind === "asr", allowSwitch],
      });
    } catch {
      continue;                         // the page is still loading
    }
    const res = out && out[0] && out[0].result;
    if (res && res.state === "ok") return res.url;
    if (res && res.state === "error") throw new Error(res.error);
  }
  return null;
}

async function openCaptureTab(url) {
  try {
    if (captureTab === null) throw new Error("no tab yet");
    await browser.tabs.update(captureTab, { url });
  } catch {                             // first video, or the user closed the tab
    captureTab = (await browser.tabs.create({ url, active: false })).id;
    try {
      await browser.tabs.update(captureTab, { muted: true });
    } catch { /* cosmetic */ }
  }
}

async function captureTrackUrl(videoId, url, track) {
  if (captureTab !== null) {            // fast path: same page, next video
    try {
      const fast = await pollPlayer(videoId, track, true, 10000);
      if (fast) return fast;
    } catch { /* fall through to a full page load */ }
  }
  await openCaptureTab(url);
  const slow = await pollPlayer(videoId, track, false, 40000);
  if (!slow) throw new Error("the player did not request the subtitles in time");
  return slow;
}

async function releaseCaptureTab() {
  if (captureTab !== null) {
    try {
      await browser.tabs.remove(captureTab);
    } catch { /* already closed */ }
  }
  captureTab = null;
}

// ---------------------------------------------------------------- transcript panel

// Last-resort source, borrowed from how Triangle Downloader reads subtitles: open the
// player page's own "Show transcript" panel and read the text YouTube has already
// rendered into the DOM. No token and no timedtext request is involved, so it works when
// every link above comes back empty. Runs inside the page (self-contained on purpose)
// and is called repeatedly until it reports a final state.
//
// YouTube ships two transcript layouts and which one a video gets varies:
//   legacy - ytd-transcript-segment-renderer rows, language picker in the footer;
//   modern - transcript-segment-view-model rows ("In this video" panel), no picker.
// Everything keys off the rows that exist, never off panel ids or class names.
async function readTranscriptPanel(videoId, wantName) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panels = () => [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")];
  // rows are read ONLY from the panel that is open: after in-site navigation the previous
  // video's panel can stay in the DOM, hidden but still full of its rows
  const openPanel = () => panels().find((p) =>
    p.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" &&
    (p.querySelector("transcript-segment-view-model") || p.querySelector("ytd-transcript-segment-renderer")));
  const modernRows = () => { const p = openPanel(); return p ? [...p.querySelectorAll("transcript-segment-view-model")] : []; };
  // switching language appends a new list and leaves the old one: the last is the active one
  const legacyList = () => {
    const p = openPanel();
    if (!p) return null;
    const lists = p.querySelectorAll("ytd-transcript-segment-list-renderer");
    const last = lists[lists.length - 1];
    return last && last.querySelector("ytd-transcript-segment-renderer") ? last : null;
  };
  const ready = () => modernRows().length > 0 || !!legacyList();
  const clickable = (el) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // the same labels also sit on a tab chip inside the (closed, invisible) panel, hence clickable()
  const OPEN_RE = /show transcript|show video text|показать текст видео|показать расшифровку|расшифровка видео|mostrar transcripci|transcripción|transkript|afficher la transcription|mostrar transcrição|показати текст|показати розшифровку/i;
  const CLOSE_RE = /закрыть|close|скрыть|hide|cerrar|schließen|fermer|fechar|закрити/i;
  const findButton = () => {
    const direct = document.querySelector("ytd-video-description-transcript-section-renderer button");
    if (clickable(direct)) return direct;
    return [...document.querySelectorAll('button, a[role="button"], [role="button"]')].find((b) => {
      const label = (b.getAttribute("aria-label") || "") + " " + (b.textContent || "");
      return OPEN_RE.test(label) && !CLOSE_RE.test(label) && clickable(b);
    });
  };
  const langLabel = () => {
    const p = openPanel();
    const f = p && p.querySelector("ytd-transcript-footer-renderer #label-text");
    return f ? f.textContent.trim() : "";
  };
  const toSec = (t) => {
    const m = /(\d+(?::\d{1,2}){1,2})/.exec(String(t || ""));
    if (!m) return null;
    return m[1].split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
  };
  const extract = () => {
    const cues = [];
    const push = (time, raw) => {
      const t = String(raw || "").replace(/\s+/g, " ").trim();
      if (!t || (cues.length && cues[cues.length - 1][1] === t)) return;   // repeated cue
      cues.push([time == null ? (cues.length ? cues[cues.length - 1][0] : 0) : time, t]);
    };
    const modern = modernRows();
    if (modern.length) {
      // a row is [timestamp][screen-reader label][text]: the whole textContent would glue
      // "0:00" and "0 seconds" onto the sentence
      for (const row of modern) {
        const span = row.querySelector("span");
        const stamp = row.querySelector("div");
        push(toSec(stamp && stamp.textContent), span ? span.textContent : (row.lastElementChild || {}).textContent);
      }
      return cues;
    }
    const list = legacyList();
    if (!list) return cues;
    for (const row of list.querySelectorAll("ytd-transcript-segment-renderer")) {
      const tx = row.querySelector(".segment-text, yt-formatted-string.segment-text");
      const st = row.querySelector(".segment-timestamp");
      if (tx) push(toSec(st && st.textContent), tx.textContent);
    }
    return cues;
  };

  const p = document.getElementById("movie_player");
  const pr = p && p.getPlayerResponse && p.getPlayerResponse();
  if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== videoId) return { state: "wait" };

  const scrollY = window.scrollY;           // leave the page where it was
  try {
    if (!ready()) {
      let btn = findButton();
      if (!btn) {
        // the section sits at the end of the description and has no size until it is expanded
        const more = document.querySelector("ytd-text-inline-expander #expand, #description #expand, tp-yt-paper-button#expand");
        if (clickable(more)) { more.click(); await sleep(700); btn = findButton(); }
      }
      if (!btn) {
        const anchor = document.querySelector("ytd-structured-description-content-renderer, #below, ytd-watch-metadata");
        if (anchor) { anchor.scrollIntoView({ block: "end" }); await sleep(700); btn = findButton(); }
      }
      if (!btn) return { state: "wait" };
      btn.click();
      for (let i = 0; i < 25 && !ready(); i++) await sleep(150);
      if (!ready()) {                       // opened on the wrong tab ("Chapters" instead of the transcript)
        const panel = panels().find((x) => x.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        const tab = panel && [...panel.querySelectorAll("button")].find((b) =>
          /transcript|расшифровка видео|transcripci|transkript|transcription|transcrição|розшифровка/i.test(b.getAttribute("aria-label") || b.textContent || ""));
        if (tab) { tab.click(); for (let i = 0; i < 20 && !ready(); i++) await sleep(150); }
      }
    }
    if (!ready()) return { state: "wait" };

    // only the legacy panel can switch language; the modern one shows whatever YouTube picked
    if (wantName && langLabel() && langLabel() !== wantName) {
      const footer = openPanel().querySelector("ytd-transcript-footer-renderer");
      const trigger = footer && footer.querySelector("tp-yt-paper-button");
      if (trigger) {
        trigger.click();
        await sleep(600);
        const link = [...document.querySelectorAll("tp-yt-iron-dropdown a, tp-yt-paper-listbox a")]
          .filter((a) => a.offsetParent !== null).find((a) => a.textContent.trim() === wantName);
        if (link) {
          link.click();
          for (let i = 0; i < 30 && langLabel() !== wantName; i++) await sleep(150);
          await sleep(500);                 // let the new list render
        } else {
          trigger.click();                  // close the menu, keep the current language
        }
      }
    }
    for (let i = 0; i < 20 && !extract().length; i++) await sleep(150);
    const cues = extract();

    // close the panel again - the capture tab should look as we found it
    const panel = openPanel();
    const close = panel && [...panel.querySelectorAll("button")].find((b) =>
      CLOSE_RE.test(b.getAttribute("aria-label") || ""));
    if (close) close.click();

    return cues.length ? { state: "ok", cues } : { state: "wait" };
  } finally {
    window.scrollTo(0, scrollY);
  }
}

async function cuesFromPanel(videoId, url, track) {
  const wantName = YS.renderText(track.name);
  const onThisVideo = async () => {
    try {
      const out = await browser.scripting.executeScript({
        target: { tabId: captureTab }, world: "MAIN",
        func: (id) => {
          const p = document.getElementById("movie_player");
          const pr = p && p.getPlayerResponse && p.getPlayerResponse();
          return Boolean(pr && pr.videoDetails && pr.videoDetails.videoId === id);
        },
        args: [videoId],
      });
      return Boolean(out && out[0] && out[0].result);
    } catch { return false; }
  };
  if (captureTab === null || !(await onThisVideo())) {
    await openCaptureTab(url);
    for (let i = 0; i < 130 && !(await onThisVideo()); i++) await YS.sleep(300);
  }
  for (let attempt = 0; attempt < 3 && !state.cancelled; attempt++) {
    let out;
    try {
      out = await browser.scripting.executeScript({
        target: { tabId: captureTab }, world: "MAIN",
        func: readTranscriptPanel, args: [videoId, wantName],
      });
    } catch { out = null; }
    const res = out && out[0] && out[0].result;
    if (res && res.state === "ok") return res.cues;
    await YS.sleep(800);                    // YouTube sometimes opens an empty panel: try again
  }
  return [];
}

async function cuesFromUrl(fetchOne, base) {
  const problems = [];
  for (const fmt of SUB_FORMATS) {      // json3 is the cleanest; the rest are fallbacks
    let raw;
    try {
      raw = await fetchOne(base(fmt));
    } catch (err) {
      problems.push(`${fmt}: ${errorText(err)}`);
      continue;
    }
    const cues = YS.parseSubtitles(raw, fmt);
    if (cues.length) return { cues, problems };
    problems.push(`${fmt}: empty response`);
    if (!raw || !raw.trim()) break;     // YouTube refused (no PO token): other formats won't differ
  }
  return { cues: [], problems };
}

// The android_vr client gets subtitle links without a PO token (yt-dlp relies on the same
// thing). Anonymous on purpose: it needs no session. One cheap request; any failure just
// falls through to the player-based path below.
async function vrTrackUrl(videoId, html, track) {
  const { apiKey } = YS.innertubeConfig(html);
  const endpoint = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false" +
    (apiKey ? `&key=${apiKey}` : "");
  const client = {
    clientName: "ANDROID_VR", clientVersion: "1.60.19", deviceMake: "Oculus", deviceModel: "Quest 3",
    androidSdkVersion: 32, osName: "Android", osVersion: "12L", hl: "en",
  };
  const resp = await ytPost(endpoint, { context: { client }, videoId, contentCheckOk: true, racyCheckOk: true },
    { anonymous: true, headers: { "User-Agent": "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip" } });
  const found = ((resp.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  const wantAsr = track.kind === "asr";
  const same = found.find((t) => t.baseUrl && t.languageCode === track.languageCode && (t.kind === "asr") === wantAsr) ||
    found.find((t) => t.baseUrl && YS.baseLang(t.languageCode) === YS.baseLang(track.languageCode) && (t.kind === "asr") === wantAsr);
  if (!same) {
    const status = (resp.playabilityStatus || {}).status || "?";
    throw new Error(`no matching track (${status}, ${found.length} tracks)`);
  }
  return same;
}

async function fetchCues(track, videoId, url, html) {
  const problems = [];
  if (plainLinksWork) {                 // cheap path: works for the videos YouTube doesn't gate
    const plain = await cuesFromUrl(ytFetch, (fmt) => YS.trackUrl(track, fmt));
    if (plain.cues.length) return { cues: plain.cues, problems };
    plainLinksWork = false;             // it is gated: don't retry it for every video of a playlist
    problems.push("page link: empty");
  }
  if (vrLinksWork) {
    try {
      const vrTrack = await vrTrackUrl(videoId, html, track);
      const vr = await cuesFromUrl(ytFetch, (fmt) => YS.trackUrl(vrTrack, fmt));
      if (vr.cues.length) return { cues: vr.cues, problems };
      throw new Error(vr.problems.join(", ") || "empty");
    } catch (err) {
      vrLinksWork = false;
      problems.push(`android_vr: ${errorText(err)}`);
    }
  }
  if (savedToken) {                     // a token from an earlier capture, if YouTube still accepts it
    const withToken = (fmt) => {
      const u = new URL(YS.trackUrl(track, fmt));
      for (const [k, v] of Object.entries(savedToken)) u.searchParams.set(k, v);
      return u.toString();
    };
    const reused = await cuesFromUrl(ytFetch, withToken);
    if (reused.cues.length) return { cues: reused.cues, problems };
    savedToken = null;
    problems.push("saved token: empty");
  }
  try {
    emit("info", "Getting the subtitles through the player...");
    const captured = await captureTrackUrl(videoId, url, track);
    const cu = new URL(captured);
    savedToken = {};
    for (const k of ["pot", "potc", "c", "cver"]) if (cu.searchParams.has(k)) savedToken[k] = cu.searchParams.get(k);
    const withFormat = (fmt) => {
      const u = new URL(captured);
      u.searchParams.set("fmt", fmt);
      return u.toString();
    };
    const viaPlayer = await cuesFromUrl(
      async (u) => (await viaTabId(captureTab, { type: "fetchText", url: u })).text, withFormat);
    if (viaPlayer.cues.length) return { cues: viaPlayer.cues, problems };
    problems.push("player link: empty");
  } catch (err) {
    problems.push(`player: ${errorText(err)}`);
  }
  try {                                 // no link worked: read what the page itself shows
    emit("info", "Reading the transcript panel on the page...");
    const fromPanel = await cuesFromPanel(videoId, url, track);
    if (fromPanel.length) return { cues: fromPanel, problems };
    problems.push("transcript panel: empty");
  } catch (err) {
    problems.push(`transcript panel: ${errorText(err)}`);
  }
  return { cues: [], problems };
}

// The watch page sometimes arrives without its embedded data (a consent wall or a
// trimmed page for some regions / VPN exits); the player API returns the same object.
async function apiPlayerResponse(url, html) {
  const videoId = YS.videoIdFromUrl(url);
  if (!videoId) throw new Error("could not read the video page");
  const { apiKey, context } = YS.innertubeConfig(html);
  const endpoint = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false" +
    (apiKey ? `&key=${apiKey}` : "");
  const ctx = context || { client: { clientName: "WEB", clientVersion: "2.20250925.01.00", hl: "en" } };
  let resp;
  try {
    resp = await ytPost(endpoint, { context: ctx, videoId, contentCheckOk: true, racyCheckOk: true });
  } catch (err) {
    throw new Error(`could not read the video page (${errorText(err)})`);
  }
  if (!resp || !(resp.videoDetails || resp.captions || resp.playabilityStatus)) {
    throw new Error("could not read the video page (YouTube returned something unexpected)");
  }
  return resp;
}

async function processVideo(url, options, folder) {
  let html = await ytFetch(url);
  let player = YS.playerResponse(html);
  if (!player && directMode) {          // a consent wall or a stripped page: retry inside a real tab
    leaveDirectMode("the watch page came back without video data");
    html = await ytFetch(url);
    player = YS.playerResponse(html);
  }
  player = player || await apiPlayerResponse(url, html);

  const native = YS.detectLanguage(player);
  // automatic: a video in the user's own language gets that language, any other video the fallback one
  const prefs = options.lang || (options.autoLang === false
    ? options.langs
    : (native === options.autoMine ? options.autoMine : options.autoOther));
  const chosen = YS.chooseTrack(player, native, prefs, options.anyLang !== false);
  if (!chosen) {
    throw new Error(YS.playabilityError(player) ||
      "this video has neither manual nor automatic subtitles");
  }

  const videoId = (player.videoDetails || {}).videoId || YS.videoIdFromUrl(url) || "";
  const { cues, problems } = await fetchCues(chosen.track, videoId, url, html);
  const lang = chosen.track.languageCode;
  if (!cues.length) {
    throw new Error(`the ${lang} track is empty or refused to download (${problems.join("; ")})`);
  }

  const info = YS.videoInfo(player);
  if (!info.id) info.id = YS.videoIdFromUrl(url) || "video";
  const markdown = YS.buildMarkdown(info, cues, native, lang, chosen.label, options.timestamps);

  const name = `${YS.safeName(info.title || info.id)} [${info.id}].md`;
  const id = await download(markdown, folder ? `${folder}/${name}` : name);
  return { id, native, lang, label: chosen.label, count: cues.length };
}

// ---------------------------------------------------------------- playlists and channels

function limitReached(count) {
  return currentLimit > 0 && count >= currentLimit;
}

async function collectEntries(url) {
  let html = await ytFetch(YS.normalizeListUrl(url));
  let data = YS.listData(html);
  if (!data && directMode) {
    leaveDirectMode("the list page came back without data");
    html = await ytFetch(YS.normalizeListUrl(url));
    data = YS.listData(html);
  }
  if (!data) throw new Error("could not read the playlist page");

  const title = YS.listTitle(data);
  const seen = new Set();
  const entries = [];
  YS.collectEntries(data, seen, entries);

  const { apiKey, context } = YS.innertubeConfig(html);
  let token = YS.continuationToken(data);
  let pages = 0;
  while (token && context && pages < MAX_LIST_PAGES && !state.cancelled && !limitReached(entries.length)) {
    pages++;
    const endpoint = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false" +
      (apiKey ? `&key=${apiKey}` : "");
    let page;
    try {
      page = await ytPost(endpoint, { context, continuation: token });
    } catch {
      break;                            // a partial list is better than none
    }
    const before = entries.length;
    YS.collectEntries(page, seen, entries);
    token = YS.continuationToken(page);
    if (entries.length === before) break;
    emit("info", `Collecting the list... ${entries.length} videos`);
    await YS.sleep(400);
  }
  return { title, entries };
}

// ---------------------------------------------------------------- job

function keepAlive(on) {
  // The event page is suspended after ~30s of inactivity, which would kill a
  // long playlist run; a periodic alarm keeps it awake until the job is done.
  if (on) browser.alarms.create(KEEPALIVE, { periodInMinutes: 0.35 });
  else browser.alarms.clear(KEEPALIVE);
}
browser.alarms.onAlarm.addListener(() => { /* waking the page is the whole point */ });

// Language preferences live on the settings page; the popup's own choice (options.lang) wins.
async function withLangSettings(options) {
  const saved = await browser.storage.local.get({ autoLang: true, autoMine: "ru", autoOther: "en", langs: ["ru", "en"], anyLang: true });
  return { ...options, ...saved };
}

async function runJob(options) {
  options = await withLangSettings(options);
  const input = String(options.url || "").trim().replace(/^["']|["']$/g, "");
  const url = YS.canonicalUrl(input);
  state.running = true;
  state.cancelled = false;
  state.summary = "";
  state.log = [];
  currentLimit = Number(options.limit) || 0;
  directMode = true;
  broadcast(snapshot());
  keepAlive(true);

  try {
    if (!input) throw new Error("paste a video, playlist or channel link");
    if (!url) throw new Error("this is not a YouTube link");

    if (!YS.isPlaylistUrl(url)) {
      emit("info", "Reading the video...");
      const res = await processVideo(url, options, "");
      emit("ok", `Video language ${res.native}, saved ${res.label} subtitles [${res.lang}], ${res.count} cues`);
      const path = await downloadPath(res.id);
      if (path) emit("info", `File: ${path}`);
      state.summary = "Done";
      return;
    }

    emit("info", "Reading the list...");
    const { title, entries } = await collectEntries(url);
    const list = currentLimit > 0 ? entries.slice(0, currentLimit) : entries;
    if (!list.length) throw new Error("no available videos in this list");

    const folder = YS.safeName(title || "playlist");
    emit("info", `List: ${title} - videos: ${list.length}`);
    emit("info", `Folder: Downloads/${folder}`);

    let done = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      if (state.cancelled) {
        emit("info", "Stopped by the user.");
        break;
      }
      const entry = list[i];
      const name = entry.title || entry.id;
      if (i > 0) await YS.sleep(1000 + Math.random() * 2000);  // don't hammer YouTube
      try {
        const res = await processVideo(YS.watchUrl(entry.id), options, folder);
        done++;
        emit("ok", `[${i + 1}/${list.length}] ${name} -> ${res.lang} / ${res.label}`);
      } catch (err) {
        failed++;
        emit("skip", `[${i + 1}/${list.length}] ${name} -> ${errorText(err)}`);
      }
    }
    state.summary = `Saved ${done} of ${list.length}` + (failed ? `, skipped ${failed}` : "");
    emit("info", `${state.summary}. Folder: Downloads/${folder}`);
  } catch (err) {
    state.summary = "Error";
    emit("error", errorText(err));
  } finally {
    keepAlive(false);
    await releaseWorkerTab();
    await releaseCaptureTab();
    state.running = false;
    broadcast({ type: "status", running: false, summary: state.summary });
  }
}

function errorText(err) {
  const text = String((err && err.message) || err || "unknown error").replace(/\s+/g, " ");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}
