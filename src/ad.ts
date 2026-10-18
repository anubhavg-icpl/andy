/**
 * `/ad` — an Active Directory campaign doctrine, and the interlock that keeps
 * it safe (port of `zimzilla/ad.py`).
 *
 * What this module is: the four AD prompt templates, the fixed unauthenticated
 * fallback vector matrix, the host tooling probe, and `makeInterlock()` — the
 * tier-2 gate for AD commands (one shared token bucket + one hard attempt
 * counter + a circuit breaker at lockout − 1) installed on every agent in a
 * wave.
 *
 * Invariants:
 *  - `inspect()` is a pure function of the command string (no state, no I/O,
 *    no network) so the whole safety surface is testable without a campaign.
 *  - A read never spends budget; a destructive command is refused *before* the
 *    budget; the breaker trips at `lockout - 1`, never `lockout`.
 *  - No TUI, no colours — the same split as `./osint.ts` and `./phish.ts`.
 *
 * Sections: Target · Tooling probe · The interlock · Vectors · Prompts ·
 * The doctrine.
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';
import type { ToolHook } from './shared.js';
import type { CampaignKind } from './hunt.js';

// === SECTION === Target

// One DNS label: letters, digits, inner hyphens. Not a full RFC 1035
// implementation — the job is to catch an empty argument, a sentence typed into
// the wrong field, or a URL pasted where a domain belongs.
const _LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const _DOMAIN_RE = new RegExp(`^${_LABEL}(?:\\.${_LABEL})+$`);
const _IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Python `repr()` for the error messages: single quotes unless the string
 * itself contains one. The messages quote the operator's input back at them
 * and the quoting style is part of the string the tests pin.
 */
function _pyRepr(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `'${s.replace(/'/g, "\\'")}'`;
}

/**
 * Normalise and check an AD target, or throw (ValueError in the Python
 * original — a plain Error here).
 *
 * A domain, not a URL and not a sentence. The distinction matters beyond
 * tidiness: the scope deny-list is written in domains, the campaign directory
 * is named after this string, and an operator who passes
 * `https://dc01.corp.local/owa` would get a campaign for a name no rule in
 * `allow.yaml` can match.
 */
export function validateTarget(raw: string): string {
  const t0 = (raw ?? '').trim().replace(/\/+$/, '');
  if (!t0) {
    throw new Error('no target — give the domain, e.g. /ad corp.local');
  }
  if (t0.includes('://')) {
    // Python: t.split('://', 1)[1].split('/', 1)[0].split(':', 1)[0] — the
    // host out of the URL, offered back as the domain they meant to type.
    const rest = t0.slice(t0.indexOf('://') + 3);
    const host = rest.split('/')[0]!.split(':')[0]!;
    throw new Error(
      `${_pyRepr(raw)} is a URL. /ad takes the DOMAIN, not a host or a URL — ` +
        `try ${_pyRepr(host)}`,
    );
  }
  if (t0.includes('/') || t0.includes('\\') || /\s/.test(t0)) {
    throw new Error(
      `${_pyRepr(raw)} is not a domain name. Give the AD domain on its own, ` +
        'e.g. corp.local',
    );
  }
  const t = t0.toLowerCase().replace(/\.+$/, '');
  if (_IPV4_RE.test(t)) {
    // An address is a domain controller, not a domain. Allowed — an operator
    // pointing at a lab box knows what they mean — but the deny-list is
    // written in domains, so the scope guard will not be able to see it.
    return t;
  }
  if (!_DOMAIN_RE.test(t) || t.length > 253) {
    throw new Error(
      `${_pyRepr(raw)} does not look like an AD domain. Expected a dotted name ` +
        'such as corp.local or ad.internal',
    );
  }
  return t;
}

/**
 * The exact string the operator must type back to arm the command.
 *
 * Typing the domain is the gate. It is not a security control and is not
 * pretending to be one — it is a speed bump that makes "I am about to run
 * credential attacks against this specific domain" a thing the operator had
 * to *say*, rather than a thing that happened because they typed `/ad` and hit
 * enter. A wrong ack is refused, so the domain cannot be reached by a typo in
 * the target field either.
 */
export function ackPhrase(domain: string): string {
  return validateTarget(domain);
}

/** The line to run, verbatim, when the gate was not passed. */
export function refusal(domain: string): string {
  return `/ad ${domain} --ack ${domain}`;
}

// === SECTION === Tooling probe

/**
 * The toolchain this doctrine knows how to use, and what each one is for.
 * `(name, install hint, vector)` — one place, so `probeTools` and `inspect`
 * can never disagree about what counts as an AD tool.
 *
 * The hints name Debian/Kali packages because that is what this box is; on
 * another distribution the hint is still the right search term.
 */
const _TOOL_CATALOGUE: ReadonlyArray<readonly [string, string, string]> = [
  // --- impacket, the workhorse set. Present on a stock Kali.
  ['GetNPUsers.py', 'impacket-scripts', 'asrep-roast'],
  ['GetUserSPNs.py', 'impacket-scripts', 'kerberoast'],
  ['GetADUsers.py', 'impacket-scripts', 'user-enum'],
  ['secretsdump.py', 'impacket-scripts', 'dcsync-rights'],
  ['lookupsid.py', 'impacket-scripts', 'user-enum'],
  ['samrdump.py', 'impacket-scripts', 'user-enum'],
  ['rpcdump.py', 'impacket-scripts', 'domain-enum'],
  ['reg.py', 'impacket-scripts', 'laps-read'],
  ['psexec.py', 'impacket-scripts', 'host-sprawl'],
  ['wmiexec.py', 'impacket-scripts', 'host-sprawl'],
  ['smbexec.py', 'impacket-scripts', 'host-sprawl'],
  ['atexec.py', 'impacket-scripts', 'scheduled-tasks'],
  ['dcomexec.py', 'impacket-scripts', 'host-sprawl'],
  ['mssqlclient.py', 'impacket-scripts', 'host-sprawl'],
  ['ntlmrelayx.py', 'impacket-scripts', 'relay'],
  ['addcomputer.py', 'impacket-scripts', 'acl-paths'],
  // --- SMB and RPC, from samba-common-bin / smbclient.
  ['smbclient', 'smbclient', 'gpp-cpassword'],
  ['rpcclient', 'smbclient', 'null-session'],
  ['smbmap', 'smbmap', 'gpp-cpassword'],
  ['enum4linux-ng', 'enum4linux-ng', 'null-session'],
  // --- the modern enumeration and ADCS tooling.
  ['nxc', 'netexec', 'smb-signing'],
  ['certipy', 'certipy-ad', 'adcs-enroll'],
  ['bloodhound-python', 'bloodhound.py', 'acl-paths'],
  ['rusthound', 'rusthound-ce', 'acl-paths'],
  ['windapsearch', 'windapsearch', 'ldap-anon'],
  ['ldapsearch', 'ldap-utils', 'ldap-anon'],
  ['gpp-decrypt', 'gpp-decrypt', 'gpp-cpassword'],
  ['kerbrute', 'kerbrute', 'user-enum'],
  // --- coercion, relay and offline cracking.
  ['mitm6', 'mitm6', 'coercion'],
  ['responder', 'responder', 'coercion'],
  ['hashcat', 'hashcat', 'kerberoast'],
  ['john', 'john', 'kerberoast'],
  // --- transport. Always worth knowing whether these are there, because a
  //     domain that does not resolve is a domain nothing else can reach.
  ['nmap', 'nmap', 'smb-signing'],
  ['dig', 'dnsutils', 'domain-enum'],
  ['nslookup', 'dnsutils', 'domain-enum'],
  ['openssl', 'openssl', 'adcs-enroll'],
];

/**
 * Vector -> the tools it needs. Derived, never hand-written, so the two cannot
 * drift. A vector whose tools are all absent is out of scope for this run, and
 * the recon prompt says so by name rather than letting a wave spend ten agents
 * rediscovering it.
 */
export const VECTOR_TOOLS: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [n, , v] of _TOOL_CATALOGUE) {
    const list = m.get(v) ?? [];
    list.push(n);
    m.set(v, list);
  }
  return m;
})();

