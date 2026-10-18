/**
 * crack.ts — `/crack`: offline password cracking, and the honest arithmetic it runs on.
 *
 * What this module is: the engine behind the /crack command (ported from
 * zimzilla/crack.py). Cracking is one sequential job that saturates every
 * core — the opposite shape of a wave campaign — so it is a command with a
 * playbook: it opens a case directory, hands the agent a briefing as one
 * turn, and the ordinary loop does the rest.
 *
 * Invariants: the time estimates are computed from REAL-run CPU throughput
 * (not `hashcat -b` benchmark numbers, which are 1.5x-11x optimistic — see
 * the RATES comment); the ladder is bounded by a wall-clock budget the
 * operator sets and `plan()` drops-and-names stages that do not fit; no
 * Ink/React imports — testable without a terminal, a model, or a network.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandTilde } from './shared.js';

// === SECTION === Hash modes ===

/**
 * The hashcat modes this command understands, and what each one is. The
 * second element is the equivalent john format, kept so the playbook can
 * offer the fallback when hashcat is absent, and so a report can name the
 * format in a way a reader who uses john recognises.
 *
 * Deliberately a curated list rather than hashcat's full 400+ modes. These are
 * the ones an engagement actually produces: the three Kerberos/Windows
 * families from `/ad` and `/net`, the unix crypt family from a shadow file,
 * the bare digests from a database dump, and WPA from a handshake.
 */
export const HASH_MODES: Readonly<Record<number, [string, string]>> = {
  0: ['MD5', 'raw-md5'],
  100: ['SHA1', 'raw-sha1'],
  500: ['md5crypt ($1$)', 'md5crypt'],
  1000: ['NTLM', 'nt'],
  1400: ['SHA256', 'raw-sha256'],
  1700: ['SHA512', 'raw-sha512'],
  1800: ['sha512crypt ($6$)', 'sha512crypt'],
  3200: ['bcrypt ($2a$)', 'bcrypt'],
  5500: ['NetNTLMv1', 'netntlm'],
  5600: ['NetNTLMv2', 'netntlmv2'],
  13100: ['Kerberos 5 TGS-REP (Kerberoast)', 'krb5tgs'],
  18200: ['Kerberos 5 AS-REP (AS-REP roast)', 'krb5asrep'],
  22000: ['WPA-PBKDF2-PMKID+EAPOL', 'wpapsk'],
};

/**
 * Signature regexes, checked in order, for when `hashcat --identify` is not
 * available or does not recognise a file. The `$...$` prefixes are hashcat's
 * own on-disk format and are unambiguous; the bare-digest rules are checked
 * last and keyed on the *length* of a hex line, which is the only thing that
 * separates a 32-character NTLM from an MD5.
 */
const SIGNATURES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\$krb5tgs\$/, 13100],
  [/^\$krb5asrep\$/, 18200],
  [/^[^:]+::[^:]+:[0-9a-fA-F]{16}:[0-9a-fA-F]{32}:/, 5600], // NetNTLMv2
  [/^[^:]+::[^:]+:[0-9a-fA-F]{48}:[0-9a-fA-F]{48}:/, 5500], // NetNTLMv1
  [/^\$1\$/, 500],
  [/^\$6\$/, 1800],
  [/^\$2[abxy]\$/, 3200],
  [/^WPA\*/, 22000],
];

/**
 * Hex-only line -> mode, by digest length. Ordered longest first so a 64-char
 * line is not mistaken for a prefix of a shorter rule.
 */
const HEX_LENGTHS: ReadonlyArray<readonly [number, number]> = [
  [128, 1700], // sha512
  [64, 1400], // sha256
  [40, 100], // sha1
  [32, 1000], // NTLM (also MD5's length — NTLM is the far more likely source)
];
const HEX_RE = /^[0-9a-fA-F]+$/;

/** Config surface this module needs (Config satisfies this structurally). */
export interface CrackConfig {
  stateDir: string;
}

export class Detected {
  /** One hash format found in a file, and how much of it is there. */
  constructor(
    public readonly mode: number,
    public readonly name: string,
    public readonly count: number,
    public readonly sample: string,
  ) {}

  get john(): string {
    return HASH_MODES[this.mode]?.[1] ?? '';
  }
}

