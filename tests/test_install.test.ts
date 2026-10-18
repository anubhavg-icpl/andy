// tests/test_install.test.ts — vitest port of tests/test_install.py.
// Regression suite for the one-line installer and the launcher it writes,
// guarding the promise install.sh makes — `andy` on PATH, running the
// checkout's own node_modules, from any directory, with no activation.
// Hermetic: no network, a throwaway git repo stands in for the upstream (git
// is only used inside the temp sandbox, never against this checkout), the
// dependency and credential steps are switched off, and what is asserted
// directly is the part that breaks silently — WHICH runtime the launcher
// chooses — read from the path the launcher reports in its failure message,
// not merely the exit code.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface RunResult {
  rc: number;
  out: string;
  err: string;
}

/** Run a command; never raises. */
function run(
  argv: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; stdin?: string },
): RunResult {
  const proc = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.stdin,
    encoding: 'utf8',
  });
  return { rc: proc.status ?? -1, out: proc.stdout ?? '', err: proc.stderr ?? '' };
}

/** A clean environment: a temp HOME, no inherited launcher state, real PATH.
 *
 *  XDG_DATA_HOME is pinned into the temp HOME too (install.sh honours it, so
 *  an operator who exports it — common on Arch — would otherwise send the
 *  test's clone into their real ~/.local/share). */
function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['HOME'] = home;
  env['XDG_DATA_HOME'] = path.join(home, '.local', 'share');
  for (const varName of [
    'ANDY_ROOT',
    'ANDY_INSTALL_DIR',
    'ANDY_BIN_DIR',
    'ANDY_REPO',
    'ANDY_SKIP_DEPS',
    'ANDY_SKIP_SETUP',
    'ANDY_HOME',
    // Direct the launcher away from any proxy machinery a real install
    // carries: the assertions are about node resolution, not the route.
    'ANDY_NO_PROXY',
  ]) {
    delete env[varName];
  }
  return env;
}

function chmod(p: string, mode: number): void {
  fs.chmodSync(p, mode);
}

/** A minimal git repo to clone: the launcher, a manifest, a setup stub.
 *  Git runs only inside the temp tree. */
