// Regression suite for the direct-Anthropic source (anthropic-setup.ts).
//
// ANDY_HOME is pinned to a throwaway tmp dir before import, since the module
// resolves PROFILE at load time — same discipline as test_zai.test.ts. No
// network is involved: this source has no marketplace catalog to fetch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type AnthropicSetup = typeof import('../src/anthropic-setup.js');

const KEY = 'sk-ant-' + 'test-fake-0123456789abcdef';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
] as const;

function cleanEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

let anthropicSetup: AnthropicSetup;
let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-anthropic-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  anthropicSetup = await import('../src/anthropic-setup.js');
});

afterEach(() => {
  cleanEnv();
});

afterAll(() => {
  cleanEnv();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('anthropic-setup — endpoint', () => {
  it('points at the real Anthropic Messages endpoint, not the local proxy', () => {
    expect(anthropicSetup.DEFAULT_BASE_URL).toBe('https://api.anthropic.com');
    expect(anthropicSetup.HOST).toBe('api.anthropic.com');
    expect(anthropicSetup.activeEndpoint === anthropicSetup.isAnthropic).toBe(true);
    expect(anthropicSetup.isAnthropic('https://api.anthropic.com/v1')).toBe(true);
    expect(anthropicSetup.isAnthropic('http://localhost:4001')).toBe(false);
  });

  it('only replaces a blank or local-default baseUrl, never a deliberate one', () => {
    expect(anthropicSetup.appliesToDefaultEndpoint('')).toBe(true);
    expect(anthropicSetup.appliesToDefaultEndpoint('http://localhost:4001')).toBe(true);
    expect(anthropicSetup.appliesToDefaultEndpoint('https://api.anthropic.com')).toBe(false);
    expect(anthropicSetup.appliesToDefaultEndpoint('https://api.z.ai/api/anthropic')).toBe(false);
  });
});

describe('anthropic-setup — credential profile', () => {
  it('has no key before one is saved', () => {
    expect(anthropicSetup.hasKey()).toBe(false);
    expect(anthropicSetup.loadCredentials()).toBeNull();
  });

  it('round-trips a saved key through the mode-600 profile', () => {
    const savedPath = anthropicSetup.saveKey(KEY);
    expect(savedPath).toBe(anthropicSetup.PROFILE);

    const mode = fs.statSync(anthropicSetup.PROFILE).mode & 0o777;
    expect(mode).toBe(0o600);

    const creds = anthropicSetup.loadCredentials();
    expect(creds).not.toBeNull();
    const [token, model, origin] = creds!;
    expect(token).toBe(KEY);
    expect(model).toBe('');
    expect(origin).toBe(anthropicSetup.PROFILE);
    expect(anthropicSetup.hasKey()).toBe(true);
  });

  it('prefers the environment over a saved profile', () => {
    anthropicSetup.saveKey(KEY);
    process.env['ANTHROPIC_API_KEY'] = 'env-wins-key-0123456789';
    const [token, , origin] = anthropicSetup.loadCredentials()!;
    expect(token).toBe('env-wins-key-0123456789');
    expect(origin).toBe('environment');
  });

  it('points cfg at the real endpoint and clears authToken on applyTo', () => {
    anthropicSetup.saveKey(KEY);
    const cfg = { baseUrl: 'http://localhost:4001', apiKey: '', authToken: 'stale', model: 'deepseek-v4.1-flash' };
    const applied = anthropicSetup.applyTo(cfg);
    expect(applied).not.toBeNull();
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.apiKey).toBe(KEY);
    expect(cfg.authToken).toBe('');
    // No model was saved, so applyTo must not clobber the caller's model.
    expect(cfg.model).toBe('deepseek-v4.1-flash');
  });

  it('returns null from applyTo when no credential exists anywhere', () => {
    fs.rmSync(anthropicSetup.PROFILE, { force: true }); // a prior test may have left one
    const cfg = { baseUrl: 'x', apiKey: '', authToken: '', model: 'm' };
    expect(anthropicSetup.applyTo(cfg)).toBeNull();
    expect(cfg.baseUrl).toBe('x'); // untouched
  });
});

describe('anthropic-setup — key validation and static catalog', () => {
  it('rejects obvious paste errors without calling out to Anthropic', () => {
    expect(anthropicSetup.looksLikeKey(KEY)).toBe(true);
    expect(anthropicSetup.looksLikeKey('too-short')).toBe(false);
    expect(anthropicSetup.looksLikeKey('has a space in it 0123456789')).toBe(false);
    expect(anthropicSetup.looksLikeKey('sk-or-openrouter-key-not-anthropic')).toBe(false);
  });

  it('serves the static KNOWN_MODELS roster with no network call', async () => {
    const [models, err] = await anthropicSetup.fetchModels();
    expect(err).toBe('');
    expect(models).not.toBeNull();
    expect(models!.length).toBeGreaterThan(0);
    expect(anthropicSetup.cachedModels()).toEqual(models);
    expect(anthropicSetup.catalogAge()).toBe(0);
  });
});
