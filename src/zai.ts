/**
 * Z.ai — the GLM Coding Plan, as an Andy source.
 *
 * Contract: a hosted Anthropic-Messages endpoint at
 * https://api.z.ai/api/anthropic; operator-supplied Coding Plan API key in a
 * `source`-format profile at $ANDY_HOME/zai/source (mode 600); the model
 * registry is fetched from {base}/v1/models and cached CACHE_TTL seconds.
 * Network failures are returned as `[null, error]`, never thrown. Nothing here
 * echoes a key.
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
 * Existing Claude-style profiles Andy can reuse. Z.ai's own Claude Code guide
 * writes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, so an operator who set
 * that up once should not have to paste the credential again here.
 */
export const CLAUDE_SOURCE = envPath(
  'ANDY_CLAUDE_SOURCE',
  path.join(homedir(), 'claude-source'),
);

/**
 * The endpoint path, not merely the host. Z.ai serves several protocols on
 * api.z.ai; matching the full Anthropic path keeps the standard pay-per-token
 * API from being mistaken for the Coding Plan endpoint.
 */
export const HOST = 'api.z.ai/api/anthropic';

/**
 * The Anthropic SDK's base URL prefix. The SDK appends `/v1/messages`, giving
 * https://api.z.ai/api/anthropic/v1/messages — exactly the Messages route Z.ai
 * documents for Claude-compatible coding tools.
 */
export const DEFAULT_BASE_URL = `https://${HOST}`;

/** Andy's own profile, written by `/zai-api-setup`. */
export const PROFILE = path.join(andyHome(), 'zai', 'source');

/** The sensible first model: the flagship current GLM coding model. */
export const DEFAULT_MODEL = 'glm-5.3';

/** A fetched registry older than this is refetched rather than trusted. */
export const CACHE_TTL = 300.0;

/** Model metadata used until (and alongside) the live registry answers. */
export interface ModelSpec {
  readonly id: string;
  readonly label: string;
  readonly contextLength: number | null;
  readonly note: string;
}

/**
 * The declared Coding Plan registry.
 *
 * `glm-5.3-flash[1m]` is the documented opt-in spelling for the 1M context
 * window, not a separate upstream model. Legacy GLM names remain accepted by
 * Z.ai's routing but are deliberately not advertised: the live registry wins,
 * and the two current models are what a new subscription should start on.
 */
export const MODEL_REGISTRY: readonly ModelSpec[] = [
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    contextLength: 200_000,
    note: 'flagship coding model · max-effort reasoning',
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM-5.3 Flash',
    contextLength: 200_000,
    note: 'fast coding model · multimodal',
  },
  {
    id: 'glm-5.3-flash[1m]',
    label: 'GLM-5.3 Flash · 1M',
    contextLength: 1_000_000,
    note: 'opt-in 1M context window',
  },
];

/** The declared ids, in the order Andy offers them before a fetch. */
export const DECLARED_MODELS: readonly string[] = MODEL_REGISTRY.map((m) => m.id);

// === SECTION === registry entry ===

/** One Z.ai Coding Plan model. */
export class Model {
  readonly id: string;
  readonly label: string;
  readonly contextLength: number | null;
  readonly note: string;

  constructor(init: {
    id: string;
    label?: string;
    contextLength?: number | null;
    note?: string;
  }) {
    this.id = init.id;
    this.label = init.label ?? init.id;
    this.contextLength = init.contextLength ?? null;
    this.note = init.note ?? '';
  }

  /** Included in the subscription rather than metered per token. */
  get free(): boolean {
    return true;
  }

  get chat(): boolean {
    return true;
  }

  get tools(): boolean {
    return true;
  }

  /** The one-line description shown by `/zai-models` and `/model`. */
  get blurb(): string {
    const bits = ['Coding Plan'];
    if (this.contextLength) {
      bits.push(
        this.contextLength >= 1_000_000
          ? `${this.contextLength / 1_000_000}M ctx`
          : `${Math.floor(this.contextLength / 1000)}k ctx`,
      );
    }
    if (this.note) bits.push(this.note);
    return bits.join(' · ');
  }
}