/** The hashcat mode a single line looks like, or null. */
function lineMode(line0: string): number | null {
  const line = line0.trim();
  if (!line || line.startsWith('#')) return null;
  for (const [pattern, mode] of SIGNATURES) {
    if (pattern.test(line)) return mode;
  }
  // A bare hex digest, or the digest inside a dump line. `user:hash` and
  // `user:rid:lm:nt:::` are both common, and a pwdump line *ends* in colons —
  // so the tail after the last one is empty and checking only the tail finds
  // nothing. Every colon-separated field is tried instead, which catches the
  // bare digest, the `user:hash` pair and the pwdump line alike.
  for (const field of line.split(':')) {
    if (HEX_RE.test(field)) {
      for (const [length, mode] of HEX_LENGTHS) {
        if (field.length === length) return mode;
      }
    }
  }
  return null;
}

export function identifyText(text: string): Detected[] {
  /** Every hash format present in *text*, with counts, most-prevalent first.
   *
   * Pure, so the whole identification surface is testable by writing a file's
   * contents down — no hashcat, no disk. `identify` wraps this with the
   * `--identify` call for files whose format is not one of the signatures. */
  const counts = new Map<number, number>();
  const samples = new Map<number, string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const mode = lineMode(line);
    if (mode === null) continue;
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
    // A short, non-secret excerpt: enough to recognise the format in a
    // banner, never the whole hash. The `$...$` prefix is the tell.
    if (!samples.has(mode)) samples.set(mode, line.trim().slice(0, 60));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([m, c]) => new Detected(m, HASH_MODES[m]?.[0] ?? 'unknown', c, samples.get(m) ?? ''));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every file under *root*, recursively, sorted (Python `sorted(rglob)`). */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort();
}

export async function identify(target: string): Promise<Detected[]> {
  /** Identify every hash format in a file, or in every file under a directory.
   *
   * Signature matching first, because it is free and it is right for every
   * format an engagement actually produces. `hashcat --identify` is consulted
   * only when the signatures found nothing, since it is the slower path and
   * its output is a table to parse — but it is the honest fallback for a
   * format this module has never seen, and refusing to identify a hash
   * because it is unfamiliar would be the wrong way round. */
  const files = isDir(target) ? walkFiles(target) : [target];

  const found = new Map<number, Detected>();
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const d of identifyText(text)) {
      const prior = found.get(d.mode);
      if (prior === undefined) {
        found.set(d.mode, d);
      } else {
        found.set(d.mode, new Detected(d.mode, d.name, prior.count + d.count, prior.sample));
      }
    }
  }

  const byCount = (a: Detected, b: Detected) => b.count - a.count || a.mode - b.mode;
  if (found.size > 0) return [...found.values()].sort(byCount);

  // Nothing matched a signature. Ask hashcat, which knows formats this module
  // does not — and whose `--identify` output names the mode directly.
  for (const f of files) {
    const mode = await identifyViaHashcat(f);
    if (mode !== null) {
      found.set(
        mode,
        new Detected(mode, HASH_MODES[mode]?.[0] ?? `mode ${mode}`, 1, '(identified by hashcat)'),
      );
      break;
    }
  }
  return [...found.values()].sort(byCount);
}

function which(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const cand = path.join(dir, name);
    if (isFile(cand)) return cand;
  }
  return null;
}

interface Captured {
  code: number | null; // null = the process could not run / was killed
  stdout: string;
  stderr: string;
  // Node sets these on the timeout path: killed=true, signal='SIGTERM'. The
  // error message text is not stable across versions, so the timeout branch
  // below keys on these instead of matching a string.
  killed: boolean;
  signal: string | null;
  message?: string;
}

function runCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<Captured> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs, cwd: opts.cwd, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & {
            code?: unknown;
            killed?: boolean;
            signal?: string | null;
          };
          resolve({
            code: typeof e.code === 'number' ? e.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? (e as unknown as { stderr?: string }).stderr ?? '',
            killed: e.killed === true,
            signal: e.signal ?? null,
            message: e.message,
          });
        } else {
          resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '', killed: false, signal: null });
        }
      },
    );
  });
}

/** `hashcat --identify <file>`, reduced to the first mode it names. */
async function identifyViaHashcat(filePath: string): Promise<number | null> {
  const exe = which('hashcat');
  if (exe === null) return null;
  const res = await runCapture(exe, ['--identify', filePath, '--quiet'], {
    timeoutMs: 60_000,
  });
  // The table rows look like `  13100 | Kerberos 5, etype 23, TGS-REP | ...`.
  for (const line of (res.stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s*\|/);
    if (m) return parseInt(m[1] as string, 10);
  }
  return null;
}

// === SECTION === The ladder, and the arithmetic that bounds it ===