/**
 * Tools whose entire purpose is guessing a credential. They are the highest
 * lockout risk on the box, so they are named as tools the interlock inspects —
 * a `hydra` that went unrecognised would be the one command that matters
 * slipping through. Kept out of `_TOOL_CATALOGUE` because they are not part of
 * the AD toolchain the probe reports on: nothing about `hydra` tells the
 * operator whether this domain is weak.
 */
const _SPRAY_TOOLS: ReadonlySet<string> = new Set([
  'hydra',
  'medusa',
  'patator',
  'ncrack',
  'crowbar',
  'spray',
  'sprayhound',
]);

/**
 * The SMB swiss-army knives, by every name they ship under. `crackmapexec` is
 * the old name, `nxc`/`netexec` the current ones, and they are the single most
 * likely tool for an agent to reach for when it decides to spray — so all three
 * have to be recognised, not just the one the probe happens to find.
 */
const _C2_ALIASES: readonly string[] = ['crackmapexec', 'cme', 'nxc', 'netexec'];

/**
 * Every name the interlock treats as AD tooling. A command naming none of these
 * is not inspected at all — `ls`, `cat` and a wordlist grep are not credential
 * attempts and must not burn the budget.
 */
export const AD_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ..._TOOL_CATALOGUE.map(([n]) => n),
  ..._SPRAY_TOOLS,
  ..._C2_ALIASES,
]);

/**
 * Tools that never submit a credential, whatever their flags. A port scanner, a
 * resolver, an offline cracker, a TLS client and a cpassword decoder do not
 * authenticate to anything — so `nmap --script smb2-security-mode` is a read and
 * must not spend the budget. Checked before the conservative default, which
 * would otherwise count every one of them.
 *
 * The exception is a spray run through one of them — `nmap --script smb-brute`
 * guesses passwords as surely as hydra does — so the spray marker is tested
 * first and wins.
 *
 * `enum4linux-ng` and `bloodhound-python` are here for the same reason as the
 * scanner: their whole job is to *collect* what the domain will hand an
 * anonymous caller. They have no password flag to carry one, so a command that
 * names them is enumeration, and counting it would spend the campaign's budget
 * on the one family of work that cannot lock an account.
 */
const _NO_AUTH_TOOLS: ReadonlySet<string> = new Set([
  'nmap',
  'dig',
  'nslookup',
  'host',
  'openssl',
  'hashcat',
  'john',
  'gpp-decrypt',
  'enum4linux-ng',
  'enum4linux',
  'bloodhound-python',
]);

/** One tool, and whether this host actually has it. */
export class ToolProbe {
  constructor(
    public readonly name: string,
    public readonly path: string | null,
    public readonly hint: string,
    public readonly vector: string,
  ) {}

  get present(): boolean {
    return this.path !== null;
  }
}

/**
 * `shutil.which`, POSIX shape: resolve `name` against each PATH entry and
 * return the first entry that exists, is executable and is not a directory —
 * the last because a PATH dir would otherwise "resolve" every name to itself.
 * A raw PATH scan rather than an import or a child process, because half of
 * these are scripts with no package to import and the question is whether the
 * *command* resolves.
 */
function _which(name: string): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    const candidate = pathJoin(dir, name);
    try {
      if (statSync(candidate).isDirectory()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not present / not executable — keep scanning
    }
  }
  return null;
}

/**
 * Find out what is installed, once, before any brief is written.
 *
 * A brief that sends an agent after a binary that is not on the box wastes the
 * agent entirely, and ten agents each discovering that for themselves wastes
 * the wave. So the probe runs here, its result is written into the recon
 * prompt, and every vector whose tooling is missing is named as out of scope.
 */
export function probeTools(): ToolProbe[] {
  return _TOOL_CATALOGUE.map(
    ([n, h, v]) => new ToolProbe(n, _which(n), h, v),
  );
}

/** The probe result as the recon prompt wants it: present, then missing. */
export function renderTools(probes: ToolProbe[]): string {
  const have = probes.filter((p) => p.present);
  const missing = probes.filter((p) => !p.present);
  const lines = [
    'PRESENT on this host — use these:',
    '  ' + (have.map((p) => p.name).join(', ') || '(none of them)'),
    '',
    'ABSENT — a vector that needs one of these is OUT OF SCOPE for this run.',
    'Do not write a brief around a tool in this list, and do not spend a turn',
    'installing it. Say the vector was skipped for missing tooling instead:',
  ];
  for (const p of missing) {
    lines.push(`  ${p.name.padEnd(20)} would need: ${p.hint}`);
  }
  return lines.join('\n');
}

/**
 * What the interlock made of one command.
 *
 * Pure data, and immutable, so `inspect` is a function of its argument alone
 * and every rule in it can be asserted by writing a command down.
 */
export class Verdict {
  /** The command submits something that can be *wrong*, which is the only
   *  thing that locks an account. Conservative: see `inspect`. */
  readonly credential: boolean;
  /** The command changes the directory rather than reading it. Refused
   *  outright unless the operator armed the run. */
  readonly destructive: boolean;
  /** The AD tool the command names, or "". Empty means nothing here is AD
   *  tooling and the interlock leaves the call alone entirely. */
  readonly tool: string;
  readonly reason: string;

  constructor(
    fields: {
      credential?: boolean;
      destructive?: boolean;
      tool?: string;
      reason?: string;
    } = {},
  ) {
    this.credential = fields.credential ?? false;
    this.destructive = fields.destructive ?? false;
    this.tool = fields.tool ?? '';
    this.reason = fields.reason ?? '';
  }

  /** Whether the interlock has any business with this command. */
  get relevant(): boolean {
    return this.tool !== '';
  }
}

/**
 * Vectors whose every tool is missing — skipped, and named as skipped.
 *
 * "Every" rather than "any": most vectors have a fallback. A vector with one
 * tool present is runnable with a worse method, and degrading to it is the
 * point of the probe. Only a vector with nothing left to run is out.
 */
export function unavailableVectors(probes: ToolProbe[]): string[] {
  const present = new Set(
    probes.filter((p) => p.present).map((p) => p.name),
  );
  return [...VECTOR_TOOLS.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, tools]) => tools.length > 0 && !tools.some((t) => present.has(t)))
    .map(([vector]) => vector);
}

// === SECTION === The interlock

/**
 * A tool call the interlock refused.
 *
 * A plain Error on purpose (RuntimeError in the Python original). The agent
 * loop already wraps every tool call in a catch and turns the exception into
 * an `isError` ToolResult carrying the message, so throwing this is all it
 * takes for the agent to *read why* it was refused and adapt — and for the run
 * to continue rather than die. No new plumbing in the agent loop.
 */
export class InterlockRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterlockRefusal';
  }
}

/** Monotonic clock in seconds — the unit every rate/delay here is stated in. */
function _now(): number {
  return performance.now() / 1000;
}

function _sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * A promise-chain mutex standing in for `asyncio.Lock`: each `run` waits on the
 * previous one, and a rejection inside the critical section never poisons the
 * chain for the callers queued behind it.
 */
class _Mutex {
  private _tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._tail.then(fn);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * A shared token bucket. One instance per campaign, not per agent.
 *
 * Ten parallel agents sharing one bucket is the whole point: a per-agent
 * throttle is ten times the rate the operator agreed to. The bucket refills at
 * `rate` tokens per second up to `burst`, and a caller that arrives to an
 * empty bucket waits — inside the lock, so the wait is served in arrival order
 * and a burst of ten agents becomes a queue rather than a stampede.
 *
 * `rate <= 0` disables throttling entirely and every acquire returns at once.
 * That is the honest meaning of "no throttle", and it is what the tests use so
 * they are not paying real seconds for arithmetic they can check directly.
 */
export class Throttle {
  readonly rate: number;
  readonly burst: number;
  /** How many calls actually had to wait, and for how long in total. Read by
   *  the tests, and by the closing report when it wants to say how hard the
   *  throttle bit. */
  waited = 0;
  slept = 0.0;
  private _tokens: number;
  private _stamp: number;
  private _lock = new _Mutex();

