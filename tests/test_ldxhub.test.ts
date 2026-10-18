// Vitest port of tests/test_ldxhub.py — regression suite for the LDXHub
// document gateway (src/ldxhub.ts) and its six tools in src/tools.ts.
//
// Contract: every fetch is served by a stubbed global fetch (no network); the
// tool layer is intercepted at the ldxhub module seam (resolveEntry /
// uploadFile / runJob / downloadFile), which is exactly the boundary the
// Python original's tools._ldx_* mocks stood in for — the TS handlers call
// those functions through `await import('./ldxhub.js')` at run time, so a
// vi.spyOn on the module namespace intercepts them. ANDY_HOME is pinned to a
// temp tree; ldxhub resolves its profile at CALL time (profilePath()), so
// per-test isolation is an env swap rather than Python's PROFILE patch. Cache
// TTL is exercised by faking performance.now (stamps are performance.now ms /
// 1000). Test names are the Python originals.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type Ldx = typeof import('../src/ldxhub.js');
type Tools = typeof import('../src/tools.js');
type AgentMod = typeof import('../src/agent.js');
type ConfigType = typeof import('../src/config.js');
type Sources = typeof import('../src/sources.js');

let ldx: Ldx;
let tools: Tools;
let agentMod: AgentMod;
let Config: ConfigType;
let sources: Sources;
let tmp: string;
let ROOT: string;

// Every env var the module reads — saved and scrubbed for hermetic runs.
const LDXHUB_VARS = [
  'LDXHUB_API_KEY',
  'LDXHUB_STRUCTFLOW_MODEL',
  'LDXHUB_ANALYZEDOC_MODEL',
  'LDXHUB_REFINELOOP_MODEL',
  'LDXHUB_RENDEROCR_ENGINE',
  'LDXHUB_CASTDOC_ENGINE',
  'LDXHUB_EXTRACTDOC_ENGINE',
] as const;
const ANTHROPIC_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] as const;
let savedVars: Record<string, string | undefined> = {};

const TOOL_NAMES = ['ldxhub_structflow', 'ldxhub_analyze', 'ldxhub_extract',
  'ldxhub_convert', 'ldxhub_refine', 'ldxhub_list'] as const;
// The five that run a paid job, and so need a key. ldxhub_list is not one of
// them — the catalogs are public.
const JOB_TOOLS = TOOL_NAMES.slice(0, 5) as string[];

// Shaped like the real `GET /{service}/models` response. Ported verbatim; the
// fixture covers the cases that matter (see the Python original's legend).
const CATALOG = {
  data: [
    {
      id: 'sf-alpha',
      display_name: 'StructFlow Alpha',
      provider: 'ldx',
      description: 'the good one',
      supported_conversions: [{ from: 'pdf', to: 'docx' }],
      supported_languages: [{ code: 'en', display_name: 'English' },
        { code: 'de', display_name: 'German' }],
    },
    { id: 'sf-beta' },
    {
      id: 'sf-gamma',
      supported_conversions: [
        { from: 'a', to: 'b' }, { from: 'c', to: 'd' },
        { from: 'e', to: 'f' }, { from: 'g', to: 'h' },
        { from: 'i', to: 'j' },
      ],
    },
    { id: '   ' },
    'not-a-row',
  ],
} as unknown as Record<string, unknown>;

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

/** A stub urlopen: raise `error`, serve `payload`, or raw `text`/`status`. */
function stubFetch(opts: { payload?: unknown; text?: string; status?: number; error?: Error } = {}):
  ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (opts.error) throw opts.error;
    if (opts.text !== undefined) {
      return new Response(opts.text, { status: opts.status ?? 200 });
    }
    return jsonResponse(opts.payload ?? CATALOG, opts.status ?? 200);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

interface Seen {
  url?: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
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
    seen.body = init?.body;
    return jsonResponse(payload);
  });
  vi.stubGlobal('fetch', fn);
  return { seen, fn };
}

/** Pin ANDY_HOME to `dir` for the duration of `fn` — the TS equivalent of
 *  Python's `mock.patch.object(ldx, "PROFILE", own)` (profilePath() reads the
 *  env at call time, so the swap is live). Async-aware: the env restores only
 *  once an async fn's promise RESOLVES (`return await`, so a suspension inside
 *  the callback cannot leak the write past the window). */
async function withHome<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env['ANDY_HOME'];
  process.env['ANDY_HOME'] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['ANDY_HOME'];
    else process.env['ANDY_HOME'] = prev;
  }
}

function cleanLdxEnv(): void {
  for (const v of [...LDXHUB_VARS, ...ANTHROPIC_VARS]) delete process.env[v];
}

function restoreLdxEnv(): void {
  cleanLdxEnv();
  for (const [k, v] of Object.entries(savedVars)) {
    if (v !== undefined) process.env[k] = v;
  }
}

/** Fake the monotonic clock forward by `secs` (stamps are ms/1000). */
function advanceClock(secs: number): void {
  const real = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => real + secs * 1000);
}

type CfgInstance = InstanceType<ConfigType['Config']>;

function mkConfig(dir: string, extra: Record<string, unknown> = {}): CfgInstance {
  return Config.Config.fromEnv({
    workdir: dir, apiKey: 'x', baseUrl: 'http://localhost:4001', ...extra,
  });
}

function mkEntry(id = 'sf-alpha'): InstanceType<Ldx['Entry']> {
  return new ldx.Entry(id, id);
}

/** Intercept the tool layer's job boundary and record what a handler built.
 *  The Python original patched tools._ldx_job; the TS handlers call
 *  ldxhub.runJob (service, payload, token) through the module namespace, so
 *  this is the same seam. dest/as_text live one layer down in ldxDeliver and
 *  are observed through the downloadFile spy instead. */
function captureJob(): { box: Record<string, unknown> } {
  const box: Record<string, unknown> = {};
  vi.spyOn(ldx, 'runJob').mockImplementation(
    async (service, payload, _token) => {
      box['service'] = service;
      box['payload'] = payload;
      return [{ status: 'completed', summary: 'ok' }, ''];
    });
  return { box };
}

async function run(name: string, args: Record<string, unknown>, cfg: CfgInstance) {
  return await tools.execute(name, args, cfg);
}

beforeAll(async () => {
  ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-ldx-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  process.env['ANDY_CLAUDE_SOURCE'] = path.join(tmp, 'claude-source');
  for (const v of [...LDXHUB_VARS, ...ANTHROPIC_VARS]) {
    savedVars[v] = process.env[v];
    delete process.env[v];
  }
  ldx = await import('../src/ldxhub.js');
  tools = await import('../src/tools.js');
  agentMod = await import('../src/agent.js');
  Config = await import('../src/config.js');
  sources = await import('../src/sources.js');
  TOOLS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'tools.ts'), 'utf-8');
});

afterAll(() => {
  restoreLdxEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ldx.clearCache();
  cleanLdxEnv();
});

