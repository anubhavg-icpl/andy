/**
 * tests/test_logfare.test.ts — vitest port of tests/test_logfare.py.
 *
 * Regression suite for the live Logfare catalog. The load-bearing rule is
 * the endpoint filter: an entry is a chat model only if it advertises
 * `chat/completions` — get that wrong and /model offers an image or TTS
 * model, which is the same bug (a name the upstream 404s) in a new costume.
 *
 * No test here touches the network: every fetch is served by a stubbed
 * global fetch, and cache expiry is driven by faking `performance` (the TS
 * port's monotonic clock) rather than by reaching into the module-private
 * cache the way the Python suite reached into `logfare._CACHE`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as lf from '../src/logfare.js'
import * as s from '../src/sources.js'
import { DEFAULT_MODEL, KNOWN_MODELS, PRICING } from '../src/config.js'

const PROXY = 'http://localhost:4001'

// A payload shaped like the real one: two healthy chat models, one degraded
// chat model, and three that do NOT serve chat (image, TTS, STT) — those must
// be filtered out, and they are the whole point of the suite.
const CATALOG = {
  object: 'list',
  overall_status: 'operational',
  overall_uptime_percent: 83.6,
  window_hours: 24,
  data: [
    { model_id: 'deepseek-v4.1-flash', display_name: 'Deepseek v4.1 Flash',
      status: 'operational', uptime_percent: 93.6, checks: 0,
      last_checked: null, endpoints: ['chat/completions'],
      real_traffic_total: 27701, real_traffic_success_rate: 0.936 },
    { model_id: 'qwen-3.8-27b', display_name: 'Qwen 3.8 27B',
      status: 'operational', uptime_percent: 83.7,
      endpoints: ['chat/completions'],
      real_traffic_total: 4000, real_traffic_success_rate: 0.835 },
    { model_id: 'gemma-4-26b', display_name: 'Gemma 4 26B',
      status: 'unstable', uptime_percent: 40.7,
      endpoints: ['chat/completions'],
      real_traffic_total: 3981, real_traffic_success_rate: 0.407 },
    // Not chat — must never reach /model.
    { model_id: 'flux-1.1-pro', display_name: 'Flux',
      status: 'operational', uptime_percent: 99.0,
      endpoints: ['images/generations'], real_traffic_total: 120 },
    { model_id: 'aura-2-en', display_name: 'Aura',
      status: 'operational', uptime_percent: 99.0,
      endpoints: ['audio/speech'], real_traffic_total: 90 },
    { model_id: 'whisper-large-v3-turbo', display_name: 'Whisper',
      status: 'operational', uptime_percent: 99.0,
      endpoints: ['audio/transcriptions'], real_traffic_total: 40 },
  ],
}

/** Enough of a Response for logfare's fetch: ok/status/text(). */
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

/**
 * The TS equivalent of the Python suite's `_stub_urlopen`: swap global fetch.
 * `payload === null` with a status makes an HTTP error; `error` makes the
 * fetch itself reject, which is what urllib.error.URLError was.
 */
