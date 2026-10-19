/**
 * commands.tsx — the session-level slash commands (split from app.tsx once it
 * passed ~3k lines).
 *
 * What this module is: /help /mode /clear /cost /limits /scope /rain /think
 * /theme /save /load /compact /panes /andy-opencode — the commands that read or
 * switch harness state rather than start a campaign. Invariant: every handler
 * receives the AppCtx seam (live refs, never stale copies) and mutates widget
 * state only through it; none of these starts a turn on the main agent except
 * /compact, which drives the agent's own compaction.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import fsSync from 'node:fs';
import path from 'node:path';
import type { AppCtx, HostSetLike } from '../app.js';
import { fmtG, fmtInt } from '../app.js';

export function cmdHelp(ctx: AppCtx, _args?: string[]): void {
  const p = ctx.pal();
  const m = ctx.mods();
  const rows: [string, string][] = [
    ['/help', 'this help'],
    ['/mode [name]', 'switch mode: auto | edits | plan | andy | danger | uncensored'],
    ['/clear', 'wipe the transcript and conversation history'],
    ['/model [name]', 'show or switch the model'],
    ['/cost', 'session token and cost breakdown'],
    ['/scope', 'show allow.yaml / out-of-scope.yaml status'],
    ['/rain', 'toggle the matrix-rain background'],
    ['/think', "toggle showing the model's own reasoning"],
    ['/theme green|amber|cyan|system', 'switch the color theme'],
    ['/andy-logfare', 'switch upstream to Logfare        (:4001)'],
    ['/andy-tokenjuice', 'switch upstream to Token Juice    (:4000)'],
    ['/andy-tokenharbour', 'switch upstream to TokenHarbour (hosted)'],
    ['/andy-openrouter', 'switch upstream to OpenRouter   (hosted)'],
    ['/andy-unorouter', 'switch upstream to UnoRouter    (hosted, free models)'],
    ['/andy-aihubmix', 'switch upstream to AIHubMix     (hosted, free models)'],
    ['/andy-zai', 'switch upstream to Z.ai          (GLM Coding Plan)'],
    ['/andy-anthropic', 'switch upstream to Anthropic     (api.anthropic.com)'],
    ['/andy-antseed', 'switch upstream to AntSeed (local buyer, free peers)'],
    ['/andy-source', 'show upstream sources and their status'],
    ['/tokenharbour-api-setup <key>', 'store your TokenHarbour API key'],
    ['/tokenharbour-models', 'fetch the live catalog; show what is free'],
    ['/openrouter-api-setup [key]', 'store your OpenRouter API key (optional)'],
    ['/unorouter-api-setup [key]', 'store your UnoRouter API key (optional)'],
    ['/unorouter-models', 'the live free catalog — what is free and usable'],
    ['/aihubmix-api-setup [key]', 'store your AIHubMix API key (optional)'],
    ['/aihubmix-models', 'the live free catalog — what is free and usable'],
    ['/zai-api-setup [key]', 'store your Z.ai Coding Plan API key (optional)'],
    ['/zai-models', 'the GLM Coding Plan model registry'],
    ['/anthropic-api-setup [key]', 'store your Anthropic API key'],
    ['/anthropic-models', 'the Claude model roster (static, no key needed)'],
    ['/mcp-add <name> <cmd> [args]', 'add an MCP server (stdio) — just like Claude Code'],
    ['/mcp-remove <name>', 'remove an MCP server'],
    ['/mcp-list', 'list configured MCP servers and their tools'],
    ['/antseed-models', "AntSeed's free models, and the peer to pin"],
    ['/models', 'free models of an upstream — /models [source]'],
    ['/logfare-models', 'fetch the live catalog; show what is up'],
    ['/ldxhub-api-setup [key]', 'store your LDXHub API key (document jobs)'],
    ['/ldxhub-models [service]', 'LDXHub models/engines — pick the default per service'],
    ['/panes', 're-open this session under tmux — ctrl+b h/v split'],
    ['/andy-opencode', 'open opencode behind a fresh rotating IP'],
    ['/save [name]', 'write the session to disk'],
    ['/load [name]', 'restore a saved session'],
    ['/compact', 'summarise history to free context'],
    ['/limits', 'context window, round caps, timeouts — and where each comes from'],
    ['/team <task>', 'fan the task out across parallel agents'],
    ['/osint [kind] <target>', 'open-source recon — email, phone, socials'],
    ['/osint-tree [kind|path]', 're-show a finished recon as a result tree'],
    ['/phish <host>', 'clone a login page, serve it, harvest creds'],
    ['/scope-validator', 'paste a programme overview → allow.yaml, out-of-scope.yaml, ranked targets'],
    ['/bug-hunt <target>', 'recon, then one wave of 10 agents'],
    ['/bug-hunt <target> --wave N', 'run wave N specifically'],
    ['/ad <domain> --ack <domain>', 'AD campaign — gated, interlocks on'],
    ['/ad tools', 'what AD tooling this host actually has'],
    ['/crack <file|dir>', 'crack hashes offline — CPU only, budgeted'],
    ['/crack <file|dir> --deep', 'add the rule set that takes hours'],
    ['/stop-hunt', 'end a running hunt       (works while busy)'],
    ['/summary-hunt', 'the hunt report          (works while busy)'],
    ['/report-bug-hunt', 'evidence-only report, every wave'],
    ['/findings', 'the finding tracker      (works while busy)'],
    ['/exit', 'leave the harness        (Ctrl+D also works)'],
  ];
  const modes = m ? Object.entries(m.config.MODES) : [];
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  COMMANDS\n\n'}
      </Text>
      {rows.map(([name, desc], i) => (
        <Box key={i}>
          <Text bold color={p.primary}>
            {`  ${name.padEnd(24)}`}
          </Text>
          <Text color={p.dim}>{desc + '\n'}</Text>
        </Box>
      ))}
      <Text bold color={p.accent}>
        {'\n  MODES\n\n'}
      </Text>
      {modes.map(([name, spec]) => (
        <Box key={name}>
          <Text bold color={spec.loud ? p.red : p.primary}>
            {`  ${name.padEnd(10)}`}
          </Text>
          <Text color={p.dim}>{spec.blurb + '\n'}</Text>
        </Box>
      ))}
      <Text bold color={p.accent}>
        {'\n  MENTIONS  '}
      </Text>
      <Text color={p.dim}>
        {"@path attaches a file's contents   ·   type / or @ for the popup\n"}
      </Text>
      <Text bold color={p.accent}>
        {'  KEYS  '}
      </Text>
      <Text color={p.dim}>
        {'↑↓ select · Tab accept · Esc close · Ctrl+C interrupt · Ctrl+D exit\n'}
      </Text>
    </Box>,
  );
}

export function setMode(ctx: AppCtx, name: string): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  ctx.cfg.mode = name;
  a.setMode(name);
  ctx.updateHeader({ mode: name });
  if (name === 'andy') {
    // Re-resolve rather than trusting the launch-time value: a session started
    // in one directory and switched to andy from another would otherwise arm
    // with no file at all. An explicit --agents path is never overridden.
    if (ctx.cfg.agentsPath === null || !fsSync.existsSync(ctx.cfg.agentsPath)) {
      const found = m.config.findAgentsFile(ctx.cfg.workdir, ctx.cfg.stateDir);
      if (found !== undefined) ctx.cfg.agentsPath = found;
    }
    const src = ctx.cfg.agentsPath;
    if (src) {
      ctx.sysLine(`ANDY MODE ARMED — following ${src} · full auto`, true);
    } else {
      ctx.sysLine('ANDY MODE ARMED — no AGENTS.md found (set --agents PATH)', true);
    }
  } else if (name === 'danger') {
    ctx.sysLine(
      "DANGER MODE ARMED — every tool runs unattended and the operator's word is law; nothing is questioned",
      true,
    );
  } else if (name === 'uncensored') {
    ctx.sysLine(
      'UNCENSORED MODE ARMED — the default prompt is gone; the model cannot refuse and will only think how to do it',
      true,
    );
  } else {
    const spec = m.config.MODES[name];
    if (spec) ctx.sysLine(`mode → ${spec.label} (${spec.blurb})`, true);
  }
}

export function cmdMode(ctx: AppCtx, args: string[]): void {
  const p = ctx.pal();
  const m = ctx.mods();
  if (!m) return;
  if (!args.length) {
    const modes = Object.entries(m.config.MODES).map(([name, spec]) => {
      const active = name === ctx.cfg.mode;
      return (
        <Box key={name}>
          <Text
            bold={active}
            color={active && spec.loud ? '#ffffff' : active ? p.accent : p.primary}
            backgroundColor={active && spec.loud ? p.red : undefined}
          >
            {`  ${active ? '◉' : '○'} ${name.padEnd(8)}`}
          </Text>
          <Text color={p.dim}>{spec.blurb + '\n'}</Text>
        </Box>
      );
    });
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  AGENT MODE\n\n'}
        </Text>
        {modes}
        {ctx.cfg.mode === 'andy' ? (
          <Box>
            <Text color={p.dim}>{'\n  following  '}</Text>
            <Text color={p.primary}>
              {(ctx.cfg.agentsPath ?? '(AGENTS.md not found)') + '\n'}
            </Text>
          </Box>
        ) : null}
        <Text color={p.dim}>{'\n  usage: /mode <name>\n'}</Text>
      </Box>,
    );
    return;
  }
  const name = (args[0] ?? '').toLowerCase();
  if (!(name in m.config.MODES)) {
    ctx.sysLine(
      `unknown mode: ${name} — try ${Object.keys(m.config.MODES).join(' | ')}`,
      true,
    );
    return;
  }
  setMode(ctx, name);
}

export function cmdClear(ctx: AppCtx): void {
  ctx.agent()?.clear();
  ctx.chat()?.clear();
  ctx.teleRail()?.clearFiles();
  ctx.loopRail()?.clearTrail?.();
  ctx.loopRail()?.setStage('idle');
  ctx.loopRail()?.setCounters(0, 0);
  ctx.syncRails();
  ctx.sysLine('transcript and history cleared', true);
}

export function cmdCost(ctx: AppCtx): void {
  const p = ctx.pal();
  const a = ctx.agent();
  const m = ctx.mods();
  if (!a || !m) return;
  const [pin, pout] = m.config.priceFor(ctx.cfg.model);
  const rows: [string, string][] = [
    ['model', ctx.cfg.model],
    ['turns', String(a.turnCount)],
    ['input tokens', fmtInt(a.sessionInputTokens)],
    ['output tokens', fmtInt(a.sessionOutputTokens)],
    ['rate (in/out)', `$${pin.toFixed(2)} / $${pout.toFixed(2)} per Mtok`],
    ['last turn', `$${a.lastTurnCost.toFixed(4)}`],
  ];
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  SESSION ACCOUNTING\n\n'}
      </Text>
      {rows.map(([label, value]) => (
        <Box key={label}>
          <Text color={p.dim}>{`  ${label.padEnd(18)}`}</Text>
          <Text color={p.primary}>{value + '\n'}</Text>
        </Box>
      ))}
      <Box>
        <Text color={p.dim}>{`  ${'session total'.padEnd(18)}`}</Text>
        <Text bold color={p.accent}>
          {`$${a.sessionCost.toFixed(4)}\n`}
        </Text>
      </Box>
    </Box>,
  );
}

export async function cmdLimits(ctx: AppCtx): Promise<void> {
  // Every limit here has bitten at least once, and the reason they are worth a
  // command is that they are otherwise invisible: a turn that ran out of
  // rounds looked exactly like one that finished. Naming the source of each
  // figure matters as much as the figure.
  const p = ctx.pal();
  const a = ctx.agent();
  if (!a) return;
  // contextWindow() is async — it may hit the active source's live catalog.
  // /limits is a one-shot user command, not a render-loop event handler, so
  // awaiting here is simply correct; nothing needs the fire-and-cache
  // pattern handleEvent() uses in app.tsx.
  const window = await a.contextWindow();
  const fromCatalog = window !== ctx.cfg.contextWindow;
  const used = a.lastInputTokens ?? 0;
  const rows: [string, string, string][] = [
    [
      'context window',
      fmtInt(window),
      fromCatalog
        ? "from this model's catalog entry"
        : `fallback (catalog has no figure for ${ctx.cfg.model})`,
    ],
    [
      'last prompt',
      used ? fmtInt(used) : 'not measured yet',
      used ? `${((used / window) * 100).toFixed(1)}% of the window` : '',
    ],
    [
      'auto-compact',
      ctx.cfg.autoCompact ? 'on' : 'off',
      ctx.cfg.autoCompact
        ? `compacts at ${Math.round(ctx.cfg.compactAt * 100)}% of the window`
        : '/compact still works by hand',
    ],
    [
      'output ceiling',
      fmtInt(ctx.cfg.maxTokens),
      'per reply; a reply cut off here is reported as truncated',
    ],
    [
      'rounds before pause',
      String(ctx.cfg.maxIterations),
      'continues automatically while the turn is progressing',
    ],
    [
      'hard round limit',
      String(ctx.cfg.maxRounds),
      'runaway guard; the turn stops and says so',
    ],
    [
      'request timeout',
      `${fmtG(ctx.cfg.requestTimeout)}s`,
      'bounds the gap between streamed chunks',
    ],
  ];
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  SESSION LIMITS\n\n'}
      </Text>
      {rows.map(([label, value, note]) => (
        <Box key={label}>
          <Text color={p.dim}>{`  ${label.padEnd(20)}`}</Text>
          <Text color={p.primary}>{value.padEnd(14)}</Text>
          {note ? <Text color={p.dim}>{note}</Text> : null}
          <Text>{'\n'}</Text>
        </Box>
      ))}
    </Box>,
  );
}

export function cmdScope(ctx: AppCtx): void {
  const p = ctx.pal();
  const a = ctx.agent();
  if (!a) return;
  const s = a.scope;
  const listing = (
    title: string,
    filePath: string | null,
    hosts: HostSetLike,
  ): ReactNode => (
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {`  ${title}\n`}
      </Text>
      <Box>
        <Text color={p.dim}>{`    ${'file'.padEnd(10)}`}</Text>
        <Text color={p.primary}>{(filePath ?? '(not found)') + '\n'}</Text>
      </Box>
      {filePath === null
        ? null
        : (
            [
              ['domains', [...hosts.domains].sort()],
              ['ips', [...hosts.ips].sort()],
              ['cidrs', [...hosts.cidrs].map(String).sort()],
            ] as [string, string[]][]
          ).flatMap(([label, values]) =>
            values.length
              ? [
                  <Box key={label}>
                    <Text color={p.dim}>{`    ${label.padEnd(10)}`}</Text>
                    <Text color={p.primary}>{values.join(', ') + '\n'}</Text>
                  </Box>,
                ]
              : [],
          )}
      {hosts.empty ? (
        <Box>
          <Text color={p.dim}>{`    ${'entries'.padEnd(10)}`}</Text>
          <Text color={p.amber}>{'(none)\n'}</Text>
        </Box>
      ) : null}
      <Text color={p.dim}>{'\n'}</Text>
    </Box>
  );
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  SCOPE GUARD\n\n'}
      </Text>
      {ctx.cfg.legacyScopePath !== null ? (
        <Box>
          <Text bold color={p.amber}>
            {'  ⚠ '}
          </Text>
          <Text color={p.amber}>{`${ctx.cfg.legacyScopePath} is ignored\n`}</Text>
          <Text color={p.dim}>
            {'    the guard was split into allow.yaml / out-of-scope.yaml\n\n'}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={p.dim}>{`  ${'status'.padEnd(12)}`}</Text>
        {s.armed ? (
          <Text>
            <Text bold color="#ffffff" backgroundColor={p.red}>
              ARMED
            </Text>
            <Text color={p.primary}>{' — tools run unattended\n\n'}</Text>
          </Text>
        ) : (
          <Text>
            <Text color={p.amber}>not armed</Text>
            <Text color={p.dim}>{' — normal mode gating applies\n\n'}</Text>
          </Text>
        )}
      </Box>
      {listing('ALLOW  (declared targets — a declaration, not a fence)', s.allowPath, s.allow)}
      {listing('DENY   (never touched — enforced, beats allow)', s.denyPath, s.deny)}
      <Text color={p.dim}>
        {
          '  Allow-list hosts are not restricted to: anything not in\n  out-of-scope.yaml is reachable. The deny-list is a static text\n  scan of the command, so obfuscated or runtime-built targets\n  (python3 -c, $(), encoded hosts) are not detected.\n'
        }
      </Text>
    </Box>,
  );
}

export function cmdRain(ctx: AppCtx): void {
  // Paused during active turns by runTurn itself, so only the preference is
  // toggled here (the app's rainOnRef is the operative flag, as in Python).
  const next = !ctx.rainOnRef.current;
  ctx.setRainBoth(next);
  ctx.sysLine(`matrix rain ${next ? 'ON' : 'OFF'}`, true);
}

export function cmdThink(ctx: AppCtx): void {
  // Says which endpoint is in play, because "OFF" and "the endpoint sends no
  // reasoning" look identical on screen — and the second is not something the
  // toggle can fix.
  ctx.cfg.showThinking = !ctx.cfg.showThinking;
  if (!ctx.cfg.showThinking) ctx.chat()?.clearReasoning();
  ctx.sysLine(`model thinking ${ctx.cfg.showThinking ? 'ON' : 'OFF'}`, true);
  if (ctx.cfg.showThinking) {
    ctx.sysLine(
      "shown only when the endpoint forwards it — an Anthropic-native one does; a LiteLLM proxy's /v1/messages bridge drops it",
    );
  }
}

export function cmdTheme(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  if (!args.length) {
    ctx.sysLine(`usage: /theme ${m.theme.THEME_NAMES.join(' | ')}`, true);
    return;
  }
  const name = (args[0] ?? '').toLowerCase();
  if (!m.theme.THEME_NAMES.includes(name)) {
    ctx.sysLine(`unknown theme: ${name}`, true);
    return;
  }
  const p = m.theme.getPalette(name, ctx.termBg ?? null, {
    colors: ctx.termColors ?? undefined,
  });
  // Persist BEFORE applying, so the choice survives even if the repaint
  // throws — a theme that took effect but was not remembered is the worse of
  // the two failures.
  m.theme.setCurrentTheme(name);
  ctx.setPaletteBoth(p, name);
  if (name === m.theme.SYSTEM_THEME && !ctx.termColors) {
    // Say so rather than showing green under a "theme:system" badge: a
    // terminal that does not answer OSC 4 is a real thing.
    ctx.sysLine(
      'theme switched to system — but this terminal did not report its colours, so the green palette is showing',
      true,
    );
    return;
  }
  ctx.sysLine(`theme switched to ${name}`, true);
}

export function cmdSave(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  try {
    const p = m.session.save(ctx.cfg, a, args[0] ?? null);
    ctx.sysLine(`saved session → ${p}`, true);
  } catch (e) {
    ctx.sysLine(`save failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

export function cmdLoad(ctx: AppCtx, args: string[]): void {
  const p = ctx.pal();
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  void (async () => {
    if (!args.length) {
      const listing = m.session.listSessions(ctx.cfg);
      const rows = listing.slice(0, 20).map((s) => {
        const ts = new Date(s.savedAt * 1000);
        const stamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(
          ts.getDate(),
        ).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(
          ts.getMinutes(),
        ).padStart(2, '0')}`;
        return (
          <Box key={s.file}>
            <Text color={p.primary}>{`  ${s.file.padEnd(34)}`}</Text>
            <Text color={p.dim}>{`${stamp}  ${s.model}  ${s.messages} msgs\n`}</Text>
          </Box>
        );
      });
      ctx.say(
        <Box flexDirection="column">
          <Text bold color={p.accent}>
            {'  SAVED SESSIONS\n\n'}
          </Text>
          {listing.length ? rows : <Text color={p.dim}>{'  (none)\n'}</Text>}
          <Text color={p.dim}>{'\n  usage: /load <name>\n'}</Text>
        </Box>,
      );
      return;
    }
    const [ok, msg] = await m.session.load(ctx.cfg, a, args[0] ?? '');
    if (ok) {
      ctx.updateHeader({ model: ctx.cfg.model });
      ctx.updateBar({ model: ctx.cfg.model });
      ctx.sysLine(msg, true);
    } else {
      ctx.sysLine(msg, true);
    }
  })();
}

export async function cmdCompact(ctx: AppCtx): Promise<void> {
  const a = ctx.agent();
  const m = ctx.mods();
  if (!a || !m) return;
  ctx.setBusyBoth(true);
  ctx.updateBar({ activity: 'compacting history' });
  ctx.sysLine('compacting conversation…');
  try {
    const [ok, result] = await a.compact();
    const p = ctx.pal();
    if (ok) {
      ctx.say(
        <Box flexDirection="column">
          <Text bold color={p.accent}>
            {'  ✔ history compacted\n\n'}
          </Text>
          <Text color={p.primary}>{result}</Text>
        </Box>,
      );
    } else {
      ctx.sysLine(`compact failed: ${result}`, true);
    }
  } finally {
    ctx.setBusyBoth(false);
    ctx.updateBar({ activity: 'idle' });
    ctx.syncRails();
  }
}

export function cmdPanes(ctx: AppCtx): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  // The prefix keys are tmux bindings, not Andy bindings, so they only exist
  // in a session tmux started. Nothing inside the running app can fix that:
  // tmux needs the terminal, and the app is holding it. So this saves the
  // conversation, asks to exit, and lets cli.ts relaunch once the terminal is
  // free — hence the onExit seam carrying the Relaunch value.
  if (m.panes.currentSession() !== null) {
    ctx.sysLine(
      'already in an Andy pane — ctrl+b h splits right, ctrl+b v splits down',
      true,
    );
    return;
  }
  if (!m.panes.tmuxAvailable()) {
    ctx.sysLine('tmux is not installed — `sudo apt install tmux` first', true);
    return;
  }
  // Keep the conversation across the relaunch. A save failure is not fatal —
  // panes still work — so it is reported and the relaunch continues.
  let resume: string | null = null;
  try {
    resume = m.session.save(ctx.cfg, a, 'panes');
    ctx.sysLine('saving the conversation…', true);
  } catch (e) {
    ctx.sysLine(
      `could not save the conversation (${e instanceof Error ? e.message : String(e)}) — relaunching without it`,
      true,
    );
  }
  ctx.sysLine(
    'relaunching under tmux — ctrl+b h splits right, ctrl+b v splits down',
    true,
  );
  try {
    ctx.actionQuitWith(new m.panes.Relaunch({ resume }));
  } catch {
    ctx.actionQuit();
  }
}

export function cmdAndyOpencode(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  void (async () => {
    // /andy-opencode [--model <id>] [--refresh] [-- <opencode args>]
    //
    // Opens opencode behind a rotating IP, with no account and no key: its
    // free models are reachable anonymously, and the only obstacle is that
    // the free tier refuses Tor exits — hence an ordinary HTTP proxy pool
    // rather than Tor.
    let model: string | null = null;
    let refresh = false;
    const passthrough: string[] = [];
    let i = 0;
    while (i < args.length) {
      const a = args[i] ?? '';
      if (a === '--model' && i + 1 < args.length) {
        model = args[i + 1] ?? null;
        i += 2;
        continue;
      }
      if (a === '--refresh') {
        refresh = true;
        i += 1;
        continue;
      }
      // Everything after `--` goes to opencode untouched, so its own flags
      // stay reachable without this parser having to know them.
      if (a === '--') {
        passthrough.push(...args.slice(i + 1));
        break;
      }
      passthrough.push(a);
      i += 1;
    }

    if (m.opencode.findBinary() === null) {
      // The exact wording asked for, plus the install lines that actually
      // work — a bare "install it" leaves the operator hunting.
      ctx.sysLine('opencode not found - install it please !', true);
      ctx.sysLine('  curl -fsSL https://opencode.ai/install | bash', true);
      ctx.sysLine('  or: mise use -g opencode   ·   brew install opencode', true);
      return;
    }
    if (refresh) ctx.sysLine('refreshing the proxy pool…');

    // Rotate, prove the route, then hand the terminal to opencode. Both the
    // pool build and the pre-flight turn block on sockets for tens of seconds
    // — hence no busy flag held across it and spinner animation on a timer.
    const binary = m.opencode.findBinary();
    if (binary === null) return;
    // Deliberately no counts and no addresses on screen: how many proxies
    // there are says nothing useful, and an address that has not been proven
    // yet is noise at best. Only the phases are shown; the proxy is named once
    // it works.
    ctx.sysLine('ANDY IS MAKING IT UNLIMITED - FINDING THE BEST PROXIES ...', true);
    ctx.setHuntSpinner(true);
    let proxy = null as ReturnType<typeof m.opencode.findWorkingProxy>[0];
    let note = '';
    try {
      const pool = m.opencode.getPool({
        refresh,
        binary,
        model: model ?? m.opencode.DEFAULT_MODEL,
      });
      if (pool.proxies.length) {
        [proxy, note] = await m.opencode.findWorkingProxy(binary, {
          model: model ?? m.opencode.DEFAULT_MODEL,
          attempts: 8,
          pool,
        });
      } else {
        note = 'no proxies in the pool';
      }
    } finally {
      ctx.setHuntSpinner(false);
    }
    if (proxy === null) {
      // Say why rather than opening a TUI that will fail on its first message:
      // `note` distinguishes "no proxies" from "the model id is retired".
      ctx.sysLine(
        `could not find a working route (${note}) — try /andy-opencode again, or --model <id>`,
        true,
      );
      return;
    }
    // The exit IP is a courtesy, not a promise: these proxies are flaky
    // per-request, so the launch can succeed and the follow-up lookup still
    // fail. When it does, say only what is known — "(exit None)" reads like a
    // failure at the exact moment the route just proved itself.
    const ip = m.opencode.probeExitIp(proxy);
    const where = ip ? `${proxy.url} (exit ${ip})` : proxy.url;
    ctx.sysLine(`opening opencode through ${where} — quit it to come back`, true);
    // The alias is (re)written here rather than at install time so a moved
    // checkout re-points itself.
    const [ok, detail] = m.opencode.installAlias();
    if (ok) {
      ctx.sysLine(`${m.opencode.ALIAS} → ${detail}`, true);
    } else {
      ctx.sysLine(`could not install ${m.opencode.ALIAS}: ${detail}`, true);
    }
    // Suspend the TUI, run opencode in the freed terminal, then resume: the
    // child wants the terminal and Andy is holding it.
    let rc = -1; // assigned inside suspendTerminal; -1 = could not run
    try {
      await ctx.suspendTerminal(async () => {
        rc = await m.opencode.run(proxy, binary, {
          args: passthrough,
          model,
          cwd: ctx.cfg.workdir,
        });
      });
    } catch (e) {
      ctx.sysLine(
        `opencode could not start: ${e instanceof Error ? e.constructor.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
      return;
    }
    if (rc !== 0) {
      ctx.sysLine(`opencode exited with status ${rc}`, true);
    } else {
      ctx.sysLine('back in andy', true);
    }
  })();
}
