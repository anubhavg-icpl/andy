/**
 * scope-validator.ts — `/scope-validator`: turn a pasted bug-bounty programme
 * overview into scope files.
 *
 * What this module is: the three-step bootstrap over scope.ts (port of
 * zimzilla/scope_validator.py). (1) EXTRACT the structured scope with a model
 * pass; (2) WRITE allow.yaml / out-of-scope.yaml in the format scope.ts
 * reads, then load them back through Scope.load so an unparsable file is
 * reported, not trusted; (3) RANK the in-scope assets as a tree after a
 * light read-only recon of each host (DNS, HTTP status, title, server).
 * Nothing here is a judgement the code makes on its own: parsing, writing
 * and rendering are deterministic; the ranking comes from the model and is
 * shown as the model's.
 *
 * Invariants:
 *  - Nothing is written from prose; only what the model reports as a
 *    structured entry reaches the scope files, and anything unplaceable is
 *    returned in `skipped` so the operator sees it — never a silent drop.
 *  - ui/app's ScopeValidatorModule pins allow/deny as pre-serialised YAML
 *    STRINGS (buildScope dumps; writeScopeFiles writes header + body
 *    verbatim). The Python pair passed dicts and dumped in write_scope_files;
 *    the seam moved with the port, the file contents did not.
 *  - recon is read-only: one DNS lookup and one GET per host, no ports, no
 *    redirects followed, no payloads. A deny-listed host is skipped before
 *    any socket opens, because these requests are made by the harness itself
 *    where the agent's bash guard cannot see them.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { stringify as stringifyYaml } from 'yaml';
import { Scope, parseIpAddress, parseIpNetwork } from './scope.js';

/** Cap on how many in-scope assets get recon. Keeps a huge programme from
 *  turning one command into a few hundred requests. */
export const RECON_MAX_HOSTS = 25;

/** Per-host network timeout, seconds. */
export const RECON_TIMEOUT = 6.0;

