// tests/test_scope_validator.test.ts — vitest port of tests/test_scope_validator.py.
// What this file is: /scope-validator's parsing, scope-file writing, the recon
// deny guard, ranking and the tree. Runs without a model or the network: the
// model reply is a fixture, and recon is checked through the deny-list gate
// before any socket would open.
// Port note: Python reached sv._classify directly; the TS port keeps classify
// module-private (PORT-MAP), so classification is pinned through buildScope's
// placement — the same judgement, observed at its public effect. Likewise the
// recon test monkeypatched sv.recon_host; an ES module's internal call cannot
// be intercepted, so the ONE network dependency recon_host uses (DNS) is
// mocked instead, which pins the deny gate even tighter — at the syscall seam.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const dnsLookup = vi.hoisted(() =>
  vi.fn(async (...args: unknown[]) => {
    throw Object.assign(new Error('getaddrinfo EAI_NONAME'), { code: 'EAI_NONAME' });
  }),
);

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  // default-import and named-import shapes both route to the same mock.
  return { ...actual, lookup: dnsLookup, default: { ...actual, lookup: dnsLookup } };
});

import * as sv from '../src/scope-validator.js';
import { HostSet, Scope } from '../src/scope.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'andy-scopeval-'));
}

const OVERVIEW_REPLY = `Here is the scope:
\`\`\`json
{"programme": "Acme Bounty",
 "in_scope": [
   {"asset": "*.acme.com", "type": "wildcard", "note": "web"},
   {"asset": "api.acme.io", "type": "domain", "note": "api"},
   {"asset": "203.0.113.10", "type": "ip", "note": "vpn"},
   {"asset": "198.51.100.0/24", "type": "cidr", "note": "lab"},
   {"asset": "Acme iOS app", "type": "other", "note": "mobile"}
 ],
 "out_of_scope": [
   {"asset": "status.acme.com", "type": "domain", "note": "third party"},
   {"asset": "*.staging.acme.com", "type": "wildcard", "note": "excluded"}
 ],
 "rules": ["no DoS", "no automated scanning above 10 rps"]}
\`\`\``;

describe('scope-validator — extraction', () => {
  it('reads fenced JSON', () => {
    const ex = sv.parseExtraction(OVERVIEW_REPLY);
    expect(ex !== null, 'extraction reads fenced JSON').toBe(true);
    expect(ex?.programme, 'programme name read').toBe('Acme Bounty');
    expect(ex?.inScope.length, 'in-scope count').toBe(5);
    expect(ex?.outOfScope.length, 'out-of-scope count').toBe(2);
    expect(ex?.rules.length, 'rules read').toBe(2);
  });

  it('rejects an unreadable reply', () => {
    expect(sv.parseExtraction('no json here')).toBeNull();
  });

  it('collapses duplicate assets case-insensitively', () => {
    const dup = sv.parseExtraction('{"in_scope":[{"asset":"a.com"},{"asset":"A.com"}]}');
    expect(dup?.inScope.length).toBe(1);
  });
});

describe('scope-validator — classification (observed through buildScope)', () => {
  // domain and wildcard both land in the `domains` bucket (a wildcard is
  // written as its base domain), so the two are indistinguishable here — the
  // Python _classify wildcard/domain split is module-private in the TS port.
  const cases: Record<string, 'domains' | 'ips' | 'cidrs' | 'other'> = {
    '*.acme.com': 'domains',
    'api.acme.io': 'domains',
    '203.0.113.10': 'ips',
    '198.51.100.0/24': 'cidrs',
    'Acme iOS app': 'other',
    '999.1.1.1': 'other',
    'https://x.io/path': 'domains',
    '2001:db8::1': 'ips',
    'fe80::/10': 'cidrs',
  };

  it.each(Object.entries(cases))('classifies %s', (asset, want) => {
    const [allowYaml, , skipped] = sv.buildScope([new sv.ScopeEntry(asset)], []);
    if (want === 'other') {
      expect(skipped.includes(asset), `classify '${asset}' -> other`).toBe(true);
      return;
    }
    expect(skipped.includes(asset), `classify '${asset}' -> ${want} (not dropped)`).toBe(false);
    const data = parseYaml(allowYaml) as Record<string, string[]>;
    if (want === 'ips') {
      expect((data['ips'] ?? []).includes(asset), `classify '${asset}' -> ip`).toBe(true);
    } else if (want === 'cidrs') {
      expect((data['cidrs'] ?? []).includes(asset), `classify '${asset}' -> cidr`).toBe(true);
    } else {
      expect((data['domains'] ?? []).length > 0, `classify '${asset}' -> domain/wildcard`).toBe(true);
    }
  });
});

