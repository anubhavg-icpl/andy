/**
 * tests/test_update.test.ts — vitest port of tests/test_update.py.
 *
 * Real git, real repositories, no network: the suite builds a bare "origin"
 * and a clone of it in a temp directory, then drives `src/update.ts` against
 * the clone. What is protected is the safety contract around the pull, not
 * "does git pull work": a dirty tree is never touched, a diverged branch is
 * never merged, a broken remote never raises and never blocks the launch —
 * asserted by checking the commit HEAD points at, not the action string.
 *
 * Every fixture is hermetic (pinned identity, signing off) and lives under
 * os.tmpdir(); nothing here runs git against this repository, and nothing
 * calls run() against a live environment.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import * as update from '../src/update.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// git plumbing for the fixtures
// ---------------------------------------------------------------------------

/** Run git in *repo* and return stdout. Asserts success. */
function git(repo: string, ...args: string[]): string {
  const proc = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${repo}:\n${proc.stderr}`)
  }
  return proc.stdout.trim()
}

/**
 * Pin an identity and disable signing, so the fixtures are hermetic.
 *
 * Without this the suite inherits the operator's global config: a commit
 * would fail on a machine with no user.email set, and `commit.gpgsign = true`
 * would hang waiting for a passphrase. Neither is a property of the code
 * under test.
 */
function ident(repo: string): void {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'tag.gpgsign', 'false')
}

/** A bare origin plus a clone tracking it. Returns [origin, seed, clone]. */
function makeRepos(base: string): [string, string, string] {
  mkdirSync(base, { recursive: true })
  const origin = path.join(base, 'origin.git')
  const clone = path.join(base, 'clone')

  mkdirSync(origin)
  git(origin, 'init', '--bare', '--initial-branch=main')

  // Build the initial commit in a scratch worktree, then push it, so the
  // clone starts with main already existing on the remote.
  const seed = path.join(base, 'seed')
  mkdirSync(seed)
  git(seed, 'init', '--initial-branch=main')
  ident(seed)
  writeFileSync(path.join(seed, 'README.md'), 'hello\n')
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'initial')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-u', 'origin', 'main')

  const cloned = spawnSync('git', ['clone', origin, clone], { encoding: 'utf8' })
  if (cloned.status !== 0) throw new Error(`git clone failed:\n${cloned.stderr}`)
  ident(clone)
  return [origin, seed, clone]
}

/** Land a new commit on origin's main, as another developer would. */
function commitToOrigin(
  seed: string,
  origin: string,
  message: string,
  files: Record<string, string> | null = null,
): string {
  for (const [name, content] of Object.entries(files ?? { 'work.txt': message })) {
    writeFileSync(path.join(seed, name), content)
  }
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', message)
  git(seed, 'push', 'origin', 'main')
  return git(seed, 'rev-parse', 'HEAD')
}

function headOf(repo: string): string {
  return git(repo, 'rev-parse', 'HEAD')
}

/** A StringIO-equivalent: formatResult writes here instead of stderr. */
function buffer(): { buf: string; stream: NodeJS.WritableStream } {
  let text = ''
  return {
    get buf() {
      return text
    },
    stream: {
      write(chunk: string | Uint8Array): boolean {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      },
    } as NodeJS.WritableStream,
  }
}

const BASES: string[] = []

function newBase(prefix: string): string {
  const base = mkdtempSync(path.join(tmpdir(), `andy-update-${prefix}-`))
  // Guard the hermeticity claim: every fixture must live in the OS temp tree,
  // never inside this repository (whose git state belongs to the orchestrator).
  if (!base.startsWith(tmpdir()) || base.startsWith(ROOT)) {
    throw new Error(`fixture escaped the temp tree: ${base}`)
  }
  BASES.push(base)
  return base
}

beforeAll(() => {
  // No-op hook kept for symmetry with the Python main(); guards live in
  // newBase so they run per fixture rather than once.
})

afterAll(() => {
  for (const base of BASES) rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// find_checkout
// ---------------------------------------------------------------------------

describe('update self-check', () => {
  it('test_find_checkout: locates this repository', () => {
    // Running from this repo, src/update.ts sits at <root>/src/update.ts, so
    // the parent of the module's directory is the checkout — and it is one.
    const root = update.findCheckout()
    expect(root).toBe(ROOT)
  })

  it('test_find_checkout: None outside a repo (the site-packages install path)', () => {
    // The Python suite redirected update.__file__ at a non-repo directory;
    // import.meta.url cannot be redirected in-process; so this reproduces
    // the install shape the honest way — a copy of the module in a temp
    // tree, imported by a child tsx process (no repo above it).
    const base = newBase('nogit')
    const pkgDir = path.join(base, 'site-packages', 'andy')
    mkdirSync(pkgDir, { recursive: true })
    copyFileSync(path.join(ROOT, 'src', 'update.ts'), path.join(pkgDir, 'update.ts'))
    writeFileSync(
      path.join(base, 'probe.ts'),
      "import * as u from './site-packages/andy/update.js'\n" +
        `console.log(u.findCheckout() ?? 'NONE')\n`,
    )
    const proc = spawnSync('npx', ['tsx', 'probe.ts'], { cwd: base, encoding: 'utf8' })
    expect(proc.status, proc.stderr).toBe(0)
    expect(proc.stdout.trim()).toBe('NONE')
  }, 60_000)

  // ---------------------------------------------------------------------------
  // The states
  // ---------------------------------------------------------------------------

  it('test_up_to_date', () => {
    const base = newBase('a')
    const [, , clone] = makeRepos(base)
    const r = update.inspect(clone)
    expect(r.action).toBe('none') // up to date: action is none
    expect(r.noteworthy).toBe(false) // up to date: not noteworthy
    expect(r.behind).toBe(0) // up to date: behind is zero
  }, 30_000)

  it('test_behind_clean', () => {
    const base = newBase('b')
    const [origin, seed, clone] = makeRepos(base)
    commitToOrigin(seed, origin, 'second commit')
    const want = commitToOrigin(seed, origin, 'third commit')
    const before = headOf(clone)

    let r = update.inspect(clone)
    expect(r.action).toBe('notify') // behind+clean: inspect notifies
    expect(r.behind).toBe(2) // behind+clean: counts the commits
    expect(r.commits.length).toBe(2) // behind+clean: lists the commits
    expect(r.commits.every((c) => c.length > 0)).toBe(true)
    // inspect must not move HEAD — only apply does.
    expect(headOf(clone)).toBe(before) // behind+clean: inspect leaves HEAD alone

    r = update.apply(clone, r)
    expect(r.action).toBe('updated') // behind+clean: apply updates
    expect(r.shouldReexec).toBe(true) // behind+clean: apply asks for a re-exec
    expect(headOf(clone)).toBe(want) // behind+clean: HEAD moved to the new tip
    // behind+clean: no merge commit was created
    expect(git(clone, 'rev-list', '--count', '--merges', 'HEAD')).toBe('0')
  }, 30_000)

  it('test_behind_modified_tracked', () => {
    const base = newBase('c')
    const [origin, seed, clone] = makeRepos(base)
    commitToOrigin(seed, origin, 'remote work')
    const before = headOf(clone)

    // An edit to a file git is tracking — work the operator would lose or
    // have to reconcile. This is the case that must stop the pull dead.
    writeFileSync(path.join(clone, 'README.md'), 'edited by hand\n')

    let r = update.inspect(clone)
    expect(r.action).toBe('blocked') // behind+modified: inspect blocks
    expect(r.behind).toBe(1) // behind+modified: still reports how far behind
    expect(r.shouldReexec).toBe(false) // behind+modified: no re-exec
    expect(headOf(clone)).toBe(before) // behind+modified: HEAD is untouched

    // apply() re-checks for itself: a caller that hands it a stale notify
    // result must not get a pull. This is the regression the suite exists for.
    const stale = new update.UpdateResult()
    stale.action = 'notify'
    stale.behind = 1
    stale.commits = ['x']
    const r2 = update.apply(clone, stale)
    expect(r2.action).toBe('blocked') // behind+modified: apply refuses on its own evidence
    expect(headOf(clone)).toBe(before) // behind+modified: HEAD is still untouched
    // behind+modified: the edit survives
    expect(readFileSync(path.join(clone, 'README.md'), 'utf8')).toBe('edited by hand\n')
  }, 30_000)

  it('test_behind_untracked', () => {
    const base = newBase('c2')
    const [origin, seed, clone] = makeRepos(base)
    const want = commitToOrigin(seed, origin, 'remote work')

    // A stray untracked file — a scratch note, a build artefact. A
    // fast-forward cannot lose it, so it must not disable the update.
    writeFileSync(path.join(clone, 'scratch.txt'), 'notes\n')

    const r = update.inspect(clone)
    expect(r.action).toBe('notify') // behind+untracked: inspect does not block

    const applied = update.apply(clone, r)
    expect(applied.action).toBe('updated') // behind+untracked: the update proceeds
    expect(headOf(clone)).toBe(want) // behind+untracked: HEAD moved
    // behind+untracked: the untracked file survives
    expect(readFileSync(path.join(clone, 'scratch.txt'), 'utf8')).toBe('notes\n')
  }, 30_000)

  it('test_diverged', () => {
    const base = newBase('d')
    const [origin, seed, clone] = makeRepos(base)

    // A local commit on the clone...
    writeFileSync(path.join(clone, 'mine.txt'), 'local\n')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-m', 'local commit')
    const localTip = headOf(clone)

    // ...and a different commit on origin.
    commitToOrigin(seed, origin, 'remote commit')

    let r = update.inspect(clone)
    // Both sides moved, so HEAD is not an ancestor of upstream; --ff-only is
    // the only thing standing between this and an unwanted merge commit.
    // diverged: inspect does not report a fast-forwardable update
    expect(['blocked', 'notify']).toContain(r.action)

    if (r.action === 'notify') {
      r = update.apply(clone, r)
      expect(r.action).toBe('blocked') // diverged: apply refuses to merge
    }

    expect(headOf(clone)).toBe(localTip) // diverged: the local commit is still HEAD
    // diverged: no merge commit exists
    expect(git(clone, 'rev-list', '--count', '--merges', 'HEAD')).toBe('0')
    // diverged: the local file survives
    expect(readFileSync(path.join(clone, 'mine.txt'), 'utf8')).toBe('local\n')
  }, 30_000)

  it('test_deps_changed', () => {
    const base = newBase('e')
    const [origin, seed, clone] = makeRepos(base)

    // An ordinary commit must NOT flag a dependency change...
    commitToOrigin(seed, origin, 'docs only', { 'NOTES.md': 'hi\n' })
    let r = update.apply(clone, update.inspect(clone))
    expect(r.depsChanged).toBe(false) // deps: an unrelated commit leaves deps_changed False

    // ...but a commit touching package.json must.
    commitToOrigin(seed, origin, 'add a dependency', { 'package.json': '{"dependencies":{"ink":"^8.0.0"}}\n' })
    r = update.apply(clone, update.inspect(clone))
    expect(r.depsChanged).toBe(true) // deps: a package.json change is flagged
    expect(r.action).toBe('updated') // deps: the update still succeeded
  }, 30_000)

  it('test_not_a_repo', () => {
    const base = newBase('f')
    const plain = path.join(base, 'plain')
    mkdirSync(plain)
    const r = update.inspect(plain)
    // not-a-repo: inspect reports none, not an exception
    expect(r.action).toBe('none')
  }, 30_000)

  it('test_no_upstream', () => {
    // A repo with no remote at all: there is nothing to be behind.
    const base = newBase('g')
    const solo = path.join(base, 'solo')
    mkdirSync(solo)
    git(solo, 'init', '--initial-branch=main')
    ident(solo)
    writeFileSync(path.join(solo, 'a.txt'), 'x\n')
    git(solo, 'add', '-A')
    git(solo, 'commit', '-m', 'only')

    const r = update.inspect(solo)
    expect(r.action).toBe('none') // no-upstream: reported as none
    expect(r.noteworthy).toBe(false) // no-upstream: not noteworthy
  }, 30_000)

  it('test_unreachable_remote', () => {
    const base = newBase('h')
    const [, , clone] = makeRepos(base)
    // Point the remote at somewhere that cannot answer, without touching the
    // network: a path that does not exist fails the fetch immediately.
    git(clone, 'remote', 'set-url', 'origin', path.join(base, 'does-not-exist.git'))

    const r = update.inspect(clone)
    expect(r.action).toBe('error') // unreachable: reported as error, not raised
    expect(r.noteworthy).toBe(true) // unreachable: noteworthy

    // And the error must format cleanly rather than throwing.
    const out = buffer()
    update.formatResult(r, out.stream)
    // unreachable: formats without raising
    expect(out.buf).toContain('update check skipped')
  }, 30_000)

  it('test_disabled: run(enabled=false) must not shell out to git at all', async () => {
    // Prove it by counting every spawnSync the module graph performs while
    // disabled (the Python suite broke _git so an invocation would raise).
    let calls = 0
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>()
      return {
        ...actual,
        spawnSync: (...args: unknown[]) => {
          calls += 1
          return (actual.spawnSync as (...a: unknown[]) => unknown)(...args)
        },
      }
    })
    try {
      vi.resetModules()
      const upd = await import('../src/update.js')
      const r = upd.run({ enabled: false })
      expect(r.action).toBe('none') // disabled: returns none
      expect(r.noteworthy).toBe(false) // disabled: nothing to report
      expect(calls).toBe(0) // disabled: git was never invoked
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('test_format', () => {
    // An up-to-date result prints nothing at all — a clean launch is silent.
    const quiet = new update.UpdateResult()
    quiet.action = 'none'
    quiet.message = 'up to date'
    const quietOut = buffer()
    update.formatResult(quiet, quietOut.stream)
    expect(quietOut.buf).toBe('') // format: a quiet result prints nothing

    const base = newBase('j')
    const [origin, seed, clone] = makeRepos(base)
    commitToOrigin(seed, origin, 'remote work')
    let r = update.apply(clone, update.inspect(clone))
    let out = buffer()
    update.formatResult(r, out.stream)
    // format: an update announces itself
    expect(out.buf).toContain('UPDATE')
    // format: names the commit
    expect(out.buf).toContain('remote work')
    // format: says it is restarting
    expect(out.buf).toContain('restarting')

    // A dependency change must tell a hand-managed checkout to re-install
    // when the operator brings their own node_modules...
    commitToOrigin(seed, origin, 'bump deps', { 'package.json': '{"dependencies":{"ink":"^8.1.0"}}\n' })
    r = update.apply(clone, update.inspect(clone))
    out = buffer()
    update.formatResult(r, out.stream)
    // format: flags the npm re-install on a dep change
    expect(out.buf).toContain('npm install')

    // ...and must say node_modules refreshes itself when the checkout owns
    // one (an install.sh install). The marker is untracked, which git
    // ignores for the dirty check.
    mkdirSync(path.join(clone, 'node_modules'), { recursive: true })
    commitToOrigin(seed, origin, 'bump deps again', { 'package.json': '{"dependencies":{"ink":"^8.2.0"}}\n' })
    r = update.apply(clone, update.inspect(clone))
    out = buffer()
    update.formatResult(r, out.stream)
    // format: a bundled node_modules refreshes itself, not via npm install
    expect(out.buf).toContain('refreshes itself')
    expect(out.buf).not.toContain('re-run npm install')
  }, 60_000)
})
