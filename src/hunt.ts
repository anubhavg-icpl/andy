/**
 * hunt.ts — `/bug-hunt`: an autonomous, self-iterating hunt campaign.
 *
 * Contract: orchestration and nothing else — no Ink, no widgets, no colours.
 * Everything is reported as plain HuntEvent objects through an async `onEvent`
 * sink, so the whole campaign is testable without a terminal. One wave per
 * invocation (bounded by `maxWaves`, default 1); the stop signal races the wave
 * so `/stop-hunt` cancels the agents rather than waiting out the slowest one.
 * Ported 1:1 from zimzilla/hunt.py: same behaviour, same event payloads
 * (camelCase keys), same on-disk campaign layout under `$ANDY_HOME/hunts/`.
 *
 * Section map (one of the largest modules — jump, don't scroll):
 *   1. Tunables & severity table        7. Campaign directories & wave layout
 *   2. Prompts                          8. On-disk migration (legacy layouts)
 *   3. Fallback vectors                 9. Artefact writers (recon/plan/report)
 *   4. Campaign kinds                  10. Evidence & closing reports
 *   5. Findings / records / run state  11. Async primitives (private)
 *   6. Parsing helpers                 12. Running (agents, waves, the loop)
 *                                     13. Recovery (findRecon / loadRun)
 */

import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import type { Config } from './config.js';
import { parseRoster } from './team.js';
import type { Roster, WorkerResult, WorkerSpec } from './team.js';
import { needsPermission } from './tools.js';
import type { AgentEvent, ContentBlock, ToolHook } from './shared.js';

/*
 * `/bug-hunt` — ported doctrine summary (from the Python module docstring):
 *
 * AGENTS.md arms a doctrine but ships no methodology: it says *you are an
 * autonomous pentest operator*, not *here is how to run an engagement*. So a
 * session improvises one pass and stops. `/bug-hunt` supplies the missing
 * loop: recon -> plan a wave -> run the wave -> harvest findings -> replan.
 *
 * One wave per invocation. The loop is bounded (`maxWaves`, default 1), so
 * `/bug-hunt host` runs the next wave and stops; `/bug-hunt host --wave 3`
 * runs wave 3. The operator decides whether there is a next wave, which is
 * the whole point: a campaign that plans wave 2 straight after wave 1 found a
 * critical is spending tokens on work nobody asked for and nobody can
 * decline. `/stop-hunt` still lands mid-wave — the wave races the `stop`
 * signal, so stopping cancels the agents rather than waiting out the slowest
 * one.
 *
 * The shape is deliberately `/team`'s: a read-only planner reads what is
 * known, emits a JSON roster of independent briefs, the briefs run
 * concurrently, and the results come back as structured text. What is
 * different:
 *
 * - The planner sees the findings so far. WAVE_PLANNER_PROMPT carries every
 *   finding from every earlier wave, so wave N+1 is aimed at what wave N did
 *   not cover rather than re-running the same ten probes. That feedback edge
 *   is the whole point of the command.
 * - The campaign directory is the scope's, and its waves are directories. A
 *   wave's plan and its findings land together in `<campaign>/wave-<n>/`, so
 *   the tree says what each wave aimed at and what it found without anyone
 *   reading frontmatter. Recon sits at the top level, one file per recon.
 * - Workers are told to report in JSON. Every brief ends with the same
 *   finding contract, and parseFindings reads it back off the worker's final
 *   text. That is what makes a wave's output machine-readable enough to feed
 *   the next planner.
 *
 * The workers inherit the session's mode, so under `/mode zim` they run the
 * operator's AGENTS.md doctrine with every tool armed. The wave planner does
 * not: it is forced to `plan` mode, because a planner with bash will start
 * doing the work itself instead of deciding who should.
 */

// === SECTION === 1. Tunables & severity table

/** Briefs per wave. All of them run at once — see HUNT_CONCURRENCY. */
export const HUNT_WAVE_SIZE = 10;

/**
 * Workers in flight at any instant. Equal to the wave size by design: the
 * operator asked for all ten to run simultaneously.
 */
export const HUNT_CONCURRENCY = 10;

/**
 * How long a turn's event stream may go quiet before the prose produced so
 * far is flushed to the UI anyway. The planner's turn runs for tens of
 * seconds over the whole recon before it writes a word of roster, and the
 * wave view has nothing else to draw for that whole time — so a buffer that
 * only empties on a tool call leaves the operator staring at an empty
 * screen. Short enough to feel live, long enough that a streaming model is
 * not flushed mid-sentence on every token.
 */
export const STREAM_IDLE_SECONDS = 0.4;

/**
 * Severity spellings a model reaches for, mapped onto the four we accept.
 * (Python `_SEVERITY_ALIASES` — the five we accept is VALID_SEVERITIES.)
 */
const SEVERITY_ALIASES: Record<string, string> = {
  crit: 'critical',
  severe: 'critical',
  moderate: 'medium',
  med: 'medium',
  low: 'low',
  info: 'info',
  informational: 'info',
  note: 'info',
  none: 'info',
};

export const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** Ordered worst-first, so a wave's findings can be sorted for display. */
export const SEVERITY_ORDER: Record<string, number> = Object.fromEntries(
  VALID_SEVERITIES.map((s, i) => [s, i]),
);

const SLUG_RE = /[^a-zA-Z0-9._-]+/g;

// === SECTION === 2. Prompts

// ---------------------------------------------------------------------------
// The finding contract
// ---------------------------------------------------------------------------
// Appended to every brief and every planner prompt. One contract, stated
// once, so a worker cannot invent its own report shape and the parser has
// exactly one thing to read.

export const FINDING_CONTRACT = `\
REPORTING
---------
Report each confirmed vulnerability TWICE, and the first time is the one that
matters:

1. THE MOMENT YOU CONFIRM IT — call the \`report_finding\` tool. Do this as soon
   as you have the evidence in hand, in the same turn you got it, before you go
   on to the next thing. This is a live engagement: the operator is watching a
   tracker that fills in as you work, and a finding reported here appears on it
   within a second. A finding you sit on until the end of your turn is a finding
   the operator spends that whole time not knowing about.

   Report a bug you confirm even if you have not finished exploiting it — an
   error that proves injection, a response that proves missing access control, a
   banner that proves an old vulnerable version. Evidence of the weakness is
   what counts, not a finished exploit.

2. AGAIN IN YOUR FINAL MESSAGE — end it with ONE JSON object on its own lines,
   wrapped in a \`\`\`json fence:

\`\`\`json
{"findings": [{"title": "short name for the bug",
               "severity": "critical|high|medium|low|info",
               "asset": "the host, URL or path affected",
               "summary": "what the bug is, in two or three sentences",
               "evidence": "the exact request, output or file:line that proves it",
               "remediation": "how to fix it"}]}
\`\`\`

Rules for both:
- One entry per distinct bug, and the same bug is the same bug in both places.
  The two are reconciled by title and asset, so repeating yourself costs
  nothing; reporting the same bug under two different names inflates the count.
- If you found nothing, call no tool and omit the block entirely (or send
  \`{"findings": []}\`) — do not invent a finding to fill either one.
- \`severity\` must be one of the five words above. Judge it honestly: a
  theoretical weakness with no demonstrated impact is \`low\`, not \`critical\`.
- \`evidence\` must be something you actually observed, not something you expect.
  A finding with no evidence is a guess and will be discarded. \`report_finding\`
  refuses a report with no evidence, which is deliberate.
- Put nothing after the final JSON block. Anything you want to say, say before it.
`;

export const RECON_PROMPT = `\
You are opening a security engagement against a declared, authorised target.

TARGET: {target}

This is the RECON phase. Map the target before anyone attacks it. Do not attempt
exploitation here — that is the next phase, and a recon run that stops early to
try a payload has failed at its actual job.

Work with the tools you have. Establish, as far as you can:

- Reachability: does it answer, on which schemes and ports, behind what?
- Surface: what hosts, paths, endpoints, parameters and API roots are exposed?
- Technology: server, framework, language, CDN, auth scheme, from headers,
  cookies, error pages, robots.txt, well-known paths and asset naming.
- Entry points: forms, upload endpoints, login flows, redirect parameters,
  anything that takes input.
- Hypotheses: the specific classes of bug this stack plausibly has, and which
  asset each would live on.
- Tooling: which offensive tools are actually present on THIS host, and whether
  a wordlist is available. Check for at least: nmap, ffuf, gobuster,
  feroxbuster, nikto, sqlmap, nuclei, whatweb, wafw00f, testssl.sh, sslyze,
  curl, dig, host, nslookup, openssl. Also check the usual wordlist roots
  (/usr/share/wordlists, /usr/share/seclists/Discovery/Web-Content). One
  \`which\` over the whole list, then \`ls\` on the wordlist roots — this is worth
  a turn, because a brief that sends an agent after a binary that is not
  installed wastes the agent entirely, and ten agents each re-checking for
  themselves wastes the wave.

Be concrete. A hypothesis that names a host and a parameter is worth ten that
name a category. If the target does not answer at all, say so plainly and report
what you tried — that is a real result, not a failure.

Finish with a short written brief: what the target is, what you could reach,
what you could not, and your ranked hypotheses for where the bugs are.

{contract}
`;

// NOTE: the JSON example below keeps SINGLE braces. The Python original wrote
// doubled `{{…}}` because it went through str.format(); here fmt() replaces
// only the named `{placeholders}`, so the example is stored post-format.
export const WAVE_PLANNER_PROMPT = `\
You are directing a security engagement against a declared, authorised target.
Your job is to decide what the NEXT wave of {wave_size} agents should each do.

TARGET: {target}

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
agent on it — enough to know the asset is real and the brief is not a guess —
but do not attempt the work itself. That is what the agents are for.

Rules:
- Return AT MOST {wave_size} workers. Fewer is better than padding.
- Every brief must be INDEPENDENT: no agent may depend on another's output,
  because they all run at the same time and cannot talk to each other.
- Do not repeat work already done. Read the findings and the wave history and
  aim at what is still open. If an earlier finding suggests a follow-up — a
  different endpoint of the same service, a second parameter, a bypass of the
  same control — that is the highest-value brief you can write.
- If an earlier finding was marked low-confidence or a worker failed, a brief
  that re-tests it properly is worth a slot.
- Spread the wave across different bug classes. Ten briefs that all test
  injection waste nine slots. The classes worth covering, roughly in order of
  how often they pay: broken access control, authentication and session flaws,
  injection, business-logic abuse, sensitive-data exposure, misconfiguration,
  input validation, race conditions, crypto and transport, and the dependency
  and supply chain.
- Each worker gets a short lowercase \`name\` (e.g. "auth-bypass") and a \`brief\`
  that is a complete, self-contained instruction. The worker sees the brief and
  nothing else — it must say what to test, on which asset, and how to prove it.
- \`owns\` is the asset, endpoint or vector that brief is responsible for. Two
  workers must not claim the same one; the wave is deduplicated on this.

Reply with ONE JSON object and nothing else:

{"summary": "one line on how you are reading the target now",
 "workers": [{"name": "short-name",
              "brief": "the full instruction for this agent",
              "owns": ["the asset or vector it owns"]}]}

{contract}
`;

/**
 * Inserted into the planner prompt when the recon above was inherited from an
 * earlier campaign rather than run now. The planner has read-only tools and
 * is told to check a hypothesis before briefing an agent on it, so the
 * honest move is to say the map may be out of date and let it re-verify what
 * it is about to build on — a target that has moved under a stale map sends
 * a whole wave at assets that no longer exist.
 */
export const RECON_INHERITED_NOTE = `\

NOTE: the mapping above was NOT taken now. It is the recon recorded for this
scope by an earlier campaign, {age_days} day(s) ago. Treat it as a starting
point, not as ground truth: before you brief an agent on an asset, check that
the asset is still there and still answers. The surface may have changed.
`;

/**
 * Appended to the planner prompt for one retry, after a reply that could not
 * be parsed. Deliberately blunt: the failure mode is almost always a model
 * that wrapped its JSON in prose or a fence, and saying so plainly fixes it.
 */
export const PLANNER_RETRY_NUDGE = `\
Your previous reply could not be read as JSON. Reply with ONE JSON object and
nothing else — no prose before it, no prose after it, no code fence around it.
Start your reply with \`{\` and end it with \`}\`.
`;

export const SUMMARY_PROMPT = `\
An engagement against a target has been running as a sequence of waves of
parallel agents. Write the closing report.

TARGET: {target}
WAVES RUN: {waves}

RECON
-----
{recon}

EVERY FINDING, IN THE ORDER THEY WERE CONFIRMED
-----------------------------------------------
{findings}

Write the report the operator will actually read. It must cover, in this order:

1. **What was tested** — the ground covered, wave by wave, in plain language.
   Not a list of agent names; a description of the attack surface that was
   actually exercised.
2. **What was found** — each confirmed finding, worst first, with its severity
   and the evidence that proves it. Be precise about impact. If something was
   reported by an agent but the evidence does not hold up, say so and say why.
3. **What is worth checking next** — the specific, still-open leads, each
   concrete enough that someone could pick it up and run with it.
4. **What is not worth the time** — the avenues that were checked and are clean,
   or that look promising but are dead ends. This section matters as much as
   the third: it is what stops the next person repeating this engagement.

Be honest about coverage. If a whole class of bug was never tested, say so
rather than letting silence read as "clean". Do not pad. If the engagement found
nothing real, the report says that and explains what was ruled out.
`;

// === SECTION === 3. Fallback vectors

// ---------------------------------------------------------------------------
// Used when the planner's reply cannot be read. A model that rambles should
// cost the wave its shape, never the wave itself — so the campaign keeps
// running on a fixed matrix rather than stopping to wait for a human.

export type HuntVector = readonly [name: string, brief: string, owns: string];

