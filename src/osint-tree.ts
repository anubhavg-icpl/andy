/**
 * osint-tree.ts — `/osint-tree`: read a finished recon report back as a tree
 * (port of zimzilla/osint_tree.py).
 *
 * What this module is: the reader for `/osint` results. `osint.ts` *runs* a
 * recon; this parses the markdown report it leaves behind (archive or
 * unfinalised case dir) into a labelled Node tree and renders it coloured.
 *
 * Invariants:
 *  - Parsing is a ladder (finding blocks -> table rows -> prose -> explicit
 *    "nothing parsed" note) because real reports do NOT follow the playbook
 *    shape; an empty tree must never be indistinguishable from "nothing
 *    found".
 *  - Confidence is only ever READ, never inferred — a finding with no
 *    confidence marker gets no tag, not a guessed UNVERIFIED.
 *  - No TUI and no model calls — testable against real reports with no
 *    terminal.
 */

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { expandTilde } from './shared.js';
import { KIND_ORDER, reportsDir, type OsintCfg } from './osint.js';

// `<stateDir>/reports/` is a *shared* archive — `/osint`, `/bug-hunt` and
// `/crack` all move their finished report into the same flat directory
// (`osint.reportsDir`, `hunt.reportsDir` and `crack.reportsDir` are three
// identical functions). So a bare `*.md` glob there is not a list of recons:
// it also holds `hunt-<target>-<stamp>.md` and `<hashfile>-<stamp>.md`, and
// the newest of *those* would be picked as "the latest recon" on a box where
// a hunt ran more recently than a recon — which is exactly what happened
// here, and why this filter exists.
//
// An osint report is named `<kind>-<slug>-<stamp>.md` (see `osint.caseDir`),
// and a kind is one of KIND_ORDER. Matching the first dash-separated token
// against that list is exact; `email-` cannot collide with `hunt-` or a hash
// filename.
const _OSINT_KINDS = new Set(KIND_ORDER);

// === SECTION === the tree ===

/**
 * One node of the result tree.
 *
 * `children` is a readonly tuple-equivalent, so a parsed tree is immutable
 * and can be compared and reused; `note` carries the dim marker shown
 * instead of children when a section parsed to nothing.
 */
export class Node {
  readonly label: string;
  readonly confidence: string;
  readonly children: readonly Node[];
  readonly note: string;

  constructor(init: {
    label: string;
    confidence?: string;
    children?: readonly Node[];
    note?: string;
  }) {
    this.label = init.label;
    this.confidence = init.confidence ?? '';
    this.children = init.children ?? [];
    this.note = init.note ?? '';
  }

  get isLeaf(): boolean {
    return this.children.length === 0;
  }
}

// === SECTION === confidence — read, never inferred ===

/**
 * The structural slice of theme.Palette this module needs (primary/accent/dim
 * hold chalk-compatible colour strings). Kept structural so the real Palette
 * satisfies it without an import edge to theme.ts.
 */
export interface PaletteLike {
  primary: string;
  accent: string;
  dim: string;
}

/** The three levels the playbook defines — the only strings accepted. */
export const CONFIDENCES = ['CONFIRMED', 'PROBABLE', 'UNVERIFIED'] as const;

/**
 * Which palette attribute each level is drawn in. Deliberately not the hunt's
 * `severityStyle` table: that one is keyed on critical/high/medium/low/info
 * and would fall through to `dim` for every confidence, which would silently
 * erase the distinction the tags exist to make.
 */
export const CONFIDENCE_STYLE: Record<string, string> = {
  CONFIRMED: 'primary',
  PROBABLE: 'accent',
  UNVERIFIED: 'dim',
};

const _CONF_RE = new RegExp(`\\b(${CONFIDENCES.join('|')})\\b`, 'i');