describe('scope-validator — scope files', () => {
  it('builds, writes, verifies and reloads through the real guard', () => {
    const tmp = tmpdir();
    const ex = sv.parseExtraction(OVERVIEW_REPLY)!;
    const [allowYaml, denyYaml, skipped] = sv.buildScope(ex.inScope, ex.outOfScope);
    const allow = parseYaml(allowYaml) as Record<string, string[]>;
    const deny = parseYaml(denyYaml) as Record<string, string[]>;

    expect((allow['domains'] ?? []).includes('acme.com'), 'wildcard becomes its base domain').toBe(true);
    expect(allow['ips'], 'ip in ips').toEqual(['203.0.113.10']);
    expect(allow['cidrs'], 'cidr in cidrs').toEqual(['198.51.100.0/24']);
    expect(skipped.includes('Acme iOS app'), 'unplaceable asset reported, not dropped').toBe(true);
    expect((deny['domains'] ?? []).includes('status.acme.com'), 'out-of-scope domains kept').toBe(true);

    const [aPath, dPath] = sv.writeScopeFiles(tmp, allowYaml, denyYaml, 'Acme Bounty');
    expect(fs.existsSync(aPath) && path.basename(aPath) === 'allow.yaml', 'allow.yaml written').toBe(true);
    expect(
      fs.existsSync(dPath) && path.basename(dPath) === 'out-of-scope.yaml',
      'out-of-scope.yaml written',
    ).toBe(true);

    expect(sv.verifyScopeFiles(aPath, dPath), 'written files load back through Scope.load').toEqual([]);

    const s = Scope.load(aPath, dPath);
    expect(s.allow.contains('api.acme.io')[0], 'guard: allowed host is in allow list').toBe(true);
    expect(s.deny.contains('status.acme.com')[0], 'guard: deny beats allow for out-of-scope host').toBe(true);
    expect(s.allow.contains('www.acme.com')[0], 'guard: wildcard subdomain matched').toBe(true);
  });

  it('moves an existing allow.yaml aside rather than destroying it', () => {
    const tmp = tmpdir();
    sv.writeScopeFiles(tmp, 'domains:\n  - first.example\n', '');
    const [aPath2] = sv.writeScopeFiles(tmp, 'domains:\n  - other.example\n', '');
    const baks = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith('allow.yaml.bak-'));
    expect(baks.length, 'existing allow.yaml moved aside, not destroyed').toBe(1);
    expect(
      fs.readFileSync(aPath2, 'utf8').includes('other.example'),
      'new allow.yaml has new content',
    ).toBe(true);
  });
});