function makeSource(td: string): string {
  const src = path.join(td, 'src');
  fs.mkdirSync(path.join(src, 'packaging'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'packaging', 'andy'), path.join(src, 'packaging', 'andy'));
  chmod(path.join(src, 'packaging', 'andy'), 0o755);
  // A manifest so the tree looks like the checkout the launcher expects;
  // with ANDY_SKIP_DEPS=1 no node_modules is ever built, so the launcher's
  // dependency sync, if it ever runs, is a no-op rather than a network fetch.
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"stub"}\n');
  fs.writeFileSync(path.join(src, 'setup.sh'), '#!/usr/bin/env bash\necho setup-stub\n');
  chmod(path.join(src, 'setup.sh'), 0o755);

  const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  const git = (args: string[]): RunResult => run(['git', ...args], { env: process.env, cwd: td });
  const init = git(['init', '-q', '-b', 'main', src]);
  expect(init.rc, 'git init of the throwaway source repo').toBe(0);
  expect(git([...ident, '-C', src, 'add', '-A']).rc, 'git add in the sandbox').toBe(0);
  expect(git([...ident, '-C', src, 'commit', '-qm', 'seed']).rc, 'git commit in the sandbox').toBe(0);
  return src;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichNode(): string {
  const probe = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' });
  return (probe.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// install.sh — the layout it lays down
// ---------------------------------------------------------------------------

describe('install — the layout install.sh lays down', () => {
  it(
    'clones the checkout, lays the launcher on PATH and pins its root',
    { timeout: 120_000 },
    () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-install-'));
      const home = path.join(td, 'home');
      fs.mkdirSync(home);
      const src = makeSource(td);
      const env = baseEnv(home);
      env['ANDY_REPO'] = `file://${src}`;
      env['ANDY_SKIP_DEPS'] = '1';
      env['ANDY_SKIP_SETUP'] = '1';

      const installDir = path.join(home, '.local', 'share', 'andy');
      const binDir = path.join(home, '.local', 'bin');

      // Feed the script on stdin, exactly as `curl … | bash` would, to prove
      // nothing in it reads standard input.
      const { rc, err } = run(['bash'], {
        env,
        cwd: ROOT,
        stdin: fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'),
      });
      expect(rc === 0, `install: exits 0 [${err.trim().slice(-400)}]`).toBe(true);
      expect(
        fs.statSync(path.join(installDir, '.git')).isDirectory(),
        'install: clones the checkout',
      ).toBe(true);
      expect(
        fs.statSync(path.join(binDir, 'andy')).isFile(),
        'install: lays the launcher on PATH',
      ).toBe(true);
      expect(
        isExecutable(path.join(binDir, 'andy')),
        'install: the launcher is executable',
      ).toBe(true);

      const shim = fs.readFileSync(path.join(binDir, 'andy'), 'utf8');
      expect(
        shim.includes(`ANDY_ROOT="${installDir}"`) || shim.includes(`ANDY_ROOT=${installDir}`),
        'install: the shim pins ANDY_ROOT to the checkout',
      ).toBe(true);
      expect(
        shim.includes(`${installDir}/packaging/andy`),
        'install: the shim execs the real launcher',
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The launcher — which runtime and tree it picks
// ---------------------------------------------------------------------------

describe('install — the launcher', () => {
  it(
    'runs node from PATH and fails closed on missing deps (exit 2)',
    { timeout: 120_000 },
    () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-launch-'));
      const home = path.join(td, 'home');
      fs.mkdirSync(home);
      const src = makeSource(td);
      const env = baseEnv(home);
      env['ANDY_REPO'] = `file://${src}`;
      env['ANDY_SKIP_DEPS'] = '1';
      env['ANDY_SKIP_SETUP'] = '1';
      const installDir = path.join(home, '.local', 'share', 'andy');
      const binDir = path.join(home, '.local', 'bin');

      // Lay the install down first (same input as the layout test).
      const install = run(['bash'], {
        env,
        cwd: ROOT,
        stdin: fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'),
      });
      expect(install.rc, 'the install ran').toBe(0);

      const launcher = path.join(installDir, 'packaging', 'andy');
      expect(fs.existsSync(launcher), 'launcher: the checkout was installed').toBe(true);

      const nodeBin = whichNode();
      expect(nodeBin.length > 0, 'node exists on PATH').toBe(true);

      // The fail-closed message names the runtime it chose and the tree that
      // is missing — the two facts the Python suite read out of the venv
      // failure. ANDY_SKIP_DEPS=1 left no node_modules behind.
      const viaShim = run([path.join(binDir, 'andy'), '--version'], {
        env: { ...baseEnv(home), ANDY_NO_PROXY: '1' },
        cwd: home,
      });
      expect(
        viaShim.err.includes(nodeBin),
        `launcher: the message names the node it chose [${viaShim.err.trim().slice(-300)}]`,
      ).toBe(true);
      expect(
        viaShim.err.includes(path.join(installDir, 'node_modules')),
        'launcher: the message names the missing dependency tree',
      ).toBe(true);
      expect(
        viaShim.err.includes('npm install'),
        'launcher: the fix is the one command that repairs it',
      ).toBe(true);
      expect(viaShim.rc === 2, `launcher: fails closed on missing deps (exit 2) [rc=${viaShim.rc}]`).toBe(true);

      // The launcher directly, with no ANDY_ROOT and from an unrelated
      // cwd — it must derive the checkout as the parent of packaging/ itself.
      const direct = run([launcher, '--version'], {
        env: { ...baseEnv(home), ANDY_NO_PROXY: '1' },
        cwd: '/',
      });
      expect(
        direct.err.includes(nodeBin),
        'launcher: derives the checkout from its own location',
      ).toBe(true);
      expect(direct.rc, 'launcher: still fails closed, same evidence').toBe(2);
    },
  );

  it(
    'dies before anything else when there is no node on PATH',
    { timeout: 60_000 },
    () => {
      const td = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-nonode-'));
      const home = path.join(td, 'home');
      fs.mkdirSync(home);
      // A bare checkout: the bring-your-own-node layout that cannot work.
      // This is the port's analogue of the old no-venv fallback test — node
      // resolution has exactly one source (PATH), so the interesting edge is
      // its absence, and the launcher must say so rather than flailing.
      const root = path.join(td, 'byo');
      fs.mkdirSync(path.join(root, 'packaging'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'packaging', 'andy'), path.join(root, 'packaging', 'andy'));
      chmod(path.join(root, 'packaging', 'andy'), 0o755);

      // A PATH with the coreutils the launcher needs to find itself
      // (readlink, dirname, basename — used before any dependency check)
      // but deliberately no node: every tool except the one that matters.
      // The shebang cannot resolve through this PATH either, so the script
      // runs as an argument to the absolute bash.
      const bashProbe = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' });
      const bashBin = (bashProbe.stdout ?? '').trim();
      expect(bashBin.length > 0, 'bash exists on PATH').toBe(true);
      const emptyBin = path.join(td, 'bin-minus-node');
      fs.mkdirSync(emptyBin);
      for (const tool of ['readlink', 'dirname', 'basename']) {
        const probe = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
        const resolved = (probe.stdout ?? '').trim();
        expect(resolved.length > 0, `${tool} exists on PATH`).toBe(true);
        fs.symlinkSync(resolved, path.join(emptyBin, tool));
      }
      const env = baseEnv(home);
      env['PATH'] = emptyBin; // coreutils only — no node, no curl
      env['ANDY_NO_PROXY'] = '1';

      const { rc, err } = run([bashBin, path.join(root, 'packaging', 'andy'), '--version'], {
        env,
        cwd: '/',
      });
      expect(rc === 2, `launcher: exit 2, not a crash [rc=${rc}]`).toBe(true);
      expect(
        err.includes('node not found'),
        `launcher: says node is the missing piece [${err.trim().slice(-200)}]`,
      ).toBe(true);
    },
  );
});
