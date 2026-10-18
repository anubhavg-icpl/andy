/**
 * tests/test_osint_tree.test.ts — regression suite for the `/osint` result
 * tree (port of tests/test_osint_tree.py).
 *
 * Two layers, matching the split in src/osint-tree.ts itself:
 *
 *  - the pure parsing — the ladder, confidence reading, table handling,
 *    report resolution — exercised directly with no terminal;
 *  - the wiring — that the slash dispatch, the help table, the palette, the
 *    completion popup and the finalise hook all actually expose the tree, so
 *    a rename in one place cannot silently orphan it in another.
 *
 * Invariants of this file:
 *  - The fixtures reproduce the *shapes* of the three real reports the
 *    Python suite was written against, because the whole difficulty of the
 *    module is that those three reports do not agree on a structure.
 *  - Python's private-helper checks (`ot._confidence_in`) go through the
 *    public parse API instead — the port keeps leading-underscore helpers
 *    module-private (PORT-MAP naming table), and a row-level probe pins the
 *    same behaviour.
 *  - The Textual `run_test` pilot has no Ink equivalent, so the Python
 *    `test_ui` block runs the real `cmdOsint`/`cmdOsintTree`/`finaliseOsint`
 *    against the real modules through a stub AppCtx whose `runTurn`
 *    reproduces the finalise hook of the real app runTurn; the app-level
 *    busy gate is covered by the source checks in `wiring`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ot from '../src/osint-tree.js';
import * as osint from '../src/osint.js';
import { Config } from '../src/config.js';
import { THEME_NAMES, getPalette } from '../src/theme.js';
import { SLASH_COMMANDS } from '../src/ui/complete.js';
import { cmdOsint, cmdOsintTree, finaliseOsint } from '../src/ui/screens/campaigns.js';
import type { AppCtx, Mods, Palette } from '../src/ui/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Module scope, NOT beforeAll: several describes below build fixtures at
// collection time, so the temp root must already be a real absolute path
// when they run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-test-osint-tree-'));
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Python `_cfg`: a real Config pointed at a throwaway workdir/state. */
function cfgFor(workdir: string): Config {
  return Config.fromEnv({ workdir, apiKey: 'x', baseUrl: 'http://localhost:4001' } as Partial<Config>);
}

// ---------------------------------------------------------------------------
// Fixtures — the three shapes the real reports come in
// ---------------------------------------------------------------------------

// Shape A: conformant. Numbered sections, every finding a `###` heading with the
// five-line What/Where/Confidence/Means/Verify block underneath.
const SHAPE_A = `\
# Email OSINT — demo@example.com

## Headline

This is a demo address belonging to **Demo Person**, used to exercise the tree.

## Coverage

| Phase | Ran? | Result |
|-------|------|--------|
| 1. Validation | yes | Free provider; not disposable |
| 6. Domain | skipped | Free provider — out of scope |

## 1. VALIDATION

### Example Mail is a free consumer provider, not corporate
**What**       — the domain resolves to a free provider.
**Where**      — \`01-dns.txt\`, MX records.
**Confidence** — CONFIRMED
**Means**      — this is an identity problem, not a domain problem.
**Verify**     — \`dig MX example.com\`.

### Address is not disposable
**What**       — Disify reports \`disposable: false\`.
**Where**      — \`01-dns.txt\`.
**Confidence** — CONFIRMED
**Means**      — the mailbox is likely a real person's.
**Verify**     — re-run Disify.

## 2. IDENTITY

### Full name is Demo Person
**What**       — the portfolio names its owner.
**Where**      — \`05-portfolio.txt\`.
**Confidence** — CONFIRMED
**Means**      — the address maps to a named individual.
**Verify**     — fetch the portfolio page.

### Alias demoguy is unconfirmed
**What**       — a handle appears in one commit only.
**Where**      — git author string.
**Confidence** — UNVERIFIED
**Means**      — not yet tied to the same person.
**Verify**     — search the handle elsewhere.

## 3. LEAKS

Nothing found — no paste or code exposure surfaced for this address.
`;

// Shape B: table-only. Same numbered sections, but every finding is a table row
// and there is not a single `**What**` block. This is the shape a strict parser
// renders as an empty tree.
const SHAPE_B = `\
# Email OSINT — demo@example.com

## 1. VALIDATION

| Item | Value | Source |
|---|---|---|
| Provider | **Example Mail — free consumer provider** | \`01-dns.txt\` |
| Disposable? | **No** — mainstream provider | — |

**Classification: free provider.** Phase 6 is out of scope.

## 2. IDENTITY

| Attribute | Value | Confidence | Source |
|---|---|---|---|
| Full name | **Demo Person** | CONFIRMED | \`05-portfolio.txt\` |
| Alias | **demoguy** | UNVERIFIED | git author string |

## 3. CONTACT

| Type | Value | Confidence | Source |
|---|---|---|---|
| Email (secondary) | \`second@example.com\` | CONFIRMED | README \`mailto:\` |
| Phone | **none found** | — | — |
`;

