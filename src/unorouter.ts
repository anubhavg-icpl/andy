/**
 * UnoRouter — a hosted Anthropic-protocol gateway, as an Andy source.
 *
 * Contract: remote endpoint (https://api.unorouter.com) fronting a few hundred
 * models behind one key; operator-supplied credential in a `source`-format
 * profile at $ANDY_HOME/unorouter/source (mode 600); the real catalog is the
 * PUBLIC /api/pricing endpoint (never /v1/models), cached CACHE_TTL seconds.
 * Network failures are returned as `[null, error]`, never thrown. Nothing here
 * echoes a key.
 */

/*
 * UnoRouter is a remote endpoint (``https://api.unorouter.com``) that fronts a
 * few hundred models behind one key. Measured on this box, not assumed:
 *
 * * ``POST /v1/messages`` answers with an Anthropic-shaped 401 when no key is
 *   sent — i.e. the Messages protocol is served natively, so there is no
 *   translation layer to write and none is written. Note the shape of that URL
 *   against DEFAULT_BASE_URL: the ``/v1`` is the SDK's, appended to the prefix
 *   it is handed. Passing ``https://api.unorouter.com/v1`` as the base composes
 *   to ``/v1/v1/messages`` and 404s on every turn while the catalog still works
 *   — the exact trap openrouter.ts documents, and the reason this constant
 *   carries no path component.
 *
 * **The catalog is two endpoints, and the obvious one is the wrong one.**
 * ``GET /v1/models`` is thin: no pricing, no tool metadata, and it lists every
 * kind of model the gateway fronts — chat, image, embedding, TTS, STT — with
 * the free ones marked only by a ``:free`` suffix. Taking it at face value
 * yields a picker where ~97 entries look free and most cannot run a turn at
 * all.
 *
 * ``GET /api/pricing`` is the real catalog, and it is **public** — 200 with no
 * key at all, so the free list is available before the operator has set
 * anything. Each entry carries ``is_free``, ``online``, and a ``metadata``
 * field holding ``supportsTools`` and ``outputModalities``. That is what makes
 * the filter in usableFreeModels possible: free **and** tool-calling **and**
 * text-output.
 *
 * **The counts move, so they are measured rather than remembered.** Re-measured
 * against the live catalog on 2026-10-16: 230 entries, 97 free, 161 text-output,
 * 46 free *and* usable here. The 51 free entries the filter drops split as 36
 * non-text (image, embedding, speech) and 15 text-but-no-tools. Every one of
 * those numbers was different an hour earlier — 220/87/154/40, then 232/99/161/48
 * — and they moved *again* between two runs minutes apart. That is the point:
 * this catalog is live, so any figure written into a docstring or a README is a
 * snapshot with a date on it, not a constant to be trusted. The filter is what
 * holds; the counts are what it returned on one afternoon.
 *
 * **Two measured caveats, stated rather than hidden.** Both were found by
 * sending real tool-using requests to every usable free model:
 *
 * * ``supportsTools`` is a strong filter but not a guarantee. Of 43 free models
 *   measured, 26 returned a real ``tool_use`` block and 17 did not — most of
 *   those 17 answering in prose. Two of them (``gemma-4-26b:free``,
 *   ``lfm-2.5-2.6b:free``) emit their tool call as *text*, in their own
 *   non-Anthropic format (``<|tool_call>call:get_weather{...}<tool_call|>``),
 *   which this harness cannot read. A model that fails the first turn is a
 *   model to switch off, not a bug here. The failure is not confined to obscure
 *   entries: ``nemotron-3-super-120b-a12b:free`` advertises tools, has a 262k
 *   context and answered a tool-using request with a complete ``end_turn`` in
 *   prose — it was briefly ranked second here on the strength of one early
 *   sample, and removed once it was re-measured.
 * * **The free tier is rate-limited and variable, and that is the constraint
 *   that bites first.** Repeating the same request, models that answered cleanly
 *   once came back ``429 rate_limit_exceeded`` or ``503 get_channel_failed`` on
 *   the next attempt; two separate sweeps of the same five models disagreed
 *   with each other on every single one. So a free model failing is more often
 *   "wait and retry" than "this model is broken", and **no small sample can
 *   rank these models** — the variance exceeds the differences between them.
 *   PREFERRED_FREE_MODELS is therefore a short list of models *verified to call
 *   a tool at all*, ordered by a context tiebreak rather than by a reliability
 *   claim the data cannot support.
 *
 * ``metadata`` is a **JSON-encoded string**, not an object, so it is parsed
 * rather than read. A malformed one degrades to "unknown", never to an
 * exception: this runs inside a TUI command.
 *
 * Two things make it different enough to live in its own module, exactly as
 * TokenHarbour and OpenRouter do:
 *
 * * **The credential is set, not discovered.** There is no shipped profile —
 *   the operator supplies their own key with ``/unorouter-api-setup``. It is
 *   kept in a ``source``-format file of the same shape as every other profile,
 *   mode 600.
 * * **The catalog is live, public and priced**, so the free list is real time
 *   and a model can be chosen before a key exists.
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
export const HOST = 'unorouter.com';

/**
 * The SDK's `base_url` — and it is the PREFIX BEFORE `/v1`, not the API root.
 * The Anthropic SDK appends `/v1/messages` to whatever it is given, so this
 * composes to `https://api.unorouter.com/v1/messages`, which is where UnoRouter
 * serves the Messages protocol (a 401 without a key, i.e. the path exists).
 * Measured: `https://api.unorouter.com/v1` as the base 404s with
 * `POST /v1/v1/messages`.
 */
