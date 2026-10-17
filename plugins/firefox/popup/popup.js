const el = {
  url: document.getElementById("url"),
  lang: document.getElementById("lang"),
  langCustom: document.getElementById("langCustom"),
  limit: document.getElementById("limit"),
  limitField: document.getElementById("limitField"),
  timestamps: document.getElementById("timestamps"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  summary: document.getElementById("summary"),
  log: document.getElementById("log"),
};

// Same rule as YS.isPlaylistUrl in lib/youtube.js (the popup does not load lib/).
function isListLink(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return false;
  }
  if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return false;
  if (u.searchParams.has("list")) return u.pathname.startsWith("/playlist") || !u.searchParams.has("v");
  return /^\/(@[^/]+|c\/[^/]+|user\/[^/]+|channel\/[^/]+)/i.test(u.pathname);
}

function syncLimit() {
  el.limitField.classList.toggle("hidden", !isListLink(el.url.value));
}

const DEFAULT_SETTINGS = { autoLang: true, autoMine: "ru", autoOther: "en", langs: ["ru", "en"], anyLang: true };
let presets = new Set([""]);

// The language menu mirrors the settings page: the first entry says what "default" means
// right now, then come the user's own languages as quick choices.
function buildLangMenu(s) {
  const langs = Array.isArray(s.langs) ? s.langs : DEFAULT_SETTINGS.langs;
  const first = s.autoLang
    ? "Auto"
    : `Auto: ${langs.join(" → ")}`;
  el.lang.textContent = "";
  const add = (value, text) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    el.lang.appendChild(o);
  };
  add("", first);
  for (const code of langs) add(code, code);
  add("custom", "Other code…");
  presets = new Set(["", ...langs]);
}

function pickLang(value) {
  if (presets.has(value)) {
    el.lang.value = value;
  } else {
    el.lang.value = "custom";
    el.langCustom.value = value;
  }
  syncCustom();
}

function chosenLang() {
  return el.lang.value === "custom" ? el.langCustom.value.trim().toLowerCase() : el.lang.value;
}

function syncCustom() {
  el.langCustom.classList.toggle("hidden", el.lang.value !== "custom");
}

function addLine(entry) {
  const li = document.createElement("li");
  li.className = entry.kind;
  li.textContent = entry.text;
  el.log.appendChild(li);
  el.log.scrollTop = el.log.scrollHeight;
}

function setRunning(running) {
  el.start.disabled = running;
  el.stop.disabled = !running;
  el.start.textContent = running ? "Working…" : "Save subtitles";
}

function render(state) {
  el.log.textContent = "";
  for (const entry of state.log || []) addLine(entry);
  el.summary.textContent = state.summary || "";
  setRunning(state.running);
}

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const saved = await browser.storage.local.get({ ...DEFAULT_SETTINGS, lang: "", timestamps: true, limit: 0 });
  buildLangMenu(saved);
  pickLang(saved.lang);
  el.timestamps.checked = saved.timestamps;
  el.limit.value = saved.limit;
}

function saveSettings() {
  browser.storage.local.set({
    lang: chosenLang(),
    timestamps: el.timestamps.checked,
    limit: Number(el.limit.value) || 0,
  });
}

async function prefillUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(tab.url || "")) {
    el.url.value = tab.url;
  }
  syncLimit();
  el.url.focus();
}

// ---------------------------------------------------------------- wiring

// the settings page may be changed while the popup is open
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.langs || changes.autoLang || changes.autoMine || changes.autoOther)) return;
  const s = await browser.storage.local.get(DEFAULT_SETTINGS);
  const current = chosenLang();
  buildLangMenu(s);
  pickLang(current);
});

const port = browser.runtime.connect({ name: "popup" });
port.onMessage.addListener((msg) => {
  if (msg.type === "state") render(msg);
  else if (msg.type === "log") addLine(msg.entry);
  else if (msg.type === "status") {
    setRunning(msg.running);
    el.summary.textContent = msg.summary || "";
  }
});

el.lang.addEventListener("change", () => {
  syncCustom();
  saveSettings();
});
el.langCustom.addEventListener("change", saveSettings);
el.url.addEventListener("input", syncLimit);
el.timestamps.addEventListener("change", saveSettings);
el.limit.addEventListener("change", saveSettings);

el.start.addEventListener("click", async () => {
  saveSettings();
  setRunning(true);
  el.log.textContent = "";
  el.summary.textContent = "";
  const res = await browser.runtime.sendMessage({
    type: "start",
    options: {
      url: el.url.value,
      lang: chosenLang(),
      timestamps: el.timestamps.checked,
      limit: Number(el.limit.value) || 0,
    },
  });
  if (res && !res.ok) {
    addLine({ kind: "error", text: res.error });
    setRunning(false);
  }
});

document.getElementById("openSettings").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

el.stop.addEventListener("click", () => {
  browser.runtime.sendMessage({ type: "stop" });
});

el.url.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !el.start.disabled) el.start.click();
});

(async () => {
  await loadSettings();
  const state = await browser.runtime.sendMessage({ type: "getState" });
  if (state) render(state);
  if (!state || !state.running) await prefillUrl();
})();
