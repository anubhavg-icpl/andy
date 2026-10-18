/**
 * websearch.ts — web search and page fetch: the tools the model uses to learn
 * something that is not in the repository.
 *
 * What this module is: a CHAIN of key-free search backends (DuckDuckGo Lite →
 * 4get → Mwmbl → RightDao, port of andy/websearch.py) plus a readable-text
 * page fetcher. Search is a chain rather than a single engine for a measured
 * reason: DDG Lite answers exactly two queries from one IP and then serves an
 * HTTP 202 anti-bot interstitial — `cc=botnet`, a form posting to
 * `anomaly.js` — in place of a results page. 202 is a 2xx, so a naive client
 * reports success, the parser finds no `result-link`, and the operator is
 * told the results page format changed. That was false, and intermittent,
 * because the first two searches of a session worked.
 *
 * Invariants:
 *  - A blocked backend must SAY so: the interstitial is detected by its own
 *    signature and reported as a rate limit, never as a format change.
 *  - One engine cannot carry search: the first backend that produces a
 *    usable answer wins; an empty answer is still an answer (that backend
 *    worked and found nothing — do not ask four services the same question).
 *  - All markup is parsed with a hand-rolled tokenizer below (stdlib only,
 *    no network-facing dependency in the hot path of every session). A shape
 *    that is not recognised raises WebError rather than reading as an empty
 *    result set — the distinction the original DDG-only code got wrong.
 *  - The backend order is overridable with `ANDY_SEARCH_BACKENDS`
 *    (comma-separated) because these are other people's free services, and
 *    which one is down this month is not something this code can predict.
 */

// === SECTION === transport ===

/** One search hit. */
export class Result {
  title: string;
  url: string;
  snippet: string;

  constructor(title: string, url: string, snippet = '') {
    this.title = title;
    this.url = url;
    this.snippet = snippet;
  }
}

/** A search or fetch that could not be completed. */
export class WebError extends Error {}

/**
 * The ValueError stand-in the pure parsers throw for unrecognised shapes.
 * Python's json/value errors surface to the caller as WebError with the
 * message attached; keep the class distinct so the wrap sites can tell a
 * parse failure from a transport failure.
 */
class ValueError extends Error {}

// DDG Lite answers a bare default-agent request with an empty page, so
// present as a browser.
const USER_AGENT =
  'Moandy/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** The key-free endpoints, tried in whatever order backendOrder returns. */
const DDG_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const FOURGET_ENDPOINT = 'https://4get.zzls.xyz/api/v1/web?s=';
const MWMBL_ENDPOINT = 'https://mwmbl.org/api/v1/search/?s=';
const RIGHTDAO_ENDPOINT = 'https://rightdao.com/search?q=';

/** What DDG's anti-bot interstitial actually served: a 202, a `cc=botnet`
 *  query parameter, and a form posting to `anomaly.js`. The status and the
 *  markers are both checked — the status alone is a convention that could
 *  move, and the markers alone would miss a page whose body had been
 *  rewritten. */
const DDG_CHALLENGE_MARKERS = [
  'cc=botnet',
  'anomaly.js',
  'challenge-form',
  'anomaly-modal',
];

const FETCH_LIMIT_BYTES = 2_000_000; // a page larger than this is not a document

interface Fetched {
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
}

/** The netloc of a URL for error messages (host[:port], no credentials). */
function netlocOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Read a response body up to *cap* bytes, then stop pulling the stream. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.byteLength;
      if (size >= cap) {
        // A page larger than the cap is not a document; stop reading rather
        // than buffering it whole only to slice it.
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const joined = Buffer.concat(chunks);
  return joined.subarray(0, cap);
}

/**
 * GET or POST *url*, returning {status, finalUrl, contentType, text}.
 *
 * The status is returned rather than assumed to be 200 — every non-throwing
 * status, including the 202 DDG serves in place of a results page when
 * rate-limiting, arrives here looking like a success. Handing the caller the
 * number is what lets it tell a challenge page from a results page that
 * happened to parse to nothing.
 *
 * (Port note: Python decompressed gzip/deflate by hand after asking for
 * identity; fetch/undici negotiates and decompresses transparently, so the
 * manual step has no TS counterpart. The byte cap is kept.)
 */
