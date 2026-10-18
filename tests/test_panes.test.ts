/**
 * tests/test_panes.test.ts — pane messaging: mailbox semantics, tool gating,
 * and the generated tmux config (port of tests/test_panes.py).
 *
 * What this pins: the mailbox contract (register/send/drain, unknown
 * recipient and empty body refused, names sanitised), the peer-tool gating on
 * the Agent (main-in-a-pane sees agent_peers/agent_send/agent_inbox, an
 * ordinary session does not and is told why), the /panes command's four
 * outcomes through the exported cmdPanes seam (AppCtx), transcriptOf's
 * flattening of wire history, and the tmux config text both standalone and
 * nested — the nested case is load-bearing: an outer tmux eats the prefix, so
 * the binding needs it pressed twice and the hint must say so.
 *
 * Port notes:
 *  - Python drove /panes on the app object with `_cmd_panes` and patched
 *    `panes.tmux_available` / `session.save`; the TS port exposes the same
 *    logic as `cmdPanes(ctx)` in ui/screens/commands.tsx, so the fake ctx
 *    here IS that drive. screens/commands.tsx is a JSX module (tsconfig sets
 *    no --jsx) so it is imported with a non-literal specifier.
 *  - Python's `_pane_inner_argv` pins are skipped: `paneInnerArgv` is
 *    module-private in the TS cli.ts (leading-underscore helpers are ported
 *    unexported by the PORT-MAP convention), so there is no seam to call.
 *  - `panes._safe_name` is likewise unexported; the sanitisation pin drives
 *    the behaviour through register/knownAgents instead of the helper.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import * as panes from '../src/panes.js';
import * as tools from '../src/tools.js';
import * as session from '../src/session.js';
import { Agent } from '../src/agent.js';
import { Config } from '../src/config.js';
import type { ChatMessage, ContentBlock } from '../src/shared.js';

// AppCtx/Mods live in src/ui/app.tsx — a JSX module, and tsconfig sets no
// --jsx, so even a type-only import of it is a tsc error in this file. The
// /panes drive only needs the slice of the ctx cmdPanes actually reads, so
// the seam is declared here structurally instead (same dodge class as the
// non-literal commands.js import below).
interface AppCtxLike {
  cfg: Config;
  mods(): { panes: typeof panes; session: typeof session } & Record<string, unknown>;
  agent(): unknown;
  sysLine(message: string): void;
  actionQuit(): void;
  actionQuitWith(result: unknown): void;
}

const SPEC_COMMANDS: string = '../src/ui/screens/commands.js';
type Commands = { cmdPanes: (ctx: AppCtxLike) => void };

const TMP = mkdtempSync(path.join(os.tmpdir(), 'andy-panes-'));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** True if `key` is bound at top level in the prefix table to `command`.
 *
 *  A plain substring test is not enough: tmux's stock prefix table carries
 *  one enormous display-menu binding whose *arguments* contain
 *  `h { split-window -h }`, so searching for "h" and "split-window -h"
 *  matches a server that has no `h` binding at all — which is precisely the
 *  state being tested for. Anchoring on `bind-key -T prefix <key>` only
 *  matches a real binding. */
function hasBind(keys: string, key: string, command: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = new RegExp(`^\\s*bind-key\\s+-T prefix\\s+${esc(key)}\\s+${esc(command)}`);
  return keys.split('\n').some((line) => pat.test(line));
}

// --- env hygiene: the pane environment is process-global state ----------------
let savedSession: string | undefined;
let savedTmuxPane: string | undefined;
let savedTmux: string | undefined;