  constructor(rate: number = DEFAULT_RATE, burst: number = DEFAULT_BURST) {
    this.rate = Math.max(0.0, rate);
    this.burst = Math.max(1, Math.trunc(burst));
    this._tokens = this.burst;
    this._stamp = _now();
  }

  /** Tokens available right now, refilled to this instant. */
  get tokens(): number {
    if (this.rate <= 0) return this.burst;
    return Math.min(
      this.burst,
      this._tokens + (_now() - this._stamp) * this.rate,
    );
  }

  /** Take one token, waiting if the bucket is empty. Returns the wait. */
  async acquire(): Promise<number> {
    if (this.rate <= 0) return 0.0;
    return this._lock.run(() => this._take());
  }

  private async _take(): Promise<number> {
    const now = _now();
    this._tokens = Math.min(
      this.burst,
      this._tokens + (now - this._stamp) * this.rate,
    );
    this._stamp = now;
    if (this._tokens >= 1.0) {
      this._tokens -= 1.0;
      return 0.0;
    }
    const delay = (1.0 - this._tokens) / this.rate;
    this.waited += 1;
    this.slept += delay;
    await _sleep(delay); // inside the lock: waits are served in arrival order
    this._tokens = 0.0;
    this._stamp = _now();
    return delay;
  }
}

/**
 * The circuit breaker. Counts credential attempts, then refuses.
 *
 * The ceiling is `lockout - 1`, and that is the entire design. An operator who
 * says the domain locks accounts after five bad passwords is saying they can
 * afford four. So four are allowed and the fifth is refused — before it runs,
 * not after — and once tripped *every* subsequent credential-bearing command in
 * the campaign is refused, because a wave that has already walked into the
 * threshold has no business trying a sixth account.
 *
 * Nothing here counts reads. A null session, an anonymous bind, a DNS query
 * and an SMB signature check are not credential attempts and must not consume
 * the budget, or the breaker would trip on reconnaissance.
 */
export class AttemptBudget {
  readonly lockout: number;
  /** Attempts permitted before the refusal. Never below one: a lockout of 1
   *  means the first wrong password locks the account, so zero attempts are
   *  affordable — but a budget that permits nothing makes the command useless,
   *  and refusing to run at all is the operator's call, not this class's. It
   *  is reported loudly in the banner instead. */
  readonly limit: number;
  spent = 0;
  tripped = false;
  /** The commands that spent the budget, for the report. Bounded, because a
   *  long campaign should not grow this without limit. */
  history: string[] = [];

