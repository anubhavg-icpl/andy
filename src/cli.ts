#!/usr/bin/env node
/**
 * cli.ts — command-line entrypoint: `andy` / `node dist/cli.js`.
 * (port of andy/__main__.py; VERSION folds in andy/__init__.py)
 *
 * What this module is: argv parsing (hand-rolled — no new deps), launch
 * preflight (scope files, doctrine file, theme, credentials, self-update),
 * and the hand-off into the Ink TUI.
 *
 * Invariants:
 *  - Raw argv is captured BEFORE parsing so a re-exec (post-update) or a
 *    tmux pane relaunch can reproduce the original invocation exactly.
 *  - Env gating mirrors the Python exactly: ANDY_NO_UPDATE skips the update
 *    check, ANDY_UPDATED breaks the re-exec loop, ANDY_ROOT names the
 *    launcher's checkout, ANDY_PANE_SESSION marks an inner tmux pane.
 *  - argparse → a minimal parser with the same surface: `--flag value`,
 *    `--flag=value`, `-m value`, `-mvalue`; unknown flags / bad choices /
 *    stray positionals are an error on stderr + exit 2. (Long-option
 *    abbreviation, argparse's one extra, is deliberately not ported.)
 *  - ui/app is imported lazily inside main() (as Python did) because it is
 *    the integration lane's long pole; the exit-side Relaunch seam is the
 *    documented `relaunchRequest()` hook below.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type FC } from 'react';
import { MODES, KNOWN_MODELS, Config, DEFAULT_MODEL, findAgentsFile } from './config.js';
import * as logfareMod from './logfare.js';
import { andyHome, expandTilde, type SessionPayload } from './shared.js';
import * as sessionMod from './session.js';
import * as sourcesMod from './sources.js';
import { THEME_NAMES, currentTheme } from './theme.js';
import * as updateMod from './update.js';

/** andy/__init__.py's `__version__`, folded here per PORT-MAP row 42. */
export const VERSION = '1.0.2';

const CLI_PATH = fileURLToPath(import.meta.url);

const MODE_CHOICES = Object.keys(MODES);

/**
 * The slice of ui/app's surface cli.ts touches (AndyApp's props per PORT-MAP
 * row 31, plus the term-colour props ui/app.py's constructor took — the app
 * builds its palette from them). Declared locally so the @ts-ignore'd import
 * cannot leak `any` into this file.
 */
interface AndyAppModule {
  AndyApp: FC<{
    cfg: Config;
    termBg?: string | null;
    termColors?: unknown;
    resume?: SessionPayload;
  }>;
  /** Optional exit-side hook standing in for Python's app.run() return value. */
  relaunchRequest?: () => { resume?: string } | null;
}

// === SECTION === hand-rolled argv parser (argparse surface, no deps) ===

interface Args {
  model?: string;
  workdir?: string;
  allow?: string;
  deny?: string;
  scope?: string;
  unsafe: boolean;
  theme?: string;
  rain: boolean;
  noRain: boolean;
  noThink: boolean;
  mode?: string;
  agents?: string;
  maxTokens?: number;
  noAutoCompact: boolean;
  noUpdate: boolean;
  listModels: boolean;
  panes: boolean;
  resume?: string;
  help: boolean;
  version: boolean;
}

/** Flags that take a value. */
const VALUE_FLAGS = new Set([
  '--model',
  '--workdir',
  '--allow',
  '--deny',
  '--scope',
  '--theme',
  '--mode',
  '--agents',
  '--max-tokens',
  '--resume',
]);

/** Short flags that take a value. */
const VALUE_SHORTS = new Set(['-m', '-C']);

const BOOL_FLAGS = new Set([
  '--unsafe',
  '--rain',
  '--no-rain',
  '--no-think',
  '--no-auto-compact',
  '--no-update',
  '--list-models',
  '--panes',
  '--version',
  '--help',
  '-h',
]);

function usageError(message: string): never {
  process.stderr.write(`andy: error: ${message}\n`);
  process.exit(2);
}

