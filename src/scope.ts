/**
 * scope.ts — target scope for bug-bounty engagements: allow.yaml + out-of-scope.yaml.
 *
 * What this module is: the session's static target-scope guard (port of
 * zimzilla/scope.py). Two files, one job each — `allow.yaml` declares the
 * operator's authorised targets and its PRESENCE arms the session (gated
 * tools then run unattended, like /mode danger); `out-of-scope.yaml` is the
 * never-touch list, hard-checked before any gated tool runs. Deny always
 * beats allow.
 *
 * Invariants:
 *  - The guard is a STATIC TEXT SCAN, not a sandbox: it tokenises the
 *    command, pulls out URLs / host:port pairs / bare host literals, and
 *    checks each against the deny-list. It never runs the shell, resolves
 *    DNS, or observes a running process.
 *  - HostSet.contains is polarity-neutral ON PURPOSE: membership means
 *    "permitted" for an allow-list and "blocked" for a deny-list. Callers
 *    decide what a match implies; keeping this neutral is what stops the two
 *    lists from silently inverting each other.
 *  - Neither file present -> nothing armed, nothing blocked. allow.yaml
 *    present -> session armed. out-of-scope.yaml present -> every listed host
 *    refused, regardless of what allow.yaml says.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expandTilde } from './shared.js';
import { parse as parseYaml } from 'yaml';

// === SECTION === IP parsing (the ipaddress stdlib stand-in) ===

/*
 * Python leaned on the stdlib `ipaddress` module for both parsing and CIDR
 * membership. Node has no equivalent, so the minimal layer lives HERE and is
 * exported: scope-validator must judge IPs and networks "the same way the
 * guard judges them" (its own docstring says so), which is only true if both
 * modules share one parser. Addresses are BigInts — IPv4 as its 32-bit value,
 * IPv6 as its 128-bit value — which makes prefix containment a mask compare.
 */

/** A parsed IP address. `text` is the canonical form (Python `str(ip)`). */
export interface IpAddress {
  version: 4 | 6;
  value: bigint;
  text: string;
}

/** A parsed network (Python `ip_network(..., strict=False)`). Host bits cleared. */
export interface IpNetwork {
  version: 4 | 6;
  prefix: number;
  base: bigint;
  contains(ip: IpAddress): boolean;
  toString(): string;
}

function hex4(n: bigint): string {
  return n.toString(16);
}

/** Canonical dotted-quad text for a 32-bit value. */
function formatIpv4(value: bigint): string {
  return [
    (value >> 24n) & 255n,
    (value >> 16n) & 255n,
    (value >> 8n) & 255n,
    value & 255n,
  ].join('.');
}

/** Canonical IPv6 text (RFC 5952-shaped: lowercase, longest zero run as `::`). */
function formatIpv6(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(hex4((value >> BigInt(i * 16)) & 0xffffn));
  }
  // Longest run of at least two zero groups becomes `::`.
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] === '0') {
      let j = i;
      while (j < 8 && groups[j] === '0') j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else {
      i++;
    }
  }
  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).map((g) => g.replace(/^0+/, '') || '0');
    const tail = groups.slice(bestStart + bestLen).map((g) => g.replace(/^0+/, '') || '0');
    return `${head.join(':')}::${tail.join(':')}`;
  }
  return groups.map((g) => g.replace(/^0+/, '') || '0').join(':');
}

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    // Leading zeros are rejected, matching modern Python's ipaddress (which
    // stopped accepting them in 3.9.5). The call sites fall back to hostname
    // treatment, exactly as they do for any non-address string.
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(s: string): bigint | null {
  let addr = s;
  // IPv4-mapped/embedded tail: `::ffff:192.0.2.1` — rewrite the dotted quad
  // as two hex groups, then parse uniformly.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.includes('.')) {
    const tail = addr.slice(lastColon + 1);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
      const v4 = parseIpv4(tail);
      if (v4 === null) return null;
      addr =
        addr.slice(0, lastColon + 1) +
        `${hex4((v4 >> 16n) & 0xffffn)}:${hex4(v4 & 0xffffn)}`;
    }
  }
  const dbl = addr.split('::');
  if (dbl.length > 2) return null;
  let groups: string[];
  if (dbl.length === 2) {
    const head = dbl[0] === '' ? [] : dbl[0].split(':');
    const tail = dbl[1] === '' ? [] : dbl[1].split(':');
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = addr.split(':');
    if (groups.length !== 8) return null;
  }
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** Parse an IP literal (v4 or v6); null when not an address. */
export function parseIpAddress(raw: string): IpAddress | null {
  const s = raw.trim();
  const v4 = parseIpv4(s);
  if (v4 !== null) return { version: 4, value: v4, text: formatIpv4(v4) };
  const v6 = parseIpv6(s);
  if (v6 !== null) return { version: 6, value: v6, text: formatIpv6(v6) };
  return null;
}