export const HUNT_VECTORS: readonly HuntVector[] = [
  [
    'access-control',
    'Broken access control. Enumerate every endpoint and object reference you '
      + 'can reach and test whether an unauthenticated or lower-privileged '
      + 'request can reach it: IDOR on object ids, forced browsing to admin '
      + 'paths, HTTP method tampering, missing function-level checks. Prove each '
      + 'with the exact request and response.',
    'access control',
  ],
  [
    'auth-session',
    'Authentication and session handling. Probe login for user enumeration, '
      + 'credential stuffing resistance, lockout, password-reset flow flaws and '
      + 'token predictability. Inspect session cookies for missing HttpOnly / '
      + 'Secure / SameSite, weak entropy, and whether logout actually invalidates '
      + 'the session server-side.',
    'authentication',
  ],
  [
    'injection',
    'Injection. Test every input you found — query parameters, form fields, '
      + 'headers, cookies, JSON bodies — for SQL, NoSQL, command, template and '
      + 'LDAP injection. Use safe, non-destructive probes first and escalate only '
      + 'on a positive signal. Report the payload and the evidence of execution.',
    'injection',
  ],
  [
    'business-logic',
    'Business logic. Walk the application\'s real workflows and look for ways '
      + 'to abuse them: skipping steps, replaying a one-time action, negative or '
      + 'overflowing quantities, price or role tampering in a request body, '
      + 'self-approval, and race windows in anything that should happen once.',
    'business logic',
  ],
  [
    'data-exposure',
    'Sensitive data exposure. Look for secrets and personal data where they '
      + 'should not be: verbose errors and stack traces, debug endpoints, source '
      + 'maps, .git and backup files, directory listings, API responses that '
      + 'return more fields than the UI shows, and credentials in client-side '
      + 'bundles.',
    'data exposure',
  ],
  [
    'misconfiguration',
    'Security misconfiguration. Check TLS and certificate validity, security '
      + 'headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options), CORS '
      + 'policy including credentialed origins, default credentials on any '
      + 'admin surface, exposed management or metrics ports, and permissive '
      + 'file-upload handling.',
    'misconfiguration',
  ],
  [
    'input-validation',
    'Input validation and client-side trust. Test for reflected and stored '
      + 'XSS, HTML injection, open redirects, SSRF via any URL-shaped parameter, '
      + 'path traversal in file parameters, XXE in any XML endpoint, and '
      + 'deserialization of attacker-controlled data.',
    'input validation',
  ],
  [
    'race-conditions',
    'Race conditions and state. Find operations that should be atomic — '
      + 'coupon redemption, transfers, invites, rate limits, vote or like '
      + 'counters — and fire them concurrently to test for double-spend, limit '
      + 'bypass and inconsistent state. Report the timing evidence, not just the '
      + 'outcome.',
    'race conditions',
  ],
  [
    'crypto-transport',
    'Cryptography and transport. Assess the TLS configuration and cipher '
      + 'suites, check for mixed content and downgrade paths, examine how tokens '
      + 'and password hashes are constructed and whether they are reversible, '
      + 'and look for predictable randomness in anything security-relevant.',
    'crypto',
  ],
  [
    'dependencies',
    'Dependency and supply chain. Fingerprint the components the target '
      + 'serves or references — JS libraries, frameworks, server banners, '
      + 'package manifests if reachable — and identify versions with known '
      + 'vulnerabilities. Confirm exploitability against this deployment rather '
      + 'than reporting a bare version match.',
    'dependencies',
  ],
];

// === SECTION === 4. Campaign kinds

// ---------------------------------------------------------------------------
// Everything about an engagement that is NOT the engine: the prompts, the
// fallback vectors, the directory prefix, and the interlock that guards the
// tools. runHunt below is the loop — recon, plan, run, harvest, report — and
// it is identical for every kind. `/ad` is a second *doctrine*, not a second
// engine, so it is expressed as one of these rather than as a fork of the
// loop.
//
// The defaults reproduce today's `/bug-hunt` exactly: HUNT_KIND carries the
// module constants verbatim, so a caller that passes no kind gets
// byte-identical prompts and the same campaign directory it has always had.
// That equivalence is asserted in the test suite rather than assumed, because
// it is the property that makes the whole refactor safe.

/**
 * One doctrine the campaign engine can run (Python dataclass CampaignKind).
 *
 * An interface rather than a class: ad.ts builds its own object literal with
 * per-campaign interlock state, and a literal satisfies the same contract a
 * constructed instance would.
 */
export interface CampaignKind {
  /** Short name, written into each plan's frontmatter so a campaign read
   *  back off disk knows which doctrine produced it. */
  readonly name: string;
  /** The slash command that starts this doctrine, without the leading slash.
   *  Used wherever a message has to tell the operator what to run — a refusal
   *  that says `/bug-hunt corp.local` over an AD campaign sends them to the
   *  wrong command, and the wrong command here means a *different campaign
   *  directory*, so they would find an empty scope and conclude the run was
   *  lost. */
  readonly command: string;
  /** Prepended to the scope slug when naming the campaign directory. Empty
   *  for `/bug-hunt`, so its directories are unchanged; `ad-` for AD, so an
   *  AD campaign on `corp.local` and a web hunt on `corp.local` cannot
   *  collide. */
  readonly dirPrefix: string;
  readonly reconPrompt: string;
  readonly plannerPrompt: string;
  readonly contract: string;
  readonly summaryPrompt: string;
  /** Fallback roster vectors. Empty means use HUNT_VECTORS. */
  readonly vectors: readonly HuntVector[];
  /** A tool hook run immediately before every tool call, alongside the write
   *  lock. This is where `/ad` installs its throttle and circuit breaker.
   *  Null for every existing caller, which is what makes the seam free. */
  readonly interlock: ToolHook | null;
}

/** The default kind: `/bug-hunt`, exactly as it shipped. */
export const HUNT_KIND: CampaignKind = {
  name: 'hunt',
  command: 'bug-hunt',
  dirPrefix: '',
  reconPrompt: RECON_PROMPT,
  plannerPrompt: WAVE_PLANNER_PROMPT,
  contract: FINDING_CONTRACT,
  summaryPrompt: SUMMARY_PROMPT,
  vectors: [],
  interlock: null,
};

/** A fixed matrix roster, used when the planner's reply cannot be read. */
export function fallbackRoster(
  wave: number,
  waveSize: number = HUNT_WAVE_SIZE,
  kind: CampaignKind | null = null,
): Roster {
  const vectors = kind !== null && kind.vectors.length > 0 ? kind.vectors : HUNT_VECTORS;
  const workers = vectors.slice(0, waveSize).map(
    (v) => makeWorkerSpec(v[0], v[1], [v[2]]),
  );
  return makeRoster(
    `planner reply unreadable — falling back to the fixed vector matrix for wave ${wave}`,
    workers,
  );
}

// === SECTION === 5. Findings / records / run state

/**
 * How much of the recon report is prepended to every worker brief. Generous,
 * because the alternative is ten agents re-reading the same files to find it.
 */
export const BRIEF_CONTEXT_CHARS = 6000;

/**
 * The shared briefing prepended to every worker's brief.
 *
 * A worker used to see only its own brief, so all ten would open with the same
 * `pwd && ls -la` and the same re-read of every recon file — a whole wave
 * spending its first turns rediscovering what recon already knew. This hands
 * each of them the same picture up front and says, plainly, not to go looking
 * for it again.
 *
 * Trimmed from the *end*: a recon report leads with reachability and surface
 * and trails into hypotheses, so the head is the part that saves the most
 * work. The full text still reaches the planner and the closing summary,
 * which see `run.recon` directly.
 */
export function briefContext(run: HuntRun, limit: number = BRIEF_CONTEXT_CHARS): string {
  let recon = (run.recon || '').trim();
  if (!recon) return '';
  if (recon.length > limit) {
    recon = `${recon.slice(0, limit).replace(/\s+$/, '')}\n…(recon report truncated here)`;
  }
  return (
    'WHAT IS ALREADY KNOWN\n'
    + '---------------------\n'
    + 'Recon has already mapped this target. The findings below are '
    + 'established fact — do not spend a turn re-deriving any of it. In '
    + 'particular, do not re-run `ls`, `pwd`, or re-read the same recon '
    + 'files: that ground is covered, and the wave is timed.\n\n'
    + `${recon}\n\n`
    + 'If the recon report names the tooling available on this host, treat '
    + 'that as the tooling you have. Do not probe for binaries it says are '
    + 'absent.\n'
    + '---------------------'
  );
}

/** One confirmed bug, as the worker reported it. */
export class Finding {
  wave: number;
  agent: string;
  title: string;
  severity: string;
  asset: string;
  summary: string;
  evidence: string;
  remediation: string;
  /**
   * True for a finding earlier work confirmed and this run loaded to seed its
   * tracker — a prior campaign's, or a prior wave's. Carried findings are
   * shown and fed to the planner, but they are not this run's work: the
   * closing counts exclude them and the digest marks them. Kept as a field
   * rather than inferred from `wave`, because a carried finding keeps the
   * wave number it was found in, which collides with this run's own waves.
   */
  carried: boolean;

  constructor(init: {
    wave: number;
    agent: string;
    title: string;
    severity: string;
    asset?: string;
    summary?: string;
    evidence?: string;
    remediation?: string;
    carried?: boolean;
  }) {
    this.wave = init.wave;
    this.agent = init.agent;
    this.title = init.title;
    this.severity = init.severity;
    this.asset = init.asset ?? '';
    this.summary = init.summary ?? '';
    this.evidence = init.evidence ?? '';
    this.remediation = init.remediation ?? '';
    this.carried = init.carried ?? false;
  }

  /**
   * Whether this earns a report file.
   *
   * Always true. This used to gate on SAVE_SEVERITIES — critical, high and
   * medium earned an artefact and low/info did not — but a low finding that
   * never reached disk died with the process, and the operator's own
   * `/report-bug-hunt` cannot cite evidence that was never written down. The
   * severity is in the file's name and its frontmatter, so filtering the
   * quiet ones is a read-time decision now rather than a write-time one.
   *
   * Kept as a getter rather than dropped, because it is the seam a threshold
   * would go back into, and `save` and the hunt_end event read it.
   */
  get saved(): boolean {
    return true;
  }
}

/**
 * What one wave was, as its plan recorded it.
 *
 * Read back from `wave-<n>/plan.md` by `loadRun`. `HuntRun.waves` is the
 * one-line-per-wave history the planner reads and the summary quotes; this is
 * the structured form behind it, so the wave view and the evidence report can
 * say what a wave aimed at without re-parsing a string.
 */
export class WaveRecord {
  number: number;
  agents: number;
  fellBack: boolean;
  summary: string;
  stamp: string;

  constructor(init: {
    number: number;
    agents?: number;
    fellBack?: boolean;
    summary?: string;
    stamp?: string;
  }) {
    this.number = init.number;
    this.agents = init.agents ?? 0;
    this.fellBack = init.fellBack ?? false;
    this.summary = init.summary ?? '';
    this.stamp = init.stamp ?? '';
  }

  /** The one-line digest, in the shape HuntRun.waves has always used. */
  line(found: number = 0): string {
    return (
      `wave ${this.number}: ${this.agents} agents, `
      + `${found} finding(s)`
      + (this.fellBack ? ' (fixed vector fallback)' : '')
    );
  }
}

/**
 * The state of one campaign, handed to the summary and the UI.
 *
 * Paths are plain strings (PORT-MAP convention); `started` is epoch seconds
 * like Python's time.time().
 */
export class HuntRun {
  target: string;
  directory: string;
  /** Set by `/stop-hunt`; the wave races it rather than polling between waves. */
  stop: AsyncEvent = new AsyncEvent();
  wave: number = 0;
  /**
   * Which doctrine produced this campaign — "hunt" or "ad". Read back from
   * the plan frontmatter by `loadRun`, and defaulted to "hunt" for every
   * campaign written before the field existed, which is all of them.
   */
  kind: string = 'hunt';
  recon: string = '';
  findings: Finding[] = [];
  waves: string[] = [];
  /**
   * What each wave was, read back from its plan. Populated by `loadRun`; a
   * live run fills `waves` as it goes and leaves this empty until the
   * campaign is reloaded, because the report is built from an archived run.
   */
  waveRecords: WaveRecord[] = [];
  started: number = Date.now() / 1000;
  /**
   * Where `recon` came from when a repeat hunt reused notes already on disk,
   * and how old they were in seconds. Both null when this campaign ran its
   * own recon — which is what lets the UI tell the two apart and say so
   * rather than presenting an inherited map as a fresh one.
   */
  reconSource: string | null = null;
  reconAge: number | null = null;
  /**
   * How many findings were already on disk when this campaign opened. The
   * tracker is seeded with them, so the campaign's own tally is
   * `findings.length - reconCarried` and its counts stay honest.
   */
  reconCarried: number = 0;

  constructor(target: string, directory: string, init: Partial<HuntRun> = {}) {
    this.target = target;
    this.directory = directory;
    Object.assign(this, init);
  }

  /** Whether this campaign inherited its recon rather than mapping. */
  get reusedRecon(): boolean {
    return this.reconSource !== null;
  }

  /**
   * Every finding so far, as the next planner sees it.
   *
   * Deliberately terse: the planner needs to know what is closed so it can
   * aim elsewhere, not to re-read the evidence. The full text lives in the
   * report files.
   *
   * Findings carried in from earlier work are marked as such, so a planner
   * does not read a bug confirmed weeks ago as one this campaign just closed
   * — the distinction decides whether a brief that re-tests it is redundant
   * or overdue. The label says "earlier wave" rather than "earlier campaign"
   * because the campaign is now the scope's whole history: a second
   * `/bug-hunt` runs one wave on top of the waves already there, so what a
   * wave inherits may be from last week's campaign or from yesterday's wave,
   * and to the planner those are the same thing.
   */
  digest(): string {
    if (this.findings.length === 0) return '(nothing confirmed yet)';
    const lines: string[] = [];
    for (const f of this.ranked()) {
      const asset = f.asset ? ` @ ${f.asset}` : '';
      let line = `- [${f.severity}] ${f.title}${asset} — ${f.summary}`.replace(/\s+$/, '');
      if (f.carried) line += '  (found in an earlier wave)';
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** One line per completed wave, so the planner can see the ground covered. */
  waveDigest(): string {
    if (this.waves.length === 0) return '(this is the first wave)';
    return this.waves.join('\n');
  }

  /**
   * Record a finding, deduplicated. Returns whether it was new.
   *
   * Ten agents run at once against one target, so the same bug gets reported
   * more than once — "missing HSTS" is a title four different vectors might
   * each land on — and an undeduped tracker would show it four times and
   * inflate every count. Two findings are the same bug when their title
   * slugs and their assets match; the first one wins, because it is the one
   * whose evidence was captured against the asset as originally found.
   *
   * The return value is what stops the transcript and the panel
   * double-counting: a repeat is dropped silently rather than announced
   * twice.
   */
  addFinding(f: Finding): boolean {
    const key = `${slug(f.title)}\u0000${(f.asset || '').trim().toLowerCase()}`;
    for (const existing of this.findings) {
      if (
        `${slug(existing.title)}\u0000${(existing.asset || '').trim().toLowerCase()}` === key
      ) {
        return false;
      }
    }
    this.findings.push(f);
    return true;
  }

  /**
   * The findings, worst first, then by wave and title.
   *
   * One ordering, used by the findings panel, the transcript and the closing
   * summary, so a critical never sorts below an info in one place and above
   * it in another. `wave` breaks severity ties so an early confirmation reads
   * above a late restatement; `title` keeps it stable run to run.
   */
  ranked(): Finding[] {
    return [...this.findings].sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity] ?? 9;
      const sb = SEVERITY_ORDER[b.severity] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.wave !== b.wave) return a.wave - b.wave;
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
    });
  }
}

// === SECTION === 6. Parsing helpers