// `**Confidence** — CONFIRMED`, but tolerant: the bold may be missing, and
// the separator may be an em dash, a hyphen, a colon or nothing much at all.
const _CONF_LINE_RE =
  /^\s*\**\s*Confidence\s*\**\s*[—:\-–]?\s*\**\s*(CONFIRMED|PROBABLE|UNVERIFIED)\b/i;

// `**What**` — the marker that a block is a finding block even when the
// model forgot the Confidence line.
const _WHAT_RE = /^\s*\**\s*What\s*\**\s*[—:\-–]/i;

/**
 * The style string for one confidence level, from the palette. Rich-shaped on
 * purpose (`"bold #00ff41"` / `"#00ff41"`); `_applyStyle` resolves it to
 * chalk when rendering.
 */
export function confidenceStyle(
  confidence: string,
  palette: PaletteLike,
  opts?: { bold?: boolean },
): string {
  const attr = CONFIDENCE_STYLE[String(confidence ?? '').trim().toUpperCase()] ?? 'dim';
  const colour = attr === 'primary' ? palette.primary
    : attr === 'accent' ? palette.accent
      : palette.dim;
  return opts?.bold ? `bold ${colour}` : colour;
}

/**
 * The first confidence word in `text`, uppercased, or ''.
 *
 * First, not any: `CONFIRMED (exists) / PROBABLE (his)` is a CONFIRMED
 * finding with a caveat, and reading the PROBABLE would downgrade it.
 */
function _confidenceIn(text: string): string {
  const m = _CONF_RE.exec(text || '');
  return m ? m[1].toUpperCase() : '';
}

// === SECTION === markdown scraping ===

