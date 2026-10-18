/**
 * tests/test_tokenharbour.test.ts — vitest port of tests/test_tokenharbour.py.
 *
 * Protects three things that are easy to break and expensive to notice:
 * credential precedence (environment beats the profile, the profile beats
 * ~/claude-source), the key file (mode 600, source-format, never echoed),
 * and the live catalog (free by `:free` suffix OR zero price; a failed fetch
 * returns an error rather than raising, because the caller is a TUI command).
 *
 * The Python suite pinned the module's paths by setting ZIMZILLA_HOME and
 * re-importing; the TS equivalent sets ANDY_HOME / ANDY_CLAUDE_SOURCE and
 * takes a fresh module instance via vi.resetModules() + dynamic import
 * (PROFILE and CLAUDE_SOURCE are computed at module load). Private helpers
 * (_parse_models, _read_exports, _CACHE) are unexported in the TS port, so
 * the same behavior is asserted through the public API, and cache expiry is
 * driven by faking `performance`.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ThNS from '../src/tokenharbour.js'

// A minimal catalog shaped like the real one: two free (one by suffix, one by
// a zero price with no suffix), two paid.
const CATALOG = {
  object: 'list',
  data: [
    { id: 'claude-haiku-5.5:free', label: 'Haiku', tier: 'mid',
      context_length: 1000000, tool_call: true,
      pricing: { input_usd_per_1m: 0, output_usd_per_1m: 0 } },
    { id: 'zero-priced', label: 'Zero', tier: 'low',
      context_length: 200000, tool_call: true,
      pricing: { input_usd_per_1m: 0.0, output_usd_per_1m: 0.0 } },
    { id: 'claude-opus-5.5', label: 'Opus', tier: 'high',
      context_length: 1000000, tool_call: true,
      pricing: { input_usd_per_1m: 4, output_usd_per_1m: 20 } },
    { id: 'grok-4.6', label: 'Grok', tier: 'frontier',
      context_length: 500000, tool_call: true,
      pricing: { input_usd_per_1m: 2, output_usd_per_1m: 6 } },
  ],
}

const PROFILE_TEXT =
  'export ANTHROPIC_BASE_URL="https://tokenharbor.ai/"\n' +
  'export ANTHROPIC_AUTH_TOKEN="thk_live_fromprofile0000000000"\n' +
  'export ANTHROPIC_MODEL="mimo-v2.5:free"\n' +
  'export ANTHROPIC_API_KEY=""\n'

/** Enough of a Response for tokenharbour's fetch: ok/status/text(). */
class StubResponse {
  ok: boolean
  status: number
  private readonly body: string
  constructor(body: string, status = 200) {
    this.status = status
    this.ok = status >= 200 && status < 300
    this.body = body
  }
  text(): Promise<string> {
    return Promise.resolve(this.body)
  }
}

/** The TS equivalent of the Python suite's `_stub_urlopen`. */
function stubFetch(
  payload: unknown = CATALOG,
  opts: { error?: Error; status?: number } = {},
): () => Promise<StubResponse> {
  return () => {
    if (opts.error) throw opts.error
    return Promise.resolve(new StubResponse(payload === null ? '' : JSON.stringify(payload), opts.status ?? 200))
  }
}

// Pin the module's paths to the temp tree before anything imports it — the
// TS equivalent of the Python main()'s env + sys.modules purge.
const TMP = mkdtempSync(path.join(tmpdir(), 'andy-th-test-'))
const HOME = path.join(TMP, '.andy')
const CLAUDE_SOURCE = path.join(TMP, 'claude-source')

const SAVED: Array<[string, string | undefined]> = []
const ENV_KEYS = [
  'ANDY_HOME',
  'ANDY_CLAUDE_SOURCE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
]

/** A fresh tokenharbour module under the current env (paths are load-time). */
async function fresh(): Promise<typeof ThNS> {
  vi.resetModules()
  return await import('../src/tokenharbour.js')
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED.push([k, process.env[k]])
  mkdirSync(CLAUDE_SOURCE, { recursive: true })
})