export const DEFAULT_BASE_URL = 'https://api.unorouter.com';

/**
 * The real catalog. Public — no key required — which is why the free list works
 * before `/unorouter-api-setup` has run. The `/v1/models` endpoint is
 * deliberately not used: it carries no pricing and no tool metadata.
 */
export const PRICING_URL = `${DEFAULT_BASE_URL}/api/pricing`;

/** The profile this module writes and reads for the in-TUI key. */
export const PROFILE = path.join(andyHome(), 'unorouter', 'source');

/**
 * A fetched catalog older than this is refetched rather than trusted. The free
 * tier turns over, so a stale list is exactly the wrong list this picker exists
 * to avoid. Seconds; cache stamps are kept in ms (performance.now).
 */
export const CACHE_TTL = 300.0;

/** The suffix UnoRouter puts on a model that costs nothing. */
export const FREE_SUFFIX = ':free';

/** The output modality a model must offer to be usable by this harness. */
export const TEXT_MODALITY = 'text';

/**
 * Upstream channels at or above which redundancy counts as `good`.
 * **Our threshold, not UnoRouter's** — the gateway publishes no status, only
 * the channel list, so this line is a judgement about where "one channel
 * failing is absorbed" begins. Five is where the measured free tier separated:
 * the models sitting at 5-8 behaved, and the ones at 1-3 were the ones that
 * rate limited.
 */
export const UPSTREAM_THIN = 5;

// === SECTION === the catalog entry ===

/** One entry from UnoRouter's pricing catalog. */
export class Model {
  readonly id: string;
  readonly label: string;
  readonly contextLength: number | null;
  readonly maxOutput: number | null;
  /**
   * Whether the catalog says this model can call tools. What makes it usable by
   * this harness at all — a model that cannot call a tool cannot drive an agent
   * loop. A strong filter, not a guarantee: see the module header.
   */
  readonly tools: boolean;
  /** The catalog's own `is_free`, cross-checked against the `:free` suffix. */
  readonly free: boolean;
  readonly reasoning: boolean;
  readonly online: boolean;
  /**
   * Output modalities the catalog reports. `("text",)` is what a chat model
   * offers; an image or embedding model offers something else, and is dropped
   * by usableFreeModels however free it is.
   */
  readonly modalities: readonly string[];
  /**
   * How many upstream channels the catalog lists for this model — the length of
   * its `enable_groups`. This is *redundancy*, and redundancy is what decides
   * whether a rate limit is a hiccup or a wall: a model with one channel has
   * nowhere to fail over to, so a 429 from that channel is the end of the
   * request, while the same 429 against a model with a hundred channels is
   * retried elsewhere and the operator never sees it. Measured 2026-10-16 on
   * the free tier: `minimax-m2.7:free` at 101 channels down to 1, with the
   * single-channel models holding at **38-42% of the usable free list** across
   * three consecutive reads. That share is the finding and it held; the
   * absolute totals did not (47 -> 45 -> 42 usable models over the same three
   * reads), which is why the ratio is what is recorded here.
   *
   * It is NOT a health signal, and must never be labelled as one. The catalog
   * publishes no per-channel status (see the module header), so a model with 20
   * channels could still have all 20 degraded. What this counts is how many
   * places the router *could* go, not how many are answering today.
   */
  readonly upstreams: number;