const _BOLD_RE = /\*\*(.+?)\*\*/g;
const _CODE_RE = /`([^`]*)`/g;
const _WS_RE = /\s+/g;

// An evidence filename — `01-dns.txt`, `03-xon.json`. The `Source` column of
// every table is made of these, and a source is not a finding: it says where
// a finding came from, not what it is. Matching them anywhere in a cell (not
// just as the whole cell) is what catches `05-portfolio-repo.txt (about.html: …)`.
const _SOURCE_TOKEN_RE =
  /[\w./-]+\.(?:txt|json|html|log|md|csv|xml|png|jpg)\b/i;

// A whole cell that is nothing but one evidence filename.
// (Ported as-is from the Python; currently referenced only by documentation.)
const _SOURCE_CELL_RE =
  /^[\w./-]+\.(?:txt|json|html|log|md|csv|xml|png|jpg)$/i;

// Cells that mean "there is no source" rather than carrying content.
const _EMPTY_CELLS = new Set(['', '—', '-', '–', 'n/a', 'none', 'nil']);

// Column names that hold provenance rather than content. A table's header row
// says which column is which, so the column is dropped by *name* wherever it
// sits — far more reliable than guessing from the cell, which cannot tell
// `GitHub login, Medium byline` (a source) from `Dhaka, Bangladesh` (a value).
const _SOURCE_COLUMNS = new Set(['source', 'sources', 'evidence', 'where', 'reference', 'ref']);

// Column names that hold a confidence. Read by name for the same reason.
const _CONFIDENCE_COLUMNS = new Set(['confidence', 'conf', 'certainty', 'level']);

/**
 * True if `cell` is a source column rather than content.
 *
 * Used only on a table's *last* content cell, where the source column sits.
 * Applying it to every cell would eat a value that merely mentions a filename
 * — `Gravatar | **None** — d=404; /<hash>.json → "User not found"` is a
 * finding whose text happens to contain `.json`.
 */
function _looksLikeSource(cell: string): boolean {
  const plain = _plain(cell);
  if (_EMPTY_CELLS.has(plain.toLowerCase())) return true;
  return _SOURCE_TOKEN_RE.test(plain);
}

/** Markdown out, readable text in — for a label, not for fidelity. */
function _plain(text: string): string {
  let s = (text || '').replace(_CODE_RE, '$1');
  s = s.replace(_BOLD_RE, '$1');
  s = s.replace(/\\\|/g, '|');
  return s.replace(_WS_RE, ' ').trim();
}

/** Python sliced by code points; truncation by UTF-16 units would split
 * surrogate pairs, so slice the code-point array instead. */
function _truncate(text: string, limit: number = 96): string {
  const cps = Array.from(text);
  if (cps.length <= limit) return text;
  return cps.slice(0, limit - 1).join('').replace(/\s+$/, '') + '…';
}

function _isTableRow(line: string): boolean {
  const s = line.trim();
  return s.startsWith('|') && s.endsWith('|') && (s.match(/\|/g)?.length ?? 0) >= 2;
}

/** `|---|---|` — the row that makes a markdown table a table. */
function _isSeparatorRow(line: string): boolean {
  const inner = line.trim().replace(/^\|+|\|+$/g, '');
  if (!inner) return false;
  for (const ch of inner) {
    if (!'-: |'.includes(ch)) return false;
  }
  return true;
}

// A pipe that is not escaped — the cell separator. `\|` inside a cell is a
// literal pipe (`Ethical Hacker \| Red Team Expert`), and splitting on it
// would cut a value in half and invent a column that does not exist.
const _CELL_SPLIT_RE = /(?<!\\)\|/;

function _cells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split(_CELL_SPLIT_RE).map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * A table row as a finding, or null if the row says nothing.
 *
 * With a `header` (the column names from the row above the separator) the
 * source and confidence columns are dropped **by name**, which is exact. Two
 * of the three real reports put free-text in their source column — `GitHub
 * login, Medium byline, README footer` — and no amount of guessing at the
 * cell can tell that from a value like `Dhaka, Bangladesh`. The header is
 * the only thing that actually knows.
 *
 * Without a header the fallback is to drop a trailing cell that looks like an
 * evidence filename, which covers the simpler tables.
 *
 * What survives is joined with ` · `, which keeps a
 * `Provider · Google / Gmail — free consumer provider` row readable without
 * the em dashes in the values colliding with the separator.
 */
function _rowToNode(line: string, header: string[] | null = null): Node | null {
  const cells = _cells(line);
  if (!cells.length) return null;

  // A source column is provenance when it *trails* the last value column, and
  // the row's subject when it leads. `Attribute | Value | Source` ends in a
  // citation to drop; `Source | Result | Evidence` opens with the thing being
  // tested, and dropping it would leave `2 commits` with no clue which search
  // found them. `Source | Result | Evidence` in the middle is provenance too.
  let lastValue = header && header.length > 0 ? header.length - 1 : 0;
  const dropColumns = new Set<string>([..._SOURCE_COLUMNS, ..._CONFIDENCE_COLUMNS]);
  while (lastValue > 0 && header
    && dropColumns.has(_plain(header[lastValue]!).trim().toLowerCase())) {
    lastValue--;
  }

  const drop = new Set<number>();
  if (header) {
    header.forEach((name, i) => {
      const key = _plain(name).trim().toLowerCase();
      if (_CONFIDENCE_COLUMNS.has(key)) {
        drop.add(i);
      } else if (_SOURCE_COLUMNS.has(key) && i > lastValue) {
        drop.add(i);
      }
    });
  }

  let confidence = '';
  const content: string[] = [];
  cells.forEach((cell, i) => {
    const conf = _confidenceIn(cell);
    if (drop.has(i)) {
      // A dropped confidence column still supplies the tag — that is what
      // the column is for.
      if (conf && !confidence) confidence = conf;
      return;
    }
    // Without a header, a cell that is *only* a confidence is the confidence
    // column; one that merely mentions the word is content.
    if (conf && _plain(cell).toUpperCase().startsWith(conf)) {
      if (!confidence) confidence = conf;
      return;
    }
    content.push(cell);
  });

  if (!content.length) return null;

  if (!header && content.length > 1 && _looksLikeSource(content[content.length - 1]!)) {
    content.pop();
  }

  const label = _truncate(content.filter((c) => _plain(c)).map((c) => _plain(c)).join(' · '));
  if (!label) return null;
  return new Node({ label, confidence });
}

/** The column names of the table whose header row is at `lines[i]`. */
function _headerOf(lines: string[], i: number): string[] | null {
  const nxt = i + 1 < lines.length ? lines[i + 1]! : '';
  return _isSeparatorRow(nxt) ? _cells(lines[i]!) : null;
}

// === SECTION === parsing ===

/** A `###` block inside a section, or the anonymous run before the first. */
interface _Block {
  title: string;
  lines: string[];
}

