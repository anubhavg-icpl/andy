/**
 * anthropic-setup.ts — direct Anthropic API, as an Andy source.
 *
 * Contract: mirrors zai.ts exactly (same ProviderModule shape, same
 * `export VAR="value"` profile format, mode 600) so it slots into the
 * existing gateway machinery (/anthropic-api-setup, /andy-anthropic,
 * /anthropic-models, cmdGatewayKey, cmdAndyGateway, cmdModels) with no new
 * UI code. Unlike the other sources, Anthropic has no marketplace catalog to
 * fetch — the model list is the static KNOWN_MODELS roster already in
 * config.ts, so fetchModels/cachedModels serve that instead of a network
 * call. Nothing here echoes a key.
 */

import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { andyHome } from './shared.js';
import { KNOWN_MODELS } from './config.js';

// === SECTION === module constants ===

/** The real Anthropic Messages endpoint — never the local Logfare default. */
export const HOST = 'api.anthropic.com';
export const DEFAULT_BASE_URL = `https://${HOST}`;

/** Andy's own profile, written by `/anthropic-api-setup`. */
export const PROFILE = path.join(andyHome(), 'anthropic', 'source');

/** Anthropic has no per-provider catalog fetch, so nothing ever expires. */
export const CACHE_TTL = Infinity;

/** The slice of `sources` used to persist the selected upstream. */
interface SourcesSlice {
  setCurrent(key: string): void;
}

async function loadSourcesMod(): Promise<SourcesSlice> {
  return (await import('./sources.js')) as SourcesSlice;
}

/** Persist the selection. Never fatal on a read-only home. */
export async function setCurrent(key: string): Promise<void> {
  (await loadSourcesMod()).setCurrent(key);
}

/** Whether *baseUrl* is the direct Anthropic endpoint (not a hosted gateway
 * or a local proxy). */
export function isAnthropic(baseUrl: string | null | undefined): boolean {
  return (baseUrl ?? '').includes(HOST);
}

/** Uniform name for gateway code that does not need to know the provider. */
export const activeEndpoint = isAnthropic;

// === SECTION === credentials ===

/** Parse `export VAR="value"` lines without invoking a shell. Identical to
 * zai.ts's reader — kept local rather than shared because the two files are
 * each meant to stand alone as a single-source contract an operator can read
 * top to bottom. */
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
 * Resolve the Anthropic key: environment first (so an operator-set
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN always wins), then Andy's own
 * profile. Returns `[token, model, origin]`; the token itself is never
 * printed by callers.
 */
export function loadCredentials(): [string, string, string] | null {
  const envToken = process.env['ANTHROPIC_AUTH_TOKEN'] || process.env['ANTHROPIC_API_KEY'];
  if (envToken) return [envToken, process.env['ANTHROPIC_MODEL'] ?? '', 'environment'];

  const exports = readExports(PROFILE);
  const token = exports['ANTHROPIC_AUTH_TOKEN'] || exports['ANTHROPIC_API_KEY'];
  if (token) return [token, exports['ANTHROPIC_MODEL'] ?? '', PROFILE];
  return null;
}

export function hasKey(): boolean {
  return loadCredentials() !== null;
}

/**
 * Write the Anthropic key to a mode-600 profile. An absent model leaves the
 * harness default (config.ts's DEFAULT_MODEL) alone rather than forcing one.
 */
export function saveKey(token: string, model = ''): string {
  mkdirSync(path.dirname(PROFILE), { recursive: true });
  try {
    chmodSync(path.dirname(PROFILE), 0o700);
  } catch {
    /* read-only home: the TUI must survive */
  }
  const body =
    `export ANTHROPIC_BASE_URL="${DEFAULT_BASE_URL}"\n` +
    `export ANTHROPIC_API_KEY="${token}"\n` +
    'export ANTHROPIC_AUTH_TOKEN=""\n' +
    (model.trim() ? `export ANTHROPIC_MODEL="${model.trim()}"\n` : '');
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

/** Point *cfg* at direct Anthropic. Returns `[origin, model]`, or null
 * without a key. */
export function applyTo(cfg: GatewayConfig): [string, string] | null {
  const creds = loadCredentials();
  if (creds === null) return null;
  const [token, model, origin] = creds;
  cfg.baseUrl = DEFAULT_BASE_URL;
  cfg.apiKey = token;
  cfg.authToken = '';
  if (model) cfg.model = model;
  return [origin, model];
}

/** Whether a remembered Anthropic choice may replace this default endpoint —
 * same rule as every other hosted source: leave a deliberately-pointed
 * endpoint alone, only ever fill in the blank or the local default. */
export function appliesToDefaultEndpoint(baseUrl: string | null | undefined): boolean {
  const url = (baseUrl ?? '').trim();
  if (isAnthropic(url)) return false;
  if (!url) return true;
  return url.includes('localhost') || url.includes('127.0.0.1');
}

// === SECTION === "catalog" (static — no marketplace to fetch) ===

/** Minimal shape `fetchModels`/`cachedModels` return — matches
 * ui/app.tsx's CatalogModel without importing the UI module from here. */
export interface Model {
  id: string;
  blurb: string;
  free?: boolean;
}

function staticCatalog(): Model[] {
  return KNOWN_MODELS.map((id) => ({ id, blurb: 'Anthropic' }));
}

/** No network call — Anthropic's model list is the static KNOWN_MODELS
 * roster, so there is nothing to fail or go stale. */
export async function fetchModels(): Promise<[Model[] | null, string]> {
  return [staticCatalog(), ''];
}

export function cachedModels(): Model[] | null {
  return staticCatalog();
}

/** Always "fresh": there is no fetch to age. */
export function catalogAge(): number | null {
  return 0;
}

/** Nothing cached to clear — present only so this satisfies the same
 * ProviderModule contract every other source does. */
export function clearCache(): void {
  /* no-op: the catalog is static */
}

/** Loose validation: Anthropic decides validity; Andy catches obvious paste
 * errors — in particular, a key from another provider reaching this
 * endpoint and failing only at the first request. */
export function looksLikeKey(value: string): boolean {
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  if (/^(sk-or-|lfu_)/i.test(v)) return false;
  return /^[A-Za-z0-9._:\-]+$/.test(v);
}
