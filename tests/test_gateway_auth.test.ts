// tests/test_gateway_auth.test.ts — vitest port of tests/test_gateway_auth.py.
// What this file is: regressions for bugs found by pointing the harness at a
// hosted gateway live — each a case where the harness had all the information
// needed to be right and said the wrong thing anyway:
//  1. a bearer token and a placeholder key were sent together (401 bait);
//  2. a free model was billed at the paid model's rate (and an unknown free
//     model at DEFAULT_PRICE);
//  3. a zero balance (402) was reported as an auth failure;
//  4. a gated model (403) and a throttled free tier (429) read as raw dicts.
// No network: every case is constructed locally from the real SDK error
// classes, because friendlyError dispatches on instanceof.
// Port note: the TS SDK lazily resolves ambient credentials on the first
// authHeaders() call, so the env pinning in beforeAll clears the ANTHROPIC_*
// vars (as the Python run did) AND points the credential chain at an empty
// temp config dir — an operator-side config there must not mint a header the
// harness never asked for.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { Agent } from '../src/agent.js';
import { DEFAULT_PRICE, PRICING, Config, priceFor } from '../src/config.js';

const ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  // The TS SDK's ambient credential chain (absent in the Python SDK): without
  // clearing these too, an operator shell could satisfy the chain.
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
];

const SAVED: Record<string, string | undefined> = {};
let CRED_DIR = '';

beforeAll(() => {
  // Cleared for the WHOLE run, not per case: the SDK falls back to these
  // variables itself when a client is built with no credential, so restoring
  // them between cases would leak a live token into the very assertions about
  // sending no credential at all.
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  CRED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-gwauth-'));
  process.env['ANTHROPIC_CONFIG_DIR'] = CRED_DIR;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  if (!('ANTHROPIC_CONFIG_DIR' in SAVED)) delete process.env['ANTHROPIC_CONFIG_DIR'];
  fs.rmSync(CRED_DIR, { recursive: true, force: true });
});

function cfg(overrides: { apiKey?: string; authToken?: string }): Config {
  // A Config with ONLY the credentials passed in (see beforeAll).
  return Config.fromEnv({
    workdir: path.resolve('.'),
    baseUrl: 'https://openrouter.ai/api',
    apiKey: overrides.apiKey ?? '',
    authToken: overrides.authToken ?? '',
  });
}

/** The auth headers the SDK will actually send for *cfg*, read off the built
 *  client (its authHeaders() seam) rather than from a request, so the
 *  assertion is about what the harness configures. */