/**
 * Split a section body on its `###` headings.
 *
 * Content before the first `###` becomes an anonymous block, so a section
 * written as bare tables (which two of the three real reports are) is
 * handled by the same path as one written as subsections.
 */
function _blocks(body: string[]): _Block[] {
  const out: _Block[] = [{ title: '', lines: [] }];
  for (const line of body) {
    if (line.startsWith('### ')) {
      out.push({ title: _heading(line.slice(4)), lines: [] });
    } else if (line.startsWith('###')) {
      out.push({ title: _heading(line.slice(3)), lines: [] });
    } else {
      out[out.length - 1]!.lines.push(line);
    }
  }
  return out.filter((b) => b.title || b.lines.some((l) => l.trim() !== ''));
}

// A trailing `— 03-xon-analytics.json` on a heading, or the comma-separated
// list of them a heading sometimes cites. The heading is a label, and the
// evidence files belong in the report, not in the tree.
const _TITLE_SOURCE_RE =
  /\s*[—–-]\s*`?[\w./-]+\.(?:txt|json|html|log|md|csv|xml|png|jpg)`?(?:\s*,\s*`?[\w./-]+\.(?:txt|json|html|log|md|csv|xml|png|jpg)`?)*\s*$/i;

/** A heading as a label: markdown off, trailing evidence file off. */
function _heading(text: string): string {
  let s = _plain(text);
  let prev: string | null = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(_TITLE_SOURCE_RE, '').trim();
  }
  return s;
}

/** The readable sentences of a block, with tables and markup stripped. */
function _prose(lines: string[]): string {
  const kept: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('---')) {
      continue;
    }
    kept.push(_plain(l));
  }
  return kept.filter((k) => k).join(' ').replace(_WS_RE, ' ').trim();
}

/** One block, by the ladder: finding block, then table, then prose. */
function _blockToNodes(block: _Block): Node[] {
  let conf = '';
  let hasWhat = false;
  for (const line of block.lines) {
    const m = _CONF_LINE_RE.exec(line);
    if (m && !conf) {
      conf = m[1]!.toUpperCase();
    } else if (_WHAT_RE.test(line)) {
      hasWhat = true;
    }
  }

  // Rung 1 — a real finding block. The `###` heading is the title, and that
  // is the whole point of this rung: a written title beats a scraped cell.
  if (block.title && (conf || hasWhat)) {
    return [new Node({ label: block.title, confidence: conf })];
  }

  // Rung 2 — table rows. A titled block keeps its rows underneath it as
  // children, because `### 4a. Breach list` and `### 4b. Infostealer
  // infections` are different sources and flattening them would lose that.
  //
  // A row immediately followed by `|---|` is a table *header* — `Item | Value
  // | Source` names the columns, it does not report anything, and counting it
  // as a finding would inflate every section that opens with a table. It is
  // kept as the column list instead, so the rows under it can be trimmed by
  // name.
  const rows: Node[] = [];
  let header: string[] | null = null;
  block.lines.forEach((line, i) => {
    if (!_isTableRow(line) || _isSeparatorRow(line)) return;
    const found = _headerOf(block.lines, i);
    if (found !== null) {
      header = found;
      return;
    }
    const node = _rowToNode(line, header);
    if (node !== null) rows.push(node);
  });
  if (rows.length) {
    if (block.title) {
      return [new Node({ label: block.title, children: rows })];
    }
    return rows;
  }

  // Rung 3 — prose. The headline is the run's most important paragraph; it
  // gets a leaf even though it is not a "finding" in the strict sense.
  const text = _prose(block.lines);
  if (block.title) {
    if (text) return [new Node({ label: block.title, note: _truncate(text, 200) })];
    return [new Node({ label: block.title })];
  }
  if (text) return [new Node({ label: _truncate(text, 200) })];
  return [];
}

