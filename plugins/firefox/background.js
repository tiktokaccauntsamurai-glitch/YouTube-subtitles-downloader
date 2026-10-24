// Job runner: turns a link into Markdown files in the Downloads folder.
//
// Requests go out from the background page first (it has host permission for youtube.com,
// so the browser attaches the session). When YouTube refuses that, they are made by the
// content script on a youtube.com tab instead - same-origin, inside the session the
// browser already has. Either way there is no cookie export and no login flow of our own.
//
// Tabs: a job uses at most one youtube.com tab of its own. A tab the user already has
// open is borrowed when it fits, but never navigated away and never closed.

const KEEPALIVE = "yt-subs-keepalive";
const SUB_FORMATS = ["json3", "srv3", "vtt"];
const MAX_LIST_PAGES = 200;
const DIRECT_RETRY_MS = 30 * 60 * 1000;    // after a refusal, skip direct requests this long

const state = {
  running: false,
  cancelled: false,
  log: [],
  summary: "",
};

const ports = new Set();

// per job (reset in runJob)
let currentLimit = 0;                   // 0 = no limit
let directMode = true;                  // requests still go out from the background page
let plainLinksWork = true;              // false once a page link came back empty
let vrLinksWork = true;                 // same, for the android_vr player request
let savedToken = null;                  // pot/c/cver from the last player-captured subtitle URL

// across jobs
let directRefusedAt = -Infinity;

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
    if (state.running && !state.cancelled) {
      state.cancelled = true;
      emit("info", "Stopping...");
    }
    return Promise.resolve({ ok: true });
  }
  if (msg.type === "start") {
    if (state.running) return Promise.resolve({ ok: false, error: "A job is already running." });
    state.running = true;               // set before any await: a second click must not start a second job
    runJob(msg.options || {});          // deliberately not awaited: the popup may close
    return Promise.resolve({ ok: true });
  }
  return false;
});

function checkCancelled() {
  if (state.cancelled) throw new Error("stopped by the user");
}

// ---------------------------------------------------------------- tabs

const YT_TABS = { url: "*://www.youtube.com/*" };   // www only: every URL is canonicalized to it

let workerTab = null;                   // { id, created } - runs requests through its content script
let capture = null;                     // { id, owned, ready } - its player is asked for subtitles

async function ping(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: "ping" });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

// A tab opened before the add-on was installed (or reloaded) has no content script yet.
async function withContentScript(tabId) {
  if (await ping(tabId)) return true;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    return false;                       // a tab we may not script (an error page, for instance)
  }
  return ping(tabId);
}

async function tabOnVideo(tabId, videoId) {
  try {
    const out = await browser.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: playerShows, args: [videoId],
    });
    return Boolean(out && out[0] && out[0].result);
  } catch {
    return false;
  }
}

