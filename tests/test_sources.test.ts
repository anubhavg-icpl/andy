// tests/test_sources.test.ts — vitest port of tests/test_sources.py.
// What this file is: the regression suite for upstream source discovery and
// proxy start. It protects the /andy-tokenjuice switch (the installed
// ~/.andy/tokenjuice route must win over a leftover $HOME/start-litellm.sh
// from an older deepseek-claude layout) and the no-flock rule in start_proxy
// (a leaked flock is what made the in-TUI switch hang until timeout).
// Port notes on seams: Python patched module attributes (DEFAULT_HOME,
// ANDY_HOME, proxy_healthy, subprocess.run, cached_ids). The TS module
// reads both homes from the environment, so the home pinning is a fresh module
// evaluation under a pinned env; the no-flock check records argv through the
// service script itself; cachedIds is a vi.fn stand-in exactly like
// mock.patch.object was.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/tokenharbour.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tokenharbour.js')>();
  return { ...actual, cachedIds: vi.fn(actual.cachedIds) };
});
vi.mock('../src/openrouter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/openrouter.js')>();
  return { ...actual, cachedIds: vi.fn(actual.cachedIds) };
});

import * as tokenharbour from '../src/tokenharbour.js';
import * as openrouter from '../src/openrouter.js';
import * as sources from '../src/sources.js';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(p: string, mode = 0o644): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '# test\n', 'utf8');
  fs.chmodSync(p, mode);
  return p;
}

// --- pinned-home module loading -------------------------------------------

// Python monkeypatched sources.DEFAULT_HOME and sources.ANDY_HOME; the TS
// module captures DEFAULT_HOME at load (from $HOME) and reads $ANDY_HOME at
// call time, so pinning both env vars around a fresh module evaluation is the
// same control. ANDY_HOME must STAY pinned for the calls; HOME only matters
// while the module evaluates. Both are restored in afterEach.
const SAVED_ENV: Record<string, string | undefined> = {};

function pinEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in SAVED_ENV)) SAVED_ENV[k] = process.env[k];
    process.env[k] = v;
  }
}

async function loadPinnedSources(): Promise<typeof sources> {
  vi.resetModules();
  return await import('../src/sources.js');
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(SAVED_ENV)) delete SAVED_ENV[k];
  vi.resetModules();
  vi.mocked(tokenharbour.cachedIds).mockReturnValue(null);
  vi.mocked(openrouter.cachedIds).mockReturnValue(null);
});

// --- the tokenjuice route --------------------------------------------------

describe('sources — tokenjuice discovery', () => {
  it('prefers the installed route when both layouts exist', async () => {
    const td = tmpdir('andy-sources-');
    const home = path.join(td, 'home');
    const andy = path.join(td, 'andy');
    // Both layouts exist — the leftover $HOME copy must lose.
    touch(path.join(home, 'start-litellm.sh'), 0o755);
    touch(path.join(home, 'litellm-config.yaml'));
    touch(path.join(home, 'claude-source', 'deepseek-claude'));
    const installedSvc = touch(path.join(andy, 'tokenjuice', 'start-litellm.sh'), 0o755);
    const installedCfg = touch(path.join(andy, 'tokenjuice', 'litellm-config.yaml'));
    const installedSrc = touch(path.join(andy, 'tokenjuice', 'source'));

    pinEnv({ HOME: home, ANDY_HOME: andy });
    const mod = await loadPinnedSources();
    const found = mod.discover();

    const tj = found['tokenjuice'];
    expect(tj !== undefined, 'tokenjuice is discovered when both layouts exist').toBe(true);
    expect(tj?.service, 'tokenjuice service is the installed copy').toBe(installedSvc);
    expect(tj?.config, 'tokenjuice config is the installed copy').toBe(installedCfg);
    expect(tj?.profile, 'tokenjuice profile is the installed copy').toBe(installedSrc);
  });

  it('falls back to the $HOME layout when not installed', async () => {
    const td = tmpdir('andy-sources-');
    const home = path.join(td, 'home');
    const andy = path.join(td, 'andy');
    fs.mkdirSync(andy, { recursive: true });
    const homeSvc = touch(path.join(home, 'start-litellm.sh'), 0o755);
    const homeCfg = touch(path.join(home, 'litellm-config.yaml'));
    const homeSrc = touch(path.join(home, 'claude-source', 'deepseek-claude'));

    pinEnv({ HOME: home, ANDY_HOME: andy });
    const mod = await loadPinnedSources();
    const found = mod.discover();

    const tj = found['tokenjuice'];
    expect(tj !== undefined, 'tokenjuice falls back to $HOME when not installed').toBe(true);
    expect(tj?.service, 'fallback service is $HOME/start-litellm.sh').toBe(homeSvc);
    expect(tj?.config, 'fallback config is $HOME/litellm-config.yaml').toBe(homeCfg);
    expect(
      tj?.profile,
      'fallback profile is $HOME/claude-source/deepseek-claude',
    ).toBe(homeSrc);
  });
});

