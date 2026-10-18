/**
 * update.ts — self-update on launch: detect new commits on the upstream and
 * apply them. (port of zimzilla/update.py)
 *
 * What this module is: the launch-time check that answers one question — is
 * `origin` ahead of me, and if so, can I move to it safely? Pure logic, no
 * TUI, testable against real throwaway repositories without a terminal.
 *
 * (The Python original fast-forwards an *editable install's* checkout. The
 * TypeScript port runs the checkout directly — tsx on src, or the dist bundle
 * npm run build emits — so fast-forwarding the checkout is still the whole
 * update; the launcher re-execs through it, which re-syncs node_modules when
 * the manifest moved.)
 *
 * Invariants (all built around not surprising the operator, because applying
 * an update means executing code fetched from the remote at startup):
 *  - `--ff-only` — never a merge commit, never a rebase. A diverged branch is
 *    reported, not resolved.
 *  - A dirty tree means no pull at all. This checkout is also the operator's
 *    development tree, so uncommitted work is normal, not an error, and
 *    nothing here may stash, reset or otherwise touch it.
 *  - Every git call carries a timeout (seconds). A hung fetch must cost a
 *    couple of seconds, never a stalled launch.
 *  - Every failure path is non-fatal: offline, no upstream, not a repository,
 *    git absent, pull refused — each returns a result and the harness boots
 *    normally.
 *  - Nothing in this module blocks the caller's decisions: it reports what it
 *    found and what it did, and leaves the printing and the re-exec decision
 *    to the caller (cli.ts).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Seconds any single git invocation may take. A fetch of a small repo is well
 * under a second on a working connection; this only has to be long enough to
 * survive a slow link and short enough that a black-holed one does not hold
 * the launch hostage.
 */
export const GIT_TIMEOUT = 10.0;

/**
 * The file whose change means the dependencies moved and node_modules needs
 * rebuilding. Its content is compared across the pull.
 */
export const DEPS_FILE = 'package.json';

/** What the update check found and did. */
export class UpdateResult {
  /**
   * The whole story in one word:
   *
   * `none`    up to date, not a checkout, or disabled — nothing to say.
   * `notify`  an update exists and is safe to apply.
   * `updated` pulled successfully; shouldReexec is set.
   * `blocked` an update exists but applying it was refused (dirty tree,
   *           diverged branch) — reported, never forced.
   * `error`   the check itself failed (offline, no git, no upstream).
   */
  action: 'none' | 'notify' | 'updated' | 'blocked' | 'error' = 'none';
  behind: number = 0;
  commits: string[] = [];
  message: string = '';
  depsChanged: boolean = false;
  /**
   * Whether the checkout carries its own node_modules (built by install.sh).
   * Such an install refreshes the dependencies itself on the next launch —
   * the launcher re-runs npm install when package.json moved — so a
   * dependency change is announced differently than for a checkout the
   * operator npm-installs by hand.
   */
  bundledDeps: boolean = false;
  shouldReexec: boolean = false;

  /** Whether the operator should be told about this at all. */
  get noteworthy(): boolean {
    return this.action === 'updated' || this.action === 'blocked' || this.action === 'error';
  }
}

/**
 * Run one git command in *root*. Returns [returncode, captured output].
 * Timeout is in seconds.
 *
 * Never raises. A missing git binary, a timeout and a non-zero exit all come
 * back as a return code and whatever was captured, so callers branch on the
 * code rather than guarding every call with try/except.
 *
 * stderr is folded into the captured text: git's useful diagnostics ("not a
 * git repository", "couldn't find remote ref") go there, and the caller wants
 * them for the message.
 */
function git(root: string, args: string[], timeout: number = GIT_TIMEOUT): [number, string] {
  let proc;
  try {
    proc = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: timeout * 1000,
    });
  } catch (e) {
    return [127, String(e)];
  }
  if (proc.error) {
    // ENOENT (no git), timeout kill, permission problems.
    return [127, String(proc.error.message ?? proc.error)];
  }
  const out = (proc.stdout ?? '') + (proc.stderr ?? '');
  return [proc.status ?? 127, out.trim()];
}

/** The current HEAD sha, or '' if it could not be read. */
function head(root: string, timeout: number = GIT_TIMEOUT): string {
  const [code, out] = git(root, ['rev-parse', 'HEAD'], timeout);
  if (code !== 0) return '';
  const lines = out.trim().split('\n');
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : '';
}

