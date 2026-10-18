/**
 * team.ts — `/team`: fan a task out across parallel agents.
 *
 * What this module is: the /team orchestrator (port of zimzilla/team.py). The
 * main brain reads the task, decides how many workers it needs and what each
 * one owns, runs them concurrently in ownership waves, and hands the results
 * to the caller for synthesis. The shape is a star: workers report to the
 * main brain and never to each other, so their briefs are the only
 * coordination between them. Orchestration only — no Ink, no widgets, no
 * colours; everything is reported as plain event objects through `onEvent`.
 *
 * Invariants (load-bearing and easy to get wrong — Python's docstring names
 * all three and the port keeps them):
 *  1. EACH WORKER GETS ITS OWN CONFIG. Agent's constructor writes its Scope
 *     onto cfg (`cfg.scope`; tools read it back), so sharing one Config
 *     between workers means the last one constructed silently owns the scope
 *     guard for all of them. Workers run on copies that re-load their own
 *     Scope. copyConfig() also drops the inherited `scope` field, mirroring
 *     Python's dataclasses.replace() which never carried `_scope` over.
 *  2. THE MODE IS INHERITED, NEVER CHANGED. /team is not a mode. A worker
 *     built from a danger session runs in danger; the only Config the
 *     orchestrator overrides is the planner's, and only to force read-only.
 *  3. OWNERSHIP IS THE REAL WRITE CONTROL, NOT THE LOCK. The lock serialises
 *     mutating TOOL calls; it cannot see a file written by a bash command,
 *     which is one opaque call to it. Ownership waves are the control for
 *     that — see waves().
 */

import { Agent } from './agent.js';
import { Config } from './config.js';
import { needsPermission } from './tools.js';
import type { ToolHook } from './shared.js';

/** Hard ceiling on the roster, whatever the planner asks for. */
export const TEAM_MAX_AGENTS = 5;

/** How many workers may be in flight at once. Bounds the concurrent load on
 *  the proxy without serialising the run — a five-worker roster still
 *  overlaps. */
export const TEAM_CONCURRENCY = 4;

/** Cap on a single worker's brief, so one over-eager planner entry cannot
 *  blow out the prompt. */
export const MAX_BRIEF_CHARS = 2000;

/** The events runTeam streams to its caller (plain dicts in Python). */
export type TeamEvent = Record<string, unknown> & { type: string };
export type TeamEventSink = (ev: TeamEvent) => void | Promise<void>;

/**
 * Builds an Agent. The test seam (Python passed `Agent` as a default): it is
 * the only place Agents are built, so a test can hand back stubbed ones.
 * The optional second argument carries /team's write-lock hook; callers that
 * ignore it simply run unlocked planners/workers.
 */
export type AgentFactory = (cfg: Config, toolHook?: ToolHook | null) => Agent;

// === SECTION === planner ===

/**
 * The planner's brief. Python exposed PLANNER_PROMPT as a str.format
 * template; the TS port exposes the filled call.
 */
export function plannerPrompt(task: string, maxAgents: number): string {
  return `You are the orchestrator for a team of coding agents. Analyse the task below and
decide whether it should be split across parallel workers.

TASK
----
${task}

You have READ-ONLY tools. Use them to size the work — enough to know which files
and areas are involved — but do not attempt to do the task itself.

Rules:
- Split the task only if it has genuinely independent parts. If it does not, or
  if it is small, return an empty roster — a single agent will handle it.
- Return AT MOST ${maxAgents} workers. Fewer is better; do not pad the roster.
- Each worker gets a short lowercase \`name\` (e.g. "parser-tests") and a \`brief\`
  that is a complete, self-contained instruction — the worker sees the brief and
  nothing else, so it must say what to do and where.
- Each worker gets an \`owns\` list: the paths or globs it may WRITE. These must
  not overlap between workers, because workers run at the same time and two
  of them writing one file loses one set of changes. If two parts of the task must
  touch the same file, they belong in one worker.
- Workers cannot talk to each other. Each brief must stand alone.

Reply with ONE JSON object and nothing else:

{"summary": "one line on how you read the task",
 "workers": [{"name": "short-name",
              "brief": "what this worker should do, in full",
              "owns": ["path/or/glob.py"]}]}

For a task that needs no team: {"summary": "...", "workers": []}
`;
}