function helpText(): string {
  return [
    'usage: andy [-h] [--model MODEL] [--workdir DIR] [--allow PATH] [--deny PATH]',
    '            [--scope PATH] [--unsafe] [--theme {' + THEME_NAMES.join(',') + '}]',
    '            [--rain] [--no-rain] [--no-think] [--mode MODE] [--agents PATH]',
    '            [--max-tokens N] [--no-auto-compact] [--no-update] [--list-models]',
    '            [--panes] [--resume SESSION] [--version]',
    '',
    'Andy — an agentic coding CLI with an ink-and-ember terminal TUI.',
    '',
    'options:',
    '  -m, --model MODEL         model name (default: ' + DEFAULT_MODEL + ')',
    '  -C, --workdir DIR         working directory (default: cwd)',
    '  --allow PATH              path to allow.yaml — declared targets; its presence runs tools unattended',
    '  --deny PATH               path to out-of-scope.yaml — hosts that are never touched',
    '  --scope PATH              DEPRECATED — replaced by --allow / --deny; ignored with a warning',
    '  --unsafe                  disable the filesystem sandbox (paths may escape the workdir)',
    '  --theme THEME             colour theme (system = match the terminal\'s own colours)',
    '  --rain                    start with matrix rain on in the shell (off by default for readability)',
    '  --no-rain                 disable matrix rain entirely, including the boot screen',
    '  --no-think                do not show the model\'s own reasoning when the endpoint forwards it',
    '                            (on by default; /think toggles)',
    '  --mode MODE               agent mode: ' + MODE_CHOICES.join(' | ') + ' (default: auto)',
    '  --agents PATH             path to AGENTS.md used by andy mode (default: workdir, its',
    '                            parent, ~/.andy, then ~)',
    '  --max-tokens N            max output tokens per reply',
    '  --no-auto-compact         never compact history automatically; /compact still works',
    '  --no-update               skip the launch-time check for new commits on the upstream',
    '  --list-models             list known models and exit',
    '  --panes                   start in a tmux session where ctrl+b h / ctrl+b v open another',
    '                            Andy pane, and the panes\' agents can message each other',
    '  --resume SESSION          restore a saved session at launch (used by /panes)',
    '  --version                 show program\'s version number and exit',
    '  -h, --help                show this help message and exit',
  ].join('\n');
}

function parseArgv(argv: string[]): Args {
  const args: Args = {
    unsafe: false,
    rain: false,
    noRain: false,
    noThink: false,
    noAutoCompact: false,
    noUpdate: false,
    listModels: false,
    panes: false,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  let i = 0;
  const takeValue = (flag: string): string => {
    i += 1;
    if (i >= argv.length) usageError(`argument ${flag}: expected one argument`);
    return argv[i]!;
  };

  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (BOOL_FLAGS.has(name)) {
        if (eq >= 0) usageError(`argument ${name}: ignored explicit argument '${a.slice(eq + 1)}'`);
        setBool(args, name);
      } else if (VALUE_FLAGS.has(name)) {
        const value = eq >= 0 ? a.slice(eq + 1) : takeValue(name);
        setValue(args, name, value);
      } else {
        usageError(`unrecognized arguments: ${a}`);
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // Short flags: `-m value` and `-mvalue` both accepted (argparse does).
      const short = a.slice(0, 2);
      const rest = a.slice(2);
      if (VALUE_SHORTS.has(short)) {
        setValue(args, short, rest.length > 0 ? rest : takeValue(short));
      } else if (BOOL_FLAGS.has(short) && rest.length === 0) {
        setBool(args, short);
      } else {
        usageError(`unrecognized arguments: ${a}`);
      }
    } else {
      positionals.push(a);
    }
    i += 1;
  }

  if (args.help) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`andy ${VERSION}\n`);
    process.exit(0);
  }
  if (positionals.length > 0) {
    usageError(`unrecognized arguments: ${positionals.join(' ')}`);
  }
  if (args.theme !== undefined && !THEME_NAMES.includes(args.theme)) {
    usageError(
      `argument --theme: invalid choice: '${args.theme}' (choose from ${THEME_NAMES.map((t) => `'${t}'`).join(', ')})`,
    );
  }
  if (args.mode !== undefined && !MODE_CHOICES.includes(args.mode)) {
    usageError(
      `argument --mode: invalid choice: '${args.mode}' (choose from ${MODE_CHOICES.map((m) => `'${m}'`).join(', ')})`,
    );
  }
  return args;
}