/**
 * Measured throughput per mode, in candidates per second, from a **real run**
 * on this host — a 4-core CPU with no GPU, through PoCL.
 *
 * Measured from actual `hashcat -m N -a 3 <hash> <mask> --runtime` runs, not
 * from `hashcat -b`. That distinction matters more than it looks: the
 * benchmark reports the kernel's best case, and a real run against a specific
 * salt with the default tuning is consistently slower — by 1.5x on NTLM and
 * by **11x on NetNTLMv2**. Planning from benchmark figures would tell an
 * operator a stage is affordable when it is not, which is the one way this
 * command actively misleads. So the table is real-run figures, and it is
 * deliberately pessimistic.
 *
 * A mode not listed falls back to `FALLBACK_RATE`, because over-estimating
 * the time is safe and under-estimating is what makes an operator start a run
 * they cannot finish.
 */
export const RATES: Readonly<Record<number, number>> = {
  0: 102e6,
  100: 83e6,
  500: 2.5e5,
  1000: 119e6,
  1400: 43e6,
  1700: 13e6,
  1800: 1.06e3,
  3200: 1.0e3,
  5500: 115e6,
  5600: 1.9e6,
  13100: 1.16e6,
  18200: 1.21e6,
  22000: 2e5,
};

/**
 * The rate used for a mode with no measured figure. Set to the slowest rate
 * this host has actually measured (bcrypt, ~1000 H/s), so an unknown mode is
 * planned conservatively rather than optimistically. Deliberately a literal
 * rather than `min(RATES)`: that would silently follow the table if someone
 * added an even slower mode, and the point of this constant is to be
 * pessimistic on purpose.
 *
 * The cost of being pessimistic is real but bounded — an unknown mode gets
 * stages dropped that might have fit — while the cost of being optimistic is
 * an operator starting a run measured in days. So it errs slow.
 */
export const FALLBACK_RATE = 1.0e3;

/**
 * Where wordlists and rules actually live on a Debian/Kali box. Named here
 * rather than inline in the ladder so the probe and the plan agree, and so a
 * host that keeps them elsewhere is one edit away.
 */
export const ROCKYOU = '/usr/share/wordlists/rockyou.txt';
/**
 * john ships best64 and hashcat can read it directly (`-r`), which is the
 * pragmatic choice: hashcat's own rules directory is not installed by every
 * package (it is absent on this host), and john's rule syntax is compatible.
 */
export const BEST64 = '/usr/share/john/rules/best64.rule';
export const ROCKYOU_30000 = '/usr/share/john/rules/rockyou-30000.rule';
export const JOHN_WORDLIST = '/usr/share/wordlists/john.lst';

export class Stage {
  /** One rung of the ladder: a method, its cost, and how to run it. */
  constructor(
    public readonly name: string,
    /**
     * Approximate candidates this stage will try, which is what the estimate
     * is computed from. Real, not decorative — rockyou is 14.3M lines and
     * best64 multiplies by its rule count.
     */
    public readonly candidates: number,
    /**
     * The hashcat *options*, minus the mode/hashfile/potfile the runner adds.
     */
    public readonly args: readonly string[] = [],
    /**
     * The positional argument that must come **after** the hashfile: the
     * wordlist for `-a 0`, or the mask for `-a 3`. hashcat parses positional
     * arguments in order, so a mask emitted before the hashfile is read *as*
     * the hashfile — which fails with "Separator unmatched" and cracks
     * nothing. Keeping this separate from `args` is what makes that ordering
     * impossible to get wrong.
     */
    public readonly positional: readonly string[] = [],
    /**
     * Every file this stage needs to exist, for the availability probe. A
     * mask needs nothing. This is about *availability*, not about the command
     * line — a rule stage needs both the wordlist and the rule, but only the
     * wordlist is positional.
     */
    public readonly needs: readonly string[] = [],
    /**
     * A ceiling on this stage's rate, for stages whose bottleneck is not the
     * hash. A rule stage generates 77 mutated candidates per word, and on a
     * *fast* hash that generator — not the hashing — is the bottleneck:
     * measured at 12-24 MH/s across modes, where NTLM's own rate is 119
     * MH/s. So a rule stage against a fast hash runs about five times slower
     * than its raw rate predicts. On a slow hash (Kerberos, ~1.2 MH/s) the
     * hashing still dominates and the ceiling never binds — which is why it
     * is a `min` rather than a multiplier.
     */
    public readonly ceiling: number | null = null,
    /**
     * Only offered with --deep. The stages that cost hours or days belong
     * behind an explicit flag, not in the default run.
     */
    public readonly deep = false,
  ) {}

  get available(): boolean {
    return this.needs.every((p) => isFile(p));
  }

  /** The first required file that is not there, for the drop reason. */
  get missing(): string {
    for (const p of this.needs) {
      if (!isFile(p)) return p;
    }
    return '';
  }
}

