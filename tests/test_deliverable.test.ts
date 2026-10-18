/**
 * tests/test_deliverable.test.ts — vitest port of tests/test_deliverable.py.
 *
 * What this suite is: the regression suite for the deliverable check in
 * `Agent.runTurn`. The original failure: `/osint instagram zimthegoat` ran
 * every phase, wrote 6 MB of real evidence, printed "All phases complete.
 * Writing the report." as plain text — and stopped. No report.md was ever
 * written. The loop broke on "no tool calls", which is right for a chat turn
 * and wrong for a turn whose whole purpose is to leave a file behind; nothing
 * distinguished "the model finished" from "the model stopped mid-task", and
 * `stop_reason` was read nowhere.
 *
 * Behaviours pinned (from the Python original):
 *  1. A turn that declares a deliverable and stops without writing it is
 *     nudged, up to its budget, and no further.
 *  2. When the budget is spent the turn says plainly that the file is
 *     missing (`written: false`) rather than ending as though it succeeded.
 *  3. A model that writes the file after a nudge ends with `written: true`.
 *  4. A finish at the token ceiling is reported as `truncated` and is NOT
 *     nudged — re-prompting a model cut off mid-Write just spends another
 *     ceiling on the same truncation.
 *  5. A finish at the ceiling that carried nothing at all is a different
 *     shape: `reasoning_exhausted`, retried once with a doubled ceiling.
 *
 * Invariants of the port:
 *  - No network: the private `Agent.streamOnce` is shadowed on the instance
 *    with a stub generator yielding canned [event, message] pairs, exactly as
 *    the Python suite replaced `agent._stream_once`. The message objects only
 *    need the fields runTurn reads (content / stop_reason / usage).
 *  - Event payload keys are the camelCase TS contract from src/shared.ts
 *    (`maxTokens`, `retryTokens`) — the Python snake_case equivalents
 *    (`max_tokens`, `retry_tokens`) do not exist here.
 *  - Each test gets its own directory: the deliverable check keys on the file
 *    existing, so a shared one would leak between tests.
 */

import { expect, describe, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, deliverable } from '../src/agent.js';
import { Config } from '../src/config.js';
import type { AgentEvent, Deliverable } from '../src/shared.js';

// === SECTION === stub plumbing (Python _Blk/_Msg/_stub) ===

/** A content block: text, or a tool_use. Only the fields runTurn reads. */
interface StubBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** A final message, with the `stop_reason` the fix depends on. */
interface StubMessage {
  content: StubBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

/** The yield shape of Agent.streamOnce: [event, finalMessage], one null. */
type StubYield = [AgentEvent | null, StubMessage | null];

function cfgFor(workdir: string, kw: Partial<Config> = {}): Config {
  return Config.fromEnv({ workdir, apiKey: 'x', baseUrl: 'http://localhost:4001', ...kw });
}

/** A reply that is pure narration — no tool call. The failing shape. */
function textMsg(msg: string, stopReason: string | null = null): StubMessage {
  return { content: [{ type: 'text', text: msg }], stop_reason: stopReason };
}

/**
 * A truncated reply that carries nothing: the reasoning-exhaustion shape.
 *
 * What a reasoning model looks like through a proxy that does not forward its
 * thinking — one text block holding an empty string, and no tool call. The
 * budget went somewhere the harness never sees. Measured, not imagined.
 */
function emptyMsg(stopReason = 'max_tokens'): StubMessage {
  return { content: [{ type: 'text', text: '' }], stop_reason: stopReason };
}

/**
 * A reply that calls the real write tool.
 *
 * The tool is `write_file`, not `write`: naming a tool that does not exist is
 * not a silent no-op here, it produces an unknown-tool error the model retries
 * forever, which is exactly what the 40-call runaway this test first showed
 * was.
 */
function writeMsg(reportPath: string, body = 'the report'): StubMessage {
  return {
    content: [
      { type: 'text', text: 'Writing the report.' },
      {
        type: 'tool_use',
        id: 't-write',
        name: 'write_file',
        input: { path: reportPath, content: body },
      },
    ],
    stop_reason: 'tool_use',
  };
}

/**
 * A terminal narration with no tool call: the turn ends here.
 *
 * A real model stops after a successful write; a stub that keeps serving the
 * write call does not. Every turn expected to *finish* must end its list with
 * this, or the loop correctly keeps going and the call count is meaningless.
 */
function doneMsg(msg = 'Done — the report is written.'): StubMessage {
  return { content: [{ type: 'text', text: msg }], stop_reason: 'end_turn' };
}

interface StubState {
  n: number;
  ceilings: (number | undefined)[];
}

/**
 * Serve *messages* in order, recording how many were consumed.
 *
 * Past the end it keeps serving the last message. That is deliberate: a loop
 * that fails to break then shows up as a runaway call count rather than a
 * StopIteration swallowed into an "error" event. The consequence is that a
 * test whose turn is meant to *finish* must end its list with a turn that
 * carries no tool call — see doneMsg().
 */
function stub(agent: Agent, messages: StubMessage[]): StubState {
  const state: StubState = { n: 0, ceilings: [] };
  async function* fake(maxTokens?: number): AsyncGenerator<StubYield> {
    // The ceiling is recorded, not ignored: the reasoning-exhaustion retry is
    // only correct if the second call actually asks for more room than the
    // first, and a stub that swallows the argument would hide a retry that
    // re-sent the same ceiling.
    state.ceilings.push(maxTokens);
    const i = state.n;
    state.n += 1;
    if (i < messages.length) {
      yield [null, messages[i]!];
    } else {
      yield [null, messages[messages.length - 1]!];
    }
  }
  (agent as unknown as { streamOnce: unknown }).streamOnce = fake;
  return state;
}

/** Run one turn and collect every event. */
async function drive(agent: Agent, text: string, deliverableSpec: Deliverable | null) {
  const events: AgentEvent[] = [];
  for await (const ev of agent.runTurn(text, deliverableSpec ?? undefined)) {
    events.push(ev);
  }
  return events;
}

function kinds(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

function caseDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'andy-deliverable-'));
}

