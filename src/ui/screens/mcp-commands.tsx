/**
 * mcp-commands.tsx — /mcp-add, /mcp-remove, /mcp-list.
 *
 * What this module is: the TUI side of mcp.ts's server registry. Own file
 * rather than folded into model-commands.tsx — that file owns the
 * chat-completion /provider-source family (ProviderModule-shaped sources
 * with a credential, a catalog, a baseUrl to switch to); an MCP server has
 * none of those, it is a child process that contributes tools, closer in
 * kind to campaigns.tsx's worker commands than to a model source.
 */

import { Box, Text } from 'ink';
import type { AppCtx } from '../app.js';

/** `/mcp-add <name> <command> [arg ...] [-- --flag-looking-like-an-arg]`.
 * The `--` separator is accepted but not required — args rarely start with
 * `-` in practice (an MCP server's own CLI flags go right after `--`), and
 * requiring it for the common case (`npx some-mcp-server`) would just be
 * friction. */
export function cmdMcpAdd(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  if (args.length < 2) {
    ctx.sysLine(
      'usage: /mcp-add <name> <command> [arg ...]  — e.g. /mcp-add fs npx -y @modelcontextprotocol/server-filesystem /tmp',
      true,
    );
    return;
  }
  const [name, command, ...rest] = args;
  if (!m.mcp.looksLikeServerName(name ?? '')) {
    ctx.sysLine(
      'server name must be 1-40 chars of letters, digits, - or _ (it becomes part of the tool name the model sees)',
      true,
    );
    return;
  }
  void (async () => {
    await m.mcp.addServer({ name: name!, command: command!, args: rest });
    ctx.sysLine(`MCP server '${name}' saved to ~/.andy/mcp.json`, true, true);
    ctx.sysLine('connecting…');
    await m.mcp.connectAll();
    const st = m.mcp.status().find((s) => s.name === name);
    if (st?.connected) {
      ctx.sysLine(`connected — ${st.toolCount} tool(s) available as mcp__${name}__*`, true, true);
    } else {
      ctx.sysLine(`could not connect${st?.error ? `: ${st.error}` : ''} — check the command and args`, true);
    }
  })();
}

export function cmdMcpRemove(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const name = (args[0] ?? '').trim();
  if (!name) {
    ctx.sysLine('usage: /mcp-remove <name>', true);
    return;
  }
  void (async () => {
    const removed = await m.mcp.removeServer(name);
    ctx.sysLine(removed ? `removed '${name}'` : `no server named '${name}'`, true, removed);
  })();
}

export function cmdMcpList(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  void (async () => {
    // A first look connects, same as any other catalog-warming command
    // (/zai-models etc.) — the operator asking "what's configured" is
    // exactly when finding out "does it actually connect" is useful too.
    await m.mcp.connectAll();
    const servers = m.mcp.status();
    if (servers.length === 0) {
      ctx.say(
        <Box flexDirection="column">
          <Text bold color={p.accent}>
            {'  MCP SERVERS\n\n'}
          </Text>
          <Text color={p.amber}>{'  none configured.\n\n'}</Text>
          <Box>
            <Text color={p.dim}>{'  add one with  '}</Text>
            <Text bold color={p.primary}>
              {'/mcp-add <name> <command> [args...]\n'}
            </Text>
          </Box>
        </Box>,
      );
      return;
    }
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  MCP SERVERS\n\n'}
        </Text>
        {servers.map((s) => (
          <Box key={s.name} flexDirection="column">
            <Box>
              <Text bold={s.connected} color={s.connected ? p.accent : p.primary}>
                {`  ${s.connected ? '◉' : '○'} ${s.name.padEnd(16)}`}
              </Text>
              <Text color={p.dim}>
                {s.connected ? `${s.toolCount} tool(s) — mcp__${s.name}__*` : s.error ? `error: ${s.error}` : 'not connected'}
              </Text>
            </Box>
            <Text color={p.dim}>{`      ${[s.command, ...s.args].join(' ')}\n`}</Text>
          </Box>
        ))}
        <Box>
          <Text color={p.dim}>{'  remove one with  '}</Text>
          <Text bold color={p.primary}>
            {'/mcp-remove <name>\n'}
          </Text>
        </Box>
      </Box>,
    );
  })();
}