/**
 * rockyou's real line count, measured. Hard-coded rather than counted at run
 * time because reading a 140MB file to count lines, every time, to produce an
 * estimate that is approximate anyway, is the wrong trade.
 */
export const ROCKYOU_LINES = 14_344_392;
/** best64's rule count, same reasoning. */
export const BEST64_RULES = 77;
/** rockyou-30000's, same. */
export const ROCKYOU_30000_RULES = 30_000;

/**
 * The rate a rule stage tops out at, whatever the hash. Measured across
 * modes (best64 over rockyou): 24.0 MH/s on NTLM, 18.8 on MD5, 15.5 on SHA1,
 * 11.2 on SHA256, 2.6 on NetNTLMv2, 1.5 on Kerberos. The ceiling is the rule
 * generator — 77 mutated candidates per word — so it binds only where the
 * hash itself is faster than that. Set to the low end of the fast-mode range
 * so a rule stage is planned pessimistically; on slow modes the hash rate is
 * lower anyway and the ceiling never applies.
 */
export const RULE_CEILING = 12e6;

/**
 * The bounded escalation. Cheap and broad first, expensive and narrow last —
 * which is the order that cracks the most passwords for the least time, and
 * the order that makes the budget meaningful: a stage is worth running only
 * if the ones before it have had their turn.
 */
export const LADDER: readonly Stage[] = [
  new Stage('dictionary', ROCKYOU_LINES, ['-a', '0'], [ROCKYOU], [ROCKYOU]),
  new Stage(
    'dictionary + best64 rules',
    ROCKYOU_LINES * BEST64_RULES,
    ['-a', '0', '-r', BEST64],
    [ROCKYOU],
    [ROCKYOU, BEST64],
    RULE_CEILING,
  ),
  new Stage(
    // A corporate mask: an upper, five lowers, two digits — `Summer24`,
    // `Autumn99`. That is 26 * 26**5 * 100 = 30.9 billion candidates, which
    // is ~59s on an NTLM here and ~4.5h on a Kerberos hash — the same mask,
    // 275x apart, which is exactly the mode-dependent difference the
    // estimate exists to surface. Against Kerberos the budget drops it on its
    // own; the ladder does not need to know that, `plan` works it out.
    'targeted mask (?u?l?l?l?l?l?d?d)',
    26 * 26 ** 5 * 100,
    ['-a', '3'],
    ['?u?l?l?l?l?l?d?d'],
  ),
  new Stage(
    'dictionary + rockyou-30000 rules',
    ROCKYOU_LINES * ROCKYOU_30000_RULES,
    ['-a', '0', '-r', ROCKYOU_30000],
    [ROCKYOU],
    [ROCKYOU, ROCKYOU_30000],
    RULE_CEILING,
    true,
  ),
];

export function rateFor(mode: number, stage: Stage | null = null): number {
  /** Candidates per second for *mode*, or the conservative fallback.
   *
   * When *stage* is given and declares a `ceiling`, the effective rate is the
   * slower of the two: a stage can never run faster than either its hash or
   * its candidate generator. That is what keeps a rule stage against a fast
   * hash from being planned at five times the speed it will actually run. */
  const rate = RATES[mode] ?? FALLBACK_RATE;
  if (stage !== null && stage.ceiling !== null) {
    return Math.min(rate, stage.ceiling);
  }
  return rate;
}

/**
 * hashcat's fixed cost per invocation: process start, OpenCL context on the
 * CPU device, kernel build and autotune. Measured at ~2.8s on this host, and
 * it is *per stage* because each stage is a separate hashcat process.
 *
 * It matters more than it looks for the cheap stages: the dictionary against
 * a Kerberoast hash is ~12s of actual work, so ignoring startup would
 * understate the wall time by a fifth. And it is the honest reason a run of
 * four stages costs ten seconds before any cracking happens.
 */
export const HASHCAT_STARTUP = 2.8;

export function estimate(mode: number, stage: Stage): number {
  /** Seconds *stage* is expected to take against a single hash of *mode*.
   *
   * Pure arithmetic over the rate table plus hashcat's fixed startup, which
   * is the point: the number an operator reads in the banner is a function
   * of a measured rate, a stated candidate count and a measured overhead —
   * not a vibe. A wrong estimate here is the one thing in this command that
   * actively misleads, so it is asserted directly in the tests.
   *
   * Startup is included because each stage is its own hashcat process and the
   * cost is not negligible at this scale: a stage whose work is seconds is
   * dominated by it. */
  return HASHCAT_STARTUP + stage.candidates / rateFor(mode, stage);
}

