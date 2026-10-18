// Vitest port of tests/test_openrouter.py — regression suite for the
// OpenRouter source (src/openrouter.ts).
//
// Contract: every fetch is served by a stubbed global fetch (no network);
// ANDY_HOME/ANDY_CLAUDE_SOURCE are pinned to a temp tree BEFORE the module is
// imported so its import-time PROFILE/CLAUDE_SOURCE constants land inside it.
// Cache TTL is exercised by faking performance.now (the TS port's stamps are
// performance.now ms, so advancing the fake clock past CACHE_TTL is the same
// thing as Python rewinding the cache stamp). Test names are the Python
// originals.
//
// Synthetic key fixtures are assembled at runtime (`'sk-' + …`), matching the
// Python original's values character for character without placing a
// token-shaped literal in the source.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Or = typeof import('../src/openrouter.js');
type Sources = typeof import('../src/sources.js');
type ConfigType = typeof import('../src/config.js');
type AgentType = typeof import('../src/agent.js');

let o: Or;
let sources: Sources;
let Config: ConfigType;
let Agent: AgentType;
let tmp: string;

// === synthetic credential fixtures (assembled, never a full literal) ===
const SK = 'sk-';
const KEY_PROFILE = SK + 'or-fromprofile000000000000';
const KEY_OWN = SK + 'or-ownprofile0000000';
const KEY_ENV = SK + 'or-fromenv000000000000';
const KEY_SAVED = SK + 'or-saved00000000000000000';
const KEY_SECRET = SK + 'or-secret0000000000000';
const KEY_CAP = SK + 'or-key000000000000000000';
const KEY_BAD = SK + 'or-bad000000000000000000';
const KEY_APPLY = SK + 'or-x00000000000000000';
const KEY_X = SK + 'or-x0000000000000000';
const KEY_V1 = SK + 'or-v1-' + '0'.repeat(32);