  constructor(lockout: number = DEFAULT_LOCKOUT) {
    this.lockout = Math.max(1, Math.trunc(lockout));
    this.limit = Math.max(1, this.lockout - 1);
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  /**
   * Consume one attempt, or throw `InterlockRefusal`.
   *
   * Throws *before* incrementing past the limit, so `spent` never exceeds
   * `limit` and the reported count is always the number of attempts that
   * actually ran.
   */
  spend(command: string = ''): void {
    if (this.tripped) {
      throw new InterlockRefusal(
        `BLOCKED — the attempt budget is spent. ${this.limit} of ` +
          `${this.limit} permitted credential attempts have run against a ` +
          `domain that locks at ${this.lockout}, so the campaign is refused ` +
          `any further credential-bearing command. Continue with ` +
          `unauthenticated vectors, or start a new campaign with a higher ` +
          `--lockout once you have confirmed the real policy with the client.`,
      );
    }
    if (this.spent + 1 > this.limit) {
      this.tripped = true;
      throw new InterlockRefusal(
        `BLOCKED — this would be credential attempt ${this.spent + 1}, and ` +
          `the domain locks accounts at ${this.lockout}. The budget is ` +
          `${this.limit} (lockout - 1) and it is now spent; every further ` +
          `credential-bearing command in this campaign is refused. This is ` +
          `the interlock working, not an error — report what the attempts so ` +
          `far established and stop guessing.`,
      );
    }
    this.spent += 1;
    if (this.history.length < 50) {
      this.history.push(command.trim().slice(0, 200));
    }
  }
}

// --- command inspection ------------------------------------------------------
//
// A pure function, so the whole interlock is testable without a campaign, a
// model, or a network. Everything below is a regex over the command string.

/**
 * Flags that carry a secret. If one of these is present the command is trying
 * to authenticate with something that can be *wrong*, which is the only thing
 * that locks an account.
 *
 * `-usersfile` is deliberately NOT here. It names a list of *usernames* — it is
 * what AS-REP roasting and enumeration take — and counting it would spend the
 * whole budget on the one technique that cannot lock anything, which is exactly
 * backwards. A file of passwords is `-w`/`--wordlist`, and that one is here.
 */
const _SECRET_FLAGS: readonly string[] = [
  '-p',
  '--password',
  '--passwords',
  '-pw',
  '--pw',
  '-hashes',
  '--hashes',
  '-w',
  '--wordlist',
  '--passwords-file',
];

/**
 * Flags that positively mean *no* secret is being offered. Checked after the
 * secret flags, so `-N` alongside a `-p` is still counted — a command that
 * carries a password is a credential attempt whatever else it says.
 *
 * `-x` is ldapsearch's simple-bind *without* a DN, and `-Y`/`-Q` are GSSAPI and
 * SASL with no credential offered. They belong here rather than in
 * `_NO_AUTH_TOOLS` because ldapsearch is not a tool that *cannot* authenticate:
 * with `-D` and `-w` it very much can, and that form must still be counted.
 */
const _NO_SECRET_FLAGS: readonly string[] = [
  '-N',
  '--no-pass',
  '-no-pass',
  '--anonymous',
  '-x',
];

/**
 * The impacket target syntaxes that carry a password inline, plus samba's
 * `user%pass`. Three shapes, because impacket accepts all three:
 *
 *   domain/user:pass@host     the full form
 *   domain/user:pass          with the host given separately as -dc-ip
 *   user%pass                 samba's, as `-U j.doe%Passw0rd`
 *
 * The domain half is required to be *dotted* in the second shape. That is what
 * separates `corp.local/j.doe:Passw0rd` from a file:line reference like
 * `src/app.py:12` — an AD domain always has a dot, a source directory usually
 * does not — and it keeps a grep result from being read as a credential.
 */
const _SECRET_INLINE_RE =
  /[a-zA-Z0-9_.\-]+:[^@\s/\\]+@|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\/[a-zA-Z0-9_.\-]+:[^@\s/\\]+|[a-zA-Z0-9_.\-]+%[^@\s/\\]+/;

/**
 * The netexec/crackmapexec password flags, which the shared table above cannot
 * carry because `-p` means *port* to nmap. Checked only when the command names
 * one of the C2 aliases, so `nmap -p445` is a port scan and `nxc smb … -p X` is
 * a credential. `-H` is the same story: a hash to nxc, something else to nmap.
 */
const _C2_SECRET_FLAGS: readonly string[] = [
  '-p',
  '--password',
  '--passwords',
  '-H',
  '--hash',
  '--hashes',
  '-u',
  '--username',
  '--users',
  '-w',
  '--wordlist',
];

/** A long-form password flag that carries its value inline: `--password=Pass1`. */
const _INLINE_SECRET_FLAG_RE =
  /(?:^|\s)(?:--password|--passwords|--pw|--hashes|--hash|--wordlist)=/;

/**
 * netexec/crackmapexec spray markers. `--continue-on-success` means the run
 * keeps going after a hit, which is the shape of a spray rather than a single
 * login attempt; `--no-bruteforce` is the opposite and is an explicit opt-out.
 */
const _SPRAY_MARKER_RE =
  /--continue-on-success|--no-bruteforce(?!=)|(?:^|\s)-M\s+spray|(?:^|\s)--spray\b/;

/**
 * A `brute` token that is not itself a tool name. `nmap --script smb-brute` and
 * `--brute` are sprays hiding in an argument list, where a flag table would
 * never see them — but `kerbrute` is a tool whose *name* contains the word, and
 * `kerbrute userenum` submits nothing. Matched as a word and then filtered
 * against `AD_TOOL_NAMES`, which is what tells the two apart.
 */
const _BRUTE_WORD_RE = /[a-zA-Z0-9_.-]*brute[a-zA-Z0-9_.-]*/g;

/**
 * Invocations that are known to submit no password, whatever else is on the
 * line. The AS-REP roast is the flagship unauthenticated technique — Kerberos
 * pre-authentication is disabled on the target account, so no password is ever
 * checked and no lockout is possible — and kerbrute's enumeration subcommand
 * asks the KDC which accounts exist without ever offering a credential.
 * Counting these would spend the campaign's whole budget on the work that
 * cannot lock anything, which is precisely backwards. Checked *after* the
 * secret flags, so `GetNPUsers.py -p …` is still a credential attempt.
 */
const _NO_SUBMIT_RE =
  /\bGetNPUsers\.py\b|\bkerbrute\s+userenum\b|\benumdom(?:users|groups|aliases)\b|\bquerydispinfo\b|\bqueryuser\b/;

/**
 * A recursive, forced delete. Destructive on its own, but only interesting to
 * this interlock when it is aimed at a domain controller — hence the pairing
 * with `_DC_PATH_RE` below.
 */
const _RM_RF_RE = /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)+/;

/**
 * Paths that belong to a domain controller's own state. `/var/lib/samba`,
 * `C:\Windows\NTDS`, `/etc/krb5.keytab` — deleting any of these is not a
 * penetration test, it is the incident.
 */
const _DC_PATH_RE =
  /\/var\/lib\/samba|\/var\/lib\/sss|\/etc\/sssd|\/etc\/krb5|\/var\/kerberos|\/etc\/samba|\/var\/lib\/ldap|\/etc\/ldap|ntds\.dit|\\Windows\\NTDS|\\Windows\\SYSVOL|sysvol/i;

/** An empty user — `-U ''` — is a null session, not a credential. */
const _NULL_USER_RE = /-U\s+(?:''|"")/;

/**
 * Things that change the domain rather than read it. Refused unless the
 * operator armed the run, because these are the commands that turn a
 * penetration test into an incident. Order matters: the first match supplies
 * the reason.
 */
const _DESTRUCTIVE: ReadonlyArray<readonly [RegExp, string]> = [
  // Both spellings: impacket scripts take single-dash long options
  // (`-delete`), PowerShell cmdlets and nxc take the double-dash GNU form
  // `--delete`, and impacket's `-action delete` — which spells the same thing
  // as a *value* rather than a flag, so a rule that only looked for the flag
  // would miss the form `secretsdump.py` actually documents. Both the
  // space-separated and `=`-joined spellings, since argparse takes either.
  [
    /(?:^|\s)--?delete\b|(?:^|\s)--?action[=\s]+delete\b|\bRemove-AD(?:User|Group|Object)\b/,
    'deletes a directory object',
  ],
  [/(?:^|\s)--?action\s+reset\b/, 'resets an account password'],
  [
    /\bset-password\b|\bSet-ADAccountPassword\b|\bdsmod\s+user\b|\bnet\s+user\b[^|;]*\/add\b|\bnet\s+user\b[^|;]*\/active:no\b/,
    'sets a password or creates or disables an account',
  ],
  // `net user <name> <password>` — no flag at all, so nothing above catches
  // it. The third token is the password, and it is a password because it does
  // not start with `/`: `net user j.doe /domain` is a read, `net user j.doe
  // NewPass /domain` is a reset, and the difference is that slash.
  [/\bnet\s+user\s+\S+\s+(?!\/)\S/, 'sets an account password'],
  [
    /\bnet\s+accounts\b[^|;]*\/(?:minpwlen|lockoutthreshold|maxpwage|forcelogoff|uniquepw)\b/,
    'changes the domain password or lockout policy',
  ],
  [
    /\bAdd-DomainObjectAcl\b|\bSet-DomainObject\b|\bAdd-ADGroupMember\b|\bAdd-DomainGroupMember\b|\bdsacls\b/,
    'modifies ACLs or group membership',
  ],
  // An ADCS *write*, matched on certipy's subcommand — the token immediately
  // after the tool name — rather than on any flag that follows it.
  //
  // `certipy find` only reads, and a blanket rule on the word `template`
  // refused the recon that establishes whether ESC1 exists at all. Matching
  // arguments instead is worse in the other direction: `-ca CORP-CA` appears
  // in `certipy req` and `certipy find` alike, so a rule keyed on it refuses a
  // certificate *request* while letting the same request through when the CA
  // is auto-discovered. The subcommand is what decides.
  //
  // `template` and `ca` change ADCS configuration; `account` sets passwords
  // and `shadow` adds key credentials, both of which are writes to the
  // directory. `req` is deliberately absent: enrolling a certificate does not
  // modify directory state, which is the line this rule draws.
  [
    /\bcertipy(?:\.py)?\b[^|;]*?\s(?:template|ca|account|shadow)\b/,
    'modifies an ADCS template, CA or account',
  ],
  [
    /\bntlmrelayx\.py\b[^|;]*(?:--escalate-user|--delegate-access|--add-computer|--sid|(?:^|\s)-c\s)/,
    'writes to the domain through a relay',
  ],
  // A machine account is a *new object* in the directory, so this is a write
  // however it is spelled — with a password, or with a hash.
  [
    /\baddcomputer\.py\b[^|;]*(?:-computer-pass|-computer-password|-hashes)/,
    'joins a computer to the domain',
  ],
  [
    /\bgpo(?:backup|restore)\b|\bdcpromo\b|\bntdsutil\b[^|;]*\b(?:delete|repair|authoritative)\b/,
    'modifies or restores directory state',
  ],
];

/** Any word that could be a command name or a tool. Split on the characters that
 *  separate one command from the next, so `a && b` and `a | b` are both seen. */
const _TOOL_WORD_RE = /[a-zA-Z0-9_./-]+/g;

/** Every token that could be a tool name, basename-normalised. */
function _words(command: string): string[] {
  return (command.match(_TOOL_WORD_RE) ?? []).map((w) => w.split('/').pop()!);
}

/**
 * The first AD tool the command names, or "".
 *
 * Matched on whole tokens so `--wordlist` cannot be read as a tool called
 * `wordlist`, and on the basename so `/usr/bin/GetUserSPNs.py` and
 * `GetUserSPNs.py` are the same tool.
 */
function _namedTool(command: string): string {
  for (const base of _words(command)) {
    if (AD_TOOL_NAMES.has(base)) return base;
    // `impacket-GetUserSPNs` and `impacket-secretsdump` are the same scripts
    // under the distro's console-script names.
    if (base.startsWith('impacket-')) {
      const stem = base.slice('impacket-'.length);
      for (const candidate of [`${stem}.py`, stem]) {
        if (AD_TOOL_NAMES.has(candidate)) return candidate;
      }
    }
  }
  return '';
}

/** True if *flag* appears as a whole argument — `-p`, not `-passive`. */
function _hasFlag(command: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)${_escapeRe(flag)}(?:\\s|=|$)`).test(command);
}

function _escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Read one shell command. Pure — no state, no I/O, no network.
 *
 * This is the whole interlock's decision surface, which is why it is a
 * function of the string alone: every rule below can be tested by writing the
 * command down, and the tests need no campaign, no model and no domain.
 *
 * The classification is deliberately asymmetric. Destructive verbs are
 * detected by a positive match on a specific pattern, because refusing a
 * read-only command costs the operator a turn. Credential attempts are the
 * other way round: **counted unless the command is definitely non-credential**,
 * because under-counting is how a domain gets locked out and over-counting
 * only costs budget the operator can raise.
 */
export function inspect(command: string): Verdict {
  const cmd = (command ?? '').trim();
  if (!cmd) return new Verdict();

  const tool = _namedTool(cmd);
  const words = new Set(_words(cmd));
  const lowered = cmd.toLowerCase();

  // --- does it submit a secret? This is computed first because it decides how
  //     a destructive command is classified, not just whether it is counted.
  const hasSecret =
    _SECRET_FLAGS.some((f) => _hasFlag(cmd, f)) ||
    _SECRET_INLINE_RE.test(cmd) ||
    _INLINE_SECRET_FLAG_RE.test(cmd) ||
    (_intersects(words, new Set(_C2_ALIASES)) &&
      _C2_SECRET_FLAGS.some((f) => _hasFlag(cmd, f)));

  // --- destructive verbs, before the tool test, because the worst of them —
  //     `net user j.doe NewPass`, `net accounts /lockoutthreshold:0` — name no
  //     AD tool at all and would otherwise fall through as "not our business".
  //     A command that writes to the directory is the interlock's business
  //     however it spells itself.
  //
  //     `credential` is taken from the secret check rather than assumed: a
  //     destructive command that also carries a password is refused outright
  //     by the interlock and must not *also* have spent the attempt budget on
  //     the way in, or the operator loses an attempt to a command that never
  //     ran.
  for (const [pattern, why] of _DESTRUCTIVE) {
    if (pattern.test(cmd)) {
      return new Verdict({
        credential: hasSecret,
        destructive: true,
        tool: tool !== '' ? tool : 'net',
        reason: why,
      });
    }
  }

  if (tool === '') {
    // A recursive delete of a domain controller's own state names no AD tool
    // — `rm -rf /var/lib/samba` is just `rm` — but it is still the end of the
    // client's Monday, so it is caught here rather than falling through as
    // "not our business". Anything else is `ls`, `cat`, `grep`: nothing to
    // say, and nothing that may spend the budget.
    if (_RM_RF_RE.test(cmd) && _DC_PATH_RE.test(cmd)) {
      return new Verdict({
        credential: false,
        destructive: true,
        tool: 'rm',
        reason:
          "rm: recursively deletes a directory that looks like a domain controller's",
      });
    }
    return new Verdict();
  }

  // Guessing is checked next and wins over everything below, including the
  // no-auth tools: `nmap --script smb-brute` is a port scanner by name and a
  // password spray in fact.
  const bruteWords = (cmd.match(_BRUTE_WORD_RE) ?? []).filter(
    (w) => !AD_TOOL_NAMES.has(w.split('/').pop()!),
  );
  if (
    _intersects(words, _SPRAY_TOOLS) ||
    _SPRAY_MARKER_RE.test(cmd) ||
    bruteWords.length > 0 ||
    lowered.includes('spray') ||
    lowered.includes('brute-force') ||
    lowered.includes('bruteforce')
  ) {
    return new Verdict({
      credential: true,
      tool,
      reason: `${tool}: password guessing or spraying`,
    });
  }

  if (_NULL_USER_RE.test(cmd)) {
    return new Verdict({
      credential: false,
      tool,
      reason: `${tool}: null session, no credential offered`,
    });
  }

  if (_NO_SECRET_FLAGS.some((f) => _hasFlag(cmd, f))) {
    return new Verdict({
      credential: false,
      tool,
      reason: `${tool}: explicitly no password`,
    });
  }

  // A recursive delete aimed at a domain controller's own state. Destructive,
  // and not a credential attempt, so it is refused outright without spending
  // budget. `rm -rf /tmp/scratch` is housekeeping and the interlock leaves it
  // alone; `rm -rf /var/lib/samba` is the end of the client's Monday.
  if (_RM_RF_RE.test(cmd) && _DC_PATH_RE.test(cmd)) {
    return new Verdict({
      credential: false,
      destructive: true,
      tool,
      reason: `${tool}: recursively deletes a directory that looks like a domain controller's`,
    });
  }

  // Tools that cannot authenticate to anything, whatever flags they carry. A
  // port scanner, a resolver, an offline cracker and a TLS client offer no
  // credential to be wrong, so they cannot lock an account.
  //
  // Checked *after* the spray rule above, because `nmap --script smb-brute` is
  // a port scanner by name and a password spray in fact — and *before* the
  // secret-flag test below, because `-p` means **port** to nmap and
  // **password** to netexec. A scanner refused for naming a port is a campaign
  // that cannot map its own target.
  if (_NO_AUTH_TOOLS.has(tool)) {
    return new Verdict({
      credential: false,
      tool,
      reason: `${tool}: does not authenticate — no credential to lock an account with`,
    });
  }

  if (hasSecret) {
    return new Verdict({
      credential: true,
      tool,
      reason: `${tool}: submits a credential`,
    });
  }

  // Invocations that are known to submit nothing. The AS-REP roast is the
  // flagship unauthenticated technique: pre-authentication is disabled on the
  // target account, so no password is ever checked and no lockout is possible.
  // Counting it would spend the campaign's whole budget on the one technique
  // that cannot lock anything. Checked after the secret flags, so a
  // `GetNPUsers.py -p …` is still counted.
  if (_NO_SUBMIT_RE.test(cmd)) {
    return new Verdict({
      credential: false,
      tool,
      reason: `${tool}: submits no credential — nothing to lock an account with`,
    });
  }

  // AD tooling with no recognisable secret and no `-N`. Could be a null
  // session, could be an interactive prompt that will fail, could be a spray
  // hidden behind a flag this table does not know. Counted, and said so.
  return new Verdict({
    credential: true,
    tool,
    reason: `${tool}: cannot tell whether this authenticates — counted conservatively`,
  });
}