/**
 * The git checkout this package is running from, or undefined.
 *
 * This module is `<root>/dist/update.js` once built (or `<root>/src/update.ts`
 * under tsx), so the grandparent of its directory is the repository root —
 * the same depth relationship the Python package dir had. A wheel installed
 * into site-packages has no repository above it, and rev-parse says so — the
 * whole feature then no-ops, which is correct: there is nothing to
 * fast-forward. process.argv[1] is tried as a second candidate for layouts
 * where the module was bundled away from the checkout (tsup inlines this
 * file into dist/cli.js).
 */
export function findCheckout(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.dirname(here)];
  if (process.argv[1]) candidates.push(path.dirname(path.dirname(path.resolve(process.argv[1]))));
  for (const root of candidates) {
    const [code, out] = git(root, ['rev-parse', '--is-inside-work-tree']);
    if (code === 0 && out.trim().split('\n').pop() === 'true') return root;
  }
  return undefined;
}

/** The tracking branch of HEAD (`origin/main`), or undefined if unset. */
function upstream(root: string, timeout: number = GIT_TIMEOUT): string | undefined {
  const [code, out] = git(
    root,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    timeout,
  );
  if (code !== 0 || !out.trim()) return undefined;
  const lines = out.trim().split('\n');
  const name = (lines[lines.length - 1] ?? '').trim();
  return name || undefined;
}

/**
 * Whether the tree has uncommitted changes that a pull could disturb.
 *
 * Only *tracked* modifications count. `--untracked-files=no` is deliberate: a
 * fast-forward cannot lose an untracked file — git either leaves it alone or
 * refuses the pull outright because the incoming commit would overwrite it,
 * and that refusal is caught and reported. Counting untracked files as dirty
 * instead would mean any stray scratch file in the checkout disables the
 * feature for good, which is the wrong trade for a check that is meant to
 * run unattended.
 *
 * A modified tracked file is different: it is work the operator would lose or
 * have to reconcile, so it stops the pull dead.
 *
 * Shared by inspect and apply so the two cannot disagree — the tree can
 * change between them, and the decision to pull must be made on what is true
 * at the moment of the pull, not on what was true when we looked.
 */
function isDirty(root: string, timeout: number = GIT_TIMEOUT): boolean {
  const [code, status] = git(
    root,
    ['status', '--porcelain', '--untracked-files=no'],
    timeout,
  );
  return code === 0 && status.trim().length > 0;
}

/** Fetch the upstream and report how far behind HEAD is. */
export function inspect(root: string, timeout: number = GIT_TIMEOUT): UpdateResult {
  if (upstream(root, timeout) === undefined) {
    return withFields(new UpdateResult(), {
      action: 'none',
      message: 'no upstream tracking branch configured',
    });
  }

  let [code, out] = git(root, ['fetch', '--quiet'], timeout);
  if (code !== 0) {
    // Offline, no credentials, no such remote — all the same to us: we could
    // not find out, so we say nothing and boot.
    return withFields(new UpdateResult(), {
      action: 'error',
      message: `could not reach the remote: ${out}`,
    });
  }

  [code, out] = git(root, ['rev-list', '--count', 'HEAD..@{u}'], timeout);
  if (code !== 0) {
    return withFields(new UpdateResult(), {
      action: 'error',
      message: `could not compare with upstream: ${out}`,
    });
  }
  const behind = Number.parseInt(out.trim().split('\n').pop() ?? '', 10);
  if (!Number.isFinite(behind)) {
    return withFields(new UpdateResult(), { action: 'error', message: 'could not read the commit count' });
  }

  if (behind === 0) {
    return withFields(new UpdateResult(), { action: 'none', message: 'up to date' });
  }

  [code, out] = git(root, ['log', '--oneline', '--no-decorate', 'HEAD..@{u}'], timeout);
  const commits = code === 0 ? out.split('\n').filter((l) => l.length > 0) : [];

  // A dirty tree is not an error here, it is the normal state of a development
  // checkout. It does mean we must not pull.
  if (isDirty(root, timeout)) {
    return withFields(new UpdateResult(), {
      action: 'blocked',
      behind,
      commits,
      message: 'local changes present — not updating (commit or stash them to update)',
    });
  }

  return withFields(new UpdateResult(), {
    action: 'notify',
    behind,
    commits,
    message: `${behind} new commit${behind !== 1 ? 's' : ''} available`,
  });
}

function withFields(r: UpdateResult, fields: Partial<UpdateResult>): UpdateResult {
  return Object.assign(r, fields);
}