/** A short, filesystem-safe label. Never empty. (Python `_slug`.) */
function slug(text: string): string {
  const s = String(text || '')
    .trim()
    .replace(SLUG_RE, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return (s.slice(0, 64) || 'finding').toLowerCase();
}

/**
 * Yield every balanced `{...}` span in `text`, string-aware.
 *
 * A worker may report several findings in one block or several blocks in one
 * message, so this walks the whole text rather than stopping at the first
 * object the way team's firstJsonObject does. Brace counting skips braces
 * inside string literals, or an evidence field containing `{` would
 * unbalance the scan.
 */
function* iterJsonObjects(text: string): Generator<string> {
  let i = 0;
  const n = text.length;
  outer: while (i < n) {
    if (text.charAt(i) !== '{') {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < n; j += 1) {
      const ch = text.charAt(j);
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
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j + 1;
          continue outer;
        }
      }
    }
    // Unbalanced from here on; nothing more to read (Python's for-else).
    return;
  }
}

/** Python `str(x or "")`: falsy (None/0/false/'') collapses to the empty string. */
function pyStr(v: unknown): string {
  return !v ? '' : String(v);
}

/** Fold a model's severity spelling onto one of the five we accept. */
export function normaliseSeverity(raw: unknown): string {
  let s = pyStr(raw).trim().toLowerCase();
  s = SEVERITY_ALIASES[s] ?? s;
  return (VALID_SEVERITIES as readonly string[]).includes(s) ? s : 'info';
}

/**
 * Read a worker's findings back off its final text.
 *
 * Accepts both shapes a model produces: a `{"findings": [...]}` envelope, and
 * a bare object that is itself one finding. Anything without a title is
 * dropped — an entry the model could not even name is not a report.
 */
export function parseFindings(
  text: string,
  opts: { wave: number; agent: string },
): Finding[] {
  if (!text || !text.trim()) return [];

  const out: Finding[] = [];
  for (const span of iterJsonObjects(text)) {
    let data: unknown;
    try {
      data = JSON.parse(span);
    } catch {
      continue;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue;
    const obj = data as Record<string, unknown>;

    let entries: unknown[] = Array.isArray(obj['findings']) ? obj['findings'] : [];
    if (!Array.isArray(obj['findings'])) {
      entries = obj['title'] ? [obj] : [];
    }

    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const title = pyStr(e['title']).trim();
      if (!title) continue;
      out.push(
        new Finding({
          wave: opts.wave,
          agent: opts.agent,
          title: title.slice(0, 200),
          severity: normaliseSeverity(e['severity']),
          asset: pyStr(e['asset']).trim().slice(0, 300),
          summary: pyStr(e['summary']).trim(),
          evidence: pyStr(e['evidence']).trim(),
          remediation: pyStr(e['remediation']).trim(),
        }),
      );
    }
  }
  return out;
}

/** A finding as a plain object, for the UI event stream (Python `_finding_dict`). */
export interface FindingDict {
  wave: number;
  agent: string;
  title: string;
  severity: string;
  asset: string;
  summary: string;
  evidence: string;
  remediation: string;
}

export function findingDict(f: Finding): FindingDict {
  return {
    wave: f.wave,
    agent: f.agent,
    title: f.title,
    severity: f.severity,
    asset: f.asset,
    summary: f.summary,
    evidence: f.evidence,
    remediation: f.remediation,
  };
}

// === SECTION === the hunt event stream

/**
 * Every event runHunt reports through its onEvent sink, as the UI dispatches
 * on `type`. Payload keys are the Python ones camelCased (`age_days` ->
 * `ageDays`, `fell_back` -> `fellBack`). `hunt_recon_text`/`hunt_plan_text`
 * and their `_tool` siblings come from collectTextLive's `prefix`.
 */
export type HuntEvent =
  | { type: 'hunt_finding'; finding: FindingDict; saved: string }
  | { type: 'hunt_agent_start'; name: string; index: number; brief: string }
  | { type: 'hunt_agent_text'; name: string; text: string }
  | { type: 'hunt_agent_tool'; name: string; tool: string; args: Record<string, unknown> }
  | {
      type: 'hunt_agent_result';
      name: string;
      tool: string;
      ok: boolean;
      output: string;
      args: Record<string, unknown>;
      meta: Record<string, unknown>;
      blocked?: boolean;
    }
  | { type: 'hunt_recon_start'; target: string; directory: string }
  | { type: 'hunt_recon_done'; text: string; saved: string }
  | {
      type: 'hunt_recon_skipped';
      target: string;
      path: string;
      ageDays: number;
      carried: number;
      findings: FindingDict[];
    }
  | { type: 'hunt_refused'; target: string; wave: number; highest: number; message: string }
  | { type: 'hunt_wave_start'; wave: number; size: number }
  | {
      type: 'hunt_plan';
      wave: number;
      summary: string;
      fellBack: boolean;
      raw: string;
      workers: Array<{ name: string; brief: string; owns: string[] }>;
    }
  | {
      type: 'hunt_agent_done';
      name: string;
      wave: number;
      ok: boolean;
      error: string;
      cost: number;
      input: number;
      output: number;
    }
  | {
      type: 'hunt_wave_end';
      wave: number;
      agents: number;
      ok: number;
      found: number;
      cost: number;
      input: number;
      output: number;
      fellBack: boolean;
    }
  | { type: 'hunt_summary_done'; path: string; text: string; wave: number }
  | {
      type: 'hunt_end';
      wave: number;
      findings: number;
      saved: number;
      carried: number;
      directory: string;
      command: string;
    }
  | { type: 'hunt_recon_text' | 'hunt_plan_text'; text: string }
  | {
      type: 'hunt_recon_tool' | 'hunt_plan_tool';
      tool: string;
      args: Record<string, unknown>;
      blocked: boolean;
    };

/** The sink every hunt step reports through (Python `on_event`). */
export type HuntEventSink = (ev: HuntEvent) => Promise<void>;

// === SECTION === 7. Campaign directories & wave layout

/**
 * The body of one finding's report file (Python `_finding_markdown`).
 * Frontmatter first, then the titled sections; `wave` in the frontmatter is
 * what reorganiseWaves files a legacy finding under.
 */
function findingMarkdown(run: HuntRun, f: Finding): string {
  const stamp = isoStamp();
  return (
    '---\n'
    + `target: ${run.target}\n`
    + `wave: ${f.wave}\n`
    + `agent: ${f.agent}\n`
    + `severity: ${f.severity}\n`
    + `asset: ${f.asset}\n`
    + `timestamp: ${stamp}\n`
    + '---\n\n'
    + `# ${f.title}\n\n`
    + `**Severity:** ${f.severity}  \n`
    + `**Asset:** ${f.asset || '(not stated)'}  \n`
    + `**Found by:** ${f.agent} (wave ${f.wave})\n\n`
    + '## Summary\n\n'
    + `${f.summary || '(no summary given)'}\n\n`
    + '## Evidence\n\n'
    + `${f.evidence || '(no evidence recorded)'}\n\n`
    + '## Remediation\n\n'
    + `${f.remediation || '(no remediation suggested)'}\n`
  );
}

/**
 * A scope name longer than this is prose, not a hostname. The longest legal
 * DNS name is 253 octets, but a name worth typing into `/bug-hunt` is nothing
 * like that long, and the failure this guards is real: an operator typed a
 * sentence into the target field and got a directory called
 * `bdgroup.com-the-recons-are-in-this-directory-pretty-much-you-can-...`.
 */
export const SCOPE_NAME_MAX = 80;

/**
 * The bare scope a target names — `https://dev.example.com/login` →
 * `dev.example.com`.
 *
 * The reduction itself, split out from `scopeSlug` because two other places
 * need to compare a scope *without* slugging it: `migrateHunts` deciding
 * whether a legacy directory already sits at its own scope, and the
 * `hunt_findings` tool matching the scope the operator typed against a
 * campaign directory. Both used to compare raw strings, so
 * `hunt_findings scope=https://dev.example.com/login` matched nothing.
 *
 * Empty for anything that is not host-shaped enough to reduce, which is the
 * caller's signal to reject it.
 */
export function scopeName(target: string): string {
  let text = String(target || '').trim();
  if (!text) return '';
  // Strip a scheme and anything after the authority, so a URL reduces to its
  // host. `//` starts the authority; a bare host has none.
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  text = text.split('/', 1)[0] ?? '';
  const at = text.split('@');
  text = at[at.length - 1] ?? ''; // drop any userinfo
  text = text.split(':', 1)[0] ?? ''; // drop a port
  return text.toLowerCase();
}

/**
 * The scope name a target files under. Never empty.
 *
 * A target is a host, a domain, a CIDR block or a URL — so the scope is
 * derived from it and reduced to one filesystem-safe label: a scheme and a
 * path are dropped, because `https://dev.example.com/login` and
 * `dev.example.com` are the same engagement and must not become two
 * directories.
 *
 * Anything that does not reduce to something host-shaped is rejected rather
 * than truncated into a misleading name. A sentence in the target field is
 * an operator mistake, and a directory named after its first eighty
 * characters is a mistake preserved on disk; throwing lets the caller say so.
 */
export function scopeSlug(target: string): string {
  const text = scopeName(target);
  if (!text) throw new Error('a hunt needs a target');

  if (text.includes(' ')) {
    throw new Error(
      `target contains spaces — ${JSON.stringify(target.slice(0, 60))}. /bug-hunt takes one `
        + 'host or domain, not a description of what to do.',
    );
  }

  const s = slug(text);
  if (!s || s === 'finding') {
    throw new Error(`cannot make a scope name out of ${JSON.stringify(target)}`);
  }
  if (s.length > SCOPE_NAME_MAX) {
    throw new Error(
      `target looks like a sentence, not a scope — ${JSON.stringify(target.slice(0, 60))}… `
        + `(${s.length} characters). /bug-hunt takes one host or domain.`,
    );
  }
  return s;
}

/**
 * Create and return the campaign directory for `target`'s scope:
 * `<stateDir>/hunts/<prefix><scope>/`.
 *
 * One directory per scope, REUSED. This used to be `<slug>-<stamp>`, so every
 * `/bug-hunt` on the same target made a new sibling directory and a campaign
 * against one host scattered itself across a dozen of them — recon notes in
 * one, findings in another, nothing that accumulated. The directory is now
 * the scope's, and the *artefacts* inside it carry the timestamps, so hunting
 * the same target twice adds to its history instead of starting over.
 *
 * `kind.dirPrefix` keeps two doctrines apart on a target that is both a
 * website and a domain: an AD campaign on `corp.local` lands in
 * `hunts/ad-corp.local/` while a web hunt on the same name keeps
 * `hunts/corp.local/`. Without it they would share one directory, and an AD
 * campaign would inherit a web hunt's recon as its own map of a domain
 * controller.
 *
 * Nothing is created but the directory itself. It used to make `findings/`
 * and `plans/` up front, which meant a `/bug-hunt` stopped before its first
 * brief left an empty campaign behind and — more to the point — those two
 * directories were the marker `migrateHunts` used to recognise a scope-shaped
 * campaign. The layout is now one directory per wave (`wave-<n>/findings/`
 * and `wave-<n>/plan.md`, see `waveDir`), so the wave directories are created
 * by `writePlan` and `writeReport` as the waves actually run. See
 * `isScopeShaped` for what replaced the marker.
 */