/** One worker: what it is called, what it does, what it may write. */
export class WorkerSpec {
  name: string;
  brief: string;
  owns: string[];

  constructor(name: string, brief: string, owns: string[] = []) {
    this.name = name;
    this.brief = brief;
    this.owns = owns;
  }
}

/** The planner's decision. */
export class Roster {
  summary: string;
  workers: WorkerSpec[];

  constructor(summary: string, workers: WorkerSpec[] = []) {
    this.summary = summary;
    this.workers = workers;
  }
}

/** What a worker produced, for the synthesis.
 *
 *  Field-for-field the Python dataclass. (app.tsx's loose WorkerResultLike
 *  also mentions flat `name`/`text` aliases, but its live /team consumer —
 *  ui/screens/campaigns.tsx — reads only `.ok` and hands the results to
 *  synthesisPrompt, so no aliases are carried; they would also collide with
 *  hunt.ts's literal-built results, which have no such members.) */
export class WorkerResult {
  spec: WorkerSpec;
  digest = '';
  ok = true;
  error = '';
  inputTokens = 0;
  outputTokens = 0;
  cost = 0.0;
  touched: string[] = [];

  constructor(spec: WorkerSpec) {
    this.spec = spec;
  }
}

// === SECTION === roster parsing ===

const SLUG_RE = /[^a-z0-9]+/g;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

/** A short, safe worker name. Never empty. */
function slug(name: string): string {
  const s = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 24) || 'worker';
}

/**
 * The first balanced `{...}` span, string-aware.
 *
 * The model often wraps its JSON in prose ("Here is the roster: {...} Hope
 * that helps"), so brace-counting beats a greedy regex — it stops at the
 * object's real end instead of swallowing trailing text. Braces inside string
 * literals are skipped, or a brief containing `{` would unbalance the count.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the planner's reply into a Roster, or null if it cannot be read.
 *
 * Null is a signal, not an error: the caller falls back to running the task
 * as a single turn. A planner that rambles should cost the operator a team,
 * never the task itself.
 */
export function parseRoster(text: string, maxAgents: number = TEAM_MAX_AGENTS): Roster | null {
  if (!text || !text.trim()) return null;

  const candidates: string[] = [];
  for (const m of text.matchAll(FENCE_RE)) candidates.push(m[1]!);
  const obj = firstJsonObject(text);
  if (obj) candidates.push(obj);

  let data: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
      break;
    }
  }
  if (data === null) return null;

  const summary = String(data['summary'] ?? '').trim();

  const raw = data['workers'];
  if (!Array.isArray(raw)) {
    // A roster with no `workers` key is still a valid "no team" answer.
    return new Roster(summary, []);
  }

  const workers: WorkerSpec[] = [];
  const seen = new Set<string>();
  for (const entryRaw of raw) {
    if (typeof entryRaw !== 'object' || entryRaw === null) continue;
    const entry = entryRaw as Record<string, unknown>;
    const brief = String(entry['brief'] ?? '').trim();
    if (!brief) continue; // a worker with no brief cannot be run
    let name = slug(String(entry['name'] ?? ''));
    // De-duplicate: two workers sharing a name would also share a colour
    // and be indistinguishable in the interleaved transcript.
    const base = name;
    let n = 2;
    while (seen.has(name)) {
      name = `${base}-${n}`;
      n += 1;
    }
    seen.add(name);

    const ownsRaw = entry['owns'];
    const owns: string[] = [];
    if (Array.isArray(ownsRaw)) {
      for (const p of ownsRaw) {
        const s = String(p).trim();
        if (s) owns.push(s);
      }
    }

    workers.push(new WorkerSpec(name, brief.slice(0, MAX_BRIEF_CHARS), owns));
    if (workers.length >= maxAgents) break;
  }

  return new Roster(summary, workers);
}

