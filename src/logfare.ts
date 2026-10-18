/**
 * logfare.ts — Logfare's live catalog: what the upstream serves *right now*.
 * (port of zimzilla/logfare.py)
 *
 * What this module is: the fetched, not declared, model list for the default
 * upstream. Logfare's model line-up moves faster than this repo does — a list
 * baked into sources.ts was correct the day it was written and wrong a month
 * later (ten of fourteen models retired upstream, offered by /model, accepted
 * by the proxy, 404 at request time; a name on a list and a name the upstream
 * answers to look identical from here). So the list is fetched from
 *
 *     https://logfare.ai/v1/status?hours=24
 *
 * — the JSON API behind https://logfare.ai/status. Filtering on
 * `chat/completions` yields exactly the models that can answer a Messages
 * request, which is the only question this module exists to answer. The
 * status payload is also the health report (`status`, `uptime_percent`, real
 * traffic success rate), so the picker can say a model is degraded rather
 * than letting the operator find out mid-turn.
 *
 * Invariants:
 *  - Nothing here needs a key: the status API is public, so the catalog can
 *    be refreshed before the operator has authenticated anything.
 *  - A network failure is returned, never raised — the caller is a TUI
 *    command that must say "could not reach Logfare" rather than take the
 *    session down. `models` is null on failure, [] for a genuinely empty
 *    catalog; the caller can tell the two apart.
 *  - cachedModels() enforces the TTL itself (load-bearing — see its doc).
 */

/** The canonical host. Matching is by this substring, so `https://logfare.ai`,
 * `https://logfare.ai/` and any subdomain path all count as the same source. */
export const HOST = 'logfare.ai';
export const DEFAULT_BASE_URL = 'https://logfare.ai';

/** The endpoint that answers "what is up". `hours` only sets the uptime window. */
export const STATUS_PATH = '/v1/status';

/** The endpoint every entry must advertise to be offered as a chat model. */
export const CHAT_ENDPOINT = 'chat/completions';

/**
 * A fetched catalog older than this (seconds) is refetched rather than
 * trusted. Logfare's line-up changes on the order of weeks, but its *health*
 * changes by the hour, so this is short enough for the status column to mean
 * something.
 */
export const CACHE_TTL = 300.0;

/** One chat-capable entry from Logfare's status API. */
export class Model {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly uptime: number;
  readonly traffic: number;
  readonly successRate: number;

  constructor(init: {
    id: string;
    label?: string;
    status?: string;
    uptime?: number;
    traffic?: number;
    successRate?: number;
  }) {
    this.id = init.id;
    this.label = init.label ?? '';
    this.status = init.status ?? '';
    this.uptime = init.uptime ?? 0.0;
    this.traffic = init.traffic ?? 0;
    this.successRate = init.successRate ?? 0.0;
  }

  /** Whether Logfare calls this model operational. */
  get healthy(): boolean {
    return this.status === 'operational';
  }

  /** A one-line health note for the picker. */
  get blurb(): string {
    const bits: string[] = [];
    if (this.status) bits.push(this.status);
    if (this.uptime) bits.push(`${trimFloat(this.uptime)}% up`);
    if (this.traffic) bits.push(`${this.traffic.toLocaleString('en-US')} req/24h`);
    return bits.join(' · ');
  }
}

/** Python `%g`: six significant digits, trailing zeros stripped. */
function trimFloat(n: number): string {
  return String(parseFloat(n.toPrecision(6)));
}

// The last-fetched catalog, with the monotonic time it was fetched at. One
// entry: the status API is public, so unlike TokenHarbour's there is no key
// to partition it by.
let CACHE: { models: Model[]; at: number } | null = null;

function monotonic(): number {
  // performance.now() is the monotonic clock Node exposes; Date.now() can
  // jump with NTP and would make TTL checks lie.
  return performance.now() / 1000;
}

/**
 * The chat-capable entries, in the order the API returned them.
 *
 * A malformed entry is skipped rather than allowed to take the catalog down:
 * this runs inside a TUI command, and half a model list beats an exception.
 */