export function caseDir(cfg: Config, target: string, kind: CampaignKind | null = null): string {
  const prefix = kind !== null ? kind.dirPrefix : '';
  const d = path.join(cfg.stateDir, 'hunts', `${prefix}${scopeSlug(target)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * A legacy campaign directory: `<scope>-<YYYYMMDD>-<HHMMSS>`. Matched on the
 * tail so the scope itself may contain dashes and dots, which every hostname
 * does. See `migrateHunts`.
 */
const LEGACY_DIR_RE = /^(.+)-(\d{8}-\d{6})$/;

/** A wave directory: `wave-0`, `wave-1`, … The number is the wave it holds. */
const WAVE_DIR_RE = /^wave-(\d+)$/;

/**
 * The flat layout's two directories, which `reorganiseWaves` moves into the
 * wave directories. Kept as names because both are still *read* — see
 * `findingFiles` — so a campaign reorganised by hand, or read before the boot
 * migration has run, still loads.
 */
const FLAT_FINDINGS = 'findings';
const FLAT_PLANS = 'plans';

/**
 * Every `wave-<n>/` in `directory`, as `[n, path]`, ordered by n.
 *
 * Sorted numerically rather than by name, so `wave-10` follows `wave-9`
 * instead of landing between `wave-1` and `wave-2` the way a lexicographic
 * sort would put it.
 */
export function waveDirs(directory: string): Array<[number, string]> {
  if (!isDir(directory)) return [];
  const out: Array<[number, string]> = [];
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const match = WAVE_DIR_RE.exec(child.name);
    if (match) out.push([Number.parseInt(match[1] ?? '0', 10), path.join(directory, child.name)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * The wave a fresh `/bug-hunt` on this scope should run next.
 *
 * One past the highest wave already on disk, so hunting a scope a second time
 * continues its numbering rather than overwriting the waves it already has.
 * Minimum 1: wave 0 is recon, and recon is never something the operator asks
 * for as a wave.
 */
export function nextWaveNumber(directory: string): number {
  const waves = waveDirs(directory);
  return waves.length > 0 ? (waves[waves.length - 1] as [number, string])[0] + 1 : 1;
}

/** `<campaign>/wave-<n>/`, created. */
export function waveDir(directory: string, wave: number): string {
  const d = path.join(directory, `wave-${wave}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** `<campaign>/wave-<n>/findings/`, created. */
export function waveFindingsDir(directory: string, wave: number): string {
  const d = path.join(waveDir(directory, wave), FLAT_FINDINGS);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Whether `directory` is already a one-directory-per-scope campaign.
 *
 * Replaces the old `_SCOPE_MARKER = "plans"` check, which stopped meaning
 * anything the moment `plans/` moved inside the wave directories: a
 * scope-shaped campaign no longer has a top-level `plans/`, so the old marker
 * would have called every one of them legacy and tried to migrate them again
 * — and, worse, `migrateHunts` *creates* the marker on a directory whose name
 * is already its own scope, so the re-run would have littered a `plans/` back
 * into campaigns that had just been reorganised.
 *
 * A campaign is scope-shaped when it holds a wave directory, or still holds
 * the flat layout's `plans/` (which is what every campaign written before the
 * wave layout has, and what `migrateHunts` itself creates).
 */
export function isScopeShaped(directory: string): boolean {
  if (!isDir(directory)) return false;
  if (isDir(path.join(directory, FLAT_PLANS))) return true;
  return waveDirs(directory).length > 0;
}

/**
 * Every finding report in a campaign, in wave order then by name.
 *
 * Reads both layouts: `wave-<n>/findings/*.md` and the flat `findings/*.md`
 * the pre-wave campaigns used. Both are read rather than only the new one
 * because the reader is what the boot migration cannot be relied on to have
 * run before — an operator who opens `/findings` while the migration is still
 * pending, or who reorganises a campaign by hand, still gets their findings
 * instead of an empty panel.
 */
function findingFiles(directory: string): string[] {
  const out: string[] = [];
  for (const [, wavePath] of waveDirs(directory)) {
    out.push(...listMd(path.join(wavePath, FLAT_FINDINGS)));
  }
  const flat = path.join(directory, FLAT_FINDINGS);
  if (isDir(flat)) out.push(...listMd(flat));
  return out;
}

/**
 * Every wave plan in a campaign, newest layout and legacy alike.
 *
 * `wave-<n>/plan.md` is the current shape; `plans/wave-<n>-<stamp>.md` is
 * what the flat layout wrote and what `reorganiseWaves` has not yet moved.
 * Sorted by filename, which orders `plan.md` before `plan-2.md` — a
 * deliberately re-run wave's second plan reads after its first.
 */
function planFiles(directory: string): string[] {
  const out: string[] = [];
  for (const [, wavePath] of waveDirs(directory)) {
    out.push(
      ...fs
        .readdirSync(wavePath)
        .filter((n) => /^plan.*\.md$/.test(n))
        .sort()
        .map((n) => path.join(wavePath, n)),
    );
  }
  const flat = path.join(directory, FLAT_PLANS);
  if (isDir(flat)) {
    out.push(
      ...fs
        .readdirSync(flat)
        .filter((n) => /^wave-.*\.md$/.test(n))
        .sort()
        .map((n) => path.join(flat, n)),
    );
  }
  return out;
}

// === SECTION === 8. On-disk migration (legacy layouts)

/**
 * The scope a campaign directory belongs under.
 *
 * Read from the findings' own frontmatter `target` where there is one, because
 * the directory *name* is exactly what was wrong: a legacy directory is named
 * after whatever the operator typed, so the sentence
 * `bdgroup.com-the-recons-are-in-this-directory-...` is a name, not a scope.
 * The findings recorded the real target, so they decide where the campaign
 * files. Falls back to the directory's own name, which is correct for
 * everything written after the scope change.
 */
function campaignScope(directory: string): string {
  for (const p of findingFiles(directory)) {
    let target = '';
    try {
      target = readFrontmatter(readTextBestEffort(p))['target'] ?? '';
    } catch {
      continue;
    }
    if (target) {
      try {
        return scopeSlug(target);
      } catch {
        // The finding recorded prose too. The directory name is all there is
        // left to go on, and it is better than dropping the campaign — a
        // wrong scope is recoverable by hand, a deleted campaign is not.
        break;
      }
    }
  }
  const match = LEGACY_DIR_RE.exec(path.basename(directory));
  return scopeName(match ? (match[1] as string) : path.basename(directory));
}

/**
 * Fold legacy `<scope>-<stamp>/` campaigns into one directory per scope.
 *
 * The old layout made a new sibling directory for every `/bug-hunt`, so a
 * single engagement scattered across a dozen of them — recon notes in one,
 * findings in another, nothing that accumulated — and a target typed as prose
 * became a directory named after its first eighty characters. This merges
 * those into `<scope>/` so every campaign on a host sits together.
 *
 * A campaign is a directory under `hunts/` that is not `isScopeShaped`: a
 * scope-shaped campaign holds wave directories (or the flat layout's
 * `plans/`), and the legacy `<scope>-<stamp>` layout held neither. Files move
 * only when the destination does not already hold that name, so a campaign
 * migrated twice is a no-op and a genuinely different finding with the same
 * filename is kept rather than overwritten. Empty legacy directories are
 * removed; a non-empty one is left alone rather than guessed at.
 *
 * Returns the `[source, destination]` pairs that moved.
 */
export function migrateHunts(cfg: Config): Array<[string, string]> {
  const root = path.join(cfg.stateDir, 'hunts');
  if (!isDir(root)) return [];

  const moved: Array<[string, string]> = [];
  for (const name of fs.readdirSync(root).sort()) {
    const directory = path.join(root, name);
    if (!isDir(directory) || isScopeShaped(directory)) continue;
    const scope = campaignScope(directory);
    if (scope === path.basename(directory)) {
      // Nothing to move it to — it is already its own scope, or its name is
      // the best identity available. Mark it so the next call skips it.
      // `reorganiseWaves` will give it its wave directories.
      fs.mkdirSync(path.join(directory, FLAT_PLANS), { recursive: true });
      continue;
    }

    const files = walkFiles(directory).sort();
    if (files.length === 0) {
      // A campaign that recorded nothing — a `/bug-hunt` stopped before recon
      // wrote anything. Removing it is the whole migration; making an empty
      // scope directory for it would just add clutter, and reporting it as
      // moved would be a lie.
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        /* best-effort, like Python's bare `except OSError: pass` */
      }
      continue;
    }

    const dest = path.join(root, scope);
    fs.mkdirSync(path.join(dest, FLAT_FINDINGS), { recursive: true });
    fs.mkdirSync(path.join(dest, FLAT_PLANS), { recursive: true });

    let landed = 0;
    for (const src of files) {
      const target = path.join(dest, path.relative(directory, src));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) continue;
      try {
        movePath(src, target);
      } catch {
        continue;
      }
      landed += 1;
    }

    // Only remove what is actually empty, and only report what moved. A
    // directory still holding a file — one whose name collided at the
    // destination and was deliberately kept — stays on disk for the operator
    // rather than being deleted on a guess, and is not announced as migrated,
    // because it was not.
    try {
      if (walkFiles(directory).length === 0) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch {
      /* best-effort */
    }
    if (landed > 0) moved.push([directory, dest]);
  }
  return moved;
}

/**
 * File a flat campaign's artefacts into per-wave directories.
 *
 * The flat layout put every wave's findings in one `findings/` and every
 * wave's plan in `plans/`, so a three-wave campaign was 43 findings in a heap
 * whose only link to a wave was a frontmatter line. This moves each finding
 * to `wave-<its own wave>/findings/` and each plan to
 * `wave-<its own wave>/plan.md`, then removes the two flat directories once
 * they are empty.
 *
 * The wave number comes from each artefact's own frontmatter, which is why
 * that field was worth writing all along. A finding with no readable `wave`
 * is left where it is rather than guessed at — a wrong wave is worse than a
 * flat one, because the flat one is obvious.
 *
 * Safety properties, mirroring `migrateHunts`: move-only, never overwrite an
 * existing destination, never remove a directory that still holds a file, and
 * return the `[source, destination]` pairs that actually moved. So a second
 * call is a no-op — it finds no flat directories — and a campaign the
 * operator has reorganised by hand is left exactly as they left it.
 */
export function reorganiseWaves(cfg: Config): Array<[string, string]> {
  const root = path.join(cfg.stateDir, 'hunts');
  if (!isDir(root)) return [];

  const moved: Array<[string, string]> = [];
  for (const name of fs.readdirSync(root).sort()) {
    const directory = path.join(root, name);
    if (!isDir(directory)) continue;
    moved.push(...reorganiseOne(directory));
  }
  return moved;
}

/** The per-campaign half of `reorganiseWaves`. */
function reorganiseOne(directory: string): Array<[string, string]> {
  const moved: Array<[string, string]> = [];

  // ---- findings, each to its own wave's directory.
  const flatFindings = path.join(directory, FLAT_FINDINGS);
  if (isDir(flatFindings)) {
    for (const src of listMd(flatFindings)) {
      let meta: Record<string, string>;
      try {
        meta = readFrontmatter(readTextBestEffort(src));
      } catch {
        continue;
      }
      const raw = (meta['wave'] ?? '').trim();
      if (!/^\d+$/.test(raw)) continue;
      const destDir = waveFindingsDir(directory, Number.parseInt(raw, 10));
      let target = path.join(destDir, path.basename(src));
      if (fs.existsSync(target)) {
        // The destination already has a file by this name — a wave re-run, or
        // a finding migrated before. Keep both rather than destroying either.
        target = unique(target);
      }
      try {
        movePath(src, target);
      } catch {
        continue;
      }
      moved.push([src, target]);
    }
  }

  // ---- plans, `wave-<n>-<stamp>.md` to `wave-<n>/plan.md`.
  const flatPlans = path.join(directory, FLAT_PLANS);
  if (isDir(flatPlans)) {
    for (const src of fs
      .readdirSync(flatPlans)
      .filter((n) => /^wave-.*\.md$/.test(n))
      .sort()
      .map((n) => path.join(flatPlans, n))) {
      let meta: Record<string, string>;
      try {
        meta = readFrontmatter(readTextBestEffort(src));
      } catch {
        continue;
      }
      const number = asInt(meta['wave'], -1);
      if (number < 0) continue;
      const target = unique(path.join(waveDir(directory, number), 'plan.md'));
      try {
        movePath(src, target);
      } catch {
        continue;
      }
      moved.push([src, target]);
    }
  }

  // ---- only what is empty. A flat directory still holding a file — one
  // whose frontmatter named no wave, or whose move failed — stays for the
  // operator.
  for (const name of [FLAT_FINDINGS, FLAT_PLANS]) {
    const d = path.join(directory, name);
    try {
      if (isDir(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    } catch {
      /* best-effort */
    }
  }
  return moved;
}

// === SECTION === small fs/time helpers (module-private)

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Sorted `*.md` entries of a directory ([] when it is missing). */
function listMd(dir: string): string[] {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => path.join(dir, n));
}

/** Every file under `dir`, recursively (Python's `rglob("*")` + is_file filter). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  if (isDir(dir)) walk(dir);
  return out;
}

/**
 * shutil.move: rename, falling back to copy+delete across filesystems (EXDEV).
 * Only ever called with full file destinations, never a bare directory.
 */
function movePath(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    } else {
      throw e;
    }
  }
}

/**
 * UTF-8 read with invalid bytes replaced (Python's
 * `read_text(encoding="utf-8", errors="replace")`); Node's decoder already
 * substitutes U+FFFD for invalid sequences.
 */