async function tabAlive(tabId) {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function openOwnTab(url) {
  const tab = await browser.tabs.create({ url, active: false });
  try {
    await browser.tabs.update(tab.id, { muted: true });
  } catch { /* cosmetic */ }
  return tab.id;
}

async function closeTab(tabId) {
  try {
    await browser.tabs.remove(tabId);
  } catch { /* the user may have closed it */ }
}

async function ensureWorkerTab() {
  if (workerTab && await ping(workerTab.id)) return workerTab.id;
  workerTab = null;

  if (capture && capture.owned && await withContentScript(capture.id)) {   // our own tab is already there
    workerTab = { id: capture.id, created: true };
    return capture.id;
  }
  const tabs = await browser.tabs.query(YT_TABS);
  for (const tab of tabs) {             // reuse a YouTube tab the user already has open
    if (await ping(tab.id)) {
      workerTab = { id: tab.id, created: false };
      return tab.id;
    }
  }
  for (const tab of tabs) {
    if (await withContentScript(tab.id)) {
      workerTab = { id: tab.id, created: false };
      return tab.id;
    }
  }

  emit("info", "Opening a background youtube.com tab to run the requests in your session...");
  const id = await openOwnTab("https://www.youtube.com/");
  for (let i = 0; i < 150; i++) {        // up to 45s: a VPN can make the first load slow
    await YS.sleep(300);
    if (await ping(id)) {
      workerTab = { id, created: true };
      return id;
    }
  }
  await closeTab(id);
  throw new Error("could not reach youtube.com - check the connection and that the site is not blocked");
}

// Picks the tab whose player is asked for subtitles, opening none: a tab of the user's that
// already shows this video (nothing to load), else our own worker tab, else nothing yet.
async function prepareCaptureTab(videoId) {
  if (capture && !(await tabAlive(capture.id))) capture = null;
  // a borrowed tab is only good for the video it shows: it is never switched to another one
  if (capture && !capture.owned && !(await tabOnVideo(capture.id, videoId))) capture = null;
  if (capture) return;

  for (const tab of await browser.tabs.query(YT_TABS)) {
    if (await tabOnVideo(tab.id, videoId) && await withContentScript(tab.id)) {
      capture = { id: tab.id, owned: false, ready: true };
      return;
    }
  }
  if (workerTab && workerTab.created) capture = { id: workerTab.id, owned: true, ready: false };
}

// Loads the watch page in our own tab (reusing it when we have one).
async function loadCaptureTab(url) {
  if (capture && capture.owned) {
    try {
      await browser.tabs.update(capture.id, { url });
      capture.ready = true;
      return;
    } catch { /* closed meanwhile */ }
  }
  capture = { id: await openOwnTab(url), owned: true, ready: true };
}

async function releaseTabs() {
  const ours = new Set();
  if (workerTab && workerTab.created) ours.add(workerTab.id);
  if (capture && capture.owned) ours.add(capture.id);
  for (const id of ours) await closeTab(id);
  workerTab = null;
  capture = null;
}

// ---------------------------------------------------------------- requests

function leaveDirectMode(why) {
  if (!directMode) return;
  directMode = false;
  directRefusedAt = Date.now();
  emit("info", `Direct requests did not work (${why}) - using a youtube.com tab instead`);
}

// A request made by the background page itself.
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

async function viaTabId(tabId, message) {
  const res = await browser.tabs.sendMessage(tabId, message);
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res;
}

// Direct first; once that is refused, through the worker tab for the rest of the job
// (and, if the tab's own connection drops, the background page as a last resort).
async function request(message) {
  if (directMode) {
    const res = await direct(message);
    if (res.ok) return res;
    leaveDirectMode(res.error);
  }
  const tabId = await ensureWorkerTab();
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, message);
  } catch {
    workerTab = null;                   // the tab died mid-job: get a fresh one and retry once
    res = await browser.tabs.sendMessage(await ensureWorkerTab(), message);
  }
  if (res && !res.ok && res.network) res = await direct(message);
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res;
}

const ytFetch = async (url) => (await request({ type: "fetchText", url })).text;
const ytPost = async (url, body, extra = {}) =>
  (await request({ type: "postJson", url, body, ...extra })).json;

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

// ---------------------------------------------------------------- subtitles through the player