export class PlannedStage {
  /** A stage together with the decision made about it. */
  constructor(
    public readonly stage: Stage,
    public readonly seconds: number,
    /**
     * False when the stage was dropped for exceeding the budget. Kept in the
     * plan rather than omitted, so the report can say "this was NOT run" — a
     * silent omission reads as "found nothing".
     */
    public readonly run: boolean,
    public readonly reason = '',
  ) {}
}

export function plan(mode: number, maxTime: number, opts: { deep?: boolean } = {}): PlannedStage[] {
  /** The stages to run, in order, each marked run or dropped.
   *
   * A stage that does not fit the *remaining* budget is dropped, and every
   * later stage with it — the ladder is an escalation, so running the mask
   * while skipping the dictionary would be a different and worse plan.
   * Dropping rather than truncating is deliberate: hashcat's `--runtime`
   * would cut a stage off mid-way, and a half-run rule stage is not a
   * smaller version of a run rule stage, it is an arbitrary prefix of the
   * wordlist. */
  const deep = opts.deep ?? false;
  const out: PlannedStage[] = [];
  let remaining = maxTime;
  for (const stage of LADDER) {
    const secs = estimate(mode, stage);
    if (stage.deep && !deep) {
      out.push(new PlannedStage(stage, secs, false, 'needs --deep (hours to days on this host)'));
      continue;
    }
    if (!stage.available) {
      out.push(new PlannedStage(stage, secs, false, `missing ${stage.missing}`));
      continue;
    }
    if (secs > remaining) {
      out.push(
        new PlannedStage(stage, secs, false, `exceeds the ${humanTime(remaining)} left`),
      );
      continue;
    }
    out.push(new PlannedStage(stage, secs, true));
    remaining -= secs;
  }
  return out;
}

