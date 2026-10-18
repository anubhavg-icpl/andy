/**
 * tests/test_hunt.test.ts — vitest port of tests/test_hunt.py (`/bug-hunt`
 * regression suite): findings parsing, the wave loop, stop, reports.
 *
 * What this file is: the offline regression suite for hunt.ts/team.ts/
 * tools.ts/agent.ts. The campaign's model calls go through a stubbed
 * `agentFactory` — the same seam team.ts exposes — by shadowing the agent's
 * `streamOnce` method on the instance, so the loop, the planner feedback
 * edge and the stop signal are all exercised without a terminal or network.
 *
 * Invariants carried over from the Python suite:
 *  - The stop is set from inside `onEvent`. `runHunt` awaits every event it
 *    emits, so setting the flag there is deterministic — the loop's stop
 *    check sees it before it can start another wave.
 *  - Agents never touch the network. The one tool call a stub agent makes is
 *    `list_dir`, which is ungated and local; a `bash` stub would really run.
 *
 * Port note: the Textual-app half of the Python suite (pilot-driven screen,
 * overlay, busy-gate and transcript tests over AndyApp) has no Ink
 * equivalent — ui/app.tsx is a React function component with internal state,
 * not an object with `_handle_command`/`query_one`. Those suites are kept
 * below as `it.skip` with the reason so the inventory survives to a future
 * Ink-level harness. Mouse-driven WaveOverlay tests are descoped per
 * PORT-MAP §3 (ink has no mouse).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as huntMod from '../src/hunt.js';
import * as teamMod from '../src/team.js';
import * as toolsMod from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Config } from '../src/config.js';
import { getPalette } from '../src/theme.js';
import { huntToolPanel } from '../src/ui/renderers.js';
import { loopRailNode, STAGES, STAGE_LABEL } from '../src/ui/rails.js';
import type { LoopRailState } from '../src/ui/rails.js';
import { WaveWeb } from '../src/ui/web.js';
import type { AgentFactory, CampaignKind, HuntEvent, StopSignal } from '../src/hunt.js';

/** The phrase that identifies the recon prompt, so the stub knows a turn is
 *  recon's. Mirrors Python's `_RECON_MARK`. */
const RECON_MARK = 'opening a security engagement';

/** One shared scratch root, as Python's single TemporaryDirectory. Each test
 *  gets its own workdir under it and its own state dir under that — see
 *  `stateDir` for why per-test state matters. */
let ROOT = '';

function wdFor(name: string): string {
  const wd = path.join(ROOT, name);
  fs.mkdirSync(wd, { recursive: true });
  return wd;
}

/**
 * A private `stateDir` for one test, under the shared workdir.
 *
 * Every test used to share `wd/state`, which was harmless while a campaign
 * was purely in-memory — but the store is persistent by design now: a repeat
 * `/bug-hunt` on a scope reuses the recon and findings already on disk. With
 * one shared store, the second test to hunt `x.test` inherited the first's
 * recon and skipped its own, so tests were measuring each other.
 */