async function authHeaders(cfgIn: Config): Promise<Record<string, string>> {
  const agent = new Agent(cfgIn);
  const client = agent.client as unknown as {
    authHeaders(o: object): Promise<{ values?: Headers } | undefined>;
  };
  const h = await client.authHeaders({});
  const out: Record<string, string> = {};
  h?.values?.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

// --- 1. one credential, not two -------------------------------------------

describe('gateway auth — one credential, not two', () => {
  it('a bearer token is sent alone (the bug: bearer + x-api-key placeholder -> 401)', async () => {
    const hdrs = await authHeaders(cfg({ authToken: 'sk-live-token', apiKey: '' }));
    expect(hdrs['authorization'], 'auth: the bearer token is sent').toBe('Bearer sk-live-token');
    expect(!('x-api-key' in hdrs), 'auth: no x-api-key is sent alongside it').toBe(true);
  });

  it('a stale api_key is not forwarded with a token', async () => {
    // A key left over from another provider is a credential for the wrong service.
    const hdrs = await authHeaders(cfg({ authToken: 'sk-live-token', apiKey: 'sk-other-provider' }));
    expect(hdrs['authorization'], 'auth: the bearer token still wins').toBe('Bearer sk-live-token');
    expect(!('x-api-key' in hdrs), 'auth: the stale api_key is NOT forwarded').toBe(true);
  });

  it('a plain api_key still works on its own', async () => {
    const hdrs = await authHeaders(cfg({ apiKey: 'sk-plain-key' }));
    expect(hdrs['x-api-key'], 'auth: a plain api_key is still sent').toBe('sk-plain-key');
    expect(!('authorization' in hdrs), 'auth: no bearer token is invented').toBe(true);
  });

  it('no credential sends no auth header', async () => {
    // The placeholder existed only to give the SDK a non-empty string. None
    // constructs just as well and puts nothing on the wire — which is what
    // lets an unauthenticated local proxy work.
    const hdrs = await authHeaders(cfg({ apiKey: '', authToken: '' }));
    expect(!('authorization' in hdrs), 'auth: no authorization header').toBe(true);
    expect(!('x-api-key' in hdrs), 'auth: no x-api-key header').toBe(true);
  });
});

// --- 2. a free model costs nothing -----------------------------------------

describe('gateway auth — a free model costs nothing', () => {
  it('a free suffix is priced at zero (the bug: prefix tolerance billed it)', () => {
    expect(priceFor('deepseek-v4.1-flash-free'), 'price: a -free suffix is free').toEqual([0.0, 0.0]);
    expect(priceFor('dots-studio/dots-3-note-preview:free'), "price: OpenRouter's :free suffix is free").toEqual([0.0, 0.0]);
    expect(priceFor('gemini-3.8-flash-free'), 'price: a bare -free model is free').toEqual([0.0, 0.0]);
  });

  it('an unknown free model is not billed the default', () => {
    const got = priceFor('some-brand-new-model-free');
    expect(
      got[0] === 0 && got[1] === 0 && (got[0] !== DEFAULT_PRICE[0] || got[1] !== DEFAULT_PRICE[1]),
      'price: an unknown free model is free, not DEFAULT_PRICE',
    ).toBe(true);
  });

  it('a paid model keeps its price', () => {
    expect(priceFor('deepseek-v4.1-flash'), 'price: the paid row is unchanged').toEqual(
      PRICING['deepseek-v4.1-flash']!,
    );
    expect(priceFor('qwen-3.8-27b'), 'price: another paid row is unchanged').toEqual(
      PRICING['qwen-3.8-27b']!,
    );
    expect(priceFor('brand-new-paid-model'), 'price: an unknown paid model still gets DEFAULT_PRICE').toEqual(
      DEFAULT_PRICE,
    );
  });

  it("'freebie' in the middle is not free", () => {
    // The suffix has to be exact — a substring match would mis-price a real charge.
    const got = priceFor('some-paid:freebie');
    expect(got[0] !== 0 || got[1] !== 0, "price: 'freebie' is not mistaken for 'free'").toBe(true);
    const got2 = priceFor('free-tier-plus');
    expect(got2[0] !== 0 || got2[1] !== 0, "price: a leading 'free' is not a free suffix").toBe(true);
  });
});

// --- 3/4. statuses with a true, useful answer -------------------------------

/** The SDK error the gateway's response would actually produce. The class
 *  matters, not just the status: friendlyError dispatches on instanceof, and
 *  the SDK raises AuthenticationError for a 401 — a bare APIError would fall
 *  through to the generic branch. 402 has no dedicated subclass, so the base
 *  is correct there. */
function statusError(code: number, body: Record<string, unknown>): APIError {
  type ErrCtor = new (
    status: number,
    error: object,
    message: undefined,
    headers: undefined,
  ) => APIError;
  const cls: ErrCtor = (
    code === 401
      ? AuthenticationError
      : code === 403
        ? PermissionDeniedError
        : code === 429
          ? RateLimitError
          : APIError
  ) as unknown as ErrCtor;
  return new cls(code, body, undefined, undefined);
}

function friendly(e: unknown): string {
  return (Agent as unknown as { friendlyError(err: unknown): string }).friendlyError(e);
}

describe('gateway auth — status errors that are not auth failures', () => {
  it('a zero balance is reported as a billing state', () => {
    const err = statusError(402, {
      error: { type: 'insufficient_credits', message: 'Insufficient balance.' },
    });
    const msg = friendly(err);
    expect(msg.includes('no credit'), '402: the credit state is named').toBe(true);
    expect(msg.includes('/models'), '402: it points at the free models').toBe(true);
    expect(!msg.includes('authentication failed'), '402: it is not reported as an auth failure').toBe(true);
    expect(!msg.includes('check ANTHROPIC'), '402: it does not blame the key').toBe(true);
  });

  it('a real auth failure is still an auth failure', () => {
    const err = statusError(401, {
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    });
    const msg = friendly(err);
    expect(msg.includes('authentication failed'), '401: still reads as an auth failure').toBe(true);
    expect(!msg.includes('no credit'), '401: it does not claim a billing problem').toBe(true);
  });

  it('a gated model is not an auth failure', () => {
    // Measured live: thinkingmachines/inkling:free on OpenRouter answers 403
    // with "only available on agentic harnesses". The key is valid and
    // thirteen other free models on it work in the same minute, so "check
    // your key" would send the operator to re-check something that is fine.
    const err = statusError(403, {
      error: {
        type: 'error',
        error: {
          type: 'permission_error',
          error_type: 'permission_denied',
          message: 'only available on agentic harnesses.',
        },
      },
    });
    const msg = friendly(err);
    expect(msg.includes('gated'), '403: the gate is named').toBe(true);
    expect(msg.includes('key is fine'), '403: it says the key is fine').toBe(true);
    expect(msg.includes('/models'), '403: it points at another model').toBe(true);
    expect(!msg.includes('authentication failed'), '403: it is not reported as an auth failure').toBe(true);
    expect(
      !msg.includes("{'type'") && !msg.includes('permission_error'),
      '403: it does not leak a raw error dict',
    ).toBe(true);
  });

  it('a throttled free model suggests another model', () => {
    // Measured: three free OpenRouter models 429'd while eleven others on the
    // same key answered, in the same minute — so "wait and retry" is the
    // wrong advice.
    const err = statusError(429, {
      error: { type: 'rate_limit_exceeded', message: 'Rate limit exceeded' },
    });
    const msg = friendly(err);
    expect(msg.includes('rate limited'), '429: it names the throttle').toBe(true);
    expect(msg.includes('/models'), '429: it points at another free model').toBe(true);
    expect(!msg.includes('authentication failed'), '429: it is not reported as an auth failure').toBe(true);
  });
});