function specFor(id: string): ModelSpec | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

// === SECTION === credentials ===

/** The slice of `sources` used to persist the selected upstream. */
interface SourcesSlice {
  currentKey(): string | undefined;
  setCurrent(key: string): void;
}

async function loadSources(): Promise<SourcesSlice> {
  return (await import('./sources.js')) as SourcesSlice;
}

/** The source selected at the last launch, if any. */
export async function currentKey(): Promise<string | undefined> {
  return (await loadSources()).currentKey();
}

/** Persist the selection. Never fatal on a read-only home. */
export async function setCurrent(key: string): Promise<void> {
  (await loadSources()).setCurrent(key);
}

/** Whether *baseUrl* is Z.ai's Anthropic-compatible Coding Plan endpoint. */
export function isZai(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}

/** Uniform name for gateway code that does not need to know the provider. */
export const activeEndpoint = isZai;

/** Parse `export VAR="value"` lines without invoking a shell. */
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

/** Reuse a Z.ai credential already written for Claude Code, if one exists. */
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
    if (!isZai(exports['ANTHROPIC_BASE_URL'])) continue;
    const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
    if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', file];
  }
  return null;
}

/**
 * Resolve the Coding Plan key: environment (when aimed at Z.ai), Andy's own
 * profile, then an existing Claude-style profile. Returns `[token, model,
 * origin]`; the token itself is never printed by callers.
 */
export function loadCredentials(): [string, string, string] | null {
  if (isZai(process.env['ANTHROPIC_BASE_URL'])) {
    const token =
      process.env['ANTHROPIC_AUTH_TOKEN'] || process.env['ANTHROPIC_API_KEY'] || '';
    if (token) return [token, process.env['ANTHROPIC_MODEL'] ?? '', 'environment'];
  }

  const exports = readExports(PROFILE);
  const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
  if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', PROFILE];
  return keyFromClaudeSource();
}

export function hasKey(): boolean {
  return loadCredentials() !== null;
}

/**
 * Write the Coding Plan key to a mode-600 profile. An absent model resolves to
 * GLM-5.3 so a first switch never carries a model id from another provider.
 */
export function saveKey(token: string, model = ''): string {
  mkdirSync(path.dirname(PROFILE), { recursive: true });
  try {
    chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    /* read-only home: the TUI must survive */
  }
  const modelId = model.trim() || DEFAULT_MODEL;
  const body =
    `export ANTHROPIC_BASE_URL="${DEFAULT_BASE_URL}"\n` +
    `export ANTHROPIC_AUTH_TOKEN="${token}"\n` +
    `export ANTHROPIC_MODEL="${modelId}"\n` +
    'export ANTHROPIC_API_KEY=""\n';
  const fd = openSync(PROFILE, 'w', 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(PROFILE, 0o600);
  } catch {
    /* best effort */
  }
  return PROFILE;
}

/** The mutable Config fields this source owns. */
export interface GatewayConfig {
  baseUrl: string;
  authToken: string;
  apiKey: string;
  model: string;
}

/** Point *cfg* at Z.ai. Returns `[origin, model]`, or null without a key. */
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

