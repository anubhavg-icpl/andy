// Vitest port of tests/test_unorouter.py — regression suite for the UnoRouter
// source (src/unorouter.ts).
//
// Contract: every fetch is served by a stubbed global fetch (no network);
// ANDY_HOME/ANDY_CLAUDE_SOURCE are pinned to a temp tree BEFORE the module is
// imported so its import-time PROFILE/CLAUDE_SOURCE constants land inside it
// (the Python main() re-pin manoeuvre). Cache TTL is exercised by faking
// performance.now — the module's cache stamps are performance.now ms, so
// advancing the fake clock past CACHE_TTL is the same thing as Python rewinding
// the stamp. Test names are the Python originals.
//
// Private parseModels is reached by fetching a payload through a stub — the
// same parse the production path runs (PORT-MAP: leading-underscore helpers
// stay unexported).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type U = typeof import('../src/unorouter.js');
type Sources = typeof import('../src/sources.js');
type ConfigType = typeof import('../src/config.js');
type AgentType = typeof import('../src/agent.js');

let u: U;
let sources: Sources;
let Config: ConfigType;
let Agent: AgentType;
let tmp: string;

// === synthetic credential fixtures (assembled, never a full literal) ===
const SK = 'sk-';
const KEY_PROFILE = SK + 'fromprofile0000000000000';
const KEY_OWN = SK + 'ownprofile000000000000';
const KEY_ENV = SK + 'fromenv0000000000000';
const KEY_SAVED = SK + 'saved0000000000000000000';
const KEY_SECRET = SK + 'secret0000000000000000';
const KEY_CAP = SK + 'key000000000000000000000';
const KEY_BAD = SK + 'bad00000000000000000000';
const KEY_X = SK + 'x000000000000000000000';

/** metadata helper — the real payload carries it as a JSON-encoded STRING. */
function meta(kw: Record<string, unknown>): string {
  return JSON.stringify(kw);
}

// Shaped like the real payload: `data` a list keyed by model_name, `is_free` a
// real bool, metadata a JSON **string**. Ported verbatim; the set covers every
// case the filter has to separate (see the Python original's legend).
const CATALOG = {
  success: true,
  data: [
    { model_name: 'deepseek-v4.1-flash:free',
      description: 'DeepSeek V4.1 Flash (free)',
      is_free: true, online: true,
      enable_groups: ['a1-deepseek-v4.1-flash-free'],
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 262144, maxOutputTokens: 65536, isReasoning: false }) },
    { model_name: 'gemini-3.6-flash:free',
      description: 'Gemini 3.6 Flash (free)',
      is_free: true, online: true,
      enable_groups: ['a1-gemini-3.6-flash-free', 'a2-gemini-3.6-flash-free',
        'a3-gemini-3.6-flash-free', 'a4-gemini-3.6-flash-free',
        'a5-gemini-3.6-flash-free', 'a6-gemini-3.6-flash-free',
        'a7-gemini-3.6-flash-free', 'a8-gemini-3.6-flash-free',
        'a9-gemini-3.6-flash-free', 'b1-gemini-3.6-flash-free',
        'b2-gemini-3.6-flash-free', 'b3-gemini-3.6-flash-free'],
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 1048576, isReasoning: true }) },
    { model_name: 'gpt-oss-20b:free',
      description: 'GPT-OSS 20B (free)',
      is_free: true, online: true,
      enable_groups: ['c1-gpt-oss-20b-free', 'c2-gpt-oss-20b-free',
        'c3-gpt-oss-20b-free', 'c4-gpt-oss-20b-free',
        'c5-gpt-oss-20b-free', 'c6-gpt-oss-20b-free',
        'c7-gpt-oss-20b-free', 'c8-gpt-oss-20b-free',
        'c9-gpt-oss-20b-free', 'd1-gpt-oss-20b-free',
        'd2-gpt-oss-20b-free', 'd3-gpt-oss-20b-free',
        'd4-gpt-oss-20b-free', 'd5-gpt-oss-20b-free'],
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 131072 }) },
    { model_name: 'wai-nsfw-illustrious-sdxl:free',
      description: 'SDXL image generator',
      is_free: true, online: true,
      metadata: meta({ supportsTools: false, outputModalities: ['image'] }) },
    { model_name: 'jina-embeddings-v4:free',
      description: 'Embedding model',
      is_free: true, online: true,
      metadata: meta({ supportsTools: false, outputModalities: ['embedding'] }) },
    { model_name: 'whisper-large-v3:free',
      description: 'Whisper transcription',
      is_free: true, online: true,
      metadata: meta({ supportsTools: false, outputModalities: ['audio'] }) },
    { model_name: 'mistral-small:free',
      description: 'Mistral Small (free, no tools)',
      is_free: true, online: true,
      metadata: meta({ supportsTools: false, outputModalities: ['text'],
        contextWindow: 131072 }) },
    { model_name: 'qwen3.8-27b:free',
      description: 'Qwen 3.8 27B — zeroed out without a rename',
      is_free: false, online: true,
      enable_groups: ['e1-qwen3.8-27b-free', 'e2-qwen3.8-27b-free',
        'e3-qwen3.8-27b-free'],
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 262144 }) },
    { model_name: 'claude-opus-5',
      description: 'Claude Opus 5 (paid)',
      is_free: false, online: true,
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 200000, maxOutputTokens: 32000 }) },
    // Free, text, tool-capable, and deliberately NOT in PREFERRED_FREE_MODELS.
    { model_name: 'claude-haiku-5-5:free',
      description: 'Claude Haiku 5.5 (free)',
      is_free: true, online: true,
      metadata: meta({ supportsTools: true, outputModalities: ['text'],
        contextWindow: 1000000, isReasoning: true }) },
  ],
} as unknown as Record<string, unknown>;