/**
 * A report's markdown as a tree.
 *
 * The root is the `# H1`; its children are the `## ` sections in document
 * order — including `## Headline` and `## Coverage`, which are not dropped
 * because they are the two sections an operator reads first. Section names
 * are whatever the report happens to use: the parser keys on `## ` and never
 * on a hard-coded list, which is what lets it survive the github report's
 * entirely different sections.
 */
export function parseReport(text: string, opts?: { fallbackTitle?: string }): Node {
  const lines = (text || '').split(/\r\n|\r|\n/);

  let title = '';
  const sections: Array<{ name: string; body: string[] }> = [];
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (sections.length) sections[sections.length - 1]!.body.push(line);
      continue;
    }
    if (line.startsWith('## ')) {
      sections.push({ name: _plain(line.slice(3)), body: [] });
      continue;
    }
    if (line.startsWith('##')) {
      sections.push({ name: _plain(line.slice(2)), body: [] });
      continue;
    }
    if (line.startsWith('# ')) {
      if (!title) title = _plain(line.slice(2));
      continue;
    }
    if (sections.length) sections[sections.length - 1]!.body.push(line);
  }

  const children: Node[] = [];
  for (const { name, body } of sections) {
    const found: Node[] = [];
    for (const block of _blocks(body)) {
      found.push(..._blockToNodes(block));
    }
    if (found.length) {
      children.push(new Node({ label: name, children: found }));
    } else {
      // Rung 4 — say it parsed nothing, rather than showing a bare branch
      // that reads as "nothing was there".
      const n = body.filter((l) => l.trim() !== '').length;
      children.push(new Node({
        label: name,
        note: n
          ? `(${n} line${n !== 1 ? 's' : ''} — no findings parsed)`
          : '(empty section)',
      }));
    }
  }

  return new Node({ label: title || opts?.fallbackTitle || 'OSINT report', children });
}

/**
 * Read and parse an archived report.
 *
 * Decode with a non-fatal TextDecoder (the Python used
 * `errors="replace"`): the reports carry em dashes, `…` and the occasional
 * stray byte from a scraped page, and a summary view must not be the thing
 * that throws on a report the operator can otherwise read.
 */
export function parseReportFile(p: string): Node {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(fs.readFileSync(p));
  } catch {
    return new Node({ label: _stem(p), note: '(could not read the report)' });
  }
  return parseReport(text, { fallbackTitle: _stem(p) });
}

/** Python `Path.stem` — basename without the last extension. */
function _stem(p: string): string {
  return path.basename(p, path.extname(p));
}

// === SECTION === finding a report to show ===

function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Is `p` a report this module can read — i.e. an archived recon?
 *
 * The archive is shared with hunt and crack, so "is a .md under reports/" is
 * not the question. It is whether the filename's leading token is a recon
 * kind, which is the only thing that distinguishes
 * `email-target-example.com-20261005-193807.md` from
 * `hunt-x.test-20261012-194709.md` and `some-tgs.txt-20261013-181853.md`.
 */
function _isOsintReport(p: string): boolean {
  return _OSINT_KINDS.has(path.basename(p).split('-', 1)[0]!.toLowerCase());
}