// Shape C: the github report — a different section vocabulary entirely, plus
// `###` sub-blocks whose titles cite evidence files, and a `Source` column that
// leads its table.
const SHAPE_C = `\
# GitHub OSINT — demohandle

## 1. ACCOUNT

| Field | Value | Source |
|---|---|---|
| login | \`demohandle\` | \`raw_user.json\` |
| name | **Demo Person** | \`raw_user.json\` |

## 2. EMAILS

| # | Address | Source | Commit date | Confidence |
|---|---|---|---|---|
| 1 | \`demo@example.com\` | git author, 12 commits | 2026-01-02 | **CONFIRMED** |

## 4. BREACH EXPOSURE

### 4a. Breach list (Example) — \`03-xon.json\`

| Breach | Date | Password? |
|---|---|---|
| **DemoLeak** | 2023-09 | **Yes — plaintext** |

### 4b. Stealer logs — \`03-stealer.json\`

| Date | Machine | Malware |
|---|---|---|
| 2024-07-27 | \`DEMO-PC\` | \`MSBuild.exe\` |

## 6. KEYS

| # | Type | Fingerprint |
|---|---|---|
| 1 | ED25519 | \`SHA256:abc123\` |

## 8. LEAKS

| Source | Result | Evidence |
|---|---|---|
| GitHub code search demo@example.com | 2 commits | \`04-search.txt\` |

## 9. SELF-DESCRIPTION

| Attribute | Value | Confidence | Source |
|---|---|---|---|
| Title | Ethical Hacker \\| Red Team Expert | CONFIRMED | portfolio |
`;

const _tree = (text: string): ot.Node => ot.parseReport(text);

/** Every leaf label in the tree, flattened. */
function _labels(node: ot.Node): string[] {
  const out: string[] = [];
  for (const c of node.children) {
    if (c.isLeaf) {
      out.push(c.label);
    } else {
      out.push(..._labels(c));
    }
  }
  return out;
}

function _section(node: ot.Node, name: string): ot.Node | undefined {
  return node.children.find((c) => c.label === name);
}

// ---------------------------------------------------------------------------
// Shape A — the conformant report
// ---------------------------------------------------------------------------

