/**
 * antseed.ts — AntSeed: the P2P marketplace, reached through its local buyer proxy.
 *
 * What this module is: the AntSeed source adapter (ported from
 * zimzilla/antseed.py). AntSeed is not a hosted gateway — it is a P2P network
 * whose local **buyer** process exposes a normal HTTP API on
 * `localhost:8377` speaking both OpenAI and Anthropic, so Andy talks to it
 * exactly like the LiteLLM proxies.
 *
 * Invariants (measured on the live network, antseed 0.1.169, 2026-10-14 —
 * each one is load-bearing for the code below):
 *  - It is an Anthropic endpoint: `DEFAULT_BASE_URL` is the prefix *before*
 *    `/v1`, like every other source. Tool use survives the hop.
 *  - No credential is required: a request with no Authorization header
 *    returned 200, so `applyTo` sets a *placeholder* bearer (the harness
 *    refuses to start without a credential-shaped value; an empty string
 *    would be a lie about a key that does not exist).
 *  - The catalog is OpenAI-shaped (`{"object":"list","data":[...]}`) but a
 *    model is many offers — each entry carries a `peers` list with its own
 *    price and reputation. A shared OpenAI parser would silently drop every
 *    peer and make everything look free; hence a parser of our own.
 *  - Free means a free *peer* (0 in AND 0 out). The catalog's `"free"`
 *    category tag is NOT a substitute (6 tagged vs 13 priced 0/0 when
 *    measured) — price is the reliable signal, the tag is never consulted.
 *  - The router ranks by price *and* trust with `minTrustScore` defaulting
 *    to 60 while free peers cluster below it, so a bare free model name
 *    answers 502 `model_not_found`. The fix is AntSeed's own pinning syntax
 *    `<peerId>@<model>`, which bypasses the ranking — that is what
 *    `freeModelIds` hands back. A pin is necessary, not sufficient (200/429/
 *    502/400 all measured), so the picker orders peers but promises nothing.
 *  - Nothing here echoes a key, and nothing here can spend money: a request
 *    that would need credits comes back 402 `antseed_buyer_fault` from the
 *    proxy before this code sees a token.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { andyHome, envStr } from './shared.js';

/** The buyer's own identity directory. It holds `config.json` (which names
 *  the proxy port) and the node's wallet — read for the port, never for a
 *  secret. */
const ANTSEED_HOME = envStr('ANTSEED_DATA_DIR', path.join(homedir(), '.antseed'));

/** Matched as a substring, so `http://localhost:8377`, `http://127.0.0.1:8377`
 *  and a tunnel host all count. The port is what actually identifies it; see
 *  `isAntseed`. */
export const HOST = 'antseed';

/** The prefix *before* `/v1` — the SDK appends `/v1/messages` to this. The
 *  buyer prints this exact value as `ANTHROPIC_BASE_URL`. */
export const DEFAULT_BASE_URL = 'http://localhost:8377';

/** Where a remembered preference for this source is written. AntSeed needs
 *  no key, so unlike the other gateways this profile holds only the chosen
 *  peer pin and model — see `savePin`. */
const PROFILE = path.join(andyHome(), 'antseed', 'source');

/** A fetched catalog older than this is refetched rather than trusted. The
 *  peer list churns as sellers come and go, so this is deliberately short. */
export const CACHE_TTL = 120.0;

/** The buyer's default proxy port, used when `~/.antseed/config.json` cannot
 *  be read. Overridable at launch with `antseed buyer start --port`. */
export const DEFAULT_PORT = 8377;

/** The protocol name AntSeed uses for Anthropic Messages. A seller that does
 *  not advertise it rejects an Anthropic request with 400
 *  `unsupported_protocol`. */
export const ANTHROPIC_PROTOCOL = 'anthropic-messages';

/** The protocol a *peer* advertises when it can serve one. Note the
 *  asymmetry: a model's `supported_protocols` is what the network claims, a
 *  peer's `protocol` is what that one seller actually speaks — and they
 *  disagree. */
