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
  for (let i = 0; i < 60; i++) {
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

async function viaTab(message) {
  const tabId = await ensureWorkerTab();
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, message);
  } catch {
    workerTab = null;                   // the tab died mid-job: get a fresh one and retry once
    const retryId = await ensureWorkerTab();
    res = await browser.tabs.sendMessage(retryId, message);
  }
  if (!res || !res.ok) throw new Error((res && res.error) || "request failed");
  return res;
}

const ytFetch = async (url) => (await viaTab({ type: "fetchText", url })).text;
const ytPost = async (url, body) => (await viaTab({ type: "postJson", url, body })).json;

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

async function fetchCues(track) {
  for (const fmt of SUB_FORMATS) {      // json3 is the cleanest; the rest are fallbacks
    let raw;
    try {
      raw = await ytFetch(YS.trackUrl(track, fmt));
    } catch {
      continue;
    }
    const cues = YS.parseSubtitles(raw, fmt);
    if (cues.length) return cues;
  }
  return [];
}

async function processVideo(url, options, folder) {
  const html = await ytFetch(url);
  const player = YS.playerResponse(html);
  if (!player) throw new Error("could not read the video page (YouTube returned something unexpected)");

  const native = YS.detectLanguage(player);
  const chosen = YS.chooseTrack(player, native, options.lang);
  if (!chosen) {
    throw new Error(YS.playabilityError(player) ||
      "this video has neither manual nor automatic subtitles");
  }

  const cues = await fetchCues(chosen.track);
  const lang = chosen.track.languageCode;
  if (!cues.length) throw new Error(`the ${lang} track is empty or refused to download`);

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
  const html = await ytFetch(YS.normalizeListUrl(url));
  const data = YS.listData(html);
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

async function runJob(options) {
  const input = String(options.url || "").trim().replace(/^["']|["']$/g, "");
  const url = YS.canonicalUrl(input);
  state.running = true;
  state.cancelled = false;
  state.summary = "";
  state.log = [];
  currentLimit = Number(options.limit) || 0;
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
    state.running = false;
    broadcast({ type: "status", running: false, summary: state.summary });
  }
}

function errorText(err) {
  const text = String((err && err.message) || err || "unknown error").replace(/\s+/g, " ");
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}