/** Whether a remembered Z.ai choice may replace this default endpoint. */
export function appliesToDefaultEndpoint(baseUrl: string | null | undefined): boolean {
  const url = (baseUrl ?? '').trim();
  if (isZai(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// === SECTION === live registry ===

const CACHE = new Map<string, { models: Model[]; at: number }>();

export interface FetchOpts {
  timeout?: number;
  useCache?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function modelFromId(id: string): Model {
  const spec = specFor(id);
  return new Model({
    id,
    label: spec?.label ?? id,
    contextLength: spec?.contextLength ?? null,
    note: spec?.note ?? '',
  });
}

function parseModels(payload: unknown): Model[] {
  const root = asRecord(payload);
  const data = root['data'] ?? root['models'];
  const entries = Array.isArray(data) ? data : [];
  const out: Model[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rec = asRecord(entry);
    const id = toStr(rec['id'] ?? rec['model_id'] ?? rec['name']).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(modelFromId(id));
  }

  // The 1M-context spelling is an option on the Flash model, not always a row
  // in the registry. If the base model is served, make the documented variant
  // discoverable without inventing any other models.
  if (seen.has('glm-5.3-flash') && !seen.has('glm-5.3-flash[1m]')) {
    const oneM = modelFromId('glm-5.3-flash[1m]');
    const at = out.findIndex((m) => m.id === 'glm-5.3-flash');
    out.splice(at < 0 ? out.length : at + 1, 0, oneM);
  }
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Fetch Z.ai's model registry. The key is required: unlike the public
 * marketplace catalogs, this listing belongs to the Coding Plan credential.
 * Failures are returned, never thrown.
 */
export async function fetchModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  const { timeout = 20.0, useCache = true } = opts;
  const key = (token ?? '').trim() || (loadCredentials()?.[0] ?? '');
  if (!key) return [null, 'no Z.ai key — set one with /zai-api-setup <key>'];
  if (useCache) {
    const hit = CACHE.get(key);
    if (hit && performance.now() - hit.at < CACHE_TTL * 1000) return [hit.models, ''];
  }

  const url = `${DEFAULT_BASE_URL}/v1/models`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } catch (e) {
    return [null, `could not reach ${HOST}: ${errText(e)}`];
  }
  if (resp.status === 401 || resp.status === 403) {
    return [null, 'key rejected (401/403) — check the Coding Plan API key'];
  }
  if (!resp.ok) return [null, `HTTP ${resp.status} from ${HOST}`];
  let payload: unknown;
  try {
    payload = JSON.parse(await resp.text());
  } catch (e) {
    return [null, `could not read the Z.ai registry: ${errText(e)}`];
  }
  const models = parseModels(payload);
  CACHE.set(key, { models, at: performance.now() });
  return [models, ''];
}

/** Included models — the semantic equivalent of a free list for this source. */
export async function freeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  return fetchModels(token, opts);
}

/** Every model here can drive a Messages coding session. */
export async function usableFreeModels(
  token = '',
  opts: FetchOpts = {},
): Promise<[Model[] | null, string]> {
  return fetchModels(token, opts);
}

/** Registry ids in registry order. */
export async function modelIds(
  token = '',
  opts: FetchOpts = {},
): Promise<[string[] | null, string]> {
  const [models, err] = await fetchModels(token, opts);
  if (models === null) return [null, err];
  return [models.map((m) => m.id), ''];
}

/** Seconds since the newest cache entry, or undefined. */
export function catalogAge(): number | undefined {
  if (CACHE.size === 0) return undefined;
  let newest = -Infinity;
  for (const entry of CACHE.values()) newest = Math.max(newest, entry.at);
  return (performance.now() - newest) / 1000;
}

/** The newest unexpired registry, without touching the network. */
export function cachedModels(): Model[] | null {
  let newest: { models: Model[]; at: number } | null = null;
  for (const entry of CACHE.values()) {
    if (newest === null || entry.at > newest.at) newest = entry;
  }
  if (newest === null || performance.now() - newest.at >= CACHE_TTL * 1000) return null;
  return [...newest.models];
}

/** Cached ids, or null on a cold/expired cache. */
export function cachedIds(): string[] | null {
  const models = cachedModels();
  return models === null ? null : models.map((m) => m.id);
}

/** Invalidate the registry after a key change. */
export function clearCache(): void {
  CACHE.clear();
}

/**
 * Subscription pricing is not a per-token rate. Returning 0/0 lets shared UI
 * avoid inventing a metered estimate; the model blurb names the real billing
 * basis — the Coding Plan subscription.
 */
export function priceFor(
  model: string,
  models: Model[] | null,
): [number, number] | null {
  if (!models) return null;
  return models.some((m) => m.id === model.trim()) ? [0.0, 0.0] : null;
}

/** Loose validation: Z.ai decides validity; Andy catches obvious paste errors. */
export function looksLikeKey(value: string): boolean {
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(v);
}
