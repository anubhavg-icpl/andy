// Vitest port of tests/test_aihubmix.py — regression suite for the AIHubMix
// source (src/aihubmix.ts).
//
// Contract: every fetch is served by a stubbed global fetch (no network);
// ANDY_HOME/ANDY_CLAUDE_SOURCE are pinned to a temp tree BEFORE the module is
// imported so its import-time PROFILE/CLAUDE_SOURCE constants land inside it
// (the TS equivalent of the Python main() re-pin). Cache TTL is exercised by
// faking performance.now — the TS port keeps its cache stamps in
// performance.now ms, so advancing the fake clock past CACHE_TTL is the same
// thing as Python rewinding the stamp. Test names are the Python originals.
//
// Synthetic key fixtures are assembled at runtime (`'sk-' + …`), matching the
// Python original's values character for character without placing a
// token-shaped literal in the source.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Ah = typeof import('../src/aihubmix.js');
type Sources = typeof import('../src/sources.js');
type ConfigType = typeof import('../src/config.js');
type AgentType = typeof import('../src/agent.js');

let ah: Ah;
let sources: Sources;
let Config: ConfigType;
let Agent: AgentType;
let tmp: string;

// === synthetic credential fixtures (assembled, never a full literal) ===
const SK = 'sk-';
const KEY_LOGIN = SK + 'abcdef0123456789'; // keyed-catalog bearer check
const KEY_OTHER = SK + 'other-key-000000';
const KEY_OWN_PROFILE = SK + 'from-own-profile';
const KEY_CLAUDE_SOURCE = SK + 'from-claude-source';
const KEY_FOREIGN = SK + 'or-should-be-skipped';
const KEY_ENV_WRONG_HOST = SK + 'or-env-wrong-host';
const KEY_ENV = SK + 'from-environment';
const KEY_API_VAR = SK + 'from-api-key-var';
const KEY_APPLY = SK + 'apply-test-0123456789';
const KEY_TEST = SK + 'test-key-abcdefghijklmnop';
const KEY_X = SK + 'x0000000000000000'; // composed-URL config token
const SECRET = SK + 'SUPERSECRETVALUE0123456789abcdef';

// Shaped like the real response — see the Python original's comment block for
// the case-by-case legend. Ported verbatim so the assertions keep their
// meaning.
const CATALOG = {
  data: [
    { model_id: 'coding-glm-5.3-flash-free',
      model_name: 'Coding GLM 5.3 Flash (free)',
      types: 'llm', tool_call: true,
      features: 'thinking,tools,function_calling,structured_outputs',
      context_length: 1000000, max_output: 131072,
      pricing: { input: 0, output: 0 }, reasoning: true },

    // The one that matters: null tool_call, still drives tools.
    { model_id: 'qwen3.8-flash-free', model_name: 'Qwen3.8 Flash (free)',
      types: 'llm', tool_call: null,
      context_length: 262144, max_output: 65536,
      pricing: { input: 0, output: 0 }, reasoning: false },

    // No `tool_call` key at all — a third spelling of "unknown".
    { model_id: 'union-alpha-free', model_name: 'Union Alpha (free)',
      types: 'llm',
      context_length: 262144, max_output: 32768,
      pricing: { input: 0, output: 0 } },

    // Suffix says free; the price says 0.02. The price wins.
    { model_id: 'meta-llama/llama-3.1-8b-instruct:free',
      model_name: 'Llama 3.1 8B (free)',
      types: 'llm', tool_call: true,
      context_length: 131072,
      pricing: { input: 0.02, output: 0.02 } },

    { model_id: 'mistralai/mistral-7b-instruct-free',
      model_name: 'Mistral 7B (free)',
      types: 'llm', tool_call: true,
      context_length: 32768,
      pricing: { input: 0.02, output: 0.02 } },

    // Suffix with a price that could not be read — the fallback path.
    { model_id: 'some-vendor/mystery-model-free',
      model_name: 'Mystery (free)',
      types: 'llm', tool_call: true,
      context_length: 8192, pricing: null },

    // Free, but not a chat model: an OCR engine.
    { model_id: 'jina-ocr-v1-free', model_name: 'Jina OCR',
      types: 'ocr', tool_call: null,
      pricing: { input: 0, output: 0 } },

    // Free, priced 0/0, but speech-to-text.
    { model_id: 'gpt-live-transcribe', model_name: 'Live Transcribe',
      types: 'stt', tool_call: null,
      pricing: { input: 0, output: 0 } },

    // Free, priced 0/0, but a decision model.
    { model_id: 'decision-model-preview', model_name: 'Decision Preview',
      types: 'decision', tool_call: null,
      pricing: { input: 0, output: 0 } },

    // A free image model, and a combined type that DOES carry llm.
    { model_id: 'seedream-4-free', model_name: 'Seedream 4 (free)',
      types: 'image_generation', tool_call: null,
      pricing: { input: 0, output: 0 } },
    { model_id: 'search-and-chat-free', model_name: 'Search Chat (free)',
      types: 'llm,search', tool_call: true,
      context_length: 131072, pricing: { input: 0, output: 0 } },

    // Paid, chat-capable.
    { model_id: 'claude-opus-5', model_name: 'Claude Opus 5',
      types: 'llm', tool_call: true,
      context_length: 200000, max_output: 32000,
      pricing: { input: 15.0, output: 75.0 }, reasoning: true },
    { model_id: 'gpt-5.2', model_name: 'GPT 5.2',
      types: 'llm', tool_call: true,
      context_length: 400000,
      pricing: { input: 2.5, output: 10.0 } },

    // Malformed rows: skipped, not fatal.
    'not-a-row',
    { model_name: 'no id here', pricing: { input: 0, output: 0 } },
    { model_id: '   ', pricing: { input: 0, output: 0 } },
  ],
} as unknown as Record<string, unknown>;

