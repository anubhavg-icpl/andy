/**
 * AIHubMix — a hosted Anthropic-protocol gateway, as an Andy source.
 *
 * Contract: remote endpoint (https://aihubmix.com) fronting ~857 models behind
 * one key; operator-supplied credential in a `source`-format profile at
 * $ANDY_HOME/aihubmix/source (mode 600); the catalog is public and live,
 * cached CACHE_TTL seconds. Network failures are returned as `[null, error]`,
 * never thrown. Nothing here echoes a key.
 */

/*
 * AIHubMix is a remote endpoint (``https://aihubmix.com``) that fronts 857
 * models behind one key. Measured on this box, not assumed:
 *
 * * ``POST /v1/messages`` **is served natively**. It answers with a real
 *   Anthropic-shaped reply — ``content`` blocks of ``thinking`` / ``text`` /
 *   ``tool_use``, ``stop_reason`` of ``tool_use``, and a proper SSE stream of
 *   ``message_start`` … ``message_stop`` when ``stream: true``. There is no
 *   translation layer to write and none is written, which is what makes this a
 *   genuine source rather than a tool surface like LDXHub.
 * * ``GET /api/v1/models`` answers **with no key at all** — 857 models when
 *   this was written. The catalog is public, so the free list can be shown, and
 *   a model chosen, *before* the operator has set anything.
 * * The free models actually run. ``coding-glm-5-free`` and
 *   ``qwen3.8-flash-free`` both answered a real request on a key with no credit
 *   balance — the paid ones returned ``403 "Your account balance is
 *   insufficient"``. So the free tier is usable on its own, which is the whole
 *   reason to add this source.
 *
 * Two traps, measured rather than guessed:
 *
 * * **Do not trust the ``tool_call`` field to mean "no tools".**
 *   ``qwen3.8-flash-free`` carries ``tool_call: null`` and still returns a
 *   ``tool_use`` block when handed a tool. Filtering the free list on that
 *   field — the obvious thing, and what OpenRouter's equivalent invites — would
 *   hide working models. It is recorded for display and never used to exclude.
 * * **The ``-free`` / ``:free`` suffix is not the free signal.** Six
 *   ``meta-llama/…:free`` and ``mistralai/…:free`` entries carry a non-zero
 *   0.02 price; they are *not* free. Meanwhile 50 entries are priced 0/0. The
 *   price is the truth and the suffix is a hint, so Model.free requires a
 *   successful price read and treats the suffix as corroboration only.
 *
 * Nothing here echoes a key.
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
 * The canonical host. Matching is by this substring, so a trailing slash and
 * any subdomain path all count as the same source.
 */
export const HOST = 'aihubmix.com';

/**
 * The SDK's `base_url` — and it is the PREFIX BEFORE `/v1`, not the API root.
 * The Anthropic SDK appends `/v1/messages` to whatever it is given, so this
 * composes to `https://aihubmix.com/v1/messages`, which is exactly where this
 * gateway serves the Messages protocol (measured: a real 403 balance error, not
 * a 404). The catalog is a *sibling* under the same version segment and is
 * spelled out in full at the call site, because it lives at `/api/v1/models` —
 * a different prefix entirely.
 */
export const DEFAULT_BASE_URL = 'https://aihubmix.com';

/** The profile this module writes and reads for the in-TUI key. */
export const PROFILE = path.join(andyHome(), 'aihubmix', 'source');

/**
 * A fetched catalog older than this is refetched rather than trusted.
 * Seconds; cache stamps are kept in ms (performance.now).
 */
export const CACHE_TTL = 300.0;

/** Suffixes that *hint* at a free model. A hint only — see the module header. */
export const FREE_SUFFIXES: readonly string[] = ['-free', ':free'];

// === SECTION === the catalog entry ===

/** One entry from AIHubMix's catalog. */
export class Model {
  readonly id: string;
  readonly label: string;
  readonly contextLength: number | null;
  readonly maxOutput: number | null;
  readonly priceIn: number;
  readonly priceOut: number;
  /**
   * `types` verbatim — `llm`, `image_generation`, `tts`, `embedding` and
   * combinations (`llm,search`). Only something carrying `llm` can answer a
   * chat request, so this is what keeps image and audio models out of
   * `/model`.
   */
  readonly types: string;
  /**
   * Whether the catalog *claims* tool calling. Advisory only: this is `null`
   * for models that demonstrably do call tools, so it is shown and never used
   * to filter.
   */
  readonly toolCall: boolean | null;
  readonly reasoning: boolean;
  /**
   * Whether a price was actually **read**, not merely whether a pricing block
   * was present. Without it a missing block would read as 0/0 and mark every
   * unpriced model free — and this catalog has entries carrying a null price.
   */
  readonly priced: boolean;