beforeEach(() => {
  savedSession = process.env[panes.ENV_SESSION];
  savedTmuxPane = process.env['TMUX_PANE'];
  savedTmux = process.env['TMUX'];
});
afterEach(() => {
  for (const [k, v] of [
    [panes.ENV_SESSION, savedSession],
    ['TMUX_PANE', savedTmuxPane],
    ['TMUX', savedTmux],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- mailbox ---------------------------------------------------------------

describe('mailbox', () => {
  const root = panes.mailboxRoot(TMP, 'andy');

  it('register creates inboxes', () => {
    panes.register(root, '1');
    panes.register(root, '2');
    expect(new Set(panes.knownAgents(root))).toEqual(new Set(['1', '2']));
  });

  it('drain returns both messages in order, then clears the inbox', async () => {
    await panes.send(root, '1', '2', 'hello from 1');
    await panes.send(root, '1', '2', 'second');
    const got = await panes.drain(root, '2');
    expect(got.map((m) => m.body)).toEqual(['hello from 1', 'second']);
    expect(await panes.drain(root, '2')).toEqual([]);
    expect(got.length > 0 && got[0]!.from === '1').toBe(true);
  });

  it('unknown recipient rejected', async () => {
    await expect(panes.send(root, '1', '9', 'x')).rejects.toThrow(/no agent named/);
  });

  it('empty body rejected', async () => {
    await expect(panes.send(root, '1', '2', '   ')).rejects.toThrow(/empty/i);
  });

  it('name sanitised: path traversal in names is stripped to a safe slug', () => {
    // Python called panes._safe_name directly; that helper is module-private
    // in the TS port, so the same property is pinned through the behaviour it
    // exists for — a traversal-y agent name lands as a safe inbox file.
    panes.register(root, '../../etc');
    expect(panes.knownAgents(root)).toContain('etc');
    expect(panes.knownAgents(root)).not.toContain('../../etc');
  });
});

// --- tool gating -------------------------------------------------------------

describe('tool gating', () => {
  const cfg = Config.fromEnv({
    workdir: TMP,
    stateDir: path.join(TMP, 'state'),
  } as Partial<Config>);
  const PEERS = ['agent_peers', 'agent_send', 'agent_inbox'];

  it('pane main agent sees peer tools', () => {
    const aMain = new Agent(cfg, null, null, false, true, true); // canPeer
    const names = new Set(aMain.toolSchemas().map((t) => t.name));
    for (const t of PEERS) expect(names.has(t)).toBe(true);
  });

  it('ordinary session has no peer tools', () => {
    const aPlain = new Agent(cfg);
    const names = new Set(aPlain.toolSchemas().map((t) => t.name));
    for (const t of PEERS) expect(names.has(t)).toBe(false);
  });

  it('denied outside a pane, with the reason the model can act on', () => {
    const aPlain = new Agent(cfg);
    const reason = (
      aPlain as unknown as { denied(name: string): string | null }
    ).denied('agent_send');
    expect(reason !== null && reason.includes('only available')).toBe(true);
  });

  it('peer tool outside pane reports a clear error, not a crash', async () => {
    delete process.env[panes.ENV_SESSION];
    const r = await tools.execute('agent_peers', {}, cfg);
    expect(r.isError).toBe(true);
    expect(r.output.includes('tmux pane')).toBe(true);
  });
});

// --- inside a simulated pane --------------------------------------------------

describe('inside a simulated pane', () => {
  it('agent_send succeeds and agent_peers lists peers', async () => {
    process.env[panes.ENV_SESSION] = 'andy';
    process.env['TMUX_PANE'] = '%7';
    const cfg2 = Config.fromEnv({
      workdir: TMP,
      stateDir: path.join(TMP, 'state'),
    } as Partial<Config>);
    panes.register(panes.mailboxRoot(cfg2.stateDir, 'andy'), '2');

    const sent = await tools.execute('agent_send', { to: '2', body: 'ping' }, cfg2);
    // ToolResult.isError is optional in the TS port (absent = success, the
    // Python dataclass's is_error=False default).
    expect(sent.isError ?? false).toBe(false);

    const peers = await tools.execute('agent_peers', {}, cfg2);
    expect(peers.output.includes('2') && peers.output.includes('7')).toBe(true);
  });

  it('the receiving pane gets it, formatted with the sender', async () => {
    process.env[panes.ENV_SESSION] = 'andy';
    process.env['TMUX_PANE'] = '%2';
    const cfg3 = Config.fromEnv({
      workdir: TMP,
      stateDir: path.join(TMP, 'state'),
    } as Partial<Config>);
    const msgs = await panes.drain(panes.mailboxRoot(cfg3.stateDir, 'andy'), '2');
    const text = panes.formatMessages(msgs);
    expect(text.includes('ping') && text.includes('from 7')).toBe(true);
  });
});

// --- /panes: the relaunch request ---------------------------------------------

describe('Relaunch and transcriptOf', () => {
  it('Relaunch carries the resume path; defaults to none', () => {
    expect(new panes.Relaunch({ resume: '/x/y.json' }).resume).toBe('/x/y.json');
    expect(new panes.Relaunch().resume).toBeNull();
  });

  it('transcript_of keeps prose in order and drops tool traffic', () => {
    // transcriptOf is what makes "your session continues there" true: it
    // flattens the wire-format history into the (role, text) pairs the boot
    // replay draws. Tool traffic is dropped — the panels are live progress,
    // and a wall of them for finished work would bury the conversation.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'what port' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '4001' },
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        ] as ContentBlock[],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'secret output' },
        ] as ContentBlock[],
      },
      { role: 'assistant', content: 'done' },
    ];
    const pairs = panes.transcriptOf(msgs);
    expect(pairs).toEqual([
      ['user', 'what port'],
      ['assistant', '4001'],
      ['assistant', 'done'],
    ]);
    expect(pairs.some(([, t]) => t.includes('secret output'))).toBe(false);
  });

  it('transcript_of edge cases: empty, blank, junk', () => {
    expect(panes.transcriptOf([])).toEqual([]);
    expect(panes.transcriptOf([{ role: 'user', content: '   ' }])).toEqual([]);
    expect(
      panes.transcriptOf([
        { role: 'assistant', content: [null, 7, {}] as unknown as ContentBlock[] },
      ]),
    ).toEqual([]);
  });
});