/** The ids that are free AND chat-capable, in catalog order. */
const USABLE = ['coding-glm-5.3-flash-free', 'qwen3.8-flash-free', 'union-alpha-free',
  'some-vendor/mystery-model-free', 'search-and-chat-free'];

/** Every free id, in catalog order — including the four that are not chat
 *  models, which is exactly what makes them worth listing separately. */
const FREE = ['coding-glm-5.3-flash-free', 'qwen3.8-flash-free', 'union-alpha-free',
  'some-vendor/mystery-model-free', 'jina-ocr-v1-free',
  'gpt-live-transcribe', 'decision-model-preview', 'seedream-4-free',
  'search-and-chat-free'];

/** The whole well-formed catalog (3 malformed rows are skipped by the parser). */
const ROWS = 13;

const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] as const;
let savedEnv: Record<string, string | undefined> = {};

/** Python's check(): a named assertion; the name is the failure message. */
function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name}  [${extra}]` : name).toBe(true);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A stub urlopen: raise `error`, or serve `payload` / raw `text`. */
function stubFetch(opts: { payload?: unknown; text?: string; status?: number; error?: Error } = {}):
  ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (opts.error) throw opts.error;
    if (opts.text !== undefined) return new Response(opts.text, { status: opts.status ?? 200 });
    return jsonResponse(opts.payload ?? CATALOG, opts.status ?? 200);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

interface Seen {
  url?: string;
  method?: string;
  headers: Record<string, string>;
}

/** A stub that records the request, so the URL and headers can be asserted. */
function captureFetch(payload: unknown = CATALOG): { seen: Seen; fn: ReturnType<typeof vi.fn> } {
  const seen: Seen = { headers: {} };
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    const m = init?.method;
    seen.method = m === undefined || m === '' ? 'GET' : m;
    const h = init?.headers ?? {};
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      seen.headers[k.toLowerCase()] = v;
    }
    return jsonResponse(payload);
  });
  vi.stubGlobal('fetch', fn);
  return { seen, fn };
}

/** The TS port keeps _parse_models private (PORT-MAP rule); the same parse is
 *  reachable by fetching the payload through a stub, which is the parse the
 *  production path runs anyway. */
async function parseCatalog(payload?: unknown): Promise<InstanceType<Ah['Model']>[]> {
  ah.clearCache();
  stubFetch(payload === undefined ? {} : { payload });
  const [models, err] = await ah.fetchModels('', { useCache: false });
  expect(err, 'parse stub must succeed').toBe('');
  return models ?? [];
}

/** Hide any AIHubMix credential in the environment for the duration. */
function cleanEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  cleanEnv();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-ah-test-'));
  // Pin the module's paths to the temp tree BEFORE importing it — PROFILE and
  // CLAUDE_SOURCE are import-time constants.
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  process.env['ANDY_CLAUDE_SOURCE'] = path.join(tmp, 'claude-source');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  ah = await import('../src/aihubmix.js');
  sources = await import('../src/sources.js');
  Config = await import('../src/config.js');
  Agent = await import('../src/agent.js');
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ah.clearCache();
});

describe('aihubmix', () => {
  it('test_free_is_the_price_not_the_suffix', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('catalog: every well-formed row parsed', models.length === ROWS, String(models.length));
    check('catalog: a row with no model_id is skipped', !byId.has('no id here'));

    check('free: a zero-priced llm is free',
      byId.get('coding-glm-5.3-flash-free')!.free);
    check('free: a zero-priced llm with a null tool_call is free',
      byId.get('qwen3.8-flash-free')!.free);

    // The heart of it: the suffix says free and the price says 0.02.
    check('free: the suffix does NOT make a priced model free',
      !byId.get('meta-llama/llama-3.1-8b-instruct:free')!.free);
    check('free: nor does a -free suffix with a price',
      !byId.get('mistralai/mistral-7b-instruct-free')!.free);
    check('free: the suffix DOES stand in when no price could be read',
      byId.get('some-vendor/mystery-model-free')!.free);

    check('free: a paid llm is not free', !byId.get('claude-opus-5')!.free);
    check('free: a second paid llm is not free', !byId.get('gpt-5.2')!.free);

    const got = models.filter((m) => m.free).map((m) => m.id);
    check('free: exactly the free set, in catalog order',
      JSON.stringify(got) === JSON.stringify(FREE), `${got.length} vs ${FREE.length}`);
  });

  it('test_priced_flag_records_a_read_not_a_block', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('priced: a real 0/0 block counts as priced',
      byId.get('coding-glm-5.3-flash-free')!.priced);
    check('priced: a real paid block counts as priced',
      byId.get('claude-opus-5')!.priced);
    check('priced: a null pricing block does NOT count as priced',
      !byId.get('some-vendor/mystery-model-free')!.priced);

    const noPrice = await parseCatalog({ data: [{ model_id: 'unpriced/thing',
      types: 'llm', pricing: null }] });
    check('priced: an unpriced model with no suffix is not free',
      !noPrice[0]!.free);

    const junk = await parseCatalog({ data: [{ model_id: 'junk/thing', types: 'llm',
      pricing: { input: 'n/a', output: 'n/a' } }] });
    check('priced: an unparseable price is not treated as zero',
      !junk[0]!.free && !junk[0]!.priced);
  });

  it('test_types_is_the_chat_filter', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('chat: an llm is chat-capable', byId.get('coding-glm-5.3-flash-free')!.chat);
    check('chat: a combined llm,search type is chat-capable',
      byId.get('search-and-chat-free')!.chat);
    check('chat: an ocr model is not', !byId.get('jina-ocr-v1-free')!.chat);
    check('chat: an stt model is not', !byId.get('gpt-live-transcribe')!.chat);
    check('chat: a decision model is not', !byId.get('decision-model-preview')!.chat);
    check('chat: an image model is not', !byId.get('seedream-4-free')!.chat);
    check('chat: a paid llm is still chat-capable', byId.get('claude-opus-5')!.chat);
  });

  it('test_tool_call_is_not_a_filter', async () => {
    stubFetch();
    const [usable, err] = await ah.usableFreeModels();
    check('tools: the fetch succeeded', usable !== null, err);
    const ids = usable ? usable.map((m) => m.id) : [];
    check('tools: a null-tool_call model survives the free filter',
      ids.includes('qwen3.8-flash-free'));
    check('tools: a model with no tool_call key survives too',
      ids.includes('union-alpha-free'));
    check('tools: the usable set is exactly the free chat models',
      JSON.stringify(ids) === JSON.stringify(USABLE), JSON.stringify(ids));

    // The advisory flag is still readable, just not load-bearing.
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));
    check('tools: tool_call true reads as tools',
      byId.get('coding-glm-5.3-flash-free')!.tools);
    check('tools: a null tool_call reads as no claim',
      !byId.get('qwen3.8-flash-free')!.tools);
  });

  it('test_catalog_needs_no_key', async () => {
    const { seen } = captureFetch();
    cleanEnv();
    const [models, err] = await ah.fetchModels('');

    check('keyless: the fetch succeeded with no token', models !== null, err);
    check('keyless: no Authorization header is sent',
      !('authorization' in seen.headers), JSON.stringify(Object.keys(seen.headers).sort()));
    check('keyless: the catalog lands on /api/v1/models',
      seen.url === 'https://aihubmix.com/api/v1/models', seen.url);
    check('keyless: it is a GET', seen.method === 'GET', seen.method);

    // With a token the same call carries a Bearer, because the listing should
    // match what this account would be charged.
    const cap2 = captureFetch();
    const [, err2] = await ah.fetchModels(KEY_LOGIN);
    expect(err2).toBe('');
    check('keyed: the token is sent as a Bearer',
      cap2.seen.headers['authorization'] === `Bearer ${KEY_LOGIN}`,
      String(cap2.seen.headers['authorization']));
  });

  it('test_no_anthropic_version_header_on_the_catalog', async () => {
    const { seen } = captureFetch();
    await ah.fetchModels(undefined, { useCache: false });

    check('headers: no anthropic-version on the catalog',
      !('anthropic-version' in seen.headers), JSON.stringify(Object.keys(seen.headers).sort()));
    check('headers: no x-api-key on the catalog',
      !('x-api-key' in seen.headers), JSON.stringify(Object.keys(seen.headers).sort()));
  });

  it('test_fetch_is_total', async () => {
    const cases: Array<[string, number, string]> = [
      ['http 500', 500, '500'],
      ['http 401', 401, 'rejected'],
      ['http 403', 403, 'rejected'],
    ];
    for (const [name, status, want] of cases) {
      stubFetch({ status });
      const [models, err] = await ah.fetchModels('', { useCache: false });
      check(`total: ${name} returns (None, message)`,
        models === null && err.includes(want), `${String(models)} ${err}`);
    }
    for (const [name, error] of [
      ['url error', new TypeError('fetch failed')],
      ['os error', new Error('socket')],
    ] as const) {
      stubFetch({ error });
      const [models, msg] = await ah.fetchModels('', { useCache: false });
      check(`total: ${name} returns (None, message)`,
        models === null && msg.includes('could not reach'), `${String(models)} ${msg}`);
    }
    stubFetch({ text: 'nope' });
    {
      const [models, msg] = await ah.fetchModels('', { useCache: false });
      check('total: bad json returns (None, message)',
        models === null && msg.includes('could not reach'), `${String(models)} ${msg}`);
    }

    // A genuinely empty catalog is [] — distinguishable from a failure.
    stubFetch({ payload: { data: [] } });
    {
      const [models, err] = await ah.fetchModels('', { useCache: false });
      check('total: an empty catalog is [] with no error',
        models !== null && models.length === 0 && err === '', `${String(models)} ${err}`);
    }

    // A catalog that is not even an object must not crash the parse.
    stubFetch({ payload: { nope: 1 } });
    {
      const [models] = await ah.fetchModels('', { useCache: false });
      check('total: a payload with no data key yields []',
        models !== null && models.length === 0, String(models));
    }
  });

  it('test_cache_is_keyed_and_expires', async () => {
    const calls = { n: 0 };
    const fn = vi.fn(async () => {
      calls.n += 1;
      return jsonResponse(CATALOG);
    });
    vi.stubGlobal('fetch', fn);

    await ah.fetchModels('');
    await ah.fetchModels('');
    check('cache: the second identical call is served from cache',
      calls.n === 1, String(calls.n));
    // A different token is a different cache entry.
    await ah.fetchModels(KEY_OTHER);
    check('cache: a different token refetches', calls.n === 2, String(calls.n));
    // And an explicit bypass always goes out.
    await ah.fetchModels('', { useCache: false });
    check('cache: use_cache=False always refetches', calls.n === 3, String(calls.n));

    // TTL: an entry older than CACHE_TTL reads as cold. The TS port stamps in
    // performance.now ms, so the fake clock advancing IS the stamp aging.
    ah.clearCache();
    stubFetch();
    await ah.fetchModels('');
    check('cache: a fresh entry is readable', ah.cachedModels() !== null);
    check('cache: its age is a number', typeof ah.catalogAge() === 'number');
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    vi.advanceTimersByTime(ah.CACHE_TTL * 1000 + 1_000);
    check('cache: an expired entry reads as None', ah.cachedModels() === null);
    check('cache: an expired entry yields no ids', ah.cachedIds() === null);
    vi.useRealTimers();
    ah.clearCache();
    check('cache: clearing empties it', ah.cachedModels() === null);
    check('cache: and reports no age', ah.catalogAge() === undefined);
  });

  it('test_the_composed_message_url_is_right', async () => {
    // The URL the SDK actually builds — not the constant it is built from.
    // The TS SDK's buildRequest takes `path` (not `url`) and is async.
    const cfg = Config.Config.fromEnv({ baseUrl: ah.DEFAULT_BASE_URL, authToken: KEY_X });
    const agent = new Agent.Agent(cfg);
    type Opts = Parameters<import('@anthropic-ai/sdk').Anthropic['buildRequest']>[0];
    const opts = { method: 'post', path: '/v1/messages', body: {}, headers: {} } as Opts;
    const built = await agent.client.buildRequest(opts);
    const composed = String(built.url);

    check('url: the message request lands on /v1/messages',
      composed === 'https://aihubmix.com/v1/messages', composed);
    check('url: there is no doubled /v1 in the path',
      !composed.includes('/v1/v1/'), composed);
    check('url: the base is the prefix BEFORE /v1, not the API root',
      ah.DEFAULT_BASE_URL === 'https://aihubmix.com', ah.DEFAULT_BASE_URL);

    const { seen } = captureFetch();
    await ah.fetchModels(undefined, { useCache: false });
    check('url: the catalog lands on /api/v1/models, not /v1/models',
      seen.url === 'https://aihubmix.com/api/v1/models', seen.url);
  });

  it('test_profile_roundtrip', () => {
    const p = ah.saveKey(KEY_TEST, 'qwen3.8-flash-free');
    check('profile: written to the aihubmix profile', p === ah.PROFILE, String(p));
    const mode = fs.statSync(p).mode & 0o777;
    check('profile: mode is 600', mode === 0o600, mode.toString(8));
    check('profile: the directory is 700',
      (fs.statSync(path.dirname(p)).mode & 0o777) === 0o700,
      (fs.statSync(path.dirname(p)).mode & 0o777).toString(8));

    const creds = ah.loadCredentials();
    check('profile: the key round-trips', creds !== null && creds[0] === KEY_TEST);
    check('profile: the model round-trips',
      creds !== null && creds[1] === 'qwen3.8-flash-free');
    check('profile: the origin is the profile path', creds !== null && creds[2] === p);

    const text = fs.readFileSync(p, 'utf-8');
    check('profile: the base URL is the SDK prefix',
      text.includes('ANTHROPIC_BASE_URL="https://aihubmix.com"'), text);
    check('profile: api_key is cleared, not left to shadow auth_token',
      text.includes('ANTHROPIC_API_KEY=""'));
    check('profile: has_key agrees', ah.hasKey());
  });

  it('test_read_exports_is_total', () => {
    // The TS port keeps _read_exports private; the same parser is driven
    // through loadCredentials with ANTHROPIC_* spellings of each case.
    fs.rmSync(ah.PROFILE, { force: true });

    // Double quotes stripped; a bare value kept.
    fs.writeFileSync(ah.PROFILE,
      'export ANTHROPIC_AUTH_TOKEN="quoted"\n' +
      'export ANTHROPIC_MODEL=bare\n', 'utf-8');
    let creds = ah.loadCredentials();
    check('exports: double quotes stripped', creds?.[0] === 'quoted', String(creds?.[0]));
    check('exports: bare value kept', creds?.[1] === 'bare', String(creds?.[1]));

    // Single quotes stripped; a value may contain =.
    fs.writeFileSync(ah.PROFILE,
      "export ANTHROPIC_AUTH_TOKEN='single'\n" +
      'export ANTHROPIC_MODEL=with=equals\n', 'utf-8');
    creds = ah.loadCredentials();
    check('exports: single quotes stripped', creds?.[0] === 'single', String(creds?.[0]));
    check('exports: a value may contain =', creds?.[1] === 'with=equals', String(creds?.[1]));

    // A commented line is ignored; a bare assignment outside an export is
    // ignored; an empty value does not read as a credential.
    fs.writeFileSync(ah.PROFILE,
      '# export ANTHROPIC_AUTH_TOKEN=commented\n' +
      'ANTHROPIC_AUTH_TOKEN=no-export-prefix\n' +
      'export ANTHROPIC_API_KEY=\n' +
      'not a line at all\n', 'utf-8');
    creds = ah.loadCredentials();
    check('exports: a commented line is ignored', creds === null, String(creds));

    // A missing file is {} — observable as no credential at all.
    fs.rmSync(ah.PROFILE, { force: true });
    check('exports: a missing file is {}', ah.loadCredentials() === null);
  });

  it('test_credential_precedence', () => {
    fs.rmSync(ah.PROFILE, { force: true });
    cleanEnv();
    check('precedence: nothing anywhere is None', ah.loadCredentials() === null);
    check('precedence: has_key agrees', !ah.hasKey());

    // 3. A claude-source profile, with a foreign one that must be skipped.
    const cs = process.env['ANDY_CLAUDE_SOURCE']!;
    fs.mkdirSync(cs, { recursive: true });
    fs.writeFileSync(path.join(cs, 'other'),
      'export ANTHROPIC_BASE_URL="https://openrouter.ai/api"\n' +
      `export ANTHROPIC_AUTH_TOKEN="${KEY_FOREIGN}"\n`, 'utf-8');
    fs.writeFileSync(path.join(cs, 'aimix'),
      'export ANTHROPIC_BASE_URL="https://aihubmix.com"\n' +
      `export ANTHROPIC_AUTH_TOKEN="${KEY_CLAUDE_SOURCE}"\n` +
      'export ANTHROPIC_MODEL="qwen3.8-flash-free"\n', 'utf-8');
    let creds = ah.loadCredentials();
    check('precedence: a claude-source profile is found',
      creds !== null && creds[0] === KEY_CLAUDE_SOURCE, String(creds?.[2]));
    check('precedence: a profile for another host is skipped',
      creds !== null && creds[0] !== KEY_FOREIGN);

    // 2. Andy's own profile beats it.
    ah.saveKey(KEY_OWN_PROFILE, 'coding-glm-5.3-flash-free');
    creds = ah.loadCredentials();
    check('precedence: the own profile beats claude-source',
      creds !== null && creds[0] === KEY_OWN_PROFILE, String(creds?.[2]));

    // 1. The environment beats everything — but only when the base matches.
    process.env['ANTHROPIC_BASE_URL'] = 'https://openrouter.ai/api';
    process.env['ANTHROPIC_AUTH_TOKEN'] = KEY_ENV_WRONG_HOST;
    creds = ah.loadCredentials();
    check('precedence: an env token for another host is ignored',
      creds !== null && creds[0] === KEY_OWN_PROFILE, String(creds?.[2]));

    process.env['ANTHROPIC_BASE_URL'] = 'https://aihubmix.com';
    process.env['ANTHROPIC_AUTH_TOKEN'] = KEY_ENV;
    creds = ah.loadCredentials();
    check('precedence: the environment wins when the host matches',
      creds !== null && creds[0] === KEY_ENV, String(creds?.[2]));
    check('precedence: the origin says environment',
      creds !== null && creds[2] === 'environment');

    // ANTHROPIC_API_KEY is the fallback spelling.
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    process.env['ANTHROPIC_API_KEY'] = KEY_API_VAR;
    creds = ah.loadCredentials();
    check('precedence: ANTHROPIC_API_KEY is the fallback spelling',
      creds !== null && creds[0] === KEY_API_VAR, String(creds?.[0]?.slice(0, 6)));
  });

  it('test_no_key_is_echoed', async () => {
    ah.saveKey(SECRET, 'qwen3.8-flash-free');

    const creds = ah.loadCredentials();
    // load_credentials must return it (that is its job) — but the *origin* it
    // reports is a path, never the key, and that is what the TUI prints.
    check('echo: origin is a path, not the key',
      creds !== null && !creds[2].includes(SECRET), String(creds?.[2]));

    stubFetch();
    const [, err] = await ah.fetchModels(SECRET);
    check('echo: no error string carries the key', !(err || '').includes(SECRET));

    // The blurb and the label are rendered in the transcript; neither may leak.
    const models = await parseCatalog();
    for (const m of models) {
      check(`echo: blurb of ${m.id.slice(0, 18)} does not carry a key`,
        !m.blurb.includes('sk-'), m.blurb);
    }
    check('echo: price_for does not carry a key',
      !String(ah.priceFor('claude-opus-5', models)).includes(SECRET));

    fs.rmSync(ah.PROFILE, { force: true });
  });

  it('test_looks_like_key', () => {
    // A synthetic key in the real shape: 51 chars of hex behind an `sk-`. The
    // operator's actual key is never written into a test.
    check('key: a real-shaped key passes',
      ah.looksLikeKey(SK + '0123456789abcdef'.repeat(3) + '012'));
    check('key: a short string fails', !ah.looksLikeKey('sk-short'));
    check('key: an empty string fails', !ah.looksLikeKey(''));
    check('key: a whole export line fails',
      !ah.looksLikeKey('export ANTHROPIC_AUTH_TOKEN="sk-abcdefghijklmnopqrst"'));
    check('key: an embedded space fails',
      !ah.looksLikeKey('sk-abcdefghijklmno pqrstuvwxyz'));
    check('key: a newline fails',
      !ah.looksLikeKey('sk-abcdefghijklmnop\nqrstuvwxyz'));
    check('key: surrounding whitespace is tolerated',
      ah.looksLikeKey('  sk-abcdefghijklmnopqrst  '));
  });

  it('test_active_key_recognises_host', () => {
    check('host: the bare host matches', ah.isAihubmix('https://aihubmix.com'));
    check('host: a path under it matches', ah.isAihubmix('https://aihubmix.com/v1'));
    check('host: the SDK prefix matches', ah.isAihubmix(ah.DEFAULT_BASE_URL));
    check('host: another gateway does not', !ah.isAihubmix('https://openrouter.ai/api'));
    check('host: None does not', !ah.isAihubmix(null));
    check('host: empty does not', !ah.isAihubmix(''));
    check('host: active_endpoint is the same predicate',
      ah.activeEndpoint === ah.isAihubmix);

    check('host: sources.active_key finds it',
      sources.activeKey('https://aihubmix.com') === 'aihubmix');
    check('host: it is a builtin, so a selection survives a launch',
      sources.BUILTIN_KEYS.has('aihubmix'));
    check('host: the port path still works',
      sources.activeKey('http://localhost:4001') === 'logfare');
  });

  it('test_apply_and_guard', () => {
    // Earlier tests leave credentials behind — a key in Andy's own profile and
    // an AIHubMix profile under the claude-source. The first assertion here is
    // about having *none*, so both are cleared rather than inherited.
    fs.rmSync(ah.PROFILE, { force: true });
    const cs = process.env['ANDY_CLAUDE_SOURCE']!;
    fs.rmSync(cs, { recursive: true, force: true });
    fs.mkdirSync(cs, { recursive: true });
    cleanEnv();

    const mk = (): InstanceType<ConfigType['Config']> =>
      Config.Config.fromEnv({ workdir: tmp, baseUrl: 'http://localhost:4001',
        authToken: '', apiKey: 'stale-key' });

    let cfg = mk();
    cfg.model = 'old-model';
    check('apply: with no key it declines', ah.applyTo(cfg) === null);
    check('apply: and leaves the base alone',
      cfg.baseUrl === 'http://localhost:4001', cfg.baseUrl);

    ah.saveKey(KEY_APPLY, 'qwen3.8-flash-free');
    cfg = mk();
    cfg.model = 'old-model';
    const applied = ah.applyTo(cfg);
    check('apply: it reports the origin and model',
      JSON.stringify(applied) === JSON.stringify([ah.PROFILE, 'qwen3.8-flash-free']),
      String(applied));
    check('apply: the base is the SDK prefix',
      cfg.baseUrl === 'https://aihubmix.com', cfg.baseUrl);
    check('apply: the token is set', cfg.authToken === KEY_APPLY);
    // The stale key must go: the client sends both headers, and a key for
    // another provider sitting in memory is a credential for the wrong host.
    check('apply: a stale api_key is cleared', cfg.apiKey === '', String(cfg.apiKey));
    check('apply: the model is taken from the profile',
      cfg.model === 'qwen3.8-flash-free', cfg.model);

    // A profile with no model must not blank the model in use.
    ah.saveKey(KEY_APPLY, '');
    cfg = mk();
    cfg.model = 'keep-me';
    ah.applyTo(cfg);
    check('apply: an empty profile model leaves the current one',
      cfg.model === 'keep-me', cfg.model);

    check('guard: the default empty endpoint may be overridden',
      ah.appliesToDefaultEndpoint(''));
    check('guard: a local proxy may be overridden',
      ah.appliesToDefaultEndpoint('http://localhost:4001'));
    check('guard: 127.0.0.1 may be overridden',
      ah.appliesToDefaultEndpoint('http://127.0.0.1:4000'));
    check('guard: a deliberate remote host is left alone',
      !ah.appliesToDefaultEndpoint('https://openrouter.ai/api'));
    check('guard: itself is left alone',
      !ah.appliesToDefaultEndpoint('https://aihubmix.com'));
  });

  it('test_selection_file_is_shared', async () => {
    await ah.setCurrent('aihubmix');
    check('selection: written through sources', sources.currentKey() === 'aihubmix');
    check('selection: the module reads it back', (await ah.currentKey()) === 'aihubmix');

    sources.setCurrent('openrouter');
    check('selection: a switch elsewhere is seen here',
      (await ah.currentKey()) === 'openrouter');

    await ah.setCurrent('aihubmix');
    check('selection: and back again', sources.currentKey() === 'aihubmix');
  });

  it('test_free_and_id_helpers', async () => {
    stubFetch();
    const [free, err] = await ah.freeModels();
    check('views: free_models succeeds', free !== null, err);
    check('views: free_models includes non-chat models',
      JSON.stringify(free?.map((m) => m.id)) === JSON.stringify(FREE),
      JSON.stringify(free?.map((m) => m.id)));

    const [usable] = await ah.usableFreeModels();
    check('views: usable_free_models is the chat subset',
      JSON.stringify(usable?.map((m) => m.id)) === JSON.stringify(USABLE));

    const [ids, errIds] = await ah.modelIds();
    check('views: model_ids succeeds', ids !== null, errIds);
    check('views: model_ids includes paid and free chat models',
      ids !== null && ids.includes('claude-opus-5') && ids.includes('qwen3.8-flash-free'),
      String(ids?.length));
    check('views: model_ids excludes the ocr model', !ids?.includes('jina-ocr-v1-free'));
    // Nine, not five: model_ids is every chat model, free or not.
    check('views: model_ids is every chat model, free or not',
      ids?.length === 9, String(ids?.length));

    check('views: cached_ids matches, filtered to chat',
      JSON.stringify(ah.cachedIds()) === JSON.stringify(ids), JSON.stringify(ah.cachedIds()));
    check('views: cached_models is the full catalog',
      ah.cachedModels()?.length === ROWS, String(ah.cachedModels()?.length));

    const models = ah.cachedModels();
    check('views: price_for finds a paid model',
      JSON.stringify(ah.priceFor('claude-opus-5', models)) === JSON.stringify([15.0, 75.0]),
      String(ah.priceFor('claude-opus-5', models)));
    check('views: price_for finds a free model',
      JSON.stringify(ah.priceFor('qwen3.8-flash-free', models)) === JSON.stringify([0.0, 0.0]));
    check('views: price_for is None for an unknown model',
      ah.priceFor('nope/not-here', models) === null);
    check('views: price_for is None with no catalog',
      ah.priceFor('claude-opus-5', null) === null);
  });

  it('test_blurb_says_what_matters', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('blurb: a free model says free',
      byId.get('coding-glm-5.3-flash-free')!.blurb.includes('free'),
      byId.get('coding-glm-5.3-flash-free')!.blurb);
    check('blurb: a reasoning model says so',
      byId.get('coding-glm-5.3-flash-free')!.blurb.includes('reasoning'));
    check('blurb: the context window is shown',
      byId.get('coding-glm-5.3-flash-free')!.blurb.includes('1000k ctx'),
      byId.get('coding-glm-5.3-flash-free')!.blurb);
    check('blurb: a paid model shows its price',
      byId.get('claude-opus-5')!.blurb.includes('$15/$75'),
      byId.get('claude-opus-5')!.blurb);
    check('blurb: a non-llm type is surfaced',
      byId.get('jina-ocr-v1-free')!.blurb.includes('ocr'),
      byId.get('jina-ocr-v1-free')!.blurb);
    check('blurb: a plain llm does not repeat its type',
      !byId.get('union-alpha-free')!.blurb.includes('llm'),
      byId.get('union-alpha-free')!.blurb);
  });

  it('test_sources_registry_dispatch', async () => {
    stubFetch();
    check('registry: a cold cache is None',
      sources.modelsFor('https://aihubmix.com') === undefined);
    check('registry: and no catalog models either',
      sources.catalogModels('aihubmix') === undefined);

    await ah.fetchModels('');
    const ids = sources.modelsFor('https://aihubmix.com');
    check('registry: a warm cache gives the chat ids',
      ids !== undefined && ids.includes('qwen3.8-flash-free'), String(ids?.length));
    check('registry: the ids exclude non-chat models',
      ids !== undefined && !ids.includes('jina-ocr-v1-free'));
    check('registry: catalog_models returns the Model objects',
      (sources.catalogModels('aihubmix') ?? []).length === ROWS);
    check('registry: an unknown key is still None',
      sources.catalogModels('nope') === undefined);
    const win = sources.contextWindowFor('https://aihubmix.com', 'coding-glm-5.3-flash-free');
    check('registry: the context window is read from the catalog',
      win === 1000000, String(win));
    check('registry: an unknown model has no window',
      sources.contextWindowFor('https://aihubmix.com', 'nope') === undefined);
  });

  it('test_tui_surfaces', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const read = (p: string): string => fs.readFileSync(p, 'utf-8');
    const appSrc = read(path.join(root, 'src/ui/app.tsx'));
    const compSrc = read(path.join(root, 'src/ui/complete.tsx'));
    const modelCmdSrc = read(path.join(root, 'src/ui/screens/model-commands.tsx'));
    const cliSrc = read(path.join(root, 'src/cli.ts'));

    for (const cmd of ['andy-aihubmix', 'aihubmix-api-setup', 'aihubmix-models']) {
      check(`tui: /${cmd} is dispatched`, appSrc.includes(`'${cmd}':`));
      check(`tui: /${cmd} is in the busy-ok set`, appSrc.includes(`'${cmd}'`));
      check(`tui: /${cmd} is offered by completion`, compSrc.includes(`/${cmd}`));
    }

    check('tui: the gateway table knows aihubmix',
      modelCmdSrc.includes("if (kind === 'aihubmix') return [m.aihubmix, 'AIHubMix'];"));
    check('tui: the status pane lists it',
      modelCmdSrc.includes("['aihubmix', m.aihubmix, 'AIHubMix', '/aihubmix-api-setup'],"));
    check('tui: the model picker knows it',
      modelCmdSrc.includes('catalogClause(m.aihubmix.catalogAge(), m.aihubmix.CACHE_TTL)'));
    check('tui: /model refetches for it',
      modelCmdSrc.includes("else if (active === 'aihubmix') {"));
    // Python pinned the /models arg pool in complete.py; the pool lives in
    // app.tsx in the TS port (computeCompletions arg pools).
    const modelsPool = /'\/models': \[([^\]]*)\]/s.exec(appSrc)?.[1] ?? '';
    check('tui: /models accepts it', modelsPool.includes("'aihubmix'"), modelsPool);
    check('tui: the launcher restores it',
      cliSrc.includes("aihubmix: () => import('./aihubmix.js'),"));
    check('tui: the module is imported by the app',
      appSrc.includes("sibling<ProviderModule>('../aihubmix.js')"));
    check('tui: /models completion offers it', modelsPool.includes("'antseed'"));
    check('tui: it is a known source for the guard',
      modelCmdSrc.includes("'tokenharbour', 'openrouter', 'unorouter', 'antseed', 'logfare', 'aihubmix'"));
  });
});
