/**
 * TokenHarbour — a hosted Anthropic-protocol gateway, as an Andy source.
 *
 * Contract: remote endpoint (https://tokenharbour.ai) speaking the native
 * Anthropic Messages protocol; credentials are operator-set (never discovered),
 * stored in a `source`-format profile at $ANDY_HOME/tokenharbour/source, mode
 * 600; the model catalog is fetched live and cached CACHE_TTL seconds. Network
 * failures are returned as `[null, error]`, never thrown. Nothing here echoes
 * a key.
 */

/*
 * TokenHarbour is not a local LiteLLM proxy like Logfare and Token Juice: it is
 * a remote endpoint (``https://tokenharbour.ai``) that speaks the same Anthropic
 * Messages protocol, so Andy can talk to it with no proxy in between. Two
 * things make it different enough to live in its own module:
 *
 * * **The credential is set, not discovered.** There is no shipped profile — the
 *   operator supplies their own key with ``/tokenharbour-api-setup``. It is kept
 *   in a ``source``-format file of the same shape as every other profile, mode
 *   600, so it is read by the same parser and never printed.
 * * **The catalog is live.** TokenHarbour serves a large, changing set of models
 *   and marks some of them free (``:free``, priced 0/0). ``/tokenharbour-models``
 *   fetches that catalog in real time, so the free list is whatever the gateway
 *   is offering *now*, not a table baked in at release.
 *
 * Nothing here echoes a key. A profile that a shell already sourced — the
 * ``source ~/claude-source/<name>`` idiom — is honoured too: if
 * ``ANTHROPIC_BASE_URL`` already points at TokenHarbour, that key is used and
 * nothing is written.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { andyHome, envPath } from './shared.js';

// === SECTION === module constants ===

/**
 * Where the operator keeps their per-provider shell profiles — the same
 * `~/claude-source/<name>` files a plain `source` loads for Claude Code.
 * ($ANDY_CLAUDE_SOURCE overrides; was ZIMZILLA_CLAUDE_SOURCE.)
 */
export const CLAUDE_SOURCE = envPath(
  'ANDY_CLAUDE_SOURCE',
  path.join(homedir(), 'claude-source'),
);

/**
 * The canonical host. Matching is by this substring, so `https://tokenharbor.ai`,
 * `https://tokenharbor.ai/` and any subdomain path all count as the same source.
 */
export const HOST = 'tokenharbor.ai';

export const DEFAULT_BASE_URL = 'https://tokenharbor.ai';

/** The profile this module writes and reads for the in-TUI key. */
export const PROFILE = path.join(andyHome(), 'tokenharbour', 'source');

/**
 * A fetched catalog older than this is refetched rather than trusted, so the
 * free list stays "real time" without hitting the network on every keystroke.
 * Seconds; cache stamps are kept in ms (performance.now).
 */
export const CACHE_TTL = 300.0;

/** The suffix TokenHarbour puts on a model that costs nothing. */
export const FREE_SUFFIX = ':free';

// === SECTION === the catalog entry ===

/** One entry from TokenHarbour's catalog. */
export class Model {
  readonly id: string;
  readonly label: string;
  readonly tier: string;
  readonly contextLength: number | null;
  readonly priceIn: number;
  readonly priceOut: number;
  readonly toolCall: boolean;