beforeEach(() => {
  // Baseline env: temp home (profile absent until a test writes it) and the
  // temp claude-source tree; no ambient Anthropic credentials.
  process.env['ANDY_HOME'] = HOME
  process.env['ANDY_CLAUDE_SOURCE'] = CLAUDE_SOURCE
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
    delete process.env[k]
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

afterAll(() => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(TMP, { recursive: true, force: true })
})

describe('tokenharbour', () => {
  it('test_free_detection: free is the suffix OR a zero price — either signal alone is enough', async () => {
    const th = await fresh()
    vi.stubGlobal('fetch', stubFetch())
    // (Python parsed CATALOG directly; the unexported parseModels is reached
    // through a stubbed fetch — same parser, same assertions.)
    const [models] = await th.fetchModels('k', { useCache: false })
    th.clearCache()
    const byId = new Map((models ?? []).map((m) => [m.id, m]))
    // catalog: every entry parsed
    expect(models?.length).toBe(4)
    // catalog: a :free suffix is free
    expect(byId.get('claude-haiku-5.5:free')!.free).toBe(true)
    // catalog: a zero price with no suffix is free
    expect(byId.get('zero-priced')!.free).toBe(true)
    // catalog: a priced model is not free
    expect(byId.get('claude-opus-5.5')!.free).toBe(false)
    // catalog: prices are read
    expect(byId.get('grok-4.6')!.priceIn).toBe(2.0)
    expect(byId.get('grok-4.6')!.priceOut).toBe(6.0)
    // catalog: context is read
    expect(byId.get('claude-opus-5.5')!.contextLength).toBe(1_000_000)

    const free = (models ?? []).filter((m) => m.free).map((m) => m.id)
    // catalog: exactly the two free ones
    expect([...free].sort()).toEqual(['claude-haiku-5.5:free', 'zero-priced'])

    // A malformed entry must not take the whole catalog down.
    vi.stubGlobal(
      'fetch',
      stubFetch({
        data: [
          { id: 'ok', pricing: { input_usd_per_1m: 'nonsense' } },
          { no_id: true },
          'not-a-dict',
          { id: 'no-pricing' },
        ],
      }),
    )
    const [messy] = await th.fetchModels('k', { useCache: false })
    th.clearCache()
    // catalog: a bad price degrades to 0, not a crash; junk entries skip
    expect(messy?.map((m) => m.id)).toEqual(['ok', 'no-pricing'])
  })

  it('test_fetch_is_total: fetchModels returns errors; it never raises into the TUI', async () => {
    const th = await fresh()
    vi.stubGlobal('fetch', stubFetch())
    let [models, err] = await th.fetchModels('k', { useCache: false })
    // fetch: a good response parses
    expect(err).toBe('')
    expect(models?.length).toBe(4)
    // fetch: the result is cached
    expect(th.cachedIds()?.length).toBe(4)

    th.clearCache()
    vi.stubGlobal('fetch', stubFetch(null, { error: new TypeError('no route') }))
    ;[models, err] = await th.fetchModels('k', { useCache: false })
    // fetch: a network failure returns None and a message
    expect(models).toBeNull()
    expect(err).toContain('could not reach')

    th.clearCache()
    vi.stubGlobal('fetch', stubFetch(null, { status: 401 }))
    ;[models, err] = await th.fetchModels('k', { useCache: false })
    // fetch: a rejected key says so
    expect(models).toBeNull()
    expect(err).toContain('401')
  })

  it('test_cache_is_keyed_by_token: a different key must not be served the previous key’s catalog', async () => {
    const th = await fresh()
    th.clearCache()
    vi.stubGlobal('fetch', stubFetch())
    await th.fetchModels('key-a')
    // cache: key-a is cached
    expect(th.cachedIds()).not.toBeNull()
    // key-b has no cache entry, so it must hit the network.
    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      () => {
        calls.push(1)
        return Promise.resolve(new StubResponse(JSON.stringify({ data: [] })))
      },
    )
    const [models] = await th.fetchModels('key-b')
    // cache: a new key fetches rather than reusing another's list
    expect(calls.length).toBe(1)
    expect(models).toEqual([])
  })

  it('test_cache_expiry: an expired catalog must not be served as if it were live', async () => {
    // Nothing sleeps: the module's monotonic clock (performance.now) is
    // faked and advanced past CACHE_TTL, which is the same thing to a TTL
    // comparison. (Python rewrote the private _CACHE timestamp instead.)
    vi.useFakeTimers({ toFake: ['performance'] })
    const th = await fresh()
    th.clearCache()
    // expiry: a cold cache has no age
    expect(th.catalogAge()).toBeUndefined()

    vi.stubGlobal('fetch', stubFetch())
    await th.fetchModels('key-a')
    // expiry: a fresh catalog is served, and its age is reported and small
    expect(th.cachedIds()).not.toBeNull()
    expect(th.catalogAge() ?? 999).toBeLessThan(5.0)

    vi.advanceTimersByTime((th.CACHE_TTL + 60) * 1000)
    // expiry: an expired catalog reads as None
    expect(th.cachedModels()).toBeNull()
    // expiry: cached_ids agrees
    expect(th.cachedIds()).toBeNull()
    // expiry: the real age is still reported, unclamped
    expect(th.catalogAge() ?? 0).toBeGreaterThanOrEqual(th.CACHE_TTL)

    vi.stubGlobal('fetch', stubFetch())
    await th.fetchModels('key-a')
    // expiry: refetching restores it
    expect(th.cachedIds()).not.toBeNull()
    th.clearCache()
  })

  it('test_free_models_only', async () => {
    const th = await fresh()
    th.clearCache()
    vi.stubGlobal('fetch', stubFetch())
    const [free, err] = await th.freeModels('k', { useCache: false })
    th.clearCache()
    // free_models: only the free ones
    expect(err).toBe('')
    expect(free?.map((m) => m.id)).toEqual(['claude-haiku-5.5:free', 'zero-priced'])
  })

  it('test_profile_roundtrip: save_key writes mode 600, in a format the parser reads back', async () => {
    const th = await fresh()
    const token = 'thk_live_saved0000000000000000'
    const p = th.saveKey(token, 'mimo-v2.5:free')
    // key: written where load_credentials looks
    expect(p).toBe(th.PROFILE)
    const mode = statSync(p).mode & 0o777
    // key: the file is mode 600
    expect(mode).toBe(0o600)
    const parentMode = statSync(path.dirname(p)).mode & 0o777
    // key: the directory is mode 700
    expect(parentMode).toBe(0o700)

    // key: the token and model round-trip through the reader load_credentials
    // uses (Python called the private _read_exports; the public read is the
    // same parser pointed at the same file).
    const creds = th.loadCredentials()
    expect(creds?.[0]).toBe(token)
    expect(creds?.[1]).toBe('mimo-v2.5:free')

    const text = readFileSync(p, 'utf-8')
    // key: the endpoint written into the profile is the gateway (trailing
    // slash is deliberate — profiles in the wild carry it)
    expect(text).toContain('export ANTHROPIC_BASE_URL="https://tokenharbor.ai/')
    // The file must be sourceable by a shell, like every other profile.
    // key: the file is source-format (four export lines)
    expect(text.split('export ').length - 1).toBe(4)
  })

  it('test_looks_like_key', async () => {
    const th = await fresh()
    // key: a real-looking key passes
    expect(th.looksLikeKey('thk_live_rcYcM3enKGzKrtuhxdJBzN3QWNW10KlFFvxs5rpz')).toBe(true)
    // key: a short string is rejected
    expect(th.looksLikeKey('abc')).toBe(false)
    // key: a pasted export line is rejected
    expect(th.looksLikeKey('export ANTHROPIC_AUTH_TOKEN="thk_live_xxx"')).toBe(false)
    // key: whitespace is rejected
    expect(th.looksLikeKey('thk_live_aaaaaaaaaaaaaaaaaaaa bbbb')).toBe(false)
  })

  it('test_active_key_recognises_host: a hosted URL has no port, so it must be matched by host', async () => {
    await fresh() // tokenharbour must be in the (lazily shared) module graph
    const s = await import('../src/sources.js')
    // sources: the gateway host is the tokenharbour source
    expect(s.activeKey('https://tokenharbor.ai/')).toBe('tokenharbour')
    // sources: with no trailing slash too
    expect(s.activeKey('https://tokenharbor.ai')).toBe('tokenharbour')
    // sources: a local proxy is still itself
    expect(s.activeKey('http://localhost:4001')).toBe('logfare')
    // sources: an unrelated host is unknown
    expect(s.activeKey('https://api.example.com')).toBeUndefined()
  })

  it('test_credential_precedence: environment beats the profile; the profile beats ~/claude-source', async () => {
    // The claude-source fallback tree.
    writeFileSync(path.join(CLAUDE_SOURCE, 'haiku-5.5'), PROFILE_TEXT)

    // Scenario 1: no profile of our own — falls back to ~/claude-source.
    process.env['ANDY_HOME'] = path.join(TMP, 'homes', 'none')
    let th = await fresh()
    let creds = th.loadCredentials()
    // creds: falls back to ~/claude-source
    expect(creds).not.toBeNull()
    expect(creds![2].endsWith('haiku-5.5')).toBe(true)
    // creds: the model comes from that profile
    expect(creds![1]).toBe('mimo-v2.5:free')

    // Scenario 2: a profile of our own must win.
    const ownHome = path.join(TMP, 'homes', 'own')
    mkdirSync(path.join(ownHome, 'tokenharbour'), { recursive: true })
    writeFileSync(
      path.join(ownHome, 'tokenharbour', 'source'),
      'export ANTHROPIC_AUTH_TOKEN="thk_live_ownprofile000000000"\n',
    )
    process.env['ANDY_HOME'] = ownHome
    th = await fresh()
    creds = th.loadCredentials()
    // creds: Andy's own profile beats ~/claude-source
    expect(creds).not.toBeNull()
    expect(creds![2]).toBe(th.PROFILE)

    // Scenario 3: and the environment beats both.
    process.env['ANTHROPIC_BASE_URL'] = 'https://tokenharbor.ai/'
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'thk_live_fromenv00000000000000'
    process.env['ANTHROPIC_MODEL'] = 'claude-haiku-5.5:free'
    creds = th.loadCredentials()
    // creds: the environment beats every file
    expect(creds![2]).toBe('environment')
    expect(creds![0]).toBe('thk_live_fromenv00000000000000')
    // creds: the environment's model is used
    expect(creds![1]).toBe('claude-haiku-5.5:free')

    // An env key pointed at ANOTHER host must not be mistaken for ours.
    process.env['ANTHROPIC_BASE_URL'] = 'https://elsewhere.example.com'
    creds = th.loadCredentials()
    // creds: an env key for another host is ignored
    expect(creds![2]).toBe(th.PROFILE)
  })

  it('test_apply_and_guard: apply_to aims a config; the guard keeps a stale choice from hijacking', async () => {
    // apply, with credentials present: give the module a home whose profile
    // carries the key (Python mocked load_credentials; the real reader
    // pointed at a real file is the same contract).
    const keyedHome = path.join(TMP, 'homes', 'keyed')
    mkdirSync(path.join(keyedHome, 'tokenharbour'), { recursive: true })
    writeFileSync(
      path.join(keyedHome, 'tokenharbour', 'source'),
      'export ANTHROPIC_AUTH_TOKEN="thk_live_x000000000000000000"\n' +
        'export ANTHROPIC_MODEL="mimo-v2.5:free"\n',
    )
    process.env['ANDY_HOME'] = keyedHome
    const th = await fresh()
    const cfg = {
      baseUrl: 'http://localhost:4001',
      authToken: 'leftover-from-logfare',
      apiKey: 'sk-leftover',
      model: 'deepseek-v4.1-flash',
    }
    const applied = th.applyTo(cfg)
    // apply: returns the origin and model
    expect(applied![0]).toBe(th.PROFILE)
    expect(applied![1]).toBe('mimo-v2.5:free')
    // apply: the endpoint is the gateway
    expect(cfg.baseUrl).toBe(th.DEFAULT_BASE_URL)
    // apply: the token is set
    expect(cfg.authToken.startsWith('thk_live_')).toBe(true)
    // apply: the stale api_key is cleared
    expect(cfg.apiKey).toBe('')
    // apply: the model is applied
    expect(cfg.model).toBe('mimo-v2.5:free')

    // apply, with no key anywhere: an empty home and an empty claude-source
    // leave the config alone. (Python mocked load_credentials to None.)
    process.env['ANDY_HOME'] = path.join(TMP, 'homes', 'empty')
    process.env['ANDY_CLAUDE_SOURCE'] = path.join(TMP, 'homes', 'empty-source')
    const th2 = await fresh()
    const cfg2 = {
      baseUrl: 'http://localhost:4001',
      authToken: '',
      apiKey: '',
      model: 'deepseek-v4.1-flash',
    }
    // apply: no key leaves the config alone
    expect(th2.applyTo(cfg2)).toBeNull()
    expect(cfg2.baseUrl).toBe('http://localhost:4001')

    // The guard: which endpoints a remembered choice may override.
    // guard: the default local proxy is overridable
    expect(th2.appliesToDefaultEndpoint('http://localhost:4001')).toBe(true)
    // guard: an empty endpoint is overridable
    expect(th2.appliesToDefaultEndpoint('')).toBe(true)
    // guard: the gateway itself is NOT overridden
    expect(th2.appliesToDefaultEndpoint('https://tokenharbor.ai/')).toBe(false)
    // guard: another host is NOT overridden
    expect(th2.appliesToDefaultEndpoint('https://api.example.com')).toBe(false)
  })

  it('test_selection_file_is_shared: the selection file is the same one sources reads', async () => {
    const th = await fresh()
    await th.setCurrent('tokenharbour')
    const s = await import('../src/sources.js')
    // selection: sources sees the tokenharbour choice
    expect(s.currentKey()).toBe('tokenharbour')
    // selection: tokenharbour sees it too
    expect(await th.currentKey()).toBe('tokenharbour')
  })

  it('test_no_key_is_echoed: the display value is a path, never the key itself', async () => {
    const ownHome = path.join(TMP, 'homes', 'own2')
    mkdirSync(path.join(ownHome, 'tokenharbour'), { recursive: true })
    writeFileSync(
      path.join(ownHome, 'tokenharbour', 'source'),
      'export ANTHROPIC_AUTH_TOKEN="thk_live_secret00000000000000"\n',
    )
    process.env['ANDY_HOME'] = ownHome
    const th = await fresh()
    const creds = th.loadCredentials()
    const origin = creds![2]
    // display: the origin is a path, not a key
    expect(origin).not.toContain('thk_')
  })
})