const IPV4_CLASSIFY_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_CLASSIFY_RE = /^(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

// === SECTION === prompts ===

/** The extraction prompt over a pasted programme overview. Python exposed a
 *  str.format template; the TS port exposes the filled call directly. */
export function EXTRACT_PROMPT(opts: { overview: string }): string {
  return `You are reading a bug-bounty programme overview to extract its scope. The text
is below between the markers. Do not run any tools, and do not test anything.

<<<OVERVIEW
${opts.overview}
OVERVIEW>>>

Return ONE JSON object and nothing else:

{"programme": "name of the programme, or empty",
 "in_scope": [{"asset": "exact asset as written, e.g. *.example.com or 10.0.0.0/24",
               "type": "domain | wildcard | ip | cidr | other",
               "note": "short note from the overview, e.g. 'web, bounty eligible'"}],
 "out_of_scope": [{"asset": "exact asset as written", "type": "domain | wildcard | ip | cidr | other",
                   "note": "why, if stated"}],
 "rules": ["short rule from the overview, e.g. 'no automated scanning above N rps'"]}

Rules for the extraction:
- Only assets the overview states. Do not add hosts from your own knowledge.
- Keep wildcards as written (*.example.com). Keep out-of-scope entries separate
  from in-scope ones even when they look similar.
- Use "other" for anything that is not a domain, wildcard, IP or CIDR (an app
  name, a mobile bundle, a feature). Those are not written to the scope files.
- Empty lists are fine. Do not invent entries to fill them.
`;
}

/** The ranking prompt over the in-scope assets plus their recon evidence. */
export function RANK_PROMPT(opts: { programme: string; assets: string }): string {
  return `You are ranking the in-scope assets of a bug-bounty programme for testing order.
Below are the assets, and for each host a read-only recon result (DNS, HTTP
status, page title, server header). Judge from this evidence only.

Programme: ${opts.programme}

ASSETS
${opts.assets}

Return ONE JSON object and nothing else:

{"ranking": [{"asset": "exact asset",
              "rank": 1,
              "value": "high | medium | low",
              "why": "one line, citing the evidence (title, status, tech, or the note)"}],
 "summary": "one line on where to start"}

Rank by likely bug density and reward, not by how the list was written. A login
page, an admin or API surface, a file-upload or a legacy-looking stack ranks
above a static marketing page. Say when the evidence is too thin to rank an
asset and rank it low with that reason. Include every asset exactly once.
`;
}

// === SECTION === parsing ===

/** One asset the model reported, as it was written. */
export class ScopeEntry {
  asset: string;
  type: string;
  note: string;

  constructor(asset: string, type = 'other', note = '') {
    this.asset = asset;
    this.type = type;
    this.note = note;
  }
}

/** The model's whole extraction. */
export class Extraction {
  programme: string;
  inScope: ScopeEntry[];
  outOfScope: ScopeEntry[];
  rules: string[];

  constructor(
    programme = '',
    inScope: ScopeEntry[] = [],
    outOfScope: ScopeEntry[] = [],
    rules: string[] = [],
  ) {
    this.programme = programme;
    this.inScope = inScope;
    this.outOfScope = outOfScope;
    this.rules = rules;
  }
}

/** One ranked asset. `rank` is renumbered densely after parsing. */
export class Ranked {
  asset: string;
  rank: number;
  value: string;
  why: string;

  constructor(asset: string, rank: number, value: string, why = '') {
    this.asset = asset;
    this.rank = rank;
    this.value = value;
    this.why = why;
  }
}

/** The first JSON object in a model reply, fenced or bare. */
function jsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try {
      const data = JSON.parse(m[1]!);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      // fall through to the next fence / bare-brace scan
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(text.slice(start, end + 1));
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function cleanAsset(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
}

function entries(raw: unknown): ScopeEntry[] {
  const out: ScopeEntry[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const itemRaw of raw) {
    let item = itemRaw;
    if (typeof item === 'string') item = { asset: item };
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const asset = cleanAsset(rec['asset']);
    if (!asset || seen.has(asset.toLowerCase())) continue;
    seen.add(asset.toLowerCase());
    out.push(
      new ScopeEntry(
        asset,
        String(rec['type'] ?? 'other').trim().toLowerCase(),
        String(rec['note'] ?? '').trim(),
      ),
    );
  }
  return out;
}

/** The model's extraction, or null if the reply cannot be read. */
export function parseExtraction(text: string): Extraction | null {
  const data = jsonObject(text);
  if (data === null) return null;
  const rulesRaw = data['rules'] ?? [];
  return new Extraction(
    String(data['programme'] ?? '').trim(),
    entries(data['in_scope']),
    entries(data['out_of_scope']),
    Array.isArray(rulesRaw)
      ? rulesRaw.map((r) => String(r).trim()).filter((r) => r.length > 0)
      : [],
  );
}

/** The model's ranking, or null if unreadable. Every asset gets a place.
 *
 *  An asset the model left out is appended at the bottom, marked as unranked,
 *  rather than dropped — a silently missing host is the worst outcome for a
 *  scope list. */
export function parseRanking(text: string, assets: string[]): [Ranked[], string] | null {
  const data = jsonObject(text);
  if (data === null) return null;
  const ranked: Ranked[] = [];
  const seen = new Set<string>();
  const rankingRaw = data['ranking'];
  if (Array.isArray(rankingRaw)) {
    for (const item of rankingRaw) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const asset = cleanAsset(rec['asset']);
      if (!asset || !assets.includes(asset) || seen.has(asset)) continue;
      seen.add(asset);
      const rankNum = Number(rec['rank'] ?? 0);
      ranked.push(
        new Ranked(
          asset,
          Number.isFinite(rankNum) ? Math.trunc(rankNum) : 0,
          String(rec['value'] ?? 'low').trim().toLowerCase(),
          String(rec['why'] ?? '').trim(),
        ),
      );
    }
  }
  ranked.sort((a, b) => {
    const ra = a.rank > 0 ? a.rank : 1_000_000;
    const rb = b.rank > 0 ? b.rank : 1_000_000;
    if (ra !== rb) return ra - rb;
    // Python sorts ties by code point, not locale — keep the tie order
    // deterministic across machines.
    return a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
  });
  for (const a of assets) {
    if (!seen.has(a)) {
      ranked.push(new Ranked(a, 0, 'unranked', 'the model did not rank this asset'));
    }
  }
  // Renumber densely so the tree reads 1..n even if the model skipped numbers.
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
  return [ranked, String(data['summary'] ?? '').trim()];
}

// === SECTION === classification and scope files ===

/** The hostname of a URL, lowercased, brackets stripped — or ''. */
function urlHostname(u: string): string {
  try {
    return new URL(u).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * `domain`, `wildcard`, `ip`, `cidr` or `other` for one asset.
 *
 * URLs are classified by their host, so `https://x.io/path` is a domain, not
 * a CIDR. IPs and networks are parsed with the scope.ts IP layer, not
 * regexes, so IPv6 and malformed input are judged the same way the guard
 * judges them.
 */
function classify(asset: string): 'domain' | 'wildcard' | 'ip' | 'cidr' | 'other' {
  let a = asset.trim().toLowerCase();
  if (a.includes('://')) a = urlHostname(a);
  if (!a) return 'other';
  if (a.includes('/')) {
    if (parseIpNetwork(a) !== null) return 'cidr';
    a = a.split('/')[0]!;
  }
  if (parseIpAddress(a.replace(/^\[+|\]+$/g, '')) !== null) return 'ip';
  const host = a.split(':')[0]!.replace(/\*\./g, '').replace(/\.+$/, '');
  if (IPV4_CLASSIFY_RE.test(host)) {
    return 'other'; // an address-shaped string that is not a valid address
  }
  if (/^\*\./.test(a)) {
    return HOST_CLASSIFY_RE.test(host) ? 'wildcard' : 'other';
  }
  return HOST_CLASSIFY_RE.test(host) ? 'domain' : 'other';
}

/** The bare hostname of an in-scope domain or wildcard, or '' if none. */
export function hostOf(asset: string): string {
  if (classify(asset) !== 'domain' && classify(asset) !== 'wildcard') return '';
  let a = asset.trim().toLowerCase();
  if (a.includes('://')) a = urlHostname(a);
  a = a.split('/')[0]!.split(':')[0]!.replace(/\*\./g, '').replace(/^\.+|\.+$/g, '');
  return HOST_CLASSIFY_RE.test(a) ? a : '';
}

/**
 * The two YAML bodies to write (as text — see the module contract block) and
 * the assets that could not be placed.
 *
 * Keys match what `HostSet.fromMapping` reads: `domains` for names and
 * wildcards, `ips` for addresses, `cidrs` for networks. Anything else is
 * returned in the skipped list so the operator sees it, not a silent drop.
 */
export function buildScope(
  entriesIn: ScopeEntry[],
  entriesOut: ScopeEntry[],
): [string, string, string[]] {
  const skipped: string[] = [];

  const bucket = (list: ScopeEntry[]): string => {
    const domains: string[] = [];
    const ips: string[] = [];
    const cidrs: string[] = [];
    for (const e of list) {
      const kind = classify(e.asset);
      if (kind === 'domain' || kind === 'wildcard') {
        const host = hostOf(e.asset);
        if (host) {
          if (!domains.includes(host)) domains.push(host);
        } else {
          skipped.push(e.asset);
        }
      } else if (kind === 'ip') {
        if (!ips.includes(e.asset)) ips.push(e.asset);
      } else if (kind === 'cidr') {
        if (!cidrs.includes(e.asset)) cidrs.push(e.asset);
      } else {
        skipped.push(e.asset);
      }
    }
    const out: Record<string, string[]> = {};
    if (domains.length) out['domains'] = domains;
    if (ips.length) out['ips'] = ips;
    if (cidrs.length) out['cidrs'] = cidrs;
    return stringifyYaml(out);
  };

  return [bucket(entriesIn), bucket(entriesOut), skipped];
}

function header(kind: string, programme: string): string {
  const who = programme ? ` for ${programme}` : '';
  return (
    `# ${kind}${who}\n` +
    '# Written by /scope-validator from a pasted programme overview.\n' +
    '# Review before you run anything — the operator owns this list.\n'
  );
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Write `allow.yaml` and `out-of-scope.yaml` into *dest*.
 *
 * Refuses to overwrite an existing file. The operator may already have a
 * hand-edited scope, and replacing it silently would discard their work — so
 * an existing file is moved aside with a timestamp first, and the move is
 * reported (the caller lists `moved_aside`; the rename is visible on disk).
 */
export function writeScopeFiles(
  dest: string,
  allow: string,
  deny: string,
  programme = '',
): [string, string] {
  mkdirSync(dest, { recursive: true });
  const stamp = timestamp();
  const paths: string[] = [];
  for (const [name, body, kind] of [
    ['allow.yaml', allow, 'allow.yaml — declared targets'],
    ['out-of-scope.yaml', deny, 'out-of-scope.yaml — never touched'],
  ] as const) {
    const p = path.join(dest, name);
    if (existsSync(p)) renameSync(p, path.join(dest, `${name}.bak-${stamp}`));
    writeFileSync(p, header(kind, programme) + body);
    paths.push(p);
  }
  return [paths[0]!, paths[1]!];
}

/**
 * Load the written files back through the real guard. Returns problems.
 *
 * An empty list means the guard reads exactly what was written. Anything
 * else is reported as a problem rather than trusted.
 */
export function verifyScopeFiles(allowPath: string, denyPath: string): string[] {
  const problems: string[] = [];
  const scope = Scope.load(allowPath, denyPath);
  if (scope.allowPath === null) {
    problems.push('allow.yaml did not load');
  } else if (scope.allow.empty) {
    problems.push('allow.yaml loaded with no entries');
  }
  if (existsSync(denyPath) && scope.denyPath === null) {
    problems.push('out-of-scope.yaml did not load');
  }
  return problems;
}

// === SECTION === recon (read-only) ===

/** What one host's read-only recon saw. */
export class HostRecon {
  host: string;
  resolves = false;
  ip = '';
  status: number | null = null;
  title = '';
  server = '';
  error = '';

  constructor(host: string) {
    this.host = host;
  }
}

function pageTitle(body: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body.slice(0, 65536));
  if (!m) return '';
  return m[1]!.replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** An error's most diagnosable short name (node codes beat class names). */
function errName(e: unknown): string {
  if (e && typeof e === 'object') {
    const rec = e as { code?: unknown; name?: unknown };
    if (typeof rec.code === 'string' && rec.code) return rec.code;
    if (typeof rec.name === 'string' && rec.name) return rec.name;
  }
  return 'Error';
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One GET over http/https — no redirects followed, body capped at 64 KiB. */
function oneGet(
  scheme: 'https' | 'http',
  host: string,
  timeout: number,
): Promise<[number | null, string, string]> {
  return new Promise((resolve, reject) => {
    const lib = scheme === 'https' ? https : http;
    const req = lib.request(
      {
        host,
        path: '/',
        method: 'GET',
        headers: { 'User-Agent': 'andy-scope-validator' },
        timeout: timeout * 1000,
      },
      (res) => {
        const status = res.statusCode ?? null;
        const server = String(res.headers['server'] ?? '');
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve([status, server, Buffer.concat(chunks).toString('utf8')]);
        };
        res.on('data', (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= 65536) {
            // Title lives in the first 64 KiB; stop reading there.
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', (e) => {
          if (settled) return;
          settled = true;
          reject(e);
        });
      },
    );
    req.on('timeout', () => {
      const err = new Error('timeout') as NodeJS.ErrnoException;
      err.code = 'TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/**
 * DNS, then one HTTPS GET (HTTP on failure). Read-only: no ports scanned.
 *
 * Nothing here follows redirects off-host or sends a payload; it is one GET
 * to the host the programme names, which is what the operator asked to look
 * at. node:http/https (not fetch) because fetch follows redirects silently.
 */
export async function reconHost(host: string, timeout: number = RECON_TIMEOUT): Promise<HostRecon> {
  const r = new HostRecon(host);
  try {
    r.ip = (await dns.lookup(host)).address;
    r.resolves = true;
  } catch (e) {
    r.error = `dns: ${errText(e)}`;
    return r;
  }

  for (const scheme of ['https', 'http'] as const) {
    try {
      const [status, server, body] = await oneGet(scheme, host, timeout);
      r.status = status;
      r.server = server.slice(0, 60);
      r.title = pageTitle(body);
      r.error = '';
      return r;
    } catch (e) {
      // Recon must report, not crash.
      r.error = `${scheme}: ${errName(e)}`;
    }
  }
  return r;
}

/**
 * Recon the in-scope hosts, never an out-of-scope one.
 *
 * The harness makes these requests itself, so the agent's bash guard does not
 * see them. The deny-list is therefore checked here, before any socket opens:
 * a host the operator marked out of scope is skipped, and reported as skipped
 * (by its absence from the returned map).
 */
export async function reconAll(
  hosts: string[],
  deny?: Scope | null,
  timeout: number = RECON_TIMEOUT,
): Promise<Record<string, HostRecon>> {
  const out: Record<string, HostRecon> = {};
  for (const h of hosts.slice(0, RECON_MAX_HOSTS)) {
    if (deny != null && !deny.deny.empty) {
      const [blocked] = deny.deny.contains(h);
      if (blocked) continue;
    }
    out[h] = await reconHost(h, timeout);
  }
  return out;
}

export function reconLine(r: HostRecon): string {
  if (!r.resolves) return `does not resolve (${r.error})`;
  const bits = [r.ip];
  if (r.status !== null) bits.push(`HTTP ${r.status}`);
  if (r.server) bits.push(r.server);
  if (r.title) bits.push(`"${r.title}"`);
  if (r.status === null && r.error) bits.push(`no response (${r.error})`);
  return bits.join(' · ');
}

export function rankPrompt(
  programme: string,
  assets: string[],
  recon: Record<string, HostRecon>,
): string {
  const lines: string[] = [];
  for (const a of assets) {
    const host = hostOf(a);
    const ev = host in recon ? reconLine(recon[host]!) : 'no recon (not a named host)';
    lines.push(`- ${a}\n    recon: ${ev}`);
  }
  return RANK_PROMPT({
    programme: programme || '(unnamed)',
    assets: lines.join('\n'),
  });
}

// === SECTION === tree ===

const VALUE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, unranked: 3 };

/** The ranked tree as plain text. Also used by the UI for its rich render. */
export function renderPlainTree(
  programme: string,
  ranked: Ranked[],
  recon: Record<string, HostRecon>,
  outOfScope: ScopeEntry[],
): string {
  const lines = [programme || 'programme'];
  lines.push('├─ IN SCOPE — test in this order');
  ranked.forEach((r, i) => {
    const last = i === ranked.length - 1;
    const branch = last ? '└─' : '├─';
    lines.push(`│  ${branch} #${r.rank} [${r.value}] ${r.asset}`);
    const pad = last ? '      ' : '│     ';
    const host = hostOf(r.asset);
    if (host in recon) lines.push(`${pad}  ${reconLine(recon[host]!)}`);
    if (r.why) lines.push(`${pad}  why: ${r.why}`);
  });
  lines.push(`└─ OUT OF SCOPE — never touched (${outOfScope.length})`);
  outOfScope.forEach((e, i) => {
    const branch = i === outOfScope.length - 1 ? '└─' : '├─';
    lines.push(`   ${branch} ${e.asset}` + (e.note ? ` — ${e.note}` : ''));
  });
  return lines.join('\n');
}

/** Everything one /scope-validator run produced. */
export class Report {
  extraction: Extraction;
  /** YAML bodies (text — see module contract block). */
  allow: string;
  deny: string;
  skipped: string[];
  recon: Record<string, HostRecon>;
  ranked: Ranked[];
  rankSummary: string;
  problems: string[];
  allowPath: string | null;
  denyPath: string | null;
  movedAside: string[];

  constructor(
    extraction: Extraction,
    allow = '',
    deny = '',
    skipped: string[] = [],
    recon: Record<string, HostRecon> = {},
    ranked: Ranked[] = [],
    rankSummary = '',
    problems: string[] = [],
    allowPath: string | null = null,
    denyPath: string | null = null,
    movedAside: string[] = [],
  ) {
    this.extraction = extraction;
    this.allow = allow;
    this.deny = deny;
    this.skipped = skipped;
    this.recon = recon;
    this.ranked = ranked;
    this.rankSummary = rankSummary;
    this.problems = problems;
    this.allowPath = allowPath;
    this.denyPath = denyPath;
    this.movedAside = movedAside;
  }
}