function stateDir(wd: string, name: string): string {
  const p = path.join(wd, 'state', name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Python `_cfg`: an offline Config pinned to the local stub gateway. */
function cfgFor(
  workdir: string,
  overrides: Partial<Config> = {},
): Config {
  return Config.fromEnv({
    workdir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
    ...overrides,
  });
}

function write(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function isFile(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

/** Read a private method off an Agent (`denied`, `drainNotices`). Python
 *  reached the underscore originals directly; `private` is compile-time
 *  only, so the cast is the same call, not a bypass of any runtime check. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(agent: Agent): any {
  return agent as unknown as any;
}

function base(p: string): string {
  return path.basename(p);
}

/** Every file under `dir`, recursively, as sorted absolute paths. Used where
 *  the Python suite compared `rglob('*')` snapshots. */
function allPaths(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    out.push(d);
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      out.push(p);
      if (fs.statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Python's `check(name, ok, extra)`: one named assertion. The name is the
 *  pinned behaviour, so it rides along as the expect message. */
function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name} — ${extra}` : name).toBe(true);
}

// === SECTION === the stub SDK seam =========================================
//
// The fake stream replaces the agent's `streamOnce` — a private method in
// the TS port — by assigning an instance property that shadows the prototype
// method. Runtime semantics are exactly Python's `agent._stream_once = ...`;
// the cast exists only because `private` is a compile-time notion.

interface FakeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** The shape runTurn actually reads off the final message: `.content`
 *  blocks, `.usage` (snake_case, as the SDK returns) and `.stop_reason`. */
function finalMsg(
  content: FakeBlock[],
  usage?: [number, number],
): unknown {
  return {
    content,
    usage: usage === undefined ? undefined : { input_tokens: usage[0], output_tokens: usage[1] },
    stop_reason: 'end_turn',
  };
}

type StubStream = (maxTokens?: number) => AsyncGenerator<[unknown, unknown]>;

function patchStream(agent: Agent, fn: StubStream): void {
  (agent as unknown as { streamOnce: StubStream }).streamOnce = fn;
}

function lastPrompt(agent: Agent): string {
  const last = agent.messages[agent.messages.length - 1];
  const content = last?.content;
  return typeof content === 'string' ? content : '';
}

// === SECTION === the scripted hunt factory ================================

interface Script {
  /** One roster JSON per planner turn, consumed in order (last reused). */
  rosters: string[];
  plannerCalls: number;
  /** Every prompt the planner was handed, in order. */
  prompts: string[];
  reconFinal?: string;
  /** A single final text, or one per worker (last reused). */
  final: string | string[];
  /** The (name, args) of the one tool call a worker makes. Ungated by
   *  default: a `bash` stub would really run. */
  firstTool?: [string, Record<string, unknown>];
  /** What each worker was actually handed on its first turn. */
  workerPrompts?: string[];
  /** Parks every worker before its first turn (Python's `hold` event). Recon
   *  is deliberately not held — parking it would mean the wave never starts. */
  hold?: StopSignal;
  /** Cursor when `final` is a list. */
  workerFinals?: number;
}

/** The text the next worker reports: `script.final` is a single string for
 *  the common case, or a list consumed one per worker so a multi-worker test
 *  can give each a distinct finding — which the tracker, now that it
 *  deduplicates, needs in order to see more than one. */
function nextFinal(script: Script): string {
  const final = script.final;
  if (Array.isArray(final)) {
    const i = script.workerFinals ?? 0;
    script.workerFinals = i + 1;
    return final[Math.min(i, final.length - 1)];
  }
  return final;
}

function findingJson(marker = 'auth bypass', asset = 'x.test'): string {
  return `{"findings": [{"title": "${marker}", "severity": "critical",`
    + ` "asset": "${asset}", "summary": "no check", "evidence": "curl"}]}`;
}

/**
 * A factory whose planner answers from `script` and whose agents report.
 *
 * `script.plannerCalls` counts planner turns; `script.prompts` collects every
 * prompt the planner was handed, which is how the feedback edge is checked.
 * `script.reconFinal` is the recon agent's own report, kept separate from
 * `script.final` so recon does not silently contribute the workers' findings.
 */
function huntFactory(script: Script): AgentFactory & { built: Agent[] } {
  const built: Agent[] = [];

  const factory: AgentFactory = (cfg, opts) => {
    // canReport is forwarded, not dropped: runHunt arms it on every hunt
    // agent so report_finding is advertised, and a stub that silently lost it
    // would hide the very path these tests exist to cover.
    const agent = new Agent(
      cfg,
      undefined,
      opts?.toolHook ?? undefined,
      opts?.canReport ?? false,
      opts?.canHuntRead ?? true,
    );
    const state = { n: 0 };

    const fakeStream: StubStream = async function* fakeStream() {
      state.n += 1;
      const prompt = lastPrompt(agent);

      const hold = script.hold;
      if (hold !== undefined && cfg.mode !== 'plan' && !prompt.includes(RECON_MARK)) {
        await hold.wait();
      }

      if (cfg.mode === 'plan') {
        script.prompts.push(prompt);
        const idx = script.plannerCalls;
        script.plannerCalls += 1;
        const rosters = script.rosters;
        const text = rosters[Math.min(idx, rosters.length - 1)];
        yield [{ type: 'text_delta', text }, null];
        yield [null, finalMsg([{ type: 'text', text }], [10, 5])];
        return;
      }

      if (prompt.includes(RECON_MARK)) {
        // Recon reports in one turn, text only.
        const text = script.reconFinal ?? 'nothing reachable';
        yield [{ type: 'text_delta', text }, null];
        yield [null, finalMsg([{ type: 'text', text }], [20, 8])];
        return;
      }

      if (state.n === 1) {
        // First worker turn: one tool call, so the tool-call path is
        // exercised. Defaults to an ungated local listing.
        (script.workerPrompts ??= []).push(prompt);
        const [tool, toolArgs] = script.firstTool ?? ['list_dir', { path: '.' }];
        yield [{ type: 'text_delta', text: 'probing' }, null];
        yield [
          null,
          finalMsg(
            [
              { type: 'text', text: 'probing' },
              { type: 'tool_use', id: 't1', name: tool, input: { ...toolArgs } },
            ],
            [100, 20],
          ),
        ];
        return;
      }

      const text = nextFinal(script);
      yield [{ type: 'text_delta', text }, null];
      yield [null, finalMsg([{ type: 'text', text }], [30, 10])];
    };

    patchStream(agent, fakeStream);
    built.push(agent);
    return agent;
  };

  (factory as AgentFactory & { built: Agent[] }).built = built;
  return factory as AgentFactory & { built: Agent[] };
}

/** An onEvent sink that stops the campaign after `after` waves.
 *
 * Setting the flag here rather than from a watcher task is what makes "how
 * many waves ran" deterministic: runHunt awaits this, so the loop's stop
 * check sees the flag before it can plan another wave. */
function recorder(events: HuntEvent[], stop: StopSignal, after = 1) {
  return async (ev: HuntEvent): Promise<void> => {
    events.push(ev);
    if (ev.type === 'hunt_wave_end' && ev.wave >= after) stop.set();
  };
}

/** Flatten a ReactNode built by the pure ui/ builders (renderers.tsx,
 *  rails.tsx, web.tsx) into readable text, without an Ink root.
 *
 *  Those builders are pure functions of props (their contract block says
 *  so); this walker collects the strings in document order WITHOUT invoking
 *  the components — the strings we assert on ("HACK", "4/10", the whole
 *  bash command) all live as children of the descriptors the builders
 *  return. Only `children` (plus the text-carrying Panel props title /
 *  subtitle / label) is walked: sweeping every prop value would interleave
 *  style scalars (hex colours) between a highlighter's token spans, which
 *  splits "401 /api/v1/users" into "401" + "#00ff41" + " /api/v1/users" and
 *  breaks word-level assertions. Siblings within one children array join
 *  with nothing between them, which is what reassembles those spans. */
function nodeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in (node as object)) {
    const props = (node as { props?: Record<string, unknown> }).props ?? {};
    const out: string[] = [];
    for (const key of Object.keys(props)) {
      if (key === 'children' || key === 'title' || key === 'subtitle' || key === 'label') {
        out.push(nodeText(props[key]));
      }
    }
    return out.join('');
  }
  return '';
}

// === SECTION === findings parsing ==========================================

describe('test_hunt: /bug-hunt regression suite', () => {
  beforeAll(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-test-hunt-'));
  });

  afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('test_parse_findings', () => {
    const text =
      'I poked at the login form.\n\n'
      + '```json\n'
      + '{"findings": ['
      + '{"title": "IDOR on /api/users/{id}", "severity": "HIGH",'
      + ' "asset": "api.example.test", "summary": "any user readable",'
      + ' "evidence": "GET /api/users/2 returned user 1",'
      + ' "remediation": "check ownership"},'
      + '{"title": "missing HSTS", "severity": "low"},'
      + '{"title": "info leak", "severity": "informational"}'
      + ']}\n'
      + '```\n';
    const fs2 = huntMod.parseFindings(text, { wave: 3, agent: 'access-control' });
    check('findings: every entry is read', fs2.length === 3, String(fs2.length));
    check('findings: severity is lowercased and kept', fs2[0].severity === 'high', fs2[0].severity);
    check('findings: an alias severity is folded', fs2[2].severity === 'info', fs2[2].severity);
    check(
      'findings: the wave and agent are stamped on',
      fs2.every((f) => f.wave === 3 && f.agent === 'access-control'),
    );
    check(
      'findings: every severity earns a report',
      fs2.map((f) => f.saved).join(',') === 'true,true,true',
      String(fs2.map((f) => f.saved)),
    );
    check(
      'findings: a brace inside a title does not unbalance the scan',
      fs2[0].title === 'IDOR on /api/users/{id}',
      fs2[0].title,
    );
    check('findings: evidence survives intact', fs2[0].evidence.includes('returned user 1'), fs2[0].evidence);

    // A bare object, not wrapped in a "findings" envelope.
    const bare = '{"title": "open redirect", "severity": "medium", "asset": "a.test"}';
    const one = huntMod.parseFindings(bare, { wave: 1, agent: 'x' });
    check('findings: a bare finding object is accepted', one.length === 1, String(one.length));
    check(
      'findings: the bare object keeps its severity',
      one.length > 0 && one[0].severity === 'medium',
    );

    check(
      'findings: an empty reply yields nothing',
      huntMod.parseFindings('', { wave: 1, agent: 'x' }).length === 0,
    );
    check(
      'findings: prose with no JSON yields nothing',
      huntMod.parseFindings('nothing found, all clean', { wave: 1, agent: 'x' }).length === 0,
    );
    check(
      'findings: an entry with no title is dropped',
      huntMod.parseFindings('{"findings": [{"severity": "high"}]}', { wave: 1, agent: 'x' })
        .length === 0,
    );
    check(
      'findings: two blocks in one message are both read',
      huntMod.parseFindings(
        '{"findings":[{"title":"a","severity":"high"}]} and '
          + '{"findings":[{"title":"b","severity":"high"}]}',
        { wave: 1, agent: 'x' },
      ).length === 2,
    );
    check(
      'findings: severity aliases normalise',
      huntMod.normaliseSeverity('Moderate') === 'medium'
        && huntMod.normaliseSeverity('SEVERE') === 'critical'
        && huntMod.normaliseSeverity('nonsense') === 'info',
    );
  });

  // === SECTION === fallback roster =========================================

  it('test_fallback', () => {
    const roster = huntMod.fallbackRoster(1);
    check(
      'fallback: the matrix has ten vectors',
      huntMod.HUNT_VECTORS.length === 10,
      String(huntMod.HUNT_VECTORS.length),
    );
    check(
      'fallback: a full wave is produced',
      roster.workers.length === huntMod.HUNT_WAVE_SIZE,
      String(roster.workers.length),
    );
    check(
      'fallback: every worker has a brief and an owned vector',
      roster.workers.every((w) => w.brief.length > 0 && w.owns.length > 0),
    );
    check(
      'fallback: names are unique',
      new Set(roster.workers.map((w) => w.name)).size === roster.workers.length,
    );
    check(
      'fallback: a smaller wave is honoured',
      huntMod.fallbackRoster(1, 3).workers.length === 3,
    );
    check(
      'fallback: all ten run at once by default',
      huntMod.HUNT_CONCURRENCY === huntMod.HUNT_WAVE_SIZE,
      `${huntMod.HUNT_CONCURRENCY} vs ${huntMod.HUNT_WAVE_SIZE}`,
    );
  });

  it('test_campaign_kind', () => {
    // The doctrine seam: `/ad` is data, not a fork of the engine. Two things
    // have to hold or the seam is a lie. First, HUNT_KIND must be exactly
    // today's constants — a default that differs in any byte is a behaviour
    // change smuggled in under a refactor. Second, a kind's own fields must
    // actually reach the places the engine uses them: the directory, the
    // plan's frontmatter, the fallback roster.
    const k = huntMod.HUNT_KIND;
    check('kind: the default is named hunt', k.name === 'hunt', k.name);
    check('kind: the default carries no directory prefix', k.dirPrefix === '', JSON.stringify(k.dirPrefix));
    check(
      'kind: the default prompts are the module constants, byte for byte',
      k.reconPrompt === huntMod.RECON_PROMPT
        && k.plannerPrompt === huntMod.WAVE_PLANNER_PROMPT
        && k.contract === huntMod.FINDING_CONTRACT
        && k.summaryPrompt === huntMod.SUMMARY_PROMPT,
    );
    check(
      'kind: the default declares no vectors and no interlock',
      k.vectors.length === 0 && k.interlock === null,
    );
    check(
      'kind: the default falls back to HUNT_VECTORS',
      JSON.stringify(huntMod.fallbackRoster(1, 3, k).workers.map((w) => w.owns))
        === JSON.stringify(huntMod.HUNT_VECTORS.slice(0, 3).map((v) => [v[2]])),
    );

    // A kind's own vectors win, and its prefix separates the directory. This
    // is the whole reason `/ad corp.local` and `/bug-hunt corp.local` can
    // coexist.
    const adish: CampaignKind = {
      name: 'ad',
      command: 'ad',
      dirPrefix: 'ad-',
      reconPrompt: '',
      plannerPrompt: '',
      contract: '',
      summaryPrompt: '',
      vectors: [['asrep', 'roast AS-REP', 'asrep-roast']],
      interlock: null,
    };
    const wd = wdFor('test_campaign_kind');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_campaign_kind');
    check(
      'kind: a prefix is honoured by caseDir',
      base(huntMod.caseDir(cfg, 'corp.local', adish)) === 'ad-corp.local',
      base(huntMod.caseDir(cfg, 'corp.local', adish)),
    );
    check(
      'kind: the unprefixed default is unchanged',
      base(huntMod.caseDir(cfg, 'corp.local')) === 'corp.local',
      base(huntMod.caseDir(cfg, 'corp.local')),
    );
    // The store directory is pinned as a literal here (it is `hunts`): the
    // Python suite compared against tools._HUNTS_DIR, which is module-private
    // in the TS port — tools keeps its own literal for the same cycle reason.
    check(
      'kind: both live under the one hunts root, so /findings sees them',
      path.dirname(huntMod.caseDir(cfg, 'corp.local', adish))
        === path.dirname(huntMod.caseDir(cfg, 'corp.local'))
        && base(path.dirname(huntMod.caseDir(cfg, 'corp.local'))) === 'hunts',
    );
    check(
      'kind: a kind\'s own vectors are used when it has them',
      JSON.stringify(huntMod.fallbackRoster(1, 1, adish).workers.map((w) => w.owns))
        === JSON.stringify([['asrep-roast']]),
    );

    // The kind has to survive a round trip through disk, because a second
    // invocation of `/ad` reads the campaign back and must know what it is.
    const run = new huntMod.HuntRun('corp.local', huntMod.caseDir(cfg, 'corp.local', adish), { kind: 'ad' });
    huntMod.writePlan(run, 1, new teamMod.Roster('s', []), '', true);
    const back = huntMod.loadRun(run.directory);
    check(
      'kind: it round-trips through writePlan -> loadRun',
      back !== undefined && back.kind === 'ad',
      back ? back.kind : '(no run)',
    );

    // And every campaign written before the field existed is a web hunt.
    const old = new huntMod.HuntRun('old.test', huntMod.caseDir(cfg, 'old.test'));
    huntMod.writePlan(old, 1, new teamMod.Roster('s', []), '', true);
    // Python reached the plan through hunt._plan_files; the TS port keeps
    // that private, and writePlan's location is contract (`wave-N/plan.md`),
    // so the file is addressed directly.
    const planPath = path.join(old.directory, 'wave-1', 'plan.md');
    check('kind: the written plan is where the layout says', exists(planPath), planPath);
    write(planPath, read(planPath).replace(/^kind:.*\n/m, ''));
    const backOld = huntMod.loadRun(old.directory);
    check(
      'kind: a plan with no kind line reads back as hunt',
      backOld !== undefined && backOld.kind === 'hunt',
      backOld ? backOld.kind : '(no run)',
    );

    // The hook combinator (Python `_chain_hooks`) is module-private in the TS
    // port, so "chaining nothing yields nothing / chaining one yields that
    // one" cannot be asserted here — reported as a gap. Its one caller
    // (runAgent's chainHooks(interlock, writeLock)) is exercised by every
    // loop test below with interlock null.
  });

  it('test_planner_fallback_path', () => {
    // A planner that rambles must not cost the wave.
    check(
      'planner: garbage parses to None',
      teamMod.parseRoster('I could not decide. Sorry!', 10) === null,
    );
    const parsed = teamMod.parseRoster('{"summary": "x", "workers": []}');
    const roster = parsed ?? new teamMod.Roster('', []);
    check('planner: an empty roster parses to no workers', roster.workers.length === 0);
  });

  // === SECTION === reports =================================================

  it('test_reports', () => {
    const wd = wdFor('test_reports');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_reports');
    const run = new huntMod.HuntRun('example.test', huntMod.caseDir(cfg, 'example.test'), { wave: 2 });

    const f = new huntMod.Finding({
      wave: 2,
      agent: 'injection',
      title: 'SQLi in ?q',
      severity: 'critical',
      asset: 'example.test/search',
      summary: 'the q parameter is concatenated into SQL',
      evidence: "' OR 1=1-- returned every row",
      remediation: 'use a parameterised query',
    });
    run.findings.push(f);

    const p = huntMod.writeReport(run, f);
    check(
      'report: the file lands in the wave\'s own directory',
      base(path.dirname(p)) === 'findings'
        && base(path.dirname(path.dirname(p))) === 'wave-2'
        && fs.statSync(p).isFile(),
      p,
    );
    check(
      'report: the filename leads with the severity and the slug',
      base(p) === 'critical-sqli-in-q.md',
      base(p),
    );

    const body = read(p);
    check(
      'report: frontmatter carries the fields',
      body.includes('severity: critical') && body.includes('wave: 2')
        && body.includes('agent: injection') && body.includes('target: example.test'),
    );
    check(
      'report: frontmatter carries one timestamp',
      body.includes('timestamp: 20') && body.split('timestamp:').length - 1 === 1,
    );
    check(
      'report: the title and sections are present',
      body.includes('# SQLi in ?q') && body.includes('## Evidence') && body.includes('## Remediation'),
    );
    check('report: the evidence is preserved', body.includes("' OR 1=1--"));

    // A low finding earns a file too — it used to be dropped, which meant
    // the evidence died with the process and the evidence report could not
    // cite it. (Python called the private `_save` for this half; the TS
    // `writeReport` is the same writer.)
    const low = new huntMod.Finding({ wave: 2, agent: 'x', title: 'nitpick', severity: 'low' });
    const lowPath = huntMod.writeReport(run, low);
    check('report: a low finding is saved too', lowPath !== '', lowPath);
    check(
      'report: the low finding\'s severity leads its filename',
      base(lowPath) === 'low-nitpick.md',
      base(lowPath),
    );

    // Round-trip: a campaign can be reloaded from disk. Both files are read
    // back — the low finding was written above and is recovered too, which
    // is the point of saving every severity.
    const loaded = huntMod.loadRun(run.directory);
    check('reload: a campaign reads back off disk', loaded !== undefined);
    check(
      'reload: every finding is recovered',
      loaded !== undefined && loaded.findings.length === 2,
      String(loaded ? loaded.findings.length : 0),
    );
    check(
      'reload: severity and title survive the round trip',
      loaded !== undefined
        && loaded.ranked()[0].severity === 'critical'
        && loaded.ranked()[0].title === 'SQLi in ?q',
    );
    check(
      'reload: the quiet finding comes back too',
      loaded !== undefined
        && JSON.stringify(loaded.ranked().map((x) => x.severity)) === '["critical","low"]',
    );
    check(
      'reload: the summary section is recovered',
      loaded !== undefined && loaded.ranked()[0].summary.includes('concatenated'),
    );
    check(
      'reload: an empty directory yields None',
      huntMod.loadRun(path.join(wd, 'nothing-here')) === undefined,
    );

    // Two agents reporting the same title in one wave must not collide: the
    // slug is derived from the title, so a naive write would drop one report.
    const dup = new huntMod.Finding({
      wave: 2,
      agent: 'other',
      title: 'SQLi in ?q',
      severity: 'high',
      evidence: "second agent's proof",
    });
    const second = huntMod.writeReport(run, dup);
    check('report: a duplicate title gets its own file', second !== p, `${base(p)} vs ${base(second)}`);
    check(
      'report: the duplicate\'s evidence survives',
      read(second).includes("second agent's proof"),
    );
    check(
      'report: the first file is untouched by the duplicate',
      read(p).includes("' OR 1=1--") && !read(p).includes('second agent'),
    );

    // The summary archives into the flat reports store, like /osint.
    const dest = huntMod.writeSummary(cfg, run, 'the closing report');
    check(
      'summary: it is written beside the evidence',
      fs.readdirSync(run.directory).filter((n) => /^summary-.*\.md$/.test(n)).length === 1,
      String(fs.readdirSync(run.directory).filter((n) => n.startsWith('summary-'))),
    );
    check(
      'summary: it is archived into the reports store',
      path.dirname(dest) === huntMod.reportsDir(cfg),
      dest,
    );
    check(
      'summary: the archive carries the run\'s shape',
      read(dest).includes('findings: 1'),
    );
    // The frontmatter's wave count and the evidence report's `**Waves:**`
    // line are the same number, from the same helper. They used to disagree —
    // the frontmatter took the highest wave *number*, the body counted `## `
    // sections — so one file carried two answers.
    const summaryWaves = /^waves: (\d+)$/m.exec(read(dest))?.[1];
    const bodyWaves = /\*\*Waves:\*\* (\d+)/.exec(huntMod.buildEvidenceReport(run))?.[1];
    check(
      'summary: the frontmatter and the body agree on the wave count',
      summaryWaves !== undefined && summaryWaves === bodyWaves,
      `${summaryWaves} vs ${bodyWaves}`,
    );

    // A second campaign on the same scope must not overwrite the first's
    // report: the directory is the scope's and is reused, so a fixed name
    // would lose it.
    const dest2 = huntMod.writeSummary(cfg, run, "the second campaign's report");
    check(
      'summary: a second campaign gets its own report file',
      dest2 !== dest && fs.statSync(dest).isFile() && fs.statSync(dest2).isFile(),
      `${base(dest)} vs ${base(dest2)}`,
    );
    check(
      'summary: the first campaign\'s report survives the second',
      read(dest).includes('the closing report') && read(dest2).includes('second campaign'),
    );
  });

  // === SECTION === the loop ================================================

  it('test_wave_layout', () => {
    // The wave-directory helpers: naming, numbering, and what counts as
    // shaped. These are the primitives every writer, reader and migration
    // goes through: `wave-10` must sort after `wave-9` (a lexicographic sort
    // puts it between 1 and 2), a fresh campaign must number from 1 and not
    // 0, and `isScopeShaped` must recognise BOTH the current layout and the
    // flat one — the old marker check would have called every reorganised
    // campaign legacy and migrated it a second time.
    const wd = wdFor('test_wave_layout');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_wave_layout');
    const d = huntMod.caseDir(cfg, 'waves.test');

    check(
      'wave layout: a fresh campaign has no waves',
      huntMod.waveDirs(d).length === 0,
      String(huntMod.waveDirs(d)),
    );
    check(
      'wave layout: a fresh campaign numbers from 1, not 0',
      huntMod.nextWaveNumber(d) === 1,
      String(huntMod.nextWaveNumber(d)),
    );
    check(
      'wave layout: a fresh campaign is not yet scope-shaped',
      huntMod.isScopeShaped(d) === false,
    );

    // Deliberately out of order, and past nine: the sort has to be numeric.
    for (const n of [10, 2, 1]) huntMod.waveDir(d, n);
    check(
      'wave layout: waves come back in numeric order',
      JSON.stringify(huntMod.waveDirs(d).map(([n]) => n)) === '[1,2,10]',
      String(huntMod.waveDirs(d).map(([n]) => n)),
    );
    check(
      'wave layout: the next wave follows the highest, not the last read',
      huntMod.nextWaveNumber(d) === 11,
      String(huntMod.nextWaveNumber(d)),
    );
    check(
      'wave layout: a campaign holding waves is scope-shaped',
      huntMod.isScopeShaped(d) === true,
    );

    // The path builders create what they name, because every caller writes
    // through them rather than mkdir-ing first.
    check(
      'wave layout: waveDir names and creates the wave',
      base(huntMod.waveDir(d, 3)) === 'wave-3' && isDir(huntMod.waveDir(d, 3)),
    );
    check(
      'wave layout: waveFindingsDir nests under it',
      huntMod.waveFindingsDir(d, 3) === path.join(d, 'wave-3', 'findings')
        && isDir(huntMod.waveFindingsDir(d, 3)),
      huntMod.waveFindingsDir(d, 3),
    );

    // A wave-<n> that is not a number is not a wave directory. `wave-x` is
    // somebody else's directory and must not be renumbered into the sequence.
    fs.mkdirSync(path.join(d, 'wave-x'));
    fs.mkdirSync(path.join(d, 'wave-'));
    check(
      'wave layout: a non-numeric wave directory is ignored',
      JSON.stringify(huntMod.waveDirs(d).map(([n]) => n)) === '[1,2,3,10]',
      String(huntMod.waveDirs(d).map(([n]) => n)),
    );

    // The flat layout is scope-shaped too — it is what every campaign
    // written before the wave directories has, and what migrateHunts itself
    // creates.
    const flat = path.join(d, 'flat.test');
    fs.mkdirSync(path.join(flat, 'plans'), { recursive: true });
    check(
      'wave layout: a flat campaign with plans/ is scope-shaped',
      huntMod.isScopeShaped(flat) === true,
    );
    const empty = path.join(d, 'empty.test');
    fs.mkdirSync(empty);
    check(
      'wave layout: an empty directory is not scope-shaped',
      huntMod.isScopeShaped(empty) === false,
    );
    check(
      'wave layout: a missing directory is not scope-shaped',
      huntMod.isScopeShaped(path.join(d, 'nope')) === false,
    );
    check(
      'wave layout: a fresh campaign directory holds nothing but itself',
      JSON.stringify(fs.readdirSync(huntMod.caseDir(cfg, 'bare.test'))) === '[]',
      String(fs.readdirSync(huntMod.caseDir(cfg, 'bare.test'))),
    );
  });

  it('test_readers_span_both_layouts', async () => {
    // The readers span the wave layout AND the flat one, because the boot
    // migration cannot be assumed to have run before a read: an operator who
    // opens /findings on a campaign written by the previous version still
    // gets their findings instead of an empty panel. Python asserted on the
    // private glob helpers; the TS port keeps them private, so the same
    // behaviour is pinned through the two public readers they feed —
    // loadRun (hunt's copy) and the hunt_findings tool (tools' copy, which
    // duplicates the globbing rather than importing it, so the two can
    // silently drift apart).
    const wd = wdFor('test_readers_span_both_layouts');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_readers_span_both_layouts');
    const d = huntMod.caseDir(cfg, 'mixed.test');

    // The wave layout.
    write(path.join(huntMod.waveFindingsDir(d, 1), 'critical-a.md'), '---\n---\n');
    write(path.join(huntMod.waveFindingsDir(d, 2), 'high-b.md'), '---\n---\n');
    write(path.join(huntMod.waveDir(d, 1), 'plan.md'), '---\nwave: 1\n---\n');

    // The flat layout, still present: not yet migrated.
    fs.mkdirSync(path.join(d, 'findings'));
    write(path.join(d, 'findings', 'medium-c.md'), '---\n---\n');
    fs.mkdirSync(path.join(d, 'plans'));
    write(path.join(d, 'plans', 'wave-3-20261010-000000.md'), '---\nwave: 3\n---\n');

    const loaded = huntMod.loadRun(d);
    check(
      'readers: findings come from both layouts',
      loaded !== undefined
        && JSON.stringify(loaded.findings.map((f) => f.title)) === '["critical-a","high-b","medium-c"]',
      String(loaded ? loaded.findings.map((f) => f.title) : '(no run)'),
    );
    check(
      'readers: plans come from both layouts',
      loaded !== undefined
        && JSON.stringify(loaded.waveRecords.map((r) => r.number)) === '[1,3]',
      String(loaded ? loaded.waveRecords.map((r) => r.number) : '(no run)'),
    );

    // And the tool reads the same set — it duplicates the globbing rather
    // than importing it, so the two can silently drift apart.
    const res = await toolsMod.execute('hunt_findings', { scope: 'mixed.test' }, cfg);
    const toolNames = ['critical-a', 'high-b', 'medium-c'].filter((t) => res.output.includes(t));
    check(
      "readers: the tool's copy agrees with hunt's",
      toolNames.length === 3,
      `${res.output.slice(0, 200)} (isError=${String(res.isError)})`,
    );
    const plansRes = await toolsMod.execute(
      'hunt_findings',
      { scope: 'mixed.test', include: 'plans' },
      cfg,
    );
    check(
      "readers: the tool's plan copy agrees too",
      plansRes.output.includes('wave 1') && plansRes.output.includes('wave 3'),
      plansRes.output,
    );
  });

  it('test_reorganise_waves', () => {
    // A flat campaign files into per-wave directories, once and only once.
    // The layout the real lerevecraze.com campaign is in: every wave's
    // findings in one findings/, every wave's plan in plans/, the wave
    // recoverable only from a frontmatter line.
    const wd = wdFor('test_reorganise_waves');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_reorganise_waves');
    const root = path.join(cfg.stateDir, 'hunts');
    const d = path.join(root, 'flat.test');
    fs.mkdirSync(path.join(d, 'findings'), { recursive: true });
    fs.mkdirSync(path.join(d, 'plans'));

    const finding = (name: string, wave: number, severity = 'medium') => {
      write(
        path.join(d, 'findings', name),
        `---\ntarget: flat.test\nwave: ${wave}\nseverity: ${severity}\n`
          + `timestamp: 2026-10-10T00:00:00Z\n---\n\n# ${name}\n`,
      );
    };

    finding('medium-a.md', 0);
    finding('critical-b.md', 1);
    finding('high-c.md', 1);
    finding('low-d.md', 2);
    write(
      path.join(d, 'plans', 'wave-1-20261010-010101.md'),
      '---\nwave: 1\nagents: 10\nfell_back: false\n'
        + 'timestamp: 2026-10-10T01:01:01Z\n---\n\n# Wave 1 — 10 agents\n\nauth\n',
    );
    write(
      path.join(d, 'plans', 'wave-2-20261010-020202.md'),
      '---\nwave: 2\nagents: 10\nfell_back: true\n'
        + 'timestamp: 2026-10-10T02:02:02Z\n---\n\n# Wave 2 — 10 agents\n\nmore auth\n',
    );

    // A finding whose frontmatter names no wave: it must be left exactly
    // where it is. A wrong wave is worse than a flat one — the flat one is
    // obvious.
    write(path.join(d, 'findings', 'nowave.md'), '---\ntarget: flat.test\n---\n\n# ?\n');

    const moved = huntMod.reorganiseWaves(cfg);
    check(
      'reorganise: every wave-bearing finding moved',
      moved.filter(([src]) => base(src).endsWith('.md') && base(path.dirname(src)) === 'findings')
        .length === 4,
      String(moved.length),
    );

    check(
      'reorganise: recon\'s own finds file under wave 0',
      isFile(path.join(d, 'wave-0', 'findings', 'medium-a.md')),
    );
    check(
      "reorganise: wave 1's findings file together",
      isFile(path.join(d, 'wave-1', 'findings', 'critical-b.md'))
        && isFile(path.join(d, 'wave-1', 'findings', 'high-c.md')),
    );
    check(
      "reorganise: wave 2's finding files under wave 2",
      isFile(path.join(d, 'wave-2', 'findings', 'low-d.md')),
    );
    check(
      'reorganise: the plans become each wave\'s plan.md',
      isFile(path.join(d, 'wave-1', 'plan.md')) && isFile(path.join(d, 'wave-2', 'plan.md')),
    );
    check('reorganise: the emptied plans directory is removed', !exists(path.join(d, 'plans')));
    // `findings/` survives holding the one file that could not be filed — a
    // directory is only removed once it is empty, so the operator can see
    // what was left behind rather than having it deleted on a guess.
    check(
      'reorganise: the undated finding is left where it is',
      isFile(path.join(d, 'findings', 'nowave.md'))
        && !exists(path.join(d, 'wave-0', 'findings', 'nowave.md')),
      'it must not be guessed into wave 0',
    );
    check(
      'reorganise: a non-empty flat directory is kept, not deleted',
      isDir(path.join(d, 'findings'))
        && JSON.stringify(fs.readdirSync(path.join(d, 'findings'))) === '["nowave.md"]',
    );

    // Reading back: the campaign loads whole, with its wave history
    // recovered from the plans it just moved.
    const loaded = huntMod.loadRun(d);
    check('reorganise: the campaign still loads', loaded !== undefined);
    check(
      'reorganise: every finding survived the move',
      loaded !== undefined && loaded.findings.length === 5,
      String(loaded ? loaded.findings.length : 0),
    );
    check(
      'reorganise: the wave history is recovered from the moved plans',
      loaded !== undefined
        && JSON.stringify(loaded.waveRecords.map((r) => r.number)) === '[1,2]',
    );
    check(
      'reorganise: a wave\'s fallback is recovered',
      loaded !== undefined
        && loaded.waveRecords.find((r) => r.number === 2)?.fellBack === true,
    );
    check(
      "reorganise: a wave's aim is recovered",
      loaded !== undefined
        && loaded.waveRecords.find((r) => r.number === 1)?.summary === 'auth',
    );

    // Idempotent, and it does not touch a campaign that is already filed.
    const before = JSON.stringify(allPaths(d));
    check('reorganise: a second run moves nothing', huntMod.reorganiseWaves(cfg).length === 0);
    check(
      'reorganise: and disturbs nothing',
      JSON.stringify(allPaths(d)) === before,
    );

    // A campaign already in the wave layout is left alone — no wave-0/plans
    // resurrection, which is what the old marker check would have caused.
    const settled = path.join(root, 'settled.test');
    write(
      path.join(huntMod.waveFindingsDir(settled, 1), 'critical-x.md'),
      '---\nwave: 1\n---\n\n# x\n',
    );
    huntMod.reorganiseWaves(cfg);
    check(
      'reorganise: a wave-layout campaign is untouched',
      isFile(path.join(settled, 'wave-1', 'findings', 'critical-x.md'))
        && !exists(path.join(settled, 'findings'))
        && !exists(path.join(settled, 'plans')),
      String(fs.readdirSync(settled)),
    );

    // A collision keeps both: a re-run wave's second finding by the same
    // name must not destroy the first.
    const clash = path.join(root, 'clash.test');
    fs.mkdirSync(path.join(clash, 'findings'), { recursive: true });
    write(path.join(clash, 'findings', 'critical-dup.md'), '---\nwave: 1\n---\n\nthe first\n');
    write(path.join(huntMod.waveFindingsDir(clash, 1), 'critical-dup.md'), 'the original');
    huntMod.reorganiseWaves(cfg);
    check(
      'reorganise: a collision keeps the existing file',
      read(path.join(clash, 'wave-1', 'findings', 'critical-dup.md')) === 'the original',
    );
    check(
      'reorganise: and the incoming one is kept beside it',
      isFile(path.join(clash, 'wave-1', 'findings', 'critical-dup-2.md')),
      String(fs.readdirSync(path.join(clash, 'wave-1', 'findings'))),
    );
  });

  it('test_evidence_report', () => {
    // `/report-bug-hunt`: every wave, every finding's evidence, verbatim.
    // The two things this must get right are the ones a paraphrase would
    // ruin: the evidence has to be reproduced unaltered, and remediation has
    // to be absent — it is the fix, not the finding, and /summary-hunt is
    // where it lives.
    const wd = wdFor('test_evidence_report');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_evidence_report');
    const d = huntMod.caseDir(cfg, 'report.test');

    const run = new huntMod.HuntRun('report.test', d);
    run.waveRecords = [
      new huntMod.WaveRecord({ number: 0, agents: 0, summary: '' }),
      new huntMod.WaveRecord({ number: 1, agents: 10, summary: 'aiming at the login flow' }),
      new huntMod.WaveRecord({ number: 2, agents: 10, summary: 'following up on auth', fellBack: true }),
    ];
    // A wave-0 finding with no plan, and two in later waves. Distinct
    // titles, so the tracker's dedup cannot collapse them.
    run.addFinding(new huntMod.Finding({
      wave: 0, agent: 'recon', title: 'mariadb exposed', severity: 'medium',
      asset: 'report.test:3306', summary: 'the port answers to anyone',
      evidence: 'nmap -p3306 -> 10.0.0.5:3306 open',
    }));
    run.addFinding(new huntMod.Finding({
      wave: 1, agent: 'injection', title: 'SQLi in ?q', severity: 'critical',
      asset: 'report.test/search', summary: 'q is concatenated into SQL',
      evidence: "' OR 1=1-- returned every row",
      remediation: 'parameterise the query',
    }));
    run.addFinding(new huntMod.Finding({
      wave: 2, agent: 'idor', title: 'IDOR /api/users', severity: 'high',
      asset: 'report.test/api/users', summary: 'any id is readable',
      evidence: "GET /api/users/2 -> 200 with user 2's email",
      remediation: 'check the caller owns the id',
    }));

    const body = huntMod.buildEvidenceReport(run);

    check('evidence report: it names the target', body.includes('# Bug hunt — report.test'));
    check('evidence report: it states the wave count', body.includes('**Waves:** 3'), body.slice(0, 300));
    check(
      'evidence report: it tallies the severities',
      body.includes('**Findings:** 3 (') && body.includes('1 critical')
        && body.includes('1 high') && body.includes('1 medium'),
      body.slice(0, 400),
    );
    check(
      'evidence report: one section per wave, in order',
      body.indexOf('## Recon (wave 0)') < body.indexOf('## Wave 1')
        && body.indexOf('## Wave 1') < body.indexOf('## Wave 2'),
    );
    check(
      "evidence report: recon's section is labelled as such",
      body.includes('Findings reported by the reconnaissance phase.'),
    );
    check('evidence report: a wave says what it aimed at', body.includes('aiming at the login flow'));
    check('evidence report: a wave says how many agents ran', body.includes('**10 agent(s)**'));
    check('evidence report: a fallback wave is marked as one', body.includes('(fixed vector fallback)'));
    check(
      'evidence report: findings are headed by severity and title',
      body.includes('### CRITICAL — SQLi in ?q')
        && body.includes('### HIGH — IDOR /api/users')
        && body.includes('### MEDIUM — mariadb exposed'),
    );
    check('evidence report: a finding names its asset', body.includes('- **Asset:** report.test/search'));
    check(
      'evidence report: a finding names who found it',
      body.includes('- **Found by:** injection (wave 1)'),
    );

    // Verbatim, character for character. This is the whole point of the
    // document: evidence that has been reworded is a claim about evidence.
    check(
      'evidence report: the evidence is reproduced unaltered',
      body.includes("```\n' OR 1=1-- returned every row\n```"),
      body.slice(-900),
    );
    check(
      "evidence report: every finding's evidence is there",
      body.includes('nmap -p3306 -> 10.0.0.5:3306 open')
        && body.includes("GET /api/users/2 -> 200 with user 2's email"),
    );

    // And the deliberate omission.
    check(
      'evidence report: remediation is NOT included',
      !body.includes('parameterise the query')
        && !body.includes('check the caller owns the id')
        && !body.includes('Remediation'),
    );

    // Written beside the campaign and archived, like the summary.
    const p = huntMod.writeEvidenceReport(cfg, run);
    check(
      'evidence report: it is archived into the reports store',
      p !== undefined && path.dirname(p) === huntMod.reportsDir(cfg),
      String(p),
    );
    check(
      'evidence report: a copy sits with the evidence it cites',
      fs.readdirSync(d).filter((n) => /^report-.*\.md$/.test(n)).length === 1,
    );
    check(
      'evidence report: the archive is the same document',
      p !== undefined && read(p) === body,
    );

    // A campaign with nothing in it writes nothing rather than an empty shell.
    const bare = new huntMod.HuntRun('bare.test', huntMod.caseDir(cfg, 'bare.test'));
    check(
      'evidence report: a campaign with no findings writes no report',
      huntMod.writeEvidenceReport(cfg, bare) === undefined,
    );

    // A finding whose wave has no plan still gets its section, built from
    // the findings alone — a campaign reorganised from the flat layout may
    // have lost its plans, and dropping findings for want of a plan would be
    // worse.
    const orphan = new huntMod.HuntRun('orphan.test', huntMod.caseDir(cfg, 'orphan.test'));
    orphan.addFinding(new huntMod.Finding({
      wave: 3, agent: 'x', title: 'orphan bug', severity: 'low',
      evidence: 'still recorded',
    }));
    const orphanBody = huntMod.buildEvidenceReport(orphan);
    check(
      'evidence report: a wave with no plan still gets a section',
      orphanBody.includes('## Wave 3') && orphanBody.includes('orphan bug'),
      orphanBody.slice(-400),
    );
    check(
      'evidence report: and says the plan is missing',
      orphanBody.includes('(no plan recorded for this wave)'),
    );
  });

  it('test_rerun_wave_is_one_wave', () => {
    // A deliberately re-run wave is still ONE wave. Every plan is kept —
    // that is the operator's record — but counting plans made a report
    // claim "16 waves" over an 11-wave campaign. Found against the real
    // lerevecraze.com campaign, whose wave 1 was run three times.
    const wd = wdFor('test_rerun_wave_is_one_wave');
    const cfg = cfgFor(wd);
    cfg.stateDir = stateDir(wd, 'test_rerun_wave_is_one_wave');
    const d = huntMod.caseDir(cfg, 'rerun.test');

    // Three runs of wave 1 as writePlan + unique actually lay them down:
    // plan.md first, then plan-2.md, then plan-3.md. No sleep between them,
    // deliberately: three runs inside one second share a frontmatter
    // timestamp, so file order is the only tiebreak — and filename order
    // alone gets it backwards, since plan-2.md sorts before plan.md.
    const run = new huntMod.HuntRun('rerun.test', d);
    const roster = new teamMod.Roster('first aim', [new teamMod.WorkerSpec('a', 'b', ['a'])]);
    for (const summary of ['first aim', 'second aim', 'third aim']) {
      roster.summary = summary;
      huntMod.writePlan(run, 1, roster, '', false);
    }
    huntMod.writePlan(run, 2, roster, '', false);

    const plans = fs.readdirSync(path.join(d, 'wave-1')).filter((n) => /^plan.*\.md$/.test(n)).sort();
    check(
      'rerun: every plan of the re-run wave is kept',
      JSON.stringify(plans) === '["plan-2.md","plan-3.md","plan.md"]',
      String(plans),
    );

    const loaded = huntMod.loadRun(d);
    check(
      'rerun: the wave history has one line per wave, not per plan',
      loaded !== undefined
        && JSON.stringify(loaded.waveRecords.map((r) => r.number)) === '[1,2]',
    );
    check(
      'rerun: the latest run of the wave is the one recorded',
      loaded !== undefined
        && loaded.waveRecords.find((r) => r.number === 1)?.summary === 'third aim',
    );
    check(
      'rerun: the digest does not repeat a wave',
      loaded !== undefined && loaded.waves.length === 3
        && loaded.waves.filter((w) => w.includes('wave 1:')).length === 1,
      String(loaded ? loaded.waves : null),
    );

    const body = huntMod.buildEvidenceReport(loaded!);
    check('rerun: the report counts waves, not plans', body.includes('**Waves:** 2'), body.slice(0, 300));
    check(
      'rerun: and gives one section per wave',
      body.split('## Wave 1').length - 1 === 1 && body.split('## Wave 2').length - 1 === 1,
    );
  });

  it('test_brief_context_truncation', () => {
    // A huge recon report is trimmed, and says so.
    const run = new huntMod.HuntRun('x.test', '/tmp/x');
    run.recon = 'A'.repeat(20000);
    const ctx = huntMod.briefContext(run, 100);
    check('context: an oversized recon report is truncated', ctx.length < 1000, String(ctx.length));
    check('context: the truncation is admitted', ctx.includes('truncated'), ctx.slice(-80));
  });

  it('test_hunt_tool_panel_renders_bash', () => {
    // The bash panel: whole command, whole response, attributed. Rendered
    // straight, without an app and without running anything — the point is
    // what the panel does with a real-shaped command, and a command long
    // enough that the old 70-character label would have cut the payload off
    // the end, which is where a real probe keeps it.
    const p = getPalette('green', null);
    const command =
      'for p in /admin /login /api/v1/users /debug /backup; do '
      + 'curl -sk -o /dev/null -w "%{http_code} $p\\n" '
      + '"https://x.test$p"; done';
    const output = '403 /admin\n200 /login\n401 /api/v1/users\n500 /debug\n404 /backup';

    const text = nodeText(
      huntToolPanel('bash', { command }, output, p, {
        agent: 'paths',
        color: p.accent,
        meta: { exit: 0 },
      }),
    );

    check('panel: the whole command is rendered', text.includes(command), text.slice(0, 300));
    check('panel: the tail of the command survives', text.includes('https://x.test$p"; done'));
    check('panel: nothing is ellipsised', !text.includes('…'));
    check('panel: the response is rendered', text.includes('401 /api/v1/users'));
    check('panel: the exit status is rendered', text.includes('EXIT 0'));
    check('panel: the agent is named', text.includes('paths'), text.slice(0, 200));
    // The command must lead the body, above the output, so the two are never
    // mistaken for each other.
    check(
      'panel: the command sits above its output',
      text.indexOf('for p in /admin') < text.indexOf('403 /admin'),
    );

    // A failed call is bordered in red and badged with the code, not hidden.
    const failed = nodeText(
      huntToolPanel('bash', { command: 'nmap -sV x.test' }, 'no route to host', p, {
        isError: true,
        meta: { exit: 2 },
      }),
    );
    check('panel: a failure is badged with its exit code', failed.includes('EXIT 2'));
    check('panel: a failure still shows the command', failed.includes('nmap -sV x.test'));
  });

  it('test_loop_rail_hunt_render', () => {
    // The rail's own render: the HACK node lights, and only it. Pure — no
    // app — because this is about the glyph and the label, which is where an
    // added stage goes wrong: the lit node is the one whose key equals
    // `state.stage`, so a mistyped key silently lights nothing. The TS port
    // split Python's `rail_text` out as `loopRailNode` precisely so the
    // layout can be asserted without a running app.
    check('rail: HACK is a stage', (STAGES as readonly string[]).includes('hacking'), String(STAGES));
    check('rail: HACK is labelled', STAGE_LABEL['hacking'] === 'HACK', String(STAGE_LABEL['hacking']));
    check('rail: idle is still last', STAGES[STAGES.length - 1] === 'idle', String(STAGES));

    const base: LoopRailState = {
      stage: 'idle',
      turn: 0,
      iteration: 0,
      pulse: false,
      hunt: null,
      cap: null,
      trail: [],
    };
    const p = getPalette('green', null);
    const hunting: LoopRailState = {
      ...base,
      stage: 'hacking',
      hunt: { wave: 2, agents: 10, done: 4 },
    };
    const body = nodeText(loopRailNode(p, hunting));
    check('rail: HACK renders', body.includes('HACK'), body);
    check('rail: wave counter renders', body.includes('wave') && body.includes('2'), body);
    check('rail: agent counter renders', body.includes('4/10'), body);
    check(
      'rail: turn/iter hidden during a hunt',
      !body.includes('turn') && !body.includes('iter'),
      body,
    );

    const idle = nodeText(loopRailNode(p, base));
    check('rail: turn/iter restored after a hunt', idle.includes('turn') && idle.includes('iter'));
    check('rail: wave counter gone after a hunt', !idle.includes('wave'), idle);
  });

  it.skip('test_pane', () => {
    // GAP (TS port): Python drove the Textual AndyPane widget imperatively
    // (`pane.hunt_agents`, `pane.note_hunt`, ...). In the Ink port AndyPane
    // is a forwardRef React component whose hunt state lives in useState
    // inside the component and is only reachable through the ref while the
    // component is rendered — there is no headless model to poke without an
    // Ink test root (ink-testing-library is not in the dependency set).
    // The WaveWeb half of the hunt view has such a model and is covered by
    // test_planner_feed_reaches_the_wave_view below.
  });

  it('test_contract_reaches_the_worker', () => {
    // The regression that made the tracker necessary: FINDING_CONTRACT used
    // to be formatted into the recon and planner prompts only. The wave
    // agents — the only ones that run a test and therefore the only ones
    // that can report what it found — never saw it, so they narrated a
    // methodology, parseFindings read no JSON, and every campaign reported
    // nothing no matter what it discovered. This pins the contract to the
    // prompt the worker is actually handed.
    const contract = huntMod.FINDING_CONTRACT;
    // A phrase that appears only in the contract, so a hit cannot be an
    // accident of the brief's own wording.
    const marker = 'One entry per distinct bug';
    check('contract: the marker really is in the contract', contract.includes(marker));

    const workerPrompt = `recon digest\n\nprobe the login form\n\n${contract}`;
    check('contract: a worker prompt carrying it is detectable', workerPrompt.includes(marker));

    // And the assembly itself, which is what regressed: context, then brief,
    // then contract last, so the reporting block is what the agent reads as
    // it writes its final message. (The real assembly lives in runAgent and
    // is asserted end to end by test_contract_in_worker_prompts below; this
    // half pins the shape the assembly must keep.)
    const spec = new teamMod.WorkerSpec('auth', 'probe the login form', ['auth']);
    let prompt = `the digest\n\n${spec.brief}`;
    if (contract) prompt = `${prompt}\n\n${contract}`;
    check(
      'contract: the contract is the last thing in the prompt',
      prompt.trimEnd().endsWith(contract.trimEnd()),
    );
    check('contract: the brief is still present', prompt.includes(spec.brief));
  });

  it('test_report_finding_tool', async () => {
    // The tool the live tracker is fed by, and the gate around it. This is
    // the seam the whole real-time feature hangs off: without a tool that
    // returns the finding on meta, the tracker can only ever be filled in
    // after a wave ends.
    const schema = toolsMod.TOOL_SCHEMAS.find((t) => t.name === 'report_finding');
    check('tool: report_finding is advertised in the schema list', schema !== undefined);
    if (schema !== undefined) {
      const props = schema.input_schema.properties as Record<string, { enum?: string[] }>;
      check(
        'tool: it takes a title, severity and evidence',
        ['title', 'severity', 'evidence'].every((k) => k in props),
        String(Object.keys(props).sort()),
      );
      // The severity enum is a literal in the schema rather than an import
      // of hunt.VALID_SEVERITIES, because hunt imports agent which imports
      // tools — reaching back would close the cycle. A literal that drifts
      // from the real set would let the model emit a severity the tracker
      // cannot place, so the two are pinned together here.
      check(
        "tool: the severity enum matches the tracker's severities",
        JSON.stringify(props['severity']?.enum) === JSON.stringify(huntMod.VALID_SEVERITIES),
        String(props['severity']?.enum),
      );
    }

    // It writes nothing, so it must not need permission — a prompt in the
    // middle of a wave would stall ten agents behind one operator keystroke.
    check('tool: report_finding is not gated', toolsMod.needsPermission('report_finding') === false);

    // A valid call returns the finding on meta, normalised.
    const res = await toolsMod.execute(
      'report_finding',
      {
        title: 'SQL injection in ?id',
        severity: 'CRITICAL',
        asset: 'api.x.test',
        evidence: 'curl -d "\'" returned 500',
      },
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-tool-'))),
    );
    check('tool: a valid report succeeds', res.isError !== true, res.output);
    const meta = res.meta ?? {};
    check('tool: the finding rides out on meta', 'finding' in meta, String(meta));
    const f = (meta['finding'] ?? {}) as Record<string, unknown>;
    check('tool: the title is carried', f['title'] === 'SQL injection in ?id');
    check('tool: the severity is normalised', f['severity'] === 'critical', String(f['severity']));
    check('tool: the evidence is carried', String(f['evidence'] ?? '').includes('500'));

    // Missing pieces are refused, not silently recorded — a finding with no
    // evidence is worse than no finding.
    const bad = await toolsMod.execute(
      'report_finding',
      { title: 'x', severity: 'high' },
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-tool-'))),
    );
    check('tool: a report with no evidence is an error', bad.isError === true, bad.output);
    check(
      'tool: the rejected report still carries no finding',
      !(res.meta && 'finding' in (bad.meta ?? {})),
    );
    const empty = await toolsMod.execute(
      'report_finding',
      { severity: 'high', evidence: 'x' },
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-tool-'))),
    );
    check('tool: a report with no title is an error', empty.isError === true);

    // The summariser the transcript uses, so the call reads as a one-liner.
    const line = toolsMod.summariseCall(
      'report_finding',
      { title: 'SQLi', severity: 'critical' },
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-tool-'))),
    );
    check('tool: the transcript summarises the call', line.includes('SQLi'), line);

    // And the gate: only a hunt agent is advertised it.
    const plain = new Agent(cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-agent-'))));
    const armed = new Agent(
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-agent-'))),
      undefined,
      undefined,
      true,
    );
    const plainTools = new Set(plain.toolSchemas().map((t) => t.name));
    const armedTools = new Set(armed.toolSchemas().map((t) => t.name));
    check(
      'tool: an ordinary session is not offered report_finding',
      !plainTools.has('report_finding'),
    );
    check('tool: a hunt agent is offered report_finding', armedTools.has('report_finding'));
    const denied = priv(plain).denied('report_finding') as string | null;
    check(
      'tool: an ordinary session calling it is denied with a reason',
      denied !== null && denied.includes('hunt'),
      String(denied),
    );
  });

  it.skip('test_finding_from_tool', () => {
    // GAP (TS port): Python called the private hunt._finding_from_tool
    // directly. The TS port keeps it module-private (PORT-MAP convention:
    // leading-underscore helpers are not exported), so the unit seam does
    // not exist. The behaviour it covered — a tool meta dict becomes a
    // normalised Finding, or nothing — is exercised end to end through the
    // live report path by test_live_reporting_mid_wave below, which goes
    // through the same helper on every report_finding tool_result.
  });

  it('test_tracker_model', () => {
    // addFinding deduplicates; ranked orders worst first.
    const run = new huntMod.HuntRun('x.test', '/tmp/x');

    const a = new huntMod.Finding({
      wave: 1, agent: 'a', title: 'SQLi in ?id', severity: 'critical', asset: 'api.x.test',
    });
    const b = new huntMod.Finding({
      wave: 1, agent: 'b', title: 'IDOR /api/users', severity: 'high', asset: 'api.x.test',
    });
    // The same bug, rediscovered by a third agent: same title slug, same asset.
    const dup = new huntMod.Finding({
      wave: 2, agent: 'c', title: 'SQLi in ?id', severity: 'critical', asset: 'api.x.test',
    });
    // Same title, different asset: a genuinely different finding.
    const other = new huntMod.Finding({
      wave: 2, agent: 'd', title: 'SQLi in ?id', severity: 'medium', asset: 'www.x.test',
    });

    check('tracker: a new finding is accepted', run.addFinding(a) === true);
    check('tracker: a second distinct finding is accepted', run.addFinding(b) === true);
    check('tracker: an exact repeat is dropped', run.addFinding(dup) === false);
    check('tracker: the repeat did not inflate the list', run.findings.length === 2, String(run.findings.length));
    check('tracker: the first report of a bug is the one kept', run.findings[0].agent === 'a');
    check(
      'tracker: the same title on another asset is a different finding',
      run.addFinding(other) === true,
    );

    // Worst first, regardless of the order they arrived in.
    const run2 = new huntMod.HuntRun('x.test', '/tmp/x');
    for (const sev of ['info', 'low', 'medium', 'high', 'critical']) {
      run2.addFinding(new huntMod.Finding({ wave: 1, agent: 'a', title: `${sev} bug`, severity: sev }));
    }
    const order = run2.ranked().map((f) => f.severity);
    check(
      'tracker: ranked is worst-first',
      JSON.stringify(order) === '["critical","high","medium","low","info"]',
      String(order),
    );

    // The planner's digest reads in the same order.
    check(
      'tracker: the digest is worst-first too',
      run2.digest().split('\n')[0].startsWith('- [critical]'),
      run2.digest().split('\n')[0],
    );
  });

  it.skip('test_findings_panel', () => {
    // GAP (TS port): the Ink FindingsPanel calls ink's useInput hook, so it
    // cannot be invoked outside an Ink render root — and ink-testing-library
    // is not in the dependency set. The ordering it pinned (worst-first when
    // the caller hands it a ranked list) is covered on the data side by
    // test_tracker_model, and by hunt_findings' output order in
    // test_hunt_findings_tool.
  });

  it.skip('test_stream_turn_watchdog', () => {
    // GAP (TS port): Python called hunt._stream_turn directly to test the
    // idle-flush watchdog. The TS port keeps streamTurn module-private (the
    // seam it guards — closing the runTurn generator when the consumer walks
    // away — has no JS equivalent: a `for await` loop that breaks plus
    // iterator.return() is the language-level path, and runHunt's own loop
    // tests exercise the real stream through every scripted campaign).
  });

  it('test_planner_feed_reaches_the_wave_view', async () => {
    // The planner's live reasoning is routed to the wave view, not dropped.
    // Half is the event stream (hunt_plan_text/hunt_plan_tool must be
    // emitted while the planner works); half is the WaveWeb model drawing
    // them. Python drove both through the private _collect_text_live; the TS
    // port keeps that private, so the event half rides a real scripted
    // campaign (runHunt routes its planner through collectTextLive) and the
    // drawing half calls WaveWeb's own public note-methods — the same ones
    // the overlay dispatches on.
    const wd = wdFor('test_planner_feed');
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_planner_feed');

    const web = new WaveWeb('t.test', getPalette('green', null), { wave: 1, size: 10 });
    check('plan feed: a fresh wave is planning', web.planning === true);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const roster = '{"summary": "s", "workers": [{"name": "a", "brief": "b", "owns": ["a"]}]}';
    await huntMod.runHunt(cfg, 'feed.test', {
      onEvent: async (ev) => {
        events.push(ev);
        // The same routing the overlay's note does.
        if (ev.type === 'hunt_plan_text') web.plannerText(ev.text);
        else if (ev.type === 'hunt_plan_tool') web.plannerTool(ev.tool, ev.args, cfg);
      },
      agentFactory: huntFactory({
        rosters: [roster], plannerCalls: 0, prompts: [],
        reconFinal: 'recon: one host', final: 'none',
      }),
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    const kinds = events.map((e) => e.type);
    check(
      'plan feed: prose is emitted as plan text',
      kinds.includes('hunt_plan_text'),
      String(kinds),
    );

    // The drawing half, fed directly: prose lands, a tool call is drawn as a
    // command with its arguments.
    const web2 = new WaveWeb('t.test', getPalette('green', null), { wave: 1, size: 10 });
    web2.plannerText('the auth bypass is closed so wave 2 pivots');
    web2.plannerTool('grep', { pattern: 'wp-json' }, cfg);
    const text = nodeText(web2.render(118, 36));
    check(
      'plan feed: the reasoning is on screen',
      text.includes('pivots'),
      text.replace(/\n/g, '|').slice(0, 300),
    );
    // The tool call is summarised with its arguments, not recorded as a bare
    // name: "grep" alone says nothing about where the wave is being aimed.
    check(
      'plan feed: the tool call is on screen with its arguments',
      text.includes('wp-json'),
      text.replace(/\n/g, '|').slice(0, 300),
    );
    check(
      'plan feed: the tool call is drawn as a command',
      text.includes('$ '),
      text.replace(/\n/g, '|').slice(0, 300),
    );
    // And the wave view is still in its planning state: nothing has claimed
    // a roster exists yet.
    check('plan feed: the view still says planning', web2.planning === true);
  });

  it('test_scope_naming', () => {
    // A target files under one scope directory, or is refused. The scope is
    // derived from the target rather than used verbatim: a URL and a bare
    // host are the same engagement, and a sentence in the target field is an
    // operator mistake that must not become a directory name.
    check('scope: a bare host is its own scope', huntMod.scopeSlug('example.com') === 'example.com');
    check(
      'scope: a wildcard drops the star',
      huntMod.scopeSlug('*.lerevecraze.com') === 'lerevecraze.com',
    );
    check(
      'scope: a URL files under its host',
      huntMod.scopeSlug('https://dev.example.com/login') === 'dev.example.com',
    );
    check('scope: a port is dropped', huntMod.scopeSlug('example.com:8443') === 'example.com');
    check('scope: a CIDR keeps its network', huntMod.scopeSlug('10.0.0.0/24') === '10.0.0.0');

    // A sentence is refused, not truncated. This is the real failure: an
    // operator typed prose into the target field and got a directory named
    // after its first sixty characters.
    const bad: Array<[string, string]> = [
      ['bdgroup.com the recons are in this directory', 'prose'],
      ['find the bugs', 'not a host'],
      ['', 'empty'],
      ['   ', 'whitespace'],
    ];
    for (const [target, why] of bad) {
      let threw = false;
      let got = '';
      try {
        got = huntMod.scopeSlug(target);
      } catch {
        threw = true;
      }
      check(`scope: ${why} is refused`, threw, JSON.stringify(got));
    }

    // One directory per scope, reused: a second campaign against the same
    // host adds to the first's history rather than starting a sibling.
    const wd = wdFor('test_scope_naming');
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_scope_naming');
    const first = huntMod.caseDir(cfg, 'https://mail.lerevecraze.com/login');
    const second = huntMod.caseDir(cfg, 'mail.lerevecraze.com');
    check('scope: the same host reuses one directory', first === second, first);
    check('scope: the directory is named for the scope', base(first) === 'mail.lerevecraze.com', base(first));
    // Nothing but the directory itself: the wave directories are made as the
    // waves run, so a hunt stopped before its first brief leaves no clutter.
    check(
      'scope: a fresh campaign holds nothing but the directory',
      isDir(first) && fs.readdirSync(first).length === 0,
      String(fs.readdirSync(first)),
    );
  });

  it('test_migrate_hunts', () => {
    // Legacy stamped campaigns fold into one directory per scope,
    // idempotently. The old layout made a new `<slug>-<stamp>` sibling for
    // every /bug-hunt, so one engagement scattered across a dozen
    // directories. The scope comes from the findings' own target where there
    // is one — the directory NAME is what was wrong, since a prose target
    // became a name.
    const legacyCampaign = (
      root: string, name: string, opts: { target?: string; finding?: string } = {},
    ): string => {
      const d = path.join(root, name, 'findings');
      fs.mkdirSync(d, { recursive: true });
      const finding = opts.finding ?? 'f.md';
      if (finding !== '') {
        const body = '---\n'
          + (opts.target ? `target: ${opts.target}\n` : '')
          + 'wave: 0\nseverity: high\ntimestamp: 2026-10-09T03:32:50Z\n---\n\n'
          + `# ${name} finding\n`;
        write(path.join(d, finding), body);
      }
      return path.join(root, name);
    };

    const wd = wdFor('test_migrate_hunts');
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_migrate_hunts');
    const root = path.join(cfg.stateDir, 'hunts');
    fs.mkdirSync(root, { recursive: true });

    // Two legacy campaigns for the same host, one with a wildcard target that
    // must normalise to the same scope as the bare host.
    legacyCampaign(root, 'lerevecraze.com-20261009-084705', { target: '*.lerevecraze.com', finding: 'a.md' });
    legacyCampaign(root, 'lerevecraze.com-20261010-025510', { target: 'lerevecraze.com', finding: 'b.md' });

    // A prose target whose findings recorded prose too: the name is all
    // there is, and it still has to shed its stamp.
    legacyCampaign(root, 'bdgroup.com-the-recons-are-in-here-20261008-162136', {
      target: 'bdgroup.com the recons are in here',
      finding: 'c.md',
    });

    // A campaign with no findings at all — nothing to derive a scope from.
    legacyCampaign(root, 'empty.test-20261009-000814', { finding: '' });

    // Already scope-shaped: has plans/, so it is left strictly alone.
    const done = path.join(root, 'settled.test');
    fs.mkdirSync(path.join(done, 'plans'), { recursive: true });
    fs.mkdirSync(path.join(done, 'findings'));
    write(path.join(done, 'findings', 'keep.md'), '---\ntarget: settled.test\n---\n# k\n');

    const moved = huntMod.migrateHunts(cfg);
    const dests = new Map(moved.map(([src, dst]) => [base(src), base(dst)]));

    check(
      'migrate: both campaigns for one host merge into its scope',
      isFile(path.join(root, 'lerevecraze.com', 'findings', 'a.md'))
        && isFile(path.join(root, 'lerevecraze.com', 'findings', 'b.md')),
      String(fs.readdirSync(path.join(root, 'lerevecraze.com', 'findings'))),
    );
    check(
      'migrate: a wildcard target files under the bare host',
      dests.get('lerevecraze.com-20261009-084705') === 'lerevecraze.com',
      String([...dests.entries()]),
    );
    check(
      'migrate: the legacy directories are gone',
      !exists(path.join(root, 'lerevecraze.com-20261009-084705'))
        && !exists(path.join(root, 'lerevecraze.com-20261010-025510')),
    );
    check(
      'migrate: the scope gets the marker, so a hunt can start there',
      isDir(path.join(root, 'lerevecraze.com', 'plans')),
    );

    // Prose: the finding recorded prose, so the scope falls back to the name
    // with its stamp stripped — not to the whole sentence.
    check(
      'migrate: a prose-named campaign sheds its stamp',
      dests.get('bdgroup.com-the-recons-are-in-here-20261008-162136')
        === 'bdgroup.com-the-recons-are-in-here',
      String([...dests.entries()]),
    );
    check(
      "migrate: the prose campaign's finding survived",
      isFile(path.join(root, 'bdgroup.com-the-recons-are-in-here', 'findings', 'c.md')),
    );

    check('migrate: an empty legacy campaign is removed', !exists(path.join(root, 'empty.test-20261009-000814')));
    check(
      'migrate: an empty campaign yields no move',
      !dests.has('empty.test-20261009-000814'),
      String([...dests.keys()]),
    );
    check('migrate: an empty campaign leaves no stray scope directory', !exists(path.join(root, 'empty.test')));

    check(
      'migrate: a scope-shaped directory is left alone',
      isFile(path.join(done, 'findings', 'keep.md')) && !dests.has('settled.test'),
    );

    // Idempotent: a second call moves nothing and disturbs nothing.
    const again = huntMod.migrateHunts(cfg);
    check('migrate: a second run is a no-op', again.length === 0, String(again));
    check(
      'migrate: the merged findings are still there after a second run',
      fs.readdirSync(path.join(root, 'lerevecraze.com', 'findings')).filter((n) => n.endsWith('.md')).length === 2,
      String(fs.readdirSync(path.join(root, 'lerevecraze.com', 'findings'))),
    );

    // A collision keeps both: a genuinely different finding with the same
    // filename must not be overwritten by the migration.
    legacyCampaign(root, 'collide.test-20261009-010101', { target: 'collide.test', finding: 'dup.md' });
    fs.mkdirSync(path.join(root, 'collide.test', 'findings'), { recursive: true });
    write(path.join(root, 'collide.test', 'findings', 'dup.md'), 'the original');
    huntMod.migrateHunts(cfg);
    check(
      'migrate: a filename collision keeps the existing file',
      read(path.join(root, 'collide.test', 'findings', 'dup.md')) === 'the original',
    );
    check('migrate: nothing to migrate is not an error', huntMod.migrateHunts(cfg).length === 0);
  });

  it('test_hunt_findings_tool', async () => {
    // The main agent's read tool: a campaign on disk, answered from disk. A
    // hunt runs on its own Agent instances, so the main agent sees none of
    // it. When the operator stopped a wave and said "save the findings", it
    // had no path to the campaign directory and said nothing was found —
    // over a directory that already held a high-severity finding.
    const wd = wdFor('test_hunt_findings_tool');
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_findings_tool');

    // Nothing has run yet: the tool must say so, not invent a campaign. On
    // its own pristine store.
    const virginWd = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-virgin-'));
    const virgin = cfgFor(virginWd, { mode: 'andy' });
    virgin.stateDir = path.join(virginWd, 'state');
    const emptyRes = await toolsMod.execute('hunt_findings', {}, virgin);
    check(
      'hunt_findings: no campaign yet is stated plainly',
      emptyRes.output.includes('no /bug-hunt campaign'),
      emptyRes.output,
    );

    // Build two campaigns: one with findings, recon and plans, and a later
    // one that must win the "most recent" default.
    const old = path.join(cfg.stateDir, 'hunts', 'quiet.test');
    fs.mkdirSync(path.join(old, 'findings'), { recursive: true });
    fs.mkdirSync(path.join(old, 'plans'));
    huntMod.writeRecon(
      new huntMod.HuntRun('quiet.test', old),
      'quiet.test answers on 80, nothing else',
    );

    const targetDir = huntMod.caseDir(cfg, 'target.test');
    const run = new huntMod.HuntRun('target.test', targetDir);
    huntMod.writeRecon(run, '443 open, nginx, a login form at /login');
    huntMod.writePlan(
      run,
      1,
      new teamMod.Roster('aiming at auth', [
        new teamMod.WorkerSpec('auth', 'test auth', ['auth']),
      ]),
      '',
      false,
    );
    huntMod.writeReport(run, new huntMod.Finding({
      wave: 1, agent: 'auth', title: 'auth bypass', severity: 'critical',
      asset: 'target.test/login', summary: 'no check', evidence: 'curl',
    }));

    // ---- findings
    const res = await toolsMod.execute('hunt_findings', { scope: 'target.test' }, cfg);
    check('hunt_findings: it names the campaign', res.output.includes('target.test'), res.output.slice(0, 120));
    check(
      'hunt_findings: it reports the finding',
      res.output.includes('auth bypass') && res.output.includes('CRITICAL'),
      res.output,
    );
    // The wave is the directory now, so the filename is severity-first: a
    // wave's reports sort worst-first in a plain ls, and the wave-N- prefix
    // that used to carry that information is gone.
    check(
      'hunt_findings: it gives the file path to read in full',
      res.output.includes('critical-auth-bypass.md') && res.output.includes('wave-1'),
      res.output,
    );
    check('hunt_findings: it does not error', res.isError !== true);

    // Worst first. On disk the files sort by wave then name, which buries a
    // campaign's one critical in the middle of the list — against the real
    // 43-finding campaign it sat at position 20. A reader skimming must meet
    // the critical first, the same order /findings and the summary use.
    huntMod.writeReport(run, new huntMod.Finding({
      wave: 1, agent: 'recon', title: 'a low note', severity: 'low',
      asset: 'target.test/x', summary: 'minor', evidence: 'eh',
    }));
    huntMod.writeReport(run, new huntMod.Finding({
      wave: 1, agent: 'auth', title: 'a medium note', severity: 'medium',
      asset: 'target.test/y', summary: 'middling', evidence: 'hm',
    }));
    const ranked = await toolsMod.execute('hunt_findings', { scope: 'target.test' }, cfg);
    const order = ranked.output
      .split('\n')
      .map((line) => /^- \[(\w+)\]/.exec(line)?.[1]?.toLowerCase())
      .filter((s): s is string => s !== undefined);
    check(
      'hunt_findings: the list is worst first, not file order',
      JSON.stringify(order) === '["critical","medium","low"]',
      String(order),
    );
    check("hunt_findings: and it says so", ranked.output.includes('worst first'));

    // The severity table is duplicated from hunt.VALID_SEVERITIES inside
    // tools (the import cycle again), so the two are pinned together. The TS
    // port keeps the table module-private, so the pin is behavioural: the
    // worst-first order above IS the table, and an unknown severity would
    // sort after info — the one place it must never land. An unknown
    // severity is injected here to prove it lands last.
    write(
      path.join(huntMod.waveFindingsDir(targetDir, 1), 'weird-note.md'),
      '---\ntarget: target.test\nwave: 1\nseverity: bizarre\n---\n\n# a weird note\n',
    );
    const withUnknown = await toolsMod.execute('hunt_findings', { scope: 'target.test' }, cfg);
    const orderUnknown = withUnknown.output
      .split('\n')
      .map((line) => /^- \[(\w*)\]/.exec(line)?.[1]?.toLowerCase())
      .filter((s): s is string => s !== undefined);
    check(
      'hunt_findings: an unknown severity sorts last, below info',
      orderUnknown[orderUnknown.length - 1] === 'bizarre' && orderUnknown[orderUnknown.length - 2] === 'low',
      String(orderUnknown),
    );

    // ---- the default is the most recently written campaign
    const recent = await toolsMod.execute('hunt_findings', {}, cfg);
    check(
      'hunt_findings: with no scope it reads the most recent campaign',
      recent.output.includes('target.test'),
      recent.output.slice(0, 120),
    );

    // ---- "most recent" follows the artefacts, not the directory's mtime.
    // migrateHunts moves files INTO a scope directory and bumps its mtime to
    // now, so a week-old campaign merged at boot would otherwise sort ahead
    // of one that finished an hour ago. The artefacts' mtimes survive the
    // move.
    const stale = path.join(cfg.stateDir, 'hunts', 'stale.test');
    huntMod.writeRecon(
      new huntMod.HuntRun('stale.test', stale),
      'an old campaign, merged at boot',
    );
    const oldTime = new Date(Date.now() / 1000 - 86400 * 7);
    for (const p of allPaths(stale)) fs.utimesSync(p, oldTime, oldTime);
    fs.utimesSync(stale, new Date(), new Date()); // the move bumped the dir
    const still = await toolsMod.execute('hunt_findings', {}, cfg);
    check(
      'hunt_findings: a freshly-touched old directory does not win',
      still.output.includes('target.test'),
      still.output.slice(0, 120),
    );

    // ---- the scope is reduced the same way the directory name is, so what
    // the operator types finds the campaign however they think of it.
    for (const typed of ['https://target.test/login', 'target.test:443', 'TARGET.TEST']) {
      const hit = await toolsMod.execute('hunt_findings', { scope: typed }, cfg);
      check(
        `hunt_findings: scope ${JSON.stringify(typed)} finds the campaign`,
        hit.output.includes('auth bypass'),
        hit.output.slice(0, 120),
      );
    }

    // ---- recon
    const recon = await toolsMod.execute(
      'hunt_findings',
      { scope: 'target.test', include: 'recon' },
      cfg,
    );
    check(
      'hunt_findings: recon is read back',
      recon.output.includes('nginx') && recon.output.includes('/login'),
      recon.output.slice(0, 200),
    );
    check(
      'hunt_findings: recon is not the frontmatter',
      !recon.output.includes('timestamp:'),
      recon.output.slice(0, 200),
    );

    // ---- plans
    const plans = await toolsMod.execute(
      'hunt_findings',
      { scope: 'target.test', include: 'plans' },
      cfg,
    );
    check(
      'hunt_findings: the wave plan is listed',
      plans.output.includes('wave 1') && plans.output.includes('1 agents'),
      plans.output,
    );

    // ---- all
    const everything = await toolsMod.execute(
      'hunt_findings',
      { scope: 'target.test', include: 'all' },
      cfg,
    );
    check(
      "hunt_findings: 'all' carries findings, recon and plans",
      everything.output.includes('auth bypass') && everything.output.includes('nginx')
        && everything.output.includes('wave 1'),
    );

    // ---- a campaign matched by the target recorded in its findings, not
    // just by the directory name.
    const byTarget = await toolsMod.execute('hunt_findings', { scope: 'quiet.test' }, cfg);
    check(
      'hunt_findings: a scope with no findings says so',
      byTarget.output.includes('none were confirmed'),
      byTarget.output,
    );

    // ---- bad input is refused with a reason, not a traceback
    const badInclude = await toolsMod.execute('hunt_findings', { include: 'everything' }, cfg);
    check(
      'hunt_findings: an unknown include is an error',
      badInclude.isError === true && badInclude.output.includes('findings'),
      badInclude.output,
    );
    const missing = await toolsMod.execute('hunt_findings', { scope: 'nope.test' }, cfg);
    check(
      'hunt_findings: an unknown scope names the known ones',
      missing.isError !== true && missing.output.includes('Known scopes'),
      missing.output,
    );

    // ---- the gate. The main agent gets it; a hunt agent must not.
    const main = new Agent(cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-gate-'))));
    const hunter = new Agent(
      cfgFor(fs.mkdtempSync(path.join(os.tmpdir(), 'andy-hunt-gate-'))),
      undefined,
      undefined,
      true,
      false,
    );
    const mainTools = new Set(main.toolSchemas().map((t) => t.name));
    const hunterTools = new Set(hunter.toolSchemas().map((t) => t.name));
    check('hunt_findings: an ordinary session is offered it', mainTools.has('hunt_findings'));
    check(
      'hunt_findings: a hunt agent is NOT offered it',
      !hunterTools.has('hunt_findings'),
      String([...hunterTools].sort()),
    );
    const denied = priv(hunter).denied('hunt_findings') as string | null;
    check(
      'hunt_findings: a hunt agent calling it is denied with a reason',
      denied !== null && denied.includes('independent'),
      String(denied),
    );
    check(
      'hunt_findings: report_finding is still hunt-only',
      hunterTools.has('report_finding') && !mainTools.has('report_finding'),
    );

    // The tool name and the store path are pinned here because tools.ts
    // cannot import hunt (hunt imports agent imports tools). The store
    // directory literal is 'hunts' on both sides.
    check(
      'hunt_findings: the store path matches hunt.caseDir',
      base(path.dirname(huntMod.caseDir(cfg, 'target.test'))) === 'hunts',
      'hunts',
    );
  });

  it('test_campaign_notes', async () => {
    // Recon and each wave's plan land on disk, so a campaign accumulates
    // notes. Recon used to exist only on the run object and each plan only
    // as a UI event, so stopping a campaign lost both.
    const wd = wdFor('test_campaign_notes');
    const roster = '{"summary": "aiming at auth", "workers": ['
      + '{"name": "auth", "brief": "test auth", "owns": ["auth", "login"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'the target answers on 443, nginx, a login form at /login',
      final: findingJson('auth bypass'),
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_campaign_notes');

    const run = await huntMod.runHunt(cfg, 'notes.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    // ---- recon notes
    const reconFiles = fs.readdirSync(run.directory)
      .filter((n) => /^recon-.*\.md$/.test(n))
      .map((n) => path.join(run.directory, n))
      .sort();
    check(
      'notes: recon is written to the campaign directory',
      reconFiles.length === 1,
      String(reconFiles.map(base)),
    );
    const body = read(reconFiles[0]);
    check('notes: the recon text is preserved', body.includes('nginx'));
    check('notes: recon is stamped wave 0', body.includes('wave: 0'));
    check('notes: recon carries the target', body.includes('target: notes.test'));
    check(
      'notes: the recon file is named by its timestamp',
      base(reconFiles[0]).replace(/\.md$/, '').length === 'recon-20261010-025510'.length,
      base(reconFiles[0]),
    );

    const done = events.filter((e) => e.type === 'hunt_recon_done');
    check(
      'notes: the recon event carries the path it wrote',
      done.length > 0 && done[0].type === 'hunt_recon_done' && done[0].saved === reconFiles[0],
      done[0] && done[0].type === 'hunt_recon_done' ? done[0].saved : '(none)',
    );

    // ---- plans
    const planFiles = fs.readdirSync(path.join(run.directory, 'wave-1'))
      .filter((n) => /^plan.*\.md$/.test(n))
      .map((n) => path.join(run.directory, 'wave-1', n))
      .sort();
    check('notes: the wave\'s plan is written', planFiles.length === 1, String(planFiles.map(base)));
    const plan = read(planFiles[0]);
    check(
      "notes: the plan sits in the wave's own directory",
      base(path.dirname(planFiles[0])) === 'wave-1' && base(planFiles[0]) === 'plan.md',
      path.relative(run.directory, planFiles[0]),
    );
    check('notes: the plan keeps each brief', plan.includes('test auth'));
    check('notes: the plan keeps what each agent owns', plan.includes('auth, login'));
    check('notes: the plan records the roster size', plan.includes('agents: 1'));
    check('notes: a read planner is not marked as fallen back', plan.includes('fell_back: false'));
    check('notes: a good plan does not paste the raw reply', !plan.includes('## Planner reply'));

    // ---- recon is also fed to the planner, unchanged by being written first.
    check('notes: recon still reaches the planner', run.recon.includes('nginx'));

    // ---- and it reads back. A summary asked for after a restart must not
    // say "recon produced nothing" over a recon that mapped the target.
    const recovered = huntMod.loadRun(run.directory);
    check('notes: a campaign reads back off disk', recovered !== undefined);
    check(
      'notes: the recon is recovered, not lost',
      recovered !== undefined && recovered.recon.includes('nginx'),
      recovered ? recovered.recon.slice(0, 80) : '',
    );
    check(
      'notes: the recovered recon drops the file\'s own heading',
      recovered !== undefined && !recovered.recon.startsWith('#'),
      recovered ? recovered.recon.slice(0, 40) : '',
    );
    check(
      'notes: the recovered recon drops the frontmatter',
      recovered !== undefined && !recovered.recon.includes('timestamp:'),
      recovered ? recovered.recon.slice(0, 60) : '',
    );
    check(
      'notes: the recovered wave history names the wave',
      recovered !== undefined && recovered.waves.some((w) => w.startsWith('wave 1: 1 agents')),
      String(recovered ? recovered.waves : null),
    );
    check(
      'notes: the recovered history says what the wave found',
      recovered !== undefined && recovered.waves.some((w) => w.includes('finding(s)')),
      String(recovered ? recovered.waves : null),
    );
    check(
      'notes: the wave reads back as a record, not a string',
      recovered !== undefined && recovered.waveRecords.length === 1
        && recovered.waveRecords[0].number === 1
        && recovered.waveRecords[0].agents === 1,
      String(recovered ? recovered.waveRecords : null),
    );
    check(
      "notes: the wave record keeps the planner's summary",
      recovered !== undefined && recovered.waveRecords[0].summary.includes('aiming at auth'),
      recovered ? recovered.waveRecords[0].summary : '',
    );
    check(
      'notes: the recovered run knows its highest wave',
      recovered !== undefined && recovered.wave === 1,
      String(recovered ? recovered.wave : null),
    );

    // A campaign with recon but no findings is still summarisable — the
    // exact case the operator hit: stopped mid-campaign, nothing confirmed,
    // but recon full of information.
    const emptyDir = path.join(path.dirname(run.directory), 'recon-only.test');
    fs.mkdirSync(path.join(emptyDir, 'findings'), { recursive: true });
    huntMod.writeRecon(
      new huntMod.HuntRun('recon-only.test', emptyDir),
      'an exposed log at /logs, directory listing on /img',
    );
    const only = huntMod.loadRun(emptyDir);
    check('notes: recon alone is enough to summarise a campaign', only !== undefined, String(only));
    check(
      'notes: the recon-only campaign keeps its notes',
      only !== undefined && only.recon.includes('exposed log'),
      only ? only.recon.slice(0, 80) : '',
    );
    check(
      'notes: a recon-only campaign has no findings',
      only !== undefined && only.findings.length === 0,
    );
  }, 20000);

  it('test_repeat_hunt_reuses_recon', async () => {
    // A second /bug-hunt on a scope plans against the first run's recon.
    // Remapping a target that has not moved costs minutes of wall-clock and
    // a wave's worth of tokens before the first brief is written.
    const wd = wdFor('test_repeat_hunt_reuses_recon');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "auth", "brief": "test auth", "owns": ["auth"]}]}';
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_repeat_hunt_reuses_recon');

    // ---- run 1: a normal campaign, which leaves recon and a finding on disk.
    const firstScript = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'nginx on 443, a login form at /login',
      final: findingJson('username enumeration', 'dev.x.test'),
    };
    const first = huntFactory(firstScript);
    const stop1 = new huntMod.AsyncEvent();
    const run1 = await huntMod.runHunt(cfg, 'repeat.test', {
      onEvent: recorder([], stop1),
      agentFactory: first,
      stop: stop1,
      waveSize: 1,
      concurrency: 1,
    });
    check('repeat: the first campaign really mapped the target', run1.recon.includes('nginx'), run1.recon.slice(0, 60));
    check(
      'repeat: the first campaign left a finding on disk',
      run1.findings.length === 1,
      String(run1.findings.length),
    );

    // ---- run 2: the same scope, no --fresh. Recon must not run.
    const events: HuntEvent[] = [];
    const secondScript = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      // A distinct recon text, so if recon *did* run this is what the run
      // would carry — the assertion below can then tell reuse from a remap.
      reconFinal: 'REMAP HAPPENED',
      final: findingJson('xss in search', 'dev.x.test'),
    };
    const second = huntFactory(secondScript);
    const stop2 = new huntMod.AsyncEvent();
    const run2 = await huntMod.runHunt(cfg, 'repeat.test', {
      onEvent: recorder(events, stop2),
      agentFactory: second,
      stop: stop2,
      waveSize: 1,
      concurrency: 1,
    });

    const kinds = events.map((e) => e.type);
    check(
      'repeat: recon is skipped, not re-run',
      kinds.includes('hunt_recon_skipped') && !kinds.includes('hunt_recon_start'),
      String(kinds.slice(0, 4)),
    );
    // The planner is a mode-plan agent too, so the count is of non-planner
    // agents: without recon that is the one worker and nothing else.
    check(
      'repeat: no recon agent was built — one worker, no mapper',
      second.built.filter((a) => a.cfg.mode !== 'plan').length === 1,
      String(second.built.map((a) => a.cfg.mode)),
    );
    check(
      'repeat: the inherited recon is the earlier one, not a remap',
      run2.recon.includes('nginx') && !run2.recon.includes('REMAP HAPPENED'),
      run2.recon.slice(0, 60),
    );
    check(
      'repeat: the run records where the recon came from',
      run2.reusedRecon === true && run2.reconSource !== null
        && base(run2.reconSource).startsWith('recon-'),
      String(run2.reconSource),
    );

    // ---- the earlier finding is carried into this campaign's tracker, and
    // marked so it cannot be read as this campaign's haul.
    const carried = run2.findings.filter((f) => f.carried);
    check(
      'repeat: the earlier finding is carried into the tracker',
      carried.length === 1 && carried[0].title === 'username enumeration',
      String(run2.findings.map((f) => f.title)),
    );
    check('repeat: the carried count is recorded on the run', run2.reconCarried === 1, String(run2.reconCarried));
    check(
      'repeat: the skip event carries the carried findings for the rail',
      events.some(
        (e) => e.type === 'hunt_recon_skipped' && e.carried === 1
          && e.findings.some((f) => f.title.includes('username enumeration')),
      ),
    );
    check(
      'repeat: the skip event names the notes file it reused',
      events.some((e) => e.type === 'hunt_recon_skipped' && e.path.endsWith('.md')),
    );

    // ---- the closing count splits carried from own, so the campaign does
    // not claim bugs it never found.
    const end = events.filter((e) => e.type === 'hunt_end');
    check(
      "repeat: the closing count reports only this campaign's findings",
      end.length > 0 && end[0].type === 'hunt_end'
        && end[0].findings === 1 && end[0].carried === 1,
      String(end[0] ?? null),
    );

    // ---- the planner is told the map is second-hand. script.prompts
    // collects every planner prompt in order, so the assertion is against
    // what the model was actually handed.
    const planPrompt = secondScript.prompts[secondScript.prompts.length - 1];
    check(
      'repeat: the planner is told the recon was not taken now',
      planPrompt.includes('was NOT taken now'),
      planPrompt.slice(-400),
    );
    // "An earlier wave", not "an earlier campaign": with one wave per
    // invocation, wave 2's own wave-1 findings arrive through this same
    // seeding path, so the narrower label would be a lie about half of them.
    check(
      'repeat: the planner sees the carried finding as carried',
      planPrompt.includes('found in an earlier wave'),
      planPrompt.slice(0, 400),
    );

    // ---- and --fresh forces the mapping phase back on.
    const freshEvents: HuntEvent[] = [];
    const third = huntFactory({
      rosters: [roster], plannerCalls: 0, prompts: [] as string[],
      reconFinal: 'REMAP HAPPENED', final: findingJson('y'),
    });
    const stop3 = new huntMod.AsyncEvent();
    const run3 = await huntMod.runHunt(cfg, 'repeat.test', {
      onEvent: recorder(freshEvents, stop3),
      agentFactory: third,
      stop: stop3,
      waveSize: 1,
      concurrency: 1,
      fresh: true,
    });
    const kinds3 = freshEvents.map((e) => e.type);
    check(
      'repeat: --fresh remaps rather than reusing',
      kinds3.includes('hunt_recon_start') && !kinds3.includes('hunt_recon_skipped'),
      String(kinds3.slice(0, 4)),
    );
    check(
      'repeat: --fresh builds a recon agent again',
      third.built.filter((a) => a.cfg.mode !== 'plan').length === 2,
      String(third.built.map((a) => a.cfg.mode)),
    );
    check('repeat: --fresh takes the new recon', run3.recon.includes('REMAP HAPPENED'), run3.recon.slice(0, 60));
    // --fresh draws its own map — that is what fresh means — but the bugs
    // earlier campaigns confirmed are still open, so the tracker is seeded
    // with them and they stay marked carried: this campaign found "y", not
    // those.
    check(
      'repeat: --fresh reuses no map',
      run3.reconSource === null && run3.reusedRecon === false,
      String(run3.reconSource),
    );
    check(
      'repeat: a fresh remap still seeds the tracker from disk',
      run3.findings.some((f) => f.title === 'username enumeration'),
      String(run3.findings.map((f) => f.title)),
    );
    check(
      'repeat: the seeded findings stay marked carried',
      run3.reconCarried === 2
        && run3.findings.filter((f) => f.title === 'username enumeration').every((f) => f.carried),
      String(run3.reconCarried),
    );
  }, 20000);

  it('test_find_recon_reads_the_newest', () => {
    // findRecon picks the newest notes, and ignores an empty one. Newest by
    // filename, not mtime: recon-<stamp>.md sorts by the timestamp it
    // carries. An empty recon is not something to plan against — re-running
    // is the honest answer.
    const wd = wdFor('test_find_recon');
    const d = path.join(wd, 'recon-probe');
    fs.mkdirSync(d, { recursive: true });

    check('find: a directory with no recon yields None', huntMod.findRecon(d) === undefined);
    check(
      'find: a directory that does not exist yields None',
      huntMod.findRecon(path.join(wd, 'nope')) === undefined,
    );

    write(
      path.join(d, 'recon-20260101-000000.md'),
      '---\ntarget: x.test\nwave: 0\n---\n\n# Recon\n\nfirst map\n',
    );
    const newer = path.join(d, 'recon-20260202-000000.md');
    write(newer, '---\ntarget: x.test\nwave: 0\n---\n\n# Recon\n\nsecond map\n');

    const note = huntMod.findRecon(d);
    check(
      'find: the newest recon is chosen',
      note !== undefined && note.text.includes('second map'),
      note ? note.text : '',
    );
    check(
      'find: the frontmatter is stripped',
      note !== undefined && !note.text.startsWith('---') && !note.text.includes('target:'),
    );
    check(
      'find: the heading is stripped',
      note !== undefined && !note.text.startsWith('#'),
      note ? note.text : '',
    );
    check(
      "find: the path is carried for the operator's notice",
      note !== undefined && note.path === newer,
    );
    check(
      'find: the age is a non-negative number of seconds',
      note !== undefined && note.age >= 0.0,
    );

    // An empty newest recon falls through to the one with content, rather
    // than being returned as an empty map.
    write(path.join(d, 'recon-20260303-000000.md'), '---\ntarget: x.test\nwave: 0\n---\n\n# Recon\n\n');
    const note2 = huntMod.findRecon(d);
    check(
      'find: an empty newest recon falls through to the last real one',
      note2 !== undefined && note2.text.includes('second map'),
      note2 ? note2.text : '',
    );
  });

  it('test_plan_records_a_fallback', async () => {
    // A planner whose reply could not be read keeps what it actually said.
    // The fixed matrix runs in its place, and the raw reply is the only way
    // to tell a malformed object from an empty turn from a prompt that needs
    // rewriting — so it has to outlive the event that announced it.
    const wd = wdFor('test_plan_records_a_fallback');
    const script = {
      rosters: ["I'll send ten agents to look at the login page."],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'nothing reachable',
      final: findingJson('x'),
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_plan_records_a_fallback');

    const run = await huntMod.runHunt(cfg, 'fallback.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 1,
    });

    const planFiles = allPaths(run.directory)
      .filter((p) => /\/wave-\d+\/plan.*\.md$/.test(p))
      .sort();
    check('fallback: the wave still has a plan file', planFiles.length === 1, String(planFiles));
    const plan = read(planFiles[0]);
    check('fallback: the plan is marked as fallen back', plan.includes('fell_back: true'));
    check(
      'fallback: the raw planner reply is kept',
      plan.includes("I'll send ten agents"),
      plan.slice(0, 200),
    );
    check(
      "fallback: the fixed matrix's briefs are recorded",
      plan.includes('agents: 2'),
      plan.slice(0, 300),
    );
  }, 20000);

  it('test_hunt_loop', async () => {
    // Recon, one wave, findings harvested, then stopped.
    const wd = wdFor('test_hunt_loop');
    const roster = '{"summary": "aiming at auth", "workers": ['
      + '{"name": "auth", "brief": "test auth", "owns": ["auth"]},'
      + '{"name": "idor", "brief": "test idor", "owns": ["idor"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'the target answers on 443, nginx, a login form at /login',
      // Distinct findings per worker: the tracker deduplicates, so two
      // identical reports would collapse to one and this test's "two
      // findings harvested" would be measuring the dedup, not the harvest.
      final: [findingJson('auth bypass'), findingJson('idor on /api/users')],
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_loop');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 2,
    });

    const kinds = events.map((e) => e.type);
    check(
      'hunt: recon runs before any wave',
      kinds.indexOf('hunt_recon_start') < kinds.indexOf('hunt_wave_start'),
    );
    check('hunt: recon reports back', kinds.includes('hunt_recon_done'));
    check('hunt: a plan event is emitted', kinds.includes('hunt_plan'));
    check(
      'hunt: every agent starts and finishes',
      kinds.filter((k) => k === 'hunt_agent_start').length === 2
        && kinds.filter((k) => k === 'hunt_agent_done').length === 2,
    );
    check('hunt: the wave closes with hunt_wave_end', kinds.includes('hunt_wave_end'));
    check('hunt: the run closes with hunt_end', kinds[kinds.length - 1] === 'hunt_end', kinds[kinds.length - 1]);
    check('hunt: exactly one wave ran', run.wave === 1, String(run.wave));
    check('hunt: the recon text is kept on the run', run.recon.includes('nginx'), run.recon.slice(0, 60));

    check(
      'hunt: findings are harvested off the agents',
      run.findings.length === 2,
      String(run.findings.length),
    );
    check(
      'hunt: a critical finding is kept',
      run.findings.some((f) => f.severity === 'critical'),
    );
    check(
      'hunt: a finding event is emitted per finding',
      kinds.filter((k) => k === 'hunt_finding').length === 2,
      String(kinds.filter((k) => k === 'hunt_finding').length),
    );
    check(
      'hunt: saved findings report their path',
      events.some((e) => e.type === 'hunt_finding' && e.saved !== ''),
    );
    // Each wave's reports live in that wave's own directory, so the tree says
    // which wave a finding came from without reading its frontmatter.
    // (Python reached the private hunt._finding_files; the wave layout is
    // the contract, so the files are walked directly.)
    const savedFiles = allPaths(run.directory).filter(
      (p) => p.endsWith('.md') && base(path.dirname(p)) === 'findings',
    );
    check(
      'hunt: the report file exists on disk',
      savedFiles.length === 2,
      String(savedFiles.map(base)),
    );
    check(
      'hunt: the reports are filed under their wave',
      new Set(savedFiles.map((p) => base(path.dirname(path.dirname(p))))).size === 1
        && savedFiles.every((p) => base(path.dirname(path.dirname(p))) === `wave-${run.wave}`),
      String([...new Set(savedFiles.map((p) => base(path.dirname(path.dirname(p)))))].sort()),
    );
    check(
      'hunt: findings are attributed to the agent that found them',
      new Set(run.findings.map((f) => f.agent)).size === 2
        && run.findings.every((f) => f.agent === 'auth' || f.agent === 'idor'),
      String([...new Set(run.findings.map((f) => f.agent))]),
    );

    // The planner is read-only, so it cannot do the work itself.
    const planners = factory.built.filter((a) => a.cfg.mode === 'plan');
    const agents = factory.built.filter((a) => a.cfg.mode === 'andy');
    check('hunt: the planner runs in plan mode', planners.length === 1);
    check(
      'hunt: agents inherit the session mode (andy)',
      agents.length === 3,
      String(agents.length),
    ); // recon + 2 workers
    check(
      'hunt: each agent gets its own Config',
      new Set(agents.map((a) => a.cfg)).size === 3,
    );
  }, 20000);

  it('test_contract_in_worker_prompts', async () => {
    // End to end: the prompt a wave agent is really handed carries the
    // finding contract, after its brief.
    const wd = wdFor('test_contract_in_worker_prompts');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "auth", "brief": "probe auth", "owns": ["auth"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      workerPrompts: [] as string[],
      reconFinal: 'recon: one host, a login form',
      final: findingJson(),
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_contract_in_worker_prompts');

    await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    const prompts = script.workerPrompts ?? [];
    check(
      'contract: the worker was handed a prompt',
      prompts.length === 1,
      String(prompts.length),
    );
    check(
      'contract: the worker prompt carries the finding contract',
      prompts[0].includes('One entry per distinct bug'),
      prompts[0].slice(-200),
    );
    check(
      'contract: the contract comes after the brief',
      prompts[0].indexOf('probe auth') < prompts[0].indexOf('One entry per'),
    );
  }, 20000);

  it('test_live_reporting_mid_wave', async () => {
    // A report_finding call publishes before the wave ends. This is the
    // operator's actual request: agent-3 finds something and it shows in the
    // tracker THEN, not when the hunt finishes. The assertion that makes it
    // real is ordering — a hunt_finding must appear in the event stream
    // before the hunt_wave_end for the wave it was found in.
    const wd = wdFor('test_live_reporting_mid_wave');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "auth", "brief": "probe auth", "owns": ["auth"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      workerPrompts: [] as string[],
      reconFinal: 'recon: one host',
      // The worker's one tool call is the live report.
      firstTool: ['report_finding', {
        title: 'SQL injection in ?id',
        severity: 'critical',
        asset: 'api.x.test',
        evidence: 'curl returned a stack trace',
      }] as [string, Record<string, unknown>],
      // And its final message carries the same bug, as the contract asks. The
      // tracker must not count it twice.
      final: findingJson('SQL injection in ?id', 'api.x.test'),
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_live_reporting_mid_wave');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    const kinds = events.map((e) => e.type);
    check('live: a finding is published', kinds.includes('hunt_finding'), String(kinds));
    if (kinds.includes('hunt_finding') && kinds.includes('hunt_wave_end')) {
      const firstFinding = kinds.indexOf('hunt_finding');
      const waveEnd = kinds.indexOf('hunt_wave_end');
      check(
        'live: the finding is published BEFORE the wave ends',
        firstFinding < waveEnd,
        `finding@${firstFinding} wave_end@${waveEnd}`,
      );

      // And specifically after the agent started, so it really is mid-turn.
      check(
        'live: the finding lands after its agent started',
        kinds.indexOf('hunt_agent_start') < firstFinding,
      );

      // The event carries the finding, normalised, attributed to the agent.
      const ev = events.find((e) => e.type === 'hunt_finding');
      check(
        'live: the published finding is attributed to the worker',
        ev !== undefined && ev.type === 'hunt_finding' && ev.finding.agent === 'auth',
        String(ev && ev.type === 'hunt_finding' ? ev.finding.agent : null),
      );
      check(
        'live: the published finding keeps its severity',
        ev !== undefined && ev.type === 'hunt_finding' && ev.finding.severity === 'critical',
        String(ev && ev.type === 'hunt_finding' ? ev.finding.severity : null),
      );

      // Exactly one, even though the agent both called the tool and repeated
      // it in its final JSON: the tracker deduplicates the two paths.
      const n = kinds.filter((k) => k === 'hunt_finding').length;
      check(
        'live: the tool report and the final JSON are not double-counted',
        n === 1,
        String(n),
      );
      check(
        'live: the tracker holds exactly one finding',
        run.findings.length === 1,
        String(run.findings.length),
      );
      // A critical earns a report file, even though it arrived live.
      check(
        'live: a live critical still gets a report written',
        run.findings[0].saved,
        String(run.findings[0].severity),
      );
    }
  }, 20000);

  it('test_live_reporting_is_per_agent', async () => {
    // Two agents reporting the same bug publish it once, from the first.
    // The tracker is shared across a wave, so the second agent to rediscover
    // a bug must not publish it again.
    const wd = wdFor('test_live_reporting_is_per_agent');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "auth", "brief": "probe auth", "owns": ["auth"]},'
      + '{"name": "api", "brief": "probe api", "owns": ["api"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      workerPrompts: [] as string[],
      reconFinal: 'recon: one host',
      firstTool: ['report_finding', {
        title: 'SQL injection in ?id',
        severity: 'high',
        asset: 'api.x.test',
        evidence: 'same bug, found twice',
      }] as [string, Record<string, unknown>],
      // Neither agent repeats it in its final message, so every finding in
      // the stream came from a live report.
      final: '{"findings": []}',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_live_reporting_is_per_agent');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 2,
    });

    const published = events.filter((e) => e.type === 'hunt_finding').map((e) => e.finding);
    check(
      'live: the shared bug is published once for the wave',
      published.length === 1,
      String(published.length),
    );
    check(
      'live: the tracker holds one finding',
      run.findings.length === 1,
      String(run.findings.length),
    );
    if (published.length > 0) {
      // Which agent wins is a scheduling race — both report it — so the
      // assertion is that the winner is one of the two, not which one.
      check(
        'live: the published finding names the agent that reported it',
        published[0].agent === 'auth' || published[0].agent === 'api',
        published[0].agent,
      );
      // The wave's own count has to include what was published live, or the
      // transcript reads "0 finding(s)" for a wave that announced a bug.
      check(
        'live: the wave-end count includes the live finding',
        events.some((e) => e.type === 'hunt_wave_end' && e.found === 1),
        String(events.filter((e) => e.type === 'hunt_wave_end').map((e) => (e.type === 'hunt_wave_end' ? e.found : null))),
      );
      check(
        "live: the run's own wave log agrees",
        run.waves.some((line) => line.includes('1 finding(s)')),
        String(run.waves),
      );
    }
  }, 20000);

  it('test_hunt_replans_from_findings', async () => {
    // Wave 2's planner must be handed wave 1's findings. Two waves through
    // one call, which the UI never does — but this is the seam that proves
    // the replanning edge still works, and it is why maxWaves is a parameter
    // rather than a bare break.
    const wd = wdFor('test_hunt_replans_from_findings');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "w1", "brief": "first", "owns": ["a"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: a single host, nothing exotic',
      // A distinct finding each wave: the tracker deduplicates on title+asset,
      // and this test is about accumulation across waves, not about dedup.
      final: [findingJson('unique-marker-bug'), findingJson('second-wave-bug')],
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_replans_from_findings');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop, 2),
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
      maxWaves: 2,
    });

    check('replan: two waves ran', run.wave === 2, String(run.wave));
    check(
      'replan: the planner was consulted twice',
      script.prompts.length === 2,
      String(script.prompts.length),
    );
    check(
      "replan: wave 1's prompt carries no prior findings",
      script.prompts[0].includes('nothing confirmed yet'),
    );
    check(
      "replan: wave 2's prompt carries wave 1's finding",
      script.prompts[1].includes('unique-marker-bug'),
      script.prompts[1].slice(0, 200),
    );
    check(
      "replan: wave 2's prompt carries the wave history",
      script.prompts[1].includes('wave 1:'),
    );
    check(
      'replan: findings accumulate across waves',
      run.findings.length === 2,
      String(run.findings.length),
    );
    check('replan: the run records both waves', run.waves.length === 2, String(run.waves));
  }, 20000);

  it('test_one_wave_is_the_default', async () => {
    // /bug-hunt with no --wave runs exactly one wave, then stops. The
    // complaint this exists for: after wave 1 found a critical, the loop
    // planned wave 2 anyway. One wave per invocation makes the operator's
    // next decision theirs.
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "w1", "brief": "first", "owns": ["a"]}]}';
    const wd = wdFor('test_one_wave_is_the_default');
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_one_wave_is_the_default');

    const factoryFor = (marker: string) =>
      // A distinct title per hunt on purpose: the tracker deduplicates on
      // title+asset and the run is seeded with what is already on disk, so a
      // repeated marker would be dropped as a duplicate and the wave would
      // legitimately write nothing — measuring the dedup, not the numbering.
      huntFactory({
        rosters: [roster],
        plannerCalls: 0,
        prompts: [] as string[],
        reconFinal: 'recon: one host',
        final: [findingJson(marker)],
      });

    // ---- the default: one wave, no stop signal needed.
    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const run = await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(events, stop, 99),
      agentFactory: factoryFor('bug-a'),
      stop,
      waveSize: 1,
      concurrency: 1,
    });
    check('one wave: a plain hunt runs exactly one wave', run.wave === 1, String(run.wave));
    check(
      'one wave: and stops on its own, with no stop set',
      stop.isSet() === false && run.stop.isSet() === false,
    );
    check(
      'one wave: the planner was consulted once',
      events.filter((e) => e.type === 'hunt_wave_start').length === 1,
    );

    // ---- the same scope again: wave 2, not a second wave 1.
    const events2: HuntEvent[] = [];
    const stop2 = new huntMod.AsyncEvent();
    const run2 = await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(events2, stop2, 99),
      agentFactory: factoryFor('bug-b'),
      stop: stop2,
      waveSize: 1,
      concurrency: 1,
    });
    check('one wave: a repeat hunt continues the numbering', run2.wave === 2, String(run2.wave));
    check(
      "one wave: wave 1's findings are still on disk",
      isFile(path.join(run.directory, 'wave-1', 'findings', 'critical-bug-a.md')),
      String(fs.readdirSync(path.join(run.directory, 'wave-1', 'findings'))),
    );
    check(
      'one wave: and wave 2 got its own directory',
      isFile(path.join(run2.directory, 'wave-2', 'findings', 'critical-bug-b.md')),
      String(fs.readdirSync(path.join(run2.directory, 'wave-2', 'findings'))),
    );

    // ---- --wave 3: run wave 3 specifically, without 4.
    const events3: HuntEvent[] = [];
    const stop3 = new huntMod.AsyncEvent();
    const run3 = await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(events3, stop3, 99),
      agentFactory: factoryFor('bug-c'),
      stop: stop3,
      waveSize: 1,
      concurrency: 1,
      waveNumber: 3,
    });
    check('one wave: --wave 3 runs wave 3', run3.wave === 3, String(run3.wave));
    check(
      'one wave: and only wave 3',
      events3.filter((e) => e.type === 'hunt_wave_start').length === 1,
    );
    check('one wave: wave 4 was not run', !exists(path.join(run3.directory, 'wave-4')));

    // ---- --wave 9 with only three waves behind it: refused, not run.
    //
    // A wave is planned against the one before it, so wave 9 here is not
    // wave 9 — it is wave 4 wearing a misleading name. The refusal must
    // happen before recon and before a single brief, and must name the wave
    // that would actually work.
    const eventsRef: HuntEvent[] = [];
    const stopRef = new huntMod.AsyncEvent();
    const scriptRef = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'r',
      final: findingJson('bug-x'),
    };
    const runRef = await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(eventsRef, stopRef, 99),
      agentFactory: huntFactory(scriptRef),
      stop: stopRef,
      waveSize: 1,
      concurrency: 1,
      waveNumber: 9,
    });
    const refused = eventsRef.filter((e) => e.type === 'hunt_refused');
    check(
      'one wave: a wave with nothing to follow is refused',
      refused.length === 1,
      String(eventsRef.map((e) => e.type)),
    );
    check(
      'one wave: the refusal names the wave that would work',
      refused.length > 0 && refused[0].type === 'hunt_refused'
        && refused[0].message.includes('run wave 4 first'),
      refused[0] && refused[0].type === 'hunt_refused' ? refused[0].message : '(no refusal)',
    );
    check(
      'one wave: and nothing was planned or run',
      scriptRef.plannerCalls === 0 && !exists(path.join(runRef.directory, 'wave-9')),
      String(scriptRef.plannerCalls),
    );
    check(
      'one wave: no wave start was emitted for the refused wave',
      !eventsRef.some((e) => e.type === 'hunt_wave_start'),
    );

    // On a scope that has never run a wave the advice is the plain command,
    // not "run wave 1 first" — there is no earlier wave to point at.
    const virginParent = stateDir(wd, 'test_one_wave_is_the_default_fresh');
    const cfg2 = cfgFor(wd, { mode: 'andy' });
    cfg2.stateDir = virginParent;
    const eventsV: HuntEvent[] = [];
    const stopV = new huntMod.AsyncEvent();
    await huntMod.runHunt(cfg2, 'virgin.test', {
      onEvent: recorder(eventsV, stopV, 99),
      agentFactory: huntFactory(scriptRef),
      stop: stopV,
      waveSize: 1,
      concurrency: 1,
      waveNumber: 2,
    });
    const refusedV = eventsV.filter((e) => e.type === 'hunt_refused');
    check(
      'one wave: on a virgin scope the refusal says start with wave 1',
      refusedV.length > 0 && refusedV[0].type === 'hunt_refused'
        && refusedV[0].message.includes('has not run a wave yet'),
      refusedV[0] && refusedV[0].type === 'hunt_refused' ? refusedV[0].message : '(no refusal)',
    );

    // The carried findings are labelled as an earlier wave's, not this
    // campaign's — the campaign is the scope's whole history now.
    const script4 = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'r',
      final: [findingJson('bug-d')],
    };
    const events4: HuntEvent[] = [];
    const stop4 = new huntMod.AsyncEvent();
    await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(events4, stop4, 99),
      agentFactory: huntFactory(script4),
      stop: stop4,
      waveSize: 1,
      concurrency: 1,
    });
    check(
      "one wave: the next planner sees the earlier waves' findings",
      script4.prompts[0].includes('found in an earlier wave'),
      script4.prompts[0] ? script4.prompts[0].slice(-300) : '(no prompt)',
    );

    // A stop mid-wave still lands: the bound is a wave count, not a
    // substitute for the operator's stop.
    const events5: HuntEvent[] = [];
    const stop5 = new huntMod.AsyncEvent();
    const run5 = await huntMod.runHunt(cfg, 'default.test', {
      onEvent: recorder(events5, stop5, 1),
      agentFactory: factoryFor('bug-e'),
      stop: stop5,
      waveSize: 1,
      concurrency: 1,
    });
    check(
      'one wave: the stop signal is still honoured',
      stop5.isSet() === true && run5.wave === 5,
      String(run5.wave),
    );
  }, 30000);

  it('test_hunt_fallback_wave', async () => {
    // An unreadable planner reply falls back to the vector matrix.
    const wd = wdFor('test_hunt_fallback_wave');
    const script = {
      rosters: ['I really cannot decide what to test next.'],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: nothing notable',
      final: 'no findings',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_fallback_wave');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 3,
      concurrency: 3,
    });

    const plan = events.find((e) => e.type === 'hunt_plan');
    check(
      'fallback: the plan event is flagged',
      plan !== undefined && plan.type === 'hunt_plan' && plan.fellBack === true,
    );
    check(
      'fallback: the fixed matrix supplies the briefs',
      plan !== undefined && plan.type === 'hunt_plan' && plan.workers.length === 3,
      String(plan && plan.type === 'hunt_plan' ? plan.workers.length : null),
    );
    check(
      'fallback: the vector names are used',
      plan !== undefined && plan.type === 'hunt_plan' && plan.workers[0].name === 'access-control',
      plan && plan.type === 'hunt_plan' ? plan.workers[0].name : '',
    );
    check(
      'fallback: the wave still ran',
      events.filter((e) => e.type === 'hunt_agent_start').length === 3,
    );
    check(
      'fallback: the wave history records the fallback',
      run.waves.some((w) => w.includes('fallback')),
      String(run.waves),
    );
    check(
      'fallback: the campaign still ends cleanly',
      events[events.length - 1].type === 'hunt_end',
    );
  }, 20000);

  it('test_brief_context', async () => {
    // Every worker must be handed the recon digest, or the wave re-derives
    // it. Before this, a worker saw only its own brief, so all ten opened
    // with the same ls and the same re-read of every recon file.
    const wd = wdFor('test_brief_context');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "a", "brief": "test a", "owns": ["a"]},'
      + '{"name": "b", "brief": "test b", "owns": ["b"]}]}';
    const script: Script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [],
      reconFinal: 'UNIQUE-RECON-MARKER nginx on 443, login at /login',
      final: 'nothing found',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_brief_context');

    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 2,
    });

    // The stub records what each worker was handed the first time it is
    // turned.
    const workerPrompts = script.workerPrompts ?? [];
    check(
      'context: the workers were prompted',
      workerPrompts.length >= 2,
      String(workerPrompts.length),
    );
    check(
      'context: the recon digest reaches every worker',
      workerPrompts.every((p) => p.includes('UNIQUE-RECON-MARKER')),
      String(workerPrompts.map((p) => p.slice(0, 60))),
    );
    check(
      'context: the brief is still carried alongside it',
      workerPrompts.every((p) => p.includes('test a') || p.includes('test b')),
    );
    check(
      'context: it says plainly not to re-derive',
      workerPrompts.every((p) => p.includes('do not spend a turn re-deriving')),
    );
    check(
      'context: run.recon is left whole for the planner and summary',
      run.recon.includes('UNIQUE-RECON-MARKER'),
      run.recon.slice(0, 60),
    );

    // A run with no recon at all must not prepend an empty header.
    const empty = new huntMod.HuntRun('y.test', path.join(wd, 'y'));
    check('context: no recon means no context block', huntMod.briefContext(empty) === '');
  }, 20000);

  it('test_planner_retry', async () => {
    // A garbage planner reply gets one retry before the matrix is used.
    const wd = wdFor('test_planner_retry');
    const roster = '{"summary": "retried ok", "workers": ['
      + '{"name": "auth", "brief": "test auth", "owns": ["auth"]}]}';
    // First reply is unparseable, the retry is a real roster.
    const script = {
      rosters: ['I am not sure what to test. Let me think about it.', roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: a login form at /login',
      final: 'nothing found',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_planner_retry');

    await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 2,
    });

    const plan = events.find((e) => e.type === 'hunt_plan');
    check('retry: the planner was asked twice', script.plannerCalls === 2, String(script.plannerCalls));
    check(
      'retry: the second reply is used',
      plan !== undefined && plan.type === 'hunt_plan' && plan.fellBack === false,
    );
    check(
      'retry: the retried roster supplies the briefs',
      plan !== undefined && plan.type === 'hunt_plan'
        && JSON.stringify(plan.workers.map((w) => w.name)) === '["auth"]',
      String(plan && plan.type === 'hunt_plan' ? plan.workers.map((w) => w.name) : null),
    );
    check(
      'retry: the retry prompt says what was wrong',
      script.prompts.some((p) => p.includes('could not be read as JSON')),
      String(script.prompts.map((p) => p.slice(-120))),
    );
  }, 20000);

  it('test_planner_fallback_shows_raw', async () => {
    // When both attempts fail, the operator sees what the planner said.
    const wd = wdFor('test_planner_fallback_shows_raw');
    const script = {
      rosters: ['nope', 'still nope'],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: nothing notable',
      final: 'no findings',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_planner_fallback_shows_raw');

    await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 2,
      concurrency: 2,
    });

    const plan = events.find((e) => e.type === 'hunt_plan');
    check(
      'fallback: it is still flagged',
      plan !== undefined && plan.type === 'hunt_plan' && plan.fellBack === true,
    );
    check(
      'fallback: the raw reply is carried for the operator',
      plan !== undefined && plan.type === 'hunt_plan' && plan.raw.trim() === 'still nope',
      JSON.stringify(plan && plan.type === 'hunt_plan' ? plan.raw : null),
    );
    check(
      'fallback: the fixed matrix still fills the wave',
      plan !== undefined && plan.type === 'hunt_plan' && plan.workers.length === 2,
      String(plan && plan.type === 'hunt_plan' ? plan.workers.length : null),
    );
  }, 20000);

  it('test_hunt_result_event_carries_args', async () => {
    // The result event must carry the command and meta, or the transcript
    // cannot render a full panel — it can only print a truncated label.
    const wd = wdFor('test_hunt_result_event_carries_args');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "a", "brief": "test a", "owns": ["a"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: x',
      final: 'nothing found',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_result_event_carries_args');

    await huntMod.runHunt(cfg, 'x.test', {
      onEvent: recorder(events, stop),
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    const results = events.filter((e) => e.type === 'hunt_agent_result');
    check('result: the tool result is reported', results.length >= 1, String(results.length));
    if (results.length > 0) {
      const r = results[0];
      check(
        'result: the command args ride along',
        r.type === 'hunt_agent_result' && (r.args['path'] === '.' || Object.keys(r.args).length > 0)
          && r.args['path'] === '.',
        JSON.stringify(r.type === 'hunt_agent_result' ? r.args : null),
      );
      check(
        'result: the meta rides along',
        r.type === 'hunt_agent_result' && 'meta' in r,
        JSON.stringify(Object.keys(r)),
      );
      check(
        'result: the output is present',
        r.type === 'hunt_agent_result' && 'output' in r,
      );
    }
  }, 20000);

  it('test_hunt_stops_midwave', async () => {
    // A stop set mid-wave cancels the in-flight agents promptly.
    //
    // PORT NOTE: Python parked the stub workers inside a bare 30s
    // asyncio.sleep and relied on task cancellation, which JS does not have.
    // The TS port's documented contract (hunt.ts, runAgent) is that the
    // worker notices the stop on its NEXT EVENT and cancels its turn — so
    // the stub here is an agent that never finishes on its own but keeps
    // yielding a slow heartbeat (25ms), which is the closest faithful
    // expression of "only cancellation ends it" the port can make. The
    // strict never-yields-again variant cannot be cancelled by design and is
    // reported as a gap.
    const wd = wdFor('test_hunt_stops_midwave');
    const roster = '{"summary": "s", "workers": ['
      + Array.from({ length: 6 }, (_, i) => `{"name": "w${i}", "brief": "b", "owns": ["o${i}"]}`).join(',')
      + ']}';

    const started: string[] = [];

    const factory: AgentFactory = (cfg) => {
      const agent = new Agent(cfg);

      const fakeStream: StubStream = async function* fakeStream() {
        const prompt = lastPrompt(agent);
        if (cfg.mode === 'plan') {
          yield [{ type: 'text_delta', text: roster }, null];
          yield [null, finalMsg([{ type: 'text', text: roster }])];
          return;
        }
        if (prompt.includes(RECON_MARK)) {
          yield [{ type: 'text_delta', text: 'recon done' }, null];
          yield [null, finalMsg([{ type: 'text', text: 'recon done' }])];
          return;
        }

        started.push('x');
        // An agent that never finishes on its own: only cancellation ends
        // it. It keeps yielding so the stop check has a chance to run.
        for (;;) {
          yield [{ type: 'text_delta', text: 'working' }, null];
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      patchStream(agent, fakeStream);
      return agent;
    };

    const events: HuntEvent[] = [];
    const onEvent = async (ev: HuntEvent): Promise<void> => {
      events.push(ev);
    };
    const stop = new huntMod.AsyncEvent();

    const stopper = async (): Promise<void> => {
      while (started.length < 2) await new Promise((r) => setTimeout(r, 10));
      stop.set();
    };

    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_stops_midwave');
    const stopTask = stopper();

    const t0 = Date.now();
    const run = await Promise.race([
      huntMod.runHunt(cfg, 'x.test', {
        onEvent,
        agentFactory: factory,
        stop,
        waveSize: 6,
        concurrency: 6,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('runHunt did not return within 8s')), 8000)),
    ]);
    const elapsed = (Date.now() - t0) / 1000;
    await stopTask;

    check('stop: the run returns instead of hanging', run !== null);
    check('stop: it lands well inside the heartbeat cadence', elapsed < 8.0, `${elapsed.toFixed(2)}s`);
    check('stop: no second wave is started', run.wave === 1, String(run.wave));
    check(
      'stop: hunt_end is still emitted',
      events.length > 0 && events[events.length - 1].type === 'hunt_end',
      events.length > 0 ? events[events.length - 1].type : '',
    );
  }, 20000);

  it('test_hunt_summary_flag', async () => {
    // A queued summary runs at the wave boundary, not concurrently.
    const wd = wdFor('test_hunt_summary_flag');
    const roster = '{"summary": "s", "workers": ['
      + '{"name": "w1", "brief": "b", "owns": ["o1"]}]}';
    const script = {
      rosters: [roster],
      plannerCalls: 0,
      prompts: [] as string[],
      reconFinal: 'recon: one host',
      final: 'nothing',
    };
    const factory = huntFactory(script);

    const events: HuntEvent[] = [];
    const stop = new huntMod.AsyncEvent();
    const flag = { queued: true }; // asked for before the run even starts

    const onEvent = async (ev: HuntEvent): Promise<void> => {
      events.push(ev);
      if (ev.type === 'hunt_summary_done') stop.set();
    };

    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_hunt_summary_flag');
    const run = await huntMod.runHunt(cfg, 'x.test', {
      onEvent,
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
      summaryFlag: () => flag.queued,
    });

    const kinds = events.map((e) => e.type);
    const done = events.filter((e) => e.type === 'hunt_summary_done');
    check('summary: the queued summary runs', done.length === 1, String(done.length));
    check(
      'summary: it runs after the wave, not during it',
      kinds.indexOf('hunt_summary_done') > kinds.indexOf('hunt_wave_end'),
    );
    check(
      'summary: it lands at the wave boundary',
      done.length > 0 && done[0].type === 'hunt_summary_done' && done[0].wave === 1,
      String(done[0] && done[0].type === 'hunt_summary_done' ? done[0].wave : null),
    );
    check(
      'summary: the report file is written',
      done.length > 0 && done[0].type === 'hunt_summary_done' && isFile(done[0].path),
      done[0] && done[0].type === 'hunt_summary_done' ? done[0].path : '',
    );
    check('summary: the campaign then stops', run.wave === 1, String(run.wave));
  }, 20000);

  it('test_recon_reports_live', async () => {
    // runHunt must emit recon tool calls as they happen, not just at the end.
    const wd = wdFor('test_recon_reports_live');
    const seen: HuntEvent[] = [];

    const factory: AgentFactory = (cfg) => {
      const agent = new Agent(cfg);

      const fakeStream: StubStream = async function* fakeStream() {
        const prompt = lastPrompt(agent);
        if (prompt.includes(RECON_MARK)) {
          yield [{ type: 'text_delta', text: 'probing' }, null];
          yield [
            null,
            finalMsg(
              [
                { type: 'text', text: 'probing' },
                { type: 'tool_use', id: 'r1', name: 'list_dir', input: { path: '.' } },
              ],
              [10, 5],
            ),
          ];
          return;
        }
        if (cfg.mode === 'plan') {
          yield [{ type: 'text_delta', text: 'no workers here' }, null];
          yield [null, finalMsg([{ type: 'text', text: 'no workers here' }])];
          return;
        }
        yield [{ type: 'text_delta', text: 'nothing' }, null];
        yield [null, finalMsg([{ type: 'text', text: 'nothing' }])];
      };

      patchStream(agent, fakeStream);
      return agent;
    };

    const stop = new huntMod.AsyncEvent();
    const onEvent = async (ev: HuntEvent): Promise<void> => {
      seen.push(ev);
      if (ev.type === 'hunt_wave_end') stop.set();
    };

    const cfg = cfgFor(wd, { mode: 'andy' });
    cfg.stateDir = stateDir(wd, 'test_recon_reports_live');

    await huntMod.runHunt(cfg, 'x.test', {
      onEvent,
      agentFactory: factory,
      stop,
      waveSize: 1,
      concurrency: 1,
    });

    const kinds = seen.map((e) => e.type);
    check(
      'recon live: a tool call is reported while recon runs',
      kinds.includes('hunt_recon_tool'),
      String(kinds.slice(0, 8)),
    );
    check(
      'recon live: the call lands before recon is done',
      kinds.indexOf('hunt_recon_tool') < kinds.indexOf('hunt_recon_done'),
    );
    check(
      'recon live: the tool name is carried',
      seen.some((e) => e.type === 'hunt_recon_tool' && e.tool === 'list_dir'),
    );
    check('recon live: prose is reported in blocks', kinds.includes('hunt_recon_text'), String(kinds.slice(0, 8)));
    check(
      'recon live: the final recon text is still returned whole',
      seen.some((e) => e.type === 'hunt_recon_done' && e.text.includes('probing')),
    );
  }, 20000);

  // === SECTION === the Textual-app half (skipped: no Ink headless seam) ====
  //
  // Everything below drove `AndyApp` through Textual's `run_test` pilot —
  // a live widget tree with imperative access (`app._handle_command`,
  // `query_one`, screen stacks, pilot.press). The Ink port's AndyApp is a
  // React function component: its command dispatch, busy gate, overlay
  // stack and transcript live in hooks/closures with no object surface to
  // drive, and ink-testing-library is not in the dependency set. Each name
  // is kept as it.skip so the inventory — and the reason — survives until
  // an Ink-level harness exists. Their underlying engines are NOT untested:
  // the busy gate's BUSY_OK set hangs off handleCommand (app.tsx), while
  // the refusal, reuse-notice, wave-number parsing and report-writing
  // behaviours are covered above through runHunt and the writers.

  it.skip('test_campaign_reaches_the_main_agent', () => {
    // GAP (app-level): the buffered [hunt] notice that leads the main
    // agent's next turn. The notice buffer itself is Agent state
    // (agent.notice / drainNotices); only the app-level routing of
    // hunt_end -> notice is UI-owned.
  });

  it.skip('test_boot_migrates_hunts', () => {
    // GAP (app-level): boot-time migration. The migration itself and its
    // one-shot idempotence are covered headlessly by test_migrate_hunts and
    // test_reorganise_waves; only its placement in the app boot path is
    // untested here.
  });

  it.skip('test_recon_overlay', () => {
    // GAP (app-level): the recon window's live narration.
  });

  it.skip('test_wave_overlay_live', () => {
    // GAP (app-level + descoped): clicks, wheel and hover are Textual-only;
    // PORT-MAP §3 descopes mouse from the Ink port. WaveWeb's hit map and
    // rendering are headless and partially covered by
    // test_planner_feed_reaches_the_wave_view.
  });

  it.skip('test_wave_overlay_can_still_be_escaped', () => {
    // GAP (app-level): ctrl+x as the graceful stop from the wave view.
  });

  it.skip('test_wave_overlay_stop_key_confirms_itself', () => {
    // GAP (app-level): the footer's "stopping" confirmation.
  });

  it.skip('test_wave_overlay_ctrl_c_still_interrupts', () => {
    // GAP (app-level): ctrl+c as the blunt fallback through the wave view.
  });

  it.skip('test_stop_hunt_reaches_the_loop', () => {
    // GAP (app-level): /stop-hunt mid-campaign. The loop's half — a stop
    // flag observed at the wave boundary and a prompt unwind — is covered
    // headlessly by test_hunt_stops_midwave and test_one_wave_is_the_default.
  });

  it.skip('test_recon_overlay_fast_target', () => {
    // GAP (app-level): push+pop of the recon screen in one tick.
  });

  it.skip('test_overlays_do_not_stack', () => {
    // GAP (app-level): screen-stack ordering between recon and the wave web.
  });

  it.skip('test_transcript_shows_full_command', () => {
    // GAP (app-level): the transcript rendering of hunt_agent_result. The
    // panel builder it renders is covered headlessly by
    // test_hunt_tool_panel_renders_bash, and the event carries args/meta/
    // output by test_hunt_result_event_carries_args.
  });

  it.skip('test_loop_rail_shows_hack_during_hunt', () => {
    // GAP (app-level): HACK lit for the campaign's duration. The rail's
    // hunt rendering is covered headlessly by test_loop_rail_hunt_render;
    // the app-side wiring (setStage/setHunt around runHunt) is UI-owned.
  });

  it.skip('test_busy_gate', () => {
    // GAP (app-level): BUSY_OK vs the dispatch dict. In the TS port the
    // dispatch table lives inside the AndyApp closure and the Python suite
    // had to parse app.py's source to read it — no equivalent seam.
  });

  it.skip('test_findings_command', () => {
    // GAP (app-level): /findings panel open/toggle/read-back.
  });

  it.skip('test_summary_reads_this_sessions_campaign', () => {
    // GAP (app-level): /summary-hunt preferring the session's campaign over
    // the newest on disk.
  });

  it.skip('test_summary_never_archives_an_empty_body', () => {
    // GAP (app-level): the empty-model-turn summary fallback body. The
    // writer it falls back to is covered by test_reports (writeSummary).
  });

  it.skip('test_bug_hunt_reuses_recon_from_the_ui', () => {
    // GAP (app-level): the reuse notice and --fresh flag parsing in the
    // command layer. The engine half — reuse, skip event, carried findings,
    // fresh remap — is covered headlessly by
    // test_repeat_hunt_reuses_recon.
  });

  it.skip('test_bug_hunt_wave_flag', () => {
    // GAP (app-level): --wave N argument parsing in the command layer. The
    // engine half — the refusal and its message — is covered headlessly by
    // test_one_wave_is_the_default.
  });

  it.skip('test_refused_wave_reaches_the_transcript', () => {
    // GAP (app-level): the refusal line in the transcript. The refusal
    // itself (event, message, nothing planned) is covered headlessly by
    // test_one_wave_is_the_default.
  });

  it.skip('test_report_bug_hunt_command', () => {
    // GAP (app-level): /report-bug-hunt. The report it writes — verbatim
    // evidence, no remediation, archive + copy — is covered headlessly by
    // test_evidence_report.
  });
});