// Shaped like the real response: an OpenAI-style `data` list, prices as
// STRINGS, `supported_parameters` carrying "tools", `name` as a display label.
// Ported verbatim; the free set covers all four cases that matter.
const CATALOG = {
  data: [
    { id: 'deepseek/deepseek-v4.1:free', name: 'DeepSeek V4.1 (free)',
      context_length: 163840,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools', 'temperature', 'top_p'] },
    { id: 'qwen/qwen4-72b:free', name: 'Qwen4 72B (free)',
      context_length: 32768,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'] },
    { id: 'meta/llama-5-70b:free', name: 'Llama 5 70B (free)',
      context_length: 131072,
      pricing: { prompt: '0.0000001', completion: '0' },
      supported_parameters: ['tools'] },
    { id: 'z-ai/glm-6-air', name: 'GLM 6 Air',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['tools'] },
    { id: 'nvidia/nemotron-3.5-content-safety:free',
      name: 'Nemotron Content Safety (free)',
      context_length: 128000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['temperature'] },
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5',
      context_length: 200000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      supported_parameters: ['tools', 'vision'] },
    { id: 'openai/gpt-5.2', name: 'GPT-5.2',
      context_length: 400000,
      pricing: { prompt: '0.00001', completion: '0.00003' },
      supported_parameters: ['tools'] },
  ],
} as unknown as Record<string, unknown>;

const FREE_SORTED = ['deepseek/deepseek-v4.1:free', 'meta/llama-5-70b:free',
  'nvidia/nemotron-3.5-content-safety:free', 'qwen/qwen4-72b:free',
  'z-ai/glm-6-air'];

const USABLE_SORTED = ['deepseek/deepseek-v4.1:free', 'meta/llama-5-70b:free',
  'qwen/qwen4-72b:free', 'z-ai/glm-6-air'];

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL'] as const;
let savedEnv: Record<string, string | undefined> = {};

/** Python's check(): a named assertion; the name is the failure message. */
function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name}  [${extra}]` : name).toBe(true);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' },
  });
}

interface Seen {
  url?: string;
  headers: Record<string, string>;
}

function captureFetch(payload: unknown = CATALOG): Seen {
  const seen: Seen = { headers: {} };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    const h = init?.headers ?? {};
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      seen.headers[k.toLowerCase()] = v;
    }
    return jsonResponse(payload);
  }));
  return seen;
}

function stubFetch(opts: { payload?: unknown; status?: number; error?: Error } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (opts.error) throw opts.error;
    if (opts.status !== undefined && opts.status !== 200) {
      return new Response('{"error":"boom"}', { status: opts.status });
    }
    return jsonResponse(opts.payload ?? CATALOG);
  }));
}

/** _parse_models is module-private in the TS port; the same parse runs by
 *  fetching the payload through a stub. */
async function parseCatalog(payload?: unknown): Promise<InstanceType<Or['Model']>[]> {
  o.clearCache();
  stubFetch(payload === undefined ? {} : { payload });
  const [models, err] = await o.fetchModels('', { useCache: false });
  expect(err, 'parse stub must succeed').toBe('');
  return models ?? [];
}

function cleanEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-or-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  process.env['ANDY_CLAUDE_SOURCE'] = path.join(tmp, 'claude-source');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  o = await import('../src/openrouter.js');
  sources = await import('../src/sources.js');
  Config = await import('../src/config.js');
  Agent = await import('../src/agent.js');
});

afterAll(() => {
  cleanEnv();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  o.clearCache();
});

describe('openrouter', () => {
  it('test_free_detection', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));
    check('catalog: every entry parsed', models.length === 7, String(models.length));

    check('catalog: a :free suffix is free',
      byId.get('deepseek/deepseek-v4.1:free')!.free);
    check('catalog: a second :free suffix is free',
      byId.get('qwen/qwen4-72b:free')!.free);

    // The suffix wins even when the listing carries a small non-zero price —
    // the model is named free, so it is free.
    check('catalog: the suffix beats a listed non-zero price',
      byId.get('meta/llama-5-70b:free')!.free);

    // And the price wins with no suffix at all: a model zeroed out without a
    // rename is still free.
    check('catalog: a zero price with no suffix is free',
      byId.get('z-ai/glm-6-air')!.free);

    check('catalog: a paid model is not free',
      !byId.get('anthropic/claude-opus-5.5')!.free);
    check('catalog: a second paid model is not free',
      !byId.get('openai/gpt-5.2')!.free);

    const free = models.filter((m) => m.free).map((m) => m.id).sort();
    check('catalog: exactly the five free ones',
      JSON.stringify(free) === JSON.stringify(FREE_SORTED), JSON.stringify(free));
  });

  it('test_prices_arrive_as_strings', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('pricing: a string "0" becomes 0.0',
      byId.get('qwen/qwen4-72b:free')!.priceIn === 0.0);
    check('pricing: a string price becomes a float',
      byId.get('anthropic/claude-opus-5.5')!.priceIn === 0.000015,
      String(byId.get('anthropic/claude-opus-5.5')!.priceIn));
    check('pricing: the output price is read too',
      byId.get('anthropic/claude-opus-5.5')!.priceOut === 0.000075);

    // An entry with no pricing block at all must not read as free.
    const unpriced = await parseCatalog({ data: [{ id: 'mystery-model' }] });
    check('pricing: an unpriced entry is not free', !unpriced[0]!.free);
    check('pricing: an unpriced entry reports no price',
      unpriced[0]!.priceIn === 0.0 && !unpriced[0]!.priced);

    // A malformed price must degrade rather than raise.
    const messy = await parseCatalog({ data: [
      { id: 'bad-price', pricing: { prompt: 'free!', completion: null } },
    ] });
    check('pricing: a malformed price degrades to 0.0',
      messy[0]!.priceIn === 0.0, String(messy[0]!.priceIn));
    check('pricing: a malformed entry with a pricing block is not free',
      !messy[0]!.free);
  });

  it('test_tool_support', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));
    check('tools: a tool-capable model reports it',
      byId.get('deepseek/deepseek-v4.1:free')!.tools);
    check('tools: a model without tools reports it',
      !byId.get('nvidia/nemotron-3.5-content-safety:free')!.tools);
    check('tools: the parameter list is preserved',
      byId.get('deepseek/deepseek-v4.1:free')!.supported.includes('temperature'));
    const bare = await parseCatalog({ data: [{ id: 'bare' }] });
    check('tools: a missing parameter list is empty, not an error',
      bare[0]!.supported.length === 0);

    stubFetch();
    const [usable, err] = await o.usableFreeModels('', { useCache: false });
    check('tools: usable_free_models keeps only the tool-capable free ones',
      usable !== null &&
      JSON.stringify(usable.map((m) => m.id).sort()) === JSON.stringify(USABLE_SORTED),
      JSON.stringify(usable?.map((m) => m.id)));
    check('tools: the no-tools free model is excluded, not merely ranked last',
      (usable ?? []).every((m) => m.tools));
    expect(err).toBe('');
  });

  it('test_catalog_needs_no_key', async () => {
    const seen = captureFetch();
    const [models, err] = await o.fetchModels('', { useCache: false });
    check('keyless: a fetch with no key succeeds',
      err === '' && models !== null && models.length === 7, err);
    check('keyless: hits the public models endpoint',
      seen.url === 'https://openrouter.ai/api/v1/models', seen.url);
    check('keyless: sends NO credential',
      !('authorization' in seen.headers) && !('x-api-key' in seen.headers),
      JSON.stringify(Object.keys(seen.headers).sort()));
    check('keyless: the catalog is cached under the empty token',
      o.cachedIds() !== null && (o.cachedIds() ?? []).length === 7);

    stubFetch();
    const [free, errFree] = await o.usableFreeModels(); // again, no token
    check('keyless: the free list is available before setup',
      free !== null && free.length === 4, JSON.stringify(free?.map((m) => m.id)));
    expect(errFree).toBe('');
  });

  it('test_anthropic_version_header_is_not_sent', async () => {
    // Sending `anthropic-version` to /models mangles the catalog into the
    // Anthropic Models API shape — measured; see the Python original.
    const seen = captureFetch();
    await o.fetchModels(KEY_CAP, { useCache: false });
    check('header: no anthropic-version is sent to /models',
      !('anthropic-version' in seen.headers),
      JSON.stringify(Object.keys(seen.headers).sort()));
    check('header: a keyed fetch still sends its credential',
      seen.headers['authorization'] === `Bearer ${KEY_CAP}`);
  });

  it('test_fetch_is_total', async () => {
    stubFetch({ error: new TypeError('no route') });
    {
      const [models, err] = await o.fetchModels('', { useCache: false });
      check('fetch: a network failure returns None and a message',
        models === null && err.includes('could not reach'), err);
    }

    stubFetch({ status: 401 });
    {
      const [models, err] = await o.fetchModels(KEY_BAD, { useCache: false });
      check('fetch: a rejected key says so', models === null && err.includes('401'), err);
      check('fetch: the rejection names the setup command',
        err.includes('openrouter-api-setup'), err);
    }

    // An empty catalog is [] and NOT an error — the caller can tell them apart.
    stubFetch({ payload: { data: [] } });
    {
      const [models, err] = await o.fetchModels('', { useCache: false });
      check('fetch: an empty catalog is [], not an error',
        models !== null && models.length === 0 && err === '', `${String(models)} ${err}`);
    }
  });

  it('test_cache_expiry', async () => {
    check('expiry: a cold cache has no age', o.catalogAge() === undefined,
      String(o.catalogAge()));

    stubFetch();
    await o.fetchModels();
    check('expiry: a fresh catalog is served', o.cachedIds() !== null);
    check('expiry: its age is reported, and small',
      (o.catalogAge() ?? 999) < 5.0, String(o.catalogAge()));

    // Python rewound the cache stamp; the TS port stamps performance.now, so
    // the fake clock advancing past the TTL is the same thing.
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    vi.advanceTimersByTime(o.CACHE_TTL * 1000 + 60_000);
    check('expiry: an expired catalog reads as None',
      o.cachedModels() === null, String(o.cachedModels()));
    check('expiry: cached_ids agrees', o.cachedIds() === null);
    check('expiry: the real age is still reported, unclamped',
      (o.catalogAge() ?? 0) >= o.CACHE_TTL, String(o.catalogAge()));
    vi.useRealTimers();

    stubFetch();
    await o.fetchModels();
    check('expiry: refetching restores it', o.cachedIds() !== null);
    o.clearCache();
  });

  it('test_cache_is_keyed_by_token', async () => {
    stubFetch();
    await o.fetchModels(); // keyless
    check('cache: the keyless list is cached', o.cachedIds() !== null);

    const calls = { n: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.n += 1;
      return jsonResponse({ data: [] });
    }));

    await o.fetchModels(KEY_CAP);
    check('cache: a keyed fetch does not reuse the keyless list',
      calls.n === 1, String(calls.n));

    // But the keyless fetch IS reused, or /models would hit the network on
    // every keystroke.
    await o.fetchModels(KEY_CAP);
    check('cache: a repeat keyed fetch is served from cache',
      calls.n === 1, String(calls.n));
  });

  it('test_profile_roundtrip', () => {
    const p = o.saveKey(KEY_SAVED, 'deepseek/deepseek-v4.1:free');
    check('key: written where load_credentials looks', p === o.PROFILE);
    const mode = fs.statSync(p).mode & 0o777;
    check('key: the file is mode 600', mode === 0o600, mode.toString(8));
    const parentMode = fs.statSync(path.dirname(p)).mode & 0o777;
    check('key: the directory is mode 700', parentMode === 0o700, parentMode.toString(8));

    const creds = o.loadCredentials();
    check('key: the token round-trips', creds?.[0] === KEY_SAVED);
    check('key: the model round-trips',
      creds?.[1] === 'deepseek/deepseek-v4.1:free');
    const text = fs.readFileSync(p, 'utf-8');
    const baseUrl = /ANTHROPIC_BASE_URL="([^"]*)"/.exec(text)?.[1] ?? '';
    check('key: the endpoint is OpenRouter', o.isOpenrouter(baseUrl), baseUrl);
    check('key: the endpoint is the SDK prefix, not the API root',
      text.includes('ANTHROPIC_BASE_URL="https://openrouter.ai/api"'), text);
    check('key: the file is source-format',
      text.split('export ').length - 1 === 4, text);
    check('key: load_credentials agrees the token is there',
      (o.loadCredentials() ?? [''])[0] === KEY_SAVED);
    fs.rmSync(p, { force: true });
  });

  it('test_looks_like_key', () => {
    check('key: a real-looking key passes', o.looksLikeKey(KEY_V1));
    check('key: a short string is rejected', !o.looksLikeKey('abc'));
    check('key: a pasted export line is rejected',
      !o.looksLikeKey('export ANTHROPIC_AUTH_TOKEN="sk-or-xxxx"'));
    check('key: whitespace is rejected',
      !o.looksLikeKey(SK + 'or-' + 'a'.repeat(20) + ' bbbb'));
  });

  it('test_active_key_recognises_host', () => {
    check('sources: the OpenRouter host is the openrouter source',
      sources.activeKey('https://openrouter.ai/api') === 'openrouter');
    // Recognition is by host, so a profile written before the base URL was
    // corrected still resolves to this source.
    check('sources: a pre-fix /api/v1 profile still resolves here',
      sources.activeKey('https://openrouter.ai/api/v1') === 'openrouter');
    check('sources: the bare host too',
      sources.activeKey('https://openrouter.ai') === 'openrouter');
    check('sources: with a trailing slash too',
      sources.activeKey('https://openrouter.ai/') === 'openrouter');
    check('sources: it is a builtin, so it survives a restart',
      sources.BUILTIN_KEYS.has('openrouter'));
    check('sources: a local proxy is still itself',
      sources.activeKey('http://localhost:4001') === 'logfare');
    check('sources: an unrelated host is unknown',
      sources.activeKey('https://api.example.com') === undefined);

    // The two gateways must not be confused for each other.
    check('sources: openrouter is not tokenharbour',
      sources.activeKey('https://openrouter.ai/api/v1') !== 'tokenharbour');
    check('sources: tokenharbour is not openrouter',
      sources.activeKey('https://tokenharbor.ai') !== 'openrouter');
  });

  it('test_credential_precedence', async () => {
    const claudeSource = process.env['ANDY_CLAUDE_SOURCE']!;
    fs.mkdirSync(claudeSource, { recursive: true });
    fs.writeFileSync(path.join(claudeSource, 'openrouter'),
      `export ANTHROPIC_BASE_URL="https://openrouter.ai/api"\n` +
      `export ANTHROPIC_AUTH_TOKEN="${KEY_PROFILE}"\n` +
      'export ANTHROPIC_MODEL="deepseek/deepseek-v4.1:free"\n' +
      'export ANTHROPIC_API_KEY=""\n', 'utf-8');

    cleanEnv();
    // The own profile stays absent for the first half (Python patched it to a
    // nonexistent path; the temp ANDY_HOME starts exactly that way).
    fs.rmSync(o.PROFILE, { force: true });

    let creds = o.loadCredentials();
    check('creds: falls back to ~/claude-source',
      creds !== null && creds[2].endsWith('openrouter'), String(creds?.[2]));
    check('creds: the model comes from that profile',
      creds !== null && creds[1] === 'deepseek/deepseek-v4.1:free');

    const own = path.join(tmp, 'own', 'source');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, `export ANTHROPIC_AUTH_TOKEN="${KEY_OWN}"\n`, 'utf-8');
    // Python patched o.PROFILE to `own`; the TS PROFILE is an import-time
    // const, so the same isolation comes from a fresh module view pinned to a
    // home whose openrouter/source IS `own`.
    const envHome = process.env['ANDY_HOME'];
    process.env['ANDY_HOME'] = path.join(tmp, 'own-home');
    fs.mkdirSync(path.join(tmp, 'own-home', 'openrouter'), { recursive: true });
    fs.copyFileSync(own, path.join(tmp, 'own-home', 'openrouter', 'source'));
    const oOwn = await freshOpenrouter();
    creds = oOwn.loadCredentials();
    check('creds: the own profile beats ~/claude-source',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    process.env['ANTHROPIC_BASE_URL'] = oOwn.DEFAULT_BASE_URL;
    process.env['ANTHROPIC_AUTH_TOKEN'] = KEY_ENV;
    process.env['ANTHROPIC_MODEL'] = 'qwen/qwen4-72b:free';
    creds = oOwn.loadCredentials();
    check('creds: the environment beats every file',
      creds !== null && creds[2] === 'environment' && creds[0] === KEY_ENV,
      String(creds?.[2]));

    // An env key pointed at ANOTHER host must not be mistaken for ours.
    process.env['ANTHROPIC_BASE_URL'] = 'https://elsewhere.example.com';
    creds = oOwn.loadCredentials();
    check('creds: an env key for another host is ignored',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    // And a TokenHarbour endpoint must not be read as an OpenRouter one.
    process.env['ANTHROPIC_BASE_URL'] = 'https://tokenharbor.ai';
    creds = oOwn.loadCredentials();
    check('creds: a TokenHarbour endpoint is not OpenRouter',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    process.env['ANDY_HOME'] = envHome;
    cleanEnv();
  });

  it('test_apply_and_guard', () => {
    const mk = (): { baseUrl: string; authToken: string; apiKey: string; model: string } => ({
      baseUrl: 'http://localhost:4001',
      authToken: 'leftover-from-logfare',
      apiKey: 'sk-leftover',
      model: 'deepseek-v4.1-flash',
    });

    // Python mocked load_credentials; the TS port keeps it live, so the key is
    // placed in the (temp) own profile — same surface the mock stood in for.
    const saved = o.saveKey(KEY_APPLY, 'qwen/qwen4-72b:free');
    expect(saved).toBe(o.PROFILE);
    const cfg = mk();
    const applied = o.applyTo(cfg);
    check('apply: returns the origin and model',
      JSON.stringify(applied) === JSON.stringify([o.PROFILE, 'qwen/qwen4-72b:free']),
      String(applied));
    check('apply: the endpoint is OpenRouter', cfg.baseUrl === o.DEFAULT_BASE_URL);
    check('apply: the token is set', cfg.authToken.startsWith(SK + 'or-'));
    check('apply: the stale api_key is cleared', cfg.apiKey === '');
    check('apply: the model is applied', cfg.model === 'qwen/qwen4-72b:free');

    fs.rmSync(o.PROFILE, { force: true });
    // The precedence test leaves a claude-source profile behind; Python mocked
    // load_credentials to None here, and the live equivalent needs BOTH
    // credential sources actually empty.
    fs.rmSync(path.join(process.env['ANDY_CLAUDE_SOURCE']!, 'openrouter'), { force: true });
    cleanEnv();
    const cfg2 = mk();
    check('apply: no key leaves the config alone',
      o.applyTo(cfg2) === null && cfg2.baseUrl === 'http://localhost:4001');

    check('guard: the default local proxy is overridable',
      o.appliesToDefaultEndpoint('http://localhost:4001'));
    check('guard: an empty endpoint is overridable', o.appliesToDefaultEndpoint(''));
    check('guard: OpenRouter itself is NOT overridden',
      !o.appliesToDefaultEndpoint(o.DEFAULT_BASE_URL));
    check('guard: another host is NOT overridden',
      !o.appliesToDefaultEndpoint('https://api.example.com'));
  });

  it('test_selection_file_is_shared', async () => {
    await o.setCurrent('openrouter');
    check('selection: sources.py sees the openrouter choice',
      sources.currentKey() === 'openrouter', String(sources.currentKey()));
    check('selection: openrouter sees it too', (await o.currentKey()) === 'openrouter');
  });

  it('test_no_key_is_echoed', async () => {
    const own = path.join(tmp, 'own2', 'source');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, `export ANTHROPIC_AUTH_TOKEN="${KEY_SECRET}"\n`, 'utf-8');
    // Read it through a module view pinned to that home (Python patched
    // o.PROFILE; the import-time const needs the fresh-import route).
    const envHome = process.env['ANDY_HOME'];
    process.env['ANDY_HOME'] = path.join(tmp, 'own2-home');
    fs.mkdirSync(path.join(tmp, 'own2-home', 'openrouter'), { recursive: true });
    fs.copyFileSync(own, path.join(tmp, 'own2-home', 'openrouter', 'source'));
    const oOwn = await freshOpenrouter();
    const creds = oOwn.loadCredentials();
    process.env['ANDY_HOME'] = envHome;
    const origin = creds?.[2] ?? '';
    check('display: the origin is a path, not a key', !origin.includes('sk-'), origin);
  });

  it('test_the_composed_message_url_is_right', async () => {
    // The URL the SDK actually builds — not the constant it is built from.
    // The TS SDK's buildRequest takes `path` (not `url`) and is async.
    const cfg = Config.Config.fromEnv({ baseUrl: o.DEFAULT_BASE_URL, authToken: KEY_X });
    const agent = new Agent.Agent(cfg);
    type Opts = Parameters<import('@anthropic-ai/sdk').Anthropic['buildRequest']>[0];
    const opts = { method: 'post', path: '/v1/messages', body: {}, headers: {} } as Opts;
    const composed = String((await agent.client.buildRequest(opts)).url);

    check('url: the message request lands on /api/v1/messages',
      composed === 'https://openrouter.ai/api/v1/messages', composed);
    check('url: there is no doubled /v1 in the path',
      !composed.includes('/v1/v1/'), composed);
    check('url: the base is the prefix BEFORE /v1, not the API root',
      o.DEFAULT_BASE_URL === 'https://openrouter.ai/api', o.DEFAULT_BASE_URL);

    // The catalog must still resolve, and to the same place it always did.
    const seen = captureFetch();
    await o.fetchModels(undefined, { useCache: false });
    check('url: the catalog still lands on /api/v1/models',
      seen.url === 'https://openrouter.ai/api/v1/models', seen.url);
  });
});

/** Re-import openrouter against the CURRENT ANDY_HOME. The Python original
 *  patched o.PROFILE / o.CLAUDE_SOURCE mid-test; the TS port froze those as
 *  import-time consts, so the same isolation is a module-registry reset plus
 *  a fresh dynamic import — the exact manoeuvre Python's main() used to pin
 *  ANDY_HOME before the first import. */
async function freshOpenrouter(): Promise<Or> {
  vi.resetModules();
  return await import('../src/openrouter.js');
}
