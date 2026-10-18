/**
 * sandbox.ts — filesystem jail (port of zimzilla/sandbox.py).
 *
 * What this module is: the one gate every file tool's path argument goes
 * through. It refuses anything that escapes the working directory unless the
 * session was started with --unsafe.
 *
 * Invariants:
 *  - Containment is checked BEFORE existence, so an escaping path reports the
 *    security-relevant reason rather than a misleading "does not exist".
 *  - Resolution follows symlinks (where they exist), so a link pointing
 *    outside the jail is caught by the containment check, not slipped through.
 *  - Paths are plain strings (node:path semantics), matching PORT-MAP §1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expandTilde } from './shared.js';

/** Raised when a path escapes the sandbox. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Best-effort absolute + symlink-resolved path, matching pathlib's
 * `Path.resolve()` (strict=False): symlinks are followed where they exist,
 * the remainder is resolved lexically. fs.realpathSync alone would throw on
 * any non-existent tail (writes target paths that do not exist yet), so the
 * longest existing ancestor is realpath'd and the rest joined back on.
 */
function resolveBestEffort(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return path.resolve(p); // reached '/' — nothing left to try
    return path.join(resolveBestEffort(parent), path.basename(p));
  }
}

/** True when `child` is `parent` itself or lives underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve *raw* relative to *workdir*, enforcing the jail.
 *
 * Returns a resolved path. Symlinks are resolved so a link pointing outside
 * the jail is caught. Set `mustExist` to require the target to already exist
 * (reads).
 */
export function resolveInJail(
  workdir: string,
  raw: string,
  unsafe = false,
  opts?: { mustExist?: boolean },
): string {
  const jail = resolveBestEffort(workdir);
  if (!raw || raw.trim() === '') {
    throw new SandboxError('empty path');
  }

  const expanded = expandTilde(raw);
  const candidate = path.isAbsolute(expanded) ? expanded : path.join(jail, expanded);

  // resolveBestEffort (not bare path.resolve) so a symlink pointing outside
  // the jail is caught by the containment check rather than slipping through.
  const resolved = resolveBestEffort(candidate);

  // Check containment BEFORE existence, so an escaping path reports the
  // security-relevant reason rather than a misleading "does not exist".
  if (!unsafe && !isWithin(jail, resolved)) {
    throw new SandboxError(
      `path escapes the working directory (${jail}): ${raw}\n` +
        `  re-run with --unsafe to permit it`,
    );
  }

  if (opts?.mustExist && !fs.existsSync(resolved)) {
    throw new SandboxError(`path does not exist: ${raw}`);
  }

  return resolved;
}

/**
 * True if *path* (already constructed) stays inside *workdir*.
 *
 * Used to validate the *results* of globbing, which `resolveInJail` cannot
 * police because the glob walker itself follows `..` and symlinks.
 */
export function containedInJail(workdir: string, p: string, unsafe = false): boolean {
  if (unsafe) return true;
  const jail = resolveBestEffort(workdir);
  return isWithin(jail, resolveBestEffort(p));
}

/** Reject glob patterns that try to climb out or address an absolute path. */
export function safeGlobPattern(pattern: string): boolean {
  if (!pattern) return true;
  const p = pattern.replaceAll('\\', '/');
  if (p.startsWith('/') || p.startsWith('~')) return false;
  return !p.split('/').some((part) => part === '..');
}

/** Render *path* relative to *workdir* when possible, for compact output. */
export function displayPath(workdir: string, p: string): string {
  const jail = resolveBestEffort(workdir);
  const resolved = resolveBestEffort(p);
  if (isWithin(jail, resolved)) {
    const rel = path.relative(jail, resolved);
    return rel === '' ? '.' : rel;
  }
  return p;
}