/**
 * Parse a network in CIDR form, or a bare address (which becomes /32 or /128).
 * Host bits are cleared (Python `strict=False`) so `10.0.0.1/24` is the
 * network `10.0.0.0/24`. Null when unparsable (Python's ValueError).
 */
export function parseIpNetwork(raw: string): IpNetwork | null {
  const s = raw.trim();
  let addrPart = s;
  let prefix: number | null = null;
  const slash = s.lastIndexOf('/');
  if (slash !== -1) {
    addrPart = s.slice(0, slash);
    if (!/^\d{1,3}$/.test(s.slice(slash + 1))) return null;
    prefix = Number(s.slice(slash + 1));
  }
  const ip = parseIpAddress(addrPart);
  if (ip === null) return null;
  const bits = ip.version === 4 ? 32 : 128;
  if (prefix === null) prefix = bits;
  if (prefix < 0 || prefix > bits) return null;
  const mask =
    prefix === 0
      ? 0n
      : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  const base = ip.value & mask;
  const net: IpNetwork = {
    version: ip.version,
    prefix,
    base,
    contains(candidate: IpAddress): boolean {
      return candidate.version === ip.version && (candidate.value & mask) === base;
    },
    toString(): string {
      const text = ip.version === 4 ? formatIpv4(base) : formatIpv6(base);
      return `${text}/${prefix}`;
    },
  };
  return net;
}

// === SECTION === static tables ===

/** Tools whose arguments commonly name a network target. */
export const NETWORK_TOOLS = new Set<string>([
  'curl', 'wget', 'nmap', 'ffuf', 'gobuster', 'feroxbuster', 'nikto',
  'masscan', 'nc', 'netcat', 'ncat', 'ssh', 'scp', 'sftp', 'socat',
  'dig', 'host', 'nslookup', 'whois', 'traceroute', 'tracepath', 'ping',
  'hydra', 'sqlmap', 'wfuzz', 'dirb', 'dnsrecon', 'amass', 'subfinder',
  'httpx', 'httprobe', 'nuclei', 'whatweb', 'wpscan', 'smbclient',
  'redis-cli', 'mongo', 'psql', 'mysql', 'telnet', 'openssl', 'arjun',
  'katana', 'gau', 'waybackurls', 'dalfox', 'commix', 'xsser',
  // Active Directory. Every one of these names a host — a DC, a member
  // server, a CA — in its arguments, and most of them in the impacket
  // `domain/user:pass@host` form rather than as a bare hostname. Without
  // them here `commandUsesNetworkTool` returns false, bare hostnames are
  // never extracted, and an out-of-scope DC is reachable through the whole
  // AD toolchain while the guard reports nothing. `ldapsearch` was the only
  // one the guard could already see, and only via an `ldap://` URL.
  'nxc', 'netexec', 'crackmapexec', 'certipy', 'bloodhound-python',
  'rusthound', 'ldapsearch', 'ldapmodify', 'ldapadd', 'kerbrute',
  'rpcclient', 'smbmap', 'enum4linux', 'enum4linux-ng', 'windapsearch',
  'gpp-decrypt', 'mitm6', 'responder', 'ntlmrelayx.py',
  // The impacket scripts, by both their bare name and the `impacket-`
  // console-script form the distro packages install.
  'psexec.py', 'wmiexec.py', 'smbexec.py', 'atexec.py', 'dcomexec.py',
  'secretsdump.py', 'GetUserSPNs.py', 'GetNPUsers.py', 'GetADUsers.py',
  'lookupsid.py', 'samrdump.py', 'rpcdump.py', 'reg.py', 'mssqlclient.py',
  'impacket-psexec', 'impacket-wmiexec', 'impacket-secretsdump',
  'impacket-GetUserSPNs', 'impacket-GetNPUsers', 'impacket-lookupsid',
  'impacket-samrdump', 'impacket-rpcdump', 'impacket-ntlmrelayx',
]);