function parseModels(payload: unknown): Model[] {
  const out: Model[] = [];
  const data = isRecord(payload) && Array.isArray(payload['data']) ? payload['data'] : [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const mid = String(entry['model_id'] ?? '').trim();
    if (!mid) continue;
    const endpoints = entry['endpoints'];
    if (!Array.isArray(endpoints) || !endpoints.includes(CHAT_ENDPOINT)) continue;
    out.push(
      new Model({
        id: mid,
        label: String(entry['display_name'] ?? ''),
        status: String(entry['status'] ?? ''),
        uptime: toFloat(entry['uptime_percent']),
        traffic: toInt(entry['real_traffic_total']),
        successRate: toFloat(entry['real_traffic_success_rate']),
      }),
    );
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toFloat(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.0;
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export interface FetchOpts {
  /** Uptime window for the status report. */
  hours?: number;
  /** Seconds. */
  timeout?: number;
  useCache?: boolean;
}

/** Fetch Logfare's chat catalog. Returns [models, error]. */
export async function fetchModels(
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const { hours = 24, timeout = 20.0, useCache = true } = opts;

  if (useCache && CACHE && monotonic() - CACHE.at < CACHE_TTL) {
    return [CACHE.models, ''];
  }

  const url = `${DEFAULT_BASE_URL}${STATUS_PATH}?hours=${Math.trunc(hours)}`;
  let payload: unknown;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);
    try {
      const resp = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!resp.ok) {
        return [null, `HTTP ${resp.status} from ${HOST}`];
      }
      payload = JSON.parse(await resp.text());
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return [null, `could not reach ${HOST}: ${String(e)}`];
  }

  const models = parseModels(payload);
  CACHE = { models, at: monotonic() };
  return [models, ''];
}

/** Every chat model id, catalog order preserved — what /model offers. */
export async function modelIds(opts: FetchOpts = {}): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(opts);
  if (models === null) return [null, err];
  return [models.map((m) => m.id), ''];
}

/**
 * Seconds since the cache was filled, or undefined if it never was.
 *
 * The age is what lets a caller say *how* stale a list is instead of only
 * whether one exists. It is deliberately not clamped to CACHE_TTL: an expired
 * catalog is exactly the case worth reporting, and a caller that cannot see
 * the real number cannot tell "fetched a minute ago" from "fetched when this
 * session started, hours ago".
 */
export function catalogAge(): number | undefined {
  return CACHE ? monotonic() - CACHE.at : undefined;
}

/**
 * The last-fetched catalog, if it is still fresh — else undefined.
 *
 * /model runs on the UI thread and must not block on a fetch, so it reads
 * whatever the last /logfare-models (or the startup warm-up) left behind.
 *
 * **Expiry is checked here, and that is load-bearing.** This used to return
 * the last catalog however old it was, while fetchModels refused to reuse
 * anything past CACHE_TTL — so a cache filled once at startup was served for
 * the rest of the session, and /model called it live. Logfare retires models
 * without notice; the whole reason the catalog is fetched rather than
 * declared is that it changes. An expired cache now reads as undefined, which
 * every caller already treats as "no catalog", so the fallback and the
 * honest "not fetched yet" wording both follow for free.
 */
export function cachedModels(): Model[] | null {
  if (!CACHE) return null;
  if (monotonic() - CACHE.at >= CACHE_TTL) return null;
  return [...CACHE.models];
}

/** The last-fetched ids, without touching the network. */
export function cachedIds(): string[] | null {
  const models = cachedModels();
  return models ? models.map((m) => m.id) : null;
}

/** Drop the cached catalog. Called when the endpoint changes. */
export function clearCache(): void {
  CACHE = null;
}

/** The catalog's entry for *model*, if the catalog knows it. */
export function healthFor(model: string): Model | undefined {
  return cachedModels()?.find((m) => m.id === model);
}

/** Whether an endpoint points at Logfare itself rather than a local proxy. */
export function isLogfare(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}