// === SECTION === ownership waves ===

/** Python fnmatch → RegExp (case-sensitive, as fnmatch is on Linux). */
function fnmatchRe(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      out += '[\\s\\S]*';
      i += 1;
    } else if (c === '?') {
      out += '.';
      i += 1;
    } else if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pattern[j] === '!' || pattern[j] === '^') {
        neg = true;
        j += 1;
      }
      let cls = '';
      if (pattern[j] === ']') {
        cls += '\\]';
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== ']') {
        const ch = pattern[j]!;
        cls += /[\\\]^-]/.test(ch) ? '\\' + ch : ch;
        j += 1;
      }
      if (j >= pattern.length) {
        out += '\\['; // unmatched '[' is a literal bracket
        i += 1;
        continue;
      }
      out += neg ? `[^${cls}]` : `[${cls}]`;
      i = j + 1;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Do two ownership lists claim the same path?
 *
 * Literal equality, or a glob on either side matching the other's literal.
 * This cannot see a path neither side declared — see the module docstring.
 */
function ownsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (fnmatchRe(y).test(x) || fnmatchRe(x).test(y)) return true;
    }
  }
  return false;
}

/**
 * Group workers so that no two in one wave claim the same path.
 *
 * The planner is told to give non-overlapping `owns` lists, but a model
 * instruction is not a guarantee. Rather than trust it, workers whose claims
 * collide are placed in a later wave and run after the first finishes. This
 * is the actual protection for writes the lock cannot see — a file written by
 * a bash command, which is a single opaque call from the lock's point of
 * view.
 *
 * Order is preserved: a worker only ever moves later, never earlier.
 */
function waves(workers: WorkerSpec[]): WorkerSpec[][] {
  const out: WorkerSpec[][] = [];
  for (const spec of workers) {
    let placed = false;
    for (const wave of out) {
      if (!wave.some((w) => ownsOverlap(spec.owns, w.owns))) {
        wave.push(spec);
        placed = true;
        break;
      }
    }
    if (!placed) out.push([spec]);
  }
  return out;
}

// === SECTION === running ===

/** acquire() resolves to that acquisition's own release function — double
 *  release is a no-op, so a hook that exits twice cannot unlock a peer. */
class Mutex {
  private locked = false;
  private waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    for (;;) {
      if (!this.locked) {
        this.locked = true;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.locked = false;
          this.waiters.shift()?.();
        };
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

class Semaphore {
  private inFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.waiters.shift()?.();
    }
  }
}

/**
 * A tool hook that serialises mutating tool calls across all workers.
 *
 * Only the tools that need permission mutate anything (bash, write_file,
 * edit_file — tools.GATED_TOOLS); anything else is passed through unguarded
 * so a read never queues behind a writer.
 *
 * What this does NOT cover: a file written by a bash command. bash is one
 * call to this lock, and the shell inside it is invisible. Ownership waves
 * are the control for that; this only stops two workers being *inside* a
 * mutating call at the same instant.
 *
 * (Port note: one hook object is shared by every worker. The single
 * `release` slot is safe because each agent awaits enter → execute → exit
 * sequentially, so at most one unresolved acquisition exists per worker and
 * releases happen strictly before the next waiter's acquire resolves.)
 */
function writeLockHook(lock: Mutex): ToolHook {
  let release: (() => void) | null = null;
  return {
    async enter(name: string): Promise<void> {
      if (!needsPermission(name)) return;
      release = await lock.acquire();
    },
    async exit(): Promise<void> {
      release?.();
      release = null;
    },
  };
}

function touchedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'edit_file') {
    const p = String(args['path'] ?? '').trim();
    return p ? [p] : [];
  }
  return [];
}

/** dataclasses.replace(cfg): a fresh Config with the same own fields. The
 *  live `scope` instance is deliberately dropped — Python's replace() never
 *  carried the dynamically-attached `_scope`, and each Agent must re-load
 *  its own. */
function copyConfig(cfg: Config, overrides?: Partial<Config>): Config {
  const copy = new Config();
  Object.assign(copy, cfg, overrides);
  copy.scope = undefined;
  return copy;
}