// --- /panes: the command itself, through the exported cmdPanes seam ------------

describe('the /panes command', () => {
  // Python drove app._cmd_panes with the app unmounted, stubbing query_one
  // and exit; the TS equivalent drives the exported cmdPanes with a fake
  // AppCtx, capturing sysLine and the exit seam (actionQuitWith).
  const acfg = Config.fromEnv({
    workdir: path.join(TMP, 'appwd'),
    stateDir: path.join(TMP, 'appstate'),
  } as Partial<Config>);
  const minimalAgent = {
    messages: [],
    turnCount: 0,
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    sessionCost: 0,
    scope: { armed: false, loaded: false },
  };
  let said: string[] = [];
  let exited: { result?: unknown } = {};
  let quitPlain = false;

  function makeCtx(modsOverride: Record<string, unknown>): AppCtxLike {
    said = [];
    exited = {};
    quitPlain = false;
    return {
      cfg: acfg,
      mods: () => ({ panes, session, ...modsOverride }),
      agent: () => minimalAgent,
      sysLine: (message: string) => {
        said.push(message);
      },
      actionQuit: () => {
        quitPlain = true;
      },
      actionQuitWith: (result: unknown) => {
        exited.result = result;
      },
    };
  }

  it('inside a pane already: nothing to do, and it must not exit', async () => {
    const { cmdPanes } = (await import(SPEC_COMMANDS)) as Commands;
    process.env[panes.ENV_SESSION] = 'andy';
    cmdPanes(makeCtx({}));
    expect('result' in exited).toBe(false);
    expect(said.some((s) => s.includes('ctrl+b h'))).toBe(true);
  });

  it('outside a pane with tmux present: save, then ask to relaunch', async () => {
    const { cmdPanes } = (await import(SPEC_COMMANDS)) as Commands;
    delete process.env[panes.ENV_SESSION];
    // Python relied on real tmux presence here; forcing the availability
    // check pins the command's logic rather than the machine it runs on (the
    // genuinely-unavailable case is the next test).
    cmdPanes(makeCtx({ panes: { ...panes, tmuxAvailable: () => true } }));
    const r = exited.result;
    expect(r instanceof panes.Relaunch).toBe(true);
    const resume = r instanceof panes.Relaunch ? r.resume : null;
    expect(resume !== null && typeof resume === 'string').toBe(true);
    // /panes saves the conversation to resume from — a real file on disk.
    expect(resume !== null && typeof resume === 'string' && existsSync(resume)).toBe(true);
    expect(said.some((s) => s.includes('relaunching under tmux'))).toBe(true);
  });

  it('no tmux: refuse, and do not exit — exiting would leave no session at all', async () => {
    const { cmdPanes } = (await import(SPEC_COMMANDS)) as Commands;
    delete process.env[panes.ENV_SESSION];
    cmdPanes(makeCtx({ panes: { ...panes, tmuxAvailable: () => false } }));
    expect('result' in exited).toBe(false);
    expect(said.some((s) => s.includes('tmux is not installed'))).toBe(true);
  });

  it('a failed save must not cost the operator the relaunch', async () => {
    const { cmdPanes } = (await import(SPEC_COMMANDS)) as Commands;
    delete process.env[panes.ENV_SESSION];
    // Panes still work without history, so the command carries on with
    // resume=None and says what happened to the save.
    const failingSession = {
      ...session,
      save: () => {
        throw new Error('read-only');
      },
    };
    cmdPanes(
      makeCtx({
        panes: { ...panes, tmuxAvailable: () => true },
        session: failingSession,
      }),
    );
    const r = exited.result;
    expect(r instanceof panes.Relaunch).toBe(true);
    expect(r instanceof panes.Relaunch && r.resume === null).toBe(true);
    expect(said.some((s) => s.includes('could not save'))).toBe(true);
  });
});