describe('sources — start_proxy', () => {
  it('invokes the service directly, without flock', { timeout: 30_000 }, async () => {
    const td = tmpdir('andy-sources-');
    // The service records its own argv (Python captured them by faking
    // subprocess.run) and fails with a stderr line, so start_proxy's
    // direct-invocation and failure-reporting behaviour are both observable.
    const svc = touch(path.join(td, 'start-litellm.sh'), 0o755);
    const rec = path.join(td, 'argv.txt');
    fs.writeFileSync(
      svc,
      '#!/bin/sh\n' +
        `printf '%s\\n' "$0 $@" > ${JSON.stringify(rec)}\n` +
        'echo boom >&2\n' +
        'exit 0\n',
      'utf8',
    );
    fs.chmodSync(svc, 0o755);
    const src = new sources.Source({
      key: 'tokenjuice',
      label: 'Token Juice',
      port: 3999,
      profile: path.join(td, 'source'),
      service: svc,
      config: path.join(td, 'config.yaml'),
      model: 'deepseek-v4.1-flash',
      root: td,
    });

    const [ok, detail] = await sources.startProxy(src, 5);
    const recorded = fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim() : '';

    expect(recorded === `${svc} start`, 'start_proxy invokes the service directly').toBe(true);
    expect(recorded.includes('flock'), 'start_proxy does not wrap the start in flock').toBe(false);
    expect(
      ok === false && detail === 'boom',
      'start_proxy reports the service failure, not a hang',
    ).toBe(true);
  });
});

describe('sources — remote gateways', () => {
  it('are identified by host, checked before the port match', () => {
    // The hosted gateways have no port to match on: TokenHarbour and
    // OpenRouter are remote, so active_key has to recognise them by host —
    // and check them before the port regex, or a hosted URL falls through to
    // None and the session is reported as pointing at nothing.
    expect(sources.activeKey('https://tokenharbor.ai'), 'host: tokenharbour is recognised').toBe('tokenharbour');
    expect(sources.activeKey('https://openrouter.ai/api/v1'), 'host: openrouter is recognised').toBe('openrouter');

    const keys = new Set([
      sources.activeKey('https://tokenharbor.ai'),
      sources.activeKey('https://openrouter.ai/api/v1'),
    ]);
    expect(keys.size, 'host: the two gateways are distinct').toBe(2);

    expect(sources.activeKey('https://api.example.com'), 'host: an unknown host is still unknown').toBeUndefined();
    expect(sources.activeKey(''), 'host: an empty endpoint is still unknown').toBeUndefined();
  });
});

describe('sources — builtin keys survive a restart', () => {
  it('remote selections are not discarded for having nothing on disk', async () => {
    expect(
      ['tokenharbour', 'openrouter'].every((k) => sources.BUILTIN_KEYS.has(k)),
      'builtin: both remote gateways are listed',
    ).toBe(true);

    const td = tmpdir('andy-sources-');
    const andy = path.join(td, 'andy');
    fs.mkdirSync(andy, { recursive: true });
    // BOTH homes are pinned to the empty temp tree (Python patched both
    // DEFAULT_HOME and ANDY_HOME for the same reason): pinning only
    // ANDY_HOME would leave the real $HOME in play, and a box with the legacy
    // $HOME/start-litellm.sh layout would legitimately discover tokenjuice.
    const emptyHome = path.join(td, 'home');
    fs.mkdirSync(emptyHome, { recursive: true });

    pinEnv({ HOME: emptyHome, ANDY_HOME: andy });
    const mod = await loadPinnedSources();
    for (const key of ['tokenharbour', 'openrouter']) {
      mod.setCurrent(key);
      expect(mod.currentKey(), `builtin: ${key} survives a restart`).toBe(key);
    }

    // A discovered source that is NOT present must still be dropped — the
    // builtin exemption must not have loosened that.
    mod.setCurrent('tokenjuice');
    expect(mod.currentKey(), 'builtin: an absent local source is still discarded').toBeUndefined();
  });
});

describe('sources — models_for reads the remote catalogs', () => {
  it('yields undefined on a cold cache, never an empty list', () => {
    // Undefined means "no live catalog, use your fallback"; an empty list
    // would mean "this source serves nothing", and confusing the two would
    // make /model show an empty list on a cold start instead of the
    // declared one. cachedIds is a vi.fn stand-in, exactly the seam
    // mock.patch.object gave the Python suite.
    for (const [key, mod, url] of [
      ['tokenharbour', tokenharbour, 'https://tokenharbor.ai'],
      ['openrouter', openrouter, 'https://openrouter.ai/api/v1'],
    ] as const) {
      vi.mocked(mod.cachedIds).mockReturnValue(null);
      expect(sources.modelsFor(url), `models_for: ${key} yields undefined on a cold cache`).toBeUndefined();

      vi.mocked(mod.cachedIds).mockReturnValue(['m-one', 'm-two']);
      expect(sources.modelsFor(url), `models_for: ${key} reads its module's cache`).toEqual([
        'm-one',
        'm-two',
      ]);

      vi.mocked(mod.cachedIds).mockReturnValue(null); // leave the cache cold
    }

    expect(sources.modelsFor('https://api.example.com'), 'models_for: an unknown source is still undefined').toBeUndefined();
  });
});
