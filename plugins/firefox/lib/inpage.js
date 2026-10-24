// Functions that run INSIDE a youtube.com page (scripting.executeScript, MAIN world).
//
// executeScript serializes each function on its own, so every one of them must be
// self-contained: no closures, no YS helpers, nothing from the background scope.
// They are called repeatedly and report { state: "wait" } until they have a result.

// True when the page's player currently holds the given video.
function playerShows(videoId) {
  const p = document.getElementById("movie_player");
  const pr = p && p.getPlayerResponse && p.getPlayerResponse();
  return Boolean(pr && pr.videoDetails && pr.videoDetails.videoId === videoId);
}

// The player attaches a PO token to its own subtitle requests; plain links taken from
// the page source come back empty. So: ask the player to switch the track on, then read
// the URL it requested from the resource timing list.
//
// allowSwitch: load the video inside an already open player instead of a page reload.
// own: the tab is ours. In a tab the user opened the player is left as we found it -
// not muted, not paused, and its caption setting is put back once the URL is captured.
function playerCapture(videoId, lang, asr, allowSwitch, own) {
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
    const nav = window.__ysNav || (window.__ysNav = {});
    if (allowSwitch && typeof p.loadVideoById === "function" && !nav[videoId]) {
      nav[videoId] = true;
      if (own && p.mute) p.mute();
      p.loadVideoById(videoId);
    }
    return { state: "wait" };
  }
  const base = (code) => String(code || "").split("-")[0].toLowerCase();
  const all = window.__ysSubs || (window.__ysSubs = {});
  const S = all[videoId] || (all[videoId] = { asked: 0, tries: 0, retries: 0, before: null });

  const restore = () => {
    if (own || !S.before) return;
    try {
      if (S.before.languageCode) p.setOption("captions", "track", S.before);
      else if (p.unloadModule) p.unloadModule("captions");
    } catch { /* cosmetic */ }
  };

  const names = performance.getEntriesByType("resource").map((r) => r.name).concat(window.__ysSeen).reverse();
  for (const name of names) {
    if (!name.includes("/api/timedtext") || !name.includes("pot=")) continue;
    const u = new URL(name);
    if (u.searchParams.get("v") === videoId && base(u.searchParams.get("lang")) === base(lang) &&
        (u.searchParams.get("kind") === "asr") === asr && !u.searchParams.get("tlang")) {
      if (own && p.pauseVideo) p.pauseVideo();
      restore();
      delete all[videoId];              // a later job on this page starts over
      if (window.__ysNav) delete window.__ysNav[videoId];
      return { state: "ok", url: name };
    }
  }
  if (S.asked && Date.now() - S.asked < 4000) return { state: "wait" };
  if (S.asked && ++S.retries > 3) {
    restore();
    return { state: "error", error: "the player did not request the subtitles" };
  }

  if (own && p.mute) p.mute();
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
  if (!S.before) S.before = p.getOption("captions", "track") || {};
  if (S.asked) {                         // it may already be showing: switch off and on to force a request
    p.setOption("captions", "track", {});
    p.setOption("captions", "reload", true);
  }
  p.setOption("captions", "track", track);
  if (p.toggleSubtitlesOn && S.asked) p.toggleSubtitlesOn();
  S.asked = Date.now();
  return { state: "wait" };
}

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
