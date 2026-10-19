/**
 * mcp.ts — Model Context Protocol client: external tool servers as Andy tools.
 *
 * What this module is: the thing that lets an operator point Andy at any
 * MCP-compatible server (filesystem, databases, SaaS APIs, whatever) the
 * same way Claude Code does, and have its tools show up in Andy's own tool
 * list. Stdio transport only — a local child process speaking MCP over its
 * stdin/stdout — which covers the overwhelming majority of MCP servers in
 * the wild (`npx <server-package>`, a local binary, a Python script). SSE/
 * HTTP transports are a real gap, not implemented here; see
 * appliesToDefaultEndpoint-style modules for the shape a remote-transport
 * variant would take if it's ever needed.
 *
 * Invariants:
 *  - Config lives at ~/.andy/mcp.json, mode 600 (a server's `env` can carry
 *    an API key) — same profile-file discipline every other source in this
 *    repo follows. The list is the operator's declared servers; it is not
 *    itself a credential, but entries routinely carry one.
 *  - One server failing to connect/spawn must never take the others down —
 *    connectAll() isolates each attempt and reports per-server failure
 *    rather than throwing.
 *  - Every MCP tool is gated (needsPermission() in tools.ts treats the
 *    `mcp__` prefix as gated, same bucket as bash/write_file/edit_file) —
 *    an MCP server is operator-configured but still executes arbitrary code
 *    with no safety contract Andy can verify, so it gets the permission
 *    modal by default in every mode, bypassable the same way bash is
 *    (scope.armed, /always, allow.yaml).
 *  - Tool names are prefixed `mcp__<server>__<tool>` — Claude Code's own
 *    convention, which is the whole point: an operator who already knows
 *    MCP from Claude Code recognises Andy's tool names immediately.
 *  - connectAll() is idempotent and cheap after the first real connect —
 *    called once per turn from agent.ts's runTurn(), same as
 *    contextWindow(); a session with no configured servers returns
 *    instantly without ever touching node:child_process.
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { andyHome } from './shared.js';
import type { ToolResult, ToolSchema } from './shared.js';

// === SECTION === config ===

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const CONFIG_PATH = path.join(andyHome(), 'mcp.json');

/** Read the configured server list. Never throws — a missing or corrupt
 * file reads as no servers, the same "unset means empty" discipline every
 * other profile in this repo follows. */
export function loadServers(): McpServerConfig[] {
  if (!existsSync(CONFIG_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is McpServerConfig =>
        s && typeof s === 'object' && typeof s.name === 'string' && typeof s.command === 'string',
    );
  } catch {
    return [];
  }
}