async function runWorker(
  spec: WorkerSpec,
  index: number,
  cfg: Config,
  opts: {
    onEvent: TeamEventSink;
    agentFactory: AgentFactory;
    toolHook: ToolHook;
  },
): Promise<WorkerResult> {
  /** Run one worker to completion. Never throws (Python's only re-raise was
   *  asyncio.CancelledError, which has no counterpart here — nothing in a
   *  Promise-based run cancels mid-flight). */
  const result = new WorkerResult(spec);

  // Its own Config copy: its own Scope, its own cfg.scope. The mode, model,
  // workdir and scope paths are inherited unchanged — /team is not a mode.
  const workerCfg = copyConfig(cfg);
  const worker = opts.agentFactory(workerCfg, opts.toolHook);

  await opts.onEvent({
    type: 'team_start',
    name: spec.name,
    index,
    brief: spec.brief,
  });

  const buf: string[] = [];

  const flush = async (): Promise<void> => {
    const text = buf.join('').trim();
    buf.length = 0;
    if (text) {
      await opts.onEvent({ type: 'team_text', name: spec.name, text });
    }
  };

  try {
    for await (const ev of worker.runTurn(spec.brief)) {
      switch (ev.type) {
        case 'text_delta':
          buf.push(ev.text);
          break;
        case 'tool_call':
          // Flush before the call so the worker's reasoning lands above
          // the call it explains, not after it.
          await flush();
          await opts.onEvent({
            type: 'team_tool',
            name: spec.name,
            tool: ev.name,
            args: ev.args ?? {},
          });
          break;
        case 'tool_result':
          result.touched.push(...touchedPaths(ev.name, ev.args ?? {}));
          await opts.onEvent({
            type: 'team_result',
            name: spec.name,
            tool: ev.name,
            ok: !ev.isError,
            output: ev.output,
          });
          break;
        case 'blocked':
          await opts.onEvent({
            type: 'team_result',
            name: spec.name,
            tool: ev.name,
            ok: false,
            output: ev.targets,
          });
          break;
        case 'usage':
          result.inputTokens += ev.input || 0;
          result.outputTokens += ev.output || 0;
          result.cost += ev.cost || 0.0;
          break;
        case 'error':
          result.ok = false;
          result.error = ev.message || 'error';
          await flush();
          break;
        default:
          break;
        // "thinking", "retry" and "turn_end" carry nothing a worker-level
        // transcript needs; the worker's own accounting is taken from the
        // usage events above.
      }
    }
    await flush();
  } catch (e) {
    result.ok = false;
    result.error = `${e instanceof Error ? e.constructor.name : typeof e}: ${
      e instanceof Error ? e.message : String(e)
    }`;
    await flush();
  }

  result.digest = digest(worker, result);
  return result;
}

/**
 * The worker's final text, for the synthesis prompt.
 *
 * Read back off the worker's own history rather than accumulated here: the
 * history is what the worker actually said, and it is already in the right
 * order. Falls back to a marker when the worker produced no text at all.
 */
function digest(worker: Agent, result: WorkerResult): string {
  for (let i = worker.messages.length - 1; i >= 0; i--) {
    const msg = worker.messages[i]!;
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    const parts: string[] = [];
    for (const b of msg.content) {
      if (typeof b === 'object' && b !== null && b.type === 'text' && b.text) {
        parts.push(b.text);
      }
    }
    const text = parts.filter((p) => p.length > 0).join('\n').trim();
    if (text) return text;
  }
  if (!result.ok) return `(worker failed: ${result.error})`;
  return '(worker produced no text)';
}

export interface RunTeamOpts {
  onEvent: TeamEventSink;
  agentFactory?: AgentFactory;
  maxAgents?: number;
  concurrency?: number;
}

/**
 * Plan, launch, and collect. Returns the worker results.
 *
 * Emits every step through `onEvent` as it happens. The caller owns the
 * synthesis — this returns the results it needs for it.
 *
 * `agentFactory` is the test seam: it is the only place Agents are built, so
 * a test can hand back stubbed ones. Patching a class attribute would not
 * work, because each worker has its own instance.
 */
