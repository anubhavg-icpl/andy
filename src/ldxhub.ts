/**
 * ldxhub.ts — LDXHub document-processing job gateway (port of zimzilla/ldxhub.py).
 *
 * What this module is: the HTTP client for the six document-job services on
 * https://gw.ldxhub.io (docs at gw.portal.ldxhub.io), plus the mode-600 key
 * profile under `$ANDY_HOME/ldxhub/source`.
 *
 * Invariants (all measured against the live gateway — see the Python original):
 *  - LDXHub is NOT a chat source: `/v1/messages` and `/v1/chat/completions`
 *    both 404, so this module is deliberately NOT wired into sources.ts and
 *    exposes no applyTo / activeEndpoint / isLdxhub predicate.
 *  - Catalogs are public and unauthenticated, so a missing key is a
 *    first-class case: an empty token omits the Authorization header entirely
 *    (a literal empty bearer is a *different* request) — see buildHeaders.
 *  - Credential helpers are synchronous (node:fs, mirroring Python) and never
 *    echo the token. Python's import-time `PROFILE` constant is `profilePath()`
 *    here so `$ANDY_HOME` set after import (tests) is still honoured.
 *  - Error channels are tuples `[result, error]`, never thrown, matching the
 *    Python `(value, error)` contract tools.ts relies on.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { andyHome } from './shared.js';

// === SECTION === constants ===

export const HOST = 'gw.ldxhub.io';
export const BASE_URL = `https://${HOST}`;

/** Where the mode-600 key profile lives: `$ANDY_HOME/ldxhub/source`. */
export function profilePath(): string {
  return path.join(andyHome(), 'ldxhub', 'source');
}

export const CACHE_TTL = 300.0;
export const JOB_TIMEOUT = 300.0;
export const POLL_INTERVAL = 2.0;

/**
 * service → catalog kind. The path segment is the same either way;
 * only `models` vs `engines` distinguishes them, and the wrong
 * kind returns 404 problem+json.
 */
export const SERVICES: Record<string, string> = {
  structflow: 'models',
  analyzedoc: 'models',
  refineloop: 'models',
  renderocr: 'engines',
  castdoc: 'engines',
  extractdoc: 'engines',
};

/** service → profile env var holding the per-service default pick. */
export const DEFAULT_VAR: Record<string, string> = {
  structflow: 'LDXHUB_STRUCTFLOW_MODEL',
  analyzedoc: 'LDXHUB_ANALYZEDOC_MODEL',
  refineloop: 'LDXHUB_REFINELOOP_MODEL',
  renderocr: 'LDXHUB_RENDEROCR_ENGINE',
  castdoc: 'LDXHUB_CASTDOC_ENGINE',
  extractdoc: 'LDXHUB_EXTRACTDOC_ENGINE',
};

/** Monotonic clock in seconds — replaces Python's `time.monotonic()`. */
function monotonic(): number {
  return performance.now() / 1000;
}

// === SECTION === catalog entries ===

/** One model or engine from a service's live catalog. */
export class Entry {
  constructor(
    public readonly id: string,
    public readonly label: string,
    public readonly provider: string = '',
    public readonly blurb: string = '',
    public readonly conversions: ReadonlyArray<readonly [string, string]> = [],
    public readonly languages: ReadonlyArray<readonly [string, string]> = [],
  ) {}

  get summary(): string {
    const bits: string[] = [this.id];
    if (this.provider && !this.id.includes(this.provider)) {
      bits.push(`(${this.provider})`);
    }
    if (this.label && this.label !== this.id) {
      bits.push(`— ${this.label}`);
    }
    if (this.conversions.length > 0) {
      const pairs = this.conversions
        .slice(0, 4)
        .map(([a, b]) => `${a}→${b}`)
        .join(', ');
      const more = this.conversions.length - 4;
      bits.push(`[${pairs}${more > 0 ? ' …' : ''}]`);
    }
    if (this.languages.length > 0) {
      bits.push(`[${this.languages.length} languages]`);
    }
    return bits.join(' ');
  }
}

// === SECTION === profile (mode 600; never echoed) ===

/**
 * Parse `export VAR="value"` lines without a shell.
 *
 * Why hand-rolled: the profile must never round-trip through a shell — a key
 * file is data, and sourcing it would execute it.
 */
function readExports(filePath: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('export ')) continue;
    const body = line.slice('export '.length);
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    if (name) out[name] = value;
  }
  return out;
}

export type CredentialOrigin = 'env' | 'profile';