/** Mode 600 — a server's `env` routinely carries an API key. */
function saveServers(servers: McpServerConfig[]): void {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  try {
    chmodSync(path.dirname(CONFIG_PATH), 0o700);
  } catch {
    /* read-only home: the TUI must survive */
  }
  const fd = openSync(CONFIG_PATH, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(servers, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

export function looksLikeServerName(name: string): boolean {
  // Becomes part of a tool name (mcp__<name>__<tool>) sent to the model's
  // tool-use API, which is stricter about identifier shape than a filename
  // would need to be.
  return /^[A-Za-z0-9_-]{1,40}$/.test(name);
}

/** Add or replace a server by name. Disconnects any existing live client
 * for that name first, since its config just changed underneath it. */
export async function addServer(cfg: McpServerConfig): Promise<McpServerConfig[]> {
  await disconnect(cfg.name);
  const servers = loadServers().filter((s) => s.name !== cfg.name);
  servers.push(cfg);
  saveServers(servers);
  return servers;
}

export async function removeServer(name: string): Promise<boolean> {
  const servers = loadServers();
  const next = servers.filter((s) => s.name !== name);
  if (next.length === servers.length) return false;
  await disconnect(name);
  saveServers(next);
  return true;
}

// === SECTION === live connections ===

/** The SDK's own Tool shape, trimmed to what this module reads. Avoids
 * importing the SDK's zod-inferred types by name here, so this file's own
 * exported surface doesn't leak a third-party type across the tools.ts /
 * agent.ts boundary. */
interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface ConnectedServer {
  // `unknown`-typed on purpose: the SDK's Client type is generic over
  // request/notification/result unions this module never specialises, and
  // naming it precisely here would require importing those unions too. The
  // two calls this module makes on it (callTool, close) are invoked through
  // a narrow local cast at the call site instead.
  client: unknown;
  tools: McpTool[];
}

const connected = new Map<string, ConnectedServer>();
/** Servers that failed to connect on the last attempt, with why — surfaced
 * by /mcp-list so a typo'd command doesn't fail silently into "no tools". */
const lastErrors = new Map<string, string>();
let everConnected = false;

interface ClientLike {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

async function connectOne(cfg: McpServerConfig): Promise<void> {
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
    });
    const client = new Client({ name: 'andy', version: '1.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    connected.set(cfg.name, { client, tools: (listed.tools ?? []) as McpTool[] });
    lastErrors.delete(cfg.name);
  } catch (e) {
    lastErrors.set(cfg.name, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Connect every configured server that isn't already connected. Idempotent
 * and near-free once everything is up — called once per turn from
 * runTurn(), same pattern as contextWindow(). A server that failed last
 * time is retried on the next call (a flaky server coming back up should
 * not need the operator to notice and reconnect by hand); one that is
 * already live is left alone rather than reconnected.
 */
export async function connectAll(): Promise<void> {
  const servers = loadServers();
  everConnected = true;
  await Promise.all(
    servers.filter((s) => !connected.has(s.name)).map((s) => connectOne(s)),
  );
}

export async function disconnect(name: string): Promise<void> {
  const entry = connected.get(name);
  if (!entry) return;
  connected.delete(name);
  try {
    await (entry.client as ClientLike).close();
  } catch {
    /* best effort — the process may already be gone */
  }
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connected.keys()].map((name) => disconnect(name)));
}

// === SECTION === tool-list / tool-call bridge ===

const PREFIX = 'mcp__';

function qualifiedName(server: string, tool: string): string {
  return `${PREFIX}${server}__${tool}`;
}

/** Split a qualified tool name back into [server, tool], or null if it is
 * not one of ours. Servers and tools are both free-form MCP identifiers
 * that could themselves contain `__`, so this takes the FIRST segment as
 * the server (names are validated against looksLikeServerName, which bars
 * underscores adjacent in a way that would make this ambiguous in
 * practice) and the remainder as the tool name verbatim. */
function splitQualifiedName(name: string): [string, string] | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  return [rest.slice(0, sep), rest.slice(sep + 2)];
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(PREFIX);
}

/**
 * Every tool from every currently-connected server, in Andy's own
 * ToolSchema shape. Synchronous and reads only the cache connectAll()
 * populated — agent.ts assembles its tool list synchronously once per
 * round, so this must never touch the network itself.
 */
export function cachedToolSchemas(): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const [server, entry] of connected) {
    for (const t of entry.tools) {
      out.push({
        name: qualifiedName(server, t.name),
        description: t.description
          ? `[MCP: ${server}] ${t.description}`
          : `[MCP: ${server}] ${t.name}`,
        input_schema: {
          type: 'object',
          properties: t.inputSchema.properties ?? {},
          required: t.inputSchema.required,
        },
      });
    }
  }
  return out;
}

/** Flatten an MCP CallToolResult's content blocks into the single string
 * ToolResult.output expects. Non-text blocks (image, resource, …) are
 * named rather than silently dropped, so the model at least knows
 * something came back that it cannot read here. */
function flattenContent(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content || content.length === 0) return '(empty result)';
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content, not shown]`))
    .join('\n');
}

/** Run a qualified mcp__<server>__<tool> call. Called from tools.ts's
 * execute() for any name isMcpTool() admits — never thrown to the turn
 * loop, same contract as every other tool handler. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const split = splitQualifiedName(name);
  if (!split) return { output: `not an MCP tool name: ${name}`, isError: true };
  const [server, tool] = split;
  const entry = connected.get(server);
  if (!entry) {
    const why = lastErrors.get(server);
    return {
      output: why
        ? `MCP server '${server}' is not connected (${why}) — check /mcp-list`
        : `MCP server '${server}' is not connected — is it in /mcp-list?`,
      isError: true,
    };
  }
  try {
    const result = await (entry.client as ClientLike).callTool({ name: tool, arguments: args });
    return { output: flattenContent(result.content), isError: result.isError === true };
  } catch (e) {
    return {
      output: `MCP call to ${server}/${tool} failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

// === SECTION === status, for /mcp-list ===

export interface ServerStatus {
  name: string;
  command: string;
  args: string[];
  connected: boolean;
  toolCount: number;
  error?: string;
}

/** Status of every configured server, connected or not — connectAll() must
 * have run at least once in this process for "connected" to be meaningful;
 * before that every server reads as not-yet-attempted rather than failed. */
export function status(): ServerStatus[] {
  return loadServers().map((s) => {
    const entry = connected.get(s.name);
    const err = lastErrors.get(s.name);
    return {
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      connected: Boolean(entry),
      toolCount: entry?.tools.length ?? 0,
      ...(err && !entry ? { error: err } : {}),
    };
  });
}

export function hasEverConnected(): boolean {
  return everConnected;
}