  constructor(init: {
    id: string;
    label?: string;
    tier?: string;
    contextLength?: number | null;
    priceIn?: number;
    priceOut?: number;
    toolCall?: boolean;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.tier = init.tier ?? '';
    this.contextLength = init.contextLength ?? null;
    this.priceIn = init.priceIn ?? 0.0;
    this.priceOut = init.priceOut ?? 0.0;
    this.toolCall = init.toolCall ?? true;
  }

  /**
   * Whether this model is free.
   *
   * Two signals, either sufficient: the `:free` suffix TokenHarbour puts on the
   * id, and a 0/0 price in the catalog. The suffix alone would miss a model the
   * gateway zeroes out without renaming; the price alone would miss one that is
   * free but not yet priced in the listing.
   */
  get free(): boolean {
    if (this.id.endsWith(FREE_SUFFIX)) return true;
    return this.priceIn === 0.0 && this.priceOut === 0.0;
  }

  /** A one-line description for the picker. */
  get blurb(): string {
    const bits: string[] = [];
    if (this.tier) bits.push(this.tier);
    if (this.free) bits.push('free');
    else if (this.priceIn || this.priceOut)
      bits.push(`$${fmtG(this.priceIn)}/$${fmtG(this.priceOut)}`);
    if (this.contextLength) bits.push(`${Math.floor(this.contextLength / 1000)}k ctx`);
    return bits.join(' · ');
  }
}

// === SECTION === keys and profiles ===

/**
 * The slice of `sources` the selection helpers delegate to (PORT-MAP row 16).
 * `sources` owns `$ANDY_HOME/current-source`; two writers of one selection file
 * is how a switch made here and a switch made with `/zim-logfare` end up
 * disagreeing about what is live.
 */
interface SourcesSlice {
  currentKey(): string | undefined;
  setCurrent(key: string): void;
}

/**
 * Load `sources` lazily. Python imports it inside current_key/set_current to
 * keep the sources ⇄ provider cycle lazy (PORT-MAP §2.5); the TS equivalent is
 * a function-level dynamic import. The specifier sits in a variable so this
 * file typechecks before `sources.ts` lands (it is ported last in the family) —
 * Node still resolves it relative to this module at runtime.
 */
async function loadSources(): Promise<SourcesSlice> {
  const spec = './sources.js';
  return (await import(spec)) as SourcesSlice;
}

/** The source key the operator last selected, if any. Async for the lazy cycle. */
export async function currentKey(): Promise<string | undefined> {
  return (await loadSources()).currentKey();
}

/** Record the selection. Never fatal — a read-only home must not break the TUI. */
export async function setCurrent(key: string): Promise<void> {
  (await loadSources()).setCurrent(key);
}

/** Whether *baseUrl* points at TokenHarbour. */
export function isTokenharbour(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}

/** Parse `export VAR="value"` lines from a profile, without a shell. */
function readExports(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('export ')) continue;
    const body = line.slice('export '.length);
    const eq = body.indexOf('=');
    if (eq < 0) continue;
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

/**
 * A TokenHarbour key already sitting in `~/claude-source/<name>`.
 *
 * This is the `source ~/claude-source/haiku-5.5` idiom: the operator has
 * already written a profile for Claude Code, so Andy should simply use it
 * rather than asking for the key again. Returns `[key, model, path]` for the
 * first profile that points at TokenHarbour and carries a token.
 */
function keyFromClaudeSource(): [string, string, string] | null {
  let entries: string[];
  try {
    entries = readdirSync(CLAUDE_SOURCE).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    const file = path.join(CLAUDE_SOURCE, name);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    const exports = readExports(file);
    if (!isTokenharbour(exports['ANTHROPIC_BASE_URL'])) continue;
    const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
    if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', file];
  }
  return null;
}

/**
 * The TokenHarbour key, however the operator supplied it.
 *
 * Resolved in order, first hit wins:
 *
 *   1. `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` **in the environment**, when
 *      `ANTHROPIC_BASE_URL` points at TokenHarbour — i.e. the operator sourced
 *      a profile before launching. This is the case the feature exists for:
 *      `source ~/claude-source/haiku-5.5 && andy` should just work.
 *   2. Andy's own profile, written by `/tokenharbour-api-setup`.
 *   3. Any TokenHarbour profile under `~/claude-source`.
 *
 * Returns `[token, model, origin]` or `null`. The token is never logged or
 * returned to the transcript — only `origin` (a path, or "environment") is.
 */
export function loadCredentials(): [string, string, string] | null {
  if (isTokenharbour(process.env['ANTHROPIC_BASE_URL'])) {
    const token =
      process.env['ANTHROPIC_AUTH_TOKEN'] || process.env['ANTHROPIC_API_KEY'] || '';
    if (token) {
      return [token, process.env['ANTHROPIC_MODEL'] ?? '', 'environment'];
    }
  }

  const exports = readExports(PROFILE);
  const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
  if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', PROFILE];

  return keyFromClaudeSource();
}

/**
 * Write the key to Andy's own TokenHarbour profile, mode 600.
 *
 * The file is the same `source` format as every other profile — it can be
 * sourced by a shell, and read by loadCredentials — so there is one credential
 * format in the project, not two.
 */
export function saveKey(token: string, model = ''): string {
  mkdirSync(path.dirname(PROFILE), { recursive: true });
  try {
    chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    // Read-only home: the TUI must not die on a chmod.
  }
  // NOTE: the trailing slash on the base URL is deliberate — the original
  // wrote it and profiles in the wild carry it; host-substring matching makes
  // it equivalent to the bare form.
  const body =
    `export ANTHROPIC_BASE_URL="${DEFAULT_BASE_URL}/"\n` +
    `export ANTHROPIC_AUTH_TOKEN="${token}"\n` +
    `export ANTHROPIC_MODEL="${model}"\n` +
    'export ANTHROPIC_API_KEY=""\n';
  // Create with 600 from the outset, then rewrite in place: never a window in
  // which the key sits in a world-readable file.
  const fd = openSync(PROFILE, 'w', 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(PROFILE, 0o600);
  } catch {
    // umask may have loosened it; best effort only.
  }
  return PROFILE;
}

export function hasKey(): boolean {
  return loadCredentials() !== null;
}

/**
 * The mutable slice of Andy's Config this gateway aims at its endpoint
 * (config.ts §2.4: baseUrl / authToken / apiKey / model).
 */
export interface GatewayConfig {
  baseUrl: string;
  authToken: string;
  apiKey: string;
  model: string;
}

/**
 * Point *cfg* at TokenHarbour. Returns `[origin, model]` or `null`.
 *
 * The one place that knows how to aim a session at this gateway, shared by the
 * `/zim-tokenharbour` command and the launch-time restore in `cli.ts` — so a
 * session started by the command and one started from the remembered source end
 * up configured identically.
 *
 * `apiKey` is cleared rather than left as-is: the client sends `authToken` when
 * it is set, and a stale `apiKey` from another provider would be a credential
 * for the wrong service sitting in memory.
 *
 * Returns `null` when no key can be found anywhere, and leaves *cfg* alone.
 */
export function applyTo(cfg: GatewayConfig): [string, string] | null {
  const creds = loadCredentials();
  if (creds === null) return null;
  const [token, model, origin] = creds;
  cfg.baseUrl = DEFAULT_BASE_URL;
  cfg.authToken = token;
  cfg.apiKey = '';
  if (model) cfg.model = model;
  return [origin, model];
}

/**
 * Whether a remembered TokenHarbour choice should override *baseUrl*.
 *
 * False for an endpoint the operator pointed somewhere deliberate — the hosted
 * gateway itself, or any other non-local host. True for the local proxies and
 * the built-in default, which is what the launcher leaves behind when it has no
 * TokenHarbour profile to source. This is what keeps a stale `current-source`
 * from hijacking a session aimed at a different provider.
 */
export function appliesToDefaultEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  const url = (baseUrl ?? '').trim();
  if (isTokenharbour(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// === SECTION === the live catalog ===

/**
 * Fetched catalogs, keyed by the token they were fetched with, so a key change
 * does not serve the previous key's list. Stamps are performance.now() ms
 * (monotonic, like Python's time.monotonic).
 */
const CACHE = new Map<string, { models: Model[]; at: number }>();

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** int(v) with Python's catch-and-None semantics; truncates floats like int(). */
function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** float(v) with Python's catch semantics — None when it cannot be read. */
function toFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** str(v or "") — Python's `str(x or "")` without the repr quoting. */
function toStr(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function parseModels(payload: unknown): Model[] {
  const out: Model[] = [];
  const data = asRecord(payload)['data'];
  const entries = Array.isArray(data) ? data : [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const mid = toStr(rec['id']).trim();
    if (!mid) continue;
    const pricing = asRecord(rec['pricing']);
    // Python: float(pricing.get(k) or 0.0) inside a try — a missing key reads
    // as 0.0 here (TokenHarbour has no `priced` flag), an unparseable one
    // degrades to 0.0 via the catch.
    const pin = toFloat(pricing['input_usd_per_1m'] ?? 0.0) ?? 0.0;
    const pout = toFloat(pricing['output_usd_per_1m'] ?? 0.0) ?? 0.0;
    const ctx = toInt(rec['context_length']);
    const toolRaw = rec['tool_call'];
    out.push(
      new Model({
        id: mid,
        label: toStr(rec['label']),
        tier: toStr(rec['tier']),
        contextLength: ctx,
        priceIn: pin,
        priceOut: pout,
        // bool(entry.get("tool_call", True)): present-but-null is false,
        // absent is true.
        toolCall: toolRaw === undefined ? true : Boolean(toolRaw),
      }),
    );
  }
  return out;
}

/** Options shared by every catalog fetch wrapper. */
export interface FetchOpts {
  timeout?: number;
  useCache?: boolean;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Fetch TokenHarbour's catalog. Returns `[models, error]`.
 *
 * A network failure is returned, never raised: the caller is a TUI command
 * that must say "could not reach TokenHarbour" rather than take the session
 * down. `models` is `null` on failure, `[]` for a genuinely empty catalog —
 * the caller can tell the two apart.
 */
export async function fetchModels(
  token: string,
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const { timeout = 20.0, useCache = true } = opts;
  if (useCache) {
    const hit = CACHE.get(token);
    if (hit && performance.now() - hit.at < CACHE_TTL * 1000) return [hit.models, ''];
  }

  const url = `${DEFAULT_BASE_URL}/v1/models`;
  const headers: Record<string, string> = {
    // Send both, the way every Anthropic-protocol client does: the gateway
    // accepts either, and which one it honours is its business.
    Authorization: `Bearer ${token}`,
    'x-api-key': token,
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  };
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeout * 1000) });
  } catch (e) {
    return [null, `could not reach ${HOST}: ${errText(e)}`];
  }
  if (resp.status === 401 || resp.status === 403) {
    return [null, 'key rejected (401/403) — check it with /tokenharbour-api-setup'];
  }
  if (!resp.ok) {
    return [null, `HTTP ${resp.status} from ${HOST}`];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await resp.text());
  } catch (e) {
    return [null, `could not reach ${HOST}: ${errText(e)}`];
  }