/** Shell tokens that are never targets. */
const SHELL_NOISE = new Set([
  '|', '||', '&&', '&', ';', '>', '>>', '<', '2>', '2>>', '(', ')',
  'sudo', 'env', 'time', 'timeout', 'xargs', 'watch', 'do', 'then',
]);

const URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\s'"|;&)]+)/;
const HOSTPORT_RE = /^([a-zA-Z0-9_.-]+):(\d{1,5})$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV4_CIDR_RE = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;
// An optional trailing dot is the FQDN root: `evil.com.` resolves to `evil.com`,
// so it must be recognised as the same host rather than slipping past the guard.
const HOSTNAME_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?:\.[a-zA-Z0-9-]{1,63})+\.?$/;

// Shell substitution/expansion: the value is evaluated at runtime and never
// appears as a static token, so a host can be built dynamically. We cannot
// resolve it, so a network-tool command whose *only* targets are dynamic is
// treated as unresolvable and blocked (a command that also names a literal
// target is checked against that literal as usual).
const SUBSTITUTION_RE = /\$\(|\$\{|\$[A-Za-z_]|`/;

// The spans those substitutions occupy, removed whole. Used to answer "does
// this command name any *literal* target?" — the raw text cannot answer it,
// because a token like `$(cat` is captured by the URL regex as if it were a
// hostname, which would make a purely dynamic command look like it had a
// static target.
const SUBSTITUTION_SPAN_RE =
  /\$\([^)]*\)|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|`[^`]*`/g;

/** *command* with every substitution span removed. What remains is the
 *  static skeleton: the parts known before the shell runs. */
function stripSubstitutions(command: string): string {
  return command.replace(SUBSTITUTION_SPAN_RE, ' ');
}

// Tokens that look like flags or values, not hosts.
const FLAG_RE = /^--?[A-Za-z]/;
const VERSIONISH_RE = /^\d+(?:\.\d+)*$/;

// Impacket's canonical target syntax is `[domain/]user[:password]@host`, and
// a Windows UNC path is `\\host\share` (also written `//host/share`). Both
// carry a `/`, a `\` or an `@` by construction, so the "skip obvious
// filenames" rule below used to discard them before hostname matching was
// ever reached — which meant a DC named the impacket way was invisible to the
// deny-list even with the tool in NETWORK_TOOLS and the suffix in
// NEVER_A_FILE_EXT_TLDS. These two forms are peeled off *before* that rule
// runs. The host part of each is syntactically explicit, like a URL's, so
// both are always treated as targets rather than gated behind the
// network-context test.
const AT_HOST_RE = /@([a-zA-Z0-9_.-]+)\.?$/;
const UNC_RE = /^[\\/]{2}([a-zA-Z0-9_.-]+)/;
// The `domain/` half of impacket's target syntax. Requires a dot, so a path
// like `src/app.py` — where the left side is a bare directory name — cannot
// match. An AD domain is always dotted; a directory usually is not.
const IMPACKET_DOMAIN_RE = /^([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)\//;

// A bare dotted token (``evil.com``) is ambiguous: it may be a hostname or a
// filename (``report.json``). To avoid hard-blocking ordinary commands, a
// bare hostname only counts as a target when EITHER the command runs a known
// network tool, OR its final label is a TLD that is never a file extension.
// URLs, host:port pairs, IPs and CIDRs are always treated as targets.
const NEVER_A_FILE_EXT_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'dev', 'app', 'cloud', 'xyz', 'online',
  'site', 'tech', 'store', 'info', 'biz', 'me', 'tv', 'cc', 'ru', 'cn',
  'uk', 'de', 'fr', 'jp', 'au', 'ca', 'nl', 'eu', 'us', 'gov', 'edu',
  'mil', 'ai', 'gg', 'to', 'name', 'pro', 'mobi', 'asia', 'ac', 'am',
  'br', 'ch', 'es', 'fi', 'gr', 'hk', 'id', 'ie', 'il', 'it', 'kr',
  'mx', 'my', 'no', 'nz', 'ph', 'pl', 'pt', 'ro', 'se', 'sg', 'tr',
  'tw', 'ua', 'vn', 'za',
  // Internal AD suffixes. An on-prem domain is almost never a public TLD —
  // it is `corp.local`, `ad.internal`, `lab.lan` — so without these a DC
  // hostname never clears the file-extension test and the deny-list cannot
  // see it. None of these is a plausible file extension, which is the bar
  // this set has to clear: `foo.local` is a host, `foo.json` is not.
  'local', 'internal', 'corp', 'lan', 'intranet', 'home', 'ad', 'ds',
  'loc', 'dom',
]);

// Shell metacharacters that split a command into independently-executed pieces.
const PIPE_SPLIT_RE = /\|\||&&|[|;&\n]/;
// Commands that prefix the real one without changing which binary runs.
const PREFIX_WORDS = new Set([
  'sudo', 'env', 'time', 'timeout', 'nohup', 'command', 'xargs', 'watch',
]);

/**
 * YAML keys accepted for each kind of entry. Singular is the documented form;
 * the plural and the older `scope.yaml` spellings are accepted so an existing
 * file keeps parsing. Exported as one object because scope-validator reads
 * the same sets (Python imported the three private tuples across modules).
 */
export const SCOPE_KEY_SETS = {
  domain: ['domain', 'domains', 'in_scope'],
  ip: ['ip', 'ips', 'hosts'],
  cidr: ['cidr', 'cidrs', 'networks'],
} as const;

/** Strip any of *chars* from both ends of *s* (Python `str.strip(chars)`). */
function stripChars(s: string, chars: string): string {
  const set = new Set(chars);
  let start = 0;
  let end = s.length;
  while (start < end && set.has(s[start]!)) start++;
  while (end > start && set.has(s[end - 1]!)) end--;
  return s.slice(start, end);
}

// === SECTION === violation / host set ===

/** One deny-list hit: the offending target and why it matched. */
export class ScopeViolation {
  readonly target: string;
  readonly reason: string;

  constructor(target: string, reason: string) {
    this.target = target;
    this.reason = reason;
  }

  /** Python `__str__`. tools.ts reaches this via String(v) in violationText. */
  toString(): string {
    return `${this.target} — ${this.reason}`;
  }
}

/** A parsed set of domains, IPs and CIDRs, and the matching rules for it. */
export class HostSet {
  domains: Set<string> = new Set();
  ips: Set<string> = new Set();
  cidrs: IpNetwork[] = [];

  static fromMapping(data: unknown): HostSet {
    const hs = new HostSet();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return hs;
    }
    const map = data as Record<string, unknown>;

    const collect = (value: unknown): string[] => {
      if (value === null || value === undefined) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.map((v) => String(v));
      return [];
    };

    for (const key of SCOPE_KEY_SETS.domain) {
      for (const entry of collect(map[key])) {
        const host = HostSet.normaliseHost(entry);
        if (host) hs.domains.add(host);
      }
    }

    for (const key of SCOPE_KEY_SETS.ip) {
      for (const raw of collect(map[key])) {
        const entry = raw.trim();
        if (IPV4_CIDR_RE.test(entry) || (entry.includes(':') && entry.includes('/'))) {
          const net = parseIpNetwork(entry);
          if (net !== null) {
            hs.cidrs.push(net);
            continue;
          }
        }
        if (IPV4_RE.test(entry)) {
          hs.ips.add(entry);
        } else {
          const host = HostSet.normaliseHost(entry);
          if (host) hs.domains.add(host);
        }
      }
    }

    for (const key of SCOPE_KEY_SETS.cidr) {
      for (const raw of collect(map[key])) {
        const net = parseIpNetwork(raw.trim());
        if (net === null) continue;
        hs.cidrs.push(net);
      }
    }
    return hs;
  }

  private static normaliseHost(entry: string): string {
    let e = entry.trim().toLowerCase();
    if (!e) return '';
    e = e.split('://').pop() ?? e;
    e = e.split('/')[0]!;
    e = e.split(':')[0]!;
    return stripChars(stripChars(e, '*.'), '.');
  }

  get empty(): boolean {
    return this.domains.size === 0 && this.ips.size === 0 && this.cidrs.length === 0;
  }

  get length(): number {
    return this.domains.size + this.ips.size + this.cidrs.length;
  }

  /**
   * Return [isMember, reason] for a host/IP against this set.
   *
   * Polarity-neutral on purpose: membership means "permitted" for an
   * allow-list and "blocked" for a deny-list, so callers decide what a match
   * implies. Keeping this neutral is what stops the two lists from silently
   * inverting each other.
   *
   * IP comparison matches Python exactly: the INPUT is canonicalised
   * (str(ip_address(...))) and compared against the stored strings as
   * written — a yaml entry in normal form matches itself, which is the only
   * case that ever fired in practice.
   */
  contains(host: string): [boolean, string] {
    let h = host.trim().toLowerCase();
    h = stripChars(h, '[]');
    h = h.replace(/\.+$/, '');
    if (!h) return [false, 'empty'];

    // Loopback/localhost is always considered infrastructure, not a target,
    // so it is never a member of either list.
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') {
      return [false, 'local'];
    }

    const ip = parseIpAddress(h);
    if (ip !== null) {
      if (this.ips.has(ip.text)) return [true, 'listed ip'];
      for (const net of this.cidrs) {
        if (net.contains(ip)) return [true, `in ${net.toString()}`];
      }
      return [false, 'ip not listed'];
    }

    // Hostname: exact, or subdomain of a listed domain.
    if (this.domains.has(h)) return [true, 'listed domain'];
    for (const dom of this.domains) {
      if (h === dom || h.endsWith('.' + dom)) return [true, `subdomain of ${dom}`];
    }
    return [false, 'host not listed'];
  }

  describe(): string {
    if (this.empty) return 'empty';
    return `${this.length} entries (${this.domains.size}d/${this.ips.size}i/${this.cidrs.length}n)`;
  }
}

// === SECTION === Scope ===

/** The session's target scope: an allow-list and a deny-list. */
export class Scope {
  allowPath: string | null = null;
  denyPath: string | null = null;
  allow: HostSet = new HostSet();
  deny: HostSet = new HostSet();
  /** Set when a legacy `scope.yaml` was found, so the UI can say so once. */
  legacyPath: string | null = null;

  // ---- construction -----------------------------------------------------
  static load(allowPath?: string | null, denyPath?: string | null): Scope {
    const scope = new Scope();
    if (allowPath != null) {
      const p = expandTilde(allowPath);
      if (existsSync(p)) {
        scope.allowPath = p;
        scope.allow = HostSet.fromMapping(readYaml(p));
      }
    }
    if (denyPath != null) {
      const p = expandTilde(denyPath);
      if (existsSync(p)) {
        scope.denyPath = p;
        scope.deny = HostSet.fromMapping(readYaml(p));
      }
    }
    return scope;
  }

  // ---- queries ----------------------------------------------------------
  /** True when allow.yaml is present: tools run without confirmation. */
  get armed(): boolean {
    return this.allowPath !== null;
  }

  /** True when either file is present. */
  get loaded(): boolean {
    return this.allowPath !== null || this.denyPath !== null;
  }

  /** Whether *host* is one of the operator's declared targets. */
  inAllow(host: string): [boolean, string] {
    if (!this.armed) return [false, 'no allow.yaml'];
    return this.allow.contains(host);
  }

  /** Whether *host* may be reached: not deny-listed. Deny beats allow. */
  allows(host: string): [boolean, string] {
    if (!this.loaded) return [true, 'no scope files'];
    const [denied, reason] = this.deny.contains(host);
    if (denied) return [false, `denied — ${reason}`];
    return [true, 'not denied'];
  }

  // ---- scanning ---------------------------------------------------------
  /** Return the deny-list violations for *command*; empty means allowed. */
  checkCommand(command: string): ScopeViolation[] {
    if (this.denyPath === null) return [];

    const violations: ScopeViolation[] = [];
    const seen = new Set<string>();

    // Runtime command substitution builds a target the token scan can never
    // see. If the command runs a network tool and names no *literal* target,
    // the target is unresolvable — fail closed and refuse the command.
    // Handled here rather than in HostSet.contains because membership is
    // polarity-neutral: only the deny-list has a reason to fail closed.
    //
    // The literal check runs against the substitution-stripped skeleton, not
    // the raw text: in `curl https://$(cat t)/` the URL regex happily
    // captures `$(cat` as a "host", so a raw scan would report a target and
    // let the command through.
    const targets = this.extractTargets(command);
    const literal = this.extractTargets(stripSubstitutions(command));
    if (
      literal.length === 0 &&
      SUBSTITUTION_RE.test(command) &&
      Scope.commandUsesNetworkTool(command)
    ) {
      return [
        new ScopeViolation(
          '<command substitution>',
          'unresolvable target (command substitution)',
        ),
      ];
    }

    for (const host of targets) {
      if (seen.has(host)) continue;
      seen.add(host);
      const [denied, reason] = this.deny.contains(host);
      if (denied) violations.push(new ScopeViolation(host, reason));
    }
    return violations;
  }

  /**
   * Best-effort extraction of network targets from a shell command.
   *
   * Unambiguous targets (URLs, host:port, IPs, CIDRs) are always returned.
   * Bare dotted hostnames are only returned when the command runs a known
   * network tool or the final label is a domain-only TLD — otherwise a
   * filename like `report.json` would be mistaken for a host.
   */
  extractTargets(command: string, networkContext?: boolean | null): string[] {
    const inNetworkContext =
      networkContext ?? Scope.commandUsesNetworkTool(command);

    const targets: string[] = [];

    // 1. Explicit URLs — unambiguous.
    for (const m of command.matchAll(new RegExp(URL_RE.source, 'g'))) {
      const rest = m[2] ?? '';
      let host = rest.split('/')[0]!.split('?')[0]!.split('@').pop() ?? '';
      host = host.split(':')[0]!;
      if (host) targets.push(host);
    }

    // 2. Token scan.
    for (const raw of command.split(/\s+/)) {
      const tok = stripChars(raw, "'\"`,");
      if (!tok || SHELL_NOISE.has(tok)) continue;
      if (FLAG_RE.test(tok)) {
        // Flags can still embed a URL (e.g. --url=https://x)
        if (tok.includes('=')) {
          const val = tok.slice(tok.indexOf('=') + 1);
          const m = URL_RE.exec(val);
          if (m) {
            const h = (m[2] ?? '').split('/')[0]!.split(':')[0]!;
            if (h) targets.push(h);
          }
        }
        continue;
      }

      const hp = HOSTPORT_RE.exec(tok);
      if (hp) {
        targets.push(hp[1]!);
        continue;
      }

      if (IPV4_CIDR_RE.test(tok)) {
        targets.push(tok.split('/')[0]!);
        continue;
      }

      if (IPV4_RE.test(tok)) {
        targets.push(tok);
        continue;
      }

      if (tok.includes('://')) {
        const h = tok.split('://')[1]!.split('/')[0]!.split(':')[0]!;
        if (h) targets.push(h);
        continue;
      }

      // Impacket target syntax: `corp.local/j.doe:Passw0rd@dc01.corp.local`.
      // Both halves are targets and both are explicit, so this runs before
      // the filename rule that would otherwise eat the token for its `/`.
      // The domain half matters as much as the host: a deny-list names the
      // domain, and `-dc-ip` frequently carries an address the operator
      // never wrote down anywhere else.
      const dom = IMPACKET_DOMAIN_RE.exec(tok);
      if (dom) targets.push(dom[1]!);
      // `@host` ends the target: `j.doe@corp.local` has a domain on the
      // left that is a *username*, not a host, so only the tail counts.
      const at = AT_HOST_RE.exec(tok);
      if (at) {
        targets.push(at[1]!);
        continue;
      }
      // A domain half with no `@host` after it — `corp.local/j.doe:Pass`.
      // Already recorded above, and it carries a `/`, so stop here rather
      // than letting the filename rule below reconsider it.
      if (IMPACKET_DOMAIN_RE.test(tok)) continue;

      // UNC path: `//dc01.corp.local/SYSVOL` or `\\dc01\SYSVOL`. The host
      // is the first component, and a UNC path is never a filename.
      const unc = UNC_RE.exec(tok);
      if (unc) {
        targets.push(unc[1]!);
        continue;
      }

      if (HOSTNAME_RE.test(tok) && !VERSIONISH_RE.test(tok)) {
        // `evil.com.` is the same host as `evil.com`; strip the root dot
        // before the tail/TLD checks so the FQDN form can't slip through.
        const bare = tok.replace(/\.+$/, '');
        const tail = (bare.split('.').pop() ?? '').toLowerCase();
        if (!(tail.length >= 2 && /^[a-z]+$/.test(tail))) continue;
        // Skip obvious filenames: has a directory part, starts with a
        // path marker, or the tail is a file extension rather than a TLD.
        // The impacket and UNC forms were peeled off above, so a `/` here
        // really is a directory separator and not a target delimiter.
        if (tok.includes('/') || tok.includes('\\') || tok.startsWith('.')) continue;
        if (inNetworkContext || NEVER_A_FILE_EXT_TLDS.has(tail)) targets.push(bare);
      }
    }
    return targets;
  }

  /** True if any segment of *command* invokes a known network binary. */
  static commandUsesNetworkTool(command: string): boolean {
    for (const segment of command.split(PIPE_SPLIT_RE)) {
      const words = segment.trim().split(/\s+/).filter((w) => w.length > 0);
      // Strip leading assignments (FOO=bar cmd) and prefix words.
      while (words.length > 0 && words[0]!.includes('=') && !words[0]!.startsWith('-')) {
        words.shift();
      }
      while (words.length > 0 && PREFIX_WORDS.has(words[0]!)) words.shift();
      if (words.length === 0) continue;
      const binary = words[0]!.split('/').pop()!;
      if (NETWORK_TOOLS.has(binary)) return true;
    }
    return false;
  }

  // ---- presentation -----------------------------------------------------
  describe(): string {
    if (!this.loaded) return 'off — no scope files';
    const bits: string[] = [];
    bits.push(this.armed ? `allow: ${this.allow.describe()}` : 'allow: none');
    if (this.denyPath !== null) bits.push(`deny: ${this.deny.describe()}`);
    return bits.join(' · ');
  }

  /** One short string for the header. */
  badge(): string {
    if (this.armed && this.denyPath !== null) return `ARMED + deny ${this.deny.length}`;
    if (this.armed) return 'ARMED';
    if (this.denyPath !== null) return `deny ${this.deny.length}`;
    return 'off';
  }
}

function readYaml(pathStr: string): Record<string, unknown> {
  try {
    const data = parseYaml(readFileSync(pathStr, 'utf8')) ?? {};
    return typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A leftover `scope.yaml`, which no longer means anything.
 *
 * The old file was an allow-list that also blocked; reinterpreting it as a
 * deny-list would block the very hosts the operator had declared. So it is
 * never read — only reported, once, so the split is not silent.
 */
export function findLegacyScope(workdir: string, home?: string): string | undefined {
  for (const name of ['scope.yaml', 'scope.yml']) {
    const candidate = path.join(workdir, name);
    if (existsSync(candidate)) return candidate;
  }
  if (home !== undefined) {
    const candidate = path.join(home, '.andy', 'scope.yaml');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
