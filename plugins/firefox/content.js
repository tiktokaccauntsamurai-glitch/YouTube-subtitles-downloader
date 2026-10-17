// The network arm of the extension.
//
// Every request is made from a youtube.com page, so it is same-origin and the
// browser attaches the session on its own: the extension never reads, stores or
// exports cookies, and pages that need an account (age-restricted videos, the
// "confirm you're not a bot" check) simply work while the user is signed in.

// Through a VPN with a European exit YouTube puts a cookie-consent wall
// (consent.youtube.com) in front of every page, and fetched watch pages come
// back without the video data. SOCS=CAI is the "reject all" answer YouTube
// itself stores; set it once if the user has never answered.
(function passConsent() {
  const answered = /(?:^|;\s*)(SOCS|CONSENT)=/.test(document.cookie);
  if (!answered) {
    document.cookie = "SOCS=CAI; domain=.youtube.com; path=/; max-age=33696000; secure; samesite=lax";
  }
  if (location.hostname === "consent.youtube.com") {
    let back = "https://www.youtube.com/";
    try {
      const cont = new URL(location.href).searchParams.get("continue");
      if (cont && new URL(cont).hostname === "www.youtube.com") back = cont;
    } catch { /* keep the home page */ }
    location.replace(back);
  }
})();

// "NetworkError when attempting to fetch resource" means the request never got an
// answer - typical for a VPN that drops connections now and then, or one that only
// proxies the page's own traffic. So: retry, and also try the page's fetch
// (content.fetch runs as the page itself, exactly like YouTube's own requests).
const fetchers = [
  (url, init) => fetch(url, init),
  ...(typeof content !== "undefined" && content.fetch ? [(url, init) => content.fetch(url, init)] : []),
];

async function request(url, init) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const f of fetchers) {
      try {
        return await f(url, init);
      } catch (err) {
        lastError = err;
      }
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  const error = new Error(String(lastError && lastError.message ? lastError.message : lastError));
  error.network = true;
  throw error;
}

async function fetchText(url) {
  try {
    const res = await request(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, network: Boolean(err.network), error: String(err && err.message ? err.message : err) };
  }
}

async function postJson(url, body, options = {}) {
  try {
    const res = await request(url, {
      method: "POST",
      credentials: options.anonymous ? "omit" : "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    return { ok: false, network: Boolean(err.network), error: String(err && err.message ? err.message : err) };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== "string") return false;
  // only a www page can make same-origin requests; the consent page is about to redirect
  if (msg.type === "ping") return Promise.resolve({ ok: location.hostname === "www.youtube.com" });
  if (msg.type === "fetchText") return fetchText(msg.url);
  if (msg.type === "postJson") return postJson(msg.url, msg.body, { anonymous: msg.anonymous, headers: msg.headers });
  return false;
});