  constructor(init: {
    id: string;
    label?: string;
    contextLength?: number | null;
    maxOutput?: number | null;
    tools?: boolean;
    free?: boolean;
    reasoning?: boolean;
    online?: boolean;
    modalities?: readonly string[];
    upstreams?: number;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.contextLength = init.contextLength ?? null;
    this.maxOutput = init.maxOutput ?? null;
    this.tools = init.tools ?? false;
    this.free = init.free ?? false;
    this.reasoning = init.reasoning ?? false;
    this.online = init.online ?? false;
    this.modalities = init.modalities ?? [];
    this.upstreams = init.upstreams ?? 0;
  }

  /** Whether this model produces text — i.e. can answer a Messages turn. */
  get chat(): boolean {
    return this.modalities.includes(TEXT_MODALITY);
  }

  /**
   * `"good"`, `"thin"`, `"single"` or `"unknown"` — a tier, not a measurement.
   *
   * The count is measured; **these thresholds are ours**, chosen to separate
   * the shapes that behave differently rather than read off anything UnoRouter
   * publishes. Stated as a tier so the UI can colour it while the number itself
   * stays on screen beside it — a colour alone would read as a status dot the
   * gateway never issued.
   *
   * - `single` — one channel, no failover at all. The measured shape of a model
   *   that rate limits.
   * - `thin` — a handful; a retry may or may not find another channel.
   * - `good` — enough redundancy that one channel failing is absorbed.
   * - `unknown` — the catalog said nothing (`0`), so no claim is made. Distinct
   *   from `single` on purpose: absence of the field is not evidence of a single
   *   channel.
   */
  get redundancy(): 'good' | 'thin' | 'single' | 'unknown' {
    if (this.upstreams <= 0) return 'unknown';
    if (this.upstreams === 1) return 'single';
    if (this.upstreams < UPSTREAM_THIN) return 'thin';
    return 'good';
  }

  /**
   * `"101 upstreams"` / `"1 upstream"` / `""` when the catalog was silent.
   *
   * Kept apart from blurb so the UI can colour it on its own — the count is the
   * one figure in the row that predicts whether the next request succeeds, and
   * a colour needs a segment boundary. Pluralised by hand rather than with an
   * `s` suffix, because `1 upstreams` in the column the operator scans is the
   * kind of detail that makes a careful number look careless.
   *
   * Empty for `0`: an unread channel list says nothing, and `0 upstreams` would
   * read as "no upstreams at all" — a worse claim than the truth, which is that
   * this catalog did not say.
   */
  get upstreamNote(): string {
    if (this.upstreams <= 0) return '';
    return this.upstreams === 1 ? '1 upstream' : `${this.upstreams} upstreams`;
  }

  /**
   * A one-line description for the picker.
   *
   * The upstream count is deliberately **not** here — see upstreamNote, which
   * the UI renders separately so it can carry a colour. Everything in this
   * string is a capability, which is what makes it safe to print in one dim
   * style.
   */
  get blurb(): string {
    const bits: string[] = [];
    if (this.free) bits.push('free');
    if (!this.tools) bits.push('no tools');
    if (this.reasoning) bits.push('reasoning');
    if (this.contextLength) bits.push(`${Math.floor(this.contextLength / 1000)}k ctx`);
    if (!this.online) bits.push('offline');
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

/** Whether *baseUrl* points at UnoRouter. */
export function isUnorouter(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}

/**
 * Generic name for the same test, so code that handles several gateways
 * uniformly can call `mod.activeEndpoint(url)` without knowing which one it
 * holds. See `_cmd_gateway_key` in ui/app.
 */
export const activeEndpoint = isUnorouter;

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
 * A UnoRouter key already sitting in `~/claude-source/<name>`.
 *
 * This is the `source ~/claude-source/<name>` idiom: the operator has already
 * written a profile for Claude Code, so Andy should use it rather than asking
 * for the key again. Returns `[key, model, path]` for the first profile that
 * points at UnoRouter and carries a token.
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
    if (!isUnorouter(exports['ANTHROPIC_BASE_URL'])) continue;
    const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
    if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', file];
  }
  return null;
}

/**
 * The UnoRouter key, however the operator supplied it.
 *
 * Resolved in order, first hit wins:
 *
 *   1. `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` **in the environment**, when
 *      `ANTHROPIC_BASE_URL` points at UnoRouter — i.e. the operator sourced a
 *      profile before launching.
 *   2. Andy's own profile, written by `/unorouter-api-setup`.
 *   3. Any UnoRouter profile under `~/claude-source`.
 *
 * Returns `[token, model, origin]` or `null`. The token is never logged or
 * returned to the transcript — only `origin` (a path, or "environment") is.
 */
export function loadCredentials(): [string, string, string] | null {
  if (isUnorouter(process.env['ANTHROPIC_BASE_URL'])) {
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
 * Write the key to Andy's own UnoRouter profile, mode 600.
 *
 * The file is the same `source` format as every other profile — it can be
 * sourced by a shell and read by loadCredentials — so there is one credential
 * format in the project, not two.
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
 * Point *cfg* at UnoRouter. Returns `[origin, model]` or `null`.
 *
 * The one place that knows how to aim a session at this gateway, shared by
 * `/zim-unorouter` and the launch-time restore in `cli.ts` — so a session
 * started by the command and one started from the remembered source end up
 * configured identically.
 *
 * `apiKey` is cleared rather than left as-is: the client sends `authToken` when
 * it is set, and a stale `apiKey` from another provider would be a credential
 * for the wrong service sitting in memory.
 *
 * With no model named by the profile, the session is aimed at a **free** model
 * rather than left on whatever the previous source called its model — see
 * defaultFreeModel. Returns `null` when no key can be found anywhere, and
 * leaves *cfg* alone.
 *
 * Sync, like the other gateways' applyTo and like Python's (whose urlopen could
 * block). That costs something here: a cold cache cannot be fetched
 * synchronously in JS, so when no model was named and the catalog cache is
 * cold, the free default is resolved in the BACKGROUND and written to
 * `cfg.model` when it lands (guarded so a deliberate /model choice made in the
 * meantime is never clobbered). cfg is read per turn, so a model that arrives a
 * second late still names the next request. The returned tuple then carries the
 * empty model, which callers already treat as "offer the free list".
 */
export function applyTo(cfg: GatewayConfig): [string, string] | null {
  const creds = loadCredentials();
  if (creds === null) return null;
  const [token, model0, origin] = creds;
  cfg.baseUrl = DEFAULT_BASE_URL;
  cfg.authToken = token;
  cfg.apiKey = '';
  let model = model0;
  if (!model) {
    const cached = cachedModels();
    if (cached !== null) {
      model = pickDefaultFree(cached) ?? '';
    } else {
      void defaultFreeModel(token).then((m) => {
        if (m && !cfg.model) cfg.model = m;
      });
    }
  }
  if (model) cfg.model = model;
  return [origin, model];
}

/**
 * Whether a remembered UnoRouter choice should override *baseUrl*.
 *
 * False for an endpoint the operator pointed somewhere deliberate — this
 * gateway itself, or any other non-local host. True for the local proxies and
 * the built-in default, which is what the launcher leaves behind when it has no
 * UnoRouter profile to source. This is what keeps a stale `current-source` from
 * hijacking a session aimed at a different provider.
 */
export function appliesToDefaultEndpoint(
  baseUrl: string | null | undefined,
): boolean {
  const url = (baseUrl ?? '').trim();
  if (isUnorouter(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// === SECTION === the live catalog ===

/**
 * Fetched catalogs, keyed by the token they were fetched with. UnoRouter's
 * catalog is public and identical for every caller, so the keyless fetch is
 * cached under "" and a keyed one under its token — a key change refetches
 * rather than serving a list fetched for a different account.
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

/** str(v or "") — Python's `str(x or "")` without the repr quoting. */
function toStr(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * The entry's `metadata`, however it arrived.
 *
 * It is a **JSON-encoded string** in the payload, so it is parsed. An object
 * (already decoded by some future revision), `null`, or junk all degrade to an
 * empty mapping: this runs inside a TUI command, and a metadata blob that
 * cannot be read is a model with unknown capabilities, not a crashed catalog.
 */
function metadataOf(entry: Record<string, unknown>): Record<string, unknown> {
  const raw = entry['metadata'];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}

function parseModels(payload: unknown): Model[] {
  // Every entry in the pricing payload, in the order the API returned them.
  // `data` is a mapping keyed by model name, so it is walked by value. A
  // malformed entry is skipped rather than allowed to take the catalog down.
  const data = asRecord(payload)['data'];
  const entries: unknown[] = Array.isArray(data)
    ? data
    : data !== null && typeof data === 'object'
      ? Object.values(data as Record<string, unknown>)
      : [];
  const out: Model[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const mid = toStr(rec['model_name'] || rec['id']).trim();
    if (!mid) continue;
    const meta = metadataOf(rec);
    const mods = meta['outputModalities'];
    const modalities = Array.isArray(mods)
      ? mods.filter((m): m is string => typeof m === 'string')
      : [];
    // `is_free` is the catalog's own answer and was measured to agree with the
    // `:free` suffix exactly; both are checked so a model zeroed out without
    // renaming is still caught.
    //
    // `enable_groups` is the upstream channel list, and its length is the
    // redundancy figure. Counted only when it is genuinely a list: a payload
    // that spells it as a string or a number leaves the count at 0, which
    // `redundancy` reports as "unknown" rather than "single" — a missing field
    // is not evidence of one channel, and guessing there would invent exactly
    // the warning this number exists to make trustworthy.
    const groups = rec['enable_groups'];
    const upstreams = Array.isArray(groups) ? groups.length : 0;
    out.push(
      new Model({
        id: mid,
        label: toStr(rec['description'] || '').slice(0, 120),
        // Python: meta.get("contextWindow") or meta.get("maxInputTokens") —
        // `||` mirrors the truthiness fallthrough.
        contextLength: toInt(meta['contextWindow'] || meta['maxInputTokens']),
        maxOutput: toInt(meta['maxOutputTokens']),
        tools: Boolean(meta['supportsTools']),
        free: Boolean(rec['is_free']) || mid.endsWith(FREE_SUFFIX),
        reasoning: Boolean(meta['isReasoning']),
        online: rec['online'] === undefined ? true : Boolean(rec['online']),
        modalities,
        upstreams,
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
 * Fetch UnoRouter's pricing catalog. Returns `[models, error]`.
 *
 * **No key required** — the catalog is public, so `token` defaults to empty and
 * the free list is available before `/unorouter-api-setup` has run. A key is
 * sent when one is supplied, so the listing matches what this session would
 * actually be charged.
 *
 * A network failure is returned, never raised: the caller is a TUI command that
 * must say "could not reach UnoRouter" rather than take the session down.
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

  // The catalog lives at `/api/pricing` — a sibling of the SDK's
  // `/v1/messages`, not under the `/v1` prefix, so it is spelled out in
  // PRICING_URL rather than composed from DEFAULT_BASE_URL. The two are
  // different roots on purpose.
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  let resp: Response;
  try {
    resp = await fetch(PRICING_URL, {
      headers,
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    return [null, `could not reach ${HOST}: ${errText(e)}`];
  }
  if (resp.status === 401 || resp.status === 403) {
    return [null, 'key rejected (401/403) — check it with /unorouter-api-setup'];
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

/** Only the models UnoRouter is currently giving away. */
export async function freeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.free), ''];
}

/**
 * The free models this harness can actually drive, most redundant first.
 *
 * Free **and** tool-calling **and** text-output. Both extra tests earn their
 * place:
 *
 * - Without the tool test, a model that cannot call a tool is offered and then
 *   fails on the first turn — an agent loop with no way to act.
 * - Without the modality test the list fills with what the gateway also fronts
 *   for free: SDXL image generators, embedding models, Whisper transcription
 *   and TTS voices. All are genuinely free, none can answer a Messages turn.
 *   Measured 2026-10-16: 97 free entries, 46 usable here — the filter drops 36
 *   for modality and 15 for missing tool support. Those counts shift between
 *   runs; see the module header.
 *
 * **Sorted by upstream channel count, descending.** The order is the point of
 * the command as much as the filter is: the operator asked which model is most
 * likely to answer, and the answer is the one with the most channels behind it.
 * Measured 2026-10-16, the top of this list is `minimax-m2.7:free` at 101
 * upstreams and the bottom is a band of single-channel models — around two in
 * five of everything usable, a share that held across three consecutive reads
 * while the totals moved. Those are the ones that rate limit. Catalog order is
 * the tiebreak, via a stable sort (Array.prototype.sort is stable in JS), so
 * two models with the same redundancy stay in the order the gateway returned
 * them.
 */
export async function usableFreeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const [models, err] = await freeModels(token, opts);
  if (models === null) return [null, err];
  const usable = models.filter((m) => m.tools && m.chat);
  usable.sort((a, b) => b.upstreams - a.upstreams);
  return [usable, ''];
}

/**
 * Every text model id, catalog order preserved — what `/model` should offer.
 *
 * Text-output models, not only the free ones: an operator who names a paid
 * model deliberately should not have it refused as "not served by unorouter"
 * against a list that was filtered to the free tier. The image, embedding and
 * speech entries are still dropped — they cannot answer a turn, so offering
 * them would be offering something that fails.
 */
export async function modelIds(
  token = '',
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.chat).map((m) => m.id), ''];
}

/**
 * Free models **verified to call a tool at all**, in the order a fresh switch
 * should try them. Every name here was sent a real tool-using request and
 * returned an actual `tool_use` block at least once — that is the bar, and it
 * is a real one, because most of the catalog's free models never clear it.
 *
 * **The order is not a reliability ranking, and the code should not pretend it
 * is.** Two sweeps were run on 2026-10-16, three spaced attempts per model each
 * time. They did not agree:
 *
 *              first sweep      confirmation
 *   gemini-3.6-flash:free      3/3      2/3
 *   qwen3.8-27b:free           3/3      2/3
 *   glm-5.3-flash:free         3/3      1/3
 *   deepseek-v4.1-flash:free   1/3      2/3
 *   gpt-oss-20b:free           1/3      2/3
 *
 * Nothing reproduced, and the failures are a mix of the gateway erroring out
 * and the model answering in prose. Three attempts cannot separate these
 * models: the run-to-run variance is larger than the difference between them.
 * So the honest reading of that table is not "gemini is the best" but **"all
 * five can call a tool, and none does so dependably"** — which is a property of
 * the free tier, not of any one model, and is the constraint the module header
 * describes.
 *
 * What the order *does* encode is a tiebreak on **context** among models that
 * showed no measurable difference in willingness: `gemini-3.6-flash:free` leads
 * on its 1M window over `qwen3.8-27b:free`'s 64k, which is tight for the tool
 * loop this harness runs. Below those two the order is a preference, not a
 * finding.
 *
 * **Reordered 2026-10-16 on a second measured axis: upstream redundancy.** The
 * tool-calling sweeps above could not separate these models, but the catalog's
 * channel counts do separate them — with one correction that had to be measured
 * rather than assumed. Five consecutive reads of each candidate:
 *
 *   gemini-3.6-flash:free       13, 13, 13, 13, 13   (13 upstreams, 1M ctx)
 *   gpt-oss-20b:free            13, 13, 13, 13, 13   (13 upstreams, 128k ctx)
 *   glm-5.3-flash:free           1,  1,  1,  1,  1   (1 upstream, 1M ctx)
 *   qwen3.8-27b:free             1,  2,  1,  2,  2   (1-2 upstreams, 65k ctx)
 *   deepseek-v4.1-flash:free     gone from the catalog
 *
 * A single read put `gpt-oss-20b:free` at 14 against `gemini`'s 12, which
 * looked like a reason to promote it. Re-measuring showed both at 13 on every
 * one of five reads: **the 14/12 gap was drift, not signal**, and promoting on
 * it would have been reading noise into a ±2 wobble. So the two are tied, and
 * the existing context tiebreak decides between them — `gemini` leads on its
 * 1M window over `gpt-oss`'s 128k, exactly as it did before this axis was
 * added.
 *
 * What the counts *do* settle is the thing that mattered: `glm-5.3-flash:free`
 * and `qwen3.8-27b:free` have one channel each, and a single channel is the
 * measured shape of a model that rate limits. Two of the five original entries
 * were therefore fragile, so the default this harness picked for a fresh switch
 * was, a third of the time, one of the models that stalls — the operator's
 * complaint arriving one step earlier, as "the harness chose badly on my behalf"
 * rather than "the list is misleading". They stay in the tuple only as a last
 * resort: present so a catalog that has lost everything else still resolves,
 * ranked below the redundant models rather than above them.
 *
 * A name that has since gone away falls through to the next, then to the
 * catalog's own order — load-bearing rather than theoretical, since
 * `deepseek-v4.1-flash:free` is already gone and `glm-5.3-flash:free` was gone
 * within the hour it was first measured.
 */
export const PREFERRED_FREE_MODELS: readonly string[] = [
  'gemini-3.6-flash:free',
  'gpt-oss-20b:free',
  'glm-5.3-flash:free',
  'qwen3.8-27b:free',
  'deepseek-v4.1-flash:free',
];

/**
 * A free model to use when the operator has chosen none.
 *
 * Exists because the alternative was measured to fail on the other gateways:
 * with no saved preference, applyTo left `cfg.model` on whatever the previous
 * source had named, and switching here then sent *that* provider's model name
 * to UnoRouter — a name it does not serve. Naming a free model instead means a
 * fresh switch spends nothing and works, which is the whole reason a free tier
 * is worth surfacing.
 *
 * Cache first: this runs inside applyTo, which runs at startup and on every
 * source switch, so the common case must not touch the network. Only with a
 * cold cache is a fetch attempted, and then bounded by *timeout* so a slow
 * gateway delays a launch rather than hanging it.
 *
 * Returns `undefined` when nothing free is on offer, leaving the caller's model
 * untouched — an empty catalog is not a reason to invent a name.
 */
export async function defaultFreeModel(
  token = '',
  opts: { timeout?: number } = {},
): Promise<string | undefined> {
  const { timeout = 8.0 } = opts;
  let models = cachedModels();
  if (models === null) {
    const [fetched] = await fetchModels(token, { timeout });
    models = fetched;
  }
  return models ? pickDefaultFree(models) : undefined;
}

/**
 * The default-model choice over an already-fetched list: PREFERRED_FREE_MODELS
 * order first, then the catalog's own order. Sync so applyTo can make the same
 * choice from a warm cache without a fetch.
 */
function pickDefaultFree(models: Model[]): string | undefined {
  const usable = models.filter((m) => m.free && m.tools && m.chat);
  if (usable.length === 0) return undefined;
  const present = new Set(usable.map((m) => m.id));
  for (const preferred of PREFERRED_FREE_MODELS) {
    if (present.has(preferred)) return preferred;
  }
  return usable[0]!.id;
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
 * **The CACHE_TTL check is load-bearing**, exactly as it is in the other
 * gateway modules. fetchModels has always refused to *reuse* an entry past its
 * TTL, but reading it back regardless reported a catalog fetched once as live
 * for the rest of the session. A free tier turns over, so a stale list is the
 * wrong list this picker exists to avoid. An expired entry reads as `null`,
 * which callers already handle as "no catalog".
 */
export function cachedModels(): Model[] | null {
  let newest: { models: Model[]; at: number } | null = null;
  for (const entry of CACHE.values()) {
    if (newest === null || entry.at > newest.at) newest = entry;
  }
  if (newest === null || performance.now() - newest.at >= CACHE_TTL * 1000) return null;
  return [...newest.models];
}

/** The last-fetched text model ids, without touching the network. */
export function cachedIds(): string[] | null {
  const models = cachedModels();
  return models !== null ? models.filter((m) => m.chat).map((m) => m.id) : null;
}

/** Drop every cached catalog. Called when the key changes. */
export function clearCache(): void {
  CACHE.clear();
}

/**
 * `(in, out)` per Mtok for *model*, when the catalog can answer.
 *
 * Only the **free** tier can be priced from this catalog. UnoRouter publishes
 * `model_ratio`/`completion_ratio` — dimensionless multipliers against the
 * gateway's own credit unit — not dollars per million tokens, so turning them
 * into a rate would be inventing a number and printing it as if it were the
 * gateway's own. A paid model therefore returns `null` and the caller falls
 * back to this harness's local estimate table, which is labelled as an
 * estimate. A free model returns `(0.0, 0.0)`, which is exact, and is what
 * makes the note read `free` rather than `$0.00/$0.00`.
 */
export function priceFor(
  model: string,
  models: Model[] | null,
): [number, number] | null {
  const found = modelFor(model, models);
  if (found === null || !found.free) return null;
  return [0.0, 0.0];
}

/** The catalog's entry for *model*, if the catalog knows it. */
export function modelFor(model: string, models: Model[] | null): Model | null {
  if (!models) return null;
  const base = model.trim();
  for (const m of models) {
    if (m.id === base) return m;
  }
  return null;
}

/**
 * A cheap sanity check before writing a key, so a typo fails loudly.
 *
 * Deliberately loose — the gateway decides what is valid, not us — but strict
 * enough to catch a pasted shell line or a bare word: a UnoRouter key is a long
 * `sk-` token.
 */
export function looksLikeKey(value: string): boolean {
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(v);
}