/** Options for `makeInterlock` (the Python keyword-only arguments). */
export interface InterlockOptions {
  /** The operator's explicit opt-in to the destructive verbs. Off unless they
   *  asked; nothing in this module turns it on by itself. */
  armed?: boolean;
  /** A reporting seam, not a control: the UI uses it to put the refusal in the
   *  transcript, so the operator sees the breaker trip as it happens rather
   *  than inferring it from a wave that went quiet. */
  onRefuse?: (verdict: Verdict, command: string) => void;
}

/**
 * Build the tool hook `/ad` installs on every agent in the campaign.
 *
 * `bash` only. Everything else the agents do — reading a file, writing a
 * report — is not a credential attempt and must not queue behind a throttle.
 *
 * Shape note for the port: the Python original is an async-context-manager
 * factory; every refusal and every acquire happens before the `yield` and
 * nothing happens after it, so in the `ToolHook` shape (`enter`/`exit` from
 * `shared.ts`) all of the work lives in `enter` and `exit` is deliberately
 * empty. A throttle token is spent, never returned — this is a rate limiter,
 * not a lock held across the tool call.
 */
export function makeInterlock(
  throttle: Throttle,
  budget: AttemptBudget,
  opts: InterlockOptions = {},
): ToolHook {
  const armed = opts.armed ?? false;
  const onRefuse = opts.onRefuse;

  const note = (verdict: Verdict, command: string): void => {
    if (onRefuse) {
      try {
        onRefuse(verdict, command);
      } catch {
        // A reporting seam that raises must not take the campaign down.
      }
    }
  };

  return {
    async enter(
      name: string,
      args: Record<string, unknown>,
    ): Promise<void> {
      if (name !== 'bash') return;
      const a = args ?? {};
      const command = String(a['command'] || a['cmd'] || '');
      const verdict = inspect(command);
      if (!verdict.relevant) return;

      if (verdict.destructive && !armed) {
        note(verdict, command);
        throw new InterlockRefusal(
          `BLOCKED — refusing a command that ${verdict.reason}. /ad does ` +
            `not modify the directory: a penetration test that changes ` +
            `ACLs, resets a password or writes through a relay is an ` +
            `incident, not a finding. Re-run with --arm if the client has ` +
            `authorised write actions, or report what you found without ` +
            `using it.`,
        );
      }

      if (verdict.credential) {
        await throttle.acquire();
        try {
          budget.spend(command);
        } catch (e) {
          if (e instanceof InterlockRefusal) note(verdict, command);
          throw e;
        }
      }
    },

    async exit(
      _name: string,
      _args: Record<string, unknown>,
    ): Promise<void> {
      // Deliberately empty — see the shape note above.
    },
  };
}

// === SECTION === Vectors