/** Whether *root* carries the node_modules install.sh builds. */
function hasBundledDeps(root: string): boolean {
  return fs.existsSync(path.join(root, 'node_modules'));
}

/**
 * Fast-forward onto the upstream and record what changed.
 *
 * Normally reached only for a `notify` result, which by construction means
 * the tree was clean when it was inspected. That is not relied on: a fetch
 * sits between the two calls, and the operator can edit a file in that
 * window, so the dirty check is repeated here against the state of the tree
 * right now. apply refuses on its own evidence rather than on the caller's
 * memory of it.
 *
 * `--ff-only` is the second guard: if anything has diverged the pull refuses
 * and we report that instead of creating a merge commit the operator did not
 * ask for.
 */
export function apply(root: string, result: UpdateResult, timeout: number = GIT_TIMEOUT): UpdateResult {
  if (isDirty(root, timeout)) {
    return withFields(new UpdateResult(), {
      action: 'blocked',
      behind: result.behind,
      commits: result.commits,
      message: 'local changes present — not updating (commit or stash them to update)',
    });
  }

  const before = head(root, timeout);

  const [code, out] = git(root, ['pull', '--ff-only', '--quiet'], timeout);
  if (code !== 0) {
    return withFields(new UpdateResult(), {
      action: 'blocked',
      behind: result.behind,
      commits: result.commits,
      message: `could not fast-forward: ${out}`,
    });
  }

  const after = head(root, timeout);

  // Did the dependency file move across the range we just pulled? Compared
  // over old..new rather than against the working tree, so an unrelated local
  // edit to the deps file cannot produce a false positive.
  let depsChanged = false;
  if (before && after && before !== after) {
    const [diffCode] = git(root, ['diff', '--quiet', before, after, '--', DEPS_FILE], timeout);
    // diff --quiet exits 1 when there IS a difference.
    depsChanged = diffCode === 1;
  }

  return withFields(new UpdateResult(), {
    action: 'updated',
    behind: result.behind,
    commits: result.commits,
    message: `updated by ${result.behind} commit${result.behind !== 1 ? 's' : ''}`,
    depsChanged,
    bundledDeps: hasBundledDeps(root),
    shouldReexec: true,
  });
}

/**
 * The whole check: find the checkout, inspect it, and apply if we may.
 *
 * This is the one function cli.ts calls. It never raises and never blocks on
 * the network for longer than *timeout* (seconds); when anything at all goes
 * wrong it returns an error/none result and the caller boots as normal.
 */
export function run(opts: { enabled?: boolean; timeout?: number } = {}): UpdateResult {
  const { enabled = true, timeout = GIT_TIMEOUT } = opts;

  if (!enabled) return withFields(new UpdateResult(), { action: 'none', message: 'disabled' });

  const root = findCheckout();
  if (root === undefined) {
    return withFields(new UpdateResult(), { action: 'none', message: 'not a git checkout' });
  }

  const result = inspect(root, timeout);
  if (result.action === 'notify') return apply(root, result, timeout);
  return result;
}

/**
 * Print a result in the harness's own voice, to stderr by default.
 *
 * Kept beside the logic so the wording lives with the thing it describes.
 * Nothing is printed for a quiet result — an up-to-date launch says nothing
 * at all, which is what a launch should look like.
 */
export function formatResult(result: UpdateResult, stream: NodeJS.WritableStream = process.stderr): void {
  if (!result.noteworthy) return;

  const line = (text: string) => stream.write(`${text}\n`);

  if (result.action === 'error') {
    line(`  · update check skipped — ${result.message}`);
    return;
  }

  const noun = `commit${result.behind !== 1 ? 's' : ''}`;

  if (result.action === 'blocked') {
    line('  ⟩ UPDATE');
    line(`  ◈ ${result.behind} new ${noun} on the remote`);
    for (const c of result.commits.slice(0, 10)) line(`    ${c}`);
    line(`  · ${result.message}`);
    return;
  }

  line('  ⟩ UPDATE');
  line(`  ◈ ${result.message}`);
  for (const c of result.commits.slice(0, 10)) line(`    ${c}`);
  if (result.depsChanged) {
    if (result.bundledDeps) {
      line(`  · ${DEPS_FILE} changed — node_modules refreshes itself on restart`);
    } else {
      line(`  · ${DEPS_FILE} changed — re-run npm install to refresh the dependencies`);
    }
  }
  line('  · restarting on the new code…');
}