function readTextBestEffort(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/**
 * `p`, or the first `-2`, `-3` … variant that is free.
 *
 * A second-resolution timestamp is not unique enough on its own: two
 * artefacts of the same kind can land in the same second — two agents
 * reporting the same title, a summary asked for twice — and the later write
 * would silently destroy the earlier one. Every artefact in a campaign
 * directory goes through here, because "one file per thing" is the whole
 * point of keeping them.
 */
function unique(p: string): string {
  if (!fs.existsSync(p)) return p;
  const suffix = path.extname(p); // '' when there is none
  const base = suffix ? p.slice(0, -suffix.length) : p;
  let n = 2;
  for (;;) {
    const candidate = `${base}-${n}${suffix}`;
    if (!fs.existsSync(candidate)) return candidate;
    n += 1;
  }
}

/**
 * A sortable timestamp for an artefact's name, e.g. `20261010-025510`.
 *
 * Filename-safe, LOCAL time, and lexicographically ordered, which is what
 * lets a campaign directory's artefacts sort into the order they were
 * written. The same shape `/osint` and `/phish` use for their case
 * directories, so one convention covers every dated thing this tool writes.
 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** UTC `%Y-%m-%dT%H:%M:%SZ` for frontmatter timestamps. */
function isoStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// === SECTION === 9. Artefact writers (recon / plan / report)

/**
 * Write recon's report to `<run.directory>/recon-<stamp>.md`.
 *
 * Recon used to live only in `run.recon` — the attribute the planner reads
 * and the summary prompt quotes — so it died with the process. A campaign
 * that spent minutes mapping a target left no record of what it saw, and the
 * operator's `/summary-hunt` after a restart said "recon produced nothing"
 * while the recon itself had been the most informative part of the run. This
 * is the record: notes accumulate in the campaign directory, one file per
 * recon, so hunting the same scope twice keeps both.
 *
 * Returns undefined when there is nothing to write, or the path when there
 * is. Best-effort like `save`: a campaign must not die because a file could
 * not be written, and the text is in the transcript either way.
 */
export function writeRecon(run: HuntRun, text: string): string | undefined {
  if (!text.trim()) return undefined;
  const body =
    '---\n'
    + `target: ${run.target}\n`
    + 'wave: 0\n'
    + `timestamp: ${isoStamp()}\n`
    + '---\n\n'
    + `# Recon — ${run.target}\n\n`
    + `${text.trim()}\n`;
  try {
    fs.mkdirSync(run.directory, { recursive: true });
    const p = unique(path.join(run.directory, `recon-${stamp()}.md`));
    fs.writeFileSync(p, body, 'utf8');
    return p;
  } catch {
    return undefined;
  }
}

/**
 * Write a wave's plan to `<run.directory>/wave-<n>/plan.md`.
 *
 * The roster the planner returned is the only statement of what a wave was
 * *supposed* to do, and it used to exist only as a UI event — gone the
 * moment the screen moved on. Keeping it is what makes a campaign legible
 * afterwards: why ten agents went where they went, and which briefs came
 * back empty.
 *
 * It sits in the wave's own directory, beside the findings that wave
 * produced, so the tree answers "what did wave 2 do, and what did it find"
 * without reading a frontmatter field. There is no timestamp in the name any
 * more — the wave number already makes it unique within the campaign; a
 * deliberately re-run wave gets `plan-2.md` from `unique`, so both plans
 * survive.
 *
 * `raw` is the planner's own reply, written only when it could not be read
 * as a roster. That is the diagnostic case — the fixed matrix ran instead,
 * and what the model actually said is the only way to tell a malformed
 * object from an empty turn from a prompt that needs rewriting.
 */
export function writePlan(
  run: HuntRun,
  wave: number,
  roster: Roster,
  raw: string,
  fellBack: boolean,
): string | undefined {
  const workers = rosterWorkers(roster);
  const lines: string[] = [
    '---',
    `target: ${run.target}`,
    `wave: ${wave}`,
    `agents: ${workers.length}`,
    `fell_back: ${fellBack ? 'true' : 'false'}`,
    // Which doctrine produced this plan. Read back by `loadRun` so a campaign
    // knows what it is; written on every plan so a campaign whose waves were
    // produced by different kinds (impossible today, but the field is the
    // record) still reports the latest honestly.
    `kind: ${run.kind}`,
    `timestamp: ${isoStamp()}`,
    '---',
    '',
    `# Wave ${wave} — ${workers.length} agents`,
    '',
    rosterSummary(roster) || '(no summary given)',
    '',
    '## Roster',
    '',
  ];
  for (const w of workers) {
    const owns = w.owns && w.owns.length > 0 ? w.owns.join(', ') : '(not stated)';
    lines.push(`### ${w.name}`, '', `**Owns:** ${owns}`, '', w.brief, '');
  }
  if (fellBack) {
    lines.push(
      '## Planner reply',
      '',
      'The planner\'s reply could not be read as a roster, so the fixed '
        + 'vector matrix ran in its place. What it actually said:',
      '',
      raw.trim() || '(the planner returned nothing)',
      '',
    );
  }
  try {
    const plans = waveDir(run.directory, wave);
    const p = unique(path.join(plans, 'plan.md'));
    fs.writeFileSync(p, `${lines.join('\n')}`, 'utf8');
    return p;
  } catch {
    return undefined;
  }
}

/**
 * Write one finding to
 * `<run.directory>/wave-<n>/findings/<severity>-<slug>.md`.
 *
 * The wave moved out of the filename and into the directory: the finding sits
 * beside the plan that aimed at it, and the name leads with the severity so
 * an `ls` of a wave's findings reads worst-first. `wave` is still in the
 * frontmatter, which is what `reorganiseWaves` uses to file a legacy finding
 * under the right wave.
 *
 * Two agents in one wave can land on the same title — "missing HSTS" is a
 * title four different vectors might each report — and the slug would be
 * identical, so the second write would silently destroy the first agent's
 * evidence. A numeric suffix keeps every finding's report on disk, which is
 * the whole point of writing them.
 */
export function writeReport(run: HuntRun, f: Finding): string {
  const base = path.join(
    waveFindingsDir(run.directory, f.wave),
    `${f.severity}-${slug(f.title)}.md`,
  );
  const p = unique(base);
  fs.writeFileSync(p, findingMarkdown(run, f), 'utf8');
  return p;
}

// === SECTION === the team seam (structural access)

/*
 * hunt imports three data shapes from team (WorkerSpec / Roster /
 * WorkerResult) plus parseRoster. PORT-MAP row 8 fixes the *names* but the
 * team.ts porter may land them as classes or interfaces; construction here
 * stays structural (object literals read through tiny seam helpers) so that
 * choice cannot break this module. Only fields the Python actually touches
 * are read: `.summary` and `.workers` on a roster; `.name/.brief/.owns` on a
 * spec. Everything hunt writes onto a WorkerResult is written back under the
 * same camelCase names team's own code uses.
 */

function makeWorkerSpec(name: string, brief: string, owns: string[]): WorkerSpec {
  return { name, brief, owns } as WorkerSpec;
}

function makeRoster(summary: string, workers: WorkerSpec[]): Roster {
  return { summary, workers } as Roster;
}

function rosterWorkers(roster: Roster): WorkerSpec[] {
  return (roster as { workers?: WorkerSpec[] }).workers ?? [];
}

function rosterSummary(roster: Roster): string {
  return (roster as { summary?: string }).summary ?? '';
}

/**
 * The WorkerResult shape hunt builds and reads (Python's dataclass fields,
 * camelCase). Extends team's type so runTeam results can flow back through
 * the same reads if a caller mixes them.
 */
export interface HuntWorkerResult extends WorkerResult {
  spec: WorkerSpec;
  digest: string;
  ok: boolean;
  error: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  touched: string[];
}

function makeWorkerResult(spec: WorkerSpec): HuntWorkerResult {
  return {
    spec,
    digest: '',
    ok: true,
    error: '',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    touched: [],
  } as HuntWorkerResult;
}

// === SECTION === 10. Evidence & closing reports

/** Where finished campaign summaries are kept, beside the osint reports. */
export function reportsDir(cfg: Config): string {
  return path.join(cfg.stateDir, 'reports');
}

/**
 * The wave numbers a report will print a `## ` section for.
 *
 * A finding's wave counts even when its plan did not survive — a legacy
 * campaign reorganised from the flat layout still gets a section, built from
 * the findings alone, rather than being dropped for want of a plan — so this
 * is the union of the recorded waves and the waves findings were reported in.
 *
 * Both the frontmatter count in `writeSummary` and the `**Waves:**` line in
 * `buildEvidenceReport` are this number. They used to be computed separately
 * and drifted: the frontmatter took `run.wave`, the highest wave *number*,
 * while the body counted sections, so one report said `waves: 1` at the top
 * and `**Waves:** 2` in the body. Two answers in one file, and the reader
 * has no way to know which was meant.
 */
export function reportWaveNumbers(run: HuntRun): number[] {
  const numbers = new Set<number>();
  for (const f of run.findings) numbers.add(f.wave);
  for (const r of run.waveRecords) numbers.add(r.number);
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Archive the closing report.
 *
 * Written into the campaign directory first so it sits with the evidence,
 * then copied into `<stateDir>/reports/` — the flat, permanent store that
 * outlives the run, the same one `/osint` archives into. The copy is
 * best-effort: the report exists in the campaign directory regardless, so a
 * failed archive must not throw into the UI.
 *
 * Both names carry a timestamp. The campaign directory belongs to the *scope*
 * and is reused, so a fixed `summary.md` would have a second campaign on the
 * same host silently overwrite the first one's report — the exact loss this
 * layout exists to stop.
 */
export function writeSummary(cfg: Config, run: HuntRun, text: string): string {
  const s = stamp();
  // The number of `## ` sections the report will print — the same number the
  // evidence report's own header carries, from the same helper. See
  // `reportWaveNumbers` for the drift this replaces.
  const waves = reportWaveNumbers(run).length;
  const body =
    '---\n'
    + `target: ${run.target}\n`
    + `waves: ${waves}\n`
    + `findings: ${run.findings.length}\n`
    + `timestamp: ${isoStamp()}\n`
    + '---\n\n'
    + `${text}\n`;
  const local = unique(path.join(run.directory, `summary-${s}.md`));
  fs.writeFileSync(local, body, 'utf8');

  // The archive copy takes the same suffix as the local one, so the two files
  // for one report read as a pair rather than as two different reports.
  const suffix = path.basename(local, path.extname(local)).slice('summary-'.length);
  const destDir = reportsDir(cfg);
  const dest = unique(path.join(destDir, `hunt-${path.basename(run.directory)}-${suffix}.md`));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(local, dest);
  } catch {
    return local;
  }
  return dest;
}

/**
 * The campaign's findings as a professional, evidence-only report.
 *
 * Deliberately **not** a model call. `/summary-hunt` is where narrative and
 * remediation live; this is the document an operator hands to whoever has to
 * act on the findings, and its whole value is that every line of it was
 * recorded during the engagement. A model asked to "write up the findings"
 * would paraphrase the evidence — and evidence that has been paraphrased is
 * no longer evidence, it is a claim about evidence. So this is assembled
 * verbatim, and the remediation section is omitted on purpose: it is the
 * fix, not the finding, and mixing the two in one document is how a report
 * starts reading as advocacy.
 *
 * One `## Wave N` section per wave, in order, each with what the wave aimed
 * at and what it found; then one `### SEVERITY — title` block per finding,
 * worst-first, with the recorded evidence quoted unaltered.
 */
export function buildEvidenceReport(run: HuntRun): string {
  const s = isoStamp();
  const ranked = run.ranked();
  const counts: Record<string, number> = {};
  for (const f of ranked) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const tally =
    VALID_SEVERITIES.filter((sev) => counts[sev])
      .map((sev) => `${counts[sev]} ${sev}`)
      .join(', ') || 'none';

  // One section per wave, in wave order. A finding whose wave has no record —
  // a legacy campaign reorganised from the flat layout, whose plans did not
  // survive — still gets a section, built from the findings alone, rather
  // than being dropped for want of a plan.
  const byWave = new Map<number, Finding[]>();
  for (const f of ranked) {
    const list = byWave.get(f.wave) ?? [];
    list.push(f);
    byWave.set(f.wave, list);
  }
  const numbers = reportWaveNumbers(run);

  const lines: string[] = [
    `# Bug hunt — ${run.target}`,
    '',
    `**Target:** ${run.target}  `,
    `**Generated:** ${s}  `,
    // The sections below, counted — not the plans. A wave that was re-run
    // leaves every plan on disk, so counting plans made this claim "16
    // waves" over an 11-wave campaign. This is the number of `## ` headings
    // the reader will find, which is the only thing the line can honestly
    // promise.
    `**Waves:** ${numbers.length}  `,
    `**Findings:** ${ranked.length} (${tally})`,
    '',
    'This report contains only what was recorded during the engagement. '
      + 'Evidence is reproduced as captured.',
    '',
  ];

  for (const n of numbers) {
    const record = run.waveRecords.find((r) => r.number === n) ?? null;
    const found = byWave.get(n) ?? [];
    const title = n === 0 ? 'Recon (wave 0)' : `Wave ${n}`;
    lines.push('', `## ${title}`, '');
    if (n === 0) {
      lines.push('Findings reported by the reconnaissance phase.');
    } else if (record !== null) {
      const aimed = record.summary || '(no summary recorded)';
      lines.push(
        `**${record.agents} agent(s)** — ${aimed}`
          + (record.fellBack ? ' _(fixed vector fallback)_' : ''),
      );
    } else {
      lines.push('_(no plan recorded for this wave)_');
    }
    lines.push('');

    if (found.length === 0) {
      lines.push('No findings recorded for this wave.', '');
      continue;
    }

    for (const f of found) {
      lines.push(
        `### ${f.severity.toUpperCase()} — ${f.title}`,
        '',
        `- **Asset:** ${f.asset || '(not stated)'}`,
        `- **Found by:** ${f.agent} (wave ${f.wave})`,
      );
      if (f.summary) lines.push('', f.summary, '');
      lines.push('**Evidence**', '');
      // Verbatim, and fenced so a payload containing markdown — a stack
      // trace, a dumped config, an injected `<script>` — renders as the text
      // it is rather than as markup in the operator's viewer.
      lines.push('```', (f.evidence || '(no evidence recorded)').trim(), '```', '');
    }
  }

  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

/**
 * Write the evidence report beside the campaign, and archive a copy.
 *
 * Same two-step as `writeSummary`: into the campaign directory so it sits
 * with the artefacts it cites, then a copy into `<stateDir>/reports/` so the
 * deliverable outlives the campaign directory. Returns the archived path,
 * the campaign path when the archive copy failed, or undefined when there
 * was nothing to report.
 */
export function writeEvidenceReport(cfg: Config, run: HuntRun): string | undefined {
  if (run.findings.length === 0) return undefined;
  const s = stamp();
  const body = buildEvidenceReport(run);
  const local = unique(path.join(run.directory, `report-${s}.md`));
  fs.writeFileSync(local, body, 'utf8');

  const destDir = reportsDir(cfg);
  const dest = unique(
    path.join(destDir, `hunt-report-${path.basename(run.directory)}-${s}.md`),
  );
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(local, dest);
  } catch {
    return local;
  }
  return dest;
}

// === SECTION === 11. Async primitives (private)

/*
 * Node ships no asyncio.Event/Semaphore. These two are the whole of what the
 * campaign needs of them — a settable latch with promise-based waiters, and a
 * counting semaphore whose release hands its slot straight to the next
 * waiter — hand-rolled rather than pulled from a dependency, because the
 * port's dep list is fixed.
 */

/** asyncio.Event: a latch `/stop-hunt` sets and every wave races. */
export class AsyncEvent {
  private flag = false;
  private readonly waiters: Array<() => void> = [];

  isSet(): boolean {
    return this.flag;
  }

  set(): void {
    if (this.flag) return;
    this.flag = true;
    const wake = this.waiters.splice(0);
    for (const fn of wake) fn();
  }

  async wait(): Promise<void> {
    if (this.flag) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/** The stop signal handed to runHunt — an AsyncEvent, aliased for signatures. */
export type StopSignal = AsyncEvent;

class Semaphore {
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.limit > 0 && this.pending < this.limit) {
      this.pending += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    // The slot was transferred directly by release(); do not count it again.
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // hand the slot straight over; the count is unchanged
      return;
    }
    this.pending = Math.max(0, this.pending - 1);
  }

  private pending = 0;
}

/**
 * A field-for-field copy of cfg — Python's `dataclasses.replace(cfg)`.
 * Descriptor-based so getters (Config.apiKeyPresent) and the prototype
 * (methods) survive; a spread would flatten the former and drop the latter.
 * Each hunt agent gets its OWN copy so its Agent can install its own Scope
 * on `cfg.scope` without clobbering the shared one — see PORT-MAP §2.4's
 * hidden coupling note for why sharing one config clobbers the scope guard.
 */
function cloneConfig(cfg: Config, overrides: Partial<Config> = {}): Config {
  const clone = Object.create(
    Object.getPrototypeOf(cfg),
    Object.getOwnPropertyDescriptors(cfg),
  ) as Config;
  return Object.assign(clone, overrides);
}

/**
 * Named-placeholder substitution for the ported prompt templates (Python's
 * str.format on `{target}` etc.). Only the named placeholders are replaced —
 * every other brace (the JSON examples) passes through untouched, which is
 * why the templates are stored in their post-format shape.
 */
function fmt(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m,
  );
}

/** A cancellable sleep used by the stream idle watchdog. */
function sleep(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

// === SECTION === 12. Running

/**
 * A finding an agent reported through `report_finding`, as a Finding
 * (Python `_finding_from_tool`).
 *
 * The tool hands its payload back on the result's `meta` rather than writing
 * anything itself, so this is where a tool call becomes a first-class
 * finding. Shaped to match what `parseFindings` produces, so the two paths
 * are indistinguishable once the finding is in the run — which is what lets
 * dedupe reconcile them.
 */
function findingFromTool(
  meta: Record<string, unknown>,
  opts: { wave: number; agent: string },
): Finding | undefined {
  const data = meta?.['finding'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const title = pyStr(d['title']).trim();
  if (!title) return undefined;
  return new Finding({
    wave: opts.wave,
    agent: opts.agent,
    title: title.slice(0, 200),
    severity: normaliseSeverity(d['severity']),
    asset: pyStr(d['asset']).trim().slice(0, 300),
    summary: pyStr(d['summary']).trim(),
    evidence: pyStr(d['evidence']).trim(),
    remediation: pyStr(d['remediation']).trim(),
  });
}

/** Write the finding's report if it is worth one. Returns the path or ''. */
function save(run: HuntRun, f: Finding): string {
  if (!f.saved) return '';
  try {
    return writeReport(run, f);
  } catch {
    // A campaign must not die because a report file could not be written —
    // the finding is already in the transcript and the next planner's digest.
    return '';
  }
}

/**
 * Record and announce a finding the instant an agent reports it.
 *
 * This is the whole point of the tool: the operator's tracker updates while
 * the wave is still running, instead of at the end of it. Deduplicated
 * through `run.addFinding`, so the mid-turn report and the same bug
 * restated in the agent's final text are one finding — the harvest after the
 * wave then has nothing new to add for anything already published here.
 */
async function reportLive(run: HuntRun, f: Finding, onEvent: HuntEventSink): Promise<void> {
  if (!run.addFinding(f)) return;
  await onEvent({ type: 'hunt_finding', finding: findingDict(f), saved: save(run, f) });
}

/**
 * The `args` a tool_result event carried. shared.ts's AgentEvent (finalised
 * by the agent.ts port) carries the call args on tool_result and the
 * violation text as `targets` on blocked, matching the Python yield sites.
 */

/** Paths a tool call wrote (team's `_touched_paths`, same logic). */
function touchedPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === 'write_file' || name === 'edit_file') {
    const p = pyStr(args['path']).trim();
    return p ? [p] : [];
  }
  return [];
}