/**
 * `(name, brief, owns, tools)`. The three-tuple the engine's fallback roster
 * wants is derived below, so the tool requirement lives beside the brief
 * instead of in a parallel table that can drift.
 *
 * **These are all unauthenticated on purpose.** A fallback matrix is what runs
 * when the planner's reply cannot be read, which means it has to be safe to run
 * blind — with no foothold, no credential and no assumption about what an
 * earlier wave obtained. Every vector here is reachable from outside the
 * domain, and the ones that are not (kerberoast, ADCS) say so in the brief and
 * tell the agent to report the *reachability* rather than force the exploit.
 */
const _VECTOR_TABLE: ReadonlyArray<
  readonly [string, string, string, readonly string[]]
> = [
  [
    'asrep-roast',
    'AS-REP roasting. Ask the KDC for a TGT for every account that does not ' +
      'require Kerberos pre-authentication, and crack the response offline. ' +
      'Enumerate the accounts first — GetNPUsers.py takes a -usersfile, and ' +
      "the domain's own naming convention (first.last, flast) generates a " +
      'usable list without any credential. This needs NO authentication and ' +
      'cannot lock an account: pre-auth is disabled, so no password is being ' +
      'checked. Report every account that returned a hash, and whether the ' +
      'hash cracked and to what.',
    'asrep-roast',
    ['GetNPUsers.py', 'hashcat'],
  ],
  [
    'kerberoast',
    'Kerberoasting. Enumerate accounts with a servicePrincipalName and ' +
      'request a service ticket for each, then crack it offline. Requesting a ' +
      'TGS normally needs a credential — so establish FIRST whether an ' +
      'anonymous or null LDAP/SAMR bind can read the SPN list, and if it ' +
      'cannot, report that as the finding and stop: an unauthenticated ' +
      'kerberoast is only possible where the bind is open, and the open bind ' +
      'is itself the bug worth reporting. Never guess a password to get the ' +
      'bind.',
    'kerberoast',
    ['GetUserSPNs.py', 'hashcat'],
  ],
  [
    'null-session',
    'Null and guest sessions. Test whether the domain controllers accept an ' +
      "SMB or SAMR session with no credential at all — `rpcclient -U '' -N` " +
      'and `smbclient -L //<dc> -N`. If one is accepted, enumerate what it ' +
      'exposes: users, groups, password policy, shares, sessions. The ' +
      'password policy is the single most valuable thing here, because every ' +
      'later decision about how hard this engagement may push depends on the ' +
      'real lockout threshold rather than the one we were told. Report the ' +
      'policy verbatim, including the lockout threshold and duration.',
    'null-session',
    ['rpcclient', 'smbclient', 'enum4linux-ng'],
  ],
  [
    'ldap-anon',
    'Anonymous LDAP. Query the directory with no bind — `ldapsearch -x -H ' +
      "ldap://<dc> -b 'dc=corp,dc=local'` and windapsearch if present. An " +
      'anonymous bind that returns objects is a finding on its own. Enumerate ' +
      'the naming context, the domain functional level, and any object the ' +
      'bind can actually read: users, groups, computers, and especially ' +
      'attributes that should never be world-readable. Do not send a bind ' +
      'with credentials to widen this — if the anonymous read stops short, ' +
      'that is the result.',
    'ldap-anon',
    ['ldapsearch', 'windapsearch'],
  ],
  [
    'smb-signing',
    'SMB signing and protocol posture. Determine, for every host you can ' +
      'reach, whether SMB signing is required, enabled-but-not-required, or ' +
      'off. Unsigned SMB is what makes NTLM relay possible, so this is the ' +
      'question that decides whether the relay vectors are worth a wave. Use ' +
      '`nmap --script smb2-security-mode,smb2-capabilities -p445 <targets>` ' +
      'and nxc if it is installed. Report per host, with the exact script ' +
      "output — 'signing not required' on a member server is a high finding " +
      'and needs the evidence to say so.',
    'smb-signing',
    ['nmap', 'nxc'],
  ],
  [
    'adcs-enroll',
    'ADCS reachability. Find the certificate authorities: the CA is ' +
      'published in the directory as an enrollment service object and often ' +
      'answers on its own hostname at /certsrv/. Establish whether the web ' +
      "enrollment endpoint is reachable unauthenticated, and whether the CA's " +
      'certificate is retrievable — `openssl s_client` against the CA host, ' +
      'and a plain fetch of http://<ca>/certsrv/. Do NOT modify a template or ' +
      'a CA. This vector is reconnaissance for the ADCS exploitation wave, ' +
      'and its output is the list of CAs and templates to attack later, not ' +
      'an attack.',
    'adcs-enroll',
    ['certipy', 'openssl'],
  ],
  [
    'domain-enum',
    'Domain mapping by DNS. No credential is involved and this is the ' +
      "cheapest high-value work in the wave. Resolve the domain's own records: " +
      'the SRV records that name every domain controller (_ldap._tcp.dc._msdcs, ' +
      '_kerberos._tcp, _gc._tcp), the site topology, the A records, and any ' +
      'zone transfer the nameserver will hand over (AXFR — a success is a ' +
      'critical finding). Build the host list the rest of the campaign will ' +
      'use. Report the DCs by name and address, the functional level if you ' +
      'can read it, and whether the nameserver leaked the zone.',
    'domain-enum',
    ['dig', 'nslookup', 'rpcdump.py'],
  ],
  [
    'user-enum',
    'Username enumeration. Establish which accounts exist without ' +
      'authenticating to any of them. Kerberos is the safe oracle: an AS-REQ ' +
      'for a nonexistent principal returns a different error from one for a ' +
      'real account with pre-authentication required, and kerbrute uses ' +
      'exactly that — it enumerates without ever submitting a password. If ' +
      'kerbrute is absent, the null-session RPC path (enumdomusers, ' +
      "lookupsid) does the same job. Build a real user list from the domain's " +
      'naming convention and the names you find. Do NOT follow this with a ' +
      'password spray in this brief: enumeration and guessing are separate, ' +
      "and the guessing budget is the operator's to spend.",
    'user-enum',
    ['kerbrute', 'lookupsid.py', 'samrdump.py', 'GetADUsers.py'],
  ],
  [
    'gpp-cpassword',
    'SYSVOL and the cpassword problem. If any read access to SYSVOL is ' +
      'possible, hunt Group Policy Preferences XML for `cpassword` — the ' +
      'AES key Microsoft published, which makes every stored GPP password ' +
      'decryptable by anyone who can read the file. Also look for scripts, ' +
      'batch files and unattend.xml carrying credentials, and for shares that ' +
      "expose them. `smbclient //<dc>/SYSVOL -N -c 'recurse; ls'` and a grep " +
      'for cpassword is the whole method. Report the exact file path and the ' +
      'decrypted password if gpp-decrypt is available, or the cpassword blob ' +
      'and its location if it is not.',
    'gpp-cpassword',
    ['smbclient', 'gpp-decrypt', 'smbmap'],
  ],
  [
    'laps-read',
    'LAPS and readable secrets. Determine whether the local-administrator ' +
      'password is managed by LAPS, and whether the attribute that holds it ' +
      '(`ms-Mcs-AdmPwd` on legacy LAPS, `msLAPS-Password` on Windows LAPS) is ' +
      'readable by anything less than a domain admin. A null or anonymous ' +
      'bind that can read it is a critical finding. Also check for readable ' +
      'description and info fields carrying passwords — a helpdesk-set ' +
      "password in a user's description is common and is a real finding. " +
      'Report the attribute, the object it was read from, and the exact ' +
      'query that read it.',
    'laps-read',
    ['rpcclient', 'ldapsearch', 'reg.py'],
  ],
];

/** The fallback roster, in the shape `hunt.fallbackRoster` consumes. */
export const AD_VECTORS: [string, string, string][] = _VECTOR_TABLE.map(
  ([n, b, o]) => [n, b, o],
);

/**
 * The authenticated vectors — the menu for wave 2 and beyond, once a wave has
 * obtained a foothold. Not in `AD_VECTORS`: a fallback matrix has to be safe to
 * run with no credential at all, and every one of these needs one. The planner
 * prompt names them so the second wave has somewhere to go.
 */
