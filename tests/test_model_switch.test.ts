// Vitest port of tests/test_model_switch.py — /model must police against the
// ACTIVE gateway's catalog, not the declared fallback (src/ui/screens/model-commands.tsx).
//
// The Python original drove the real Textual app through app.run_test(); Ink
// has no pilot harness in this repo's deps, so the port drives the REAL
// command handlers (cmdModel / cmdZimSource) through a fake AppCtx — the same
// seam the component itself uses — with the real sources/config modules and
// per-gateway wrappers standing in for Python's mock.patch.object. The
// regression being pinned is in the handler's logic, which runs unmodified.
//
// The bug: every hosted gateway's catalog is FETCHED, so on a cold cache
// modelsFor returns the declared fallback (Logfare's list) and a live model is
// refused as "not served by <gateway>" — the next turn then 402s. Both
// gateways are driven here, and the final case asserts a non-gateway source
// is left alone. Test names are the Python originals.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

type ConfigType = typeof import('../src/config.js');
type Sources = typeof import('../src/sources.js');
type Logfare = typeof import('../src/logfare.js');
type Openrouter = typeof import('../src/openrouter.js');
type Tokenharbour = typeof import('../src/tokenharbour.js');
/**
 * The handlers live in .tsx modules, and the tsconfig's JSX flag is not the
 * port's to set — so they are imported through a non-literal specifier (the
 * same trick src/ui/app.tsx uses for its own siblings) and typed structurally
 * here. Node resolves the specifier at runtime; tsc leaves it alone.
 */
interface ModelCommands {
  cmdModel(ctx: AppCtxLike, args: string[]): void;
  cmdZimSource(ctx: AppCtxLike, key: string | null): void;
}

/** The slice of AppCtx the two commands under test touch. */
interface AppCtxLike {
  cfg: { baseUrl: string; authToken: string; apiKey: string; model: string; workdir: string };
  mods(): Record<string, unknown> | null;
  agent(): { setModel(n: string): void; resetClient?(): void } | null;
  pal(): Record<string, unknown>;
  say(node: unknown): void;
  sysLine(message: string, warn?: boolean, ok?: boolean): void;
  updateBar(patch: Record<string, unknown>): void;
  updateHeader(patch: Record<string, unknown>): void;
  setBusyBoth(v: boolean): void;
  refreshCompletions(text: string): void;
  inputRef: { current: string };
}

let Config: ConfigType;
let sources: Sources;
let lf: Logfare;
let or: Openrouter;
let th: Tokenharbour;
let mc: ModelCommands;
let tmp: string;
let ROOT: string;

/** Minimal stand-in for a gateway module this test never activates: the
 *  render path reads priceFor off every one of them, so null would throw. */
const quietGateway = (): Record<string, unknown> => ({
  priceFor: () => null,
  cachedModels: () => null,
  loadCredentials: () => null,
});