// --- the pane command's argv (launcher-side) -----------------------------------

describe('pane inner argv', () => {
  it.skip("argv: --panes/--resume stripped, other flags survive — SKIP (port gap): Python called `__main__._pane_inner_argv` (private-but-reachable). The TS port's `paneInnerArgv` in src/cli.ts is module-private per the PORT-MAP unexported-helper convention, so there is no exported seam to call; the behaviour is only observable by running the real `--panes` relaunch, which needs a terminal and tmux.", () => {
    // The five Python checks this stands in for:
    //   paneInnerArgv(["--panes"]) == []
    //   paneInnerArgv(["--panes", "--theme", "amber"]) == ["--theme", "amber"]
    //   paneInnerArgv(["--panes", "--resume", "/s.json"]) == []
    //   paneInnerArgv(["--panes", "--resume=/s.json", "-m", "x"]) == ["-m", "x"]
    //   paneInnerArgv(["--panes", "-m", "x"]) == ["-m", "x"]
  });
});

// --- tmux config ---------------------------------------------------------------

describe('tmux config', () => {
  it('standalone: prefix, splits, and a hint that needs the prefix once', () => {
    const conf = panes.tmuxConf("/usr/bin/andy --workdir '/tmp/x y'");
    expect(conf.includes('set -g prefix C-b')).toBe(true);
    expect(conf.includes('bind h split-window -h')).toBe(true);
    expect(conf.includes('bind v split-window -v')).toBe(true);
    expect(conf.includes('ctrl+b ctrl+b')).toBe(false);
  });

  it('nested: the hint says the prefix twice, and send-prefix forwards it', () => {
    // Nested inside another tmux the outer server eats the prefix, so the
    // binding needs it pressed twice — and the hint has to say so, or the
    // feature looks broken. `send-prefix` is what makes the second arrive.
    const nconf = panes.tmuxConf('/usr/bin/andy', true);
    expect(nconf.includes('ctrl+b ctrl+b h')).toBe(true);
    expect(nconf.includes('bind C-b send-prefix')).toBe(true);
    expect(nconf.includes('bind h split-window -h')).toBe(true);
    expect(nconf.includes('bind v split-window -v')).toBe(true);
  });

  it('nested_in_tmux reads the TMUX variable', () => {
    process.env['TMUX'] = '/tmp/tmux-1000/outer,123,0';
    expect(panes.nestedInTmux()).toBe(true);
    delete process.env['TMUX'];
    expect(panes.nestedInTmux()).toBe(false);
  });

  it('write_tmux_conf honours an explicit nested flag', () => {
    const wconf = panes.writeTmuxConf(path.join(TMP, 'nested-state'), '/usr/bin/andy', true);
    expect(readFileSync(wconf, 'utf8').includes('ctrl+b ctrl+b h')).toBe(true);
    const wconf2 = panes.writeTmuxConf(path.join(TMP, 'plain-state'), '/usr/bin/andy', false);
    expect(readFileSync(wconf2, 'utf8').includes('ctrl+b ctrl+b')).toBe(false);
  });
});