/**
 * `(token, {service: default_id}, origin)` or null.
 *
 * `LDXHUB_API_KEY` in the environment wins, then the profile. Origin is where
 * the token came from — `env` or `profile` — so callers can say where a key is
 * missing from. The token itself is never logged or returned anywhere but here.
 */
export type Credentials = [
  token: string,
  defaults: Record<string, string>,
  origin: CredentialOrigin,
];

export function loadCredentials(): Credentials | null {
  const envToken = (process.env['LDXHUB_API_KEY'] ?? '').trim();
  if (envToken) {
    const defaults: Record<string, string> = {};
    for (const [svc, varName] of Object.entries(DEFAULT_VAR)) {
      const v = (process.env[varName] ?? '').trim();
      if (v) defaults[svc] = v;
    }
    return [envToken, defaults, 'env'];
  }
  const raw = readExports(profilePath());
  const token = (raw['LDXHUB_API_KEY'] ?? '').trim();
  if (!token) return null;
  const defaults: Record<string, string> = {};
  for (const [svc, varName] of Object.entries(DEFAULT_VAR)) {
    const v = (raw[varName] ?? '').trim();
    if (v) defaults[svc] = v;
  }
  return [token, defaults, 'profile'];
}

/**
 * Write the key (and any default picks) to the mode-600 profile.
 * Returns the profile path (Python returned a Path).
 *
 * Existing `DEFAULT_VAR` lines are merged in, so replacing the key never
 * silently drops a chosen engine — `/ldxhub-models` can set defaults without
 * re-supplying the key.
 */