describe('scope-validator — recon deny guard', () => {
  it('recon never touches an out-of-scope host', async () => {
    const tmp = tmpdir();
    const [, dPath] = sv.writeScopeFiles(
      tmp,
      'domains:\n  - api.acme.io\n',
      'domains:\n  - status.acme.com\n',
    );
    const denyScope = new Scope();
    denyScope.denyPath = dPath;
    denyScope.deny = HostSet.fromMapping({ domains: ['status.acme.com'] });

    // DNS is mocked to fail with EAI_NONAME, so recon "runs" for the in-scope
    // host without any network, and the deny gate is provable at the seam a
    // socket would be opened from: exactly one lookup, for the in-scope host.
    dnsLookup.mockClear();
    const out = await sv.reconAll(
      ['api.acme.io', 'status.acme.com', 'www.status.acme.com'],
      denyScope,
    );

    expect(dnsLookup, 'recon never touches an out-of-scope host').toHaveBeenCalledTimes(1);
    expect(dnsLookup.mock.calls[0]?.[0], 'the one lookup is the in-scope host').toBe('api.acme.io');
    expect(!('status.acme.com' in out), 'the denied host has no recon entry').toBe(true);
    expect(!('www.status.acme.com' in out), 'a denied subdomain has no recon entry either').toBe(true);
    expect('api.acme.io' in out, 'recon still runs the in-scope host').toBe(true);
    expect(out['api.acme.io']!.resolves, 'the in-scope host was really probed').toBe(false);
    expect(out['api.acme.io']!.error.startsWith('dns:'), 'and its recon reports the DNS failure').toBe(true);
  });
});

describe('scope-validator — ranking', () => {
  const assets = ['*.acme.com', 'api.acme.io', '203.0.113.10'];
  const reply =
    '{"ranking": [{"asset": "api.acme.io", "rank": 1, "value": "high", "why": "api"},' +
    ' {"asset": "*.acme.com", "rank": 2, "value": "medium", "why": "web"}],' +
    ' "summary": "start with the api"}';

  it('keeps order, appends the unranked, renumbers densely', () => {
    const parsed = sv.parseRanking(reply, assets)!;
    const [ranked, summary] = parsed;
    expect(
      ranked.slice(0, 2).map((r) => r.asset),
      'ranking order kept',
    ).toEqual(['api.acme.io', '*.acme.com']);
    expect(
      ranked.some((r) => r.asset === '203.0.113.10' && r.value === 'unranked'),
      'unranked asset appended, not dropped',
    ).toBe(true);
    expect(
      ranked.map((r) => r.rank),
      'ranks renumbered densely',
    ).toEqual([1, 2, 3]);
    expect(summary, 'summary read').toBe('start with the api');
  });

  it('cannot add an asset that was not in scope', () => {
    const hallucinated = sv.parseRanking(
      '{"ranking":[{"asset":"evil.com","rank":1,"value":"high"}]}',
      assets,
    );
    expect(
      hallucinated !== null && hallucinated[0].every((r) => assets.includes(r.asset)),
      'model cannot add an asset that was not in scope',
    ).toBe(true);
  });
});

describe('scope-validator — tree', () => {
  it('renders programme, order, evidence and out-of-scope', () => {
    const ex = sv.parseExtraction(OVERVIEW_REPLY)!;
    const [ranked] = sv.parseRanking(
      '{"ranking": [{"asset": "api.acme.io", "rank": 1, "value": "high", "why": "api"},' +
        ' {"asset": "*.acme.com", "rank": 2, "value": "medium", "why": "web"}],' +
        ' "summary": "start with the api"}',
      ['*.acme.com', 'api.acme.io', '203.0.113.10'],
    )!;
    const reconEntry = new sv.HostRecon('api.acme.io');
    reconEntry.resolves = true;
    reconEntry.ip = '10.1.1.1';
    reconEntry.status = 200;
    reconEntry.server = 'nginx';
    reconEntry.title = 'Acme API';
    const tree = sv.renderPlainTree(
      'Acme Bounty',
      ranked,
      { 'api.acme.io': reconEntry },
      ex.outOfScope,
    );

    expect(tree.startsWith('Acme Bounty'), 'tree names the programme').toBe(true);
    expect(tree.indexOf('IN SCOPE') < tree.indexOf('OUT OF SCOPE'), 'tree lists in-scope first').toBe(true);
    expect(tree.includes('#1 [high] api.acme.io'), 'tree shows rank and value').toBe(true);
    expect(tree.includes('HTTP 200') && tree.includes('Acme API'), 'tree shows recon evidence').toBe(true);
    expect(tree.includes('status.acme.com'), 'tree lists out-of-scope').toBe(true);
  });
});