export function humanTime(seconds: number): string {
  /** A duration a human reads at a glance. */
  if (seconds < 1) return '<1s';
  if (seconds < 90) return `${seconds.toFixed(0)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

// === SECTION === Running ===

/**
 * hashcat's exit codes, from its own `exit_status_code.txt`. The split that
 * matters is *stopped* versus *failed*: 0-5 all mean hashcat did what it was
 * asked and stopped for a reason, while a negative code is a real failure
 * (self-test, backend, kernel) that must be surfaced rather than read as
 * "found nothing".
 *
 * 4 in particular is not an error and not an edge case — it is what a
 * *bounded* run returns. `--runtime` elapsed, hashcat aborted cleanly, and
 * the budget worked. Treating it as a failure would make every
 * correctly-capped stage look broken, which is the whole reason this table is
 * written out rather than inferred from 0/1.
 */
export const EXIT_CRACKED = 0; // OK/cracked
export const EXIT_EXHAUSTED = 1; // exhausted — the keyspace ran out, nothing more to try
export const EXIT_ABORTED = 2; // aborted
export const EXIT_CHECKPOINT = 3; // aborted by checkpoint
export const EXIT_RUNTIME = 4; // aborted by runtime — the budget did its job
export const EXIT_FINISH = 5; // aborted by finish

/**
 * Every code that means "hashcat ran and stopped", i.e. not a failure. A
 * caller checks `STOPPED.has(code)` rather than enumerating, so a future
 * hashcat that adds a sixth stop code does not silently become an error here.
 */
export const STOPPED: ReadonlySet<number> = new Set<number>([
  EXIT_CRACKED,
  EXIT_EXHAUSTED,
  EXIT_ABORTED,
  EXIT_CHECKPOINT,
  EXIT_RUNTIME,
  EXIT_FINISH,
]);

export function exitMeaning(code: number): string {
  /** A phrase for a hashcat exit code, for the banner and the report. */
  const meanings: Record<number, string> = {
    [EXIT_CRACKED]: 'cracked',
    [EXIT_EXHAUSTED]: 'exhausted',
    [EXIT_ABORTED]: 'aborted',
    [EXIT_CHECKPOINT]: 'aborted by checkpoint',
    [EXIT_RUNTIME]: 'aborted by runtime (the budget was reached)',
    [EXIT_FINISH]: 'aborted by finish',
  };
  return meanings[code] ?? `hashcat failed (exit ${code})`;
}

/**
 * hashcat allows exactly one instance at a time — a second refuses to start
 * with "Already an instance ... running on pid N" and exit 255. Verified on
 * this box, reproducibly. It is worth naming because it is an *operational*
 * hazard rather than a bug: an operator with a hashcat already running (or a
 * `/crack` turn that overlapped another) gets a 255 that would otherwise read
 * as "hashcat is broken", and the fix is to wait, not to debug.
 */
export const INSTANCE_BUSY = /already an instance/i;

export function instanceBusy(output: string): boolean {
  /** True when hashcat refused to start because another instance holds it. */
  return INSTANCE_BUSY.test(output || '');
}

export function hashcatArgv(
  hashfile: string,
  mode: number,
  stage: Stage,
  potfile: string,
  runtime: number,
  hashcat = 'hashcat',
): string[] {
  /** The command line for one stage. Separate from `runStage` so it is
   * assertable without running anything — the argument order is exactly where
   * a rule file gets mistaken for a wordlist, and where a mask ends up in the
   * hashfile's position.
   *
   * hashcat's positional order is `<hashfile> [wordlist|mask]`. Options may
   * appear anywhere; the two positionals may not. So the stage's `args` go
   * before the hashfile and its `positional` after — the one arrangement that
   * cannot misparse. */
  return [
    hashcat,
    '-m',
    String(mode),
    ...stage.args,
    hashfile,
    ...stage.positional,
    '--potfile-path',
    potfile,
    '--runtime',
    String(Math.trunc(runtime)),
    '--quiet',
    '--force',
  ];
}

export async function runStage(
  hashfile: string,
  mode: number,
  stage: Stage,
  potfile: string,
  opts: { runtime: number; workdir?: string; hashcat?: string },
): Promise<[number, string]> {
  /** Run one stage against *hashfile*. Returns `[exitCode, combinedOutput]`.
   *
   * `--runtime` bounds the stage in wall-clock seconds, which is what makes
   * the budget real rather than advisory: a stage that turns out slower than
   * its estimate is cut off by hashcat itself rather than running on.
   * `--status-json` is not used here — this is the synchronous path the
   * tests drive — but the playbook asks the agent to add it so a long run
   * reports progress.
   *
   * The potfile is passed explicitly on every call. Without it hashcat writes
   * to its own default, which is shared with the operator's other hashcat
   * work and is not this campaign's to touch. */
  const hashcat = opts.hashcat ?? 'hashcat';
  const argv = hashcatArgv(hashfile, mode, stage, potfile, opts.runtime, hashcat);
  const res = await runCapture(hashcat, argv.slice(1), {
    timeoutMs: (opts.runtime + 60) * 1000,
    cwd: opts.workdir,
  });
  if (res.code === null) {
    if (res.killed) {
      // Python TimeoutExpired: the stage outlived even its +60s grace —
      // Node reports the kill as killed+signal with code unset.
      return [EXIT_ABORTED, res.stdout + res.stderr];
    }
    return [255, `could not run hashcat: ${res.message ?? 'spawn failed'}`];
  }
  // Python concatenates stdout + stderr; hashcat writes progress and errors
  // to stderr, so dropping it would hide exactly what the caller shows.
  return [res.code, res.stdout + res.stderr];
}

export async function recovered(
  hashfile: string,
  mode: number,
  potfile: string,
  hashcat = 'hashcat',
): Promise<Array<[string, string]>> {
  /** `[(hash, plaintext)]` for every hash in *hashfile* that is cracked.
   *
   * Read from `hashcat --show`, which is the only correct way to ask — the
   * potfile holds hashes from *every* run that has ever used it, so reading
   * it directly would attribute another run's cracks to this one. */
  const res = await runCapture(
    hashcat,
    [
      '-m',
      String(mode),
      hashfile,
      '--potfile-path',
      potfile,
      '--show',
      '--quiet',
    ],
    { timeoutMs: 120_000 },
  );
  if (res.code === null) {
    // Spawn failure or timeout — Python returns [] for both.
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const line of (res.stdout + res.stderr).split('\n')) {
    // `--show` prints `hash:plaintext`, and the hash itself contains colons,
    // so the split is on the LAST one (rpartition).
    const idx = line.lastIndexOf(':');
    if (idx !== -1) {
      out.push([line.slice(0, idx).trim(), line.slice(idx + 1)]);
    }
  }
  return out;
}

// === SECTION === Case directory ===

const SLUG_RE = /[^a-zA-Z0-9._-]+/g;

export function caseSlug(target: string): string {
  /** A filesystem-safe, recognisable label. */
  const s = String(target).trim().replace(SLUG_RE, '-').replace(/^[.-]+|[.-]+$/g, '');
  return (s.slice(0, 64) || 'hashes').toLowerCase();
}

/** `YYYYmmdd-HHMMSS` in local time (matches Python time.strftime). */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function caseDir(cfg: CrackConfig, target: string): string {
  /** Create and return this run's directory.
   *
   * `<stateDir>/crack/<slug>-<stamp>/` — beside the osint cases and the hunt
   * campaigns, under stateDir so evidence lands with the sessions rather
   * than in whatever repo the operator happens to be in. */
  const stamp = localStamp();
  const d = path.join(cfg.stateDir, 'crack', `${caseSlug(target)}-${stamp}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function potfile(cfg: CrackConfig): string {
  /** The potfile every `/crack` run shares.
   *
   * Shared across runs on purpose: cracking is multi-session. A hash that did
   * not fall in ten minutes may fall tomorrow with a bigger rule, and a run
   * that redid the work it already did would be wasting the operator's time.
   * One potfile per stateDir means a re-run picks up exactly where the last
   * left off — and keeping it here rather than at hashcat's own default path
   * means `/crack` never writes to the operator's global hashcat state. */
  const d = path.join(cfg.stateDir, 'crack');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, 'crack.potfile');
}