export async function runTeam(
  cfg: Config,
  task: string,
  opts: RunTeamOpts,
): Promise<WorkerResult[]> {
  const agentFactory: AgentFactory =
    opts.agentFactory ?? ((c, toolHook) => new Agent(c, null, toolHook ?? null));
  const maxAgents = opts.maxAgents ?? TEAM_MAX_AGENTS;

  // ---- plan. Read-only, so planning cannot start doing the work itself
  // when the session is in zim or danger mode.
  const planCfg = copyConfig(cfg, { mode: 'plan' });
  const planner = agentFactory(planCfg);
  const planText = await collectText(planner, plannerPrompt(task, maxAgents));

  const roster = parseRoster(planText, maxAgents);

  await opts.onEvent({
    type: 'team_plan',
    summary: roster ? roster.summary : '',
    workers: roster
      ? roster.workers.map((w) => ({ name: w.name, brief: w.brief, owns: [...w.owns] }))
      : [],
    parsed: roster !== null,
  });

  if (roster === null || roster.workers.length === 0) return [];

  // ---- launch, in waves, so no two concurrent workers claim one path.
  const lock = new Mutex();
  const hook = writeLockHook(lock);
  const sem = new Semaphore(Math.max(1, opts.concurrency ?? TEAM_CONCURRENCY));

  const results: WorkerResult[] = [];
  const total = roster.workers.length;
  let index = 0;

  const one = async (spec: WorkerSpec, i: number): Promise<WorkerResult> =>
    sem.run(() =>
      runWorker(spec, i, cfg, { onEvent: opts.onEvent, agentFactory, toolHook: hook }),
    );

  for (const wave of waves(roster.workers)) {
    const waveResults = await Promise.all(wave.map((spec, offset) => one(spec, index + offset)));
    for (const r of waveResults) {
      results.push(r);
      await opts.onEvent({
        type: 'team_done',
        name: r.spec.name,
        ok: r.ok,
        cost: r.cost,
        error: r.error,
        input: r.inputTokens,
        output: r.outputTokens,
      });
    }
    index += wave.length;
  }

  await opts.onEvent({
    type: 'team_end',
    workers: total,
    ok: results.filter((r) => r.ok).length,
    cost: results.reduce((sum, r) => sum + r.cost, 0),
    input: results.reduce((sum, r) => sum + r.inputTokens, 0),
    output: results.reduce((sum, r) => sum + r.outputTokens, 0),
  });
  return results;
}

/** Run one turn and return only its text, discarding the tool chatter. */
async function collectText(agent: Agent, prompt: string): Promise<string> {
  const parts: string[] = [];
  for await (const ev of agent.runTurn(prompt)) {
    if (ev.type === 'text_delta') parts.push(ev.text);
  }
  return parts.join('');
}

/** The main brain's closing brief: fold the workers' work into one answer. */
export function synthesisPrompt(task: string, results: WorkerResult[]): string {
  const blocks: string[] = [];
  for (const r of results) {
    const status = r.ok ? 'OK' : `FAILED (${r.error})`;
    const owns = r.spec.owns.length ? r.spec.owns.join(', ') : '(no declared files)';
    blocks.push(
      `### ${r.spec.name} — ${status}\n` +
        `brief: ${r.spec.brief}\n` +
        `declared files: ${owns}\n\n` +
        `${r.digest}`,
    );
  }
  const body = blocks.length ? blocks.join('\n\n') : '(no worker produced anything)';

  return (
    `A team of ${results.length} agents worked on this task in parallel:\n\n` +
    `TASK\n${task}\n\n` +
    `THEIR REPORTS\n${body}\n\n` +
    'Write the single answer the operator asked for. Combine what the ' +
    'workers found into one coherent response — do not simply concatenate ' +
    'their reports, and do not list them by name unless a name is ' +
    'load-bearing. If workers disagree, say so and say which you believe. ' +
    'If a worker failed, note it only if it leaves a gap in the answer.'
  );
}