  constructor(init: {
    id: string;
    label?: string;
    contextLength?: number | null;
    maxOutput?: number | null;
    priceIn?: number;
    priceOut?: number;
    types?: string;
    toolCall?: boolean | null;
    reasoning?: boolean;
    priced?: boolean;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.contextLength = init.contextLength ?? null;
    this.maxOutput = init.maxOutput ?? null;
    this.priceIn = init.priceIn ?? 0.0;
    this.priceOut = init.priceOut ?? 0.0;
    this.types = init.types ?? '';
    this.toolCall = init.toolCall ?? null;
    this.reasoning = init.reasoning ?? false;
    this.priced = init.priced ?? false;
  }

  /**
   * Whether this model costs nothing.
   *
   * Requires a successful price read of 0/0, and *additionally* accepts the
   * suffix when a price could not be read at all. The suffix alone is not
   * enough — the `meta-llama/…:free` family carries a real 0.02 price and is
   * not free — but a suffixed entry with no parseable price is better treated
   * as free than as a paid model with an unknown cost.
   */
  get free(): boolean {
    if (this.priced) return this.priceIn === 0.0 && this.priceOut === 0.0;
    return FREE_SUFFIXES.some((s) => this.id.endsWith(s));
  }

  /** Whether this model can answer a chat request at all. */
  get chat(): boolean {
    return this.types.includes('llm');
  }

  /** Whether the catalog *claims* tool support. Advisory, not a filter. */
  get tools(): boolean {
    return Boolean(this.toolCall);
  }

  /** A one-line description for the picker. */
  get blurb(): string {
    const bits: string[] = [];
    if (this.free) bits.push('free');
    else if (this.priceIn || this.priceOut)
      bits.push(`$${fmtG(this.priceIn)}/$${fmtG(this.priceOut)}`);
    if (this.contextLength) bits.push(`${Math.floor(this.contextLength / 1000)}k ctx`);
    if (this.reasoning) bits.push('reasoning');
    if (this.types && this.types !== 'llm') bits.push(this.types);
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

/** Whether *baseUrl* points at AIHubMix. */
export function isAihubmix(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}

/**
 * Generic name for the same test, so code that handles several gateways
 * uniformly can call `mod.activeEndpoint(url)` without knowing which one it
 * holds. See `_cmd_gateway_key` in ui/app.
 */
export const activeEndpoint = isAihubmix;

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
 * An AIHubMix key already sitting in `~/claude-source/<name>`.
 *
 * This is the `source ~/claude-source/<name>` idiom: the operator has already
 * written a profile for Claude Code, so Andy should use it rather than asking
 * for the key again. Returns `[key, model, path]` for the first profile that
 * points at AIHubMix and carries a token.
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
    if (!isAihubmix(exports['ANTHROPIC_BASE_URL'])) continue;
    const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
    if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', file];
  }
  return null;
}

/**
 * The AIHubMix key, however the operator supplied it.
 *
 * Resolved in order, first hit wins:
 *
 *   1. `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` **in the environment**, when
 *      `ANTHROPIC_BASE_URL` points at AIHubMix — i.e. the operator sourced a
 *      profile before launching.
 *   2. Andy's own profile, written by `/aihubmix-api-setup`.
 *   3. Any AIHubMix profile under `~/claude-source`.
 *
 * Returns `[token, model, origin]` or `null`. The token is never logged or
 * returned to the transcript — only `origin` (a path, or "environment") is.
 */
export function loadCredentials(): [string, string, string] | null {
  if (isAihubmix(process.env['ANTHROPIC_BASE_URL'])) {
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
 * Write the key to Andy's own AIHubMix profile, mode 600.
 *
 * The file is the same `source` format as every other profile — it can be
 * sourced by a shell and read by loadCredentials — so there is one credential
 * format in the project, not four.
 */
export function saveKey(token: string, model = ''): string {
  mkdirSync(path.dirname(PROFILE), { recursive: true });
  try {
    chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    // Read-only home: the TUI must not die on a chmod.
  }
  const body =
    `export ANTHROPIC_BASE_URL="${DEFAULT_BASE_URL}"\n` +
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
 * Point *cfg* at AIHubMix. Returns `[origin, model]` or `null`.
 *
 * The one place that knows how to aim a session at this gateway, shared by
 * `/zim-aihubmix` and the launch-time restore in `cli.ts` — so a session
 * started by the command and one started from the remembered source end up
 * configured identically.
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
 * Whether a remembered AIHubMix choice should override *baseUrl*.
 *
 * False for an endpoint the operator pointed somewhere deliberate — this
 * gateway itself, or any other non-local host. True for the local proxies and
 * the built-in default, which is what the launcher leaves behind when it has no
 * AIHubMix profile to source. This is what keeps a stale `current-source` from
 * hijacking a session aimed at a different provider.
 */
export function appliesToDefaultEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  const url = (baseUrl ?? '').trim();
  if (isAihubmix(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// === SECTION === the live catalog ===

/**
 * Fetched catalogs, keyed by the token they were fetched with. The catalog is
 * public and identical for every caller, so the keyless fetch is cached under
 * "" and a keyed one under its token — a key change refetches rather than
 * serving a list fetched for a different account.
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

/** float(v) with Python's catch semantics — null when it cannot be read. */
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
    const mid = toStr(rec['model_id']).trim();
    if (!mid) continue;
    const pricing = rec['pricing'];
    // `priced` records a successful *read*, not the block's presence: some
    // entries carry a null price, and treating that as 0/0 would mark every
    // unpriced model free — the exact failure the flag exists to prevent.
    let priced = false;
    let pin = 0.0;
    let pout = 0.0;
    if (pricing !== null && typeof pricing === 'object' && !Array.isArray(pricing)) {
      const a = toFloat((pricing as Record<string, unknown>)['input']);
      const b = toFloat((pricing as Record<string, unknown>)['output']);
      if (a !== null && b !== null) {
        pin = a;
        pout = b;
        priced = true;
      }
    }
    const toolRaw = rec['tool_call'];
    out.push(
      new Model({
        id: mid,
        label: toStr(rec['model_name']),
        contextLength: toInt(rec['context_length']),
        maxOutput: toInt(rec['max_output']),
        priceIn: pin,
        priceOut: pout,
        types: toStr(rec['types']),
        // bool(tool_call) if tool_call is not None else None — present-but-null
        // stays null (advisory-unknown), absent stays null too.
        toolCall: toolRaw === null || toolRaw === undefined ? null : Boolean(toolRaw),
        reasoning: Boolean(rec['reasoning']),
        priced,
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
 * Fetch AIHubMix's catalog. Returns `[models, error]`.
 *
 * **No key required** — the catalog is public, so `token` defaults to empty and
 * the free list is available before `/aihubmix-api-setup` has run. A key is
 * sent when one is supplied, because the listing should match what this session
 * would actually be charged.
 *
 * A network failure is returned, never raised: the caller is a TUI command
 * that must say "could not reach AIHubMix" rather than take the session down.
 * `models` is `null` on failure, `[]` for a genuinely empty catalog — the
 * caller can tell the two apart.
 */
export async function fetchModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const { timeout = 20.0, useCache = true } = opts;
  const key = (token ?? '').trim();
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && performance.now() - hit.at < CACHE_TTL * 1000) return [hit.models, ''];
  }

  // The catalog lives at `/api/v1/models` — note the `/api`, which the SDK's
  // prefix (`https://aihubmix.com`) does not carry. Messages are
  // `{base}/v1/messages` by the SDK's own appending; models are
  // `{base}/api/v1/models` by hand. Spelling both out is what stops one being
  // "fixed" into breaking the other.
  const url = `${DEFAULT_BASE_URL}/api/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeout * 1000) });
  } catch (e) {
    return [null, `could not reach ${HOST}: ${errText(e)}`];
  }
  if (resp.status === 401 || resp.status === 403) {
    return [null, 'key rejected (401/403) — check it with /aihubmix-api-setup'];
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
  CACHE.set(key, { models, at: performance.now() });
  return [models, ''];
}

/** Only the models AIHubMix is currently giving away. */
export async function freeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.free), ''];
}

/**
 * The free models this harness can actually drive.
 *
 * Free *and* able to answer a chat request — i.e. `types` carrying `llm`. The
 * filter is not decoration: of the 50 zero-priced entries, three are not chat
 * models at all (an OCR engine, a transcription endpoint, a decision model),
 * and offering those in `/models` would be offering something that fails on the
 * first turn.
 *
 * Note what is deliberately **not** filtered: tool support. The catalog's
 * `tool_call` field is `null` for `qwen3.8-flash-free`, which then returns a
 * real `tool_use` block when handed a tool — so filtering on it would hide
 * working models. It is shown in the blurb instead.
 */
export async function usableFreeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const [models, err] = await freeModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.chat), ''];
}

/** Every chat-capable model id, catalog order preserved. */
export async function modelIds(
  token = '',
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.chat).map((m) => m.id), ''];
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
 * whatever the last fetch left behind.
 *
 * **The CACHE_TTL check is load-bearing** — the same trap OpenRouter hit.
 * Without it a catalog fetched once reads as live for the rest of the session,
 * and this gateway's free tiers turn over (they are promotional campaigns with
 * expiry dates), so a stale list is exactly the wrong list this picker exists
 * to avoid. An expired entry reads as `null`, which callers already handle as
 * "no catalog".
 */
export function cachedModels(): Model[] | null {
  let newest: { models: Model[]; at: number } | null = null;
  for (const entry of CACHE.values()) {
    if (newest === null || entry.at > newest.at) newest = entry;
  }
  if (newest === null || performance.now() - newest.at >= CACHE_TTL * 1000) return null;
  return [...newest.models];
}

/** The last-fetched chat-capable ids, without touching the network. */
export function cachedIds(): string[] | null {
  const models = cachedModels();
  if (models === null) return null;
  return models.filter((m) => m.chat).map((m) => m.id);
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
 * enough to catch a pasted shell line or a bare word: an AIHubMix key is an
 * `sk-` token of hex.
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
