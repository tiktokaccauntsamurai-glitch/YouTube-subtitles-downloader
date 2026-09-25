// Cues -> readable Markdown (same layout as the yt_subs.py output).
var YS = globalThis.YS || (globalThis.YS = {});

YS.paragraphs = function (cues, soft = 480, hard = 900, gap = 4.0) {
  const out = [];
  let buf = [];
  let start = null;
  let prev = null;

  for (const [time, text] of cues) {
    if (start === null) start = time;
    const length = buf.reduce((sum, x) => sum + x.length + 1, 0);
    const bigGap = prev !== null && time - prev > gap && length > 200;
    const endsSentence = buf.length > 0 && '.!?…»"\''.includes(buf[buf.length - 1].slice(-1));
    if (buf.length && (length >= hard || (length >= soft && endsSentence) || bigGap)) {
      out.push([start, buf.join(" ")]);
      buf = [];
      start = time;
    }
    buf.push(text);
    prev = time;
  }
  if (buf.length) out.push([start, buf.join(" ")]);
  return out;
};

YS.buildMarkdown = function (info, cues, native, lang, label, timestamps = true) {
  const stamp = new Date();
  const local = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-` +
    `${String(stamp.getDate()).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:` +
    `${String(stamp.getMinutes()).padStart(2, "0")}`;

  const lines = [
    `# ${info.title || info.id}`,
    "",
    `- **Link:** https://www.youtube.com/watch?v=${info.id}`,
    `- **Channel:** ${info.uploader || "—"}`,
    `- **Published:** ${info.uploadDate || "—"}`,
    `- **Duration:** ${YS.hhmmss(info.duration || 0)}`,
    `- **Video language:** ${native}`,
    `- **Subtitles:** ${lang} (${label})`,
    `- **Downloaded:** ${local}`,
    "",
    "---",
    "",
  ];
  for (const [start, text] of YS.paragraphs(cues)) {
    lines.push(timestamps ? `**[${YS.hhmmss(start)}]** ${text}` : text);
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
};