function setBool(args: Args, name: string): void {
  switch (name) {
    case '--unsafe':
      args.unsafe = true;
      break;
    case '--rain':
      args.rain = true;
      break;
    case '--no-rain':
      args.noRain = true;
      break;
    case '--no-think':
      args.noThink = true;
      break;
    case '--no-auto-compact':
      args.noAutoCompact = true;
      break;
    case '--no-update':
      args.noUpdate = true;
      break;
    case '--list-models':
      args.listModels = true;
      break;
    case '--panes':
      args.panes = true;
      break;
    case '--version':
      args.version = true;
      break;
    case '--help':
    case '-h':
      args.help = true;
      break;
  }
}

function setValue(args: Args, name: string, value: string): void {
  switch (name) {
    case '--model':
    case '-m':
      args.model = value;
      break;
    case '--workdir':
    case '-C':
      args.workdir = value;
      break;
    case '--allow':
      args.allow = value;
      break;
    case '--deny':
      args.deny = value;
      break;
    case '--scope':
      args.scope = value;
      break;
    case '--theme':
      args.theme = value;
      break;
    case '--mode':
      args.mode = value;
      break;
    case '--agents':
      args.agents = value;
      break;
    case '--max-tokens': {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n)) usageError(`argument --max-tokens: invalid int value: '${value}'`);
      args.maxTokens = n;
      break;
    }
    case '--resume':
      args.resume = value;
      break;
  }
}

// === SECTION === launcher path / pane argv shims ===

/**
 * The launcher script this run came through, if there is one.
 *
 * `packaging/andy` exports ANDY_ROOT before it execs the interpreter, so the
 * script is discoverable from there. A bare `node dist/cli.js` — no launcher —
 * leaves the variable unset and gets undefined.
 */
function launcherPath(): string | undefined {
  const root = process.env['ANDY_ROOT'];
  if (!root) return undefined;
  const launcher = path.join(root, 'packaging', 'andy');
  try {
    // os.access(X_OK) equivalent: throws when missing or not executable.
    fs.accessSync(launcher, fs.constants.X_OK);
    return launcher;
  } catch {
    /* not executable / not present */
  }
  return undefined;
}

// Flags the tmux *pane* command must not carry. `--panes` would recurse, and
// `--resume` belongs to the first pane alone — panes opened later are new
// agents, and giving each of them the same history would defeat the point of
// them being separate agents that message each other.
const PANE_STRIP_FLAGS = new Set(['--panes']);
const PANE_STRIP_WITH_VALUE = new Set(['--resume']);

/**
 * Argv minus the flags that belong to the launcher, not to a pane.
 *
 * Handles both `--resume X` and `--resume=X`; anything unrecognised is passed
 * through untouched, so an unrelated flag is never eaten.
 */
function paneInnerArgv(argv: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (PANE_STRIP_FLAGS.has(a)) {
      i += 1;
      continue;
    }
    if (PANE_STRIP_WITH_VALUE.has(a)) {
      i += 2;
      continue;
    }
    if ([...PANE_STRIP_WITH_VALUE].some((f) => a.startsWith(`${f}=`))) {
      i += 1;
      continue;
    }
    out.push(a);
    i += 1;
  }
  return out;
}

/** shlex.quote for the tmux pane commands (POSIX single-quote form). */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Replace the process image — Node has no execv(2), so this is a stdio-
 * inheriting child followed by a matching parent exit. Observable difference
 * from execv: the parent lingers as the child's parent, which is harmless
 * for a CLI re-exec (the shell waits on the parent, the parent waits on the
 * child, exit codes propagate).
 */
function reexec(argv: string[]): Promise<never> {
  const launcher = launcherPath();
  const cmd = launcher ?? process.execPath;
  const args = launcher ? argv : [CLI_PATH, ...argv];
  return new Promise(() => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ANDY_UPDATED: '1' },
    });
    child.on('error', () => process.exit(1));
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('close', (code) => process.exit(code ?? 0));
  });
}