/**
 * The worker's final text (team's `_digest`).
 *
 * Read back off the worker's own history rather than accumulated here: the
 * history is what the worker actually said, and it is already in the right
 * order. Falls back to a marker when the worker produced no text at all.
 */
function digestOf(worker: Agent, result: HuntWorkerResult): string {
  for (let i = worker.messages.length - 1; i >= 0; i -= 1) {
    const msg = worker.messages[i];
    if (msg === undefined || msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block && typeof block === 'object' && (block as ContentBlock).type === 'text') {
        parts.push((block as Extract<ContentBlock, { type: 'text' }>).text);
      }
    }
    const text = parts.filter((p) => p).join('\n').trim();
    if (text) return text;
  }
  if (!result.ok) return `(worker failed: ${result.error})`;
  return '(worker produced no text)';
}

/**
 * A tool_hook that serialises mutating tool calls across all workers (team's
 * `_write_lock_hook`, built here because team's private helper is not part of
 * its exported contract — `needsPermission` from tools is).
 *
 * Only the tools that need permission mutate anything (bash, write_file,
 * edit_file — tools.GATED_TOOLS); anything else is a no-op so a read never
 * queues behind a writer. enter/exit re-check the same pure predicate, so an
 * ungated call never releases a lock it never took.
 *
 * What this does NOT cover: a file written by a bash command. bash is one
 * call to this lock, and the shell inside it is invisible. Ownership waves
 * are the control for that; this only stops two workers being *inside* a
 * mutating call at the same instant.
 */
function writeLockHook(lock: Semaphore): ToolHook {
  return {
    async enter(name) {
      if (needsPermission(name)) await lock.acquire();
    },
    async exit(name) {
      if (needsPermission(name)) lock.release();
    },
  };
}

/**
 * Compose tool hooks into one, outermost first. Null entries are skipped.
 *
 * Two hooks have to be able to run around the same call: the write lock and
 * a campaign kind's interlock. exit unwinds in REVERSE — the AsyncExitStack
 * semantics the Python port relied on — so the interlock releases its
 * throttle only after the write lock has let go.
 */
function chainHooks(...hooks: Array<ToolHook | null | undefined>): ToolHook | null {
  const live = hooks.filter((h): h is ToolHook => h != null);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0] as ToolHook;
  return {
    async enter(name, args) {
      for (const h of live) await h.enter(name, args);
    },
    async exit(name, args) {
      for (let i = live.length - 1; i >= 0; i -= 1) {
        await (live[i] as ToolHook).exit(name, args);
      }
    },
  };
}

/**
 * How hunt builds its agents (Python's injectable `agent_factory`). Keyword
 * options mirror the Python call sites: `tool_hook`, `can_report`,
 * `can_hunt_read`.
 */
export type AgentFactory = (
  cfg: Config,
  opts?: { toolHook?: ToolHook | null; canReport?: boolean; canHuntRead?: boolean },
) => Agent;

const defaultAgentFactory: AgentFactory = (cfg, opts) =>
  new Agent(
    cfg,
    undefined,
    opts?.toolHook ?? undefined,
    opts?.canReport ?? false,
    opts?.canHuntRead ?? true,
  );

/**
 * Run one hunt agent to completion. Never throws; returns null when the
 * campaign was stopped under it (Python: the cancelled task's absence from
 * the gather results).
 *
 * A near-copy of team's worker runner, and deliberately so: that one emits
 * `team_*` events, and a hunt agent's events carry a different payload (the
 * wave, the pane slot). The shared machinery — the write lock, the digest,
 * the touched-path extraction — is the same logic.
 *
 * `context` is the shared recon digest, prepended to the brief. Without it
 * every agent starts blind and spends its first turns re-deriving what recon
 * already established — ten agents running the same `ls` and reading the
 * same six files — which is most of a wave's budget spent on nothing.
 *
 * `contract` is the finding-reporting block, appended *after* the brief so
 * it is the last thing the agent reads before it answers. It has to be here
 * and not only on the planner: a worker is the only one that runs a test, so
 * it is the only one that can report what the test found. Without it the
 * agent narrates a methodology, `parseFindings` reads no JSON, and the whole
 * wave reports nothing no matter what it actually discovered.
 */
async function runAgent(
  spec: WorkerSpec,
  index: number,
  cfg: Config,
  opts: {
    onEvent: HuntEventSink;
    agentFactory: AgentFactory;
    toolHook: ToolHook | null;
    context: string;
    contract: string;
    wave: number;
    run: HuntRun | null;
    stop: StopSignal | null;
  },
): Promise<HuntWorkerResult | null> {
  const result = makeWorkerResult(spec);

  // Its own Config copy, so each agent gets its own Scope and its own
  // cfg.scope — see the cloneConfig note for why sharing one clobbers the
  // scope guard. The mode is inherited: under /mode zim these agents run the
  // operator's AGENTS.md doctrine with every tool armed.
  //
  // canReport arms report_finding for this agent. It is a hunt agent, so it
  // has a tracker to report into; nothing outside a hunt does. canHuntRead
  // is the other way round: this agent must not read the campaign it is part
  // of, because its brief is deliberately independent of the other agents'.
  const agentCfg = cloneConfig(cfg);
  const worker = opts.agentFactory(agentCfg, {
    toolHook: opts.toolHook,
    canReport: true,
    canHuntRead: false,
  });

  await opts.onEvent({
    type: 'hunt_agent_start',
    name: spec.name,
    index,
    brief: spec.brief,
  });

  const buf: string[] = [];

  const flush = async (): Promise<void> => {
    const text = buf.join('').trim();
    buf.length = 0;
    if (text) {
      await opts.onEvent({ type: 'hunt_agent_text', name: spec.name, text });
    }
  };

  // Order matters: the shared context first, then the brief, then the
  // contract last — the reporting block is what the agent should be holding
  // in mind as it writes its final message.
  let prompt = opts.context ? `${opts.context}\n\n${spec.brief}` : spec.brief;
  if (opts.contract) prompt = `${prompt}\n\n${opts.contract}`;

  try {
    for await (const ev of worker.runTurn(prompt)) {
      // JS has no task cancellation. Python's asyncio cancel unwound the
      // worker from outside; here the worker notices the stop on its next
      // event, asks its turn to abort, and leaves no result — which is what
      // the wave's gather-equivalent filtered out for cancelled tasks.
      if (opts.stop !== null && opts.stop.isSet()) {
        try {
          worker.cancelTurn();
        } catch {
          /* already finished — nothing to cancel */
        }
        return null;
      }
      if (ev.type === 'text_delta') {
        buf.push(ev.text);
      } else if (ev.type === 'tool_call') {
        // Flush first, so the agent's reasoning lands above the call it
        // explains rather than after it.
        await flush();
        await opts.onEvent({
          type: 'hunt_agent_tool',
          name: spec.name,
          tool: ev.name,
          args: ev.args ?? {},
        });
      } else if (ev.type === 'tool_result') {
        const args = ev.args ?? {};
        result.touched.push(...touchedPaths(ev.name, args));
        await opts.onEvent({
          type: 'hunt_agent_result',
          name: spec.name,
          tool: ev.name,
          ok: !ev.isError,
          output: ev.output,
          // The command and the run metadata travel with the result so the
          // transcript can render a full panel rather than a truncated
          // one-liner. This is the operator's only view of what the
          // engagement is actually doing.
          args,
          meta: ev.meta ?? {},
        });
        // The live edge. A report_finding call publishes here, mid-turn,
        // rather than waiting for the wave to end — this is what makes the
        // operator's tracker fill in as the agents work. The event above
        // still goes out first, so the transcript shows the call before it
        // shows what it found.
        if (opts.run !== null && ev.name === 'report_finding' && !ev.isError) {
          const live = findingFromTool(ev.meta ?? {}, { wave: opts.wave, agent: spec.name });
          if (live !== undefined) {
            await reportLive(opts.run, live, opts.onEvent);
          }
        }
      } else if (ev.type === 'blocked') {
        await opts.onEvent({
          type: 'hunt_agent_result',
          name: spec.name,
          tool: ev.name,
          ok: false,
          output: ev.targets,
          args: {},
          meta: {},
          blocked: true,
        });
      } else if (ev.type === 'usage') {
        result.inputTokens += ev.input || 0;
        result.outputTokens += ev.output || 0;
        result.cost += ev.cost || 0;
      } else if (ev.type === 'error') {
        result.ok = false;
        result.error = ev.message || 'error';
        await flush();
      }
    }
    await flush();
  } catch (e) {
    result.ok = false;
    result.error = `${e instanceof Error ? e.constructor.name : typeof e}: ${String(
      e instanceof Error ? e.message : e,
    )}`;
    await flush().catch(() => {});
  }

  result.digest = digestOf(worker, result);
  return result;
}

/**
 * Run one wave concurrently, racing the stop signal.
 *
 * All the workers start together; `concurrency` is a semaphore, not a batch
 * boundary, so with the default of ten a ten-brief wave is genuinely ten
 * simultaneous streams. The wave is raced against `stop` rather than merely
 * checked before it: `/stop-hunt` cancels the in-flight agents instead of
 * waiting out the slowest one, which is the difference between stopping a
 * hunt and waiting for it.
 *
 * `interlock` is the campaign kind's own tool hook, run around every call
 * alongside the write lock. It is the same object for all ten workers, which
 * is the point: `/ad`'s throttle and attempt counter have to be shared, or
 * ten parallel agents each get their own budget and the whole wave sprays
 * ten times what the operator authorised.
 */
async function runWave(
  specs: WorkerSpec[],
  cfg: Config,
  opts: {
    onEvent: HuntEventSink;
    agentFactory: AgentFactory;
    stop: StopSignal;
    concurrency: number;
    context: string;
    contract: string;
    wave: number;
    run: HuntRun | null;
    interlock: ToolHook | null;
  },
): Promise<HuntWorkerResult[]> {
  const sem = new Semaphore(Math.max(1, opts.concurrency));
  const hook = chainHooks(opts.interlock, writeLockHook(new Semaphore(1)));

  const one = async (index: number, spec: WorkerSpec): Promise<HuntWorkerResult | null> => {
    await sem.acquire();
    try {
      if (opts.stop.isSet()) return null;
      return await runAgent(spec, index, cfg, {
        onEvent: opts.onEvent,
        agentFactory: opts.agentFactory,
        toolHook: hook,
        context: opts.context,
        contract: opts.contract,
        wave: opts.wave,
        run: opts.run,
        stop: opts.stop,
      });
    } finally {
      sem.release();
    }
  };

  const tasks = specs.map((s, i) => one(i, s));
  if (tasks.length === 0) return [];

  // Race the whole wave against the stop signal. When stop fires the
  // in-flight agents observe it on their next event, cancel their turn and
  // return null (Python: tasks cancelled, gather drops them); workers still
  // queued behind the semaphore return null without starting.
  const allDone = Promise.allSettled(tasks);
  await Promise.race([allDone, opts.stop.wait()]);

  const settled = await allDone;
  return settled
    .filter((r): r is PromiseFulfilledResult<HuntWorkerResult | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r): r is HuntWorkerResult => r !== null);
}

/** Run one turn and return only its text, discarding the tool chatter. */
async function collectText(agent: Agent, prompt: string): Promise<string> {
  const parts: string[] = [];
  for await (const ev of agent.runTurn(prompt)) {
    if (ev.type === 'text_delta') parts.push(ev.text);
  }
  return parts.join('');
}

/**
 * Yield a turn's events, calling `onIdle` when the stream goes quiet.
 *
 * A turn's prose arrives as `text_delta` events, and the consumers below
 * only forward it when something *else* happens — a tool call, or the end of
 * the turn. For a planner that reasons for forty seconds before its first
 * tool call, that means the screen shows nothing at all for forty seconds,
 * which is indistinguishable from a hang and is exactly the complaint the
 * wave view was built to answer.
 *
 * So the wait between events is bounded: when `idleSeconds` pass with no
 * event, `onIdle` runs — the consumers flush their buffer through it — and
 * the wait restarts. `onIdle` is a callback rather than an event yielded to
 * the caller so the generator keeps the same shape for callers that only
 * care about events.
 *
 * Nothing here invents content or reorders anything: the only thing that
 * changes is *when* prose the model has already produced is handed on.
 */
