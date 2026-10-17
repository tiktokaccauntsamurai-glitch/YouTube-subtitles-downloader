// Subtitle parsers: one cue is [startSeconds, text].
var YS = globalThis.YS || (globalThis.YS = {});

const TAG = /<[^>]+>/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// One pass, so "&amp;lt;" stays "&lt;" instead of turning into "<".
function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] || whole;
  });
}

function toSeconds(value) {
  const parts = String(value).replace(",", ".").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseJson3(raw) {
  const data = JSON.parse(raw);
  const cues = [];
  for (const ev of data.events || []) {
    if (ev.aAppend) continue;           // internal "appends" to the rolling caption line
    const text = (ev.segs || [])
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push([(ev.tStartMs || 0) / 1000, text]);
  }
  return cues;
}

function parseVtt(raw) {
  const cues = [];
  let start = null;
  let buf = [];

  const flush = () => {
    if (start === null) return;
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    if (text && (!cues.length || cues[cues.length - 1][1] !== text)) cues.push([start, text]);
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.includes("-->")) {
      flush();
      start = toSeconds(line.split("-->")[0].trim().split(/\s+/)[0]);
      buf = [];
    } else if (!line) {
      flush();
      start = null;
      buf = [];
    } else if (start !== null && !/^(WEBVTT|NOTE|Kind:|Language:)/.test(line)) {
      buf.push(decodeEntities(line.replace(TAG, "")));
    }
  }
  flush();

  // Rolling auto-captions repeat the tail of the previous cue or grow it; only
  // those shapes are merged, so a short reply ("Yes") after "Yes, I agree." survives.
  const result = [];
  for (const [time, text] of cues) {
    const last = result[result.length - 1];
    if (last && last[1].endsWith(text)) continue;
    if (last && text.startsWith(last[1])) {
      last[1] = text;
      continue;
    }
    result.push([time, text]);
  }
  return result;
}

function parseXml(raw) {
  const cues = [];
  const re = /<(?:text|p)[^>]*?\b(start|begin|t)="([^"]+)"[^>]*>(.*?)<\/(?:text|p)>/gs;
  for (const m of raw.matchAll(re)) {
    const [, attr, value, body] = m;
    let secs;
    if (value.includes(":")) {          // 00:01:05.500 (ttml)
      secs = toSeconds(value);
    } else {                            // t="1500" is milliseconds (srv3), start="4"/"4s" is seconds
      const number = Number(value.replace(/[^\d.]/g, "")) || 0;
      secs = attr === "t" ? number / 1000 : number;
    }
    const text = decodeEntities(body.replace(TAG, " ")).replace(/\s+/g, " ").trim();
    if (text) cues.push([secs, text]);
  }
  return cues;
}

YS.parseSubtitles = function (raw, ext) {
  if (!raw || !raw.trim()) return [];
  try {
    if (ext === "json3") return parseJson3(raw);
    if (ext === "vtt" || ext === "srt") return parseVtt(raw);
    return parseXml(raw);
  } catch {
    return [];
  }
};