/**
 * Every recon case directory still on disk, newest first.
 *
 * Normally empty: a finished run archives its report and deletes the case.
 * But `finaliseCase` is called from the turn's finally block, so an app
 * killed outright — Ctrl+C twice, a crash, a closed terminal — never gets
 * there, and the case survives with a perfectly readable `report.md` in it.
 * That is not a hypothetical: it is the state of this machine, where all
 * three real reports are sitting in case directories that were never
 * finalised.
 *
 * Ignoring those would mean `/osint-tree` says "no archived reports yet"
 * while three recons are on disk, which is the same class of lie as an empty
 * tree — the operator cannot tell "there is nothing" from "I did not look".
 */
function _caseDirs(cfg: OsintCfg): string[] {
  const root = path.join(cfg.stateDir, 'osint');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    const p = path.join(root, e.name);
    try {
      // statSync (not the Dirent flag) so symlinked case dirs behave like
      // Python's Path.is_dir(), which follows symlinks.
      if (fs.statSync(p).isDirectory()) dirs.push(p);
    } catch {
      /* unreadable entry — not a case dir */
    }
  }
  return dirs.sort((a, b) => _mtime(b) - _mtime(a));
}

/** `dir/*.md`, sorted by path. */
function _globMd(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md'))
    .map((n) => path.join(dir, n))
    .sort();
}

/** `dir/<sub>/*.md`, sorted by path — one level deep, directories only. */
function _globMdOneDeep(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const sub = path.join(dir, e.name);
    try {
      if (fs.statSync(sub).isDirectory()) out.push(..._globMd(sub));
    } catch {
      /* unreadable entry */
    }
  }
  return out.sort();
}

/**
 * The report inside an unfinalised `caseDirPath`, if it has one.
 *
 * Same question `_findReport` in osint.ts answers for the archive step,
 * minus the git-clone guard: that guard exists so `finaliseCase` does not
 * *delete* a cloned repo's own `report.md` along with the evidence, which is
 * a destructive decision. Reading one back is not destructive, and a case
 * directory here is a recon case by construction.
 */
function _reportIn(caseDirPath: string): string | null {
  const direct = path.join(caseDirPath, 'report.md');
  if (_isFile(direct)) return direct;
  for (const p of [..._globMd(caseDirPath), ..._globMdOneDeep(caseDirPath)]) {
    if (path.basename(p).toLowerCase().includes('report')) return p;
  }
  return null;
}

/**
 * Resolve `which` to a recon report, or the newest one.
 *
 * Newest by mtime, not by name: the filenames embed a timestamp and would
 * usually sort correctly, but a report copied in by hand would not, and "the
 * latest run" is a question about time.
 *
 * Two stores are searched, because a recon can be in either: the archive
 * (`<stateDir>/reports/`, where a finished run leaves it) and any case
 * directory that never finalised (see `_caseDirs`). The archive wins a tie
 * on mtime — a finalised report is the one that got tidied.
 *
 * `which` may be a path (taken as-is — an explicit path is the operator
 * overriding both stores, so it is not second-guessed), a kind, or a case
 * name. Kinds and case names are matched against **recon** reports only; see
 * `_isOsintReport` for why the shared archive makes that necessary.
 */
export function findReport(cfg: OsintCfg, which?: string | null): string | undefined {
  const base = reportsDir(cfg);
  let archived: string[] = [];
  try {
    archived = fs.readdirSync(base)
      .filter((n) => n.endsWith('.md'))
      .map((n) => path.join(base, n))
      .filter((q) => _isFile(q) && _isOsintReport(q));
  } catch {
    archived = [];
  }
  // (report, name-to-match-on) — a live report is matched on its *directory*
  // name, since the file inside is just `report.md` and carries no target.
  const live: Array<{ r: string; name: string }> = [];
  for (const d of _caseDirs(cfg)) {
    const r = _reportIn(d);
    if (r !== null) live.push({ r, name: path.basename(d) });
  }

  let hits: string[];
  if (which) {
    const p = expandTilde(which);
    if (_isFile(p)) return p;

    const matches = (name: string): boolean => {
      // A case name or a bare kind: `email`, `github`, `github-torvalds`.
      // `which-*` first, so `/osint-tree email` prefers `email-…` over a
      // case name that merely contains "email" somewhere in the middle.
      return name.startsWith(`${which}-`) || name.includes(which);
    };

    hits = archived.filter((q) => matches(path.basename(q)));
    hits = hits.concat(live.filter(({ name }) => matches(name)).map(({ r }) => r));
    if (!hits.length) return undefined;
  } else {
    hits = archived.concat(live.map(({ r }) => r));
  }

  // max() by mtime; `>` keeps the first on ties, like Python's max().
  let best = hits[0]!;
  for (const h of hits) {
    if (_mtime(h) > _mtime(best)) best = h;
  }
  return best;
}

