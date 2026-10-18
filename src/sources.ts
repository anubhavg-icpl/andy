/**
 * sources.ts — upstream "sources": the endpoints Andy can talk through.
 * (port of zimzilla/sources.py)
 *
 * What this module is: the switchboard over every place ANTHROPIC_BASE_URL
 * can point. Two local LiteLLM proxies front two different upstreams —
 *
 *     logfare      :4001  →  logfare.ai        (the default, shipped with the repo)
 *     tokenjuice   :4000  →  api.tokenjuice.ai (deepseek-claude's endpoint)
 *
 * — and five hosted/local gateways (tokenharbour, openrouter, unorouter,
 * antseed, aihubmix) are identified by host rather than port. They go down
 * independently, so the point of this module is to make switching between
 * them a one-liner and to have the choice survive a restart
 * (`~/.andy/current-source`).
 *
 * Invariants:
 *  - Nothing here echoes a key. Credentials live in each source's profile
 *    file, mode 600, exactly as before.
 *  - The catalog accessors (modelsFor / contextWindowFor / catalogFor /
 *    catalogModels) NEVER touch the network: they read whatever the last
 *    explicit fetch left in a provider's cache. /model runs on the UI thread
 *    and must not block; a cold cache reads as undefined and the caller
 *    falls back to the declared list — which is why the per-source
 *    *-models commands exist to warm it.
 *  - The five gateway modules are imported STATICALLY here (their own
 *    back-references to this module are lazy), which is what keeps the
 *    catalog accessors synchronous like their Python originals.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as aihubmix from './aihubmix.js';
import * as antseed from './antseed.js';
import * as logfare from './logfare.js';
import * as openrouter from './openrouter.js';
import * as tokenharbour from './tokenharbour.js';
import * as unorouter from './unorouter.js';
import { andyHome } from './shared.js';

// Python read ZIMZILLA_HOME at import; andyHome() reads ANDY_HOME at call
// time — observably identical (the env never mutates mid-process) and honest
// under tests that set ANDY_HOME.
const DEFAULT_HOME = homedir();

// The checkout root the service managers are started from. Python used
// Path(__file__).parent.parent (the package dir's parent); module-URL depth
// is the same here, with an argv[1] fallback for bundled layouts where this
// file gets inlined into dist/cli.js.
function defaultRoot(): string {
  const fromModule = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (fs.existsSync(path.join(fromModule, 'packaging'))) return fromModule;
  if (process.argv[1]) {
    const fromArgv = path.dirname(path.dirname(path.resolve(process.argv[1])));
    if (fs.existsSync(path.join(fromArgv, 'packaging'))) return fromArgv;
  }
  return fromModule;
}
const DEFAULT_ROOT = defaultRoot();

/** One upstream: where to reach it, how to start it, what to call the model. */
export class Source {
  /** "logfare" | "tokenjuice" */
  readonly key: string;
  /** Human name, for the transcript. */
  readonly label: string;
  readonly port: number;
  /** Shell profile to source (holds the key; mode 600). */
  readonly profile: string;
  /** start-litellm.sh-compatible manager. */
  readonly service: string;
  /** The litellm yaml. */
  readonly config: string;
  /** Default model name for this upstream. */
  readonly model: string;
  /** Checkout the service manager is started from. */
  readonly root: string;
  /** Declared fallback list; the live one is fetched. */
  readonly models: readonly string[];

  constructor(init: {
    key: string;
    label: string;
    port: number;
    profile: string;
    service: string;
    config: string;
    model: string;
    root: string;
    models?: readonly string[];
  }) {
    this.key = init.key;
    this.label = init.label;
    this.port = init.port;
    this.profile = init.profile;
    this.service = init.service;
    this.config = init.config;
    this.model = init.model;
    this.root = init.root;
    this.models = init.models ?? [];
  }

  get baseUrl(): string {
    return `http://localhost:${this.port}`;
  }
}