export const AD_LATER_VECTORS: [string, string][] = [
  [
    'acl-paths',
    'BloodHound-style ACL analysis: find the shortest path from what we hold ' +
      'to Domain Admin — GenericAll, WriteDacl, WriteOwner, ' +
      'ForceChangePassword, AddMember — and the object each one hangs off.',
  ],
  [
    'delegation',
    'Unconstrained, constrained and resource-based constrained delegation. An ' +
      'unconstrained-delegation host that we can write to is a domain ' +
      'compromise; RBCD on a machine account we control is the modern one.',
  ],
  [
    'adcs-esc',
    'ADCS exploitation: ESC1 through ESC16 against the templates the recon ' +
      'wave listed. Certificate templates are the most common full-domain ' +
      'escalation in a modern estate.',
  ],
  [
    'dcsync-rights',
    'Who holds Replicating Directory Changes and Replicating Directory ' +
      'Changes All. Either one is a DCSync, which is every hash in the ' +
      'domain.',
  ],
  [
    'trust-abuse',
    'Domain and forest trusts: the trust key, SID history, and whether the ' +
      'trust is transitive or filtered. A trust is a doorway and the trust ' +
      'key is often the lock.',
  ],
  [
    'coercion',
    'Authentication coercion — PetitPotam, PrinterBug, DFSCoerce — against a ' +
      'host that will relay to the CA or the DC. This one needs the relay in ' +
      'place first.',
  ],
  [
    'relay',
    'NTLM relay. Only worth a wave where the recon found SMB signing off, or ' +
      'an ADCS web enrollment endpoint that accepts NTLM. Relay to LDAP for ' +
      'RBCD, to the CA for a certificate, or to SMB for a shell — the choice ' +
      'follows from what is unsigned.',
  ],
  [
    'host-sprawl',
    'Lateral movement across the member servers: local admin reuse, cached ' +
      'credentials, service accounts, and which hosts the credential we hold ' +
      'actually opens.',
  ],
  [
    'scheduled-tasks',
    'Scheduled tasks and services on hosts we can reach — a task running as ' +
      'a privileged account, or a service binary path we can write to.',
  ],
  [
    'unquoted-paths',
    'Unquoted service paths and weak directory permissions on the member ' +
      'servers — the classic local privilege escalation that turns a ' +
      'member-server foothold into a domain one.',
  ],
];

// === SECTION === Prompts

/**
 * `{tools}` is substituted by `buildReconPrompt` *before* the engine formats
 * `{target}`/`{contract}`. Left in place it would raise a missing-key error at
 * format time in the Python engine, which is the right failure: a recon prompt
 * with no tool list is a prompt that sends agents after binaries that are not
 * installed. Keep the placeholders intact — the engine's substitution depends
 * on finding them.
 */
const _RECON_TEMPLATE = `You are opening a security engagement against a declared, authorised Active
Directory domain.

DOMAIN: {target}

This is the RECON phase. Map the domain before anyone attacks it. Do not attempt
exploitation here — that is the next phase, and a recon run that stops early to
try a roast has failed at its actual job.

TOOLING ON THIS HOST
--------------------
{tools}

Work with the tools you have. Establish, as far as you can, WITHOUT
AUTHENTICATING TO ANY ACCOUNT:

- The domain controllers: their names and addresses, from DNS SRV records
  (\`_ldap._tcp.dc._msdcs.<domain>\`, \`_kerberos._tcp.<domain>\`, \`_gc._tcp\`).
  A domain that will not resolve is a real result — report it and stop.
- The domain itself: functional level, naming context, NetBIOS name, the site
  topology if DNS gives it up, and whether a zone transfer is permitted.
- The unauthenticated surface: does the DC accept a null SMB or SAMR session?
  Does anonymous LDAP return objects? Is SMB signing required on each host?
  These three answers decide which vectors the next wave can even attempt.
- The password policy. If any null session reaches it, this is the single most
  valuable fact in the engagement — the real lockout threshold, not the one we
  were told. Report it verbatim.
- Users and groups, to the extent they are readable without a credential, and
  the naming convention the domain uses (first.last, flast, firstl).
- ADCS: which certificate authorities are published, where they answer, and
  whether web enrollment is reachable.
- Hypotheses: which of the four families — credentials, ADCS, ACL and
  delegation, coercion and relay — this domain is actually weak in, and what
  each one would need to proceed.

RULES FOR THIS PHASE
- Do NOT submit a password to anything. Not one. Recon is unauthenticated, and
  a guessed password here spends the campaign's entire attempt budget before a
  brief has been written.
- Do NOT modify the directory: no ACL changes, no password resets, no template
  edits, no writing through a relay.
- Prefer the offline path everywhere it exists. Roasting and cracking happens
  on this host, not against the DC.
- Treat a lockout error (\`STATUS_ACCOUNT_LOCKED_OUT\`, Kerberos \`err: 1909\`) as
  a stop signal: report it immediately and change nothing further.

Be concrete. A hypothesis that names a DC and an attribute is worth ten that
name a category. If the domain does not answer at all, say so plainly and report
what you tried — that is a real result, not a failure.

Finish with a short written brief: what the domain is, what you could reach
without a credential, what you could not, the password policy if you found it,
and your ranked hypotheses for where the weaknesses are.

{contract}
`;

export const PLANNER_PROMPT = `You are directing a security engagement against a declared, authorised Active
Directory domain. Your job is to decide what the NEXT wave of {wave_size} agents
should each do.

DOMAIN: {target}

WHAT IS KNOWN
-------------
{recon}
{recon_note}
WHAT HAS ALREADY BEEN FOUND
---------------------------
{findings}

WAVE HISTORY
------------
{waves}

You have READ-ONLY tools. Use them to check a hypothesis before you brief an
agent on it — enough to know the host answers and the brief is not a guess — but
do not attempt the work itself. That is what the agents are for.

THE ONE RULE THAT OVERRIDES THE OTHERS
- Never write a brief that guesses passwords. No spraying, no brute force, no
  wordlist against a live account, no "try these ten common passwords". This
  domain locks an account after __LOCKOUT__ bad passwords, so the whole campaign
  is permitted __BUDGET__ credential attempts in total — and a hard circuit
  breaker refuses every credential-bearing command once they are spent. A brief
  built around guessing spends them and is then refused mid-wave. Offline
  cracking of a hash we already hold is always the better path and is always
  allowed.
- Never write a brief that modifies the domain. No ACL changes, no password
  resets, no ADCS template edits, no \`--delete\`, no relay that writes. The
  interlock refuses these outright, so a brief built on one wastes an agent.
- If any worker sees \`STATUS_ACCOUNT_LOCKED_OUT\`, \`err: 1909\`, or a lockout
  notice in an output, that is a stop signal for the entire wave: brief nobody
  to retry that account, and say so in the finding.

Rules:
- Return AT MOST {wave_size} workers. Fewer is better than padding.
- Every brief must be INDEPENDENT: no agent may depend on another's output,
  because they all run at the same time and cannot talk to each other.
- Wave 1 is the unauthenticated surface only. If the findings show no foothold
  yet, every brief must be reachable with no credential at all.
- Once a foothold exists, the highest-value work is the path it opens: the ACL
  edge it unlocks, the host it reaches, the template it can enroll against.
  These are the families worth covering, roughly in the order they pay:
  credential material, ADCS, ACL and delegation abuse, then coercion and relay.
- Do not repeat work already done. Read the findings and the wave history and
  aim at what is still open. If an earlier finding was marked low-confidence or
  a worker failed, a brief that re-tests it properly is worth a slot.
- Each worker gets a short lowercase \`name\` (e.g. "asrep-roast") and a \`brief\`
  that is a complete, self-contained instruction. The worker sees the brief and
  nothing else — it must say what to test, against which host, with which tool,
  and how to prove it.
- \`owns\` is the host, account or vector that brief is responsible for. Two
  workers must not claim the same one; the wave is deduplicated on this.

Reply with ONE JSON object and nothing else:

{{"summary": "one line on how you are reading the domain now",
  "workers": [{{"name": "short-name",
               "brief": "the full instruction for this agent",
               "owns": ["the host, account or vector it owns"]}}]}}

{contract}
`;