// === SECTION === rendering ===

/** `(total leaves, {confidence: count})` for the whole tree. */
export function countFindings(node: Node): [number, Record<string, number>] {
  let total = 0;
  const tally: Record<string, number> = {};
  for (const child of node.children) {
    if (child.isLeaf) {
      total += 1;
      if (child.confidence) {
        tally[child.confidence] = (tally[child.confidence] ?? 0) + 1;
      }
    } else {
      const [subTotal, subTally] = countFindings(child);
      total += subTotal;
      for (const [k, v] of Object.entries(subTally)) {
        tally[k] = (tally[k] ?? 0) + v;
      }
    }
  }
  return [total, tally];
}

/** `12 findings · 9 CONFIRMED · 2 PROBABLE · 1 UNVERIFIED`. */
export function summaryLine(node: Node): string {
  const [total, tally] = countFindings(node);
  if (!total) return 'no findings parsed';
  const parts = [`${total} finding${total !== 1 ? 's' : ''}`];
  for (const level of CONFIDENCES) {
    if (tally[level]) parts.push(`${tally[level]} ${level}`);
  }
  return parts.join(' · ');
}

/** A chalk-compatible painter: callable, with a `.bold` modifier. */
interface _Painter {
  (s: string): string;
  bold(s: string): string;
}

const _identityPainter: _Painter = Object.assign((s: string) => s, {
  bold: (s: string) => s,
});

/** Resolve a palette colour string (hex or chalk colour name) to a painter. */
function _colour(c: string): _Painter {
  if (c.startsWith('#')) return chalk.hex(c);
  const named = (chalk as unknown as Record<string, unknown>)[c];
  return typeof named === 'function' ? (named as _Painter) : _identityPainter;
}

/** Apply a Rich-shaped style string (`"bold X"` / `"X"`) with chalk. */
function _applyStyle(style: string, text: string): string {
  if (style.startsWith('bold ')) return _colour(style.slice(5)).bold(text);
  return _colour(style)(text);
}

/** One node's label, confidence tagged and coloured (Python `_label_text`). */
function _labelText(node: Node, palette: PaletteLike): string {
  let s = '';
  if (node.confidence) {
    s += _applyStyle(
      confidenceStyle(node.confidence, palette, { bold: true }),
      `[${node.confidence}] `,
    );
  }
  s += node.children.length
    ? _applyStyle(`bold ${palette.primary}`, node.label)
    : _applyStyle(palette.primary, node.label);
  if (node.note) {
    s += _applyStyle(palette.dim, `  ${node.note}`);
  }
  return s;
}

/**
 * The parsed tree rendered as a coloured string (Python built a
 * `rich.tree.Tree`; here the box-drawing glyphs + chalk carry the same
 * shape), ready for the transcript.
 *
 * Colours come from the palette, so the tree reads in whatever theme the
 * operator is running — the same rule every other renderable follows.
 */
export function renderTree(node: Node, palette: PaletteLike): string {
  const lines: string[] = [_labelText(node, palette)];
  const walk = (children: readonly Node[], prefix: string): void => {
    children.forEach((child, i) => {
      const last = i === children.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + _labelText(child, palette));
      walk(child.children, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(node.children, '');
  return lines.join('\n');
}
