// Regression suite for the Z.ai GLM Coding Plan source.
//
// Every network call is stubbed. ANDY_HOME and ANDY_CLAUDE_SOURCE are pinned
// before import because the provider resolves its profile paths at module
// load. Credentials are assembled at runtime and never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Zai = typeof import('../src/zai.js');
type Sources = typeof import('../src/sources.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'zai-' + 'coding-plan-key-0123456789';

let zai: Zai;
let sources: Sources;
let tmp: string;
let savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
] as const;

function cleanEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(payload: unknown, status = 200) {
  const seen: { url?: string; authorization?: string } = {};
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    const headers = init?.headers as Record<string, string> | undefined;
    seen.authorization = headers?.['authorization'];
    return jsonResponse(payload, status);
  });
  vi.stubGlobal('fetch', fn);
  return seen;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-zai-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  process.env['ANDY_CLAUDE_SOURCE'] = path.join(tmp, 'claude-source');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  zai = await import('../src/zai.js');
  sources = await import('../src/sources.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  zai.clearCache();
});

afterAll(() => {
  cleanEnv();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('zai — endpoint and registry', () => {
  it('uses the documented Anthropic-compatible endpoint and adds the 1M variant', async () => {
    expect(zai.DEFAULT_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(zai.HOST).toBe('api.z.ai/api/anthropic');
    expect(zai.activeEndpoint === zai.isZai).toBe(true);

    const seen = captureFetch({
      data: [
        { id: 'glm-5.3' },
        { id: 'glm-5.3-flash' },
        { id: 'glm-legacy-alias' },
      ],
    });
    const [models, err] = await zai.fetchModels(KEY, { useCache: false });
    expect(err).toBe('');
    expect(seen.url).toBe('https://api.z.ai/api/anthropic/v1/models');
    expect(seen.authorization).toBe(`Bearer ${KEY}`);
    expect(models?.map((m) => m.id)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flash[1m]',
      'glm-legacy-alias',
    ]);
    expect(models?.[2]?.blurb).toContain('Coding Plan');
    expect(models?.[2]?.blurb).toContain('1M ctx');
  });

  it('requires a Coding Plan key and reports upstream failures without throwing', async () => {
    fs.rmSync(zai.PROFILE, { force: true });
    fs.rmSync(process.env['ANDY_CLAUDE_SOURCE']!, { recursive: true, force: true });
    cleanEnv();

    const [none, noKeyErr] = await zai.fetchModels('', { useCache: false });
    expect(none).toBeNull();
    expect(noKeyErr).toContain('/zai-api-setup');

    captureFetch({}, 403);
    const [rejected, rejectedErr] = await zai.fetchModels(KEY, { useCache: false });
    expect(rejected).toBeNull();
    expect(rejectedErr).toContain('key rejected');

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const [unreachable, unreachableErr] = await zai.fetchModels(KEY, { useCache: false });
    expect(unreachable).toBeNull();
    expect(unreachableErr).toContain('could not reach');
  });
});

describe('zai — credentials and switching', () => {
  it('stores a mode-600 profile with a safe GLM default', () => {
    fs.rmSync(zai.PROFILE, { force: true });
    const profile = zai.saveKey(KEY, '');
    expect(profile).toBe(zai.PROFILE);
    expect((fs.statSync(profile).mode & 0o777).toString(8)).toBe('600');

    const text = fs.readFileSync(profile, 'utf-8');
    expect(text).toContain('ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"');
    expect(text).toContain('ANTHROPIC_MODEL="glm-5.3"');
    expect(text).toContain('ANTHROPIC_API_KEY=""');

    const cfg = {
      baseUrl: 'http://localhost:4001',
      authToken: '',
      apiKey: 'stale-provider-key',
      model: 'another-provider-model',
    };
    const applied = zai.applyTo(cfg);
    expect(applied).toEqual([profile, 'glm-5.3']);
    expect(cfg.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(cfg.authToken).toBe(KEY);
    expect(cfg.apiKey).toBe('');
    expect(cfg.model).toBe('glm-5.3');
    expect(zai.appliesToDefaultEndpoint('http://localhost:4001')).toBe(true);
    expect(zai.appliesToDefaultEndpoint('https://api.z.ai/api/anthropic')).toBe(false);
  });

  it('recognises the Coding Plan key shape without accepting other providers', () => {
    const shaped = `${'a'.repeat(32)}.bcdEFG456789abcd`;
    expect(zai.looksLikeKey(shaped)).toBe(true);
    expect(zai.looksLikeKey(`sk-ant-${'a'.repeat(40)}`)).toBe(false);
    expect(zai.looksLikeKey(`sk-or-v1-${'a'.repeat(40)}`)).toBe(false);
    expect(zai.looksLikeKey(`lfu_${'a'.repeat(40)}`)).toBe(false);
    expect(zai.looksLikeKey('short')).toBe(false);
    expect(zai.looksLikeKey('two tokens that are not a key')).toBe(false);
  });

  it('reuses an existing Claude-style profile for the same endpoint', () => {
    fs.rmSync(zai.PROFILE, { force: true });
    cleanEnv();
    const sourceDir = process.env['ANDY_CLAUDE_SOURCE']!;
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'foreign'),
      'export ANTHROPIC_BASE_URL="https://openrouter.ai/api"\n' +
        'export ANTHROPIC_AUTH_TOKEN="foreign-key-0123456789"\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(sourceDir, 'glm'),
      'export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"\n' +
        `export ANTHROPIC_AUTH_TOKEN="${KEY}"\n` +
        'export ANTHROPIC_MODEL="glm-5.3-flash"\n',
      'utf-8',
    );

    const creds = zai.loadCredentials();
    expect(creds?.[0]).toBe(KEY);
    expect(creds?.[1]).toBe('glm-5.3-flash');
    expect(creds?.[2]).toBe(path.join(sourceDir, 'glm'));
  });

  it('is registered as a built-in source without hijacking other Z.ai protocols', () => {
    expect(sources.BUILTIN_KEYS.has('zai')).toBe(true);
    expect(sources.MODELS_BY_KEY['zai']).toEqual([...zai.DECLARED_MODELS]);
    expect(sources.activeKey('https://api.z.ai/api/anthropic')).toBe('zai');
    expect(sources.activeKey('https://api.z.ai/api/coding/paas/v4')).toBeUndefined();
  });
});

describe('zai — TUI and one-command installation wiring', () => {
  it('exposes the commands, restores the source, and makes npx executable', async () => {
    const app = fs.readFileSync(path.join(ROOT, 'src/ui/app.tsx'), 'utf-8');
    const help = fs.readFileSync(path.join(ROOT, 'src/ui/screens/commands.tsx'), 'utf-8');
    const completion = fs.readFileSync(path.join(ROOT, 'src/ui/complete.tsx'), 'utf-8');
    const modelCommands = fs.readFileSync(
      path.join(ROOT, 'src/ui/screens/model-commands.tsx'),
      'utf-8',
    );
    const cli = fs.readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf-8');
    const launcher = fs.readFileSync(path.join(ROOT, 'packaging/andy'), 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    for (const surface of [app, help, completion]) {
      expect(surface).toContain('/andy-zai');
      expect(surface).toContain('/zai-api-setup');
      expect(surface).toContain('/zai-models');
    }
    expect(app).toContain("sibling<ProviderModule>(import('../zai.js'))");
    expect(cli).toContain("zai: () => import('./zai.js')");
    expect(modelCommands).toContain("if (kind === 'zai') return [m.zai, 'Z.ai'];");
    expect(launcher).toContain('|zai');
    expect(pkg.scripts['prepare']).toBe('npm run build');
  });
});
