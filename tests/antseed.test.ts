// tests/antseed.test.ts — vitest port of tests/test_antseed.py: the
// regression suite for the AntSeed source.
//
// Protects what is particular about this provider (each a measured behaviour
// of the live network, not a guess):
//  - The pin is the feature: free peers sit below the router's minTrustScore,
//    so `freeModelIds` must hand back *pinned* `<peerId>@<model>` ids — bare
//    names look right and 502 on use.
//  - Free is a property of a peer (0 in AND 0 out), not of a model/tag.
//  - The catalog is OpenAI-shaped but must not be parsed as OpenAI's (pricing
//    lives in a nested `peers` array; a shared parser reads every model free).
//  - The endpoint is identified by port, not by name.
//  - There is no key: `looksLikeKey` is false for everything, and a fetch
//    sends no credential.
//
// No test here touches the network: every fetch is served by a stubbed
// global fetch (the Python original stubbed urllib's urlopen). The whole file
// runs under a temp $ANDY_HOME (set before the modules are imported, since
// antseed.ts resolves its profile path at import time), so the real
// ~/.andy — including the operator's current-source selection — is never
// touched.
//
// Every `check` name is preserved verbatim from the Python suite — they are
// named for the regressions they pin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '../src/antseed.js';

// --- module-load-order-sensitive setup ------------------------------------
//
// antseed.ts computes PROFILE (and reads ANTSEED_DATA_DIR) at import time, so
// the environment must be pinned BEFORE the dynamic import below. Static
// imports are hoisted above this code; dynamic ones are not — that is the
// whole reason the two module handles below are `await import`ed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-antseed-test-'));
process.env['ANDY_HOME'] = path.join(TMP, 'home');

// Stub profile/service/config files for both LiteLLM proxies so
// sources.discover() (and therefore activeKey's port match) is deterministic
// on any machine — the Python suite relied on the checkout's packaging/
// files and the operator's home for this, which made two of its assertions
// machine-dependent.
for (const key of ['logfare', 'tokenjuice']) {
  const dir = path.join(process.env['ANDY_HOME']!, key);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['source', 'start-litellm.sh', 'litellm-config.yaml']) {
    fs.writeFileSync(path.join(dir, f), 'test stub\n');
  }
}

const a = await import('../src/antseed.js');
const s = await import('../src/sources.js');

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  a.clearCache();
});