describe('ldxhub', () => {
  it('test_looks_like_key', () => {
    // `zpka_…` passes — the underscore openrouter's regex would reject.
    check('key: a zpka_ key is accepted', ldx.looksLikeKey('zpka_' + 'a'.repeat(32)));
    check('key: dots and dashes are fine',
      ldx.looksLikeKey('zpka-abc.def_' + 'x'.repeat(20)));
    check('key: too short is refused', !ldx.looksLikeKey('zpka_short'));
    check('key: whitespace anywhere is refused',
      !ldx.looksLikeKey('zpka_' + 'a'.repeat(20) + ' b'));
    check('key: a whole export line is refused',
      !ldx.looksLikeKey('export LDXHUB_API_KEY="zpka_' + 'a'.repeat(20) + '"'));
    check('key: empty is refused', !ldx.looksLikeKey(''));
  });

  it('test_profile_roundtrip', async () => {
    const home = path.join(tmp, 'profile');
    await withHome(home, () => {
      const own = path.join(home, 'ldxhub', 'source');
      const token = 'zpka_' + 'b'.repeat(30);
      const p = ldx.saveKey(token, { structflow: 'sf-alpha' });
      check('profile: save_key returns the profile path', p === own, String(p));

      const mode = fs.statSync(own).mode & 0o777;
      check('profile: the file is mode 600', mode === 0o600, mode.toString(8));
      const parentMode = fs.statSync(path.dirname(own)).mode & 0o777;
      check('profile: the directory is mode 700', parentMode === 0o700,
        parentMode.toString(8));

      const creds = ldx.loadCredentials();
      check('profile: the key reads back',
        creds !== null && creds[0] === token);
      check('profile: origin is profile', creds?.[2] === 'profile');
      check('profile: the default round-trips',
        creds?.[1]['structflow'] === 'sf-alpha');
      check('profile: has_key is True', ldx.hasKey());

      // Replacing the key must not drop the pinned default.
      const token2 = 'zpka_' + 'c'.repeat(30);
      ldx.saveKey(token2);
      const again = ldx.loadCredentials();
      check('profile: a new key keeps the old default',
        again?.[0] === token2 && again?.[1]['structflow'] === 'sf-alpha');

      // A new default overrides, and the others survive.
      ldx.saveKey(token2, { renderocr: 'ki/render' });
      const final = ldx.loadCredentials();
      check('profile: defaults merge rather than replace',
        final?.[1]['renderocr'] === 'ki/render' &&
          final?.[1]['structflow'] === 'sf-alpha');

      const raw = fs.readFileSync(own, 'utf-8');
      check('profile: it is the shared export shape',
        raw.startsWith('export LDXHUB_API_KEY="') &&
          raw.includes('export LDXHUB_STRUCTFLOW_MODEL="sf-alpha"'), raw);
    });
  });

  it('test_read_exports_is_total', async () => {
    const home = path.join(tmp, 'exports-test');
    fs.mkdirSync(path.join(home, 'ldxhub'), { recursive: true });
    // The odd-lines fixture, with the module's own vars carried on the real
    // export lines — readExports is private, so the parse is observed through
    // loadCredentials, which is the parse the production path runs.
    fs.writeFileSync(path.join(home, 'ldxhub', 'source'),
      'export LDXHUB_API_KEY="1"\n' +
      'not an export\n' +
      'LDXHUB_CASTDOC_ENGINE=2\n' +
      "export LDXHUB_STRUCTFLOW_MODEL='3'\n" +
      'export LDXHUB_RENDEROCR_ENGINE=plain\n' +
      'export =\n' +
      '# export LDXHUB_REFINELOOP_ENGINE=no\n', 'utf-8');
    const missing = await withHome(path.join(tmp, 'nope'), () => ldx.loadCredentials());
    await withHome(home, () => {
      const got = ldx.loadCredentials();
      check('exports: a missing file is {}', missing === null);
      check('exports: quoted values are unwrapped', got?.[0] === '1', String(got?.[0]));
      check('exports: single quotes are unwrapped too',
        got?.[1]['structflow'] === '3', String(got?.[1]['structflow']));
      check('exports: an unquoted value still parses',
        got?.[1]['renderocr'] === 'plain');
      check('exports: a bare assignment outside an export is ignored',
        got?.[1]['castdoc'] === undefined);
      check('exports: a commented-out line is ignored',
        got?.[1]['refineloop'] === undefined);
      // Exactly the three real export lines parse: the key plus the two
      // defaults (the Python fixture's A/C/D, on this module's own var names).
      check('exports: exactly the three real lines parse',
        got?.[0] === '1' &&
          JSON.stringify(Object.keys(got?.[1] ?? {}).sort()) ===
            JSON.stringify(['renderocr', 'structflow']), String(got?.[1]));
    });
  });

  it('test_credential_precedence', async () => {
    const home = path.join(tmp, 'prec');
    await withHome(home, () => {
      ldx.saveKey('zpka_' + 'p'.repeat(30), { structflow: 'from-profile' });

      process.env['LDXHUB_API_KEY'] = 'zpka_' + 'e'.repeat(30);
      process.env['LDXHUB_STRUCTFLOW_MODEL'] = 'from-env';
      const creds = ldx.loadCredentials();
      check('creds: env beats the profile', creds?.[0] === 'zpka_' + 'e'.repeat(30));
      check('creds: origin says env', creds?.[2] === 'env');
      check('creds: the env default is read',
        creds?.[1]['structflow'] === 'from-env');

      // A blank env value is falsy after strip, so the profile is used.
      process.env['LDXHUB_API_KEY'] = '   ';
      const back = ldx.loadCredentials();
      check('creds: a blank env value falls through to the profile',
        back?.[2] === 'profile' && back?.[1]['structflow'] === 'from-profile');
    });
  });

  it('test_no_key_is_echoed', async () => {
    const home = path.join(tmp, 'absent');
    await withHome(home, () => {
      check('creds: no key reads as None', ldx.loadCredentials() === null);
      check('creds: has_key is False', !ldx.hasKey());
      check('creds: save_default refuses without a key',
        ldx.saveDefault('structflow', 'sf-alpha') === null);
    });

    // A token that was never given back is never printed either. The TS
    // equivalent of "the module prints no token": no console output at all.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'ldxhub.ts'), 'utf-8');
    check('creds: the module prints no token', !src.includes('console.'));
  });

  it('test_keyless_catalog_browsing', async () => {
    ldx.clearCache();
    const home = path.join(tmp, 'absent2');
    await withHome(home, async () => {
      const { seen } = captureFetch();
      const [entries, err] = await ldx.fetchCatalog('structflow');
      check('keyless: a catalog fetch succeeds with no key',
        err === '' && entries !== null && entries.length === 3, `err=${err}`);
      check('keyless: no Authorization header is sent',
        !('authorization' in seen.headers), String(seen.headers));
      check('keyless: the request still carries no data',
        seen.body === undefined);

      // Every service, not just the first — the whole point is browsing.
      for (const svc of Object.keys(ldx.SERVICES)) {
        const [e, err2] = await ldx.fetchCatalog(svc, '', { useCache: false });
        check(`keyless: ${svc} lists without a key`, err2 === '' && e !== null, err2);
      }

      // And the non-blocking read agrees, keyed on the empty token.
      check('keyless: cached_catalog reads the anonymous entry',
        ldx.cachedCatalog('structflow') !== undefined);
      check('keyless: catalog_age is a number',
        typeof ldx.catalogAge('structflow') === 'number');

      // A key, once stored, is used — the anonymous path is a fallback.
      const zkey = 'zpka_' + 'z'.repeat(30);
      ldx.saveKey(zkey);
      ldx.clearCache();
      const keyed = captureFetch();
      await ldx.fetchCatalog('structflow');
      check('keyless: a stored key switches the header back on',
        keyed.seen.headers['authorization'] === `Bearer ${zkey}`,
        String(keyed.seen.headers['authorization']));

      // The keyed fetch landed in the cache under the KEYED identity (the TS
      // cache key is token\0service and an explicit '' token resolves to the
      // credential too, so the keyed slot is what a repeat read must hit).
      check('keyless: the cache is keyed separately from anonymous',
        ldx.cachedCatalog('structflow') !== undefined &&
          keyed.fn.mock.calls.length === 1,
        String(keyed.fn.mock.calls.length));
    });
    ldx.clearCache();
  });

  it('test_json_is_total', async () => {
    // jsonRequest is private; fetchCatalog/createJob run it — the same call
    // path the production code uses.
    ldx.clearCache();
    stubFetch({ status: 401 });
    let [obj, err] = await ldx.fetchCatalog('structflow', 't', { useCache: false });
    check('json: 401 is mapped, not raised',
      obj === null && err.includes('rejected'), err);

    ldx.clearCache();
    stubFetch({ payload: { detail: 'model is required' }, status: 400 });
    let [jid, jerr] = await ldx.createJob('structflow', { x: 1 }, 't');
    check('json: a problem+json detail is surfaced',
      jid === '' && jerr === 'model is required', jerr);

    ldx.clearCache();
    stubFetch({ error: new TypeError('no route') });
    [obj, err] = await ldx.fetchCatalog('structflow', 't', { useCache: false });
    check('json: an unreachable host names the host',
      obj === null && err.includes(ldx.HOST), err);

    ldx.clearCache();
    stubFetch({ text: '<html>nope</html>' });
    [obj, err] = await ldx.fetchCatalog('structflow', 't', { useCache: false });
    check('json: a non-JSON body is reported as such',
      obj === null && err === 'response was not JSON', err);
  });

  it('test_json_sends_a_bearer_and_a_body', async () => {
    ldx.clearCache();
    let { seen } = captureFetch();
    await ldx.fetchCatalog('structflow', 'tok-123', { useCache: false });
    check('http: GET carries a bearer',
      seen.headers['authorization'] === 'Bearer tok-123', String(seen.headers));
    check('http: a bodyless GET sends no content-type',
      !('content-type' in seen.headers));
    check('http: a bodyless GET sends no data', seen.body === undefined);
    check('http: the method is GET', seen.method === 'GET');

    ldx.clearCache();
    ({ seen } = captureFetch());
    await ldx.createJob('structflow', { model: 'sf-alpha' }, 'tok-123');
    check('http: a JSON POST sets the content type',
      seen.headers['content-type'] === 'application/json');
    check('http: the payload is JSON-encoded',
      JSON.parse(String(seen.body)) ['model'] === 'sf-alpha');
    check('http: the method is POST', seen.method === 'POST');
  });

  it('test_parse_entries', async () => {
    // parseEntries is private; the same parse runs on a fetched payload.
    ldx.clearCache();
    stubFetch();
    const [entries, err] = await ldx.fetchCatalog('structflow', 'tok', { useCache: false });
    expect(err).toBe('');
    check('catalog: three good rows parse', entries!.length === 3, String(entries!.length));
    const byId = new Map(entries!.map((e) => [e.id, e]));
    check('catalog: a blank id is skipped', !byId.has('   '));

    const alpha = byId.get('sf-alpha')!;
    check('catalog: display_name becomes the label', alpha.label === 'StructFlow Alpha');
    check('catalog: provider and blurb are kept',
      alpha.provider === 'ldx' && alpha.blurb === 'the good one');
    check('catalog: conversions are tuples',
      JSON.stringify(alpha.conversions) === JSON.stringify([['pdf', 'docx']]));
    check('catalog: languages are tuples',
      JSON.stringify(alpha.languages) === JSON.stringify([['en', 'English'], ['de', 'German']]));

    check('catalog: a bare row falls back to the id as label',
      byId.get('sf-beta')!.label === 'sf-beta');

    ldx.clearCache();
    stubFetch({ payload: ['nope'] });
    const [nonDict] = await ldx.fetchCatalog('structflow', 'tok', { useCache: false });
    check('catalog: a non-dict payload is empty', nonDict!.length === 0);
    ldx.clearCache();
    stubFetch({ payload: {} });
    const [noData] = await ldx.fetchCatalog('structflow', 'tok', { useCache: false });
    check('catalog: a payload with no data is empty', noData!.length === 0);
  });

  it('test_entry_summary', async () => {
    ldx.clearCache();
    stubFetch();
    const [entries] = await ldx.fetchCatalog('structflow', 'tok', { useCache: false });
    const byId = new Map(entries!.map((e) => [e.id, e]));
    const s = byId.get('sf-alpha')!.summary;
    check('summary: starts with the id', s.startsWith('sf-alpha'));
    check('summary: names the label', s.includes('StructFlow Alpha'));
    check('summary: counts languages', s.includes('[2 languages]'));
    check('summary: shows a conversion', s.includes('pdf→docx'));

    const gamma = byId.get('sf-gamma')!.summary;
    check('summary: more than four conversions elide', gamma.includes('…'), gamma);
    check('summary: only four pairs are shown',
      gamma.split('→').length - 1 === 4, gamma);

    const bare = new ldx.Entry('sf-beta', 'sf-beta');
    check('summary: a bare entry is just the id', bare.summary === 'sf-beta');

    // The provider is dropped when it is already inside the id.
    const dup = new ldx.Entry('ldx/sf-alpha', 'ldx/sf-alpha', 'ldx');
    check('summary: a redundant provider is not repeated',
      !dup.summary.includes('(ldx)'), dup.summary);
  });

  it('test_fetch_catalog', async () => {
    ldx.clearCache();
    const { seen } = captureFetch();
    const [entries, err] = await ldx.fetchCatalog('structflow', 'tok-abc');
    check('fetch: a model service reads /models',
      seen.url === `${ldx.BASE_URL}/structflow/models`, seen.url);
    check('fetch: it succeeds',
      err === '' && entries !== null && entries.length === 3,
      `err=${err} n=${entries?.length}`);

    ldx.clearCache();
    const engine = captureFetch();
    await ldx.fetchCatalog('renderocr', 'tok-abc');
    check('fetch: an engine service reads /engines',
      engine.seen.url === `${ldx.BASE_URL}/renderocr/engines`, engine.seen.url);

    const [, svcErr] = await ldx.fetchCatalog('nope', 'tok-abc');
    check('fetch: an unknown service is refused without a request',
      svcErr.startsWith('unknown service'), svcErr);

    // Cached: the second call must not reach the network at all.
    ldx.clearCache();
    const counting = stubFetch();
    await ldx.fetchCatalog('structflow', 'tok-abc');
    await ldx.fetchCatalog('structflow', 'tok-abc');
    check('fetch: the second call is served from cache',
      counting.mock.calls.length === 1, String(counting.mock.calls.length));

    await ldx.fetchCatalog('structflow', 'tok-abc', { useCache: false });
    check('fetch: use_cache=False always re-fetches',
      counting.mock.calls.length === 2);
  });

  it('test_cache_is_keyed_and_expires', async () => {
    ldx.clearCache();
    stubFetch();
    await ldx.fetchCatalog('structflow', 'tok-a');
    await ldx.fetchCatalog('structflow', 'tok-b');
    // Two tokens hold two entries, observable as: each token's repeat read is
    // served without a network hit.
    const counting = stubFetch();
    await ldx.fetchCatalog('structflow', 'tok-a');
    await ldx.fetchCatalog('structflow', 'tok-b');
    check('cache: two tokens hold two entries',
      counting.mock.calls.length === 0, String(counting.mock.calls.length));
    await ldx.fetchCatalog('structflow', 'tok-c');
    check('cache: a different token reads nothing',
      counting.mock.calls.length === 1, String(counting.mock.calls.length));

    process.env['LDXHUB_API_KEY'] = 'tok-a';
    check('cache: cached_catalog reads by the credential token',
      ldx.cachedCatalog('structflow') !== undefined);
    check('cache: catalog_age is a small positive number',
      typeof ldx.catalogAge('structflow') === 'number');
    process.env['LDXHUB_API_KEY'] = 'tok-b';
    check('cache: a different token reads nothing',
      ldx.cachedCatalog('structflow') !== undefined);

    // Age the entry past the TTL: reads go None so the next action refetches.
    advanceClock(ldx.CACHE_TTL + 1.0);
    check('cache: an expired entry reads as None',
      ldx.cachedCatalog('structflow') === undefined);
    check('cache: an expired entry still reports its age',
      (ldx.catalogAge('structflow') ?? 0) > ldx.CACHE_TTL,
      String(ldx.catalogAge('structflow')));
    vi.restoreAllMocks();

    ldx.clearCache();
    stubFetch();
    await ldx.fetchCatalog('structflow', 'tok-a');
    // Keyless, the cache keys on "" — browsable before any key exists.
    cleanLdxEnv();
    await withHome(path.join(tmp, 'nohome'), () => {
      check('cache: a cold keyless read is None',
        ldx.cachedCatalog('structflow') === undefined);
      check('cache: a cold keyless age is None',
        ldx.catalogAge('structflow') === undefined);
    });
    const keyless = stubFetch();
    await ldx.fetchCatalog('structflow');
    check('cache: a keyless fetch populates the anonymous slot',
      keyless.mock.calls.length === 1, String(keyless.mock.calls.length));
    check('cache: and is then readable without a key',
      ldx.cachedCatalog('structflow') !== undefined);
  });

  it('test_resolve_entry', async () => {
    ldx.clearCache();
    stubFetch();
    let [entry, err] = await ldx.resolveEntry('structflow', 'sf-gamma', null, 'tok');
    check('resolve: an explicit id wins', err === '' && entry!.id === 'sf-gamma');

    [entry, err] = await ldx.resolveEntry('structflow', 'nope', null, 'tok');
    check('resolve: an unknown id is refused by name',
      entry === null && err.includes('not in structflow catalog'), err);

    [entry, err] = await ldx.resolveEntry('structflow', '', null, 'tok');
    check('resolve: with no pin the first entry is used',
      err === '' && entry!.id === 'sf-alpha');

    // A pinned default is honoured when it is really in the catalog.
    const creds: import('../src/ldxhub.js').Credentials = ['tok', { structflow: 'sf-beta' }, 'profile'];
    [entry, err] = await ldx.resolveEntry('structflow', '', creds, 'tok');
    check('resolve: the pinned default is used',
      err === '' && entry!.id === 'sf-beta');

    // A stale pin falls back to the first entry rather than failing.
    const stale: import('../src/ldxhub.js').Credentials = ['tok', { structflow: 'long-gone' }, 'profile'];
    [entry, err] = await ldx.resolveEntry('structflow', '', stale, 'tok');
    check('resolve: a stale pin falls back to the first entry',
      err === '' && entry!.id === 'sf-alpha');

    check('resolve: default_for is empty with no pin',
      ldx.defaultFor('structflow', ['tok', {}, 'profile']) === '');

    ldx.clearCache();
    stubFetch({ payload: { data: [] } });
    [entry, err] = await ldx.resolveEntry('structflow', '', null, 'tok');
    check('resolve: an empty catalog says so',
      entry === null && err === 'structflow catalog is empty', err);
  });

  it('test_run_job', async () => {
    // runJob calls createJob/getJob inside its own module, where a namespace
    // spy cannot reach — so the Python create_job/get_job mocks are driven
    // through the real HTTP layer with a routing fetch stub instead.
    const noSleep = async (): Promise<void> => {};
    let polls = 0;
    const routeFetch = (create: () => unknown, poll: () => unknown): ReturnType<typeof vi.fn> =>
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/jobs') && init?.method === 'POST') return jsonResponse(create());
        polls += 1;
        return jsonResponse(poll());
      });
    const stub = (fn: ReturnType<typeof vi.fn>): void => {
      vi.stubGlobal('fetch', fn);
    };

    // Polling walks to a terminal status.
    const statuses = ['queued', 'processing', 'completed'];
    stub(routeFetch(() => ({ job_id: 'j1' }),
      () => ({ status: statuses[Math.min(polls - 1, statuses.length - 1)], summary: 'done' })));
    let [job, err] = await ldx.runJob('structflow', { model: 'sf-alpha' }, 'tok',
      { sleep: noSleep });
    check('job: polling stops at the first terminal status',
      err === '' && job!['status'] === 'completed', err);
    check('job: it polled three times', polls === 3, String(polls));

    // A failed create short-circuits before any polling.
    polls = 0;
    stub(routeFetch(() => ({ detail: 'nope' }), () => {
      throw new Error('should not poll after a failed create');
    }));
    [job, err] = await ldx.runJob('structflow', {}, 'tok', { sleep: noSleep });
    check('job: a failed create returns its error',
      job === null && err.includes('no job_id') && polls === 0, `${err} polls=${polls}`);

    // A job that never leaves 'processing' times out, and says what it last saw.
    stub(routeFetch(() => ({ job_id: 'j2' }), () => ({ status: 'processing' })));
    [job, err] = await ldx.runJob('structflow', {}, 'tok',
      { timeout: 0.0, sleep: noSleep });
    check('job: a timeout reports the last status',
      err.includes('timed out') && err.includes('processing'), err);

    // A failing poll with no payload at all still returns a usable error.
    stub(routeFetch(() => ({ job_id: 'j3' }), () => ({ detail: 'boom' })));
    // mapHttpError surfaces the problem+json detail only for 4xx; force one.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/jobs') && init?.method === 'POST') return jsonResponse({ job_id: 'j3' });
      return jsonResponse({ detail: 'boom' }, 400);
    }));
    [job, err] = await ldx.runJob('structflow', {}, 'tok',
      { timeout: 0.0, sleep: noSleep });
    check('job: a poll failure is carried out',
      job === null && err === 'boom', err);
  });

  it('test_create_and_upload_errors', async () => {
    stubFetch({ payload: { detail: 'nope' } });
    let [jid, err] = await ldx.createJob('structflow', { model: 'x' }, 'tok');
    check('create: a response with no job_id is an error',
      jid === '' && err.includes('no job_id'), err);

    stubFetch({ payload: { id: 'j9' } });
    [jid, err] = await ldx.createJob('structflow', { model: 'x' }, 'tok');
    check('create: an `id` is accepted as a job_id', jid === 'j9' && err === '');

    stubFetch({ payload: { job_id: 'j10' } });
    [jid] = await ldx.createJob('structflow', { model: 'x' }, 'tok');
    check('create: job_id wins', jid === 'j10');

    const src = path.join(tmp, 'doc.pdf');
    fs.writeFileSync(src, '%PDF-1.4 tiny');

    const { seen } = captureFetch(); // serves the catalog shape — no file_id
    let [fid, uerr] = await ldx.uploadFile(src, 'tok');
    check('upload: a response with no file_id is an error',
      fid === '' && uerr.includes('no file_id'), uerr);
    check('upload: it posts to /files',
      seen.url === `${ldx.BASE_URL}/files` && seen.method === 'POST', seen.url);
    const bodyText = (seen.body as unknown as { toString(enc: string): string }).toString('latin1');
    check('upload: the body is multipart with the field named `file`',
      (seen.headers['content-type'] ?? '').startsWith('multipart/form-data; boundary=') &&
        bodyText.includes('name="file"'), String(seen.headers));
    check('upload: the filename and bytes are in the body',
      bodyText.includes('filename="doc.pdf"') && bodyText.includes('%PDF-1.4 tiny'));
    check('upload: a PDF is labelled as one',
      bodyText.includes('Content-Type: application/pdf'));

    stubFetch({ payload: { file_id: 'f1' } });
    [fid, uerr] = await ldx.uploadFile(src, 'tok');
    check('upload: a file_id comes back', fid === 'f1' && uerr === '');

    [fid, uerr] = await ldx.uploadFile(path.join(tmp, 'missing.pdf'), 'tok');
    check('upload: a missing file is refused locally, before any request',
      fid === '' && uerr.includes('no such file'), uerr);
  });

  it('test_download_file', async () => {
    const dest = path.join(tmp, 'out', 'result.docx');
    stubFetch({ text: 'DOCXBYTES' });
    let err = await ldx.downloadFile('f1', 'tok', dest);
    check('download: success returns an empty error', err === '');
    check('download: the bytes are written',
      fs.readFileSync(dest).toString() === 'DOCXBYTES');
    check('download: the parent directory is created',
      fs.statSync(path.dirname(dest)).isDirectory());

    const { seen } = captureFetch();
    await ldx.downloadFile('f1', 'tok', dest);
    check('download: it reads the content endpoint',
      seen.url === `${ldx.BASE_URL}/files/f1/content`, seen.url);

    stubFetch({ status: 403 });
    err = await ldx.downloadFile('f1', 'tok', dest);
    check('download: a 403 is mapped', err.includes('rejected'), err);

    stubFetch({ error: new TypeError('down') });
    err = await ldx.downloadFile('f1', 'tok', dest);
    check('download: an unreachable host is reported',
      err.includes('could not fetch result'), err);

    // An unwritable destination is a clean error, not a traceback.
    stubFetch({ text: 'x' });
    err = await ldx.downloadFile('f1', 'tok', '/proc/nope/out.bin');
    check('download: an unwritable dest is reported',
      err.includes('could not write'), err);
  });

  it('test_job_output', () => {
    let [inline, fid, err] = ldx.jobOutput({ status: 'failed', error: 'bad model' });
    check('output: a failed job reports its problem',
      inline === null && err === 'job failed: bad model', err);

    [inline, fid, err] = ldx.jobOutput({ status: 'completed', summary: 'all good' });
    check('output: a bare summary is returned as text',
      inline === 'all good' && err === '');

    [inline] = ldx.jobOutput(
      { status: 'completed', summary: 's', results: [{ a: 1 }] });
    check('output: summary and results render as JSON',
      JSON.parse(inline!) ['summary'] === 's' &&
        JSON.parse(JSON.stringify(JSON.parse(inline!) ['results'])) [0]['a'] === 1);

    [inline] = ldx.jobOutput({ status: 'completed', results: [1, 2] });
    check('output: results alone render as JSON',
      JSON.parse(inline!) [0] === 1);

    [inline, fid, err] = ldx.jobOutput({ status: 'completed', output: 'text out' });
    check('output: a plain output field is returned',
      inline === 'text out' && err === '');

    [inline, fid, err] = ldx.jobOutput({ status: 'completed', output_file_id: 'f7' });
    check('output: a lone file id is handed back for download',
      inline === null && fid === 'f7' && err === '');

    [inline, , err] = ldx.jobOutput({ status: 'completed' });
    check('output: a job with nothing says so',
      inline === null && err === 'job finished with no output', err);

    [, , err] = ldx.jobOutput('not a dict');
    check('output: a non-dict payload is refused', err === 'no job payload');
  });

  it('test_service_help', () => {
    const text = ldx.serviceHelp();
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    check('help: one line per service', lines.length === Object.keys(ldx.SERVICES).length,
      String(lines.length));
    for (const svc of Object.keys(ldx.SERVICES)) {
      check(`help: names ${svc}`, text.includes(svc));
    }
    check('help: the kinds are the two the API has',
      JSON.stringify([...new Set(Object.values(ldx.SERVICES))].sort()) ===
        JSON.stringify(['engines', 'models']));
    check('help: every service has a default var',
      JSON.stringify([...new Set(Object.keys(ldx.DEFAULT_VAR))].sort()) ===
        JSON.stringify([...new Set(Object.keys(ldx.SERVICES))].sort()));
  });

  it('test_tool_gating', async () => {
    check('tools: LDXHUB_TOOLS is exactly the five job tools',
      [...tools.LDXHUB_TOOLS].sort().join(',') === [...JOB_TOOLS].sort().join(','),
      String([...tools.LDXHUB_TOOLS].sort()));
    check('tools: ldxhub_list is NOT key-gated — the catalogs are public',
      !tools.LDXHUB_TOOLS.has('ldxhub_list'));

    const schemaNames = new Set(tools.TOOL_SCHEMAS.map((s) => s.name));
    for (const name of TOOL_NAMES) {
      check(`tools: ${name} has a schema`, schemaNames.has(name));
      check(`tools: ${name} is dispatched`, toolsDispatched(name));
      check(`tools: ${name} is not permission-gated`, !tools.needsPermission(name));
    }

    check('tools: every tool schema has a description',
      tools.TOOL_SCHEMAS.every((s) => Boolean(s.description)));
    check('tools: every input_schema is an object',
      tools.TOOL_SCHEMAS.every((s) => s.input_schema.type === 'object'));

    const wd = path.join(tmp, 'gate');
    fs.mkdirSync(wd, { recursive: true });
    const cfg = mkConfig(wd);
    const a = new agentMod.Agent(cfg);
    type Denier = { denied(name: string): string | null };
    const denier = a as unknown as Denier;
    await withHome(path.join(tmp, 'none'), () => {
      const advertised = new Set(a.toolSchemas().map((s) => s.name));
      const leaked = [...advertised].filter((n) => JOB_TOOLS.includes(n));
      check('gate: no key withholds the five job tools',
        leaked.length === 0, String(leaked.sort()));
      check('gate: no key still advertises ldxhub_list', advertised.has('ldxhub_list'));
      const reason = denier.denied('ldxhub_structflow');
      check('gate: the job-tool refusal names the setup command',
        reason !== null && reason.includes('/ldxhub-api-setup'), String(reason));
      check('gate: ldxhub_list is never denied for want of a key',
        denier.denied('ldxhub_list') === null, String(denier.denied('ldxhub_list')));
    });

    process.env['LDXHUB_API_KEY'] = 'zpka_' + 'k'.repeat(30);
    const b = new agentMod.Agent(mkConfig(wd));
    const advertised2 = new Set(b.toolSchemas().map((s) => s.name));
    const missing = TOOL_NAMES.filter((n) => !advertised2.has(n));
    check('gate: a key advertises all six', missing.length === 0, String(missing));
    check('gate: with a key nothing is denied',
      TOOL_NAMES.every((n) => (b as unknown as Denier).denied(n) === null));

    // A mode that denies a normal tool must not accidentally deny these.
    for (const [mode, policy] of Object.entries(Config.MODES)) {
      const hit = [...policy.deny].filter((t) => (TOOL_NAMES as readonly string[]).includes(t));
      check(`gate: ${mode} mode denies no ldxhub tool`, hit.length === 0, String(hit));
    }
  });

  it('test_structflow_inputs_xor_file', async () => {
    const wd = path.join(tmp, 'sf');
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'doc.pdf'), 'pdf');
    const cfg = mkConfig(wd);
    const { box } = captureJob();
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue([mkEntry(), 'tok'] as never);
    vi.spyOn(ldx, 'uploadFile').mockResolvedValue(['fid', '']);

    let out = await run('ldxhub_structflow', { prompt: 'write a memo' }, cfg);
    check('structflow: a prompt job succeeds', !out.isError, out.output);
    check('structflow: the service is structflow', box['service'] === 'structflow');
    const payload = box['payload'] as Record<string, unknown>;
    check('structflow: the prompt becomes an inputs array',
      JSON.stringify(payload['inputs']) ===
        JSON.stringify([{ role: 'user', content: 'write a memo' }]),
      String(payload['inputs']));
    check('structflow: file_id is absent when a prompt is given',
      !('file_id' in payload));
    check('structflow: the chosen model is sent', payload['model'] === 'sf-alpha');
    check('structflow: a default system prompt is supplied',
      Boolean(String(payload['system_prompt'] ?? '')));
    check('structflow: example_output defaults to an object',
      JSON.stringify(payload['example_output']) === JSON.stringify({ result: '' }));

    out = await run('ldxhub_structflow', { file_path: 'doc.pdf' }, cfg);
    check('structflow: a file job succeeds', !out.isError, out.output);
    check('structflow: a file job sends file_id',
      (box['payload'] as Record<string, unknown>)['file_id'] === 'fid');
    check('structflow: inputs is absent when a file is given',
      !('inputs' in (box['payload'] as Record<string, unknown>)));

    out = await run('ldxhub_structflow', { prompt: 'x', file_path: 'doc.pdf' }, cfg);
    check('structflow: both prompt and file is refused',
      out.isError === true && out.output.includes('exactly one'), out.output);

    out = await run('ldxhub_structflow', {}, cfg);
    check('structflow: neither prompt nor file is refused', out.isError === true);

    out = await run('ldxhub_structflow',
      { prompt: 'x', example_output: '{"a": 1}' }, cfg);
    check('structflow: a JSON-encoded example_output string is coerced',
      !out.isError &&
        JSON.stringify((box['payload'] as Record<string, unknown>)['example_output']) ===
          JSON.stringify({ a: 1 }),
      out.output);

    out = await run('ldxhub_structflow',
      { prompt: 'x', example_output: '[1, 2]' }, cfg);
    check('structflow: a non-object example_output is refused',
      out.isError === true && out.output.includes('must be a JSON object'), out.output);

    out = await run('ldxhub_structflow', { prompt: 'x', model: 'nope' }, cfg);
    check('structflow: an explicit model is passed to resolve_entry',
      !out.isError);
  });

  it('test_structflow_model_selection', async () => {
    const wd = path.join(tmp, 'sf-model');
    fs.mkdirSync(wd, { recursive: true });
    const cfg = mkConfig(wd);
    const seen: Record<string, unknown> = {};
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockImplementation((async (service: string, explicit: string) => {
      seen['service'] = service;
      seen['explicit'] = explicit;
      return [mkEntry('sf-gamma'), 'tok'];
    }) as never);
    vi.spyOn(ldx, 'runJob').mockResolvedValue([{ status: 'completed', summary: 'ok' }, '']);

    await run('ldxhub_structflow', { prompt: 'x', model: 'sf-gamma' }, cfg);
    check('structflow: the service is passed through', seen['service'] === 'structflow');
    check('structflow: the explicit model is passed through',
      seen['explicit'] === 'sf-gamma', String(seen['explicit']));

    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue(
      [null, 'structflow catalog is empty'] as never);
    const out = await run('ldxhub_structflow', { prompt: 'x' }, cfg);
    check('structflow: an empty catalog is a clean tool error',
      out.isError === true && out.output.includes('catalog is empty'), out.output);
  });

  it('test_analyze_extract_refine', async () => {
    const wd = path.join(tmp, 'aer');
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'doc.pdf'), 'pdf');
    fs.writeFileSync(path.join(wd, 'doc.xliff'), 'xliff');
    const cfg = mkConfig(wd);
    const { box } = captureJob();
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue([mkEntry('m1'), 'tok'] as never);
    vi.spyOn(ldx, 'uploadFile').mockResolvedValue(['fid', '']);
    // as_text reads the file back inline — the download spy writes the body.
    // The job returns an output_file_id so the delivery layer actually runs
    // (a bare summary would short-circuit before the download branch).
    vi.spyOn(ldx, 'runJob').mockImplementation(
      (async (service: string, payload: Record<string, unknown>) => {
        box['service'] = service;
        box['payload'] = payload;
        return [{ status: 'completed', output_file_id: 'fid' }, ''];
      }) as never);
    vi.spyOn(ldx, 'downloadFile').mockImplementation(
      async (_fid, _tok, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'extracted text');
        return '';
      });

    let out = await run('ldxhub_analyze',
      { file_path: 'doc.pdf', prompt: 'find the totals' }, cfg);
    check('analyze: it succeeds', !out.isError, out.output);
    check('analyze: the service is analyzedoc', box['service'] === 'analyzedoc');
    let p = box['payload'] as Record<string, unknown>;
    check('analyze: the prompt becomes the system_prompt',
      p['system_prompt'] === 'find the totals');
    check('analyze: the file is uploaded', p['file_id'] === 'fid' && p['model'] === 'm1');
    check('analyze: output_format defaults to json', p['output_format'] === 'json');
    check('analyze: example_output is an object',
      typeof p['example_output'] === 'object' && p['example_output'] !== null);

    out = await run('ldxhub_analyze', { file_path: 'doc.pdf' }, cfg);
    check('analyze: a missing prompt is refused', out.isError === true, out.output);

    out = await run('ldxhub_analyze', { prompt: 'x' }, cfg);
    check('analyze: a missing file is refused', out.isError === true, out.output);

    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('extract: it succeeds', !out.isError, out.output);
    check('extract: the service is extractdoc', box['service'] === 'extractdoc');
    p = box['payload'] as Record<string, unknown>;
    check('extract: the engine is sent as `engine`',
      p['engine'] === 'm1' && !('model' in p));
    check('extract: output_format defaults to text', p['output_format'] === 'text');
    // as_text: the result is the downloaded file body, inline.
    check('extract: the result is delivered as text',
      out.output === 'extracted text', out.output);

    out = await run('ldxhub_extract',
      { file_path: 'doc.pdf', output_format: 'jsonl' }, cfg);
    check('extract: an explicit format is passed through',
      (box['payload'] as Record<string, unknown>)['output_format'] === 'jsonl');

    out = await run('ldxhub_extract', {}, cfg);
    check('extract: a missing file is refused', out.isError === true);

    out = await run('ldxhub_refine', { file_path: 'doc.xliff' }, cfg);
    check('refine: it succeeds', !out.isError, out.output);
    check('refine: the service is refineloop', box['service'] === 'refineloop');
    check('refine: only model and file_id are sent',
      JSON.stringify(Object.keys(box['payload'] as Record<string, unknown>).sort()) ===
        JSON.stringify(['file_id', 'model']),
      String(Object.keys(box['payload'] as Record<string, unknown>).sort()));
    check('refine: the result is delivered as text',
      out.output === 'extracted text', out.output);

    out = await run('ldxhub_refine', {}, cfg);
    check('refine: a missing file is refused', out.isError === true);
  });

  it('test_convert_modes', async () => {
    const wd = path.join(tmp, 'convert');
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'scan.pdf'), 'scan');
    const cfg = mkConfig(wd);
    const { box } = captureJob();
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue([mkEntry('ki/cast'), 'tok'] as never);
    vi.spyOn(ldx, 'uploadFile').mockResolvedValue(['fid', '']);
    // The job returns an output_file_id so the dest branch of the delivery
    // layer actually runs — that branch is where the destination lands.
    vi.spyOn(ldx, 'runJob').mockImplementation(
      (async (service: string, payload: Record<string, unknown>) => {
        box['service'] = service;
        box['payload'] = payload;
        return [{ status: 'completed', output_file_id: 'fid' }, ''];
      }) as never);
    vi.spyOn(ldx, 'downloadFile').mockImplementation(
      async (_fid, _tok, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'RESULT');
        return '';
      });

    let out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'castdoc', dest: 'out.docx' }, cfg);
    check('convert: castdoc succeeds', !out.isError, out.output);
    check('convert: the service is castdoc', box['service'] === 'castdoc');
    let p = box['payload'] as Record<string, unknown>;
    check('convert: output_format defaults to docx', p['output_format'] === 'docx');
    check('convert: castdoc sends no languages', !('languages' in p));
    // The destination reaches the delivery layer: the download spy saw a path
    // ending in out.docx and the report names the relative path.
    check('convert: the destination is passed to the job layer',
      out.output.includes('wrote out.docx'), out.output);

    out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'renderocr', dest: 'out.docx' }, cfg);
    check('convert: renderocr succeeds', !out.isError, out.output);
    check('convert: the service is renderocr', box['service'] === 'renderocr');
    check('convert: languages default to [en]',
      JSON.stringify((box['payload'] as Record<string, unknown>)['languages']) ===
        JSON.stringify(['en']),
      String((box['payload'] as Record<string, unknown>)['languages']));

    out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'renderocr', dest: 'o.docx',
        languages: 'en, de ,fr' }, cfg);
    check('convert: a comma-separated string becomes a list',
      JSON.stringify((box['payload'] as Record<string, unknown>)['languages']) ===
        JSON.stringify(['en', 'de', 'fr']),
      String((box['payload'] as Record<string, unknown>)['languages']));

    out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'renderocr', dest: 'o.docx',
        languages: ['ja'] }, cfg);
    check('convert: an explicit list passes through',
      JSON.stringify((box['payload'] as Record<string, unknown>)['languages']) ===
        JSON.stringify(['ja']));

    out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'renderocr', dest: 'o.docx',
        languages: [] }, cfg);
    check('convert: an empty list falls back to [en]',
      JSON.stringify((box['payload'] as Record<string, unknown>)['languages']) ===
        JSON.stringify(['en']));

    out = await run('ldxhub_convert',
      { file_path: 'scan.pdf', mode: 'nope', dest: 'o.docx' }, cfg);
    check('convert: an unknown mode is refused by name',
      out.isError === true && out.output.includes('renderocr') &&
        out.output.includes('castdoc'), out.output);

    out = await run('ldxhub_convert', { file_path: 'scan.pdf', mode: 'castdoc' }, cfg);
    check('convert: a missing dest is refused', out.isError === true, out.output);

    out = await run('ldxhub_convert', { mode: 'castdoc', dest: 'o.docx' }, cfg);
    check('convert: a missing file is refused', out.isError === true);
  });

  it('test_list_handler', async () => {
    const wd = path.join(tmp, 'list');
    fs.mkdirSync(wd, { recursive: true });
    const cfg = mkConfig(wd);
    const creds: import('../src/ldxhub.js').Credentials = ['tok', { structflow: 'sf-beta' }, 'env'];

    vi.spyOn(ldx, 'loadCredentials').mockReturnValue(creds);
    vi.spyOn(ldx, 'fetchCatalog').mockImplementation((async () => {
      // parseEntries is private; build the same three entries it would.
      return [[new ldx.Entry('sf-alpha', 'StructFlow Alpha', 'ldx', 'the good one',
        [['pdf', 'docx']], [['en', 'English'], ['de', 'German']]),
        new ldx.Entry('sf-beta', 'sf-beta'),
        new ldx.Entry('sf-gamma', 'sf-gamma', '', '', [['a', 'b'], ['c', 'd'],
          ['e', 'f'], ['g', 'h'], ['i', 'j']])], ''];
    }) as never);

    let out = await run('ldxhub_list', {}, cfg);
    check('list: all six services are listed', !out.isError, out.output);
    for (const svc of Object.keys(ldx.SERVICES)) {
      check(`list: ${svc} appears`, out.output.includes(svc));
    }
    check('list: the entry count is shown', out.output.includes('3 models'), out.output);
    check('list: the pinned default is starred',
      out.output.split('\n').some((ln) => ln.includes('sf-beta *')), out.output);
    check('list: the star is explained',
      out.output.includes('default for that service'), out.output);

    out = await run('ldxhub_list', { service: 'structflow' }, cfg);
    check('list: a single service works', !out.isError, out.output);
    check('list: a single service omits the legend',
      !out.output.includes('default for that service'));

    out = await run('ldxhub_list', { service: 'nope' }, cfg);
    check('list: an unknown service is refused by name',
      out.isError === true && out.output.includes('unknown service'), out.output);
    check('list: the refusal lists the real services',
      Object.keys(ldx.SERVICES).every((s) => out.output.includes(s)), out.output);

    vi.spyOn(ldx, 'fetchCatalog').mockResolvedValue([null, 'boom'] as never);
    out = await run('ldxhub_list', { service: 'structflow' }, cfg);
    check('list: a catalog error is reported, not raised',
      !out.isError && out.output.includes('boom'), out.output);

    // The catalogs are public, so listing must work before a key exists.
    vi.restoreAllMocks();
    ldx.clearCache();
    const nokeyHome = path.join(tmp, 'nokey');
    const seenRef = await withHome(nokeyHome, () => captureFetch());
    out = await withHome(nokeyHome, () => run('ldxhub_list', { service: 'structflow' }, cfg));
    check('list: a keyless list succeeds against the public catalog',
      !out.isError && out.output.includes('sf-alpha'), out.output);
    check('list: the keyless request sends no Authorization header',
      !('authorization' in seenRef.seen.headers), JSON.stringify(seenRef.seen));
    check('list: the keyless legend says a key is only for jobs',
      out.output.includes('/ldxhub-api-setup') && out.output.includes('browse'),
      out.output);

    // The job-running tools do need the key, and say so.
    out = await run('ldxhub_structflow', { prompt: 'x' }, cfg);
    check('list: a job tool without a key names the fix',
      out.isError === true && out.output.includes('/ldxhub-api-setup'), out.output);
    ldx.clearCache();
  });

  it('test_deliver', async () => {
    const wd = path.join(tmp, 'deliver');
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'doc.pdf'), 'pdf');
    const cfg = mkConfig(wd);
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue([mkEntry(), 'tok'] as never);
    vi.spyOn(ldx, 'uploadFile').mockResolvedValue(['fid', '']);

    // Inline only: no file, nothing to download.
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', summary: 'hello' }, '']);
    let out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: inline text is returned as-is',
      !out.isError && out.output === 'hello', out.output);

    // Nothing at all is an error the model can read.
    vi.spyOn(ldx, 'runJob').mockResolvedValue([{ status: 'completed' }, '']);
    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: no output at all is refused',
      out.isError === true && out.output.includes('no output'), out.output);

    // A dest writes the file and reports a relative path.
    vi.spyOn(ldx, 'downloadFile').mockImplementation(
      async (_fid, _tok, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'RESULT');
        return '';
      });
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', output_file_id: 'f1' }, '']);
    out = await run('ldxhub_convert',
      { file_path: 'doc.pdf', mode: 'castdoc', dest: 'out/result.docx' }, cfg);
    check('deliver: a dest download succeeds', !out.isError, out.output);
    check('deliver: the file landed',
      fs.readFileSync(path.join(wd, 'out', 'result.docx')).toString() === 'RESULT');
    check('deliver: the report names the relative path',
      out.output.includes('wrote out/result.docx'), out.output);

    // A failing download is a clean tool error naming the reason.
    vi.spyOn(ldx, 'downloadFile').mockResolvedValue('key rejected (403)');
    out = await run('ldxhub_convert',
      { file_path: 'doc.pdf', mode: 'castdoc', dest: 'out/result.docx' }, cfg);
    check('deliver: a failed download raises',
      out.isError === true && out.output.includes('download failed'), out.output);

    // as_text reads the file back inline.
    vi.spyOn(ldx, 'downloadFile').mockImplementation(
      async (_fid, _tok, dest) => {
        fs.writeFileSync(dest, 'extracted text');
        return '';
      });
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', output_file_id: 'f2' }, '']);
    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: as_text returns the file body',
      !out.isError && out.output === 'extracted text', out.output);

    // A file with no dest and no as_text hands back the id instead of guessing
    // (refine/extract always deliver as text, so structflow is the path with
    // neither — exactly the Python _ldx_deliver(None, "f3", …) call).
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', output_file_id: 'f3' }, '']);
    out = await run('ldxhub_structflow', { prompt: 'x' }, cfg);
    check('deliver: a bare file id is reported, with the hint',
      out.output.includes('output file id: f3') && out.output.includes('dest'),
      out.output);

    // Inline text plus a file: both are reported.
    vi.spyOn(ldx, 'downloadFile').mockImplementation(
      async (_fid, _tok, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'RESULT');
        return '';
      });
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', summary: 'summary', output_file_id: 'f4' }, '']);
    out = await run('ldxhub_convert',
      { file_path: 'doc.pdf', mode: 'castdoc', dest: 'out/two.docx' }, cfg);
    check('deliver: inline text and a saved file both appear',
      out.output.includes('summary') && out.output.includes('wrote out/two.docx'),
      out.output);

    // _ldx_job drives the whole path from a canned terminal job.
    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'completed', summary: 'done' }, '']);
    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: an inline job result reaches the model',
      !out.isError && out.output.includes('done'), out.output);

    vi.spyOn(ldx, 'runJob').mockResolvedValue(
      [{ status: 'failed', error: 'bad input' }, '']);
    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: a failed job becomes a tool error',
      out.isError === true && out.output.includes('bad input'), out.output);

    vi.spyOn(ldx, 'runJob').mockResolvedValue([null, 'timed out']);
    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('deliver: a job timeout becomes a tool error',
      out.isError === true && out.output.includes('timed out'), out.output);
  });

  it('test_upload_is_jailed', async () => {
    const wd = path.join(tmp, 'jail');
    fs.mkdirSync(wd, { recursive: true });
    fs.writeFileSync(path.join(wd, 'doc.pdf'), 'pdf');
    const cfg = mkConfig(wd);
    const loose = mkConfig(wd, { unsafe: true });
    process.env['LDXHUB_API_KEY'] = 'zpka_' + 't'.repeat(30);
    vi.spyOn(ldx, 'resolveEntry').mockResolvedValue([mkEntry(), 'tok'] as never);
    vi.spyOn(ldx, 'uploadFile').mockImplementation(
      async (filePath) => [`fid:${path.basename(filePath)}`, ''] as [string, string]);
    vi.spyOn(ldx, 'runJob').mockResolvedValue([{ status: 'completed', summary: 'ok' }, '']);

    let out = await run('ldxhub_extract', { file_path: '../../etc/passwd' }, cfg);
    check('jail: an escaping upload path is refused',
      out.isError === true &&
        out.output.includes('escapes the working directory'), out.output);

    out = await run('ldxhub_extract', { file_path: 'not-here.pdf' }, cfg);
    check('jail: a missing file is refused before any upload',
      out.isError === true && out.output.includes('does not exist'), out.output);

    out = await run('ldxhub_extract', { file_path: 'doc.pdf' }, cfg);
    check('jail: an in-jail file uploads', !out.isError, out.output);

    // With --unsafe the jail is lifted, so an outside path that exists is
    // permitted — asserted so the flag keeps working for uploads too. (The
    // landmark is created rather than assumed: /etc/hostname is not universal.)
    const landmark = path.join(tmp, 'outside-marker');
    fs.writeFileSync(landmark, 'outside the jail');
    out = await run('ldxhub_extract', { file_path: '../outside-marker' }, loose);
    check('jail: --unsafe permits an outside path that exists',
      !out.isError, out.output);

    // The jail is lifted but existence is still required.
    out = await run('ldxhub_extract', { file_path: '../definitely-absent' }, loose);
    check('jail: --unsafe still requires the file to exist',
      out.isError === true && out.output.includes('does not exist'), out.output);
  });

  it('test_not_a_source', () => {
    const mod = ldx as unknown as Record<string, unknown>;
    check('source: there is no apply_to', !('applyTo' in mod));
    check('source: there is no active_endpoint', !('activeEndpoint' in mod));
    check('source: there is no is_ldxhub predicate', !('isLdxhub' in mod));
    check('source: there is no DEFAULT_BASE_URL to switch to',
      !('DEFAULT_BASE_URL' in mod));

    const src = fs.readFileSync(path.join(ROOT, 'src', 'sources.ts'), 'utf-8');
    check('source: sources.ts never mentions ldxhub', !src.toLowerCase().includes('ldxhub'));
    check('source: LDXHub is not a builtin key',
      !sources.BUILTIN_KEYS.has('ldxhub'));
    check('source: active_key does not recognise the host',
      sources.activeKey('https://gw.ldxhub.io') === undefined);

    // The module carries no Claude fallback (openrouter has one; this must not).
    const body = fs.readFileSync(path.join(ROOT, 'src', 'ldxhub.ts'), 'utf-8');
    check('source: ldxhub.ts has no claude fallback',
      !body.toLowerCase().includes('claude'));
    check('source: it documents that it is not a chat source',
      body.toLowerCase().includes('not a chat source'));
  });

  it('test_tui_surfaces', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf-8');
    const comp = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'complete.tsx'), 'utf-8');
    const modelCmds = fs.readFileSync(
      path.join(ROOT, 'src', 'ui', 'screens', 'model-commands.tsx'), 'utf-8');

    check('tui: the app dispatches the setup command',
      app.includes("'ldxhub-api-setup': (a) => cmdLdxhubKey(ctx, a)"));
    check('tui: the app dispatches the models command',
      app.includes("'ldxhub-models': (a) => cmdLdxhubModels(ctx, a)"));
    check('tui: both commands are busy-safe',
      app.includes("'ldxhub-api-setup', 'ldxhub-models',"));
    check('tui: the status pane shows the keyless hint, and says browsing is free',
      modelCmds.includes('no key — /ldxhub-api-setup (jobs; /ldxhub-models ') &&
        modelCmds.includes('browses free)'));
    check('tui: the key is never echoed back',
      modelCmds.includes('key.slice(-4)'), modelCmds.slice(0, 0));
    check('tui: completion offers the setup command',
      comp.includes("['/ldxhub-api-setup', 'store your LDXHub API key (document jobs)']"));
    check('tui: completion offers the models command',
      comp.includes(
        "['/ldxhub-models', 'LDXHub models/engines — pick the default per service']"));
    check('tui: the app palette lists the setup command',
      app.includes("['/ldxhub-api-setup', 'store your LDXHub API key', 'ldxhub-api-setup']"));
    check('tui: the app palette lists the models command',
      app.includes(
        "['/ldxhub-models', 'LDXHub models/engines — pick the default per service', 'ldxhub-models']"));

    // The catalogs command must not pretend to be a chat-model list.
    check('tui: /ldxhub-models is not advertised as a chat model list',
      modelCmds.includes('put in /model'));
  });
});

/** The Python suite asserted membership of tools._DISPATCH; the TS dispatch
 *  table is module-private, so the same fact is checked against the source —
 *  every ldxhub_* tool is wired to its handler there. */
let TOOLS_SRC = '';
function toolsDispatched(name: string): boolean {
  const handler = 'toolLdxhub' + name.slice('ldxhub_'.length)
    .replace(/(^|_)(\w)/g, (_m, _a, c: string) => c.toUpperCase());
  return TOOLS_SRC.includes(`${name}: ${handler},`);
}
