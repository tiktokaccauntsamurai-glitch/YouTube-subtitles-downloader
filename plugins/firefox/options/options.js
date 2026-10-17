const DEFAULTS = { autoLang: true, autoMine: "ru", autoOther: "en", langs: ["ru", "en"], anyLang: true };

const NAMES = {
  ru: "Russian", en: "English", uk: "Ukrainian", be: "Belarusian", es: "Spanish", de: "German",
  fr: "French", it: "Italian", pt: "Portuguese", pl: "Polish", nl: "Dutch", tr: "Turkish",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic", hi: "Hindi", cs: "Czech",
  sv: "Swedish", fi: "Finnish", el: "Greek", he: "Hebrew", id: "Indonesian", vi: "Vietnamese",
};

const el = {
  auto: document.getElementById("auto"),
  mine: document.getElementById("mine"),
  other: document.getElementById("other"),
  rule: document.getElementById("autoRule"),
  manual: document.getElementById("manual"),
  list: document.getElementById("list"),
  code: document.getElementById("code"),
  addBtn: document.getElementById("addBtn"),
  any: document.getElementById("any"),
  reset: document.getElementById("reset"),
  saved: document.getElementById("saved"),
  known: document.getElementById("known"),
};

let langs = [];
let timer = null;

for (const [code, name] of Object.entries(NAMES)) {
  const o = document.createElement("option");
  o.value = code;
  o.label = name;
  el.known.appendChild(o);
}

function render() {
  el.rule.classList.toggle("hidden", !el.auto.checked);
  el.list.textContent = "";
  langs.forEach((code, i) => {
    const li = document.createElement("li");
    const mk = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    li.append(mk("n", `${i + 1}.`), mk("c", code), mk("name", NAMES[code] || ""));
    const btn = (label, title, disabled, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title; b.disabled = disabled;
      b.addEventListener("click", fn);
      return b;
    };
    li.append(
      btn("\u2191", "Move up", i === 0, () => move(i, -1)),
      btn("\u2193", "Move down", i === langs.length - 1, () => move(i, 1)),
      btn("\u2715", "Remove", false, () => { langs.splice(i, 1); save(); }),
    );
    el.list.appendChild(li);
  });
}

function move(i, d) {
  [langs[i], langs[i + d]] = [langs[i + d], langs[i]];
  save();
}

function addCode() {
  const code = el.code.value.trim().toLowerCase().replace("_", "-");
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(code)) return;
  const base = code.split("-")[0];
  if (!langs.includes(base)) langs.push(base);       // matching is by base language anyway
  el.code.value = "";
  save();
}

function save() {
  if (!el.auto.checked && !langs.length) langs = [...DEFAULTS.langs];
  const code = (input, fallback) => {
    const c = input.value.trim().toLowerCase().split(/[-_]/)[0];
    return /^[a-z]{2,3}$/.test(c) ? c : fallback;
  };
  el.mine.value = code(el.mine, DEFAULTS.autoMine);
  el.other.value = code(el.other, DEFAULTS.autoOther);
  browser.storage.local.set({
    autoLang: el.auto.checked, autoMine: el.mine.value, autoOther: el.other.value,
    langs, anyLang: el.any.checked,
  });
  render();
  el.saved.textContent = "Saved";
  clearTimeout(timer);
  timer = setTimeout(() => { el.saved.textContent = ""; }, 1500);
}

el.auto.addEventListener("change", save);
el.any.addEventListener("change", save);
el.mine.addEventListener("change", save);
el.other.addEventListener("change", save);
el.addBtn.addEventListener("click", addCode);
el.code.addEventListener("keydown", (e) => { if (e.key === "Enter") addCode(); });
el.reset.addEventListener("click", () => {
  el.auto.checked = DEFAULTS.autoLang;
  el.any.checked = DEFAULTS.anyLang;
  el.mine.value = DEFAULTS.autoMine;
  el.other.value = DEFAULTS.autoOther;
  langs = [...DEFAULTS.langs];
  save();
});

(async () => {
  const s = await browser.storage.local.get(DEFAULTS);
  el.auto.checked = s.autoLang;
  el.any.checked = s.anyLang;
  el.mine.value = s.autoMine;
  el.other.value = s.autoOther;
  langs = Array.isArray(s.langs) ? [...s.langs] : [...DEFAULTS.langs];
  render();
})();
