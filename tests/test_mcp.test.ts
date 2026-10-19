// Regression suite for mcp.ts's config layer: the part testable without a
// live MCP server. connectOne()/connectAll()/callTool() spawn a real child
// process speaking the MCP wire protocol — not exercised here; that needs
// an actual server binary, which this repo cannot assume is installed.
// ANDY_HOME is pinned to a throwaway tmp dir before import, same discipline
// as test_zai.test.ts / test_anthropic_setup.test.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type Mcp = typeof import('../src/mcp.js');

let mcp: Mcp;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-mcp-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, '.andy');
  mcp = await import('../src/mcp.js');
});

afterEach(() => {
  // Each test starts from no configured servers.
  fs.rmSync(mcp.CONFIG_PATH, { force: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mcp — server name validation', () => {
  it('accepts plain identifiers, rejects anything that could break the mcp__<name>__<tool> shape', () => {
    expect(mcp.looksLikeServerName('fs')).toBe(true);
    expect(mcp.looksLikeServerName('my-server_1')).toBe(true);
    expect(mcp.looksLikeServerName('')).toBe(false);
    expect(mcp.looksLikeServerName('has space')).toBe(false);
    expect(mcp.looksLikeServerName('a'.repeat(41))).toBe(false);
  });
});

describe('mcp — config persistence', () => {
  it('reads as empty before any server is configured', () => {
    expect(mcp.loadServers()).toEqual([]);
    expect(mcp.status()).toEqual([]);
  });

  it('round-trips a server through the mode-600 profile', async () => {
    await mcp.addServer({ name: 'fs', command: 'npx', args: ['-y', 'some-server'] });
    const mode = fs.statSync(mcp.CONFIG_PATH).mode & 0o777;
    expect(mode).toBe(0o600);

    const servers = mcp.loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'fs', command: 'npx', args: ['-y', 'some-server'] });
  });

  it('replaces an existing server of the same name rather than duplicating it', async () => {
    await mcp.addServer({ name: 'fs', command: 'npx', args: ['-y', 'old'] });
    await mcp.addServer({ name: 'fs', command: 'npx', args: ['-y', 'new'] });
    const servers = mcp.loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.args).toEqual(['-y', 'new']);
  });

  it('removeServer reports false for an unknown name and true for a real removal', async () => {
    await mcp.addServer({ name: 'fs', command: 'npx' });
    expect(await mcp.removeServer('nope')).toBe(false);
    expect(await mcp.removeServer('fs')).toBe(true);
    expect(mcp.loadServers()).toEqual([]);
  });

  it('a corrupt config file reads as empty rather than throwing', () => {
    fs.mkdirSync(path.dirname(mcp.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mcp.CONFIG_PATH, 'not json{{{');
    expect(mcp.loadServers()).toEqual([]);
  });
});

describe('mcp — tool-name bridge', () => {
  it('isMcpTool recognises only the mcp__ prefix', () => {
    expect(mcp.isMcpTool('mcp__fs__read_file')).toBe(true);
    expect(mcp.isMcpTool('bash')).toBe(false);
    expect(mcp.isMcpTool('mcp')).toBe(false);
  });

  it('cachedToolSchemas is empty before any server connects (never touches the network itself)', () => {
    expect(mcp.cachedToolSchemas()).toEqual([]);
  });

  it('calling a tool on a server that is not connected fails cleanly, not by throwing', async () => {
    const result = await mcp.callTool('mcp__nope__something', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('nope');
  });

  it('calling a non-mcp-shaped name is rejected without touching any server', async () => {
    const result = await mcp.callTool('not_an_mcp_name', {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not an MCP tool name');
  });
});