function stubFetch(
  payload: unknown = CATALOG,
  opts: { error?: Error; status?: number } = {},
): () => Promise<StubResponse> {
  return () => {
    if (opts.error) throw opts.error
    return Promise.resolve(new StubResponse(payload === null ? '' : JSON.stringify(payload), opts.status ?? 200))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('logfare catalog', () => {
  it('test_chat_filter: only entries advertising chat/completions are offered as models', async () => {
    lf.clearCache()
    vi.stubGlobal('fetch', stubFetch())
    const [models, err] = await lf.fetchModels({ useCache: false })
    // fetch: a good response parses
    expect(err).toBe('')
    expect(models).not.toBeNull()
    const ids = (models ?? []).map((m) => m.id)
    // filter: exactly the three chat models
    expect(ids).toEqual(['deepseek-v4.1-flash', 'qwen-3.8-27b', 'gemma-4-26b'])
    // filter: each non-chat entry is excluded
    for (const gone of ['flux-1.1-pro', 'aura-2-en', 'whisper-large-v3-turbo']) {
      expect(ids).not.toContain(gone)
    }
  })

  it('test_health_is_read: status, uptime and traffic come through, and drive healthy', async () => {
    lf.clearCache()
    vi.stubGlobal('fetch', stubFetch())
    const [models] = await lf.fetchModels({ useCache: false })
    const byId = new Map((models ?? []).map((m) => [m.id, m]))

    const ds = byId.get('deepseek-v4.1-flash')!
    // health: status/uptime/traffic/success rate are read
    expect(ds.status).toBe('operational')
    expect(ds.uptime).toBe(93.6)
    expect(ds.traffic).toBe(27701)
    expect(ds.successRate).toBe(0.936)
    // health: an operational model is healthy
    expect(ds.healthy).toBe(true)

    const gemma = byId.get('gemma-4-26b')!
    // health: an unstable model is not healthy
    expect(gemma.healthy).toBe(false)
    // health: the blurb names the problem
    expect(gemma.blurb).toContain('unstable')
  })

  it('test_parse_is_total: a malformed entry degrades; it never takes the catalog down', async () => {
    // Python called the private _parse_models directly; the TS port keeps
    // parseModels unexported, so the same parser is exercised through a
    // fetch that serves the messy payload. Same assertions, same code path.
    lf.clearCache()
    vi.stubGlobal(
      'fetch',
      stubFetch({
        data: [
          { model_id: 'ok', endpoints: ['chat/completions'],
            uptime_percent: 'nonsense', real_traffic_total: 'nonsense' },
          { no_id: true, endpoints: ['chat/completions'] },
          'not-a-dict',
          { model_id: 'no-endpoints' },
          { model_id: 'endpoints-not-a-list', endpoints: 'chat/completions' },
          { model_id: '', endpoints: ['chat/completions'] },
        ],
      }),
    )
    const [messy, err] = await lf.fetchModels({ useCache: false })
    expect(err).toBe('')
    // parse: only the one usable entry survives
    expect(messy?.map((m) => m.id)).toEqual(['ok'])
    // parse: a bad uptime degrades to 0, not a crash
    expect(messy?.[0]?.uptime).toBe(0)
    // parse: a bad traffic count degrades to 0
    expect(messy?.[0]?.traffic).toBe(0)
  })

  it('test_fetch_is_total: fetchModels returns errors; it never raises into the TUI', async () => {
    lf.clearCache()
    vi.stubGlobal('fetch', stubFetch(null, { error: new TypeError('no route') }))
    let [models, err] = await lf.fetchModels({ useCache: false })
    // fetch: a network failure returns None and a message
    expect(models).toBeNull()
    expect(err).toContain('could not reach')
    // fetch: a failed fetch does not populate the cache
    expect(lf.cachedIds()).toBeNull()

    vi.stubGlobal('fetch', stubFetch(null, { status: 503 }))
    ;[models, err] = await lf.fetchModels({ useCache: false })
    // fetch: an HTTP error says so
    expect(models).toBeNull()
    expect(err).toContain('503')
  })

  it('test_cache: a warm cache answers without a second request; clearCache empties it', async () => {
    lf.clearCache()
    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      () => {
        calls.push(1)
        return Promise.resolve(new StubResponse(JSON.stringify(CATALOG)))
      },
    )
    await lf.fetchModels()
    await lf.fetchModels() // must be served from the cache
    // cache: a second fetch does not hit the network
    expect(calls.length).toBe(1)
    // cache: cached_ids reports the catalog
    expect(lf.cachedIds()).toEqual(['deepseek-v4.1-flash', 'qwen-3.8-27b', 'gemma-4-26b'])
    lf.clearCache()
    // cache: clear_cache empties it
    expect(lf.cachedIds()).toBeNull()
  })

  it('test_cache_expiry: an expired catalog must not be served as if it were live', async () => {
    // The bug this pins: fetch_models has always refused to *reuse* an entry
    // past CACHE_TTL, but cached_models read it back regardless — so a catalog
    // fetched once at startup was reported by /model for the rest of the
    // session, under the words "the catalog is live". Nothing here sleeps:
    // the monotonic clock (performance) is faked and advanced, which is the
    // same thing to a TTL comparison and costs no time.
    vi.useFakeTimers({ toFake: ['performance'] })
    lf.clearCache()
    // expiry: a cold cache has no age
    expect(lf.catalogAge()).toBeUndefined()

    vi.stubGlobal('fetch', stubFetch())
    await lf.fetchModels()
    // expiry: a fresh catalog is served, and its age is reported and small
    expect(lf.cachedIds()).not.toBeNull()
    expect(lf.catalogAge() ?? 999).toBeLessThan(5.0)

    // Age it well past the TTL — the state a long-running session reaches on
    // its own, with no code path having cleared the cache in between.
    vi.advanceTimersByTime((lf.CACHE_TTL + 60) * 1000)
    // expiry: an expired catalog reads as None
    expect(lf.cachedModels()).toBeNull()
    // expiry: cached_ids agrees
    expect(lf.cachedIds()).toBeNull()
    // expiry: the real age is still reported, unclamped
    expect(lf.catalogAge() ?? 0).toBeGreaterThanOrEqual(lf.CACHE_TTL)
    // expiry: sources.modelsFor falls back rather than serving it. (The TS
    // port moved the caller's declared-list fallback inside modelsFor, so
    // "falls back" reads as the declared list rather than undefined — the
    // guarantee the Python suite pinned at the caller.)
    expect(s.modelsFor(PROXY)).toEqual([...s.LOGFARE_MODELS])
    // expiry: sources.catalogFor agrees
    expect(s.catalogFor(PROXY)).toBeUndefined()
    // expiry: health_for finds nothing in an expired catalog
    expect(lf.healthFor('deepseek-v4.1-flash')).toBeUndefined()

    // A re-fetch is what makes it live again.
    vi.stubGlobal('fetch', stubFetch())
    await lf.fetchModels()
    // expiry: refetching restores it
    expect(lf.cachedIds()).not.toBeNull()
    lf.clearCache()
  })

  it('test_sources_prefers_live: the fetched list wins over the declared one', async () => {
    lf.clearCache()
    // sources: a cold cache falls back to the declared list (the TS port
    // performs the caller's LOGFARE_MODELS fallback inside modelsFor)
    expect(s.modelsFor(PROXY)).toEqual([...s.LOGFARE_MODELS])
    // sources: catalog_for is None when cold
    expect(s.catalogFor(PROXY)).toBeUndefined()

    vi.stubGlobal('fetch', stubFetch())
    await lf.fetchModels()
    const live = s.modelsFor(PROXY)
    // sources: a warm cache serves the live ids
    expect(live).toEqual(['deepseek-v4.1-flash', 'qwen-3.8-27b', 'gemma-4-26b'])
    // sources: the live list wins over the declared one
    expect(live).not.toEqual([...s.LOGFARE_MODELS])
    const catalog = s.catalogFor(PROXY)
    // sources: catalog_for serves the health objects
    expect(catalog).toBeDefined()
    expect(catalog!.length).toBe(3)
    // sources: catalog_for is None for a source with no catalog
    expect(s.catalogFor('http://localhost:4000')).toBeUndefined()
    // sources: catalog_for is None for an unknown endpoint
    expect(s.catalogFor('https://api.anthropic.com')).toBeUndefined()
  })

  it('test_declared_fallback_is_plausible: the declared fallback must not name retired models', () => {
    // The regression that started all of it: LOGFARE_MODELS listed ten models
    // that 404'd upstream, so /model offered them. The list cannot be kept
    // honest by a test — only a fetch can — but it can be kept *small*.
    // fallback: LOGFARE_MODELS is the four live models
    expect(new Set(s.LOGFARE_MODELS)).toEqual(
      new Set(['deepseek-v4.1-flash', 'gemma-4-26b', 'logfare/auto', 'qwen-3.8-27b']),
    )
    // fallback: KNOWN_MODELS agrees
    expect(new Set(KNOWN_MODELS)).toEqual(new Set(s.LOGFARE_MODELS))
    // A retired model must not still carry a price, or /cost quotes a 404.
    for (const dead of [
      'claude-opus-4.6', 'deepseek-v3.2', 'glm-5', 'grok-4.6',
      'kimi-k2.5', 'kimi-k2-thinking', 'gpt-oss-120b',
      'gemma-4-31b', 'space-bunny-alpha', 'claude-sonnet-4.6',
    ]) {
      expect(PRICING, `${dead} is gone from PRICING`).not.toHaveProperty(dead)
    }
    // The default model must be one the upstream actually serves.
    // fallback: DEFAULT_MODEL is in the fallback list
    expect(s.LOGFARE_MODELS).toContain(DEFAULT_MODEL)
  })

  it('test_is_logfare: the host test distinguishes the gateway from the local proxy', () => {
    // host: a local proxy is not the gateway
    expect(lf.isLogfare('http://localhost:4001')).toBe(false)
    // host: the gateway URL is
    expect(lf.isLogfare('https://logfare.ai/v1')).toBe(true)
    // host: the bare host is
    expect(lf.isLogfare('https://logfare.ai')).toBe(true)
    // host: None is not
    expect(lf.isLogfare(null)).toBe(false)
  })
})