export function saveKey(token: string, defaults?: Record<string, string>): string {
  const profile = profilePath();
  const existing = readExports(profile);
  const merged: Record<string, string> = {};
  for (const [svc, varName] of Object.entries(DEFAULT_VAR)) {
    let val = '';
    const supplied = defaults?.[svc];
    if (supplied) {
      val = supplied;
    } else {
      const prior = (existing[varName] ?? '').trim();
      if (prior) val = prior;
    }
    if (val) merged[varName] = val;
  }

  const lines = [`export LDXHUB_API_KEY="${token}"`];
  for (const [, varName] of Object.entries(DEFAULT_VAR)) {
    if (merged[varName]) lines.push(`export ${varName}="${merged[varName]}"`);
  }
  const body = lines.join('\n') + '\n';

  fs.mkdirSync(path.dirname(profile), { recursive: true });
  try {
    fs.chmodSync(path.dirname(profile), 0o700);
  } catch {
    // best-effort, as in Python: a chmod failure must not lose the key
  }
  // O_WRONLY|O_CREAT|O_TRUNC with 0o600 — the mode applies at creation only,
  // same semantics as Python's os.open flags here.
  const fd = fs.openSync(profile, 'w', 0o600);
  try {
    fs.writeSync(fd, Buffer.from(body, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
  return profile;
}

/**
 * Pin the default model/engine for one service. Needs a key.
 * Returns the profile path, or null when no credential exists.
 */
export function saveDefault(service: string, entryId: string): string | null {
  const creds = loadCredentials();
  if (!creds) return null;
  const [token, defaults] = creds;
  const merged: Record<string, string> = { ...defaults, [service]: entryId };
  return saveKey(token, merged);
}

export function hasKey(): boolean {
  return loadCredentials() !== null;
}

/** `zpka_…` and friends — underscore included, unlike openrouter's. */
export function looksLikeKey(value: string): boolean {
  const v = (value ?? '').trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  return /^[A-Za-z0-9._-]+$/.test(v);
}

// === SECTION === HTTP ===

/**
 * Bearer auth, omitted entirely when there is no token.
 *
 * The six catalogs are public and answer fine with no Authorization header at
 * all, so an empty token must mean *absent*, not `Bearer ` — a literal empty
 * bearer is a different request.
 */
function buildHeaders(token: string, jsonBody = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (jsonBody) h['Content-Type'] = 'application/json';
  return h;
}

function mapHttpError(status: number, bodyText: string): string {
  if (status === 401 || status === 403) {
    return `key rejected (${status}) — check it with /ldxhub-api-setup`;
  }
  let detail = '';
  try {
    const payload = JSON.parse(bodyText || '') as Record<string, unknown>;
    detail = String(payload?.['detail'] || payload?.['title'] || '');
  } catch {
    // not problem+json — fall through to the bare status
  }
  return detail || `HTTP ${status}`;
}

/**
 * `(obj, error)` — never rejects. `obj` is null on error.
 * The whole-module error contract: callers destructure, nothing throws.
 */
async function jsonRequest(
  method: string,
  url: string,
  token: string,
  opts: { payload?: Record<string, unknown>; timeout?: number } = {},
): Promise<[unknown, string]> {
  const { payload, timeout = 20.0 } = opts;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: payload !== undefined ? buildHeaders(token, true) : buildHeaders(token),
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    // network failure / DNS / timeout — the Python analogue of
    // `could not reach {HOST}: {e}` from URLError/OSError
    return [null, `could not reach ${HOST}: ${String(e)}`];
  }
  if (!resp.ok) {
    return [null, mapHttpError(resp.status, await resp.text().catch(() => ''))];
  }
  const text = await resp.text();
  try {
    return [JSON.parse(text), ''];
  } catch {
    return [null, 'response was not JSON'];
  }
}

// === SECTION === catalogs ===

/** token \0 service → (entries, monotonic stamp). Keyed on the token because a
 * keyless session is a supported state, not a miss — the catalogs are public. */
const CACHE = new Map<string, [Entry[], number]>();

function cacheKey(token: string, service: string): string {
  return `${token}\u0000${service}`;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function parseEntries(payload: unknown): Entry[] {
  const rows =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)['data']
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: Entry[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const eid = String(r['id'] ?? '').trim();
    if (!eid) continue;
    const conv: Array<[string, string]> = [];
    for (const c of asArray(r['supported_conversions'])) {
      if (typeof c === 'object' && c !== null && !Array.isArray(c)) {
        const cc = c as Record<string, unknown>;
        conv.push([String(cc['from'] ?? ''), String(cc['to'] ?? '')]);
      }
    }
    const langs: Array<[string, string]> = [];
    for (const l of asArray(r['supported_languages'])) {
      if (typeof l === 'object' && l !== null && !Array.isArray(l)) {
        const ll = l as Record<string, unknown>;
        langs.push([String(ll['code'] ?? ''), String(ll['display_name'] ?? '')]);
      }
    }
    out.push(
      new Entry(
        eid,
        String(r['display_name'] ?? eid),
        String(r['provider'] ?? ''),
        String(r['description'] ?? ''),
        conv,
        langs,
      ),
    );
  }
  return out;
}

/**
 * `(entries, error)` — live fetch of one service's catalog.
 *
 * Keyless is a first-class case, not an error: the six catalogs are public and
 * unauthenticated, so browsing them is useful *before* `/ldxhub-api-setup` has
 * run. A key is only needed to run a job.
 */
export async function fetchCatalog(
  service: string,
  token = '',
  opts: { timeout?: number; useCache?: boolean } = {},
): Promise<[Entry[] | null, string]> {
  const { timeout = 20.0, useCache = true } = opts;
  const kind = SERVICES[service];
  if (kind === undefined) {
    return [null, `unknown service '${service}'`];
  }
  let tok = token;
  if (!tok) {
    const creds = loadCredentials();
    if (creds) tok = creds[0];
    // No credential is fine here — the request simply goes out unauthenticated.
  }
  if (useCache) {
    const hit = CACHE.get(cacheKey(tok, service));
    if (hit && monotonic() - hit[1] < CACHE_TTL) {
      return [hit[0], ''];
    }
  }
  const [obj, err] = await jsonRequest('GET', `${BASE_URL}/${service}/${kind}`, tok, {
    timeout,
  });
  if (err) return [null, err];
  const entries = parseEntries(obj ?? {});
  CACHE.set(cacheKey(tok, service), [entries, monotonic()]);
  return [entries, ''];
}

/**
 * Non-blocking UI read. TTL checked on *read* — an expired entry reads as
 * undefined so the next UI action re-fetches instead of serving stale models
 * forever.
 */
export function cachedCatalog(service: string): Entry[] | undefined {
  const creds = loadCredentials();
  const token = creds ? creds[0] : '';
  const hit = CACHE.get(cacheKey(token, service));
  if (!hit) return undefined;
  if (monotonic() - hit[1] >= CACHE_TTL) return undefined;
  return hit[0];
}

export function clearCache(): void {
  CACHE.clear();
}

/** Seconds since the cached catalog was fetched, or undefined when uncached. */
export function catalogAge(service: string): number | undefined {
  const creds = loadCredentials();
  const token = creds ? creds[0] : '';
  const hit = CACHE.get(cacheKey(token, service));
  return hit ? monotonic() - hit[1] : undefined;
}

export function defaultFor(service: string, creds?: Credentials | null): string {
  const c = creds === undefined ? loadCredentials() : creds;
  if (!c) return '';
  return (c[1][service] ?? '').trim();
}

/** explicit → profile default → first live catalog entry. */
export async function resolveEntry(
  service: string,
  explicit = '',
  creds: Credentials | null = null,
  token = '',
): Promise<[Entry | null, string]> {
  const want = (explicit ?? '').trim();
  const c = creds ?? loadCredentials();
  let tok = token;
  if (c && !tok) tok = c[0];
  const [entries, err] = await fetchCatalog(service, tok);
  if (err) return [null, err];
  if (!entries || entries.length === 0) {
    return [null, `${service} catalog is empty`];
  }
  if (want) {
    for (const e of entries) {
      if (e.id === want) return [e, ''];
    }
    return [null, `${want} not in ${service} catalog`];
  }
  const pinned = defaultFor(service, c);
  if (pinned) {
    for (const e of entries) {
      if (e.id === pinned) return [e, ''];
    }
  }
  return [entries[0], ''];
}

// === SECTION === files & jobs ===

function contentTypeFor(ext: string): string {
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.txt':
    case '.md':
      return 'text/plain';
    case '.jsonl':
    case '.json':
      return 'application/json';
    case '.xliff':
    case '.xlf':
      return 'application/xliff+xml';
    default:
      return 'application/octet-stream';
  }
}

/** `(file_id, error)` — multipart POST /files, field `file`. 200MB cap on the server. */
export async function uploadFile(
  filePath: string,
  token: string,
  opts: { timeout?: number } = {},
): Promise<[string, string]> {
  const { timeout = 60.0 } = opts;
  const p = filePath;
  try {
    if (!fs.statSync(p).isFile()) return ['', `no such file: ${p}`];
  } catch {
    return ['', `no such file: ${p}`];
  }
  // boundary carries the andy name (was `----zimzilla<uuid>`); random so two
  // concurrent uploads can never collide on the delimiter
  const boundary = `----andy${randomUUID().replace(/-/g, '')}`;
  const ctype = contentTypeFor(path.extname(p).toLowerCase());
  const fileBytes = fs.readFileSync(p);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${path.basename(p)}"\r\n` +
      `Content-Type: ${ctype}\r\n\r\n`,
    'utf-8',
  );
  const body = Buffer.concat([head, fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')]);

  let payload: Record<string, unknown>;
  try {
    const resp = await fetch(`${BASE_URL}/files`, {
      method: 'POST',
      headers: {
        ...buildHeaders(token),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!resp.ok) {
      return ['', mapHttpError(resp.status, await resp.text().catch(() => ''))];
    }
    const text = await resp.text();
    payload = JSON.parse(text || '{}') as Record<string, unknown>;
  } catch (e) {
    // includes a malformed JSON response, matching Python's ValueError catch
    return ['', `could not reach ${HOST}: ${String(e)}`];
  }
  const fid = String(payload['file_id'] ?? payload['id'] ?? '').trim();
  if (!fid) return ['', 'upload response had no file_id'];
  return [fid, ''];
}

/** Save a result file. Returns `''` on success, else an error. */
export async function downloadFile(
  fileId: string,
  token: string,
  dest: string,
  opts: { timeout?: number } = {},
): Promise<string> {
  const { timeout = 60.0 } = opts;
  let data: Buffer;
  try {
    const resp = await fetch(`${BASE_URL}/files/${fileId}/content`, {
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!resp.ok) {
      return mapHttpError(resp.status, await resp.text().catch(() => ''));
    }
    data = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return `could not fetch result: ${String(e)}`;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  } catch (e) {
    return `could not write ${dest}: ${String(e)}`;
  }
  return '';
}

export type JobPayload = Record<string, unknown>;

/** `(job_id, error)` — POST /{service}/jobs → 202 `{job_id}`. */
export async function createJob(
  service: string,
  payload: Record<string, unknown>,
  token: string,
  opts: { timeout?: number } = {},
): Promise<[string, string]> {
  const [obj, err] = await jsonRequest('POST', `${BASE_URL}/${service}/jobs`, token, {
    payload,
    timeout: opts.timeout ?? 30.0,
  });
  if (err) return ['', err];
  const d = (obj ?? {}) as Record<string, unknown>;
  const jid = String(d['job_id'] ?? d['id'] ?? '').trim();
  if (!jid) {
    return ['', `no job_id in response: ${JSON.stringify(obj ?? {}).slice(0, 200)}`];
  }
  return [jid, ''];
}

export async function getJob(
  service: string,
  jobId: string,
  token: string,
  opts: { timeout?: number } = {},
): Promise<[JobPayload | null, string]> {
  const [obj, err] = await jsonRequest('GET', `${BASE_URL}/${service}/jobs/${jobId}`, token, {
    timeout: opts.timeout ?? 20.0,
  });
  if (err) return [null, err];
  return [obj as JobPayload | null, ''];
}

const TERMINAL = new Set(['completed', 'complete', 'succeeded', 'done', 'failed', 'error']);

/**
 * Create a job and poll it to a terminal status.
 *
 * `sleep` is injectable so tests never wait. Safe to await from a handler: the
 * caller runs it off the render path (Python ran it via `asyncio.to_thread`),
 * not on the UI thread. Returns `(last_job_dict, error)`.
 */
export async function runJob(
  service: string,
  payload: Record<string, unknown>,
  token: string,
  opts: {
    timeout?: number;
    poll?: number;
    sleep?: (secs: number) => Promise<void>;
  } = {},
): Promise<[JobPayload | null, string]> {
  const { timeout = JOB_TIMEOUT, poll = POLL_INTERVAL } = opts;
  const sleep =
    opts.sleep ?? ((secs: number) => new Promise<void>((r) => setTimeout(r, secs * 1000)));
  const [jid, err] = await createJob(service, payload, token);
  if (err) return [null, err];
  const deadline = monotonic() + timeout;
  let last: JobPayload | null = null;
  let lastErr = '';
  for (;;) {
    const [obj, getErr] = await getJob(service, jid, token);
    if (getErr) {
      lastErr = getErr;
    } else if (obj !== null) {
      last = obj;
      lastErr = '';
      const status = String(obj['status'] ?? '').toLowerCase();
      if (TERMINAL.has(status)) return [last, ''];
    }
    if (monotonic() >= deadline) {
      if (last !== null) {
        return [last, `timed out after ${Math.round(timeout)}s (status ${last['status'] ?? 'None'})`];
      }
      return [null, lastErr || `timed out after ${Math.round(timeout)}s`];
    }
    await sleep(poll);
  }
}

/**
 * `(inline_text, output_file_id, error)` from a terminal job.
 *
 * File is authoritative when present; otherwise inline `summary` + `results[]`
 * is rendered as JSON. `failed` jobs report their problem as the error.
 */
export function jobOutput(job: unknown): [string | null, string | null, string] {
  if (typeof job !== 'object' || job === null || Array.isArray(job)) {
    return [null, null, 'no job payload'];
  }
  const j = job as Record<string, unknown>;
  const status = String(j['status'] ?? '').toLowerCase();
  if (status === 'failed' || status === 'error') {
    const detail = j['error'] || j['detail'] || j['message'] || status;
    return [null, null, `job ${status}: ${String(detail)}`];
  }

  const rawFid = j['output_file_id'] || j['file_id'];
  const fid = rawFid ? String(rawFid).trim() : '';

  const summary = j['summary'];
  const results = j['results'];
  if (typeof summary === 'string' && summary.trim()) {
    if (Array.isArray(results) && results.length > 0) {
      return [JSON.stringify({ summary, results }, null, 2), fid || null, ''];
    }
    return [summary, fid || null, ''];
  }
  if (Array.isArray(results) && results.length > 0) {
    return [JSON.stringify(results, null, 2), fid || null, ''];
  }

  for (const key of ['output', 'result', 'content']) {
    const val = j[key];
    if (typeof val === 'string' && val.trim()) {
      return [val, fid || null, ''];
    }
    if (typeof val === 'object' && val !== null) {
      return [JSON.stringify(val, null, 2), fid || null, ''];
    }
  }

  if (fid) return [null, fid, ''];
  return [null, null, 'job finished with no output'];
}

export function serviceHelp(): string {
  return (
    'structflow — free-form document generation from a prompt (model)\n' +
    'analyzedoc — structured JSON analysis of a PDF/image (model)\n' +
    'extractdoc — text or jsonl extraction from office/PDF (engine)\n' +
    'renderocr — OCR to docx/xlsx/pptx, 128 languages (engine)\n' +
    'castdoc — PDF to docx/xlsx/pptx conversion (engine)\n' +
    'refineloop — revise an XLIFF translation (model)'
  );
}
