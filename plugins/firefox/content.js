// The network arm of the extension.
//
// Every request is made from a youtube.com page, so it is same-origin and the
// browser attaches the session on its own: the extension never reads, stores or
// exports cookies, and pages that need an account (age-restricted videos, the
// "confirm you're not a bot" check) simply work while the user is signed in.

async function fetchText(url) {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (msg.type === "ping") return Promise.resolve({ ok: true });
  if (msg.type === "fetchText") return fetchText(msg.url);
  if (msg.type === "postJson") return postJson(msg.url, msg.body);
  return false;
});
