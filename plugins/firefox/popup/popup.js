const el = {
  url: document.getElementById("url"),
  lang: document.getElementById("lang"),
  langCustom: document.getElementById("langCustom"),
  limit: document.getElementById("limit"),
  timestamps: document.getElementById("timestamps"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  summary: document.getElementById("summary"),
  log: document.getElementById("log"),
};

const PRESETS = new Set(["", "ru", "en", "es", "de", "fr"]);

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
  const saved = await browser.storage.local.get({ lang: "", timestamps: true, limit: 0 });
  if (PRESETS.has(saved.lang)) {
    el.lang.value = saved.lang;
  } else {
    el.lang.value = "custom";
    el.langCustom.value = saved.lang;
  }
  el.timestamps.checked = saved.timestamps;
  el.limit.value = saved.limit;
  syncCustom();
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
  el.url.focus();
}

// ---------------------------------------------------------------- wiring

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