export const OPENAI_PROTOCOL = 'openai-chat-completions';

/** What is sent as the bearer token. The buyer authenticates nothing, so
 *  this is a marker that the harness has a credential-shaped value rather
 *  than a secret. Deliberately not a key-shaped string, so any log scrubber
 *  treats it as the non-secret it is. */
export const NO_KEY_PLACEHOLDER = 'antseed-local-no-key';

// === SECTION === the local buyer ===

export function buyerConfig(): Record<string, unknown> {
  /** `~/.antseed/config.json` as an object, or `{}` when unreadable. */
  try {
    return JSON.parse(
      fs.readFileSync(path.join(ANTSEED_HOME, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function proxyPort(): number {
  /** The port the local buyer is configured to listen on.
   *
   * Read from the buyer's own config rather than hardcoded, because
   * `antseed buyer start --port` changes it and the port is the only thing
   * that identifies this source. Falls back to `DEFAULT_PORT` when the file
   * is missing or malformed — a machine that has never run AntSeed still
   * gets a sensible guess rather than an exception. */
  const buyer = buyerConfig()['buyer'];
  const port = buyer !== null && typeof buyer === 'object' ? (buyer as Record<string, unknown>)['proxyPort'] : undefined;
  if (typeof port === 'number' && Number.isInteger(port) && 0 < port && port < 65536) {
    return port;
  }
  return DEFAULT_PORT;
}

export function isAntseed(baseUrl: string | null | undefined): boolean {
  /** Whether *baseUrl* points at a local AntSeed buyer proxy.
   *
   * Identified by the buyer's port, not by the word "antseed" — the URL the
   * buyer hands out is plain `http://localhost:8377` and contains no such
   * string. A `*.antseed.com` tunnel URL is matched too, for the case where
   * the buyer has been exposed with `antseed tunnel`. */
  const url = (baseUrl ?? '').trim();
  if (!url) return false;
  if (url.includes('antseed.com')) return true;
  const port = proxyPort();
  return ['localhost', '127.0.0.1', '[::1]'].some((host) => url.includes(`${host}:${port}`));
}

/** Generic name for the same test, so code handling several gateways
 *  uniformly can call `mod.activeEndpoint(url)` without knowing which one it
 *  holds. */
export const activeEndpoint = isAntseed;

export async function reachable(timeout = 1.5): Promise<boolean> {
  /** Whether a buyer proxy is actually answering on the configured port.
   *
   * A cheap check the UI can make before offering AntSeed, since the proxy
   * only exists while `antseed buyer start` is running. */
  try {
    const resp = await fetch(`http://127.0.0.1:${proxyPort()}/v1/models`, {
      signal: AbortSignal.timeout(timeout * 1000),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

// === SECTION === the catalog ===

export class Peer {
  /** One seller's offer of one model. */
  constructor(
    public readonly peerId: string,
    public readonly displayName = '',
    public readonly provider = '',
    public readonly protocol = '',
    public readonly priceIn = 0.0,
    public readonly priceOut = 0.0,
    public readonly reputation: number | null = null,
  ) {}

  /** Whether this seller charges nothing for the model.
   *
   * Both directions must be zero. A peer that is free in and paid out is a
   * paid peer — it would still drain credits on a long answer. */
  get free(): boolean {
    return this.priceIn === 0.0 && this.priceOut === 0.0;
  }

  /** Whether this seller advertises the Anthropic protocol.
   *
   * Sellers overwhelmingly advertise only `openai-chat-completions`, and the
   * proxy does translate for most of them — but not reliably: pinning
   * `qwen2.5-coder-7b` returned 400 `unsupported_protocol` on one
   * measurement and 200 on another. So this is advisory, used to order the
   * picker, never to hide a model. */
  get servesAnthropic(): boolean {
    return this.protocol === ANTHROPIC_PROTOCOL;
  }

  get blurb(): string {
    const bits: string[] = [];
    if (this.free) {
      bits.push('free');
    } else {
      bits.push(`$${fmtG(this.priceIn)}/$${fmtG(this.priceOut)} per Mtok`);
    }
    if (this.reputation !== null) bits.push(`trust ${this.reputation.toFixed(0)}`);
    if (this.displayName) bits.push(this.displayName);
    return bits.join(' · ');
  }
}

export class Model {
  /** One model on the network, with every seller offering it. */
  constructor(
    public readonly id: string,
    public readonly label = '',
    public readonly aliases: readonly string[] = [],
    public readonly contextLength: number | null = null,
    public readonly maxOutputTokens: number | null = null,
    public readonly toolUse = false,
    public readonly reasoning = false,
    public readonly modelType = 'text',
    public readonly protocols: readonly string[] = [],
    public readonly peers: readonly Peer[] = [],
  ) {}

  get freePeers(): readonly Peer[] {
    return this.peers.filter((p) => p.free);
  }

  /** Whether *any* seller offers this model for nothing.
   *
   * This is the whole definition of a free model here. There is no tag and
   * no suffix — the price on a peer is the only signal AntSeed publishes. */
  get free(): boolean {
    return this.freePeers.length > 0;
  }

  /** Whether the network claims Anthropic support for this model. */
  get servesAnthropic(): boolean {
    return this.protocols.includes(ANTHROPIC_PROTOCOL);
  }

  /** The peer the router would most plausibly pick, ignoring trust.
   *
   * Used for the price shown in the picker: quoting the cheapest seller is
   * the honest answer to "what does this model cost", even though the
   * router's trust floor may refuse to use it. */
  get cheapest(): Peer | null {
    if (this.peers.length === 0) return null;
    let best = this.peers[0];
    for (const p of this.peers) {
      if (p.priceIn < best.priceIn || (p.priceIn === best.priceIn && p.priceOut < best.priceOut)) {
        best = p;
      }
    }
    return best;
  }

  /** The model id to send so this model routes to a free seller.
   *
   * Composes AntSeed's own `<peerId>@<model>` syntax, which the buyer
   * documents as bypassing the router's price-and-trust ranking. Free peers
   * sit below the default `minTrustScore` of 60, so without this a free
   * model answers 502 `model_not_found` even though the peer is online.
   *
   * Among the free peers, the highest-trust one that advertises Anthropic
   * wins; failing that, the highest-trust free peer of any kind.
   *
   * The Anthropic preference is a *preference*, not a filter. In practice no
   * free peer advertises `anthropic-messages` at all, so the fallback is the
   * branch that actually runs — and the proxy translates for most
   * OpenAI-only sellers, which is why pinning a free model normally works
   * from here. Returns null when no seller offers the model for free.
   *
   * The trust ordering is the only signal the network publishes, and it is
   * a weak one: measured across the nine free pins on 2026-10-15, the
   * highest-reputation free peer answered 502 twice while the lowest
   * answered 200 twice. So this picks a *pinnable* peer, not a *reliable*
   * one — `defaultFreePin` carries the measured shortlist for the case
   * where nobody has chosen yet, and a 429/502 here means "pick another
   * seller", which the picker's blurb is what tells the operator. */
  pin(): string | null {
    const free = this.freePeers;
    if (free.length === 0) return null;
    const ranked = [...free].sort((a, b) => {
      const anth = Number(b.servesAnthropic) - Number(a.servesAnthropic);
      if (anth !== 0) return anth;
      return (b.reputation ?? 0.0) - (a.reputation ?? 0.0);
    });
    return `${ranked[0].peerId}@${this.id}`;
  }

  /** A one-line description for the picker.
   *
   * The seller counts are written as `N of M sellers` rather than
   * `N peers · M sellers`: "peer" and "seller" are the same thing in
   * AntSeed's vocabulary, so the two numbers side by side read as a
   * contradiction ("4 peers · 9 sellers" — which is the free one?) rather
   * than as the free count out of the total. */
  get blurb(): string {
    const bits: string[] = [];
    if (this.free) {
      const free = this.freePeers.length;
      const total = this.peers.length;
      if (free === total) {
        bits.push(`free · ${total} seller${total !== 1 ? 's' : ''}`);
      } else {
        bits.push(`free · ${free} of ${total} sellers`);
      }
    } else {
      const c = this.cheapest;
      if (c !== null) {
        bits.push(`$${fmtG(c.priceIn)}/$${fmtG(c.priceOut)} per Mtok`);
        const total = this.peers.length;
        bits.push(`${total} seller${total !== 1 ? 's' : ''}`);
      }
    }
    if (this.toolUse) bits.push('tools');
    if (this.contextLength) bits.push(`${Math.floor(this.contextLength / 1000)}k ctx`);
    return bits.join(' · ');
  }
}

/** Python `:g`-ish formatting: ~6 significant digits, trailing zeros
 *  dropped — for prices in blurbs. */
function fmtG(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toPrecision(6)));
}

/** A price as a float, tolerating a string or a missing field.
 *
 * AntSeed sends JSON numbers, but a seller's own metadata is not always
 * well-typed and a malformed price must not take the whole catalog down. A
 * zero here reads as "free", which is only safe because `Peer.free` also
 * requires the *other* direction to be zero. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0.0;
}

function parsePeers(raw: unknown): Peer[] {
  const out: Peer[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const peerId = String(e['peerId'] ?? '').trim();
    if (!peerId) continue;
    let rep = e['effectiveReputationScore'];
    if (rep === null || rep === undefined) rep = e['reputationScore'];
    out.push(
      new Peer(
        peerId,
        String(e['displayName'] ?? ''),
        String(e['provider'] ?? ''),
        String(e['protocol'] ?? ''),
        num(e['inputUsdPerMillion']),
        num(e['outputUsdPerMillion']),
        rep === null || rep === undefined ? null : num(rep),
      ),
    );
  }
  return out;
}

/** Turn the `/v1/models` payload into `Model` objects.
 *
 * The payload is OpenAI-shaped — `{"object": "list", "data": [...]}` — so
 * the shared OpenAI parser would appear to work. It would then silently
 * drop every peer, because the pricing that matters lives in a nested
 * `peers` array rather than in the entry, and a model with no peers would
 * look free. Hence a parser of its own.
 *
 * An entry with no id is skipped rather than kept: it cannot be requested,
 * and a nameless row in the picker is worse than no row. */
function parseModels(payload: Record<string, unknown>): Model[] {
  const out: Model[] = [];
  const data = payload['data'];
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const modelId = String(e['id'] ?? '').trim();
    if (!modelId) continue;
    let caps = e['capabilities'];
    if (caps === null || typeof caps !== 'object') caps = {};
    const c = caps as Record<string, unknown>;
    const ctx = e['context_length'] ?? c['contextWindow'];
    const maxOut = e['max_output_tokens'] ?? c['maxOutputTokens'];
    const aliases = e['aliases'] ?? [];
    const supported = e['supported_protocols'] ?? [];
    out.push(
      new Model(
        modelId,
        String(e['name'] ?? ''),
        Array.isArray(aliases)
          ? aliases.filter((a) => typeof a === 'string' || typeof a === 'number').map(String)
          : [],
        typeof ctx === 'number' && ctx !== 0 ? Math.trunc(ctx) : null,
        typeof maxOut === 'number' && maxOut !== 0 ? Math.trunc(maxOut) : null,
        Boolean(c['toolUse']),
        Boolean(c['reasoning']),
        String(e['type'] ?? 'text'),
        Array.isArray(supported) ? supported.map(String) : [],
        parsePeers(e['peers']),
      ),
    );
  }
  return out;
}

// === SECTION === fetching ===

const CACHE = new Map<string, [number, Model[]]>();

/** Monotonic seconds — Python `time.monotonic()`. */
function mono(): number {
  return performance.now() / 1000;
}

/** Cache per endpoint, not per module.
 *
 * The port can be changed with `--port` and the network's contents differ
 * between a local buyer and a tunnel, so one process-wide slot would serve a
 * catalog fetched from one endpoint to a session pointed at another. */
function cacheKey(baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export interface FetchOpts {
  timeout?: number;
  useCache?: boolean;
}

export async function fetchModels(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  /** Fetch the network's catalog. Returns `[models, ""]` or `[null, why]`.
   *
   * Needs no credential — the buyer serves its catalog openly to anything
   * that can reach the port, and a buyer that is not running is the expected
   * failure rather than an error worth alarming about. */
  const { timeout = 20.0, useCache = true } = opts;
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/models`;
  const key = cacheKey(baseUrl);
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && mono() - hit[0] < CACHE_TTL) {
      return [[...hit[1]], ''];
    }
  }

  let payload: unknown;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
    if (!resp.ok) {
      return [null, `HTTP ${resp.status} from the AntSeed buyer`];
    }
    payload = await resp.json();
  } catch (e) {
    const err = e as Error;
    if (err instanceof SyntaxError) {
      return [null, `could not read the AntSeed catalog: ${err.message}`];
    }
    const reason = err.name === 'TimeoutError' ? 'timed out' : (err.message ?? String(e));
    return [
      null,
      `could not reach the AntSeed buyer at ${url} — ` +
        'is `antseed buyer start` running? ' +
        `(${reason})`,
    ];
  }

  const models = parseModels(payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {});
  // An empty list is cached as a real answer: the network genuinely can have
  // nothing to sell, and re-fetching on every keystroke to rediscover that
  // is exactly the hammering the cache exists to prevent.
  CACHE.set(key, [mono(), models]);
  return [[...models], ''];
}

export function catalogAge(): number | null {
  /** Seconds since the cache was filled, or `null` if it never was.
   *
   * Not clamped to `CACHE_TTL`: an expired catalog is the case worth
   * reporting, and the caller needs the real number to say how stale it is. */
  const hit = CACHE.get(cacheKey(''));
  return hit ? mono() - hit[0] : null;
}

export function cachedModels(): Model[] | null {
  /** The last fetched catalog, if it is still fresh — else `null`.
   *
   * Never fetches. **The `CACHE_TTL` check is load-bearing:**
   * `fetchModels` has always refused to *reuse* an entry past its TTL, but
   * this read it back regardless, so a catalog fetched once was reported as
   * live for the rest of the session. AntSeed's seller set is the most
   * volatile of any source here — peers join and leave constantly — so a
   * stale list is the worst case. An expired entry now reads as `null`,
   * which callers already handle as "no catalog". */
  const hit = CACHE.get(cacheKey(''));
  if (!hit) return null;
  if (mono() - hit[0] >= CACHE_TTL) return null;
  return [...hit[1]];
}

export function cachedIds(): string[] | null {
  const models = cachedModels();
  if (models === null) return null;
  return models.map((m) => m.id);
}

export function clearCache(): void {
  CACHE.clear();
}

export async function freeModels(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  /** Every model at least one seller offers for nothing. */
  const [models, err] = await fetchModels(baseUrl, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.free), ''];
}

export async function usableFreeModels(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  /** Free models that can actually be pinned to a free seller.
   *
   * Identical to `freeModels` in practice — `Model.pin()` returns a value
   * exactly when a free peer exists — but stated separately so a caller
   * cannot forget that a free model is useless here without a pinnable
   * peer. */
  const [models, err] = await freeModels(baseUrl, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.pin() !== null), ''];
}

export async function freeModelIds(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  /** The **pinned** ids to send so free models route to a free seller.
   *
   * These are `<peerId>@<model>` strings, not bare model names. Handing
   * back the bare name would produce a list that looks right and 502s on
   * use, which is the exact failure this module was written to avoid. */
  const [models, err] = await usableFreeModels(baseUrl, opts);
  if (models === null) return [null, err];
  const out: string[] = [];
  for (const m of models) {
    const pin = m.pin();
    if (pin) out.push(pin);
  }
  return [out, ''];
}

/**
 * Free models measured to answer, in the order a fresh switch should try
 * them. This ranks *reliability*, not quality, because the network's own
 * reputation score does not predict it — it inverts. Measured 2026-10-15
 * over the nine free pins, two attempts each: the four below returned 200
 * both times, while the highest-reputation free peer (`jev-latest`, trust
 * 68.9) returned 502 twice and the lowest (`qwen2.5-coder-7b`, trust 28.6)
 * returned 200 twice. A name here that has since gone away simply falls
 * through to the ranking in `defaultFreePin`, so a stale entry costs one
 * dictionary lookup.
 */
export const PREFERRED_FREE_MODELS: readonly string[] = [
  'nemotron-120b-free',
  'nemotron-3-ultra-free',
  'glm-4.5-flash',
  'qwen2.5-coder-7b',
];

export async function defaultFreePin(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<string | null> {
  /** A pinned free model to use when the operator has chosen none.
   *
   * Exists because the alternative was measured to fail: with no saved
   * preference, `applyTo` left `cfg.model` on whatever the previous source
   * had named, and switching to AntSeed then sent a *paid* model name to the
   * router — which picked a paid peer and answered
   *
   *     402 antseed_buyer_fault: You are out of AntSeed credits for this request
   *
   * on a wallet holding 0.0 USDC. Naming a free pin instead means a fresh
   * switch spends nothing, which is the whole reason AntSeed is a source
   * here.
   *
   * Returns `null` when nothing free is on offer, leaving the caller's
   * model untouched — an empty network is not a reason to invent a name. */
  // Bounded, because this runs inside `applyTo`, which runs at startup and
  // on every source switch. The default 20s fetch timeout is right for an
  // explicit catalog command and wrong here: a buyer that is up but slow
  // must not hold the launch for twenty seconds to name a model the
  // operator can change in one command. `reachable` has already proven the
  // port answers, so a healthy buyer returns well inside this.
  const merged: FetchOpts = { timeout: 5.0, ...opts };
  const [models] = await usableFreeModels(baseUrl, merged);
  if (!models || models.length === 0) return null;
  const byId = new Map(models.map((m) => [m.id, m] as const));
  for (const modelId of PREFERRED_FREE_MODELS) {
    const m = byId.get(modelId);
    const pin = m !== undefined ? m.pin() : null;
    if (pin) return pin;
  }
  // None of the measured ones is on offer: take the alphabetically first of
  // whatever is. Ordering by name rather than by `Model.pin`'s trust ranking
  // is deliberate — that ranking prefers the *least* reliable peers, so it
  // would reintroduce the 502s this function exists to avoid.
  const sorted = [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of sorted) {
    const pin = m.pin();
    if (pin) return pin;
  }
  return null;
}

export async function modelIds(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(baseUrl, opts);
  if (models === null) return [null, err];
  return [models.map((m) => m.id), ''];
}

export async function agenticModels(
  baseUrl = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  /** Text models that report tool support — what an agentic harness needs. */
  const [models, err] = await fetchModels(baseUrl, opts);
  if (models === null) return [null, err];
  return [models.filter((m) => m.toolUse && m.modelType === 'text'), ''];
}

export function priceFor(model: string, models: Model[] | null): [number, number] | null {
  /** `(in, out)` per Mtok for *model*, or `null` when it cannot be priced.
   *
   * A pinned id (`<peerId>@<model>`) is unwrapped to the model before the
   * lookup, so a session running on a pinned free model still shows its
   * real price — which is zero — rather than failing to find itself in the
   * catalog. */
  if (!models || models.length === 0) return null;
  // Python split("@", 1)[1] keeps everything after the FIRST "@" — a model
  // id may itself contain "@" — so slice rather than split-with-limit.
  const at = model.indexOf('@');
  const wanted = at !== -1 ? model.slice(at + 1) : model;
  for (const m of models) {
    if (m.id === wanted) {
      if (m.free) return [0.0, 0.0];
      const c = m.cheapest;
      return c !== null ? [c.priceIn, c.priceOut] : null;
    }
  }
  return null;
}

// === SECTION === the remembered pin ===

/** Parse `export VAR="value"` lines from a profile, without a shell. */
function readExports(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('export ')) continue;
    const body = line.slice('export '.length);
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    let name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (name) out[name] = value;
  }
  return out;
}

export function loadPin(): [string, string] | null {
  /** The remembered `(model, peerId)` preference, or `null`.
   *
   * AntSeed issues no key, so this profile is not a credential — it is the
   * operator's answer to "which free peer should my sessions use", so that
   * a restart lands back on the same seller instead of re-picking one. */
  const exports = readExports(PROFILE);
  const model = (exports['ANTSEED_MODEL'] ?? '').trim();
  const peer = (exports['ANTSEED_PEER'] ?? '').trim();
  if (!model && !peer) return null;
  return [model, peer];
}

export function savePin(model: string, peer = ''): string {
  /** Remember a model and the peer to pin it to. Returns the profile path.
   *
   * Written mode 600 through an explicit open for the same reason every
   * other profile is: it lives in a home directory that may be shared, and
   * a later version of this file could carry a credential. Today it carries
   * none, which the header says out loud so nobody assumes otherwise. */
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  try {
    fs.chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    /* read-only home must not break the switch */
  }
  const body =
    '# Andy — AntSeed source preference. Not a credential:\n' +
    '# the local buyer proxy authenticates nothing.\n' +
    `export ANTSEED_MODEL="${model}"\n` +
    `export ANTSEED_PEER="${peer}"\n` +
    `export ANTHROPIC_BASE_URL="${DEFAULT_BASE_URL}"\n`;
  const fd = fs.openSync(PROFILE, 'w', 0o600);
  try {
    // writeSync(fd, string, position, encoding): the null position means
    // "write at the current position" — the encoding is the 4th argument.
    fs.writeSync(fd, body, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return PROFILE;
}

/** The config surface `applyTo` mutates (Config satisfies this
 *  structurally; fields must be writable). */
export interface AntseedTarget {
  baseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
}

export async function loadCredentials(): Promise<[string, string, string] | null> {
  /** `(token, model, origin)` in the shape the other gateways use.
   *
   * AntSeed has no key, so the token is `NO_KEY_PLACEHOLDER` — the same
   * marker `applyTo` sets. It exists so `/zim-antseed` can share one code
   * path with `/zim-openrouter` rather than branching around a credential
   * lookup that does not apply here.
   *
   * `null` when no buyer is reachable: that is the honest analogue of "no
   * key found", because a switch to a proxy that is not running would
   * report success and then fail on the first turn.
   *
   * `origin` is `"local buyer"` so the confirmation line reads
   * `key from local buyer`, which is what is actually true — there is no
   * profile and no environment variable behind it.
   *
   * The model falls back to `defaultFreePin`, not to `""`. `""` reads to
   * the caller as "nothing chosen yet, go and fetch a free list", which is
   * a round trip that ends with the *previous* source's model still in
   * place — the stale paid name behind the 402. Reporting a free pin here
   * makes the switch land on something that costs nothing without the
   * fetch. */
  if (!(await reachable())) return null;
  const pin = loadPin();
  let model = '';
  if (pin) {
    const [chosen, peer] = pin;
    if (chosen && peer) model = `${peer}@${chosen}`;
    else if (chosen) model = chosen;
  }
  const fallback = (await defaultFreePin()) ?? '';
  return [NO_KEY_PLACEHOLDER, model || fallback, 'local buyer'];
}

export async function applyTo(cfg: AntseedTarget): Promise<[string, string] | null> {
  /** Point *cfg* at the local AntSeed buyer. Returns `[origin, model]`.
   *
   * `authToken` is set to a placeholder because the harness refuses to
   * start without one (`apiKeyPresent` is false for an empty config) while
   * the proxy ignores it entirely — measured: a request with no auth
   * header, and one with a junk bearer, both returned 200. The placeholder
   * is a marker, not a secret, and is named so in the transcript.
   *
   * A remembered pin is composed into the model, so the session routes to
   * the seller the operator chose rather than to whatever the router ranks
   * first. With no remembered pin, a *measured* free model is named
   * instead — see `defaultFreePin` for why leaving `cfg.model` alone is
   * the one thing that must not happen here.
   *
   * Returns `null` when no buyer is reachable, leaving *cfg* alone — a
   * switch to a proxy that is not running would look like success and then
   * fail on the first turn. */
  if (!(await reachable())) return null;
  cfg.baseUrl = DEFAULT_BASE_URL;
  cfg.authToken = NO_KEY_PLACEHOLDER;
  cfg.apiKey = '';
  const pin = loadPin();
  if (pin) {
    const [model, peer] = pin;
    if (model && peer) cfg.model = `${peer}@${model}`;
    else if (model) cfg.model = model;
  } else {
    // No preference saved. Leaving cfg.model untouched is what produced the
    // 402 this function now exists to prevent: the name left over from the
    // previous source is usually a paid one, the router then refuses to
    // route it to a free peer, and the buyer answers "out of credits" on a
    // wallet that never had any. A free pin costs nothing and works.
    cfg.model = (await defaultFreePin()) || cfg.model;
  }
  return ['antseed', cfg.model];
}

export function appliesToDefaultEndpoint(baseUrl: string | null | undefined): boolean {
  /** Whether a remembered AntSeed choice should override *baseUrl*.
   *
   * True only for the built-in default and the local LiteLLM proxies — the
   * endpoints the launcher leaves behind when it has no profile to source.
   * An endpoint the operator pointed somewhere deliberate is left exactly
   * as they set it, so a stale selection cannot hijack a session aimed
   * elsewhere. */
  const url = (baseUrl ?? '').trim();
  if (isAntseed(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

export function looksLikeKey(value: string): boolean {
  /** Whether *value* looks like an AntSeed credential.
   *
   * Always false, and that is the honest answer: the buyer proxy accepts
   * any bearer, so no string is more or less a key than another. Present so
   * this module satisfies the same interface as the gateways that do have
   * keys, and so a caller that offers to store one gets told there is
   * nothing to store. */
  return false;
}

/**
 * sources.ts owns `$ANDY_HOME/current-source`. Two writers of one selection
 * file is how a switch made here and a switch made with `/zim-source` end
 * up disagreeing about what is live — so this module delegates rather than
 * duplicating the read/write.
 *
 * The import is lazy (PORT-MAP "lazy" edge) with a non-literal specifier so
 * this file typechecks before the sources lane lands; the loose return
 * types accept either a sync or an async sources implementation.
 */
interface SourcesContract {
  currentKey(): string | undefined | Promise<string | undefined>;
  setCurrent(key: string): void | Promise<void>;
}

async function loadSources(): Promise<SourcesContract> {
  const spec = './sources.js';
  return (await import(spec)) as SourcesContract;
}

/** The source key the operator last selected, if any (delegates to sources). */
export async function currentKey(): Promise<string | undefined> {
  return await (await loadSources()).currentKey();
}

/** Record the selection. Never fatal — a read-only home must not break the
 *  TUI. The UI calls this on whatever its gateway table hands back, and
 *  AntSeed is in that table, so this has to exist even though the module
 *  has no key to store. */
export async function setCurrent(key: string): Promise<void> {
  await (await loadSources()).setCurrent(key);
}