describe('shape A', () => {
  const node = _tree(SHAPE_A);

  it('A: the H1 becomes the root', () => {
    expect(node.label).toBe('Email OSINT — demo@example.com');
  });

  it('A: every section is a branch', () => {
    expect(node.children.map((c) => c.label)).toEqual(
      ['Headline', 'Coverage', '1. VALIDATION', '2. IDENTITY', '3. LEAKS'],
    );
  });

  // The five-line blocks are the richest rung: a written title, a real
  // confidence read off the Confidence line.
  const val = _section(node, '1. VALIDATION');
  it('A: finding blocks become leaves under their section', () => {
    expect(val?.children.length).toBe(2);
  });
  it('A: the leaf is the ### title, not the What line', () => {
    expect(val?.children[0]?.label).toBe('Example Mail is a free consumer provider, not corporate');
  });
  it('A: CONFIRMED is read from the Confidence line', () => {
    expect(val?.children[0]?.confidence).toBe('CONFIRMED');
  });

  const ident = _section(node, '2. IDENTITY');
  it('A: UNVERIFIED is read too, not normalised away', () => {
    expect(ident?.children[1]?.confidence).toBe('UNVERIFIED');
  });

  // A section that found nothing is a finding in its own right and must not
  // be dropped — the report guide says so explicitly.
  const leaks = _section(node, '3. LEAKS');
  it("A: a 'nothing found' section still appears", () => {
    expect(leaks).toBeDefined();
  });
  it('A: its prose is kept as a leaf', () => {
    expect(leaks?.children.length ?? 0).toBeGreaterThan(0);
    expect(leaks?.children[0]?.label.includes('no paste or code exposure')).toBe(true);
  });

  // Headline is the run's most important paragraph — losing it would be the
  // worst thing this view could do.
  const head = _section(node, 'Headline');
  it('A: the Headline is rendered, not dropped', () => {
    expect(head?.children.length ?? 0).toBeGreaterThan(0);
    expect(head?.children[0]?.label.includes('Demo Person')).toBe(true);
  });

  const cov = _section(node, 'Coverage');
  it('A: the coverage table is rendered', () => {
    expect(cov?.children.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Shape B — the table-only report (the regression a strict parser fails)
// ---------------------------------------------------------------------------

describe('shape B', () => {
  const node = _tree(SHAPE_B);

  it('B: a table-only report still yields findings', () => {
    const [total] = ot.countFindings(node);
    expect(total >= 6).toBe(true);
  });

  const val = _section(node, '1. VALIDATION');
  it('B: table rows become leaves', () => {
    expect(val?.children.length).toBe(2);
  });

  // The header row names the columns; counting it would inflate every section.
  it('B: the header row is not counted as a finding', () => {
    const labels = _labels(node).join(' | ');
    expect(labels.includes('Item · Value')).toBe(false);
    expect(labels.includes('Attribute · Value')).toBe(false);
  });

  // A trailing source column is provenance, not a finding. `01-dns.txt` must
  // not survive into a label.
  it('B: a trailing evidence-filename column is dropped', () => {
    const labels = _labels(node).join(' | ');
    expect(labels.includes('01-dns.txt')).toBe(false);
  });

  // ...but the *value* survives. Over-trimming here would silently gut the tree.
  it("B: the row's value survives", () => {
    const labels = _labels(node).join(' | ');
    expect(labels.includes('Provider · Example Mail — free consumer provider')).toBe(true);
  });

  const ident = _section(node, '2. IDENTITY');
  it('B: confidence is read from a table cell', () => {
    expect(ident?.children.map((c) => c.confidence)).toEqual(['CONFIRMED', 'UNVERIFIED']);
  });

  // A `—` source cell means "no source"; the value before it must remain.
  const contact = _section(node, '3. CONTACT');
  it('B: a row with an em-dash source keeps its value', () => {
    expect(contact?.children.some((c) => c.label.includes('Phone · none found'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape C — the github report's different vocabulary
// ---------------------------------------------------------------------------

describe('shape C', () => {
  const node = _tree(SHAPE_C);

  // The parser keys on `## `, never on a hard-coded section list — which is
  // the only reason a report with a different vocabulary works at all.
  it('C: sections are whatever the report calls them', () => {
    expect(node.children.map((c) => c.label)).toEqual(
      ['1. ACCOUNT', '2. EMAILS', '4. BREACH EXPOSURE', '6. KEYS', '8. LEAKS',
        '9. SELF-DESCRIPTION'],
    );
  });

  const breach = _section(node, '4. BREACH EXPOSURE');
  it('C: a ### sub-block becomes a nested branch', () => {
    expect(breach?.children.length).toBe(2);
  });
  it('C: the sub-block keeps its own title', () => {
    expect(breach?.children[0]?.label).toBe('4a. Breach list (Example)');
  });
  it('C: its evidence filename is stripped from the title', () => {
    expect(breach?.children[0]?.label.includes('03-xon.json')).toBe(false);
  });
  it('C: the rows nest under the sub-block', () => {
    expect(breach?.children[0]?.children.length ?? 0).toBeGreaterThan(0);
    expect(breach?.children[0]?.children[0]?.label.includes('DemoLeak')).toBe(true);
  });

  // A `Source` column that *leads* is the row's subject, not provenance.
  const leaks = _section(node, '8. LEAKS');
  it('C: a leading Source column is kept as the subject', () => {
    expect(leaks?.children.length ?? 0).toBeGreaterThan(0);
    expect(leaks?.children[0]?.label.includes('GitHub code search')).toBe(true);
  });

  // An escaped pipe inside a cell is a literal pipe, not a column break.
  const selfdesc = _section(node, '9. SELF-DESCRIPTION');
  it('C: an escaped pipe does not split the cell', () => {
    expect(selfdesc?.children.length ?? 0).toBeGreaterThan(0);
    expect(selfdesc?.children[0]?.label.includes('Ethical Hacker | Red Team Expert')).toBe(true);
  });

  // Confidence buried mid-row, with the source column after it.
  const emails = _section(node, '2. EMAILS');
  it('C: a mid-row confidence is still read', () => {
    expect(emails?.children[0]?.confidence).toBe('CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
// The ladder's bottom rung
// ---------------------------------------------------------------------------

describe('unparsed sections', () => {
  const node = _tree('# T\n\n## 1. STRUCTURE ONLY\n\n> a blockquote, which is not a finding\n\n---\n\n## 2. TOTALLY EMPTY\n');

  // A section of pure structure — a quote, a rule — has nothing to show. It
  // must say so, because a bare branch reads as "nothing was there".
  const empty = _section(node, '1. STRUCTURE ONLY');
  it('unparsed: a section with no findings still appears', () => {
    expect(empty).toBeDefined();
  });
  it('unparsed: it says so rather than rendering bare', () => {
    expect(empty?.note.includes('no findings parsed')).toBe(true);
  });
  it('unparsed: the count is right', () => {
    expect(empty?.note.includes('(2 lines')).toBe(true);
  });

  const blank = _section(node, '2. TOTALLY EMPTY');
  it('unparsed: a genuinely empty section says that instead', () => {
    expect(blank?.note).toBe('(empty section)');
  });

  // But prose *is* a finding at the bottom rung: "Nothing found — <why>" is
  // the shape the report guide mandates for an empty section, and dropping it
  // would lose the reason.
  const prose = _tree('# T\n\n## 1. LEAKS\n\nNothing found — every source was key-gated.\n');
  const leaks = _section(prose, '1. LEAKS');
  it("unparsed: a 'nothing found' sentence is kept as a leaf", () => {
    expect(leaks?.children.length ?? 0).toBeGreaterThan(0);
    expect(leaks?.children[0]?.label.includes('key-gated')).toBe(true);
  });
  it('unparsed: a kept prose leaf carries no note', () => {
    expect(leaks?.children[0]?.note).toBe('');
  });

  // A report with no H1 at all still parses, falling back to the filename.
  it('unparsed: a report with no H1 falls back to the given title', () => {
    const bare = ot.parseReport('## 1. X\n\n| a | b |\n|---|---|\n| k | v |\n',
      { fallbackTitle: 'fallback.md' });
    expect(bare.label).toBe('fallback.md');
  });

  it('unparsed: an empty string does not raise', () => {
    expect(ot.parseReport('').label).toBe('OSINT report');
  });
});

// ---------------------------------------------------------------------------
// Confidence is read, never invented
// ---------------------------------------------------------------------------

describe('confidence', () => {
  const node = _tree('# T\n\n## 1. A\n\n| Item | Value |\n|---|---|\n| Provider | Some Mail |\n| Host | mail.example.com |\n');
  const sec = _section(node, '1. A');
  it('confidence: a row with no confidence gets no tag', () => {
    expect(sec?.children.every((c) => c.confidence === '')).toBe(true);
  });

  it('confidence: untagged findings are not tallied as anything', () => {
    const [total, tally] = ot.countFindings(node);
    expect(total).toBe(2);
    expect(tally).toEqual({});
  });

  // Python called the private `ot._confidence_in` directly. The port keeps
  // leading-underscore helpers module-private (PORT-MAP naming table), so the
  // same two behaviours are pinned through the public row parser: a
  // Confidence cell saying "CONFIRMED (exists) / PROBABLE (his)" must read as
  // CONFIRMED, and a cell with no confidence word must read as none.
  const mixed = _tree('# T\n\n## 1. A\n\n| Item | Confidence |\n|---|---|\n'
    + '| X | CONFIRMED (exists) / PROBABLE (his) |\n| Y | probably fine |\n');
  const mixedSec = _section(mixed, '1. A');
  it('confidence: the first level wins, not the last', () => {
    expect(mixedSec?.children[0]?.confidence).toBe('CONFIRMED');
  });
  it('confidence: an unknown word is not a confidence', () => {
    expect(mixedSec?.children[1]?.confidence).toBe('');
  });
});

describe('summary line', () => {
  it('summary: it counts findings', () => {
    const line = ot.summaryLine(_tree(SHAPE_A));
    expect(line.includes('finding')).toBe(true);
  });
  it('summary: it breaks out the levels', () => {
    const line = ot.summaryLine(_tree(SHAPE_A));
    expect(line.includes('CONFIRMED')).toBe(true);
    expect(line.includes('UNVERIFIED')).toBe(true);
  });

  it('summary: an empty tree says so plainly', () => {
    expect(ot.summaryLine(new ot.Node({ label: 'x' }))).toBe('no findings parsed');
  });

  it('summary: singular reads correctly', () => {
    const one = new ot.Node({ label: 'r', children: [new ot.Node({ label: 'only' })] });
    expect(ot.summaryLine(one)).toBe('1 finding');
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('find', () => {
  const dir = path.join(TMP, 'find');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = cfgFor(dir);
  cfg.stateDir = path.join(dir, 'state');
  const base = path.join(cfg.stateDir, 'reports');
  fs.mkdirSync(base, { recursive: true });

  it('find: no reports at all returns None', () => {
    expect(ot.findReport(cfg)).toBeUndefined();
  });

  const emptyCfg = cfgFor(path.join(dir, 'nope'));
  emptyCfg.stateDir = path.join(dir, 'nope', 'state');
  it('find: a missing reports dir returns None', () => {
    expect(ot.findReport(emptyCfg)).toBeUndefined();
  });

  // The Python test was one sequential function — mutations interleaved with
  // assertions — so each mutation below lives inside the `it` that first
  // observes its effect (describe-body code runs at collection, before any
  // assertion, which would leak later state into earlier checks).
  const a = path.join(base, 'email-alpha-20260101-000000.md');
  const b = path.join(base, 'github-beta-20260102-000000.md');
  let now = 0;

  it('find: with no argument it takes the newest by mtime', () => {
    fs.writeFileSync(a, '# A\n');
    fs.writeFileSync(b, '# B\n');
    // mtime, not name: make the *older* name the newer file.
    now = Date.now() / 1000;
    fs.utimesSync(a, now - 100, now - 100);
    fs.utimesSync(b, now, now);
    expect(ot.findReport(cfg)).toBe(b);
  });

  it("find: newest is mtime, not the name's stamp", () => {
    fs.utimesSync(a, now + 100, now + 100);
    expect(ot.findReport(cfg)).toBe(a);
  });

  it('find: a bare kind filters to that kind', () => {
    expect(ot.findReport(cfg, 'github')).toBe(b);
  });
  it('find: an unknown kind matches nothing', () => {
    expect(ot.findReport(cfg, 'nosuch')).toBeUndefined();
  });
  it('find: an exact path is honoured', () => {
    expect(ot.findReport(cfg, b)).toBe(b);
  });
  it('find: a case name resolves', () => {
    expect(ot.findReport(cfg, 'github-beta-20260102-000000')).toBe(b);
  });

  it('find: only .md files are considered', () => {
    // A non-markdown file in the store is not a report.
    const notes = path.join(base, 'notes.txt');
    fs.writeFileSync(notes, 'x');
    fs.utimesSync(notes, now + 500, now + 500);
    expect(ot.findReport(cfg)).toBe(a);
  });

  it('find: a newer hunt report is not a recon', () => {
    // `<state_dir>/reports/` is shared with /bug-hunt and /crack — all three
    // move their finished report into the same flat directory. A newer hunt
    // or crack report must not be handed back as "the latest recon": it
    // parses to nothing, so the operator would get an empty tree for a run
    // that never happened, which reads exactly like "the recon found
    // nothing".
    const h = path.join(base, 'hunt-x.test-20260103-000000.md');
    const c = path.join(base, 'some-tgs.txt-20260104-000000.md');
    fs.writeFileSync(h, '---\ntarget: x.test\n---\n');
    fs.writeFileSync(c, '# Password cracking — tgs.txt\n');
    fs.utimesSync(h, now + 900, now + 900);
    fs.utimesSync(c, now + 950, now + 950);
    expect(ot.findReport(cfg)).toBe(a);
  });
  it('find: a bare kind does not match a hunt report', () => {
    expect(ot.findReport(cfg, 'hunt')).toBeUndefined();
  });
  it('find: a bare kind does not match a crack report', () => {
    expect(ot.findReport(cfg, 'some-tgs.txt')).toBeUndefined();
  });
});

describe('live case', () => {
  // A case directory that never finalised is still a readable recon.
  //
  // `finaliseCase` runs in the turn's finally block, so an app killed
  // outright — Ctrl+C twice, a crash, a closed terminal — leaves the case
  // (and its `report.md`) on disk forever. This is not hypothetical: it is
  // how all three real reports on the source box ended up in case
  // directories rather than in the archive, and the whole reason
  // `/osint-tree` searches both.
  const dir = path.join(TMP, 'live');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = cfgFor(dir);
  cfg.stateDir = path.join(dir, 'state');
  const root = path.join(cfg.stateDir, 'osint');
  fs.mkdirSync(root, { recursive: true });

  it('live: no case dirs, no archive, returns None', () => {
    expect(ot.findReport(cfg)).toBeUndefined();
  });

  // Sequential mutations live inside the `it` that first observes them —
  // see the `find` block for why.
  const oldDir = path.join(root, 'email-alpha-20260101-000000');
  const newDir = path.join(root, 'github-beta-20260102-000000');
  let now = 0;

  it('live: an unfinalised case is found', () => {
    for (const [d, title] of [
      [oldDir, '# Old\n\n## 1. X\n\n- one\n'],
      [newDir, '# New\n\n## 1. Y\n\n- two\n'],
    ] as const) {
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'report.md'), title);
      fs.writeFileSync(path.join(d, 'raw.json'), '{}'); // the bulky evidence, still there
    }
    now = Date.now() / 1000;
    fs.utimesSync(oldDir, now - 100, now - 100);
    fs.utimesSync(newDir, now, now);
    expect(ot.findReport(cfg)).toBe(path.join(newDir, 'report.md'));
  });
  it('live: a bare kind filters case dirs too', () => {
    expect(ot.findReport(cfg, 'email')).toBe(path.join(oldDir, 'report.md'));
  });
  it('live: a case name resolves', () => {
    expect(ot.findReport(cfg, 'github-beta-20260102-000000'))
      .toBe(path.join(newDir, 'report.md'));
  });

  it('live: a case with no report is skipped', () => {
    // A case dir with no report in it is a failed run, not a result — it
    // must not shadow a real one, and must not be returned at all.
    const emptyDir = path.join(root, 'email-gamma-20260103-000000');
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(emptyDir, 'raw.json'), '{}');
    fs.utimesSync(emptyDir, now + 500, now + 500);
    expect(ot.findReport(cfg)).toBe(path.join(newDir, 'report.md'));
  });

  it('live: the archive is searched alongside case dirs', () => {
    // The archive wins a tie: a finalised report is the tidied one.
    const base = path.join(cfg.stateDir, 'reports');
    fs.mkdirSync(base, { recursive: true });
    const arch = path.join(base, 'email-delta-20260104-000000.md');
    fs.writeFileSync(arch, '# Archived\n\n## 1. Z\n\n- three\n');
    fs.utimesSync(arch, now + 900, now + 900);
    expect(ot.findReport(cfg)).toBe(arch);
  });
  it('live: a kind matches in either store', () => {
    expect(ot.findReport(cfg, 'github')).toBe(path.join(newDir, 'report.md'));
  });
});

describe('file', () => {
  it('file: a path with spaces reads', () => {
    const p = path.join(TMP, 'a report with spaces.md');
    fs.writeFileSync(p, SHAPE_A);
    expect(ot.parseReportFile(p).label.startsWith('Email OSINT')).toBe(true);
  });

  it('file: a missing file returns a note, not a raise', () => {
    const missing = ot.parseReportFile(path.join(TMP, 'nope.md'));
    expect(missing.note.includes('could not read')).toBe(true);
  });

  it('file: invalid utf-8 does not raise', () => {
    // Reports carry em dashes and stray bytes from scraped pages; a summary
    // view must not be the thing that throws on them.
    const bad = path.join(TMP, 'bad.md');
    fs.writeFileSync(bad,
      Buffer.from('# T\n\n## 1. X\n\n| a | b |\n|---|---|\n| k\xff\xfe | v |\n', 'latin1'));
    expect(ot.parseReportFile(bad).label).toBe('T');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('render', () => {
  const pal = getPalette('green');
  const node = _tree(SHAPE_C);
  const tree = ot.renderTree(node, pal);

  it('render: it builds a tree string', () => {
    // The Python built a rich Tree; the port renders the same shape as a
    // box-drawing string, so the type check is the string form.
    expect(typeof tree).toBe('string');
  });

  it('render: the tree carries every parsed node', () => {
    // Every section, every sub-block and every finding is a line in the
    // rendered tree, so the line count is the node count.
    const lines = tree.split('\n');
    const [parsed] = ot.countFindings(node);
    expect(lines.length >= parsed).toBe(true);
  });

  // Colours come from the palette, so the tree reads in any theme. Iterating
  // THEME_NAMES rather than a hardcoded trio is what makes a newly-added theme
  // get checked here without anyone remembering to come back and edit this —
  // the list had already drifted from the one the UI offers once.
  for (const theme of THEME_NAMES) {
    it(`render: it renders under the ${theme} palette`, () => {
      expect(ot.renderTree(node, getPalette(theme))).toBeDefined();
    });
  }

  // Confidence styling must actually differ per level — the failure this
  // guards is every tag falling through to `dim`.
  it('render: the three confidence levels are styled distinctly', () => {
    const styles = Object.fromEntries(
      ot.CONFIDENCES.map((c) => [c, ot.confidenceStyle(c, pal)]));
    expect(new Set(Object.values(styles)).size).toBe(3);
  });
  it('render: an unknown confidence falls back rather than raising', () => {
    expect(ot.confidenceStyle('MAYBE', pal)).toBe(pal.dim);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('wiring', () => {
  // Read from the sources rather than importing a copy, so a rename cannot
  // drift past this. The Python single file ui/app.py is split across
  // app.tsx (dispatch + palette + busy gate), screens/campaigns.tsx (the
  // handlers) and screens/commands.tsx (the help table) in the port; each
  // check reads the file that now owns that surface.
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf8');
  const campaignsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'screens', 'campaigns.tsx'), 'utf8');
  const commandsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'screens', 'commands.tsx'), 'utf8');

  it('wiring: dispatch has an osint-tree entry', () => {
    expect(appSrc.includes("'osint-tree': (a) => cmdOsintTree(")).toBe(true);
  });
  it('wiring: cmdOsintTree is defined', () => {
    expect(campaignsSrc.includes('export function cmdOsintTree(')).toBe(true);
  });
  it('wiring: showOsintTree is defined', () => {
    expect(campaignsSrc.includes('function showOsintTree(')).toBe(true);
  });
  it('wiring: the finalise hook renders the tree', () => {
    // finaliseOsint → showOsintTree is the render; the second expect is the
    // port's split-file form of "the finalise hook" — the app's runTurn
    // calls finaliseOsint from its finally block.
    expect(campaignsSrc.includes('showOsintTree(ctx, report)')).toBe(true);
    expect(appSrc.includes('finaliseOsint(ctx, opts.osintCase)')).toBe(true);
  });
  it('wiring: help table lists it', () => {
    expect(commandsSrc.includes("'/osint-tree [kind|path]'")).toBe(true);
  });
  it('wiring: palette lists it', () => {
    expect(appSrc.includes("['/osint-tree', 're-show a finished recon as a result tree', 'osint']"))
      .toBe(true);
  });
  it('wiring: it is permitted while busy', () => {
    // Scoped to the BUSY_OK set rather than any occurrence — the dispatch
    // table spells the key differently, so an unscoped search would pass
    // even if the busy gate dropped it.
    const start = appSrc.indexOf('const BUSY_OK = new Set([');
    const busyFragment = appSrc.slice(start, appSrc.indexOf(']);', start));
    expect(busyFragment.includes("'osint-tree',")).toBe(true);
  });

  it('wiring: completion lists it', () => {
    const cmds = Object.fromEntries(SLASH_COMMANDS);
    expect('/osint-tree' in cmds).toBe(true);
  });
  it('wiring: completion describes it', () => {
    const cmds = Object.fromEntries(SLASH_COMMANDS) as Record<string, string>;
    expect(cmds['/osint-tree']?.includes('tree')).toBe(true);
  });

  // The command must be its own dispatch key, not an argument to /osint.
  it('wiring: /osint-tree is a dispatch key of its own', () => {
    const start = appSrc.indexOf('const dispatch: Record<');
    const dispatch = appSrc.slice(start, appSrc.indexOf('};', start));
    expect(dispatch.includes("'osint-tree'")).toBe(true);
    expect(dispatch.includes('osint:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The command handlers (Python test_ui, ported at the handler seam — see the
// file contract block for why there is no Ink run_test pilot)
// ---------------------------------------------------------------------------

/** Read the text back out of a captured React/ink node (Python read `.plain`). */
function nodeText(n: unknown): string {
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (n && typeof n === 'object' && 'props' in (n as Record<string, unknown>)) {
    return nodeText((n as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

describe('ui', () => {
  const cfg = cfgFor(TMP);
  // Its own state_dir, not one shared with the pure tests: the case-dir
  // stamp is second-resolution, so two blocks creating a directory for the
  // same target within the same second land on the SAME path, which would
  // make count-based assertions depend on how fast the suite runs.
  cfg.stateDir = path.join(TMP, 'ui-state');

  const palette: Palette = {
    name: 'green',
    bg: '#000000',
    primary: '#00ff41',
    dim: '#0b6e2a',
    accent: '#00ffaa',
    red: '#ff3333',
    amber: '#ffb000',
    glow: '#00ff41',
  };

  const says: unknown[] = [];
  const lines: string[] = [];
  const turnPromises: Promise<void>[] = [];
  // The model stub for the in-flight turn — Python's reporting_stream /
  // held_stream, swapped per scenario.
  let turnBehaviour: ((caseDir: string) => Promise<void>) | null = null;

  const ctx = {
    cfg,
    mods: () => ({ osint, osintTree: ot } as unknown as Mods),
    pal: () => palette,
    say: (node: unknown) => {
      says.push(node);
    },
    sysLine: (message: string) => {
      lines.push(message);
    },
    busyRef: { current: false },
    setBusyBoth: (v: boolean) => {
      ctx.busyRef.current = v;
    },
    // Reproduces the one seam of the real app runTurn the Python test_ui was
    // exercising through the pilot: the osint case is finalised after the
    // turn, in the turn's finally, whatever happened inside it
    // (src/ui/app.tsx runTurn → finaliseOsint(ctx, opts.osintCase)).
    runTurn: (text: string, opts?: Parameters<AppCtx['runTurn']>[1]) => {
      const pr = (async () => {
        ctx.setBusyBoth(true);
        try {
          if (opts?.osintCase && turnBehaviour) {
            await turnBehaviour(opts.osintCase);
          }
        } finally {
          if (opts?.osintCase) finaliseOsint(ctx as unknown as AppCtx, opts.osintCase);
          ctx.setBusyBoth(false);
        }
      })();
      turnPromises.push(pr);
      return pr;
    },
  } as unknown as AppCtx;

  // The rendered tree is the one `say` call that is a plain string
  // (renderTree returns a string); every other say is a React node — the
  // Python counted `isinstance(c, Tree)` the same way.
  const treeStrings = (): string[] =>
    says.filter((c): c is string => typeof c === 'string');
  const texts = (): string =>
    [...says.map(nodeText), ...lines].join(' ');
  const osintRoot = (): string => path.join(cfg.stateDir, 'osint');

  // The turn is held on a gate (Python's asyncio.Event) so `busy` is
  // observed genuinely in flight before the stub writes its report.
  let openReconGate: (() => void) | null = null;

  it('ui: the recon turn launches', () => {
    const gate = new Promise<void>((resolve) => {
      openReconGate = resolve;
    });
    turnBehaviour = async (caseDir) => {
      await gate;
      fs.writeFileSync(path.join(caseDir, 'report.md'), SHAPE_A);
    };
    cmdOsint(ctx, ['email', 'demo@example.com']);
    expect(ctx.busyRef.current).toBe(true);
  });

  it('ui: the turn completes', async () => {
    openReconGate!();
    await turnPromises[turnPromises.length - 1]!;
    expect(ctx.busyRef.current).toBe(false);
  });

  it('ui: the result tree reaches the transcript', () => {
    expect(treeStrings().length).toBe(1);
  });

  // And the summary line, so the operator gets the count before the shape.
  it('ui: the summary line is printed', () => {
    const t = texts();
    expect(t.includes('RESULT')).toBe(true);
    expect(t.includes('finding')).toBe(true);
  });

  // The archive still happens — the tree is added to that path, not
  // instead of it.
  it('ui: the report is still archived', () => {
    const archived = fs.readdirSync(path.join(cfg.stateDir, 'reports'))
      .filter((n) => /^email-demo-example\.com-.*\.md$/.test(n));
    expect(archived.length).toBe(1);
  });

  // ---- /osint-tree re-reads it -------------------------------
  it('ui: /osint-tree re-renders the archived report', () => {
    says.length = 0;
    cmdOsintTree(ctx, []);
    expect(treeStrings().length).toBe(1);
  });

  it('ui: /osint-tree by kind resolves', () => {
    says.length = 0;
    cmdOsintTree(ctx, ['email']);
    expect(treeStrings().length).toBeGreaterThan(0);
  });

  it('ui: an unmatched kind is refused, not rendered', () => {
    says.length = 0;
    lines.length = 0;
    cmdOsintTree(ctx, ['nosuchkind']);
    expect(treeStrings().length).toBe(0);
    expect(lines.some((l) => l.includes('no recon report matches'))).toBe(true);
  });

  // ---- and it is typeable while busy -------------------------
  let releaseSecondTurn: (() => void) | null = null;

  it('ui: a second turn is running', () => {
    turnBehaviour = () => new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });
    cmdOsint(ctx, ['github', 'demohandle']);
    expect(ctx.busyRef.current).toBe(true);
  });

  it('ui: /osint-tree works while the harness is busy', async () => {
    says.length = 0;
    cmdOsintTree(ctx, []);
    // Handler level: cmdOsintTree never refuses on busy (the app-level gate
    // whitelists it in BUSY_OK — pinned by the wiring block).
    expect(treeStrings().length).toBeGreaterThan(0);

    releaseSecondTurn!();
    await turnPromises[turnPromises.length - 1]!;
    expect(ctx.busyRef.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real reports, when they are still on disk
// ---------------------------------------------------------------------------

describe('real reports', () => {
  // Parse the actual archived reports, if this box still has them.
  //
  // Reported as SKIP rather than PASS when absent: a check that silently
  // passes without running is worse than no check, and these are the only
  // inputs that prove the ladder against markdown nobody wrote for a test.
  // (`~/.zimzilla` in the Python → `~/.andy` per the port's rename rules.)
  it('real: parses the actual archived reports', (t) => {
    const base = path.join(os.homedir(), '.andy', 'osint');
    const found: string[] = [];
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        const r = path.join(base, d, 'report.md');
        if (fs.statSync(path.join(base, d)).isDirectory() && fs.existsSync(r)) {
          found.push(r);
        }
      }
    }
    if (!found.length) {
      t.skip();
      return;
    }

    for (const p of found) {
      const node = ot.parseReportFile(p);
      const [total] = ot.countFindings(node);
      const tag = path.basename(path.dirname(p)).slice(0, 42);
      expect(total > 0 && node.children.length > 0, `${tag}: ${total} findings`)
        .toBe(true);

      // Every section must be accounted for — rendered with children, or with
      // the explicit note. A bare branch is the silent-empty failure.
      const bare = node.children.filter((c) => !c.children.length && !c.note)
        .map((c) => c.label);
      expect(bare, `${tag}: bare sections`).toEqual([]);
    }
  });
});