export function reportsDir(cfg: CrackConfig): string {
  /** Where finished reports are kept, beside the osint and hunt ones. */
  return path.join(cfg.stateDir, 'reports');
}

export function finaliseCase(cfg: CrackConfig, casePath: string): string | null {
  /** Archive the case's report into the flat report store.
   *
   * Unlike `/osint`, the case directory is **not** deleted — the hash copy
   * and the potfile are the evidence, and a potfile that vanished with the
   * case would make the next run redo work. Only the report is copied out,
   * which is what outlives the case.
   *
   * Returns null when there is no report: a run that failed or was
   * interrupted keeps everything for inspection, exactly as osint's contract
   * has it. */
  let report = path.join(casePath, 'report.md');
  if (!isFile(report)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(casePath);
    } catch {
      names = [];
    }
    const candidates = names
      .filter((n) => n.toLowerCase().includes('report') && n.toLowerCase().endsWith('.md'))
      .sort();
    report = candidates.length > 0 ? path.join(casePath, candidates[0] as string) : '';
  }
  if (!report || !isFile(report)) return null;
  const destDir = reportsDir(cfg);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${path.basename(casePath)}.md`);
    fs.copyFileSync(report, dest);
    return dest;
  } catch {
    return null;
  }
}

// === SECTION === Target ===

export function validatePath(raw: string): [string | null, string] {
  /** Resolve the operator's argument to an existing file or directory.
   *
   * A path, not a hash and not a sentence. Typing the hash inline is a
   * tempting mistake — it is what every hashcat tutorial shows — but the hash
   * then lives in the shell history and the transcript, and a run needs it on
   * disk anyway so a second attempt can reuse it. So the argument is a path
   * and the error says so. */
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return [null, 'no path given — point /crack at a hash file or directory'];
  }
  const p = expandTilde(trimmed);
  if (!fs.existsSync(p)) {
    if (/^\$?\w+\$/.test(trimmed) || trimmed.includes(':')) {
      return [
        null,
        `${trimmed.slice(0, 40)}… looks like a hash, not a path. Write it to ` +
          'a file first — it stays out of your shell history and a second ' +
          'run can reuse it',
      ];
    }
    return [null, `no such file or directory: ${p}`];
  }
  return [p, ''];
}

// === SECTION === The playbook ===

// NOTE: the trailing `\` line-continuations in the hashcat examples are
// literal Python string continuations in the original — they join the lines
// without a newline. The TS template literal reproduces that exactly (a `\`
// before a newline in a template literal is also a continuation), so the
// prompt bytes match the Python output.
export const PLAYBOOK = `\
Crack the password hashes in {source} and report what they reveal.

CASE DIRECTORY: {case_dir}
HASH COPY:     {hash_copy}
POTFILE:       {potfile}
BUDGET:        {budget}
FORMATS FOUND: {formats}

This host has NO GPU. Every figure below is CPU throughput, measured from real
runs, and it is the number that decides what is worth trying. Kerberos hashes
(13100, 18200) run at about 1.2 MH/s here — roughly 100x slower than NTLM — so a
rule set that takes seconds against an NTLM takes minutes against a Kerberoast,
and the biggest community rule sets take days. Do not start something you cannot
finish.

METHOD — work the ladder in order, stopping when the budget is spent:

1. Identify and confirm the mode before running anything:
     hashcat --identify {hash_copy}
   The mode numbers matter — 13100 is Kerberoast, 18200 is AS-REP, 5600 is
   NetNTLMv2, 1000 is NTLM. Using the wrong one wastes the whole budget.

2. Stage 1 — the dictionary. Fast, broad, and it cracks more real passwords than
   anything else:
     hashcat -m <mode> -a 0 {hash_copy} /usr/share/wordlists/rockyou.txt \
       --potfile-path {potfile} --runtime <seconds> --status --status-json