// === SECTION === credential onboarding ===

/**
 * First-run, interactive-terminal-only credential setup. Runs exactly once,
 * right before the launch gate that would otherwise just print an error and
 * exit — so a brand-new install reaches a working session on the first
 * `andy` invocation instead of needing `./setup.sh` or a hand-set env var
 * first. Writes through the same provider modules `/anthropic-api-setup`
 * and `/zai-api-setup` use inside the running TUI, so a key saved here
 * behaves identically to one pasted after launch — mode-600 profile under
 * ~/.andy, never echoed, never logged.
 *
 * Returns the source key to remember as current ('anthropic' | 'zai'), or
 * null if the operator skipped (Ctrl+C, blank input, or chose "later") —
 * null leaves `cfg` untouched and the caller's existing error path fires.
 */
async function runCredentialOnboarding(cfg: Config): Promise<string | null> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      '\nandy: no API key configured yet.\n\n' +
        '  1) Anthropic          — api.anthropic.com, pay-per-token\n' +
        '  2) Z.ai GLM Coding Plan — api.z.ai, subscription\n' +
        '  3) skip for now        — set ANTHROPIC_API_KEY yourself, or run ./setup.sh\n\n',
    );
    const choice = (await rl.question('Pick a provider [1]: ')).trim() || '1';
    if (choice === '3' || choice.toLowerCase() === 'skip') return null;

    if (choice === '2') {
      const key = (await rl.question('Z.ai Coding Plan API key: ')).trim();
      if (!key) return null;
      const zai = await import('./zai.js');
      if (!zai.looksLikeKey(key)) {
        process.stderr.write(
          'andy: that does not look like a Z.ai key — paste just the key, not the whole `export` line.\n',
        );
        return null;
      }
      const savedPath = zai.saveKey(key);
      zai.applyTo(cfg);
      process.stdout.write(`  saved to ${savedPath}\n\n`);
      return cfg.apiKeyPresent ? 'zai' : null;
    }

    const key = (await rl.question('Anthropic API key: ')).trim();
    if (!key) return null;
    const anthropicSetup = await import('./anthropic-setup.js');
    if (!anthropicSetup.looksLikeKey(key)) {
      process.stderr.write(
        'andy: that does not look like an API key — paste just the key, not the whole `export` line.\n',
      );
      return null;
    }
    const savedPath = anthropicSetup.saveKey(key);
    anthropicSetup.applyTo(cfg);
    process.stdout.write(`  saved to ${savedPath}\n\n`);
    return cfg.apiKeyPresent ? 'anthropic' : null;
  } finally {
    rl.close();
  }
}

// === SECTION === main ===

