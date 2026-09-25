// Small helpers shared by the background scripts (they all run in one scope).
var YS = globalThis.YS || (globalThis.YS = {});

YS.baseLang = function (code) {
  return String(code || "").split("-")[0].split("_")[0].toLowerCase();
};

YS.safeName = function (text, limit = 90) {
  let name = String(text || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "");
  name = name.replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
  name = name.slice(0, limit).replace(/^[\s.]+|[\s.]+$/g, "") || "video";
  // device names Windows refuses as a file or folder name (a playlist called "Con")
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `_${name}` : name;
};

YS.hhmmss = function (seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

YS.sleep = function (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// Renderer titles come either as {simpleText} or as {runs: [{text}]}.
YS.renderText = function (node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || "").join("");
  return "";
};

// Balanced-brace scan: YouTube embeds its JSON inline, so a regex can't find the end of it.
YS.extractJsonAfter = function (text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = text.indexOf("{", start + marker.length);
  if (open < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
};

// Depth-first walk over a parsed YouTube response; `visit` sees every object node.
YS.walk = function (node, visit, depth = 0) {
  if (!node || typeof node !== "object" || depth > 60) return;
  if (Array.isArray(node)) {
    for (const item of node) YS.walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const key of Object.keys(node)) YS.walk(node[key], visit, depth + 1);
};