3. Stage 2 — the same dictionary with rules, which is where corporate passwords
   actually fall (\`Password1!\`, \`Summer2024\`):
     hashcat -m <mode> -a 0 {hash_copy} /usr/share/wordlists/rockyou.txt \
       -r /usr/share/john/rules/best64.rule \
       --potfile-path {potfile} --runtime <seconds>

4. Stage 3 — only if the budget allows and the mode is fast enough: a targeted
   mask for the organisation's naming convention (\`?u?l?l?l?l?l?d?d\` matches
   \`Summer24\`). Check the estimate before starting. It is 30.9 billion
   candidates: ~4.3 minutes against an NTLM here, and ~7 HOURS against a
   Kerberos hash. The same mask. Do not start it on a Kerberos hash without
   meaning to.

Always pass \`--potfile-path {potfile}\`. It is shared between runs deliberately:
a hash that did not fall today may fall tomorrow with a bigger rule, and redoing
work already done wastes the operator's time. Always pass \`--runtime\` so a stage
cannot overrun the budget. Read progress with \`--status-json\` rather than
polling, and check results with:

     hashcat -m <mode> {hash_copy} --potfile-path {potfile} --show

ONE INSTANCE AT A TIME. hashcat refuses to start a second copy — it exits 255
with "Already an instance ... running on pid N". If you see that, another hashcat
(possibly a \`/crack\` turn, possibly the operator's own) is running: **wait for it
to finish and retry**, do not treat it as a failure and do not kill it. Check
with \`pgrep -a hashcat\` before starting a long stage. Exit code 4 is not an error
either — it means \`--runtime\` elapsed and the stage stopped at its budget, which
is the bound working.

ANALYSIS — this is the part that is worth more than the cracks
-------------------------------------------------------------
A recovered password is not the finding. The finding is what it says about the
organisation's password policy, and that is what the report has to argue:

- **Crack rate.** How many of how many fell to a plain dictionary? A high rate
  means the policy permits common passwords and the estate is one breach-dump
  away from compromise.
- **Patterns.** If several passwords are \`Season+Year\` or \`Word+digits\`, the
  policy is being satisfied in letter and defeated in spirit — say so, with the
  examples, and say what a length-based policy would have done instead.
- **Reuse and relationship.** A service account whose password is the company
  name plus a year is a different finding from a user's \`Password1\`. Name which
  accounts fell and what each one grants.
- **What did NOT crack, and what that means.** A hash that survived a full
  dictionary and a rule set is evidence the policy is working somewhere. Report
  it as a positive, not as a gap.

Write the report to \`{case_dir}/report.md\`:

    # Password cracking — <source>
    ## Headline          — the crack rate and the single most important pattern
    ## What was cracked  — per hash: the account it belongs to, the plaintext,
                            and the stage that recovered it
    ## What it means     — the policy finding, argued from the patterns above
    ## What did not crack— the survivors, and what their survival shows
    ## Method            — modes, wordlists, rules, and the time each stage took

Report the plaintexts. This is an authorised engagement and the recovered
credentials are the deliverable; redacting them makes the report useless to the
operator who has to remediate. But be precise about the account each one belongs
to — a cracked service account and a cracked helpdesk account are different
findings and must not be merged.

Authorised use only: hashes you are entitled to test — your own estate, a
consented audit, or a declared engagement.
`;

export function buildPrompt(
  cfg: CrackConfig,
  source: string,
  casePath: string,
  detected: Detected[],
  budget: number,
): string {
  /** The turn the agent actually runs.
   *
   * The formats and the budget are interpolated rather than left for the
   * agent to work out, because both are facts this module already knows and
   * asking a model to rediscover them is asking it to guess. The mode list
   * in particular: an agent that picks 1000 for a Kerberoast hash burns the
   * entire budget on a mode that cannot match. */
  let formats: string;
  if (detected.length > 0) {
    formats = detected
      .map((d) => `${d.name} (mode ${d.mode}, ${d.count} hash${d.count !== 1 ? 'es' : ''})`)
      .join(', ');
  } else {
    formats =
      '(none recognised by signature — run `hashcat --identify` on ' +
      'the hash copy to establish the mode)';
  }
  return PLAYBOOK.replaceAll('{source}', source)
    .replaceAll('{case_dir}', casePath)
    .replaceAll('{hash_copy}', path.join(casePath, 'hashes.txt'))
    .replaceAll('{potfile}', potfile(cfg))
    .replaceAll('{budget}', humanTime(budget))
    .replaceAll('{formats}', formats);
}