// === SECTION === the tests ===

describe('test_deliverable', () => {
  it('narrate_then_narrate_gives_up_honestly: the exact failure — narration, no write. Nudged twice, then honest.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 2);
    const state = stub(agent, [textMsg('All phases complete. Writing the report.')]);

    const events = await drive(agent, 'do the recon', spec);
    const ks = kinds(events);

    const nudges = events.filter((e) => e.type === 'nudged');
    expect(nudges.length, 'narrate: the model was nudged').toBe(2);
    expect(
      nudges.every((e) => e.type === 'nudged' && e.label === 'report.md'),
      'narrate: the nudge names the label',
    ).toBe(true);
    expect(
      nudges.map((e) => (e.type === 'nudged' ? e.attempt : 0)),
      'narrate: the nudge counts up',
    ).toEqual([1, 2]);
    expect(state.n, 'narrate: it stopped after the budget, not before').toBe(3);

    const final = events.filter((e) => e.type === 'deliverable');
    expect(final.length, 'narrate: a deliverable event was emitted').toBe(1);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].written === false,
      'narrate: the deliverable is reported NOT written',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].path === report,
      'narrate: the deliverable names the path',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].nudges === 2,
      'narrate: the nudge count is reported',
    ).toBe(true);
    expect(existsSync(report), 'narrate: the file really was not written').toBe(false);
    expect(
      ks.filter((k) => k === 'deliverable').length === 1 && !ks.includes('error'),
      'narrate: the turn still ended cleanly',
    ).toBe(true);
  });

  it('a_nudged_model_can_recover: narration, then a nudge, then the file — written: true, one nudge.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 2);
    const state = stub(agent, [
      textMsg('All phases complete. Writing the report.'),
      writeMsg(report),
      doneMsg(),
    ]);

    const events = await drive(agent, 'do the recon', spec);
    const nudges = events.filter((e) => e.type === 'nudged');
    const final = events.filter((e) => e.type === 'deliverable');

    expect(nudges.length, 'recover: exactly one nudge was needed').toBe(1);
    expect(existsSync(report), 'recover: the file exists on disk').toBe(true);
    expect(
      existsSync(report) && readFileSync(report, 'utf8').includes('the report'),
      'recover: it holds what the tool call said',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].written === true,
      'recover: the deliverable is reported written',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].nudges === 1,
      'recover: the nudge count is reported',
    ).toBe(true);
    expect(state.n, 'recover: no wasted extra call').toBe(3);
  });

  it('a_first_try_write_is_not_nudged: the happy path must be untouched by any of this.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 2);
    const state = stub(agent, [writeMsg(report), doneMsg()]);

    const events = await drive(agent, 'do the recon', spec);
    const final = events.filter((e) => e.type === 'deliverable');

    expect(kinds(events).includes('nudged'), 'happy: no nudge on a first-try write').toBe(false);
    expect(state.n, 'happy: write then stop — two calls, no retry loop').toBe(2);
    expect(existsSync(report), 'happy: the file exists').toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].written === true,
      'happy: the deliverable is reported written',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].nudges === 0,
      'happy: the nudge count is zero',
    ).toBe(true);
  });

  it('a_truncated_finish_is_not_nudged: a ceiling hit is reported as truncation, never re-prompted.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 2);
    const state = stub(agent, [textMsg('The report is lengthy and I was cut', 'max_tokens')]);

    const events = await drive(agent, 'do the recon', spec);
    const ks = kinds(events);
    const trunc = events.filter((e) => e.type === 'truncated');
    const final = events.filter((e) => e.type === 'deliverable');

    // The branch that makes the two failures distinguishable: the model was
    // cut off mid-Write, so the tool call never reached final.content and the
    // loop sees no tool call — exactly like a model that stopped. Without the
    // stop_reason check the two are the same thing, and nudging just burns
    // another ceiling producing the same truncation.
    expect(trunc.length, 'truncated: a truncated event was emitted').toBe(1);
    expect(
      trunc[0] && trunc[0].type === 'truncated' && trunc[0].maxTokens === agent.cfg.maxTokens,
      'truncated: it names the ceiling',
    ).toBe(true);
    expect(ks.includes('nudged'), 'truncated: it was NOT nudged').toBe(false);
    expect(state.n, 'truncated: it did not spend a second call').toBe(1);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].written === false,
      'truncated: the deliverable is still reported missing',
    ).toBe(true);
    expect(
      final[0] && final[0].type === 'deliverable' && final[0].nudges === 0,
      'truncated: zero nudges are reported',
    ).toBe(true);
    expect(
      ks.includes('reasoning_exhausted'),
      'truncated: a mid-Write cut is NOT the empty shape',
    ).toBe(false);
  });

  it('an_empty_truncation_retries_with_more_room: a truncated reply carrying nothing is retried, not dropped.', async () => {
    const tmp = caseDir();
    const agent = new Agent(cfgFor(tmp));
    const state = stub(agent, [
      emptyMsg(),
      doneMsg('We are on wave 7 of the x.test campaign.'),
    ]);

    // The failure this pins: "so where are we ?" came back as "reply
    // truncated at 32768 output tokens" with no reply above it. The model was
    // a reasoning model, its thinking is billed against max_tokens, and the
    // proxy forwards none of it — so the harness was handed an empty turn.
    const events = await drive(agent, 'so where are we ?', null);
    const ks = kinds(events);
    const exh = events.filter((e) => e.type === 'reasoning_exhausted');

    expect(exh.length, 'empty: the empty truncation was named').toBe(1);
    expect(ks.includes('truncated'), 'empty: it is not called a mid-Write truncation').toBe(false);
    expect(
      exh[0] && exh[0].type === 'reasoning_exhausted' && exh[0].maxTokens === agent.cfg.maxTokens,
      'empty: it names the ceiling that was spent',
    ).toBe(true);
    expect(
      exh[0] &&
        exh[0].type === 'reasoning_exhausted' &&
        exh[0].retryTokens === agent.cfg.maxTokens * 2,
      'empty: it says what it is retrying with',
    ).toBe(true);
    expect(state.n, 'empty: it spent exactly two calls').toBe(2);
    expect(
      state.ceilings.length === 2 && state.ceilings[1]! > state.ceilings[0]!,
      'empty: the retry actually asked for more room',
    ).toBe(true);
    expect(agent.messages.length, 'empty: the blank turn was dropped from the history').toBe(2);
    expect(ks.includes('error'), 'empty: the turn ended without error').toBe(false);
  });

  it('a_second_empty_truncation_stops_honestly: the retry is bounded — double once, then say so, never a loop.', async () => {
    const tmp = caseDir();
    const agent = new Agent(cfgFor(tmp));
    const state = stub(agent, [emptyMsg()]);

    const events = await drive(agent, 'so where are we ?', null);
    const ks = kinds(events);
    const exh = events.filter((e) => e.type === 'reasoning_exhausted');

    // A model that spends a doubled ceiling on reasoning and still emits
    // nothing is not going to answer on a third attempt, so the second one is
    // reported rather than retried. The history must be left clean too: the
    // turn ends on the user's message, with no blank assistant reply carried
    // into the next request.
    expect(exh.length, 'empty x2: both attempts were reported').toBe(2);
    expect(
      exh[0] &&
        exh[0].type === 'reasoning_exhausted' &&
        exh[0].retryTokens === agent.cfg.maxTokens * 2,
      'empty x2: the first offered the retry',
    ).toBe(true);
    expect(
      exh.length === 2 &&
        exh[1]!.type === 'reasoning_exhausted' &&
        exh[1]!.retryTokens === null,
      'empty x2: the second offered no further retry',
    ).toBe(true);
    expect(state.n, 'empty x2: it stopped after two calls').toBe(2);
    expect(agent.messages.length, 'empty x2: the history is left clean').toBe(1);
    expect(ks.includes('error'), 'empty x2: the turn ended without error').toBe(false);
  });

  it('a_truncation_after_a_nudge_still_stops: nudge once, then truncate — it must stop, not nudge again.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 2);
    const state = stub(agent, [
      textMsg('All phases complete. Writing the report.'),
      textMsg('Now writing the full report, which is long', 'max_tokens'),
    ]);

    const events = await drive(agent, 'do the recon', spec);
    const ks = kinds(events);
    expect(ks.filter((k) => k === 'nudged').length, 'nudge+truncate: one nudge was spent').toBe(1);
    expect(
      ks.filter((k) => k === 'truncated').length,
      'nudge+truncate: the truncation was reported',
    ).toBe(1);
    expect(state.n, 'nudge+truncate: the truncation ended it').toBe(2);
    const delivered = events.find((e) => e.type === 'deliverable');
    expect(
      delivered !== undefined && delivered.type === 'deliverable' && delivered.written === false,
      'nudge+truncate: the file is reported missing',
    ).toBe(true);
  });

  it('no_deliverable_means_no_change: a plain chat turn must behave exactly as it did before the fix.', async () => {
    const tmp = caseDir();
    const agent = new Agent(cfgFor(tmp));
    const state = stub(agent, [textMsg('Sure — here is the answer, no files needed.')]);

    // The whole risk of the fix is that it perturbs ordinary turns. A turn
    // with no deliverable that narrates and stops must end after one call,
    // with no nudge, no truncation and no deliverable event.
    const events = await drive(agent, 'just tell me something', null);
    const ks = kinds(events);

    expect(state.n, 'plain: one stream call').toBe(1);
    expect(ks.includes('nudged'), 'plain: no nudge').toBe(false);
    expect(ks.includes('deliverable'), 'plain: no deliverable event').toBe(false);
    expect(ks.includes('truncated'), 'plain: no truncation event').toBe(false);
    expect(ks.includes('error'), 'plain: it ended without error').toBe(false);
  });

  it('a_zero_nudge_budget_never_nudges: max_nudges=0 must mean zero — the boundary the caller could set.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 0);
    const state = stub(agent, [textMsg('All phases complete. Writing the report.')]);

    const events = await drive(agent, 'do the recon', spec);
    const final = events.filter((e) => e.type === 'deliverable');

    expect(kinds(events).includes('nudged'), 'budget 0: no nudge at all').toBe(false);
    expect(state.n, 'budget 0: one call only').toBe(1);
    expect(
      final[0] &&
        final[0].type === 'deliverable' &&
        final[0].written === false &&
        final[0].nudges === 0,
      'budget 0: the miss is still reported',
    ).toBe(true);
  });

  it('the_nudge_message_is_a_real_user_turn: appended as a user message, never smuggled into a system line.', async () => {
    const tmp = caseDir();
    const report = path.join(tmp, 'report.md');
    const agent = new Agent(cfgFor(tmp));
    const spec = deliverable(report, 'report.md', 1);
    stub(agent, [textMsg('All phases complete. Writing the report.')]);

    await drive(agent, 'do the recon', spec);

    // The history has to stay a clean user/assistant alternation, or the next
    // API call is rejected. The nudge must therefore be a genuine user
    // message — the same constraint notice() documents for why it folds
    // rather than appends.
    const roles = agent.messages.map((m) => m.role);
    const alternates = roles.slice(0, -1).every((r, i) => r !== roles[i + 1]);
    expect(alternates, 'history: it alternates user/assistant').toBe(true);
    expect(
      roles[0] === 'user' && agent.messages[0]!.content === 'do the recon',
      'history: it starts with the user\'s request',
    ).toBe(true);

    // The nudge is a real user message. It is NOT the last entry: the model's
    // final narration is appended before the loop breaks on a spent budget, so
    // the nudge sits second-to-last. Asserting its content rather than its
    // position is the point — the invariant is the alternation, not the tail.
    const nudges = agent.messages.filter(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('You stopped before writing'),
    );
    expect(nudges.length, 'history: the nudge is a real user message').toBe(1);
    expect(
      nudges.length === 1 &&
        typeof nudges[0]!.content === 'string' &&
        nudges[0]!.content.includes('report.md') &&
        nudges[0]!.content.includes(report),
      'history: the nudge names the label and the path',
    ).toBe(true);
  });
});