/** The ids that survive usableFreeModels — free AND text AND tool-capable,
 *  sorted most-upstreams first (the sort is part of the assertion). */
const USABLE_FREE = ['gpt-oss-20b:free', 'gemini-3.6-flash:free',
  'qwen3.8-27b:free', 'deepseek-v4.1-flash:free', 'claude-haiku-5-5:free'];

/** Every text-output model id, catalog order — what /model should offer. */
const TEXT_IDS = ['deepseek-v4.1-flash:free', 'gemini-3.6-flash:free',
  'gpt-oss-20b:free', 'mistral-small:free', 'qwen3.8-27b:free',
  'claude-opus-5', 'claude-haiku-5-5:free'];

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

/** The TS port keeps parseModels private; the same parse is reachable by
 *  fetching the payload through a stub, which is the parse the production path
 *  runs anyway. */
async function parseCatalog(payload?: unknown): Promise<InstanceType<U['Model']>[]> {
  u.clearCache();
  stubFetch(payload === undefined ? {} : { payload });
  const [models, err] = await u.fetchModels('', { useCache: false });
  expect(err, 'parse stub must succeed').toBe('');
  return models ?? [];
}

/** Fake the monotonic clock forward by `secs` (cache stamps are ms). */
function advanceClock(secs: number): void {
  const real = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => real + secs * 1000);
}

function cleanEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  cleanEnv();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
}

/** Re-import unorouter against the CURRENT ANDY_HOME — the Python original
 *  patched u.PROFILE / u.CLAUDE_SOURCE mid-test; the TS port froze those as
 *  import-time consts, so the same isolation is a module-registry reset plus a
 *  fresh dynamic import. */
async function freshUnorouter(): Promise<U> {
  vi.resetModules();
  return await import('../src/unorouter.js');
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-uno-test-'));
  // Pin the module's paths to the temp tree BEFORE importing it — PROFILE and
  // CLAUDE_SOURCE are import-time constants.
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  process.env['ANDY_CLAUDE_SOURCE'] = path.join(tmp, 'claude-source');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  u = await import('../src/unorouter.js');
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
  vi.restoreAllMocks();
  u.clearCache();
});