async function request(
  url: string,
  opts: { data?: string; timeout?: number } = {},
): Promise<Fetched> {
  const timeout = opts.timeout ?? 15.0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    // globalThis.fetch, NOT this module's own fetch() export — the export
    // shadows the platform global for the whole module scope.
    const res = await globalThis.fetch(url, {
      method: opts.data !== undefined ? 'POST' : 'GET',
      body: opts.data,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...(opts.data !== undefined
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const raw = await readCapped(res, FETCH_LIMIT_BYTES);
    // Python's urlopen RAISES on 4xx/5xx (HTTPError → WebError "HTTP N from
    // host"); fetch resolves them like any other status, so raise here or a
    // 404 page would flow into the parsers as if it were an answer.
    if (!res.ok) {
      throw new WebError(`HTTP ${res.status} from ${netlocOf(url)}`);
    }
    const ctypeHeader = res.headers.get('content-type') ?? '';
    // Python's get_content_type(): the mime token, lowercased, no params —
    // and the whole header is absent, text/html is the assumption.
    const contentType = (ctypeHeader.split(';')[0] ?? '').trim().toLowerCase() || 'text/html';
    const charsetMatch = /charset=("?)([^\s;"]*)\1/i.exec(ctypeHeader);
    // Buffer.toString only takes a fixed encoding set; map the common HTTP
    // charset labels onto it and fall back to utf-8 for anything else
    // (Python's decode(errors="replace") accepted any label, but the pages
    // this fetches are utf-8 or single-byte — latin1 preserves their bytes).
    const label = (charsetMatch?.[2] ?? 'utf-8').trim().toLowerCase();
    const encoding: BufferEncoding =
      label === 'utf-8' || label === 'utf8'
        ? 'utf8'
        : label === 'iso-8859-1' || label === 'latin1' || label === 'windows-1252'
          ? 'latin1'
          : label === 'utf-16le' || label === 'utf16le'
            ? 'utf16le'
            : label === 'ascii' || label === 'us-ascii'
              ? 'ascii'
              : 'utf8';
    const text = raw.toString(encoding);
    return { status: res.status, finalUrl: res.url || url, contentType, text };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new WebError(`request failed: timed out after ${timeout}s`);
    }
    // fetch only rejects on network-level failure; HTTP 4xx/5xx are statuses
    // (raised as WebError by the callers that treat them as errors, exactly
    // like urllib's HTTPError did).
    throw new WebError(`could not reach ${netlocOf(url)}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Collapsed whitespace (Python `" ".join(s.split())`). */
function collapseWs(s: string): string {
  return s.split(/\s+/).filter((p) => p.length > 0).join(' ');
}

// === SECTION === minimal HTML tokenizer ===

/*
 * Python parsed with html.parser.HTMLParser; Node has no stdlib equivalent
 * and PORT-MAP left the choice to the porter ("hand-rolled regex walkers or
 * node-html-parser"). These pages are simple, generated markup, so a small
 * scanner is chosen over a new dependency — no network-facing package enters
 * the hot path of every session (the same reasoning the Python module states
 * for using only the standard library).
 *
 * Fidelity notes, matching HTMLParser's observable behavior:
 *  - Void elements (<br>, <img>, ...) emit a start event and no end event.
 *  - A self-closed tag (<a/>) emits start THEN end (HTMLParser's default
 *    handle_startendtag does exactly that).
 *  - Entity references in text and attribute values are decoded
 *    (convert_charrefs=True), for the common named set plus numeric forms.
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// NOTE: the three members each carry a SINGLE literal kind. A member typed
// `kind: 'start' | 'end'` defeats discriminant narrowing under this
// compiler, which would force casts at every read site.
type HtmlEvent =
  | { kind: 'start'; tag: string; attrs: Map<string, string> }
  | { kind: 'end'; tag: string; attrs: Map<string, string> }
  | { kind: 'text'; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttrs(body: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    if (!attrs.has(name)) attrs.set(name, value !== undefined ? decodeEntities(value) : '');
  }
  return attrs;
}

/** Scan *html* into start/end/text events in document order. */
function* tokenizeHtml(html: string): Generator<HtmlEvent> {
  let pos = 0;
  const emitText = function* (chunk: string): Generator<HtmlEvent> {
    if (chunk.length > 0) yield { kind: 'text', text: decodeEntities(chunk) };
  };
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      yield* emitText(html.slice(pos));
      return;
    }
    if (lt > pos) yield* emitText(html.slice(pos, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      const chunk = html.slice(lt + 9, end === -1 ? html.length : end);
      yield* emitText(chunk);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      // doctype / processing instruction: skipped entirely
      const end = html.indexOf('>', lt);
      pos = end === -1 ? html.length : end + 1;
      continue;
    }
    // Find the closing '>' honoring quoted attribute values.
    let j = lt + 1;
    let quote = '';
    while (j < html.length) {
      const c = html[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= html.length) return; // unterminated tag: stop, as HTMLParser does
    const inner = html.slice(lt + 1, j);
    pos = j + 1;
    const closing = inner.startsWith('/');
    let body = closing ? inner.slice(1) : inner;
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(body);
    if (nameMatch === null) continue; // not a tag; treat as noise
    const tag = nameMatch[0].toLowerCase();
    const attrs = closing ? new Map<string, string>() : parseAttrs(body.slice(nameMatch[0].length));
    if (closing) {
      yield { kind: 'end', tag, attrs };
    } else {
      yield { kind: 'start', tag, attrs };
      if (selfClosing && !VOID_TAGS.has(tag)) {
        yield { kind: 'end', tag, attrs };
      }
    }
  }
}

// === SECTION === DDG Lite parsing ===

/** Pull `result-link` anchors and `result-snippet` cells, in order. */
class DdgResultParser {
  links: [string, string][] = []; // [url, title]
  snippets: string[] = [];
  private link: [string, string] | null = null;
  private snippet: string[] | null = null;

  feed(html: string): void {
    try {
      for (const ev of tokenizeHtml(html)) {
        if (ev.kind === 'start') {
          const classes = new Set((ev.attrs.get('class') ?? '').split(/\s+/));
          if (ev.tag === 'a' && classes.has('result-link')) {
            this.link = [ev.attrs.get('href') ?? '', ''];
          } else if (ev.tag === 'td' && classes.has('result-snippet')) {
            this.snippet = [];
          }
        } else if (ev.kind === 'end') {
          if (ev.tag === 'a' && this.link !== null) {
            this.links.push([this.link[0], collapseWs(this.link[1])]);
            this.link = null;
          } else if (ev.tag === 'td' && this.snippet !== null) {
            this.snippets.push(collapseWs(this.snippet.join('')));
            this.snippet = null;
          }
        } else if (ev.kind === 'text') {
          if (this.link !== null) this.link[1] += ev.text;
          if (this.snippet !== null) this.snippet.push(ev.text);
        }
      }
    } catch {
      // malformed HTML must not sink the search
    }
  }
}

/** DDG sometimes wraps hits in a `/l/?uddg=` redirect — show the target. */
function unwrapDdgUrl(url: string): string {
  // urlsplit parses relative URLs without complaint; new URL does not, so
  // split path/query by hand when the strict parser refuses.
  let pathName: string;
  let query: string;
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    pathName = u.pathname;
    query = u.search.startsWith('?') ? u.search.slice(1) : u.search;
  } catch {
    const q = url.indexOf('?');
    pathName = q === -1 ? url : url.slice(0, q);
    query = q === -1 ? '' : url.slice(q + 1);
  }
  if (pathName.startsWith('/l/') || query.includes('uddg=')) {
    const target = new URLSearchParams(query).get('uddg');
    if (target) return target;
  }
  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

/** Extract hits from a DDG Lite results page. Order-preserving. */
export function parseResults(html: string): Result[] {
  const parser = new DdgResultParser();
  parser.feed(html);

  const results: Result[] = [];
  parser.links.forEach(([rawUrl, title], i) => {
    const snippet = i < parser.snippets.length ? parser.snippets[i]! : '';
    const url = unwrapDdgUrl(rawUrl);
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    if (!title) return;
    results.push(new Result(title, url, snippet));
  });
  return results;
}

/** Is this DDG's anti-bot interstitial rather than a results page?
 *
 *  Measured: after two queries from one IP, DDG Lite answers 202 with a page
 *  whose form posts to `anomaly.js` and whose query string carries
 *  `cc=botnet`. 202 is a 2xx, so nothing raised; the parser found no
 *  `result-link` and the old code blamed the page format. Checking the
 *  signature here is what turns that into a true statement about a rate
 *  limit. */
export function ddgIsChallenged(status: number, text: string): boolean {
  if (status === 202) return true;
  if (status !== 200) return false;
  const lowered = text.toLowerCase();
  return DDG_CHALLENGE_MARKERS.some((m) => lowered.includes(m));
}

// === SECTION === 4get (JSON) ===

// {"status": "ok", "web": [{"title", "description", "url", ...}, ...]}
// A non-"ok" status is the instance saying so — reported, not parsed around.

/** Extract hits from a 4get `/api/v1/web` JSON response. */
export function parse4get(payload: string): Result[] {
  const data = JSON.parse(payload);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ValueError('4get: expected a JSON object');
  }
  const status = String((data as Record<string, unknown>)['status'] ?? '').toLowerCase();
  if (status !== 'ok') {
    throw new ValueError(`4get: instance returned status ${status ? `'${status}'` : "'<missing>'"}`);
  }
  const hits = (data as Record<string, unknown>)['web'];
  if (!Array.isArray(hits)) throw new ValueError("4get: no 'web' list in the response");

  const results: Result[] = [];
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue;
    const rec = hit as Record<string, unknown>;
    const url = String(rec['url'] ?? '').trim();
    const title = String(rec['title'] ?? '').trim();
    if (!(url.startsWith('http://') || url.startsWith('https://')) || !title) continue;
    results.push(
      new Result(collapseWs(title), url, collapseWs(String(rec['description'] ?? ''))),
    );
  }
  return results;
}

// === SECTION === Mwmbl (JSON list) ===

// A bare JSON LIST at the root. `title` and `extract` are run-lists of
// {"value", "is_bold"} — not strings — so they are joined rather than used
// directly. Reading them as strings is the one way to get this wrong quietly.

/** Join Mwmbl's rich-text runs into plain text. */
function mwmblRuns(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .filter((run): run is Record<string, unknown> => typeof run === 'object' && run !== null)
      .map((run) => String(run['value'] ?? ''));
    return collapseWs(parts.join(''));
  }
  return '';
}

/** Extract hits from an Mwmbl `/api/v1/search` JSON response. */
export function parseMwmbl(payload: string): Result[] {
  const data = JSON.parse(payload);
  if (!Array.isArray(data)) throw new ValueError('mwmbl: expected a JSON list at the root');

  const results: Result[] = [];
  for (const hit of data) {
    if (typeof hit !== 'object' || hit === null) continue;
    const rec = hit as Record<string, unknown>;
    const url = String(rec['url'] ?? '').trim();
    const title = mwmblRuns(rec['title']);
    if (!(url.startsWith('http://') || url.startsWith('https://')) || !title) continue;
    results.push(new Result(title, url, mwmblRuns(rec['extract'])));
  }
  return results;
}

// === SECTION === RightDao (HTML) ===

// Each hit is a `<div class="title">` holding the anchor, followed by a
// `<div class="description">` holding the snippet — so the two are paired by
// order, exactly as DDG's link/snippet cells are.

/** Pull RightDao's `div.title` anchors and `div.description` text. */
class RightDaoParser {
  links: [string, string][] = [];
  snippets: string[] = [];
  private depth = 0; // nesting inside a tracked div
  private want = ''; // 'title' | 'description' | ''
  private href = '';
  private buf: string[] = [];
  private inAnchor = false;

  feed(html: string): void {
    try {
      for (const ev of tokenizeHtml(html)) {
        if (ev.kind === 'start') {
          if (this.want) {
            this.depth += 1;
            if (ev.tag === 'a' && this.want === 'title' && !this.href) {
              this.href = ev.attrs.get('href') ?? '';
              this.inAnchor = true;
            }
          } else {
            const classes = new Set((ev.attrs.get('class') ?? '').split(/\s+/));
            if (ev.tag === 'div' && (classes.has('title') || classes.has('description'))) {
              this.want = classes.has('title') ? 'title' : 'description';
              this.depth = 1;
              this.href = '';
              this.buf = [];
              this.inAnchor = false;
            }
          }
        } else if (ev.kind === 'end') {
          if (!this.want) continue;
          if (ev.tag === 'a') this.inAnchor = false;
          this.depth -= 1;
          if (this.depth > 0) continue;
          const text = collapseWs(this.buf.join(''));
          if (this.want === 'title') this.links.push([this.href, text]);
          else this.snippets.push(text);
          this.want = '';
          this.buf = [];
          this.href = '';
        } else {
          if (this.want === 'description') this.buf.push(ev.text);
          else if (this.want === 'title' && this.inAnchor) this.buf.push(ev.text);
        }
      }
    } catch {
      // see parseResults
    }
  }
}

/** Extract hits from a RightDao results page. Order-preserving. */
export function parseRightdao(html: string): Result[] {
  const parser = new RightDaoParser();
  parser.feed(html);

  const results: Result[] = [];
  parser.links.forEach(([url, title], i) => {
    const snippet = i < parser.snippets.length ? parser.snippets[i]! : '';
    if (!(url.startsWith('http://') || url.startsWith('https://')) || !title) return;
    results.push(new Result(title, url, snippet));
  });
  return results;
}

// === SECTION === the backend chain ===

/** urllib.parse.quote_plus: application/x-www-form-urlencoded space encoding. */
function quotePlus(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/** DuckDuckGo Lite, over POST. */
async function searchDdg(query: string, timeout: number): Promise<Result[]> {
  const body = new URLSearchParams({ q: query }).toString();
  const { status, contentType, text } = await request(DDG_ENDPOINT, { data: body, timeout });

  if (ddgIsChallenged(status, text)) {
    throw new WebError(
      `duckduckgo is rate-limiting this IP (HTTP ${status} anti-bot page) — trying another backend`,
    );
  }
  const results = parseResults(text);
  if (results.length === 0 && contentType.includes('text/html') && !text.includes('result-link')) {
    throw new WebError(
      'duckduckgo returned no parsable results — the results page format may have changed',
    );
  }
  return results;
}

/** 4get, a key-free metasearch API returning JSON. */
async function search4get(query: string, timeout: number): Promise<Result[]> {
  const url = FOURGET_ENDPOINT + quotePlus(query);
  const { text } = await request(url, { timeout });
  try {
    return parse4get(text);
  } catch (e) {
    throw new WebError(`4get returned an unrecognised response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Mwmbl, a key-free community index returning JSON. */
async function searchMwmbl(query: string, timeout: number): Promise<Result[]> {
  const url = MWMBL_ENDPOINT + quotePlus(query);
  const { text } = await request(url, { timeout });
  try {
    return parseMwmbl(text);
  } catch (e) {
    throw new WebError(`mwmbl returned an unrecognised response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** RightDao, key-free HTML results. Its parameter is `q`, not `query`. */
async function searchRightdao(query: string, timeout: number): Promise<Result[]> {
  const url = RIGHTDAO_ENDPOINT + quotePlus(query);
  const { text } = await request(url, { timeout });
  const results = parseRightdao(text);
  if (results.length === 0 && !text.includes('description')) {
    throw new WebError(
      'rightdao returned no parsable results — the results page format may have changed',
    );
  }
  return results;
}

/** name -> the callable that queries it. Each throws WebError on its own
 *  failure so the chain can move on without knowing which kind it was. */
const BACKENDS: Record<string, (query: string, timeout: number) => Promise<Result[]>> = {
  duckduckgo: searchDdg,
  '4get': search4get,
  mwmbl: searchMwmbl,
  rightdao: searchRightdao,
};

/** The order tried when nothing overrides it. DDG leads because its results
 *  are the best of the four when it answers — the point of the chain is that
 *  a refusal there is no longer the end of the search. */
const DEFAULT_BACKEND_ORDER = ['duckduckgo', '4get', 'mwmbl', 'rightdao'];

/**
 * The backends to try, in order.
 *
 * `ANDY_SEARCH_BACKENDS=4get,mwmbl` pins the order, because these are other
 * people's free services and which one is refusing traffic this month is not
 * something this code can know. Unknown names are ignored rather than fatal:
 * a typo should not leave the operator with no search at all.
 */
function backendOrder(): string[] {
  const raw = (process.env['ANDY_SEARCH_BACKENDS'] ?? '').trim();
  if (!raw) return [...DEFAULT_BACKEND_ORDER];
  const named = raw.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p.length > 0);
  const ordered = named.filter((n) => n in BACKENDS);
  return ordered.length > 0 ? ordered : [...DEFAULT_BACKEND_ORDER];
}

/**
 * Search the web across the backend chain.
 *
 * Returns `[results, backendName]` for the first backend that produced a
 * usable answer — the name so the caller can say which engine answered,
 * since they are not interchangeable and the operator may want to pin one.
 *
 * An empty list with a backend name means that backend genuinely had no hits.
 * Every backend failing throws WebError naming each one and why, so a total
 * failure is diagnosable rather than a shrug.
 */
export async function search(
  query: string,
  maxResults = 5,
  timeout = 15.0,
): Promise<[Result[], string]> {
  const q = (query ?? '').trim();
  if (!q) throw new WebError('empty query');

  const order = backendOrder();
  const failures: string[] = [];
  for (const name of order) {
    let results: Result[];
    try {
      results = await BACKENDS[name]!(q, timeout);
    } catch (e) {
      if (e instanceof WebError) {
        failures.push(`${name}: ${e.message}`);
        continue;
      }
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // An empty answer is still an answer: this backend worked and found
    // nothing. Falling through would ask four services the same question
    // to be told "nothing" four times.
    return [results.slice(0, Math.max(1, maxResults)), name];
  }

  throw new WebError(`every search backend failed — ${failures.join('; ')}`);
}

// === SECTION === readable text ===

const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'head', 'template', 'iframe',
  'nav', 'aside', 'footer', 'form', 'button', 'select',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'header', 'blockquote', 'pre', 'table',
]);
const REGION_TAGS = new Set(['main', 'article']);

/**
 * Turn a document into readable text: drop chrome, keep the prose.
 *
 * With region='main' only the inside of `<main>`/`<article>` is captured —
 * documentation and article pages put their prose there and their navigation
 * outside it, which is the difference between reading a page and reading its
 * menu. Pages without either element yield nothing in that mode, so the
 * caller falls back to the whole document.
 */
class TextExtractor {
  private region: 'main' | null;
  private out: string[] = [];
  private dropDepth = 0;
  private regionDepth = 0;

  constructor(region: 'main' | null = null) {
    this.region = region;
  }

  private capturing(): boolean {
    if (this.dropDepth) return false;
    return this.region !== 'main' || this.regionDepth > 0;
  }

  feed(html: string): void {
    try {
      for (const ev of tokenizeHtml(html)) {
        if (ev.kind === 'start') {
          const tag = ev.tag;
          if (DROP_TAGS.has(tag)) {
            this.dropDepth += 1;
          } else if (this.region === 'main' && REGION_TAGS.has(tag)) {
            this.regionDepth += 1;
            if (this.regionDepth === 1) this.out.push('\n');
          } else if (this.capturing() && BLOCK_TAGS.has(tag)) {
            this.out.push('\n');
          }
        } else if (ev.kind === 'end') {
          const tag = ev.tag;
          if (DROP_TAGS.has(tag)) {
            if (this.dropDepth) this.dropDepth -= 1;
          } else if (this.region === 'main' && REGION_TAGS.has(tag)) {
            if (this.regionDepth) this.regionDepth -= 1;
            if (this.regionDepth === 0) this.out.push('\n');
          } else if (this.capturing() && BLOCK_TAGS.has(tag)) {
            this.out.push('\n');
          }
        } else {
          if (this.capturing()) this.out.push(ev.text);
        }
      }
    } catch {
      // see parseResults
    }
  }

  text(): string {
    let joined = this.out.join('');
    joined = joined.replace(/[ \t\r\f\v]+/g, ' ');
    joined = joined.replace(/\n\s*\n\s*\n+/g, '\n\n');
    return joined.trim();
  }
}

function extract(html: string, region: 'main' | null): string {
  const extractor = new TextExtractor(region);
  extractor.feed(html);
  return extractor.text();
}

// Below this, a "main region" is not a document — it is a stub or a
// mis-detect, and the whole page is the better answer.
const MAIN_MIN_CHARS = 200;

/** Readable text from an HTML document, without a parser dependency. */
export function htmlToText(html: string): string {
  const main = extract(html, 'main');
  if (main.length >= MAIN_MIN_CHARS) return main;
  return extract(html, null);
}

/**
 * Fetch *url* as text. Returns [finalUrl, text]. Throws WebError.
 *
 * Scope: fetching an arbitrary URL is reaching a host, so the CALLER
 * (tools.ts web_fetch) checks the session's scope guard and refuses
 * out-of-scope targets; searching is egress to a fixed engine rather than a
 * chosen target, so it is allowed whenever the session authorises any
 * network at all.
 */
export async function fetch(
  url: string,
  maxChars = 20_000,
  timeout = 20.0,
): Promise<[string, string]> {
  let u = (url ?? '').trim();
  if (!u) throw new WebError('empty url');
  if (!(u.startsWith('http://') || u.startsWith('https://'))) u = 'https://' + u;

  const { finalUrl, contentType, text } = await request(u, { timeout });

  let out: string;
  if (contentType.includes('html') || contentType.includes('xml')) {
    out = htmlToText(text);
  } else if (contentType.startsWith('text/') || contentType.includes('json')) {
    out = text;
  } else {
    throw new WebError(`${contentType} is not readable text (only text and HTML pages)`);
  }

  if (!out.trim()) throw new WebError(`${finalUrl} returned no readable text`);

  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n... [truncated at ${maxChars} chars]`;
  }
  return [finalUrl, out];
}