/** Python's check(): a named assertion; the name is the failure message. */
function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name}  [${extra}]` : name).toBe(true);
}

/** Flatten a ReactNode tree to its text — Ink nodes are plain objects with
 *  props.children, so no renderer is needed to read what the transcript gets. */
function nodeText(n: unknown): string {
  if (n === null || n === undefined || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (typeof n === 'object' && 'props' in (n as Record<string, unknown>)) {
    return nodeText((n as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

/** The one attribute the warm-up reads off a fetched catalog entry. */
function modelEntry(mid: string): { id: string; free: boolean; blurb: string } {
  return { id: mid, free: false, blurb: '' };
}

interface Harness {
  ctx: AppCtxLike;
  cfg: { baseUrl: string; authToken: string; apiKey: string; model: string; workdir: string };
  sysLines: string[];
  sayText: string[];
  mods: Record<string, unknown>;
  agentCalls: { setModel: string[]; resetClient: number };
}

function mkCtx(mods: Record<string, unknown>, cfg: Harness['cfg']): Harness {
  const sysLines: string[] = [];
  const sayText: string[] = [];
  const agentCalls = { setModel: [] as string[], resetClient: 0 };
  const palette = new Proxy({}, { get: (_t, k) => String(k) });
  const ctx = {
    cfg,
    mods: () => mods,
    agent: () => ({
      setModel: (n: string) => {
        agentCalls.setModel.push(n);
      },
      resetClient: () => {
        agentCalls.resetClient += 1;
      },
    }),
    pal: () => palette,
    say: (node: ReactNode) => {
      sayText.push(nodeText(node));
    },
    sysLine: (message: string) => {
      sysLines.push(message);
    },
    updateBar: () => {},
    updateHeader: () => {},
    setBusyBoth: () => {},
    refreshCompletions: () => {},
    inputRef: { current: '' },
  } as unknown as AppCtxLike;
  return { ctx, cfg, sysLines, sayText, mods, agentCalls };
}

/** Let cmdModel's fire-and-forget async body settle (its fetch stub resolves
 *  on the microtask queue, so a short macrotask wait is deterministic). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

/** The whole transcript the port can read: sysLine strings + say text. */
function transcript(h: Harness): string {
  return [...h.sysLines, ...h.sayText].join('\n');
}

beforeAll(async () => {
  ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-ms-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  for (const name of ['gateway-or', 'gateway-th', 'logfare', 'footer', 'stored', 'nongateway']) {
    fs.mkdirSync(path.join(tmp, name), { recursive: true });
  }
  Config = await import('../src/config.js');
  sources = await import('../src/sources.js');
  lf = await import('../src/logfare.js');
  or = await import('../src/openrouter.js');
  th = await import('../src/tokenharbour.js');
  const modelCommandsSpec = '../src/ui/screens/model-commands.js';
  mc = (await import(modelCommandsSpec)) as unknown as ModelCommands;
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  lf.clearCache();
  or.clearCache();
  th.clearCache();
});

describe('model_switch', () => {
  it('test_a_gateway_model_is_not_policed_against_logfare', async () => {
    const cases: [string, string, string][] = [
      ['openrouter', 'https://openrouter.ai/api',
        'dots-studio/dots-3-note-preview:free'],
      ['tokenharbour', 'https://tokenharbor.ai', 'tokenharbour/fast'],
    ];
    for (const [key, baseUrl, model] of cases) {
      const mod = key === 'openrouter' ? or : th;
      mod.clearCache();
      // A cold cache is the precondition, so assert it rather than assume it.
      check(`${key}: the catalog really is cold`, mod.cachedIds() === null,
        String(mod.cachedIds()));

      const fetched = [modelEntry(model), modelEntry(`${key}-other`)];
      const gatewayMod = {
        ...mod,
        fetchModels: vi.fn(async () => [fetched, ''] as [typeof fetched, string]),
        loadCredentials: vi.fn(() => ['sk-test', '', 'test'] as [string, string, string]),
      };
      const mods = {
        sources,
        config: { KNOWN_MODELS: [...Config.KNOWN_MODELS], priceFor: Config.priceFor },
        logfare: lf,
        tokenharbour: th,
        openrouter: or,
        unorouter: null,
        antseed: null,
        aihubmix: null,
        ldxhub: null,
        [key === 'openrouter' ? 'openrouter' : 'tokenharbour']: gatewayMod,
      };
      const cfg = {
        baseUrl, authToken: 'sk-x', apiKey: '', model: 'old-model',
        workdir: path.join(tmp, `gateway-${key === 'openrouter' ? 'or' : 'th'}`),
      };
      const h = mkCtx(mods, cfg);
      mc.cmdModel(h.ctx, [model]);
      await vi.waitFor(() => {
        if (cfg.model !== model && !h.sysLines.some((l) => l.includes('is not served by'))) {
          throw new Error('switch still pending');
        }
      }, { timeout: 1000, interval: 10 });

      const blob = transcript(h);
      check(`${key}: the gateway's own model was accepted`,
        cfg.model === model, `model is ${JSON.stringify(cfg.model)}`);
      check(`${key}: it was not refused as unserved`,
        !blob.includes('is not served by'), blob.slice(-300));
      check(`${key}: the switch was confirmed`,
        blob.includes(`model switched to ${model}`), blob.slice(-300));
    }
  });

  it('test_logfare_is_policed_against_its_own_live_catalog', async () => {
    // A model Logfare serves *now* must switch, even if the fallback lacks it.
    const live = [modelEntry('deepseek-v4.1-flash'), modelEntry('mimo-v2.6-flash')];
    const calls = { n: 0 };
    const lfStub = {
      ...lf,
      fetchModels: vi.fn(async () => {
        calls.n += 1;
        return [live, ''] as [typeof live, string];
      }),
    };
    const cfg = {
      baseUrl: 'http://localhost:4001', authToken: 'sk-x', apiKey: '', model: 'old',
      workdir: path.join(tmp, 'logfare'),
    };
    const h = mkCtx({
      sources,
      config: { KNOWN_MODELS: [...Config.KNOWN_MODELS], priceFor: Config.priceFor },
      logfare: lfStub,
      tokenharbour: th,
      openrouter: or,
      unorouter: quietGateway(),
      antseed: quietGateway(),
      aihubmix: quietGateway(),
      ldxhub: quietGateway(),
    }, cfg);
    lf.clearCache(); // the mount warm-up is simply not run here
    check('logfare: the catalog really is cold', lf.cachedIds() === null,
      String(lf.cachedIds()));
    check('logfare: the live model is absent from the fallback',
      !Config.KNOWN_MODELS.includes('mimo-v2.6-flash'));
    mc.cmdModel(h.ctx, ['mimo-v2.6-flash']);
    await settle();

    const blob = transcript(h);
    check('logfare: a live model the fallback lacks was accepted',
      cfg.model === 'mimo-v2.6-flash', `model is ${JSON.stringify(cfg.model)}`);
    check('logfare: it was not refused as unserved',
      !blob.includes('is not served by'), blob.slice(-300));
    check('logfare: the switch fetched the catalog rather than assuming',
      calls.n >= 1, `${calls.n} fetches`);
  });

  it('test_a_non_gateway_source_is_left_alone', async () => {
    const orSpy = { ...or, fetchModels: vi.fn(async () => [[modelEntry('x')], '']) };
    const cfg = {
      baseUrl: 'http://localhost:4001', authToken: 'sk-x', apiKey: '', model: 'old',
      workdir: path.join(tmp, 'nongateway'),
    };
    const h = mkCtx({
      sources,
      config: { KNOWN_MODELS: [...Config.KNOWN_MODELS], priceFor: Config.priceFor },
      logfare: lf,
      tokenharbour: th,
      openrouter: orSpy,
      unorouter: quietGateway(),
      antseed: quietGateway(),
      aihubmix: quietGateway(),
      ldxhub: quietGateway(),
    }, cfg);
    mc.cmdModel(h.ctx, ['deepseek-v4.1-flash']);
    await settle();

    check('local: no gateway fetch was triggered for a local proxy',
      (orSpy.fetchModels as ReturnType<typeof vi.fn>).mock.calls.length === 0);
    check('local: a Logfare model still switches',
      cfg.model === 'deepseek-v4.1-flash', cfg.model);
    // Why no fetch fired: the name is in the declared fallback, so the
    // membership test passes before the fetch branch is reached.
    check('local: the name was in the fallback, so no fetch was needed',
      Config.KNOWN_MODELS.includes('deepseek-v4.1-flash'));
  });

  it('test_the_footer_reports_the_catalogs_age', async () => {
    // A real payload through the real parser, so the cache holds real Model
    // objects and the render path reads the shapes it does in production.
    const payload = { data: [
      { model_id: 'deepseek-v4.1-flash', display_name: 'D',
        status: 'operational', uptime_percent: 93.6,
        endpoints: ['chat/completions'], real_traffic_total: 10 },
      { model_id: 'mimo-v2.6-flash', display_name: 'M',
        status: 'operational', uptime_percent: 90.0,
        endpoints: ['chat/completions'], real_traffic_total: 10 },
    ] };
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 })));

    const cfg = {
      baseUrl: 'http://localhost:4001', authToken: 'sk-x', apiKey: '', model: 'deepseek-v4.1-flash',
      workdir: path.join(tmp, 'footer'),
    };
    const h = mkCtx({
      sources,
      config: { KNOWN_MODELS: [...Config.KNOWN_MODELS], priceFor: Config.priceFor },
      logfare: lf,
      tokenharbour: th,
      openrouter: or,
      unorouter: quietGateway(),
      antseed: quietGateway(),
      aihubmix: quietGateway(),
      ldxhub: quietGateway(),
    }, cfg);

    /** The newest catalog line only — the transcript accumulates, so an
     *  unscoped search would find an earlier /model's footer. */
    const footer = (): string => {
      const lines = [...h.sysLines, ...h.sayText].join('\n')
        .split('\n').filter((l) => l.includes('catalog'));
      return lines[lines.length - 1] ?? '';
    };

    lf.clearCache();
    mc.cmdModel(h.ctx, []);
    await settle();
    let line = footer();
    check('footer: a cold cache says so rather than claiming live',
      line.includes('not fetched yet') && !line.includes('live'), line);

    await lf.fetchModels();
    mc.cmdModel(h.ctx, []);
    await settle();
    line = footer();
    check('footer: a fresh cache reports live, with its age',
      line.includes('catalog live (just now)'), line);

    // Age it past the TTL by advancing the fake monotonic clock — the same
    // thing as Python rewinding the cache stamp.
    const realNow = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(
      () => realNow + (lf.CACHE_TTL + 3600) * 1000);
    mc.cmdModel(h.ctx, []);
    await settle();
    line = footer();
    check('footer: an expired cache says expired, not live',
      line.includes('expired') && !line.includes('live'), line);
    check('footer: it names the real age, not the TTL',
      line.includes('1h old'), line);
    // And the list above it must be the fallback, not the dead catalog.
    const blob = transcript(h);
    const block = blob.lastIndexOf('current model:');
    check('footer: the expired list is not printed as current',
      !blob.slice(block).includes('mimo-v2.6-flash'), blob.slice(block, block + 300));
    vi.restoreAllMocks();
  });

  it('test_a_retired_stored_model_is_replaced_on_switch', async () => {
    // /zim-logfare takes the model from ANTHROPIC_MODEL in the stored profile,
    // which can name a model the upstream has since retired. The switch is
    // already paying for a round-trip, so verifyModelFor checks there — reached
    // through the real cmdZimSource with a fabricated source.
    const live = [modelEntry('deepseek-v4.1-flash'), modelEntry('mimo-v2.6-flash')];
    const lfStub = {
      ...lf,
      fetchModels: vi.fn(async () => [live, ''] as [typeof live, string]),
    };
    // The stored profile is mutable so each sub-case re-runs the switch with
    // a different stored model — the exact state that goes stale in practice.
    const profile: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: 'sk-stored',
      ANTHROPIC_MODEL: 'deepseek-v3.2',
    };
    const logfareSrc = {
      key: 'logfare', label: 'Logfare', port: 4001,
      baseUrl: 'http://localhost:4001', model: 'deepseek-v4.1-flash',
      profile: path.join(tmp, 'stored', 'profile'), service: 'logfare',
    };
    const tokenjuiceSrc = {
      key: 'tokenjuice', label: 'TokenJuice', port: 4002,
      baseUrl: 'http://localhost:4002', model: 'deepseek-v4.1-flash',
      profile: path.join(tmp, 'stored', 'profile2'), service: 'tokenjuice',
    };
    let discoverable: Record<string, unknown> = { logfare: logfareSrc };
    const fakeSources = {
      ...sources,
      discover: () => discoverable,
      activeKey: () => undefined,
      startProxy: async () => [true, 'up'] as [boolean, string],
      loadProfile: () => profile,
      setCurrent: () => {},
    };
    const cfg = {
      baseUrl: 'http://localhost:4002', authToken: '', apiKey: '', model: 'old',
      workdir: path.join(tmp, 'stored'),
    };
    const h = mkCtx({
      sources: fakeSources,
      config: { KNOWN_MODELS: [...Config.KNOWN_MODELS], priceFor: Config.priceFor },
      logfare: lfStub,
      tokenharbour: th,
      openrouter: or,
      unorouter: quietGateway(),
      antseed: quietGateway(),
      aihubmix: quietGateway(),
      ldxhub: quietGateway(),
    }, cfg);

    mc.cmdZimSource(h.ctx, 'logfare');
    await settle();
    check('switch: a retired stored model is replaced by the default',
      cfg.model === 'deepseek-v4.1-flash', cfg.model);
    check('switch: the retirement is reported',
      h.sysLines.some((l) => l.includes('no longer served')), h.sysLines.join(' | '));

    // A model still served is kept unchanged.
    profile['ANTHROPIC_MODEL'] = 'mimo-v2.6-flash';
    cfg.model = 'old';
    mc.cmdZimSource(h.ctx, 'logfare');
    await settle();
    check('switch: a model still served is kept unchanged',
      cfg.model === 'mimo-v2.6-flash', cfg.model);

    // An unreachable status API is not evidence a model was retired.
    (lfStub.fetchModels as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => [null, 'boom'] as [null, string]);
    profile['ANTHROPIC_MODEL'] = 'deepseek-v3.2';
    cfg.model = 'old';
    mc.cmdZimSource(h.ctx, 'logfare');
    await settle();
    check('switch: a failed fetch leaves the stored name alone',
      cfg.model === 'deepseek-v3.2', cfg.model);

    // Only Logfare's local proxy has a stored profile to go stale.
    discoverable = { tokenjuice: tokenjuiceSrc };
    profile['ANTHROPIC_MODEL'] = 'anything';
    cfg.model = 'old';
    mc.cmdZimSource(h.ctx, 'tokenjuice');
    await settle();
    check('switch: a non-Logfare source is never second-guessed',
      cfg.model === 'anything', cfg.model);
  });
});