export async function main(argv?: string[]): Promise<number> {
  // Captured before parsing so the re-exec below can reproduce the original
  // invocation exactly, whatever it was.
  const rawArgv = argv ?? process.argv.slice(2);

  const args = parseArgv(rawArgv);

  if (args.listModels) {
    // The live catalog when it can be reached, the declared snapshot when it
    // cannot. This is a one-shot that exits, so one blocking fetch is the
    // right price for a list that is not a month out of date — and a failure
    // is reported on stderr rather than silently printing a stale list as
    // though it were current.
    const [models, err] = await logfareMod.modelIds();
    let list = models;
    if (list === null) {
      process.stderr.write(`andy: ${err} — showing the declared list\n`);
      list = [...KNOWN_MODELS];
    }
    for (const m of list) process.stdout.write(`${m}\n`);
    return 0;
  }

  const workdir = args.workdir ? path.resolve(expandTilde(args.workdir)) : process.cwd();

  // --panes: hand the whole session to tmux. tmux owns ctrl+b and the splits;
  // every pane re-runs this same command without --panes, so each one is an
  // ordinary Andy that happens to share a mailbox with its peers.
  if (args.panes && !process.env['ANDY_PANE_SESSION']) {
    const panesMod = await import('./panes.js');

    if (!panesMod.tmuxAvailable()) {
      process.stderr.write(
        'andy: --panes needs tmux — install it (e.g. `sudo apt install tmux`)\n',
      );
      return 2;
    }
    const launcher = launcherPath();
    const base = launcher ? [launcher] : [process.execPath, CLI_PATH];
    // The pane command keeps everything the operator typed, minus the
    // launcher's own flags — so `andy --panes --theme amber` opens amber
    // panes. The first pane additionally resumes, when asked.
    const andyCmd = [...base, ...paneInnerArgv(rawArgv)].map(shellQuote).join(' ');
    let firstCmd = andyCmd;
    if (args.resume) {
      firstCmd = [...base, '--resume', args.resume, ...paneInnerArgv(rawArgv)]
        .map(shellQuote)
        .join(' ');
    }
    const conf = panesMod.writeTmuxConf(andyHome(), andyCmd);
    return panesMod.launch(conf, andyCmd, workdir, firstCmd);
  }

  // Target scope: two files with one job each. allow.yaml arms the session
  // (its presence means the operator has declared their targets, so tools run
  // unattended); out-of-scope.yaml is the never-touch list. Each is looked
  // for in the working directory first, then in ~/.andy.
  const findScopeFile = (
    explicit: string | undefined,
    names: readonly string[],
  ): string | undefined => {
    if (explicit) return path.resolve(expandTilde(explicit));
    for (const base of [workdir, path.join(homedir(), '.andy')]) {
      for (const name of names) {
        const candidate = path.join(base, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  };

  const allowPath = findScopeFile(args.allow, ['allow.yaml', 'allow.yml']);
  const denyPath = findScopeFile(args.deny, ['out-of-scope.yaml', 'out-of-scope.yml']);

  // A leftover scope.yaml is never read: the old file was an allow-list that
  // also blocked, so reinterpreting it as a deny-list would block the very
  // hosts the operator had declared. Report it instead of acting on it.
  let legacyScope: string | undefined;
  if (args.scope) {
    legacyScope = path.resolve(expandTilde(args.scope));
  } else {
    const scopeMod = await import('./scope.js');
    legacyScope = scopeMod.findLegacyScope(workdir, homedir()) ?? undefined;
  }

  // Andy mode follows the operator's AGENTS.md. The search order lives in
  // config.findAgentsFile so the CLI and the runtime /mode andy path cannot
  // drift apart: workdir, its parent, the installed doctrine in ~/.andy,
  // then ~. The installed copy is what makes andy mode work from any directory.
  let agentsPath: string | undefined;
  if (args.agents) {
    agentsPath = path.resolve(expandTilde(args.agents));
  } else {
    agentsPath = findAgentsFile(workdir);
  }

  // Which theme to open with. An explicit --theme wins; failing that, whatever
  // was last chosen with /theme, so a restart lands back on it; failing both,
  // the config default. fromEnv ignores undefined overrides, so
  // resolving the precedence into one value here is what makes the remembered
  // choice take effect — and what keeps `--theme` authoritative over it.
  const theme = args.theme ?? currentTheme();

  // Shell rain is off unless requested. --no-rain kills rain everywhere,
  // including the boot screen.
  const cfg = Config.fromEnv({
    model: args.model,
    workdir,
    allowPath,
    denyPath,
    legacyScopePath: legacyScope ?? null,
    // `|| undefined` mirrors Python's `or None`: an absent flag leaves the
    // env-derived default alone rather than forcing False over it.
    unsafe: args.unsafe || undefined,
    theme,
    maxTokens: args.maxTokens,
    // fromEnv applies only non-undefined overrides, so false is passed
    // explicitly rather than `|| undefined` — otherwise the flag could never
    // turn the feature off, which is its entire job.
    autoCompact: args.noAutoCompact ? false : undefined,
    mode: args.mode,
    agentsPath: agentsPath ?? null,
    rain: args.rain ? true : undefined,
    bootRain: args.noRain ? false : undefined,
    showThinking: args.noThink ? false : undefined,
  });

  // A remembered hosted-gateway choice has to be re-applied here, not in the
  // launcher: the key can live in Andy's own profile, in ~/claude-source, or
  // only in the environment, and only the harness knows how to find all
  // three. The launcher deliberately does not source a profile it cannot
  // find, so without this a session would come back up on the default
  // Logfare endpoint with the wrong credential.
  //
  // Guarded by appliesToDefaultEndpoint: an endpoint the operator pointed
  // somewhere deliberate — the gateway itself, or any other host — is left
  // exactly as they set it, so a stale selection file cannot hijack it.
  const remembered = sourcesMod.currentKey();
  if (remembered) {
    const gateways: Record<string, () => Promise<{ appliesToDefaultEndpoint(baseUrl: string): boolean; applyTo(cfg: Config): unknown }>> = {
      tokenharbour: () => import('./tokenharbour.js'),
      openrouter: () => import('./openrouter.js'),
      unorouter: () => import('./unorouter.js'),
      antseed: () => import('./antseed.js'),
      aihubmix: () => import('./aihubmix.js'),
      zai: () => import('./zai.js'),
      anthropic: () => import('./anthropic-setup.js'),
    };
    const loader = gateways[remembered];
    if (loader) {
      const mod = await loader();
      if (mod.appliesToDefaultEndpoint(cfg.baseUrl)) mod.applyTo(cfg);
    }
  }

  // The split is not silent. A stale scope.yaml would otherwise leave the
  // operator believing the guard is armed when nothing is loaded at all —
  // and the old file's meaning cannot be carried over, because an allow-list
  // read as a deny-list would block exactly the hosts that were declared.
  if (legacyScope !== undefined && fs.existsSync(legacyScope)) {
    process.stderr.write(
      `andy: ${legacyScope} is no longer read — the scope guard was split into two files:\n` +
        '  allow.yaml          declared targets; its presence runs tools unattended\n' +
        '  out-of-scope.yaml   hosts that are never touched\n' +
        '  Nothing is armed or blocked right now. Rename the file to one of those to re-enable it.\n',
    );
  }

  if (!fs.existsSync(cfg.workdir)) {
    process.stderr.write(`andy: working directory does not exist: ${cfg.workdir}\n`);
    return 2;
  }

  if (!cfg.apiKeyPresent) {
    // Interactive first-run: only when there is a human on the other end of
    // stdin/stdout to ask. A piped/headless invocation (CI, a script, a
    // non-interactive agent) falls straight through to the plain error below
    // rather than hanging on a prompt nobody can answer.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const onboarded = await runCredentialOnboarding(cfg);
      if (onboarded) sourcesMod.setCurrent(onboarded);
    }
  }

  if (!cfg.apiKeyPresent) {
    process.stderr.write(
      'andy: no credentials found.\n' +
        '  Set ANTHROPIC_AUTH_TOKEN (preferred) or ANTHROPIC_API_KEY.\n' +
        "  For the local Logfare route, source Andy's own profile:\n" +
        '      set -a; . ~/.andy/logfare/source; set +a\n' +
        '  Or just run `./setup.sh` once, then launch with `andy`.\n' +
        '  Or paste a key when andy next asks — it only asks in an interactive terminal.\n',
    );
    return 2;
  }

  // Launch-time self-update. This runs after the preflight checks, so a
  // launch that cannot proceed anyway never pulls, and before the TUI takes
  // the terminal, so the notice is plain text on a normal screen.
  //
  // An applied update must re-exec rather than continue: config, scope and
  // the rest are already imported, and the fast-forward just replaced their
  // files on disk. Running on would be a mix of old and new modules.
  //
  // ANDY_UPDATED guards the loop: once we have re-exec'd, the next launch of
  // main() skips the check entirely, so a flaky fetch cannot make the
  // harness restart itself repeatedly.
  if (!process.env['ANDY_UPDATED']) {
    const result = updateMod.run({
      enabled: !args.noUpdate && process.env['ANDY_NO_UPDATE'] !== '1',
    });
    if (result.noteworthy) updateMod.formatResult(result);
    if (result.shouldReexec) {
      // Re-exec through the launcher when there is one, so the node_modules
      // dependency sync it performs runs against the package.json the
      // update just pulled. Going straight to process.execPath would skip
      // that and boot the new code against the old dependencies — exactly the
      // case the update flagged.
      await reexec(rawArgv);
      return 0; // unreachable — reexec replaces the process
    }
  }

  const { detectColors } = await import('./termcolors.js');

  // Ask the terminal for its own colours. A terminal draws its padding — the
  // gutter around the text grid — in its own background, and a TUI cannot
  // paint outside the grid, so a hardcoded background leaves a frame of the
  // wrong colour around everything. The same reply carries the foreground and
  // the sixteen ANSI slots, which is what the `system` theme is built from —
  // so this is one round-trip either way, not two.
  //
  // Best-effort throughout: a terminal that does not answer costs one short
  // timeout, the palettes keep their own colours, and `system` falls back to
  // green. termBg is filtered to a *dark* background because the three fixed
  // palettes are neon-on-black; `system` reads the unfiltered colours, since
  // it takes its text colour from the same place as its background.
  const colors = await detectColors();

  // `--resume` (what `/panes` passes to the relaunched process) restores the
  // conversation before the first frame, so the replayed transcript is drawn
  // by the same boot path that draws a fresh one. A bad path is reported and
  // the session starts clean rather than refusing to start at all.
  let resume;
  if (args.resume) {
    const file = sessionMod.findSessionFile(cfg, args.resume);
    const payload = file ? sessionMod.readSessionPayload(file) : undefined;
    if (payload) {
      resume = payload;
    } else {
      process.stderr.write(
        `andy: no session matching '${args.resume}' — starting a fresh session\n`,
      );
    }
  }

  const { render } = await import('ink');
  // @ts-ignore — ui/app.tsx exists but this repo's tsconfig does not yet set
  // `jsx` (only the orchestrator may add it), so tsc refuses to resolve the
  // .tsx module until then. The literal specifier is deliberate: esbuild/tsup
  // can only bundle an analytically-literal dynamic import. Once tsconfig
  // gains `jsx`, this suppression is inert and can be deleted. The surface is
  // pinned by AndyAppModule below so the any from the suppression cannot leak.
  const appMod = (await import('./ui/app.js')) as unknown as AndyAppModule;
  const instance = render(
    createElement(appMod.AndyApp, {
      cfg,
      termBg: colors ? colors.darkBg : null,
      termColors: colors ?? null,
      resume,
    }),
  );
  await instance.waitUntilExit();

  // `/panes` cannot start tmux itself — tmux has to own the terminal, and the
  // app is holding it — so the command exits with this request and the
  // relaunch happens here, once the terminal is free. Python read it off
  // app.run()'s return value; an Ink component cannot return, so the app
  // module exposes the request instead (relaunchRequest(): {resume?: string}
  // | null after unmount). The hook is optional so this boots unchanged
  // while the integration lane settles it.
  const request = typeof appMod.relaunchRequest === 'function' ? appMod.relaunchRequest() : null;
  if (request) {
    const relaunchArgv = paneInnerArgv(rawArgv);
    const resumeFlags = request.resume ? ['--resume', request.resume] : [];
    return main(['--panes', ...resumeFlags, ...relaunchArgv]);
  }
  return 0;
}

// `python -m andy` → `node dist/cli.js`: run main when executed directly.
//
// CLI_PATH (fileURLToPath(import.meta.url)) is always the REAL file path —
// Node resolves module URLs through symlinks when loading ESM. argv[1] is
// whatever the shell actually typed, which is the realpath only when andy
// was invoked by its literal file path. Every other normal invocation goes
// through a symlink: `npm link`, an npx bin shim, a hand-made
// ~/.local/bin/andy -> dist/cli.js. Comparing the raw (non-realpath) argv[1]
// against CLI_PATH made every one of those silently skip main() — the
// process loaded, matched nothing, and exited 0 with no output and no
// error, which is the worst possible failure mode for a CLI entrypoint.
// realpathSync resolves argv[1] through its symlink chain so the comparison
// is apples to apples; the try/catch covers the pathological case of
// argv[1] naming a file that no longer exists by the time this runs.
function invokedAsCli(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === CLI_PATH;
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  void main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`andy: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