  const models = parseModels(payload);
  CACHE.set(token, { models, at: performance.now() });
  return [models, ''];
}

/** Only the models TokenHarbour is currently giving away. */
export async function freeModels(
  token: string,
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.free), ''];
}

/** Every model id, catalog order preserved — what `/model` should offer. */
export async function modelIds(
  token: string,
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.map((m) => m.id), ''];
}

/** Seconds since the newest cache entry was filled, or `undefined` if none was. */
export function catalogAge(): number | undefined {
  if (CACHE.size === 0) return undefined;
  let newest = -Infinity;
  for (const entry of CACHE.values()) newest = Math.max(newest, entry.at);
  return (performance.now() - newest) / 1000;
}

/**
 * The last-fetched catalog as Model objects, or `null`.
 *
 * `/model` runs on the UI thread and must not block on a fetch, so it reads
 * whatever the last `/tokenharbour-models` (or a warm cache) left behind.
 *
 * **The CACHE_TTL check is load-bearing.** fetchModels has always refused to
 * *reuse* an entry past its TTL, but this read it back regardless — so a
 * catalog fetched once was reported as live for the rest of the session. The
 * picker exists to show what the gateway serves *now*; a stale list is the bug
 * it was written to fix. An expired entry now reads as `null`, which callers
 * already handle as "no catalog".
 */