// The *fallback* list for each upstream — what to show when the live catalog
// has not been fetched (no network, or /model opened before the startup warm-up
// finished). The real list comes from the upstream's own status API; see
// modelsFor().
//
// This is a snapshot, so it rots: it was fourteen models, ten of which Logfare
// retired upstream, and /model kept offering them long after every request for
// them 404'd. Treat it as a starting point that /logfare-models corrects, not
// as the truth. Anything not in the live catalog returns "Model not found"
// (404) at request time.
//
// Logfare's catalog also lists image/TTS/STT models (flux-*, sdxl-lightning,
// whisper-large-v3-turbo, aura-2-en, nova-3, phoenix-1.0, lucid-origin); they
// reject chat completions, so they are omitted here.
//
// Token Juice is deliberately a single entry: its whole catalog is one model,
// exposed upstream as `deepseek-ai/DeepSeek-V4.1-Flash` and aliased to
// `deepseek-v4.1-flash` by its litellm config. It publishes no status API, so
// this list is all there is for it.
export const LOGFARE_MODELS: readonly string[] = [
  'deepseek-v4.1-flash',
  'gemma-4-26b',
  'logfare/auto',
  'qwen-3.8-27b',
];

export const TOKENJUICE_MODELS: readonly string[] = ['deepseek-v4.1-flash'];

export const MODELS_BY_KEY: Record<string, readonly string[]> = {
  logfare: LOGFARE_MODELS,
  tokenjuice: TOKENJUICE_MODELS,
};

/** The catalog-entry slice contextWindowFor reads off any provider's Model. */
interface CatalogEntry {
  id: string;
  contextLength?: number | null;
}

/** The cached-catalog slice sources consumes from each gateway module. */
interface GatewayCache {
  cachedIds(): string[] | null;
  cachedModels(): unknown[] | null;
}

/**
 * The active source's live catalog, or undefined if it has none.
 *
 * Only Logfare publishes one with health. Returned as the source module's own
 * Model objects so the caller can read health without knowing where it came
 * from. Never fetches: this is the cache, and a cold cache is undefined —
 * /model runs on the UI thread and must not block on the network.
 */
export function catalogFor(baseUrl: string): logfare.Model[] | undefined {
  if (activeKey(baseUrl) !== 'logfare') return undefined;
  return logfare.cachedModels() ?? undefined;
}

/**
 * The model list for whichever source this endpoint points at.
 *
 * Undefined means "not a known source" — the caller should fall back to the
 * default registry rather than showing an empty list.
 *
 * Logfare's, TokenHarbour's and OpenRouter's lists are fetched, not declared,
 * so they come from a catalog cache rather than MODELS_BY_KEY. A cold cache
 * yields undefined, and the caller falls back to the declared list — which is
 * why the per-source *-models commands exist to warm it.
 */
export function modelsFor(baseUrl: string): string[] | undefined {
  const key = activeKey(baseUrl);
  if (key === undefined) return undefined;
  const gateway: Record<string, GatewayCache | undefined> = {
    logfare,
    tokenharbour,
    openrouter,
    unorouter,
    antseed,
    aihubmix,
  };
  const cached = gateway[key]?.cachedIds();
  if (cached) return cached;
  // Declared fallback lists are typed readonly (they are module constants);
  // copy so the live/fallback return types stay identical for callers.
  const declared = MODELS_BY_KEY[key];
  return declared ? [...declared] : undefined;
}

/**
 * The cached catalog of *key*, as that source module's own Model list.
 *
 * Undefined for a source with no catalog (Logfare's is health-only and
 * carries no window) or a cold cache. Kept as a small dispatch rather than a
 * dict of importers so the modules stay separately imported — sources is
 * imported by their callers, and a merged module graph would make them
 * import each other.
 */
export function catalogModels(key: string): unknown[] | undefined {
  const gateway: Record<string, GatewayCache | undefined> = {
    tokenharbour,
    openrouter,
    unorouter,
    antseed,
    aihubmix,
  };
  return gateway[key]?.cachedModels() ?? undefined;
}

/**
 * The active model's real context window, from its source's live catalog.
 *
 * Undefined when nothing knows — an unknown source, a cold cache, or a
 * catalog that simply does not publish a window (Logfare's status API has no
 * such field). The caller falls back to Config.contextWindow, so an undefined
 * here is not a failure: it means "use the default".
 *
 * Read from the cache and never fetched, for the same reason catalogFor never
 * fetches: this is called on the turn path, and a blocking network read there
 * would stall the very loop it is measuring.
 *
 * The field is spelled contextLength in every TS module that has one (the
 * Python modules' `context_length`), but it is read by name off whatever the
 * module's own Model exposes rather than by importing five dataclasses to
 * unify them — that keeps each source's parsing where it already lives.
 */
export function contextWindowFor(baseUrl: string, model: string): number | undefined {
  const key = activeKey(baseUrl);
  if (key === undefined) return undefined;
  const cached = catalogModels(key);
  if (!cached) return undefined;
  for (const entry of cached as CatalogEntry[]) {
    if (entry.id !== model) continue;
    const window = entry.contextLength;
    if (typeof window === 'number' && window > 0) return window;
    return undefined;
  }
  return undefined;
}