describe('unorouter', () => {
  it('test_metadata_is_a_json_string', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));
    check('metadata: every entry parsed', models.length === 10, String(models.length));

    const ds = byId.get('deepseek-v4.1-flash:free')!;
    check('metadata: supportsTools is read from the decoded string', ds.tools);
    check('metadata: outputModalities is read from the decoded string',
      JSON.stringify(ds.modalities) === JSON.stringify(['text']), String(ds.modalities));
    check('metadata: contextWindow is read', ds.contextLength === 262144,
      String(ds.contextLength));
    check('metadata: maxOutputTokens is read', ds.maxOutput === 65536, String(ds.maxOutput));
    check('metadata: isReasoning is read', byId.get('gemini-3.6-flash:free')!.reasoning);
    check('metadata: isReasoning false is false', !ds.reasoning);
    check('metadata: a missing maxOutputTokens is None, not an error',
      byId.get('gemini-3.6-flash:free')!.maxOutput === null);

    // Tolerated shapes: none may raise, and all must read as "capabilities
    // unknown".
    for (const [label, value] of [
      ['a dict', { supportsTools: true, outputModalities: ['text'] }],
      ['None', null],
      ['a non-JSON string', 'not json at all'],
      ['a JSON string that is not an object', '"just a string"'],
      ['a number', 7],
      ['an empty string', ''],
    ] as [string, unknown][]) {
      let parsed: unknown = 'no result';
      let ok = true;
      try {
        parsed = await parseCatalog({ data: [{ model_name: 'x', metadata: value }] });
        ok = Array.isArray(parsed) && parsed.length === 1;
      } catch (e) {
        ok = false;
        parsed = String(e);
      }
      check(`metadata: ${label} does not raise`, ok, String(parsed));
    }

    const tolerant = await parseCatalog({ data: [
      { model_name: 'withdict',
        metadata: { supportsTools: true, outputModalities: ['text'] } },
      { model_name: 'withnone', metadata: null },
      { model_name: 'withjunk', metadata: '{{{' },
      { model_name: 'withnomd' },
      { model_name: 'withlist', metadata: '["text"]' },
    ] });
    const t = new Map(tolerant.map((m) => [m.id, m]));
    check('metadata: a dict already decoded is still read',
      t.get('withdict')!.tools && t.get('withdict')!.chat);
    check('metadata: None yields an unknown model, not an error',
      !t.get('withnone')!.tools && t.get('withnone')!.modalities.length === 0);
    check('metadata: junk yields an unknown model',
      !t.get('withjunk')!.tools && t.get('withjunk')!.modalities.length === 0);
    check('metadata: a missing key yields an unknown model',
      !t.get('withnomd')!.tools && t.get('withnomd')!.modalities.length === 0);
    check('metadata: a JSON list is not mistaken for a mapping',
      !t.get('withlist')!.tools && t.get('withlist')!.modalities.length === 0);

    // A malformed entry must not take the catalog down with it.
    const junk = await parseCatalog({ data: [
      null, 7, {}, { model_name: '' }, { model_name: 'good' },
    ] });
    check('metadata: junk entries are skipped, not fatal',
      JSON.stringify(junk.map((m) => m.id)) === JSON.stringify(['good']),
      String(junk.map((m) => m.id)));

    check('metadata: an entry with no name is dropped',
      (await parseCatalog({ data: [{ is_free: true }] })).length === 0);

    check('metadata: a junk `data` yields an empty catalog',
      (await parseCatalog({ data: 'nonsense' })).length === 0);
  });

  it('test_free_detection', async () => {
    const models = await parseCatalog();
    const byId = new Map(models.map((m) => [m.id, m]));

    check('catalog: is_free True is free', byId.get('deepseek-v4.1-flash:free')!.free);
    check('catalog: is_free False with a :free suffix is still free',
      byId.get('qwen3.8-27b:free')!.free);
    check('catalog: a :free suffix is free', byId.get('mistral-small:free')!.free);
    check('catalog: a paid model is not free', !byId.get('claude-opus-5')!.free);

    const free = models.filter((m) => m.free).map((m) => m.id).sort();
    check('catalog: exactly the nine free ones',
      JSON.stringify(free) === JSON.stringify([
        'claude-haiku-5-5:free', 'deepseek-v4.1-flash:free',
        'gemini-3.6-flash:free', 'gpt-oss-20b:free', 'jina-embeddings-v4:free',
        'mistral-small:free', 'qwen3.8-27b:free',
        'wai-nsfw-illustrious-sdxl:free', 'whisper-large-v3:free']), String(free));
    check('catalog: the paid model is the only non-free one',
      JSON.stringify(models.filter((m) => !m.free).map((m) => m.id)) ===
        JSON.stringify(['claude-opus-5']));
  });

  it('test_the_free_usable_filter', async () => {
    u.clearCache();
    stubFetch();
    const [usable, err] = await u.usableFreeModels('', { useCache: false });
    const ids = (usable ?? []).map((m) => m.id);
    check('filter: only the free, text, tool-capable models survive',
      JSON.stringify(ids) === JSON.stringify(USABLE_FREE), String(ids));
    check('filter: the free image model is excluded',
      !ids.includes('wai-nsfw-illustrious-sdxl:free'));
    check('filter: the free embedding model is excluded',
      !ids.includes('jina-embeddings-v4:free'));
    check('filter: the free audio model is excluded',
      !ids.includes('whisper-large-v3:free'));
    check('filter: a free text model without tools is excluded',
      !ids.includes('mistral-small:free'));
    check('filter: a paid model is excluded', !ids.includes('claude-opus-5'));
    check('filter: everything surviving is free and tool-capable',
      (usable ?? []).every((m) => m.free && m.tools && m.chat));
    check('filter: no error is reported on a good fetch', err === '', err);

    // The modality clause isolated: a PAID image model is excluded too, so the
    // exclusion is the modality rather than the price.
    const paidImage = await parseCatalog({ data: [
      { model_name: 'paid-image', is_free: false,
        metadata: meta({ supportsTools: true, outputModalities: ['image'] }) },
    ] });
    check('filter: the modality clause excludes a paid image model too',
      paidImage[0]!.tools && !paidImage[0]!.chat);

    // A model declaring several modalities is a chat model if text is one.
    const multi = await parseCatalog({ data: [
      { model_name: 'multimodal', is_free: true,
        metadata: meta({ supportsTools: true, outputModalities: ['text', 'image'] }) },
    ] });
    check('filter: text among several output modalities counts as chat',
      multi[0]!.chat);

    // A failed fetch is null and an error, NOT an empty list.
    u.clearCache();
    stubFetch({ error: new TypeError('fetch failed') });
    const [failed, ferr] = await u.usableFreeModels('', { useCache: false });
    check('filter: a failed fetch is None, not an empty list',
      failed === null && ferr !== '', String(failed) + ' ' + String(ferr));
  });

  it('test_model_ids_keep_paid_text_models', async () => {
    u.clearCache();
    stubFetch();
    const [ids, err] = await u.modelIds('', { useCache: false });
    check('ids: every text model is listed, in catalog order',
      JSON.stringify(ids) === JSON.stringify(TEXT_IDS), String(ids));
    check('ids: the paid model is present despite being paid',
      (ids ?? []).includes('claude-opus-5'));
    check('ids: the image model is dropped',
      !(ids ?? []).includes('wai-nsfw-illustrious-sdxl:free'));
    check('ids: the embedding model is dropped',
      !(ids ?? []).includes('jina-embeddings-v4:free'));
    check('ids: the audio model is dropped',
      !(ids ?? []).includes('whisper-large-v3:free'));
    expect(err).toBe('');

    // The cached accessor must agree with the fetched one.
    check('ids: cached_ids agrees with the fetched list',
      JSON.stringify(u.cachedIds()) === JSON.stringify(TEXT_IDS), String(u.cachedIds()));
  });

  it('test_catalog_needs_no_key', async () => {
    u.clearCache();
    const { seen } = captureFetch();
    const [models, err] = await u.fetchModels('', { useCache: false }); // no token at all
    check('keyless: a fetch with no key succeeds',
      err === '' && models !== null && models.length === 10, err);
    check('keyless: hits the public pricing endpoint',
      seen.url === 'https://api.unorouter.com/api/pricing', seen.url);
    check('keyless: sends NO credential',
      !('authorization' in seen.headers) && !('x-api-key' in seen.headers),
      String(Object.keys(seen.headers).sort()));
    check('keyless: the catalog is cached under the empty token',
      u.cachedIds() !== null);

    u.clearCache();
    stubFetch();
    const [free] = await u.usableFreeModels(); // again, no token
    check('keyless: the free list is available before setup',
      free !== null && JSON.stringify(free.map((m) => m.id)) === JSON.stringify(USABLE_FREE),
      String((free ?? []).map((m) => m.id)));
  });

  it('test_keyed_fetch_sends_the_credential', async () => {
    u.clearCache();
    const { seen } = captureFetch();
    await u.fetchModels(KEY_CAP, { useCache: false });
    check('keyed: the bearer token is sent',
      seen.headers['authorization'] === `Bearer ${KEY_CAP}`,
      String(Object.keys(seen.headers).sort()));
  });

  it('test_fetch_is_total', async () => {
    u.clearCache();
    stubFetch({ error: new TypeError('no route') });
    let [models, err] = await u.fetchModels('', { useCache: false });
    check('fetch: a network failure returns None and a message',
      models === null && err.includes('could not reach'), err);

    u.clearCache();
    stubFetch({ status: 401 });
    [models, err] = await u.fetchModels(KEY_BAD, { useCache: false });
    check('fetch: a rejected key says so', models === null && err.includes('401'), err);
    check('fetch: the rejection names the setup command',
      err.includes('unorouter-api-setup'), err);

    // A 500 is not a rejected key, and must not claim to be one.
    u.clearCache();
    stubFetch({ status: 500 });
    [models, err] = await u.fetchModels('', { useCache: false });
    check('fetch: a 500 is reported as HTTP 500, not a key problem',
      models === null && err.includes('500') && !err.includes('unorouter-api-setup'), err);

    // An empty catalog is [] and NOT an error.
    u.clearCache();
    stubFetch({ payload: { data: [] } });
    [models, err] = await u.fetchModels('', { useCache: false });
    check('fetch: an empty catalog is [], not an error',
      Array.isArray(models) && models.length === 0 && err === '', String(models) + err);

    // `data` arrives as a list today and as a mapping on some deployments.
    u.clearCache();
    const asDict = { data: Object.fromEntries(
      (CATALOG.data as Record<string, unknown>[]).map((m) => [m['model_name'], m])) };
    stubFetch({ payload: asDict });
    [models, err] = await u.fetchModels('', { useCache: false });
    check('fetch: a mapping-shaped `data` parses too',
      models !== null && models.length === 10, String(models?.length ?? null));

    // A body that is not JSON at all degrades rather than raising.
    u.clearCache();
    stubFetch({ text: '<html>gateway error</html>' });
    [models, err] = await u.fetchModels('', { useCache: false });
    check('fetch: a non-JSON body returns an error, not a traceback',
      models === null && err !== '', String(models) + err);
  });

  it('test_cache_is_keyed_by_token', async () => {
    u.clearCache();
    stubFetch();
    await u.fetchModels(); // keyless
    check('cache: the keyless list is cached', u.cachedIds() !== null);

    const counting = stubFetch({ payload: { data: [] } });
    await u.fetchModels(KEY_CAP);
    check('cache: a keyed fetch does not reuse the keyless list',
      counting.mock.calls.length === 1, String(counting.mock.calls.length));

    counting.mockClear();
    await u.fetchModels(KEY_CAP);
    check('cache: a repeat keyed fetch is served from cache',
      counting.mock.calls.length === 0, String(counting.mock.calls.length));

    // Both slots coexist: the keyless entry is still warm too.
    counting.mockClear();
    await u.fetchModels();
    check('cache: both slots are populated',
      counting.mock.calls.length === 0, String(counting.mock.calls.length));
  });

  it('test_cache_expiry', async () => {
    u.clearCache();
    check('expiry: a cold cache has no age', u.catalogAge() === undefined,
      String(u.catalogAge()));

    stubFetch();
    await u.fetchModels();
    check('expiry: a fresh catalog is served', u.cachedIds() !== null);
    check('expiry: its age is reported, and small',
      (u.catalogAge() ?? 999) < 5.0, String(u.catalogAge()));

    // Age it past the TTL by advancing the fake monotonic clock — the same
    // thing as Python rewinding the stamp.
    advanceClock(u.CACHE_TTL + 60);
    check('expiry: an expired catalog reads as None',
      u.cachedModels() === null, String(u.cachedModels()));
    check('expiry: cached_ids agrees', u.cachedIds() === null);
    check('expiry: the real age is still reported, unclamped',
      (u.catalogAge() ?? 0) >= u.CACHE_TTL, String(u.catalogAge()));

    vi.restoreAllMocks();
    stubFetch();
    await u.fetchModels();
    check('expiry: refetching restores it', u.cachedIds() !== null);
    u.clearCache();
    check('expiry: clear_cache empties it',
      u.cachedModels() === null && u.catalogAge() === undefined);
  });

  it('test_default_free_model', async () => {
    u.clearCache();
    stubFetch();
    let picked = await u.defaultFreeModel();
    check('default: the TOP preferred entry is chosen, not merely a preferred one',
      picked === u.PREFERRED_FREE_MODELS[0], String(picked));
    check('default: and that top entry is a free, usable model',
      (picked ?? '') !== '' && USABLE_FREE.includes(picked ?? ''), String(picked));

    // A preferred name that has since gone must fall through to the NEXT
    // preferred entry. The expected name is computed from the shortlist rather
    // than written as an index.
    u.clearCache();
    const without = { data: (CATALOG.data as Record<string, unknown>[]).filter(
      (m) => m['model_name'] !== u.PREFERRED_FREE_MODELS[0]) };
    const stillPresent = without.data.map((m) => String(m['model_name']));
    const expectedNext = u.PREFERRED_FREE_MODELS.slice(1).find((p) => stillPresent.includes(p));
    stubFetch({ payload: without });
    picked = await u.defaultFreeModel();
    check('default: a stale preferred name falls through to the next preferred',
      expectedNext !== undefined && picked === expectedNext, String(picked));

    // With no preferred name present at all, the catalog's own first usable
    // entry is used — claude-haiku is in the fixture for exactly this.
    u.clearCache();
    const nonePreferred = { data: (CATALOG.data as Record<string, unknown>[]).filter(
      (m) => !u.PREFERRED_FREE_MODELS.includes(String(m['model_name']))) };
    stubFetch({ payload: nonePreferred });
    picked = await u.defaultFreeModel();
    check('default: with no preferred entry, the first usable one is used',
      picked === 'claude-haiku-5-5:free', String(picked));

    // Nothing free at all leaves the caller's model alone.
    u.clearCache();
    const paidOnly = { data: (CATALOG.data as Record<string, unknown>[]).filter(
      (m) => m['model_name'] === 'claude-opus-5') };
    stubFetch({ payload: paidOnly });
    check('default: nothing free yields None',
      (await u.defaultFreeModel()) === undefined);

    // A failed fetch yields None too, not a crash.
    u.clearCache();
    stubFetch({ error: new TypeError('down') });
    check('default: an unreachable gateway yields None',
      (await u.defaultFreeModel()) === undefined);

    // The cache is read first — the common path touches no network.
    u.clearCache();
    const counting = stubFetch();
    await u.fetchModels();
    counting.mockClear();
    await u.defaultFreeModel();
    check('default: a warm cache means no fetch',
      counting.mock.calls.length === 0, String(counting.mock.calls.length));
  });

  it('test_profile_roundtrip', () => {
    const p = u.saveKey(KEY_SAVED, 'deepseek-v4.1-flash:free');
    check('key: written where load_credentials looks', p === u.PROFILE);
    const mode = fs.statSync(p).mode & 0o777;
    check('key: the file is mode 600', mode === 0o600, mode.toString(8));
    const parentMode = fs.statSync(path.dirname(p)).mode & 0o777;
    check('key: the directory is mode 700', parentMode === 0o700, parentMode.toString(8));

    // readExports is private; the same parse is what loadCredentials runs.
    const creds = u.loadCredentials();
    check('key: the token round-trips', creds !== null && creds[0] === KEY_SAVED);
    check('key: the model round-trips',
      creds !== null && creds[1] === 'deepseek-v4.1-flash:free');
    const text = fs.readFileSync(p, 'utf-8');
    const savedBase = /ANTHROPIC_BASE_URL="([^"]*)"/.exec(text)?.[1] ?? '';
    check('key: the endpoint is UnoRouter', u.isUnorouter(savedBase), savedBase);
    check('key: the endpoint is the SDK prefix, not the API root',
      savedBase === 'https://api.unorouter.com', savedBase);
    check('key: the file is source-format',
      text.split('export ').length - 1 === 4, text);
    check('key: load_credentials reads it back',
      (u.loadCredentials() ?? [''])[0] === KEY_SAVED);
    fs.rmSync(p, { force: true });
  });

  it('test_looks_like_key', () => {
    // A shape-only sample, not a live credential.
    check('key: a real-looking key passes', u.looksLikeKey(SK + '0'.repeat(48)));
    check('key: a short string is rejected', !u.looksLikeKey('abc'));
    check('key: a pasted export line is rejected',
      !u.looksLikeKey('export ANTHROPIC_AUTH_TOKEN="sk-xxxx"'));
    check('key: whitespace is rejected',
      !u.looksLikeKey(SK + 'a'.repeat(20) + ' bbbb'));
  });

  it('test_active_key_recognises_host', async () => {
    check('sources: the UnoRouter host is the unorouter source',
      sources.activeKey('https://api.unorouter.com') === 'unorouter');
    check('sources: the bare host too',
      sources.activeKey('https://unorouter.com') === 'unorouter');
    check('sources: with a trailing slash too',
      sources.activeKey('https://api.unorouter.com/') === 'unorouter');
    check('sources: it is a builtin, so it survives a restart',
      sources.BUILTIN_KEYS.has('unorouter'));
    check('sources: a local proxy is still itself',
      sources.activeKey('http://localhost:4001') === 'logfare');
    check('sources: an unrelated host is unknown',
      sources.activeKey('https://api.example.com') === undefined);

    // The gateways must not be confused for each other.
    check('sources: unorouter is not openrouter',
      sources.activeKey('https://api.unorouter.com') !== 'openrouter');
    check('sources: openrouter is not unorouter',
      sources.activeKey('https://openrouter.ai/api') !== 'unorouter');
    check('sources: unorouter is not tokenharbour',
      sources.activeKey('https://api.unorouter.com') !== 'tokenharbour');

    // The catalog is reachable through the generic accessor, and a cold cache
    // reports None rather than an empty list.
    u.clearCache();
    check('sources: models_for returns None on a cold cache',
      sources.modelsFor('https://api.unorouter.com') === undefined);
    stubFetch();
    await u.fetchModels();
    check('sources: models_for returns the cached text ids',
      JSON.stringify(sources.modelsFor('https://api.unorouter.com')) ===
        JSON.stringify(TEXT_IDS),
      String(sources.modelsFor('https://api.unorouter.com')));
    u.clearCache();
  });

  it('test_credential_precedence', async () => {
    const claudeSource = process.env['ANDY_CLAUDE_SOURCE']!;
    fs.mkdirSync(claudeSource, { recursive: true });
    fs.writeFileSync(path.join(claudeSource, 'unorouter'),
      `export ANTHROPIC_BASE_URL="https://api.unorouter.com"\n` +
      `export ANTHROPIC_AUTH_TOKEN="${KEY_PROFILE}"\n` +
      'export ANTHROPIC_MODEL="deepseek-v4.1-flash:free"\n' +
      'export ANTHROPIC_API_KEY=""\n', 'utf-8');

    cleanEnv();
    fs.rmSync(u.PROFILE, { force: true }); // the own profile stays absent

    let creds = u.loadCredentials();
    check('creds: falls back to ~/claude-source',
      creds !== null && creds[2].endsWith('unorouter'), String(creds?.[2]));
    check('creds: the model comes from that profile',
      creds !== null && creds[1] === 'deepseek-v4.1-flash:free');

    // Python patched u.PROFILE to `own`; the TS PROFILE is an import-time
    // const, so the same isolation is a fresh module pinned to a home whose
    // unorouter/source IS `own`.
    const envHome = process.env['ANDY_HOME'];
    process.env['ANDY_HOME'] = path.join(tmp, 'own-home');
    fs.mkdirSync(path.join(tmp, 'own-home', 'unorouter'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'own-home', 'unorouter', 'source'),
      `export ANTHROPIC_AUTH_TOKEN="${KEY_OWN}"\n`, 'utf-8');
    const uOwn = await freshUnorouter();
    creds = uOwn.loadCredentials();
    check('creds: Andy own profile beats ~/claude-source',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    process.env['ANTHROPIC_BASE_URL'] = uOwn.DEFAULT_BASE_URL;
    process.env['ANTHROPIC_AUTH_TOKEN'] = KEY_ENV;
    process.env['ANTHROPIC_MODEL'] = 'gemini-3.6-flash:free';
    creds = uOwn.loadCredentials();
    check('creds: the environment beats every file',
      creds !== null && creds[2] === 'environment' && creds[0] === KEY_ENV,
      String(creds?.[2]));

    process.env['ANTHROPIC_BASE_URL'] = 'https://elsewhere.example.com';
    creds = uOwn.loadCredentials();
    check('creds: an env key for another host is ignored',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    process.env['ANTHROPIC_BASE_URL'] = 'https://openrouter.ai/api';
    creds = uOwn.loadCredentials();
    check('creds: an OpenRouter endpoint is not UnoRouter',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    // A profile with a token but no base URL must not be claimed.
    delete process.env['ANTHROPIC_BASE_URL'];
    creds = uOwn.loadCredentials();
    check('creds: no env base URL means the env is not consulted',
      creds !== null && creds[0] === KEY_OWN, String(creds?.[2]));

    process.env['ANDY_HOME'] = envHome!;
    cleanEnv();
  });

  it('test_apply_and_guard', async () => {
    const mk = (): { baseUrl: string; authToken: string; apiKey: string; model: string } => ({
      baseUrl: 'http://localhost:4001',
      authToken: 'leftover-from-logfare',
      apiKey: 'sk-leftover',
      model: 'deepseek-v4.1-flash',
    });

    u.saveKey(KEY_X, 'gemini-3.6-flash:free');
    let cfg = mk();
    const applied = u.applyTo(cfg);
    check('apply: returns the origin and model',
      JSON.stringify(applied) === JSON.stringify([u.PROFILE, 'gemini-3.6-flash:free']),
      String(applied));
    check('apply: the endpoint is UnoRouter', cfg.baseUrl === u.DEFAULT_BASE_URL);
    check('apply: the token is set', cfg.authToken.startsWith(SK));
    check('apply: the stale api_key is cleared', cfg.apiKey === '');
    check('apply: the model is applied', cfg.model === 'gemini-3.6-flash:free');

    // With no model named, a FREE one is chosen rather than leaving the
    // previous source's name in place. The TS port resolves a cold cache in
    // the background; a warm cache makes the choice synchronous, which is the
    // behaviour the Python mock pinned.
    u.saveKey(KEY_X, '');
    u.clearCache();
    stubFetch();
    await u.fetchModels(); // warm the cache
    cfg = mk();
    u.applyTo(cfg);
    check('apply: an unnamed model lands on a free one',
      cfg.model === 'gemini-3.6-flash:free', cfg.model);

    // And when nothing free exists, the previous model is left alone.
    u.clearCache();
    const paidOnly = { data: (CATALOG.data as Record<string, unknown>[]).filter(
      (m) => m['model_name'] === 'claude-opus-5') };
    stubFetch({ payload: paidOnly });
    await u.fetchModels();
    cfg = mk();
    u.applyTo(cfg);
    check('apply: nothing free leaves the previous model in place',
      cfg.model === 'deepseek-v4.1-flash', cfg.model);

    fs.rmSync(u.PROFILE, { force: true });
    cleanEnv();
    fs.rmSync(path.join(process.env['ANDY_CLAUDE_SOURCE']!, 'unorouter'), { force: true });
    cfg = mk();
    check('apply: no key leaves the config alone',
      u.applyTo(cfg) === null && cfg.baseUrl === 'http://localhost:4001');

    check('guard: the default local proxy is overridable',
      u.appliesToDefaultEndpoint('http://localhost:4001'));
    check('guard: 127.0.0.1 is overridable',
      u.appliesToDefaultEndpoint('http://127.0.0.1:4001'));
    check('guard: an empty endpoint is overridable', u.appliesToDefaultEndpoint(''));
    check('guard: UnoRouter itself is NOT overridden',
      !u.appliesToDefaultEndpoint(u.DEFAULT_BASE_URL));
    check('guard: another host is NOT overridden',
      !u.appliesToDefaultEndpoint('https://api.example.com'));
    check('guard: a sibling gateway is NOT overridden',
      !u.appliesToDefaultEndpoint('https://openrouter.ai/api'));

    check('guard: active_endpoint is is_unorouter',
      u.activeEndpoint === u.isUnorouter);
  });

  it('test_price_for', async () => {
    const models = await parseCatalog();
    check('price: a free model prices at exactly zero',
      JSON.stringify(u.priceFor('deepseek-v4.1-flash:free', models)) ===
        JSON.stringify([0.0, 0.0]));
    check('price: a paid model is NOT priced from this catalog',
      u.priceFor('claude-opus-5', models) === null);
    check('price: an unknown model is not priced',
      u.priceFor('no-such-model', models) === null);
    check('price: a cold catalog prices nothing',
      u.priceFor('deepseek-v4.1-flash:free', null) === null);
    check('price: a suffix-free model prices at zero',
      JSON.stringify(u.priceFor('qwen3.8-27b:free', models)) ===
        JSON.stringify([0.0, 0.0]));
  });

  it('test_selection_file_is_shared', async () => {
    await u.setCurrent('unorouter');
    check('selection: sources.py sees the unorouter choice',
      sources.currentKey() === 'unorouter', String(sources.currentKey()));
    check('selection: unorouter sees it too',
      (await u.currentKey()) === 'unorouter');
  });

  it('test_no_key_is_echoed', () => {
    // The own profile carries the secret; the ORIGIN it reports is a path.
    fs.mkdirSync(path.dirname(u.PROFILE), { recursive: true });
    fs.writeFileSync(u.PROFILE,
      `export ANTHROPIC_AUTH_TOKEN="${KEY_SECRET}"\n`, 'utf-8');
    const creds = u.loadCredentials();
    const origin = creds?.[2] ?? '';
    check('display: the origin is a path, not a key', !origin.includes('sk-'), origin);

    check('display: the module holds no key material',
      !u.DEFAULT_BASE_URL.includes('sk-') && !u.PRICING_URL.includes('sk-'));

    // apply_to returns the origin, never the token.
    const applied = u.applyTo({
      baseUrl: 'http://localhost:4001', authToken: '', apiKey: '', model: '',
    });
    check('display: apply_to returns no key',
      applied !== null && !applied[0].includes('sk-'), String(applied));
    fs.rmSync(u.PROFILE, { force: true });
  });

  it('test_the_composed_message_url_is_right', async () => {
    // The URL the SDK actually builds — not the constant it is built from.
    // The TS SDK's buildRequest takes `path` (not `url`) and is async.
    const cfg = Config.Config.fromEnv({ baseUrl: u.DEFAULT_BASE_URL, authToken: KEY_X });
    const agent = new Agent.Agent(cfg);
    type Opts = Parameters<import('@anthropic-ai/sdk').Anthropic['buildRequest']>[0];
    const opts = { method: 'post', path: '/v1/messages', body: {}, headers: {} } as Opts;
    const composed = String((await agent.client.buildRequest(opts)).url);

    check('url: the message request lands on /v1/messages',
      composed === 'https://api.unorouter.com/v1/messages', composed);
    check('url: there is no doubled /v1 in the path',
      !composed.includes('/v1/v1/'), composed);
    check('url: the base carries no /v1 at all',
      !u.DEFAULT_BASE_URL.includes('/v1'), u.DEFAULT_BASE_URL);
    check('url: the base is the bare host',
      u.DEFAULT_BASE_URL === 'https://api.unorouter.com', u.DEFAULT_BASE_URL);

    u.clearCache();
    const { seen } = captureFetch();
    await u.fetchModels(undefined, { useCache: false });
    check('url: the catalog lands on /api/pricing, not under /v1',
      seen.url === 'https://api.unorouter.com/api/pricing', seen.url);
    check('url: PRICING_URL agrees with what was fetched',
      u.PRICING_URL === seen.url, u.PRICING_URL);
  });

  it('test_upstream_redundancy', async () => {
    u.clearCache();
    stubFetch();
    const [usable] = await u.usableFreeModels('', { useCache: false });
    const byId = new Map((usable ?? []).map((m) => [m.id, m]));

    check('upstreams: the count is the length of enable_groups',
      byId.get('gpt-oss-20b:free')!.upstreams === 14,
      String(byId.get('gpt-oss-20b:free')!.upstreams));
    check('upstreams: a one-channel model counts 1, not 0',
      byId.get('deepseek-v4.1-flash:free')!.upstreams === 1,
      String(byId.get('deepseek-v4.1-flash:free')!.upstreams));

    // A missing channel list is "unknown", NOT "single".
    const haiku = byId.get('claude-haiku-5-5:free')!;
    check('upstreams: a missing enable_groups is 0, not a guess',
      haiku.upstreams === 0, String(haiku.upstreams));
    check('upstreams: and it reads as unknown, not single',
      haiku.redundancy === 'unknown', haiku.redundancy);
    check('upstreams: a real single channel reads as single',
      byId.get('deepseek-v4.1-flash:free')!.redundancy === 'single');

    // The tiers, at their boundaries (UPSTREAM_THIN is ours — pin its edge).
    const tiers = await parseCatalog({ data: [1, 2, 4, 5, 8].map((n) => ({
      model_name: `m${n}`, is_free: true,
      enable_groups: Array.from({ length: n }, (_, i) => `g${i}`),
      metadata: meta({ supportsTools: true, outputModalities: ['text'] }),
    })) });
    const got = new Map(tiers.map((m) => [m.upstreams, m.redundancy]));
    check('upstreams: 1 is single', got.get(1) === 'single', String([...got]));
    check('upstreams: 2 is thin', got.get(2) === 'thin', String([...got]));
    check('upstreams: just below the threshold is thin', got.get(4) === 'thin',
      String([...got]));
    check('upstreams: at the threshold is good', got.get(5) === 'good', String([...got]));
    check('upstreams: well above is good', got.get(8) === 'good', String([...got]));

    // A malformed channel list must not be counted as channels.
    const junk = await parseCatalog({ data: [
      { model_name: 'str-groups', is_free: true, enable_groups: 'abc',
        metadata: meta({ supportsTools: true, outputModalities: ['text'] }) },
      { model_name: 'int-groups', is_free: true, enable_groups: 7,
        metadata: meta({ supportsTools: true, outputModalities: ['text'] }) },
    ] });
    check('upstreams: a string enable_groups is not counted as characters',
      junk[0]!.upstreams === 0, String(junk[0]!.upstreams));
    check('upstreams: a numeric enable_groups is not counted either',
      junk[1]!.upstreams === 0, String(junk[1]!.upstreams));

    // The note the UI prints, and its pluralisation.
    check('upstreams: the note pluralises a single channel correctly',
      byId.get('deepseek-v4.1-flash:free')!.upstreamNote === '1 upstream',
      byId.get('deepseek-v4.1-flash:free')!.upstreamNote);
    check('upstreams: and pluralises many correctly',
      byId.get('gpt-oss-20b:free')!.upstreamNote === '14 upstreams',
      byId.get('gpt-oss-20b:free')!.upstreamNote);
    check('upstreams: an unknown count says nothing at all',
      haiku.upstreamNote === '', JSON.stringify(haiku.upstreamNote));

    // The count must not have leaked into blurb.
    check('upstreams: the blurb does not carry the count',
      !byId.get('gpt-oss-20b:free')!.blurb.includes('upstream'),
      byId.get('gpt-oss-20b:free')!.blurb);

    // The ordering: most redundant first.
    const counts = (usable ?? []).map((m) => m.upstreams);
    const sorted = [...counts].sort((a, b) => b - a);
    check('upstreams: the free list is sorted most-redundant first',
      JSON.stringify(counts) === JSON.stringify(sorted), String(counts));
    check('upstreams: so the most redundant model leads the list',
      (usable ?? [null])[0]!.id === 'gpt-oss-20b:free');
    check('upstreams: and a single-channel model sinks below a redundant one',
      (usable ?? []).findIndex((m) => m.id === 'gpt-oss-20b:free') <
        (usable ?? []).findIndex((m) => m.id === 'deepseek-v4.1-flash:free'));

    // A paid model carries the count too.
    const all = await parseCatalog();
    const paid = all.filter((m) => m.id === 'qwen3.8-27b:free');
    check('upstreams: a paid model still reports its channel count',
      paid.length === 1 && paid[0]!.upstreams === 3, String(paid[0]?.upstreams));
  });
});
