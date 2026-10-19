/**
 * plugin-commands.tsx — /plugin-install, /plugin-remove, /plugins.
 *
 * What this module is: the TUI side of plugins.ts's local-install registry.
 * See plugins.ts's file contract for what this does and does not support
 * (local directories only, skills only — no marketplace fetch, no
 * commands/agents/hooks bundling).
 */

import { Box, Text } from 'ink';
import type { AppCtx } from '../app.js';

export function cmdPluginInstall(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const source = (args[0] ?? '').trim();
  if (!source) {
    ctx.sysLine('usage: /plugin-install <local directory>  — must contain plugin.json', true);
    return;
  }
  try {
    const manifest = m.plugins.installLocal(source);
    const skills = m.skills.list(ctx.cfg.workdir).filter((s) => s.name.startsWith(`${manifest.name}:`));
    ctx.sysLine(
      `installed '${manifest.name}'${manifest.version ? ` v${manifest.version}` : ''} — ${skills.length} skill(s) available as ${manifest.name}:*`,
      true,
      true,
    );
  } catch (e) {
    ctx.sysLine(e instanceof Error ? e.message : String(e), true);
  }
}

export function cmdPluginRemove(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const name = (args[0] ?? '').trim();
  if (!name) {
    ctx.sysLine('usage: /plugin-remove <name>', true);
    return;
  }
  const removed = m.plugins.remove(name);
  ctx.sysLine(removed ? `removed '${name}'` : `no plugin named '${name}'`, true, removed);
}

export function cmdPlugins(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  const installed = m.plugins.list();
  if (installed.length === 0) {
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  PLUGINS\n\n'}
        </Text>
        <Text color={p.amber}>{'  none installed.\n\n'}</Text>
        <Box>
          <Text color={p.dim}>{'  install a local one with  '}</Text>
          <Text bold color={p.primary}>
            {'/plugin-install <dir>\n'}
          </Text>
        </Box>
        <Text color={p.dim}>{'  (local directories only — see /help for the install layout)\n'}</Text>
      </Box>,
    );
    return;
  }
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  PLUGINS\n\n'}
      </Text>
      {installed.map((pl) => (
        <Box key={pl.dir} flexDirection="column">
          <Box>
            <Text bold color={p.primary}>{`  ${pl.name}`}</Text>
            {pl.version ? <Text color={p.dim}>{` v${pl.version}`}</Text> : null}
            <Text color={p.dim}>{`  —  ${pl.skillDirs.length} skill dir(s)\n`}</Text>
          </Box>
          <Text color={p.dim}>{`    ${pl.description}\n`}</Text>
        </Box>
      ))}
      <Box>
        <Text color={p.dim}>{'  remove one with  '}</Text>
        <Text bold color={p.primary}>
          {'/plugin-remove <name>\n'}
        </Text>
      </Box>
    </Box>,
  );
}