export const FINDING_CONTRACT = `REPORTING
---------
Report each confirmed weakness TWICE, and the first time is the one that
matters:

1. THE MOMENT YOU CONFIRM IT — call the \`\`report_finding\`\` tool. Do this as soon
   as you have the evidence in hand, in the same turn you got it, before you go
   on to the next thing. This is a live engagement: the operator is watching a
   tracker that fills in as you work. A finding you sit on until the end of your
   turn is a finding the operator spends that whole time not knowing about.

   Report a weakness you have *indicated* as well as one you have *proven*, but
   never blur the two — see the evidence rule below.

2. AGAIN IN YOUR FINAL MESSAGE — end it with ONE JSON object on its own lines,
   wrapped in a \`\`\`json fence:

\`\`\`json
{"findings": [{"title": "short name for the weakness",
               "severity": "critical|high|medium|low|info",
               "asset": "the host, account or object affected",
               "summary": "what the weakness is, in two or three sentences",
               "evidence": "the exact command and the exact output that shows it",
               "remediation": "how to fix it"}]}
\`\`\`

Rules for both:
- One entry per distinct weakness, and the same weakness is the same weakness in
  both places. The two are reconciled by title and asset, so repeating yourself
  costs nothing; reporting the same weakness under two names inflates the count.
- If you found nothing, call no tool and omit the block entirely (or send
  \`{"findings": []}\`) — do not invent a finding to fill either one.
- \`severity\` must be one of the five words above. Judge it honestly against what
  the weakness actually grants: a readable attribute with no path from it is
  \`low\`; a path from an account we hold to Domain Admin is \`critical\`.
- \`evidence\` must be something you actually observed — **the exact command and
  the exact output**, not a summary of them and not what you expect them to
  return. Say plainly whether the technique was PROVEN (you did it and have the
  result) or only INDICATED (the configuration allows it and you did not carry
  it through). A finding that does not say which is a finding nobody can act on,
  and will be discarded. \`\`report_finding\`\` refuses a report with no evidence,
  which is deliberate.
- Never submit a password to produce a finding. If a weakness can only be shown
  by guessing a credential, report the configuration that makes the guess
  worthwhile and say the exploitation was not carried out.
- Put nothing after the final JSON block. Anything you want to say, say before it.
`;

export const SUMMARY_PROMPT = `An Active Directory engagement against a domain has been running as a sequence
of waves of parallel agents. Write the closing report.

DOMAIN: {target}
WAVES RUN: {waves}

RECON
-----
{recon}

EVERY FINDING, IN THE ORDER THEY WERE CONFIRMED
-----------------------------------------------
{findings}

Write the report the operator will actually read — the one that goes to the
client. It must cover, in this order:

1. **The domain's exposure, in plain language.** What an unauthenticated
   attacker on the network can see and do, before any credential is involved.
   This is the section a non-specialist reads, and it is the one that decides
   whether the engagement is taken seriously.
2. **What was tested** — the ground covered, wave by wave, naming the hosts and
   the techniques. Not a list of agent names.
3. **What was found** — each confirmed weakness, worst first, with its severity,
   the evidence that proves it, and — explicitly — whether the attack path was
   **proven** or only **indicated**. A proven path to Domain Admin and an
   indicated one are different findings and must not read the same.
4. **What is worth checking next** — the specific, still-open leads: the ACL
   edge, the template, the host. Concrete enough that someone could pick it up.
5. **What was NOT done, and why.** The attempts the interlock refused, the
   vectors skipped for missing tooling, and any credential guessing that was
   deliberately avoided. This section is not optional. A client reading a
   domain report needs to know exactly where the engagement stopped, because
   everything past that line is unknown rather than clean.
6. **What is not worth the time** — the avenues checked and found clean.

Be honest about coverage. If a whole family was never tested, say so rather than
letting silence read as "clean". Do not pad, and do not overstate: an indicated
path presented as a proven one is the single worst failure this report can have.
`;

/**
 * The recon prompt with this host's tooling baked in.
 *
 * Substituted here rather than at format time because the engine's contract is
 * `{target}`/`{contract}` substitution — it knows nothing about tools, and
 * giving it a prompt it cannot format would break the seam for every other
 * doctrine.
 */
export function buildReconPrompt(probes: ToolProbe[]): string {
  return _RECON_TEMPLATE.replaceAll('{tools}', renderTools(probes));
}

// === SECTION === The doctrine

/**
 * The default lockout threshold when the operator does not state one. Five is
 * the most conservative value in common use — the Windows legacy default, and
 * the number a client is most likely to be running if nobody has looked. It is
 * deliberately not the modern default of ten: being wrong on the low side costs
 * a re-run, being wrong on the high side costs a locked-out workforce.
 */
export const DEFAULT_LOCKOUT = 5;

/**
 * Commands per second the whole wave may sustain, and how many may go at once.
 * A domain controller answers fast, and the danger is not volume against the DC
 * — it is the account. One per second sustained is slow enough that a mistake is
 * visible in the transcript before it becomes a lockout.
 */
export const DEFAULT_RATE = 1.0;
export const DEFAULT_BURST = 4;

/**
 * `PLANNER_PROMPT` with the operator's lockout arithmetic baked in.
 *
 * The planner is told the budget in numbers, not adjectives: "be careful" is a
 * wish, "you have four attempts against a domain that locks at five" is a
 * constraint a model can actually plan against. The numbers come from
 * `--lockout`, so they have to be substituted here rather than written into the
 * constant.
 *
 * Not a format field like `{target}`: the engine substitutes a fixed key set,
 * and a prompt carrying `{lockout}` would fail on the first wave of every
 * campaign. Sentinels are doubled-underscore names instead, and the test suite
 * asserts none of them survives.
 */
export function buildPlannerPrompt(lockout: number = DEFAULT_LOCKOUT): string {
  const budget = Math.max(1, Math.trunc(lockout) - 1);
  return PLANNER_PROMPT.replaceAll('__LOCKOUT__', String(Math.trunc(lockout)))
    .replaceAll('__BUDGET__', String(budget));
}

/** Options for `adKind` (the Python keyword-only arguments). */
export interface AdKindOptions {
  lockout?: number;
  rate?: number;
  burst?: number;
  armed?: boolean;
  /** Injectable so tests do not depend on what happens to be installed on the
   *  machine running them. */
  probes?: ToolProbe[];
  onRefuse?: (verdict: Verdict, command: string) => void;
}

/**
 * Build the `/ad` doctrine, with its own throttle and attempt budget.
 *
 * A *function*, not a constant, because the interlock holds per-campaign state:
 * a throttle and an attempt counter belong to one run. A module-level kind
 * handed to two campaigns in one session would carry the first campaign's spent
 * budget into the second and refuse it early — a conservative failure, but a
 * wrong one, and the kind of bug that is invisible until it matters.
 */
export function adKind(opts: AdKindOptions = {}): CampaignKind {
  const probes = opts.probes ?? probeTools();
  const throttle = new Throttle(
    opts.rate ?? DEFAULT_RATE,
    opts.burst ?? DEFAULT_BURST,
  );
  const budget = new AttemptBudget(opts.lockout ?? DEFAULT_LOCKOUT);
  const kind: CampaignKind = {
    name: 'ad',
    command: 'ad',
    dirPrefix: 'ad-',
    reconPrompt: buildReconPrompt(probes),
    plannerPrompt: buildPlannerPrompt(opts.lockout ?? DEFAULT_LOCKOUT),
    contract: FINDING_CONTRACT,
    summaryPrompt: SUMMARY_PROMPT,
    vectors: AD_VECTORS,
    interlock: makeInterlock(throttle, budget, {
      armed: opts.armed,
      onRefuse: opts.onRefuse,
    }),
  };
  return kind;
}

/**
 * The doctrine's default instance. Fine for reading the prompts, the vectors
 * and the directory prefix — which is what the tests and the UI's help text
 * want. **A real campaign calls `adKind()`**, so it gets its own throttle and
 * its own budget; see the note on that function for why that matters.
 */
export const AD_KIND: CampaignKind = adKind();