function first(paths: (string | undefined)[]): string | undefined {
  for (const p of paths) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return undefined;
}

function serviceCandidates(key: string): string[] {
  if (key === 'logfare') {
    return [
      path.join(andyHome(), 'logfare', 'start-litellm.sh'),
      path.join(DEFAULT_ROOT, 'packaging', 'logfare', 'start-litellm.sh'),
    ];
  }
  return [
    path.join(andyHome(), 'tokenjuice', 'start-litellm.sh'),
    path.join(DEFAULT_HOME, 'start-litellm.sh'),
  ];
}

function configCandidates(key: string): string[] {
  if (key === 'logfare') {
    return [
      path.join(andyHome(), 'logfare', 'litellm-config.yaml'),
      path.join(DEFAULT_ROOT, 'packaging', 'logfare', 'litellm-config.yaml'),
    ];
  }
  return [
    path.join(andyHome(), 'tokenjuice', 'litellm-config.yaml'),
    path.join(DEFAULT_HOME, 'litellm-config.yaml'),
  ];
}

function profileCandidates(key: string): string[] {
  if (key === 'logfare') {
    return [
      path.join(andyHome(), 'logfare', 'source'),
      path.join(DEFAULT_ROOT, 'packaging', 'logfare', 'source'),
    ];
  }
  return [
    path.join(andyHome(), 'tokenjuice', 'source'),
    path.join(DEFAULT_HOME, 'claude-source', 'deepseek-claude'),
  ];
}

function build(key: string, label: string, port: number, model: string): Source | undefined {
  const profile = first(profileCandidates(key));
  const service = first(serviceCandidates(key));
  const config = first(configCandidates(key));
  if (profile === undefined || service === undefined || config === undefined) {
    return undefined;
  }
  return new Source({
    key,
    label,
    port,
    profile,
    service,
    config,
    model,
    root: DEFAULT_ROOT,
    models: MODELS_BY_KEY[key] ?? [],
  });
}

/** Every source whose profile, service and config are actually present. */
export function discover(): Record<string, Source> {
  const found: Record<string, Source> = {};
  const logfareSrc = build('logfare', 'Logfare', 4001, 'deepseek-v4.1-flash');
  if (logfareSrc) found['logfare'] = logfareSrc;
  const tokenjuice = build('tokenjuice', 'Token Juice', 4000, 'deepseek-v4.1-flash');
  if (tokenjuice) found['tokenjuice'] = tokenjuice;
  return found;
}

/** Which source key owns a given proxy port, if any. */
export function sourceForPort(port: number): string | undefined {
  for (const [key, src] of Object.entries(discover())) {
    if (src.port === port) return key;
  }
  return undefined;
}

// === SECTION === current selection (persisted so a restart keeps the working source) ===

function stateFile(): string {
  return path.join(andyHome(), 'current-source');
}

/**
 * Sources that are always selectable, whether or not discover() finds them on
 * this machine. TokenHarbour, OpenRouter, UnoRouter and AIHubMix are remote:
 * they have no local profile, service or config to discover, so gating them
 * on discover() would silently discard the selection and drop a session back
 * onto Logfare at the next launch. AntSeed is local but equally
 * undiscoverable by discover(), which only knows the two LiteLLM proxies —
 * its buyer is started and stopped by the operator, so requiring it to be up
 * at selection time would lose the choice every time the proxy was down.
 */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set([
  'tokenharbour',
  'openrouter',
  'unorouter',
  'antseed',
  'aihubmix',
]);

/**
 * The source the user last selected, if it is still a valid one.
 *
 * A discovered source is valid while its files are present. A built-in one is
 * valid always — there is nothing on disk that could go missing.
 */
export function currentKey(): string | undefined {
  let key: string;
  try {
    key = fs.readFileSync(stateFile(), 'utf8').trim();
  } catch {
    return undefined;
  }
  if (BUILTIN_KEYS.has(key)) return key;
  return key in discover() ? key : undefined;
}

/** Record the selection. Never fatal — a read-only home must not break the TUI. */
export function setCurrent(key: string): void {
  try {
    fs.mkdirSync(andyHome(), { recursive: true });
    fs.writeFileSync(stateFile(), `${key}\n`, 'utf8');
  } catch {
    /* a read-only home must not break the TUI */
  }
}