export function cachedModels(): Model[] | null {
  let newest: { models: Model[]; at: number } | null = null;
  for (const entry of CACHE.values()) {
    if (newest === null || entry.at > newest.at) newest = entry;
  }
  if (newest === null || performance.now() - newest.at >= CACHE_TTL * 1000) return null;
  return [...newest.models];
}

/** The last-fetched ids, without touching the network. */
export function cachedIds(): string[] | null {
  const models = cachedModels();
  return models !== null ? models.map((m) => m.id) : null;
}

/** Drop every cached catalog. Called when the key changes. */
export function clearCache(): void {
  CACHE.clear();
}

/** The catalog's price for *model*, if the catalog knows it. */
export function priceFor(
  model: string,
  models: Model[] | null,
): [number, number] | null {
  if (!models) return null;
  const base = model.trim();
  for (const m of models) {
    if (m.id === base) return [m.priceIn, m.priceOut];
  }
  return null;
}

/**
 * A cheap sanity check before writing a key, so a typo fails loudly.
 *
 * Deliberately loose — the gateway decides what is valid, not us — but strict
 * enough to catch a pasted shell line or a bare word: a TokenHarbour key is a
 * long token, optionally `thk_live_`/`thk_test_` prefixed.
 */
export function looksLikeKey(value: string): boolean {
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(v);
}

// === SECTION === private display helper ===

/**
 * Python's `:g` (6 significant digits, trailing zeros stripped, exponent form
 * when the decimal exponent is < -4 or >= 6 — e.g. 0.0000015 renders as
 * "1.5e-06"). Kept faithful because blurb strings are compared against the
 * Python original's output.
 */
function fmtG(n: number): string {
  const P = 6;
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  if (exp >= -4 && exp < P) {
    // %f with precision P-1-exp, then strip trailing zeros and a bare dot.
    let s = n.toFixed(P - 1 - exp);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }
  // %e with precision P-1, mantissa zeros stripped, two-digit exponent.
  const [mant, e] = n.toExponential(P - 1).split('e');
  const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
  const sign = e.startsWith('-') ? '-' : '+';
  const digits = e.replace(/^[+-]/, '').padStart(2, '0');
  return `${m}e${sign}${digits}`;
}