async function* streamTurn(
  agent: Agent,
  prompt: string,
  onIdle: () => Promise<void>,
  idleSeconds: number = STREAM_IDLE_SECONDS,
): AsyncGenerator<AgentEvent, void, unknown> {
  const it = agent.runTurn(prompt)[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<AgentEvent>> | null = null;
  try {
    for (;;) {
      if (pending === null) pending = it.next();
      // Captured into a const so the null-check survives the closures below —
      // a mutable let would lose its narrowing inside the race callbacks.
      const next = pending;
      const timer = sleep(idleSeconds * 1000);
      let timedOut = false;
      try {
        timedOut = await Promise.race([
          next.then(() => false),
          timer.promise.then(() => true),
        ]);
      } finally {
        timer.cancel(); // don't keep the loop alive once the event won
      }
      if (timedOut) {
        await onIdle();
        continue;
      }
      const res = await next; // settled; rejects like Python's task.result()
      pending = null;
      if (res.done) return;
      yield res.value;
    }
  } finally {
    // Python cancelled the outstanding __anext__ task and closed the
    // generator. JS cannot cancel a pending next(); observe it so a late
    // rejection is not reported as unhandled, then close the source.
    if (pending !== null) void pending.then(
      () => {},
      () => {},
    );
    const close = it.return;
    if (close !== undefined) {
      try {
        // `undefined` satisfies lib's (value: TReturn) signature on a
        // void-returning generator — the spec makes the argument optional.
        await close.call(it, undefined);
      } catch {
        /* best-effort close, like Python's bare except around aclose() */
      }
    }
  }
}

/**
 * Run one turn, reporting what it is doing as it does it.
 *
 * Two turns in a campaign run long enough that the operator watches them
 * directly, and a frozen line for that long is indistinguishable from a
 * hang: recon, which can take minutes against a live target, and the wave
 * planner, which is a real model call over the whole recon, every finding so
 * far and the wave history before it writes ten briefs. Both go through
 * here, and the `prefix` names the events they emit — `recon` or `plan`. The
 * UI routes each to its own sink, so the planner's reasoning lands in the
 * wave view while recon's lands in its own window.
 *
 * Only the *tool call* is reported, not its output: a tool result here is
 * arbitrary target text, and pushing it into a UI sink unescaped is how a
 * scan of a hostile page ends up painting the overlay. The model's own prose
 * is the interesting part and it is what gets shown.
 *
 * `run` is passed so a recon agent's `report_finding` call publishes the
 * same way a wave agent's does. Recon is the first thing to touch the target,
 * and it is where an exposed debug endpoint or a stack trace in an error
 * page turns up — a finding confirmed here should reach the tracker now, not
 * at the first wave boundary. The planner is in plan mode and cannot report
 * at all, so it passes null.
 */
async function collectTextLive(
  agent: Agent,
  prompt: string,
  onEvent: HuntEventSink,
  run: HuntRun | null,
  prefix: 'recon' | 'plan',
): Promise<string> {
  const parts: string[] = [];
  const buf: string[] = [];

  const flush = async (): Promise<void> => {
    const text = buf.join('').trim();
    buf.length = 0;
    if (text) {
      await onEvent({ type: `hunt_${prefix}_text`, text });
    }
  };

  // The watchdog, so prose reaches the screen while the model is still
  // thinking rather than at its first tool call — see `streamTurn`.
  for await (const ev of streamTurn(agent, prompt, flush)) {
    if (ev.type === 'text_delta') {
      parts.push(ev.text);
      buf.push(ev.text);
    } else if (ev.type === 'tool_call') {
      // Flush first, so the reasoning lands above the call it explains.
      await flush();
      await onEvent({
        type: `hunt_${prefix}_tool`,
        tool: ev.name,
        args: ev.args ?? {},
        blocked: false,
      });
    } else if (ev.type === 'tool_result') {
      if (run !== null && ev.name === 'report_finding' && !ev.isError) {
        const live = findingFromTool(ev.meta ?? {}, { wave: 0, agent: 'recon' });
        if (live !== undefined) {
          await reportLive(run, live, onEvent);
        }
      }
    } else if (ev.type === 'blocked') {
      await onEvent({
        type: `hunt_${prefix}_tool`,
        tool: ev.name,
        args: {},
        blocked: true,
      });
    } else if (ev.type === 'error') {
      await onEvent({
        type: `hunt_${prefix}_text`,
        text: `(${prefix} error: ${ev.message})`,
      });
    }
  }
  await flush();
  return parts.join('');
}

/**
 * Recon, then wave(s). Returns the run for the closing report.
 *
 * Every step is reported through `onEvent` as it happens. The caller owns
 * the final summary text — this returns the run it needs to write it.
 *
 * It stops on its own now. This used to loop `while not run.stop.isSet()`
 * with no cap at all, so a campaign ran wave after wave until the operator
 * pressed Ctrl+X — including waves planned after one that had already found
 * a critical, which is work the operator did not ask for and could not
 * decline. The loop is bounded by `maxWaves` (default 1) and the UI never
 * raises it, so the command runs one wave per invocation and the operator
 * decides whether there is a next one. The bound is a parameter rather than
 * a bare `break` so a test can still drive two waves through one call and
 * check that the second planner saw the first wave's findings.
 *
 * `waveNumber` names the wave to run; undefined means the next one the scope
 * has not run yet — see `nextWaveNumber`. So `/bug-hunt host` continues a
 * campaign's numbering where it left off, and `--wave 3` runs wave 3
 * specifically, on top of whatever waves 1 and 2 already put on disk.
 *
 * `summaryFlag` is polled at each wave boundary: `/summary-hunt` cannot run
 * concurrently with the hunt (both stream through the same transcript), so
 * it sets a flag and the summary is generated here, between waves, where
 * nothing else is streaming.
 *
 * `run` lets the caller supply the HuntRun it wants used. The UI passes one
 * it has already published, so `/stop-hunt` and `/summary-hunt` have
 * something to act on *while the campaign is running* — this function
 * returns only when the campaign is over, which is far too late to be told
 * to stop.
 *
 * `fresh` forces the recon phase even when the scope already has notes on
 * disk. Without it a repeat hunt reuses them and goes straight to planning —
 * see `findRecon`. It is the operator's escape hatch for a target that has
 * actually changed since the map was drawn.
 *
 * `kind` selects the doctrine: the prompts, the fallback vectors, the
 * campaign directory's prefix, and the tool interlock. Null means HUNT_KIND
 * — `/bug-hunt` exactly as it shipped — so every existing caller is
 * unaffected. `/ad` passes its own.
 */
export async function runHunt(
  cfg: Config,
  target: string,
  opts: {
    onEvent: HuntEventSink;
    agentFactory?: AgentFactory;
    stop?: StopSignal | null;
    waveSize?: number;
    concurrency?: number;
    summaryFlag?: (() => boolean) | null;
    run?: HuntRun | null;
    fresh?: boolean;
    waveNumber?: number | null;
    maxWaves?: number;
    kind?: CampaignKind | null;
  },
): Promise<HuntRun> {
  const onEvent = opts.onEvent;
  const agentFactory = opts.agentFactory ?? defaultAgentFactory;
  const waveSize = opts.waveSize ?? HUNT_WAVE_SIZE;
  const concurrency = opts.concurrency ?? HUNT_CONCURRENCY;
  const kind = opts.kind ?? HUNT_KIND;

  let run = opts.run ?? null;
  if (run === null) {
    run = new HuntRun(target, caseDir(cfg, target, kind));
  }
  if (opts.stop != null) run.stop = opts.stop;
  run.kind = kind.name;

  // The wave to run. `run.wave` is set to one *below* it, because the loop
  // increments before it plans — so the counter the UI and the artefacts see
  // is exactly the wave the operator asked for.
  let waveNumber = opts.waveNumber ?? null;
  if (waveNumber === null) waveNumber = nextWaveNumber(run.directory);
  run.wave = Math.max(0, waveNumber - 1);

  // A wave is a step, not a label: the planner is briefed on what the
  // previous wave found, so wave 3 on a scope that has run nothing is not
  // wave 3, it is wave 1 with a misleading name and a planner told to follow
  // up on findings that do not exist. Refuse it rather than run it —
  // `nextWaveNumber` is what the operator wants in that case, and `--wave`
  // is for re-running or reordering a campaign that already has a history.
  const highest = nextWaveNumber(run.directory) - 1;
  if (waveNumber > highest + 1) {
    await onEvent({
      type: 'hunt_refused',
      target: run.target,
      wave: waveNumber,
      highest,
      message: highest > 0
        ? `wave ${waveNumber} has nothing to follow: this scope has run `
          + `up to wave ${highest}. A wave is planned against the one before `
          + `it, so run wave ${highest + 1} first — plain `
          + `/${kind.command} ${run.target} does exactly that.`
        : `wave ${waveNumber} has nothing to follow: this scope has not `
          + `run a wave yet. Start with /${kind.command} ${run.target}.`,
    });
    return run;
  }

  // ---- recon, or the recon we already have.
  //
  // The campaign directory is the scope's and is reused, so a second
  // `/bug-hunt` on the same target finds the first run's notes sitting
  // there. Remapping a target that has not moved costs minutes of wall-clock
  // and a wave's worth of tokens before the first brief is written, so a
  // repeat run plans against the notes on disk instead. `fresh` is the
  // operator's override — `/bug-hunt --fresh` — for when the target HAS
  // moved.
  const note = opts.fresh ? undefined : findRecon(run.directory);
  if (note !== undefined) {
    run.recon = note.text;
    run.reconSource = note.path;
    run.reconAge = note.age;
  } else {
    // Runs in the session's own mode, not read-only: mapping a live target
    // needs the shell and the network tools, and a recon phase that cannot
    // scan is not recon. The prompt is what bounds it to reconnaissance, not
    // the mode.
    await onEvent({
      type: 'hunt_recon_start',
      target,
      directory: run.directory,
    });
    // canReport, so recon's report_finding calls publish live like a wave
    // agent's. The final-text harvest below still runs: it catches a recon
    // that reported in its closing JSON but never called the tool.
    // The interlock rides on recon too. Recon is where a null session or an
    // AS-REP roast happens, so it is exactly the phase that must not be
    // allowed to spray — an unthrottled recon turn is the one place a
    // campaign could lock out a domain before a single brief was written.
    const reconAgent = agentFactory(cloneConfig(cfg), {
      canReport: true,
      canHuntRead: false,
      toolHook: kind.interlock,
    });
    run.recon = await collectTextLive(
      reconAgent,
      fmt(kind.reconPrompt, { target, contract: kind.contract }),
      onEvent,
      run,
      'recon',
    );
    // Written before the event, so the path can ride on it: the UI has the
    // campaign directory, but only the module knows what the file is called.
    const reconPath = writeRecon(run, run.recon);
    await onEvent({
      type: 'hunt_recon_done',
      text: run.recon,
      saved: reconPath ?? '',
    });

    // A recon run can itself turn up something — an exposed debug endpoint,
    // a stack trace in an error page. Harvest it before the first wave, or
    // the planner starts out blind to what recon already knew. Anything
    // recon already published through the tool is deduplicated away here.
    for (const f of parseFindings(run.recon, { wave: 0, agent: 'recon' })) {
      await reportLive(run, f, onEvent);
    }
  }

  // ---- seed the tracker from what earlier campaigns already confirmed.
  //
  // Whatever happened above — reused the map, or drew a fresh one — the bugs
  // this scope has already had are still open until someone closes them, and
  // the planner should aim at what is left rather than re-deriving it. The
  // seeding runs *after* recon so a bug this campaign re-confirmed is its
  // own (the dedupe keeps the first, and recon's came first). `--fresh`
  // seeds too: it carries no *map* — that is what fresh means — but the bugs
  // earlier campaigns confirmed are still open, and still not this
  // campaign's. The `carried` flag is what keeps every count honest, since
  // the tracker is now taller than what this run actually did.
  const prior = loadRun(run.directory);
  if (prior !== undefined) {
    for (const f of prior.findings) {
      f.carried = true;
      run.addFinding(f);
    }
  }
  run.reconCarried = run.findings.filter((f) => f.carried).length;

  // The UI is told the map was inherited — and how old it is — before the
  // first brief is written. There is no recon window to open, so without
  // this event the operator would see nothing at all between the banner and
  // wave 1.
  if (note !== undefined) {
    await onEvent({
      type: 'hunt_recon_skipped',
      target,
      path: note.path,
      ageDays: note.ageDays,
      carried: run.reconCarried,
      // The carried findings themselves, so the tracker can open with them
      // on the rail rather than filling in only as this campaign reports.
      // They are already in the run, so they are not announced as new.
      findings: run.ranked().map(findingDict),
    });
  }

  // ---- waves. Bounded, and still racing the operator's stop: `/stop-hunt`
  // mid-wave unwinds the agents rather than waiting out the slowest one.
  let wavesRun = 0;
  while (!run.stop.isSet() && wavesRun < Math.max(1, opts.maxWaves ?? 1)) {
    wavesRun += 1;
    run.wave += 1;
    const wave = run.wave;

    await onEvent({ type: 'hunt_wave_start', wave, size: waveSize });

    // Plan. Read-only, so the planner cannot start doing the work itself —
    // the same reason team.py forces its planner to plan mode. It is handed
    // the recon and the findings in its prompt, so it must not also read the
    // campaign directory: that would put the raw artefacts in front of it
    // alongside the digest, which is the same information twice.
    const planner = agentFactory(cloneConfig(cfg, { mode: 'plan' }), {
      canHuntRead: false,
      toolHook: kind.interlock,
    });
    const planPrompt = fmt(kind.plannerPrompt, {
      target,
      wave_size: waveSize,
      recon: run.recon || '(recon produced nothing)',
      recon_note: run.reusedRecon
        ? fmt(RECON_INHERITED_NOTE, { age_days: Math.floor((run.reconAge ?? 0) / 86400) })
        : '',
      findings: run.digest(),
      waves: run.waveDigest(),
      contract: kind.contract,
    });
    // Reported live, not collected silently. This turn is a real model call
    // over the whole recon, every finding so far and the wave history — tens
    // of seconds during which the wave view had no roster to draw and said
    // nothing, so the operator watched a blank screen while the briefs were
    // written. The events go out as `hunt_plan_*` and the wave view feeds
    // them to the planning feed.
    let planText = await collectTextLive(planner, planPrompt, onEvent, null, 'plan');
    let roster: Roster | null = parseRoster(planText, waveSize);

    // One retry before giving up on the planner. A model that answered in
    // prose or wrapped the object in a fence it malformed usually gets it
    // right when told plainly what was wrong, and a real roster is worth
    // far more than the fixed matrix. Streamed too, so a retry is not a
    // second unexplained silence.
    if (roster === null || rosterWorkers(roster).length === 0) {
      const retryText = await collectTextLive(
        planner,
        `${planPrompt}\n\n${PLANNER_RETRY_NUDGE}`,
        onEvent,
        null,
        'plan',
      );
      if (retryText.trim()) {
        planText = retryText;
        roster = parseRoster(retryText, waveSize);
      }
    }

    const fellBack = roster === null || rosterWorkers(roster).length === 0;
    // fellBack false implies roster is non-null (that is what fellBack means);
    // the binding exists because the correlation is invisible to the compiler.
    const active: Roster = fellBack ? fallbackRoster(wave, waveSize, kind) : (roster as Roster);

    // The plan lands on disk as it is announced, so a campaign's plans
    // accumulate beside its findings instead of dying with the event stream.
    writePlan(run, wave, active, planText, fellBack);

    const workers = rosterWorkers(active);
    await onEvent({
      type: 'hunt_plan',
      wave,
      summary: rosterSummary(active),
      fellBack,
      // When the planner could not be read, hand the operator what it
      // actually said. Silently swapping in the fixed matrix hides whether
      // the fault is the prompt, the model, or a truncated turn — and that
      // is not diagnosable from the outside.
      raw: fellBack ? planText : '',
      workers: workers.map((w) => ({ name: w.name, brief: w.brief, owns: [...w.owns] })),
    });

    if (run.stop.isSet()) break;

    // Taken before the wave so the wave's own count can be measured as a
    // delta: a finding reported live through report_finding is already in
    // the tracker by the time the wave ends, so counting only the harvest
    // below would report a wave that published a critical as "0 finding(s)".
    const before = run.findings.length;

    const results = await runWave(workers, cfg, {
      onEvent,
      agentFactory,
      stop: run.stop,
      concurrency,
      context: briefContext(run),
      contract: kind.contract,
      wave,
      run,
      interlock: kind.interlock,
    });

    // ---- harvest. Most findings already reached the tracker through
    // report_finding while the wave was running — that is the live path, and
    // addFinding has seen them. This sweep is the backstop for an agent that
    // reported only in its closing JSON, and it is what keeps the planner's
    // digest complete even when the tool was not called.
    const found: Finding[] = [];
    for (const r of results) {
      found.push(...parseFindings(r.digest, { wave, agent: r.spec.name }));
    }

    for (const r of results) {
      await onEvent({
        type: 'hunt_agent_done',
        name: r.spec.name,
        wave,
        ok: r.ok,
        error: r.error,
        cost: r.cost,
        input: r.inputTokens,
        output: r.outputTokens,
      });
    }

    // `found` is every finding reported this wave; `newly` is the ones the
    // tracker had not already seen. Only the new ones are announced, and the
    // wave counter uses them too, so a bug three agents each rediscovered
    // reads as one finding rather than three — and a bug an agent already
    // published live through report_finding is not announced a second time
    // here.
    const newly: Finding[] = [];
    for (const f of found) {
      if (run.addFinding(f)) newly.push(f);
    }
    for (const f of newly) {
      await onEvent({ type: 'hunt_finding', finding: findingDict(f), saved: save(run, f) });
    }

    // The wave's count is the tracker's growth, not the harvest's size: a
    // finding that arrived live was counted the moment it was published, so
    // the two paths have to be reconciled here or the wave reads as finding
    // nothing. The dedupe in addFinding already guarantees no finding is
    // counted on both paths, so the delta is exact.
    const thisWave = run.findings.length - before;

    const ok = results.filter((r) => r.ok).length;
    run.waves.push(
      `wave ${wave}: ${workers.length} agents, ${ok} ok, `
        + `${thisWave} finding(s)`
        + (fellBack ? ' (fixed vector fallback)' : ''),
    );
    run.waveRecords.push(
      new WaveRecord({
        number: wave,
        agents: workers.length,
        fellBack,
        summary: rosterSummary(active) || '',
        stamp: stamp(),
      }),
    );
    await onEvent({
      type: 'hunt_wave_end',
      wave,
      agents: workers.length,
      ok,
      found: thisWave,
      cost: results.reduce((acc, r) => acc + r.cost, 0),
      input: results.reduce((acc, r) => acc + r.inputTokens, 0),
      output: results.reduce((acc, r) => acc + r.outputTokens, 0),
      fellBack,
    });

    // ---- the queued summary, run here: between waves nothing else is
    // streaming, so it cannot corrupt the transcript.
    if (opts.summaryFlag != null && opts.summaryFlag()) {
      const text = await collectText(agentFactory(cloneConfig(cfg)), summaryPrompt(run, kind));
      const p = writeSummary(cfg, run, text);
      await onEvent({ type: 'hunt_summary_done', path: p, text, wave });
    }
  }

  // The tracker holds carried findings too, so the closing counts are split:
  // `findings`/`saved` are what *this* campaign did, and `carried` is what it
  // inherited. Reporting the tracker's total as the campaign's haul would
  // claim bugs this run never found. Keyed off the flag rather than a count,
  // so it stays right however dedupe interleaved the two.
  const own = run.findings.filter((f) => !f.carried);
  await onEvent({
    type: 'hunt_end',
    wave: run.wave,
    findings: own.length,
    saved: own.filter((f) => f.saved).length,
    carried: run.findings.length - own.length,
    directory: run.directory,
    // Which command ran it, so the UI's notice to the main agent names the
    // campaign that actually happened rather than assuming `/bug-hunt`.
    command: kind.command,
  });
  return run;
}

/**
 * The closing brief: everything the run knows, for the final report.
 *
 * `kind` selects the prompt template. Null means HUNT_KIND — the default,
 * and what every existing caller gets — so `/bug-hunt`'s report is
 * byte-identical to what it shipped. `/ad` passes its own kind, whose
 * template asks for the AD-specific framing: what the domain's exposure is,
 * and which attack paths were proven rather than merely indicated.
 */
export function summaryPrompt(run: HuntRun, kind: CampaignKind | null = null): string {
  const k = kind ?? HUNT_KIND;
  let findings: string;
  if (run.findings.length > 0) {
    const blocks: string[] = [];
    for (const f of run.ranked()) {
      blocks.push(
        `### [${f.severity}] ${f.title}\n`
          + `asset: ${f.asset || '(not stated)'}\n`
          + `found by: ${f.agent} (wave ${f.wave})\n\n`
          + `${f.summary || '(no summary)'}\n\n`
          + `evidence: ${f.evidence || '(none recorded)'}\n\n`
          + `suggested fix: ${f.remediation || '(none)'}`,
      );
    }
    findings = blocks.join('\n\n');
  } else {
    findings = '(no findings were confirmed)';
  }

  return fmt(k.summaryPrompt, {
    target: run.target,
    waves: run.waveDigest(),
    recon: run.recon || '(recon produced nothing)',
    findings,
  });
}

// === SECTION === 13. Recovery (findRecon / loadRun)

/**
 * Recon already on disk for a scope, as a repeat hunt finds it.
 *
 * `text` is the recon body with its frontmatter and heading stripped, ready
 * to hand straight to a planner or a summary — the same reduction `loadRun`
 * makes. `age` is seconds since the file was written, which is what the UI
 * quotes so the operator can judge whether the map is still worth trusting.
 */
export class ReconNote {
  text: string;
  path: string;
  age: number;

  constructor(init: { text: string; path: string; age: number }) {
    this.text = init.text;
    this.path = init.path;
    this.age = init.age;
  }

  /** Whole days since the recon was written, for the operator's notice. */
  get ageDays(): number {
    return Math.floor(this.age / 86400);
  }
}

/**
 * Python's `str.split(sep, maxsplit)`: at most `max` splits, the remainder
 * kept whole as the last element. Used to replicate exactly how
 * `reconBody`'s Python original chopped a recon file (splitting on the
 * frontmatter fence AND the first `---` rule in the body) — a plain
 * JavaScript split would behave differently on bodies containing horizontal
 * rules.
 */
function splitMax(s: string, sep: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < max) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

/**
 * Strip a recon file's frontmatter and heading, leaving the notes.
 *
 * Shared by `findRecon` and `loadRun` so a reused recon and a recovered
 * summary read back identically — they are the same file read for two
 * reasons, and a second parser would drift from the first.
 */
function reconBody(text: string): string {
  const parts = text.startsWith('---') ? splitMax(text, '\n---', 2) : [text];
  let body = (parts[parts.length - 1] ?? '').trim();
  // A heading with nothing under it is not a map — strip the heading and the
  // empty body is the answer. The `\n` guard matters: splitting a lone
  // "# Recon" on its newline would hand back the heading itself, and a
  // caller would take it for content.
  if (body.startsWith('# ') && body.includes('\n')) {
    body = body.slice(body.indexOf('\n') + 1);
  } else if (body.startsWith('# ')) {
    body = '';
  }
  return body.trim();
}

/**
 * The newest recon already recorded for a scope, or undefined.
 *
 * This is what makes a repeat `/bug-hunt` skip the recon phase: the campaign
 * directory is the scope's and is reused, so a second run finds the first
 * run's notes sitting there and can plan a wave against them instead of
 * spending minutes remapping a target that has not moved.
 *
 * Newest by filename, not mtime — `recon-<stamp>.md` sorts by the timestamp
 * it carries, and the same convention already orders a campaign's artefacts.
 * Returns undefined when the directory holds no recon, or holds only an
 * empty one; an empty recon is not something to plan against, and re-running
 * is the honest answer.
 */
export function findRecon(directory: string): ReconNote | undefined {
  if (!isDir(directory)) return undefined;
  const names = fs
    .readdirSync(directory)
    .filter((n) => /^recon-.*\.md$/.test(n))
    .sort()
    .reverse();
  for (const name of names) {
    const p = path.join(directory, name);
    let text: string;
    try {
      text = readTextBestEffort(p);
    } catch {
      continue;
    }
    const body = reconBody(text);
    if (!body) continue;
    let age = 0.0;
    try {
      age = Math.max(0.0, Date.now() / 1000 - (fs.statSync(p).mtimeMs / 1000));
    } catch {
      age = 0.0;
    }
    return new ReconNote({ text: body, path: p, age });
  }
  return undefined;
}

/**
 * Rebuild a run from an archived campaign directory.
 *
 * Used by `/summary-hunt` when no hunt is live: the findings are re-read
 * from the report files rather than kept in memory, so a summary can be
 * asked for after a restart, or for a campaign that ran in an earlier
 * session. Returns undefined when the directory holds nothing to summarise.
 */
export function loadRun(directory: string): HuntRun | undefined {
  if (!isDir(directory)) return undefined;

  const findings: Finding[] = [];
  for (const p of findingFiles(directory)) {
    const text = readTextBestEffort(p);
    const meta = readFrontmatter(text);
    findings.push(
      new Finding({
        wave: asInt(meta['wave']),
        agent: meta['agent'] ?? '?',
        title: firstHeading(text) || path.basename(p, path.extname(p)),
        severity: normaliseSeverity(meta['severity'] ?? 'info'),
        asset: meta['asset'] ?? '',
        summary: sectionOf(text, 'Summary'),
        evidence: sectionOf(text, 'Evidence'),
        remediation: sectionOf(text, 'Remediation'),
      }),
    );
  }

  // Recon comes back too, from the newest notes file. Without this a summary
  // asked for after a restart quoted "recon produced nothing" over a recon
  // that had mapped the whole target — the recon is usually the most
  // informative part of the run, and it is now on disk to be read back.
  let recon = '';
  const note = findRecon(directory);
  if (note !== undefined) {
    recon = note.text;
  }

  // The plans are read back as the wave history, so a recovered summary can
  // say what each wave was aimed at rather than only what it found. Both
  // layouts are read — see `planFiles` — so a campaign the boot migration
  // has not reached yet still recovers its history.
  //
  // One record per *wave*, not per plan. A wave that was deliberately re-run
  // leaves every plan on disk — that is the operator's record, and `unique`
  // is what keeps them — but a wave is one thing, and counting plans made a
  // report claim "16 waves" over an 11-wave campaign whose wave 1 had been
  // run three times. The latest run of a wave wins.
  //
  // "Latest" is the pair of the frontmatter timestamp and the write order,
  // because neither alone is enough. Two runs inside the same second share a
  // timestamp; and the filename cannot break that tie, since `unique` names
  // the *second* plan `plan-2.md`, which sorts *before* `plan.md` — filename
  // order picks the oldest. `planSeq` reads that counter back out, so the
  // pair is a total order that matches the order the plans were written in.
  const best = new Map<number, { order: [string, number]; record: WaveRecord }>();
  // The doctrine, taken from the newest plan that names one. Defaulted below
  // to "hunt" so every campaign written before the field existed — which is
  // every campaign on disk today — reads back as the web hunt it was.
  let kindName = '';
  let kindOrder: [string, number] = ['', 0];
  for (const p of planFiles(directory)) {
    const text = readTextBestEffort(p);
    const meta = readFrontmatter(text);
    const record = new WaveRecord({
      number: asInt(meta['wave'], 0),
      agents: asInt(meta['agents'], 0),
      fellBack: (meta['fell_back'] ?? 'false').trim().toLowerCase() === 'true',
      // The first prose paragraph, which is where writePlan puts the
      // planner's summary of what the wave is for. The heading line above it
      // is the wave's agent count, which `agents` already carries.
      summary: planSummary(text),
      stamp: meta['timestamp'] ?? '',
    });
    const order: [string, number] = [record.stamp, planSeq(p)];
    const seen = best.get(record.number);
    if (seen === undefined || order >= seen.order) {
      best.set(record.number, { order, record });
    }
    const k = (meta['kind'] ?? '').trim();
    if (k && order >= kindOrder) {
      kindName = k;
      kindOrder = order;
    }
  }
  const records = [...best.keys()].sort((a, b) => a - b).map((n) => {
    return (best.get(n) as { order: [string, number]; record: WaveRecord }).record;
  });

  // How many findings each wave actually produced, so a recovered digest can
  // say what a wave found as well as what it aimed at. Counted off the
  // findings, not the plan: a plan records intent, and the finding is the
  // only evidence that the intent was met.
  const perWave = new Map<number, number>();
  for (const f of findings) {
    perWave.set(f.wave, (perWave.get(f.wave) ?? 0) + 1);
  }

  const waves = [`(recovered from ${directory})`];
  for (const r of records) waves.push(r.line(perWave.get(r.number) ?? 0));

  // A wave that ran and found nothing still leaves a plan, and that is now a
  // state the operator reaches routinely: one wave per invocation means an
  // empty wave is the *expected* way to end a campaign. Refusing to load it
  // would make `/summary-hunt` say "no campaign here" over a directory whose
  // tree plainly shows ten agents went out — so a plan counts as content.
  if (findings.length === 0 && !recon && records.length === 0) return undefined;

  return new HuntRun(path.basename(directory), directory, {
    recon,
    findings,
    waves,
    waveRecords: records,
    kind: kindName || 'hunt',
    // So `--wave` on a recovered campaign continues its numbering rather
    // than restarting at 1 and overwriting what is on disk. The highest wave
    // anything on disk names, plan or finding.
    wave: Math.max(0, ...findings.map((f) => f.wave), ...records.map((r) => r.number)),
  });
}

/**
 * The write order of a plan, read back out of its `unique` suffix.
 *
 * `plan.md` is the first run of a wave and scores 1; `plan-2.md` is the
 * second and scores 2. `loadRun` uses this only as a tiebreak, for plans
 * written inside the same second — but it is the *right* tiebreak, because
 * the number was assigned in the order the files were created, and it is the
 * one piece of ordering `unique` records. A name it did not produce scores
 * 0, so a hand-made file never displaces a real run — except that, as in the
 * Python original, an unsuffixed hand-made `plan.md` scores 1 like a real
 * first run; only suffixed names are read.
 */
function planSeq(p: string): number {
  const m = /-(\d+)$/.exec(path.basename(p, path.extname(p)));
  return m ? Number.parseInt(m[1] as string, 10) : 1;
}

/**
 * The planner's own summary of a wave, out of a plan file.
 *
 * `writePlan` writes the heading, then the roster's summary as a plain
 * paragraph, then `## Roster`. This takes everything between them, so the
 * summary reads back whole even when it is several lines.
 */
function planSummary(text: string): string {
  const after = splitMax(text, '\n# ', 1);
  if (after.length < 2) return '';
  let body = after[1] ?? '';
  const nl = body.indexOf('\n');
  body = nl >= 0 ? body.slice(nl + 1) : '';
  const fence = body.indexOf('\n## ');
  if (fence >= 0) body = body.slice(0, fence);
  return body.trim();
}

function asInt(value: unknown, defaultValue: number = 0): number {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(n) ? defaultValue : n;
}

/**
 * The YAML frontmatter of a report file, as flat strings.
 *
 * Hand-rolled rather than pulling in a YAML dependency: the frontmatter this
 * module writes is a flat map of scalars, and that is all it needs to read.
 */
function readFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    if (!line.includes(':')) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return '';
}

/** The body under `## <name>`, up to the next heading. */
function sectionOf(text: string, name: string): string {
  const marker = `## ${name}`;
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const nl = text.indexOf('\n', start);
  if (nl < 0) return '';
  const rest = text.slice(nl + 1);
  const end = rest.indexOf('\n## ');
  const body = end < 0 ? rest : rest.slice(0, end);
  return body.trim();
}