/**
 * Best guess at which source the running session is pointed at.
 *
 * The local proxies are identified by their port. The hosted gateways are
 * remote, so they are identified by host instead — and checked first, because
 * a hosted URL has no port to match on and would otherwise fall through to
 * undefined. Each gateway exposes an is_<name> predicate, so the host string
 * lives in exactly one module rather than being spelled again here.
 */
export function activeKey(baseUrl: string | null | undefined): string | undefined {
  if (tokenharbour.isTokenharbour(baseUrl)) return 'tokenharbour';
  if (openrouter.isOpenrouter(baseUrl)) return 'openrouter';
  if (unorouter.isUnorouter(baseUrl)) return 'unorouter';
  if (aihubmix.isAihubmix(baseUrl)) return 'aihubmix';
  // Checked before the port match, and by port rather than by name: the buyer
  // hands out a plain http://localhost:8377 with no "antseed" in it, and the
  // regex below would otherwise find port 8377, miss it in sourceForPort()
  // (which only knows the two LiteLLM proxies) and return undefined.
  if (antseed.isAntseed(baseUrl)) return 'antseed';
  const m = /:(\d{2,5})(?:\/|$)/.exec(baseUrl ?? '');
  if (!m) return undefined;
  return sourceForPort(Number.parseInt(m[1]!, 10));
}

// === SECTION === profile / proxy ===

/**
 * Read the profile's exports without a shell, so nothing is echoed.
 *
 * Parses the `export VAR="value"` lines the profiles are written in. A
 * profile that uses anything more exotic than that is read by the launcher
 * anyway; this is only for the in-TUI switch.
 */
export function loadProfile(src: Source): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(src.profile, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('export ')) continue;
    const body = line.slice('export '.length);
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Whether the proxy on *port* answers its health endpoint.
 *
 * SYNC by contract (the TUI calls it from synchronous paths, like Python's
 * urllib), and Node has no synchronous HTTP — so the probe rides a
 * short-lived `node -e` child that exits 0 only on HTTP 200. It is a
 * 127.0.0.1-only liveness check, so the child's ~40ms startup is the
 * acceptable price of keeping the signature honest. Timeout is in seconds.
 */
export function proxyHealthy(port: number, timeout: number = 2.0): boolean {
  const script =
    'const t=setTimeout(()=>process.exit(1),Math.round(Number(process.argv[1])));' +
    `fetch('http://127.0.0.1:${port}/health/liveliness').then(r=>{clearTimeout(t);process.exit(r.status===200?0:1)},()=>process.exit(1));`;
  try {
    const proc = spawnSync(process.execPath, ['-e', script, String(timeout * 1000)], {
      timeout: timeout * 1000 + 1500, // child's own deadline + boot slack
    });
    return proc.status === 0;
  } catch {
    return false;
  }
}

/**
 * Start the source's proxy if it is not already answering. Blocking (async).
 * Timeout is in seconds.
 */
export async function startProxy(src: Source, timeout: number = 180.0): Promise<[boolean, string]> {
  if (proxyHealthy(src.port)) return [true, 'already running'];
  if (!(fs.existsSync(src.service) && fs.statSync(src.service).isFile())) {
    return [false, `no service manager at ${src.service}`];
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  env['ANDY_ROOT'] = env['ANDY_ROOT'] ?? src.root;
  env['LITELLM_ENV_FILE'] = src.profile;
  env['LITELLM_CONFIG'] = src.config;
  env['LITELLM_PORT'] = String(src.port);
  // Do not wrap this in flock. The launcher already serialises its own
  // cold-start, and wrapping here is how a leaked lock (LiteLLM inheriting
  // the launcher's lock fd) made /zim-tokenjuice hang until timeout while a
  // manual start of the same script finished in seconds. Two sources live on
  // different ports, so they can come up independently.
  const argv = [src.service, 'start'];

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolve) => {
      const proc = spawn(argv[0]!, argv.slice(1), { env });
      let stderr = '';
      let stdout = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), timeout * 1000);
      proc.stderr?.on('data', (d) => (stderr += String(d)));
      proc.stdout?.on('data', (d) => (stdout += String(d)));
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stderr: String(e), stdout: '' });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, stdout });
      });
    },
  );

  if (proxyHealthy(src.port)) return [true, 'started'];
  const detail = (result.stderr || result.stdout || '').trim().split('\n');
  const tail = detail.length > 0 ? detail[detail.length - 1]! : `exit ${result.code}`;
  return [false, tail];
}