// --- a real tmux, when there is one --------------------------------------------

const tmuxOnPath = panes.tmuxAvailable();

describe.skipIf(!tmuxOnPath)('tmux live (tmux present)', () => {
  it('tmux accepts the generated config, binds the keys, exports the session env', () => {
    const conf = panes.tmuxConf('/usr/bin/andy');
    const confPath = path.join(TMP, 'tmux.conf');
    writeFileSync(confPath, conf);
    const sock = `andy-test-${process.pid}`;
    const env = { ...process.env };
    delete env['TMUX'];
    const base = ['tmux', '-L', sock, '-f', confPath];

    const created = spawnSync(base[0]!, [...base.slice(1), 'new-session', '-d', '-s', 't', '-x', '200', '-y', '50', 'sleep', '60'], { env });
    expect(created.status).toBe(0);
    try {
      const ok = spawnSync('tmux', ['-L', sock, 'source-file', confPath], { env });
      expect(ok.status, ok.stderr?.toString()).toBe(0);
      const keys = spawnSync('tmux', ['-L', sock, 'list-keys', '-T', 'prefix'], { env })
        .stdout?.toString() ?? '';
      expect(hasBind(keys, 'h', 'split-window -h'), keys).toBe(true);
      expect(hasBind(keys, 'v', 'split-window -v'), keys).toBe(true);
      const ss = spawnSync('tmux', ['-L', sock, 'show-environment', '-g', panes.ENV_SESSION], { env })
        .stdout?.toString() ?? '';
      // Global session env set — every pane tmux creates inherits it.
      expect(ss.includes(`${panes.ENV_SESSION}=${panes.TMUX_SESSION}`)).toBe(true);
    } finally {
      spawnSync('tmux', ['-L', sock, 'kill-server'], { env });
    }
  });

  it('a pre-existing server still gets the bindings (applyConfig)', () => {
    // `tmux -f` is read only when a server starts. If one is already up on
    // our socket, `new-session -A` attaches and the config is never read —
    // leaving tmux's stock prefix table, in which ctrl+b h does nothing at
    // all. This is the exact bug that made the prefix keys "not work".
    const conf = panes.tmuxConf('/usr/bin/andy');
    const confPath = path.join(TMP, 'tmux2.conf');
    writeFileSync(confPath, conf);
    const sock2 = `andy-test-stale-${process.pid}`;
    const env2 = { ...process.env };
    delete env2['TMUX'];
    const stale = ['tmux', '-L', sock2, '-f', '/dev/null'];

    const created = spawnSync(stale[0]!, [...stale.slice(1), 'new-session', '-d', '-s', 't', '-x', '200', '-y', '50', 'sleep', '60'], { env: env2 });
    expect(created.status).toBe(0);
    try {
      const before = spawnSync('tmux', ['-L', sock2, 'list-keys', '-T', 'prefix'], { env: env2 })
        .stdout?.toString() ?? '';
      expect(hasBind(before, 'h', 'split-window -h'), 'stock server lacks the bindings').toBe(false);
      // applyConfig is what launch() calls before attaching.
      panes.applyConfig(confPath, sock2);
      const after = spawnSync('tmux', ['-L', sock2, 'list-keys', '-T', 'prefix'], { env: env2 })
        .stdout?.toString() ?? '';
      expect(hasBind(after, 'h', 'split-window -h')).toBe(true);
      expect(hasBind(after, 'v', 'split-window -v')).toBe(true);
    } finally {
      spawnSync('tmux', ['-L', sock2, 'kill-server'], { env: env2 });
    }
  });
});