async function pollPlayer(videoId, track, allowSwitch, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !state.cancelled) {
    await YS.sleep(300);
    let out;
    try {
      out = await browser.scripting.executeScript({
        target: { tabId: capture.id },
        world: "MAIN",
        func: playerCapture,
        args: [videoId, track.languageCode, track.kind === "asr", allowSwitch, capture.owned],
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

async function captureTrackUrl(videoId, url, track) {
  await prepareCaptureTab(videoId);
  if (capture && capture.ready) {       // fast path: the page is open, only the video changes (if at all)
    try {
      const fast = await pollPlayer(videoId, track, capture.owned, 10000);
      if (fast) return fast;
    } catch { /* fall through to a full page load */ }
    checkCancelled();
    if (!capture.owned) capture = null; // the user's tab did not give it up: use one of ours
  }
  await loadCaptureTab(url);
  const slow = await pollPlayer(videoId, track, false, 40000);
  checkCancelled();
  if (!slow) throw new Error("the player did not request the subtitles in time");
  return slow;
}

async function cuesFromPanel(videoId, url, track) {
  const wantName = YS.renderText(track.name);
  await prepareCaptureTab(videoId);
  if (!capture || !(await tabOnVideo(capture.id, videoId))) {
    await loadCaptureTab(url);
    for (let i = 0; i < 130 && !state.cancelled && !(await tabOnVideo(capture.id, videoId)); i++) {
      await YS.sleep(300);
    }
  }
  for (let attempt = 0; attempt < 3 && !state.cancelled; attempt++) {
    let out;
    try {
      out = await browser.scripting.executeScript({
        target: { tabId: capture.id }, world: "MAIN",
        func: readTranscriptPanel, args: [videoId, wantName],
      });
    } catch { out = null; }
    const res = out && out[0] && out[0].result;
    if (res && res.state === "ok") return res.cues;
    await YS.sleep(800);                // YouTube sometimes opens an empty panel: try again
  }
  return [];
}

// ---------------------------------------------------------------- subtitles

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

// Cheapest source first; a source that fails once is skipped for the rest of the job.
async function fetchCues(track, videoId, url, html) {
  const problems = [];
  if (plainLinksWork) {                 // works for the videos YouTube doesn't gate
    const plain = await cuesFromUrl(ytFetch, (fmt) => YS.trackUrl(track, fmt));
    if (plain.cues.length) return { cues: plain.cues, problems };
    plainLinksWork = false;
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
  checkCancelled();
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
      async (u) => (await viaTabId(capture.id, { type: "fetchText", url: u })).text, withFormat);
    if (viaPlayer.cues.length) return { cues: viaPlayer.cues, problems };
    problems.push("player link: empty");
  } catch (err) {
    if (state.cancelled) throw err;
    problems.push(`player: ${errorText(err)}`);
  }
  checkCancelled();
  try {                                 // no link worked: read what the page itself shows
    emit("info", "Reading the transcript panel on the page...");
    const fromPanel = await cuesFromPanel(videoId, url, track);
    if (fromPanel.length) return { cues: fromPanel, problems };
    problems.push("transcript panel: empty");
  } catch (err) {
    problems.push(`transcript panel: ${errorText(err)}`);
  }
  checkCancelled();
  return { cues: [], problems };
}

// ---------------------------------------------------------------- one video

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
  if (!info.id) info.id = videoId || "video";
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
  const listUrl = YS.normalizeListUrl(url);
  let html = await ytFetch(listUrl);
  let data = YS.listData(html);
  if (!data && directMode) {
    leaveDirectMode("the list page came back without data");
    html = await ytFetch(listUrl);
    data = YS.listData(html);
  }
  if (!data) throw new Error("could not read the playlist page");

  const title = YS.listTitle(data);
  const seen = new Set();
  const entries = [];
  YS.collectEntries(data, seen, entries);

  const { apiKey, context } = YS.innertubeConfig(html);
  const endpoint = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false" +
    (apiKey ? `&key=${apiKey}` : "");
  let token = YS.continuationToken(data);
  let pages = 0;
  while (token && context && pages < MAX_LIST_PAGES && !state.cancelled && !limitReached(entries.length)) {
    pages++;
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
  const saved = await browser.storage.local.get(YS.LANG_DEFAULTS);
  return { ...options, ...saved };
}

async function runJob(options) {
  state.running = true;
  state.cancelled = false;
  state.summary = "";
  state.log = [];
  currentLimit = Number(options.limit) || 0;
  directMode = Date.now() - directRefusedAt > DIRECT_RETRY_MS;
  plainLinksWork = true;
  vrLinksWork = true;
  savedToken = null;
  broadcast(snapshot());
  keepAlive(true);

  try {
    options = await withLangSettings(options);
    const input = String(options.url || "").trim().replace(/^["']|["']$/g, "");
    if (!input) throw new Error("paste a video, playlist or channel link");
    const url = YS.canonicalUrl(input);
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
    for (let i = 0; i < list.length && !state.cancelled; i++) {
      const entry = list[i];
      const name = entry.title || entry.id;
      if (i > 0) await YS.sleep(1000 + Math.random() * 2000);  // don't hammer YouTube
      if (state.cancelled) break;
      try {
        const res = await processVideo(YS.watchUrl(entry.id), options, folder);
        done++;
        emit("ok", `[${i + 1}/${list.length}] ${name} -> ${res.lang} / ${res.label}`);
      } catch (err) {
        if (state.cancelled) break;
        failed++;
        emit("skip", `[${i + 1}/${list.length}] ${name} -> ${errorText(err)}`);
      }
    }
    if (state.cancelled) emit("info", "Stopped by the user.");
    state.summary = `Saved ${done} of ${list.length}` + (failed ? `, skipped ${failed}` : "");
    emit("info", `${state.summary}. Folder: Downloads/${folder}`);
  } catch (err) {
    state.summary = state.cancelled ? "Stopped" : "Error";
    emit(state.cancelled ? "info" : "error", state.cancelled ? "Stopped by the user." : errorText(err));
  } finally {
    keepAlive(false);
    await releaseTabs();
    state.running = false;
    broadcast({ type: "status", running: false, summary: state.summary });
  }
}

function errorText(err) {
  const text = String((err && err.message) || err || "unknown error").replace(/\s+/g, " ");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}