function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name} — ${extra}` : name).toBe(true);
}

// Shaped like the real response: `object`/`data`, every entry carrying a nested
// `peers` array whose members hold the pricing. The cases that matter:
//   - one free peer, high trust            → free and pinnable
//   - two free peers, one higher-trust     → the better one is pinned
//   - a free peer that is free-in/paid-out → NOT free
//   - no free peer at all                  → not free, not pinnable
//   - an entry with no peers               → must NOT read as free
const CATALOG = {
  object: 'list',
  data: [
    {
      id: 'glm-4.5-flash',
      name: 'GLM 4.5 Flash',
      type: 'text',
      aliases: ['glm-4.5-flash', 'glm45flash'],
      supported_protocols: ['openai-chat-completions'],
      capabilities: { contextWindow: 128000, maxOutputTokens: 16384, toolUse: true },
      peers: [
        {
          peerId: 'aaaa1111',
          displayName: 'refound',
          provider: 'openai',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          reputationScore: null,
          effectiveReputationScore: null,
        },
        {
          peerId: 'bbbb2222',
          displayName: 'Crimson',
          provider: 'openai',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          effectiveReputationScore: 44.58,
        },
      ],
    },
    {
      id: 'ling-3.1-flash',
      name: 'Ling 3.1 Flash',
      type: 'text',
      supported_protocols: ['openai-chat-completions'],
      capabilities: { contextWindow: 262144, toolUse: true, reasoning: true },
      peers: [
        {
          peerId: 'cccc3333',
          displayName: 'Relay Works',
          protocol: 'anthropic-messages',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          effectiveReputationScore: 65.22,
        },
      ],
    },
    {
      id: 'half-free',
      name: 'Half Free',
      type: 'text',
      supported_protocols: ['openai-chat-completions'],
      peers: [
        {
          peerId: 'dddd4444',
          displayName: 'Sneaky',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 3.5,
          effectiveReputationScore: 70.0,
        },
      ],
    },
    {
      // Two free peers, and the lower-trust one is the Anthropic one: the
      // only entry that can show protocol support outranking trust.
      // The live network has no such peer (every seller advertises OpenAI
      // only), so without this fixture that ordering rule is untested.
      id: 'dual-free',
      name: 'Dual Free',
      type: 'text',
      supported_protocols: ['openai-chat-completions', 'anthropic-messages'],
      peers: [
        {
          peerId: 'ffff6666',
          displayName: 'OpenAI Only',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          effectiveReputationScore: 80.0,
        },
        {
          peerId: 'gggg7777',
          displayName: 'Speaks Anthropic',
          protocol: 'anthropic-messages',
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          effectiveReputationScore: 20.0,
        },
        // A paid seller alongside the free ones, so the blurb has a
        // genuine "N of M" to render — all-free is the easy case.
        {
          peerId: 'hhhh8888',
          displayName: 'Costs Money',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 1.5,
          outputUsdPerMillion: 6.0,
          effectiveReputationScore: 90.0,
        },
      ],
    },
    {
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      type: 'text',
      supported_protocols: ['openai-chat-completions', 'anthropic-messages'],
      capabilities: { contextWindow: 200000, toolUse: true },
      peers: [
        {
          peerId: 'eeee5555',
          displayName: 'Best',
          protocol: 'openai-chat-completions',
          inputUsdPerMillion: 0.3449,
          outputUsdPerMillion: 1.1199,
          effectiveReputationScore: 63.77,
        },
      ],
    },
    {
      id: 'no-peers',
      name: 'Nobody Serves This',
      type: 'text',
      supported_protocols: [],
      peers: [],
    },
  ],
};

/** A fetch result good enough for the code under test (a real `Response`). */
function respOf(body: string, status = 200): Response {
  return new Response(body, { status });
}

/** A fetch replacement serving *payload* (CATALOG by default). */
function serve(
  payload: unknown = CATALOG,
): (url: unknown, init?: unknown) => Promise<Response> {
  return async () => respOf(JSON.stringify(payload));
}

/**
 * Parse a payload into Models. The Python tests called the private
 * `_parse_models` directly; the TS port keeps the parser module-private, so
 * the same objects are obtained through `fetchModels` over a stubbed fetch —
 * the exact code path production uses.
 */
async function parseCatalog(payload: unknown = CATALOG): Promise<Model[]> {
  a.clearCache();
  vi.stubGlobal('fetch', serve(payload));
  try {
    const [models, err] = await a.fetchModels('', { useCache: false });
    expect(err).toBe('');
    return models ?? [];
  } finally {
    vi.unstubAllGlobals();
    a.clearCache();
  }
}

async function catalogById(payload?: unknown): Promise<Map<string, Model>> {
  return new Map((await parseCatalog(payload)).map((m) => [m.id, m] as const));
}

describe('antseed regression suite', () => {
  // -------------------------------------------------------------------------
  // free detection
  // -------------------------------------------------------------------------

  it('test_free_is_a_peer_property', async () => {
    // Free is decided by the price on a seller, not by a tag or a suffix.
    const byId = await catalogById();

    check('free: a model with a zero-priced peer is free', byId.get('glm-4.5-flash')!.free);
    check('free: the free peers are the zero-priced ones', byId.get('glm-4.5-flash')!.freePeers.length === 2);
    check('free: a paid model is not free', !byId.get('claude-fable-5')!.free);
    check('free: free-in but paid-out is NOT free', !byId.get('half-free')!.free, '0 in / 3.5 out must not read as free');
    check('free: a model nobody serves is not free', !byId.get('no-peers')!.free);
    check('free: an entry with no peers does not read as free', byId.get('no-peers')!.peers.length === 0);
    // The distinction that a shared OpenAI parser would get wrong: an entry with
    // no pricing of its own is not thereby free.
    check('free: pricing is read from peers, not from the entry', (await parseCatalog({ data: [{ id: 'x' }] }))[0]!.free === false);
  });

  it('test_prices_are_per_million_floats', async () => {
    // AntSeed quotes per-million numbers; nothing is scaled on the way in.
    const byId = await catalogById();
    const c = byId.get('claude-fable-5')!.cheapest;
    check(
      'price: kept as per-million, unscaled',
      c !== null && c.priceIn === 0.3449 && c.priceOut === 1.1199,
      String(c ? [c.priceIn, c.priceOut] : null),
    );
    check('price: the cheapest peer is the one quoted', c !== null && c.peerId === 'eeee5555');
    const pf = a.priceFor('glm-4.5-flash', [...byId.values()]);
    check('price: a free model prices at zero', pf !== null && pf[0] === 0.0 && pf[1] === 0.0);
    // A malformed price must not take the catalog down, and must not invent a
    // free model: both directions have to be zero.
    const odd = (
      await parseCatalog({
        data: [
          {
            id: 'odd',
            peers: [{ peerId: 'z', inputUsdPerMillion: 'not-a-number', outputUsdPerMillion: 5 }],
          },
        ],
      })
    )[0]!;
    check('price: a malformed price degrades to 0, not to an exception', odd.peers[0]!.priceIn === 0.0);
    check('price: a malformed price does not make a model free', !odd.free, '0 in / 5 out is paid');
  });

  // -------------------------------------------------------------------------
  // the pin — the whole point of this module
  // -------------------------------------------------------------------------

  it('test_pin_composes_peer_at_model', async () => {
    // The pin is `<peerId>@<model>`, which is what makes a free model route.
    const byId = await catalogById();
    const pin = byId.get('glm-4.5-flash')!.pin();
    check(
      'pin: composes <peerId>@<model>',
      pin !== null && pin.endsWith('@glm-4.5-flash') && ['aaaa1111', 'bbbb2222'].includes(pin!.split('@')[0]!),
      String(pin),
    );
    check('pin: the bare model name is NOT returned', pin !== 'glm-4.5-flash', 'a bare name 502s against the router\'s trust floor');
    check('pin: a paid model has no pin', byId.get('claude-fable-5')!.pin() === null);
    check('pin: a model with no free peer has no pin', byId.get('half-free')!.pin() === null);
  });

  it('test_pin_prefers_trust_then_anthropic', async () => {
    // Among free peers, Anthropic support wins, then reputation.
    const byId = await catalogById();
    // glm-4.5-flash has a None-reputation peer and a 44.58 one: take the higher.
    check('pin: the higher-trust free peer is chosen', byId.get('glm-4.5-flash')!.pin() === 'bbbb2222@glm-4.5-flash', String(byId.get('glm-4.5-flash')!.pin()));
    // A peer advertising anthropic-messages outranks one that does not, even at
    // a *lower* trust — measured: one free peer rejects Anthropic outright.
    check(
      'pin: an anthropic-capable peer outranks a higher-trust one',
      byId.get('dual-free')!.pin() === 'gggg7777@dual-free',
      `${byId.get('dual-free')!.pin()} (80-trust OpenAI peer must lose to the 20-trust Anthropic one)`,
    );
    // The highest-trust seller of all is a *paid* one, and it must still lose:
    // the pin's entire job is to reach a free seller, so trust only ever ranks
    // peers that are already free. A regression here would silently start
    // spending money on a model the operator picked because it was free.
    check(
      'pin: a higher-trust PAID seller never wins the pin',
      byId.get('dual-free')!.pin() !== 'hhhh8888@dual-free' && !(byId.get('dual-free')!.pin() ?? '').includes('hhhh8888'),
      `90-trust paid seller must not be pinned: ${byId.get('dual-free')!.pin()}`,
    );
    check('pin: serves_anthropic reads the peer protocol', byId.get('ling-3.1-flash')!.freePeers[0]!.servesAnthropic);
    check(
      "pin: a model's own protocol list is separate from its peers'",
      byId.get('claude-fable-5')!.servesAnthropic && !byId.get('claude-fable-5')!.peers[0]!.servesAnthropic,
    );
    // The rule is a preference, never a filter: with no Anthropic peer at all,
    // the best OpenAI-only free peer is still pinned. Every free peer on the
    // live network is in this branch, so it is the one that actually runs.
    const glm = byId.get('glm-4.5-flash')!;
    check('pin: no free peer advertises Anthropic here', !glm.freePeers.some((p) => p.servesAnthropic));
    check('pin: an OpenAI-only free peer is still pinned', glm.pin() === 'bbbb2222@glm-4.5-flash', String(glm.pin()));
  });

  it('test_blurb_says_which_count_is_the_free_one', async () => {
    // `free · 4 of 9 sellers` — the counts must not read as a contradiction.
    const byId = await catalogById();
    // All sellers free → a single count, no ratio.
    check('blurb: all-free reads as one count', byId.get('glm-4.5-flash')!.blurb.startsWith('free · 2 sellers'), byId.get('glm-4.5-flash')!.blurb);
    // Some free → the ratio, free first. This is the case that used to render
    // as "2 peers · 2 sellers" — two numbers, no way to tell them apart.
    check('blurb: part-free reads as \'N of M sellers\'', byId.get('dual-free')!.blurb.startsWith('free · 2 of 3 sellers'), byId.get('dual-free')!.blurb);
    // A paid model quotes a price and never says "free".
    const paid = byId.get('claude-fable-5')!.blurb;
    check("blurb: a paid model never says 'free'", !paid.includes('free'), paid);
    check('blurb: a paid model quotes a price', paid.includes('$0.3449/$1.1199 per Mtok'), paid);
    check('blurb: a paid model still says how many sellers', paid.includes('1 seller'), paid);
    // Singular/plural must not read "1 sellers".
    const one = byId.get('ling-3.1-flash')!.blurb;
    check('blurb: one seller is singular', one.includes('1 seller') && !one.includes('1 sellers'), one);
    check("blurb: the word 'peers' is gone from the free blurb", !byId.get('glm-4.5-flash')!.blurb.includes('peer'), 'two words for one thing is what made it ambiguous');
  });

  it('test_a_pin_bypasses_ranking_not_the_seller', async () => {
    // A pin gets you to the peer; it does not make that peer answer.
    // Measured across the eight free pins on the live network: one 200, one
    // 429, one 502, one 400. So this module must hand back a *set* of free
    // pins and never present one as guaranteed — the set is what the picker
    // shows; a single "the free model" would be a promise the network cannot
    // keep.
    a.clearCache();
    vi.stubGlobal('fetch', serve());
    let ids: string[] | null = null;
    try {
      const [out, err] = await a.freeModelIds('', { useCache: false });
      ids = out;
      expect(err).toBe('');
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('pin: every free model is offered, not just the best one', ids !== null && ids.length === 3, `${(ids ?? []).length} pins — a pin can 429 or 502, so all are offered`);
    check('pin: no duplicate pins', ids !== null && new Set(ids).size === ids.length);
    // The pins carry the peer that was chosen, so a failure names a peer the
    // operator can see and re-pick rather than an opaque model id.
    check('pin: each pin names both the peer and the model', (ids ?? []).every((i) => i.split('@').length === 2 && Boolean(i.split('@')[0]) && Boolean(i.split('@')[1])));
    check('pin: a pin is not the bare model id', (ids ?? []).every((i) => i !== i.split('@')[1]), 'a bare id 502s against the router\'s trust floor');
  });

  it('test_free_model_ids_are_pinned', async () => {
    // `freeModelIds` must return pinned ids — bare ones would 502.
    a.clearCache();
    vi.stubGlobal('fetch', serve());
    let ids: string[] | null = null;
    let err = '';
    try {
      const [out, e] = await a.freeModelIds('', { useCache: false });
      ids = out;
      err = e;
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('free ids: the fetch succeeds', err === '' && ids !== null, err);
    check('free ids: every id is pinned', Boolean(ids) && ids!.every((i) => i.includes('@')), String(ids));
    check('free ids: the paid models are excluded', !(ids ?? []).some((i) => i.includes('claude-fable-5')));
    check('free ids: the half-free model is excluded', !(ids ?? []).some((i) => i.includes('half-free')));
    check(
      'free ids: sorted set matches the free models',
      JSON.stringify((ids ?? []).map((i) => i.split('@')[1]).sort()) ===
        JSON.stringify(['dual-free', 'glm-4.5-flash', 'ling-3.1-flash']),
      String(ids),
    );
  });

  it('test_default_free_pin_never_names_a_paid_model', async () => {
    // The 402 regression: a fresh switch must land on a free pin.
    // Measured before this existed: with no saved preference, applyTo left
    // cfg.model on the previous source's paid name and the router answered
    // 402 antseed_buyer_fault on a wallet holding 0.0 USDC. So the property
    // under test is not "a pin is returned" but "whatever is returned is free".
    a.clearCache();
    vi.stubGlobal('fetch', serve());
    let pin: string | null = null;
    try {
      pin = await a.defaultFreePin('', { useCache: false });
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('default pin: one is returned at all', Boolean(pin), String(pin));
    check('default pin: it is pinned, not a bare model name', Boolean(pin) && pin!.includes('@'), String(pin));
    const model = (pin ?? '').split('@')[1] ?? '';
    check('default pin: it names a model the catalog calls free', ['dual-free', 'glm-4.5-flash', 'ling-3.1-flash'].includes(model), model);
    check('default pin: never the paid model', model !== 'claude-fable-5', model);
    check('default pin: never the free-in-but-paid-out model', model !== 'half-free', model);

    // An empty network must yield None, not an invented name: `applyTo` reads
    // that as "leave cfg.model alone", and a made-up id would be worse than the
    // stale one it replaced.
    a.clearCache();
    vi.stubGlobal('fetch', serve({ object: 'list', data: [] }));
    try {
      check('default pin: an empty network yields None, not a guess', (await a.defaultFreePin('', { useCache: false })) === null);
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }

    // A network with no free peer at all must also yield None.
    a.clearCache();
    const paid = {
      object: 'list',
      data: [
        {
          id: 'claude-fable-5',
          type: 'text',
          peers: [
            { peerId: 'eeee5555', protocol: 'openai-chat-completions', inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', serve(paid));
    try {
      check('default pin: an all-paid network yields None', (await a.defaultFreePin('', { useCache: false })) === null);
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
  });

  it('test_usable_free_models_is_the_pinnable_set', async () => {
    // `/models antseed` reads this, so a free-but-unpinnable model is out.
    a.clearCache();
    vi.stubGlobal('fetch', serve());
    let free: Model[] | null = null;
    let usable: Model[] | null = null;
    let err = '';
    try {
      [free] = await a.freeModels('', { useCache: false });
      [usable, err] = await a.usableFreeModels('', { useCache: false });
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('usable: every usable model is pinnable', usable !== null && usable.every((m) => Boolean(m.pin())), err);
    check('usable: it is a subset of the free list', new Set((usable ?? []).map((m) => m.id)).size <= new Set((free ?? []).map((m) => m.id)).size && (usable ?? []).every((m) => (free ?? []).some((f) => f.id === m.id)));
    check('usable: the count matches the pinnable free models', (usable ?? []).length === 3, String((usable ?? []).map((m) => m.id)));
  });

  // -------------------------------------------------------------------------
  // fetching
  // -------------------------------------------------------------------------

  it('test_catalog_needs_no_key', async () => {
    // The buyer authenticates nothing; a fetch must send no credential.
    a.clearCache();
    const seen: { url?: string; init?: unknown } = {};
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init?: unknown): Promise<Response> => {
        seen.url = String(url);
        seen.init = init;
        return respOf(JSON.stringify(CATALOG));
      },
    );
    let models: Model[] | null = null;
    let err = '';
    try {
      [models, err] = await a.fetchModels('', { useCache: false });
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('keyless: a fetch with no key succeeds', err === '' && models !== null && models.length === 6, err);
    check('keyless: hits /v1/models on the buyer', (seen.url ?? '').endsWith('/v1/models'), seen.url);
    const initStr = JSON.stringify(seen.init ?? {});
    check(
      'keyless: sends NO credential',
      !initStr.toLowerCase().includes('authorization') && !initStr.toLowerCase().includes('x-api-key'),
      initStr,
    );
    check('keyless: the request is a bare URL, so there is nowhere to put one', (seen.init as Record<string, unknown> | undefined)?.headers === undefined, 'no headers option means no headers at all');
    check('keyless: looks_like_key is False for everything', !a.looksLikeKey('antseed_abc') && !a.looksLikeKey(''));
  });

  it('test_base_url_is_the_prefix_before_v1', async () => {
    // The SDK appends /v1/messages — a base carrying /v1 would 404.
    check('base: DEFAULT_BASE_URL has no /v1', !a.DEFAULT_BASE_URL.includes('/v1'), a.DEFAULT_BASE_URL);
    check("base: it is the buyer's documented ANTHROPIC_BASE_URL", a.DEFAULT_BASE_URL === 'http://localhost:8377');
    a.clearCache();
    const seen: { url?: string } = {};
    vi.stubGlobal(
      'fetch',
      async (url: unknown): Promise<Response> => {
        seen.url = String(url);
        return respOf(JSON.stringify(CATALOG));
      },
    );
    try {
      await a.fetchModels('', { useCache: false });
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('base: the catalog URL is base + /v1/models', seen.url === 'http://localhost:8377/v1/models', seen.url);
  });

  it('test_fetch_is_total', async () => {
    // Every failure is a message, never an exception.
    const cases: [string, () => Promise<Response>][] = [
      ['unreachable', async () => { throw new TypeError('fetch failed'); }],
      ['404', () => Promise.resolve(respOf('', 404))],
      ['500', () => Promise.resolve(respOf('', 500))],
      ['garbage', () => Promise.resolve(respOf('not json at all'))],
    ];
    for (const [label, fn] of cases) {
      a.clearCache();
      vi.stubGlobal('fetch', fn);
      let models: Model[] | null = null;
      let message = '';
      try {
        [models, message] = await a.fetchModels('', { useCache: false });
      } finally {
        vi.unstubAllGlobals();
        a.clearCache();
      }
      check(`total: ${label} returns None and a reason`, models === null && Boolean(message), message.slice(0, 60));
    }

    a.clearCache();
    vi.stubGlobal('fetch', serve({ object: 'list', data: [] }));
    let models: Model[] | null = null;
    let err = '';
    try {
      [models, err] = await a.fetchModels('', { useCache: false });
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
    check('total: an empty catalog is [] and not an error', Array.isArray(models) && models.length === 0 && err === '', JSON.stringify(err));
    check('total: a non-dict payload yields [] rather than raising', (await parseCatalog([])).length === 0 && (await parseCatalog({})).length === 0);
  });

  it('test_cache_is_keyed_by_endpoint', async () => {
    // Two endpoints must not share one cache slot.
    a.clearCache();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> => {
        n += 1;
        return respOf(JSON.stringify(CATALOG));
      },
    );
    try {
      await a.fetchModels();
      await a.fetchModels();
      check('cache: a second fetch is served from the cache', n === 1, `calls=${n}`);

      await a.fetchModels('http://localhost:9999', { useCache: true });
      check('cache: a different endpoint is fetched separately', n === 2, `calls=${n}`);
      a.clearCache();
      check('cache: clearing empties it', a.cachedModels() === null);
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }
  });

  it('test_cache_expiry', async () => {
    // An expired catalog must not be served as if it were live.
    // fetchModels has always refused to *reuse* an entry past CACHE_TTL, but
    // cachedModels once read it back regardless — so a catalog fetched once
    // was reported by /model for the rest of the session. AntSeed's seller set
    // is the most volatile of any source here, so a stale list is the worst
    // case of the four.
    //
    // Nothing sleeps: the monotonic clock is advanced, which is the same thing
    // to a performance.now() comparison. (The Python original rewound the
    // cache entry's timestamp directly; the TS port keeps the cache
    // module-private, so the clock is the lever.)
    a.clearCache();
    check('expiry: a cold cache has no age', a.catalogAge() === null, String(a.catalogAge()));

    vi.stubGlobal('fetch', serve());
    const realNow = performance.now();
    let offsetMs = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow + offsetMs);
    try {
      await a.fetchModels();
      check('expiry: a fresh catalog is served', a.cachedIds() !== null);
      check('expiry: its age is reported, and small', (a.catalogAge() ?? 999) < 5.0, String(a.catalogAge()));

      offsetMs = (a.CACHE_TTL + 60) * 1000;
      check('expiry: an expired catalog reads as None', a.cachedModels() === null, String(a.cachedModels()));
      check('expiry: cached_ids agrees', a.cachedIds() === null);
      check('expiry: the real age is still reported, unclamped', (a.catalogAge() ?? 0) >= a.CACHE_TTL, String(a.catalogAge()));

      await a.fetchModels();
      check('expiry: refetching restores it', a.cachedIds() !== null);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
      a.clearCache();
    }
  });

  // -------------------------------------------------------------------------
  // endpoint identification
  // -------------------------------------------------------------------------

  it('test_is_antseed_by_port_not_name', () => {
    // The buyer's URL contains no 'antseed' — the port is the identifier.
    check('ident: the plain buyer URL is recognised', a.isAntseed('http://localhost:8377'));
    check('ident: 127.0.0.1 is recognised too', a.isAntseed('http://127.0.0.1:8377'));
    check('ident: a tunnel host is recognised', a.isAntseed('https://abc.antseed.com'));
    check(
      'ident: the LiteLLM proxies are NOT antseed',
      !a.isAntseed('http://localhost:4001') && !a.isAntseed('http://localhost:4000'),
      'port 4000/4001 belong to Logfare and Token Juice',
    );
    check('ident: an unrelated host is not antseed', !a.isAntseed('https://tokenharbour.ai'));
    check('ident: empty and None are not antseed', !a.isAntseed('') && !a.isAntseed(null));
    check('ident: active_endpoint is the same test', a.activeEndpoint === a.isAntseed);
  });

  it('test_active_key_does_not_confuse_sources', () => {
    // sources.activeKey must route each port to the right provider.
    check('sources: 8377 is antseed', s.activeKey('http://localhost:8377') === 'antseed');
    check('sources: 4001 is logfare', s.activeKey('http://localhost:4001') === 'logfare');
    check('sources: 4000 is tokenjuice', s.activeKey('http://localhost:4000') === 'tokenjuice');
    check('sources: antseed is a builtin key, so a selection survives', s.BUILTIN_KEYS.has('antseed'));
    a.clearCache();
    check('sources: models_for returns None on a cold cache', s.modelsFor('http://localhost:8377') === undefined);
  });

  it('test_proxy_port_comes_from_the_buyer_config', async () => {
    // The port is read from AntSeed's own config, with a sane fallback.
    // ANTSEED_DATA_DIR is read at module load, so this test re-imports the
    // module under a temp data dir (the Python original patched the module
    // constant).
    const fakeHome = path.join(TMP, 'antseed-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env['ANTSEED_DATA_DIR'] = fakeHome;
    vi.resetModules();
    try {
      const m = await import('../src/antseed.js');
      check('port: falls back when there is no config', m.proxyPort() === m.DEFAULT_PORT, String(m.proxyPort()));
      fs.writeFileSync(path.join(fakeHome, 'config.json'), JSON.stringify({ buyer: { proxyPort: 9999 } }), 'utf8');
      check('port: reads buyer.proxyPort from the config', m.proxyPort() === 9999, String(m.proxyPort()));
      fs.writeFileSync(path.join(fakeHome, 'config.json'), '{ not json', 'utf8');
      check('port: a malformed config falls back rather than raising', m.proxyPort() === m.DEFAULT_PORT);
      fs.writeFileSync(path.join(fakeHome, 'config.json'), JSON.stringify({ buyer: { proxyPort: 999999 } }), 'utf8');
      check('port: an out-of-range port is rejected', m.proxyPort() === m.DEFAULT_PORT);
    } finally {
      delete process.env['ANTSEED_DATA_DIR'];
      vi.resetModules();
    }
  });

  // -------------------------------------------------------------------------
  // the remembered pin
  // -------------------------------------------------------------------------

  it('test_profile_roundtrip', () => {
    // The preference file round-trips, is mode 600, and holds no key.
    const own = path.join(process.env['ANDY_HOME']!, 'antseed', 'source');
    fs.rmSync(own, { force: true });
    check('profile: nothing remembered initially', a.loadPin() === null);
    const wrote = a.savePin('glm-4.5-flash', 'bbbb2222');
    check('profile: saved to the expected path', wrote === own);
    check('profile: mode is 600', (fs.statSync(own).mode & 0o777).toString(8) === '600', (fs.statSync(own).mode & 0o777).toString(8));
    check('profile: parent dir is 700', (fs.statSync(path.dirname(own)).mode & 0o777).toString(8) === '700', (fs.statSync(path.dirname(own)).mode & 0o777).toString(8));
    check('profile: round-trips the model and peer', JSON.stringify(a.loadPin()) === JSON.stringify(['glm-4.5-flash', 'bbbb2222']), String(a.loadPin()));
    const text = fs.readFileSync(own, 'utf8');
    check('profile: the file says it is not a credential', text.toLowerCase().includes('not a credential'));
    check('profile: it records the base url for a shell to source', text.includes('export ANTHROPIC_BASE_URL="http://localhost:8377"'));
    // A model with no peer must still read back.
    a.savePin('solo-model', '');
    check('profile: a model with no peer round-trips', JSON.stringify(a.loadPin()) === JSON.stringify(['solo-model', '']));
  });

  it('test_apply_and_guard', async () => {
    // applyTo points the config here; the guard leaves other hosts alone.
    // (A plain mutable target rather than a Config: applyTo only touches the
    // four AntseedTarget fields, and the Python original asserted exactly
    // those.)
    const cfg = { baseUrl: 'http://localhost:4001', apiKey: '', authToken: '', model: 'deepseek-v4.1-flash' };
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
    );
    try {
      check('apply: no buyer means no switch', (await a.applyTo(cfg)) === null && cfg.baseUrl === 'http://localhost:4001', 'a switch to a dead proxy must not report success');
      check('creds: no buyer means no credentials', (await a.loadCredentials()) === null);
    } finally {
      vi.unstubAllGlobals();
    }

    // The Python original injected default_free_pin directly; the TS module
    // binds it internally, so the same coverage comes from serving a catalog
    // whose only pinnable free model is deterministic: PREFERRED_FREE_MODELS
    // names glm-4.5-flash, so the default pin is bbbb2222@glm-4.5-flash.
    const own = path.join(process.env['ANDY_HOME']!, 'antseed', 'source');
    fs.rmSync(own, { force: true });
    vi.stubGlobal('fetch', serve());
    try {
      const applied = await a.applyTo(cfg);
      check('apply: points at the buyer', cfg.baseUrl === 'http://localhost:8377');
      check('apply: sets a non-empty token so the harness will start', Boolean(cfg.authToken), 'api_key_present must be True');
      check('apply: the token is the documented placeholder', cfg.authToken === a.NO_KEY_PLACEHOLDER, cfg.authToken);
      check("apply: api_key is cleared, not left as another provider's", cfg.apiKey === '');
      check('apply: returns the origin', applied !== null && applied[0] === 'antseed', String(applied));
      const creds = await a.loadCredentials();
      check('creds: returns the same three-tuple shape as the gateways', creds !== null && creds.length === 3, String(creds));
      check('creds: origin says where it came from', creds !== null && creds[2] === 'local buyer', String(creds));
      check('creds: with no pin, it names a measured free model, never the stale paid one', creds !== null && creds[1] === 'bbbb2222@glm-4.5-flash', String(creds));

      // A remembered pin is composed into the model.
      a.savePin('glm-4.5-flash', 'bbbb2222');
      await a.applyTo(cfg);
      check('apply: a remembered pin is composed into the model', cfg.model === 'bbbb2222@glm-4.5-flash', cfg.model);
    } finally {
      vi.unstubAllGlobals();
      a.clearCache();
    }

    check("guard: the buyer's own endpoint is not overridden", !a.appliesToDefaultEndpoint('http://localhost:8377'));
    check('guard: the default and local proxies may be overridden', a.appliesToDefaultEndpoint('') === true && a.appliesToDefaultEndpoint('http://localhost:4001') === true);
    check('guard: a deliberate remote endpoint is left alone', !a.appliesToDefaultEndpoint('https://tokenharbour.ai'));
  });

  it('test_selection_file_is_shared', async () => {
    // One selection file, so /andy-antseed and /andy-source agree.
    // (The Python original saved and restored the real selection; this port
    // runs the whole file under a temp ANDY_HOME, so the operator's file is
    // never touched and no restore is needed.)
    await a.setCurrent('antseed');
    check('selection: set_current writes the shared file', s.currentKey() === 'antseed', String(s.currentKey()));
    check('selection: current_key reads it back through the module', (await a.currentKey()) === 'antseed');
  });

  it('test_price_for_unwraps_a_pin', async () => {
    // A pinned model still prices, so /cost is not blank on a free run.
    const models = await parseCatalog();
    let pf = a.priceFor('glm-4.5-flash', models);
    check('price_for: a bare free model prices at zero', pf !== null && pf[0] === 0 && pf[1] === 0);
    pf = a.priceFor('bbbb2222@glm-4.5-flash', models);
    check('price_for: a pinned free model prices at zero', pf !== null && pf[0] === 0 && pf[1] === 0);
    pf = a.priceFor('eeee5555@claude-fable-5', models);
    check('price_for: a pinned paid model prices at the cheapest peer', pf !== null && pf[0] === 0.3449 && pf[1] === 1.1199);
    check('price_for: an unknown model prices as None', a.priceFor('nope', models) === null);
    check('price_for: no catalog prices as None', a.priceFor('glm-4.5-flash', null) === null);
  });

  it('test_no_key_is_echoed', () => {
    // Nothing this module writes or returns looks like a secret.
    const own = path.join(process.env['ANDY_HOME']!, 'antseed', 'source');
    a.savePin('glm-4.5-flash', 'bbbb2222');
    const text = fs.readFileSync(own, 'utf8');
    for (const marker of ['antseed_', 'sk-', 'zk_', 'Bearer ']) {
      check(`nokey: the profile contains no '${marker}'`, !text.includes(marker));
    }
    check('nokey: the placeholder is not key-shaped', !a.NO_KEY_PLACEHOLDER.startsWith('sk-') && !a.NO_KEY_PLACEHOLDER.startsWith('antseed_'), a.NO_KEY_PLACEHOLDER);
  });
});
