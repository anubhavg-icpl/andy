// tests/test_agent_limits.test.ts — vitest port of tests/test_agent_limits.py.
// What this file is: the regression suite for the round caps, auto-continue and
// auto-compact. It pins the fix for a real reported failure — a turn that ran
// out of rounds fell out of the loop and yielded a plain turn_end, rendering
// exactly like a finished turn (the "idle loop" report). No network:
// Agent.streamOnce is replaced with a stub that yields canned messages, and
// compact() is faked; the bash tools that drive "progress" really execute
// (`true` succeeds, `false` fails), exactly as the Python suite did.
// Invariant kept from the original: a turn that stops at a limit must SAY so.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BadRequestError } from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { Agent } from '../src/agent.js';
import { Config } from '../src/config.js';
import type { AgentEvent, ChatMessage } from '../src/shared.js';

function tmpWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'andy-limits-'));
}

function cfgFor(workdir: string, overrides: Partial<Config> = {}): Config {
  return Config.fromEnv({
    workdir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
    ...overrides,
  });
}

/** The private seams the Python suite reached via _-prefixed attributes.
 *  agent.ts keeps them module-private per PORT-MAP; tests reach through this
 *  one cast so the dependency on each seam is visible in a single place. */
interface AgentSeams {
  streamOnce: (maxTokens?: number) => AsyncGenerator<[AgentEvent | null, Message | null]>;
  compact(): Promise<[boolean, string]>;
  shouldCompact(window: number): boolean;
  lastInputTokens: number;
}

function seams(agent: Agent): AgentSeams {
  return agent as unknown as AgentSeams;
}

interface UsageShape {
  input_tokens: number;
  output_tokens: number;
}

type MsgShape = {
  content: unknown[];
  stop_reason?: string | null;
  usage?: UsageShape | null;
};

function asMessage(shape: MsgShape): Message {
  return shape as unknown as Message;
}

/** A reply that calls a real tool, so the loop takes another round. */
function tool(name = 'bash', input?: Record<string, unknown>): Message {
  return asMessage({
    content: [
      {
        type: 'tool_use',
        id: `t-${name}`,
        name,
        input: input ?? { command: 'true' },
      },
    ],
    stop_reason: 'tool_use',
    usage: null,
  });
}

/** A tool call that will fail: `false` exits non-zero. */
function failTool(i = 0): Message {
  return asMessage({
    content: [
      { type: 'tool_use', id: `f-${i}`, name: 'bash', input: { command: 'false' } },
    ],
    stop_reason: 'tool_use',
    usage: null,
  });
}

/** A terminal narration with no tool call: the turn ends here. */
function done(msg = 'Done.'): Message {
  return asMessage({ content: [{ type: 'text', text: msg }], stop_reason: 'end_turn' });
}

/** Serve *messages* in order, recording how many were consumed.
 *
 *  Past the end it keeps serving the last message, so a loop that fails to
 *  break shows up as a runaway call count rather than a swallowed error. A
 *  turn meant to finish must therefore end its list with done(). *used* sets
 *  the reported input_tokens on every reply, which is what the auto-compact
 *  threshold reads. */
function stub(agent: Agent, messages: Message[], used = 0): { n: number } {
  const state = { n: 0 };
  const fake = async function* (): AsyncGenerator<[AgentEvent | null, Message | null]> {
    const i = state.n;
    state.n += 1;
    const msg = messages[Math.min(i, messages.length - 1)]!;
    const shape = msg as unknown as { usage?: UsageShape | null };
    if (shape.usage == null) {
      shape.usage = { input_tokens: used, output_tokens: 10 };
    }
    yield [null, msg];
  };
  seams(agent).streamOnce = fake;
  return state;
}

async function drive(agent: Agent, text = 'go'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.runTurn(text)) events.push(ev);
  return events;
}

function kinds(events: AgentEvent[]): string[] {
  return events.map((e) => e.type);
}

function of<T extends AgentEvent['type']>(
  events: AgentEvent[],
  kind: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === kind);
}

function seededHistory(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) out.push({ role: 'user', content: `m${i}` });
  return out;
}

describe('agent limits — the soft cap', () => {
  it('stuck at the soft cap is reported (the exact bug)', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { maxIterations: 3 });
    const agent = new Agent(cfg);
    // Every tool fails, so no round makes progress and the cap is obeyed.
    const state = stub(
      agent,
      Array.from({ length: 10 }, (_, i) => failTool(i)),
    );

    const events = await drive(agent);
    const ks = kinds(events);
    const caps = of(events, 'iteration_cap');

    expect(caps.length, 'stuck: an iteration_cap event was emitted').toBe(1);
    expect(caps[0]?.hard, 'stuck: it is the soft cap').toBe(false);
    expect(caps[0]?.limit, 'stuck: it names the limit it hit').toBe(3);
    expect(caps[0]?.rounds, 'stuck: it reports how many rounds ran').toBe(3);
    expect(ks.includes('iteration_cap'), 'stuck: the cap is NOT swallowed into a bare turn_end').toBe(true);
    expect(ks[ks.length - 1], 'stuck: it still ends the turn properly').toBe('turn_end');
    expect(state.n, 'stuck: it stopped at the cap, not later').toBe(3);
    expect(of(events, 'continuing').length, "stuck: no 'continuing' event when there is no progress").toBe(0);
  });

  it('a progressing turn continues past the cap (the long-task case)', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { maxIterations: 3, maxRounds: 12 });
    const agent = new Agent(cfg);
    // Nine successful tool rounds, then a terminal narration. With a 3-round
    // cap that is a continue at round 3, 6 and 9 — three of them, because the
    // cap is checked at each multiple and the turn is still progressing at
    // every one.
    const state = stub(agent, [...Array.from({ length: 9 }, () => tool()), done()]);

    const events = await drive(agent);
    const conts = of(events, 'continuing');

    expect(conts.length, 'progress: it continued past the soft cap').toBe(3);
    expect(
      conts.map((e) => e.continued),
      'progress: it continued once per cap crossed',
    ).toEqual([1, 2, 3]);
    expect(conts.every((e) => e.limit === 3), 'progress: each continue names the cap').toBe(true);
    expect(
      conts.map((e) => e.rounds),
      'progress: the rounds count up',
    ).toEqual([3, 6, 9]);
    expect(of(events, 'iteration_cap').length, 'progress: it did NOT stop at the soft cap').toBe(0);
    expect(state.n, 'progress: it ran past the cap and finished').toBe(10);
  });

  it('progress that stops is not carried past the cap', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { maxIterations: 3, maxRounds: 20 });
    const agent = new Agent(cfg);
    // Three good rounds (so round 3 continues), then failures forever.
    const state = stub(agent, [
      ...Array.from({ length: 3 }, () => tool()),
      ...Array.from({ length: 20 }, (_, i) => failTool(i)),
    ]);

    const events = await drive(agent);
    const conts = of(events, 'continuing');
    const caps = of(events, 'iteration_cap');

    expect(conts.length, 'stale: the first cap was passed through').toBe(1);
    expect(caps.length, 'stale: the second cap stopped it').toBe(1);
    expect(caps[0]?.rounds, 'stale: it stopped at round 6, the first cap after the failures').toBe(6);
    expect(state.n, 'stale: it did not run to the hard limit').toBe(6);
  });
});

describe('agent limits — the hard limit', () => {
  it('the hard limit is reported as hard', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { maxIterations: 2, maxRounds: 5 });
    const agent = new Agent(cfg);
    const state = stub(agent, Array.from({ length: 50 }, () => tool()));

    const events = await drive(agent);
    const caps = of(events, 'iteration_cap');
    const ks = kinds(events);

    expect(caps.length, 'hard: the hard cap was reported').toBe(1);
    expect(caps[0]?.hard, 'hard: it is flagged hard').toBe(true);
    expect(caps[0]?.limit, 'hard: it names maxRounds, not maxIterations').toBe(5);
    expect(state.n, 'hard: it ran exactly to the hard limit').toBe(5);
    expect(of(events, 'continuing').length, 'hard: the soft cap was passed through on the way').toBe(2);
    expect(ks[ks.length - 1], 'hard: the turn still ended').toBe('turn_end');
  });
});

describe('agent limits — auto-compact', () => {
  it('fires above the measured threshold, before the request it protects', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, {
      maxIterations: 2,
      autoCompact: true,
      compactAt: 0.5,
      contextWindow: 1_000,
    });
    const agent = new Agent(cfg);
    // 900 of a 1000 window is over the 0.5 threshold, so the *second* round
    // (the first has nothing measured yet) must compact before it requests.
    stub(agent, [tool(), done()], 900);

    // What each request actually saw. This is the assertion that matters: the
    // event stream cannot show "before the request" directly, because the
    // request is not itself an event — but the stub sees the history the
    // request was built from, so a compaction that ran too late shows up here
    // as a second call still carrying the full history.
    const seen: number[] = [];
    const original = seams(agent).streamOnce;
    const recording = async function* (): AsyncGenerator<
      [AgentEvent | null, Message | null]
    > {
      seen.push(agent.messages.length);
      yield* original();
    };
    seams(agent).streamOnce = recording;

    const compacted: string[] = [];
    seams(agent).compact = async () => {
      compacted.push('yes');
      // Stand in for the real thing, which replaces the history with a single
      // summary message — that shrink is what the assertion below measures.
      agent.messages = [{ role: 'user', content: '[summary]' }];
      return [true, 'a summary'];
    };
    // A history long enough that shouldCompact does not skip it.
    agent.messages = seededHistory(6);

    const events = await drive(agent);
    const ks = kinds(events);
    const compactings = of(events, 'compacting');
    const compacteds = of(events, 'compacted');

    expect(compacted.length, 'auto: history was compacted').toBe(1);
    expect(compactings.length, 'auto: a compacting event was emitted').toBe(1);
    expect(compactings[0]?.trigger, 'auto: it names the threshold as the trigger').toBe('threshold');
    expect(compacteds[0]?.ok, 'auto: a compacted event reports success').toBe(true);
    expect(compactings[0]?.used, 'auto: the events carry the measured prompt size').toBe(900);
    // The property: the *second* request went out with the compacted history,
    // so the compaction happened before it rather than after.
    expect(seen.length === 2 && seen[0] > 1, 'auto: the first request carried the full history').toBe(true);
    expect(seen.length === 2 && seen[1] === 1, 'auto: the second request carried the compacted history').toBe(true);
    expect(
      seen.length === 2 && seen[1] < seen[0],
      'auto: the compaction therefore preceded the request it protects',
    ).toBe(true);
    expect(compactings.length, 'auto: it was not compacted repeatedly').toBe(1);
    expect(ks[ks.length - 1], 'auto: the turn still completed').toBe('turn_end');
  });

  it('does not fire below the threshold', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, {
      maxIterations: 2,
      autoCompact: true,
      compactAt: 0.9,
      contextWindow: 1_000,
    });
    const agent = new Agent(cfg);
    stub(agent, [tool(), done()], 100); // 10% of the window

    const compacted: string[] = [];
    seams(agent).compact = async () => {
      compacted.push('yes');
      return [true, 'a summary'];
    };
    agent.messages = seededHistory(6);

    const events = await drive(agent);

    expect(compacted.length, 'auto: nothing compacted below the threshold').toBe(0);
    expect(of(events, 'compacting').length, 'auto: no compacting event below the threshold').toBe(0);
  });

  it('respects the off switch', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, {
      maxIterations: 2,
      autoCompact: false,
      compactAt: 0.5,
      contextWindow: 1_000,
    });
    const agent = new Agent(cfg);
    stub(agent, [tool(), done()], 900);

    const compacted: string[] = [];
    seams(agent).compact = async () => {
      compacted.push('yes');
      return [true, 'a summary'];
    };
    agent.messages = seededHistory(6);

    const events = await drive(agent);

    expect(compacted.length, 'auto: --no-auto-compact prevents it').toBe(0);
    expect(of(events, 'compacting').length, 'auto: and emits no event').toBe(0);
  });

  it('shouldCompact never fires without a measurement', () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { contextWindow: 1_000 });
    const agent = new Agent(cfg);
    agent.messages = seededHistory(6);
    seams(agent).lastInputTokens = 0;
    // No measurement must never trip the threshold — 0 is not "nearly full".
    expect(seams(agent).shouldCompact(1_000), 'auto: an unmeasured session does not compact').toBe(false);
    seams(agent).lastInputTokens = 950;
    expect(seams(agent).shouldCompact(1_000), 'auto: a measured one over the threshold does').toBe(true);
  });

  it('shouldCompact skips a short history', () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { contextWindow: 1_000, compactAt: 0.5 });
    const agent = new Agent(cfg);
    seams(agent).lastInputTokens = 900;
    agent.messages = [{ role: 'user', content: 'one' }];
    // compact() would refuse a short history, so do not emit a no-op event.
    expect(seams(agent).shouldCompact(1_000), 'auto: a too-short history is not compacted').toBe(false);
  });
});

// === SECTION === overflow: detected, compacted, retried once ===

/** The SDK error the gateway's 400 would actually produce (the class matters —
 *  Agent.friendlyError dispatches on instanceof). Headers are an empty set;
 *  friendlyError never reads them. */
function overflowError(text: string): BadRequestError {
  const ctor = BadRequestError as unknown as new (
    status: number,
    error: object,
    message: undefined,
    headers: undefined,
  ) => BadRequestError;
  return new ctor(400, { message: text }, undefined, undefined);
}

describe('agent limits — context overflow', () => {
  it('is recognised by the phrasings actually seen', () => {
    // The message patterns actually seen, and the one that must NOT match.
    expect(Agent.isContextOverflow(overflowError('prompt is too long: 210000 tokens > 200000 maximum')))
      .toBe(true);
    expect(
      Agent.isContextOverflow(
        overflowError("This model's maximum context length is 8192 tokens"),
      ),
      "overflow: litellm's 'context length' matches",
    ).toBe(true);
    expect(
      Agent.isContextOverflow(overflowError('too many tokens in request')),
      "overflow: 'too many tokens' matches",
    ).toBe(true);
    // The trap: a bad model name is also a 400, and compacting the history for
    // one would throw the session away for nothing.
    expect(
      Agent.isContextOverflow(overflowError('Invalid model name passed in model=claude-opus-5')),
      'overflow: a bad model name does NOT match',
    ).toBe(false);
    expect(
      Agent.isContextOverflow(new Error('prompt is too long')),
      'overflow: a non-400 does not match',
    ).toBe(false);
  });

  it('has a real message (it used to fall through to `bad request: {dict}`)', () => {
    const friendly = Agent as unknown as { friendlyError(e: unknown): string };
    const msg = friendly.friendlyError(overflowError('prompt is too long: 210000 tokens > 200000 maximum'));
    expect(msg.includes('context window'), 'overflow: the message names the context window').toBe(true);
    expect(msg.toLowerCase().includes('compact'), 'overflow: it mentions compaction').toBe(true);
    expect(msg.startsWith('bad request'), 'overflow: it is not the bare fallback').toBe(false);
    // And the model-name branch must still win for a genuine name error.
    const name = friendly.friendlyError(overflowError('Invalid model name passed in model=nope'));
    expect(name.includes('model name'), 'overflow: a bad model name still reads as a name error').toBe(true);
  });

  it('triggers one compact and retry', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, {
      maxIterations: 2,
      autoCompact: true,
      compactAt: 0.99,
      contextWindow: 1_000,
    });
    const agent = new Agent(cfg);

    const calls = { n: 0 };
    const stream = async function* (): AsyncGenerator<[AgentEvent | null, Message | null]> {
      calls.n += 1;
      if (calls.n === 1) throw overflowError('prompt is too long: 210000 tokens > 200000 maximum');
      yield [null, done('recovered')];
    };
    seams(agent).streamOnce = stream;

    const compacted: string[] = [];
    seams(agent).compact = async () => {
      compacted.push('yes');
      return [true, 'a summary'];
    };
    agent.messages = seededHistory(6);

    const events = await drive(agent);
    const ks = kinds(events);

    expect(compacted.length, 'overflow: it compacted in response').toBe(1);
    expect(
      of(events, 'compacting')[0]?.trigger,
      'overflow: the compacting event names the overflow trigger',
    ).toBe('overflow');
    expect(calls.n, 'overflow: it retried the round').toBe(2);
    expect(of(events, 'error').length, 'overflow: no error event survived').toBe(0);
    expect(ks[ks.length - 1], 'overflow: the turn completed').toBe('turn_end');
  });

  it('is retried only once', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, {
      maxIterations: 2,
      autoCompact: true,
      compactAt: 0.99,
      contextWindow: 1_000,
    });
    const agent = new Agent(cfg);

    const calls = { n: 0 };
    const stream = async function* (): AsyncGenerator<[AgentEvent | null, Message | null]> {
      // A second overflow means compaction did not help; stop, don't loop.
      calls.n += 1;
      throw overflowError('prompt is too long: 210000 tokens > 200000 maximum');
    };
    seams(agent).streamOnce = stream;

    seams(agent).compact = async () => [true, 'a summary'];
    agent.messages = seededHistory(6);

    const events = await drive(agent);
    const errs = of(events, 'error');

    expect(calls.n, 'overflow: it tried exactly twice, not forever').toBe(2);
    expect(errs.length, 'overflow: the second failure is reported').toBe(1);
    expect(
      errs[0]?.message.includes('context window'),
      'overflow: and it reads as a context problem',
    ).toBe(true);
  });

  it('is not retried with auto-compact off', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { autoCompact: false });
    const agent = new Agent(cfg);

    const calls = { n: 0 };
    const stream = async function* (): AsyncGenerator<[AgentEvent | null, Message | null]> {
      calls.n += 1;
      throw overflowError('prompt is too long: 210000 tokens > 200000 maximum');
    };
    seams(agent).streamOnce = stream;

    seams(agent).compact = async () => {
      throw new Error('compact must not be called with autoCompact off');
    };
    agent.messages = seededHistory(6);

    const events = await drive(agent);
    const errs = of(events, 'error');

    expect(calls.n, 'overflow: not retried with auto-compact off').toBe(1);
    expect(
      errs[0]?.message.includes('context window'),
      'overflow: the error is still explained',
    ).toBe(true);
  });
});

// === SECTION === the window itself ===

describe('agent limits — context window lookup', () => {
  it('prefers the catalog and falls back to the configured value', async () => {
    const tmp = tmpWorkdir();
    const cfg = cfgFor(tmp, { contextWindow: 128_000 });
    const agent = new Agent(cfg);
    // No catalog in a test process, so the fallback is what answers.
    expect(await agent.contextWindow(), 'window: falls back to the configured value').toBe(128_000);
    expect(new Config().contextWindow, 'window: the default is 1M').toBe(1_000_000);
  });

  it('never raises on a broken lookup', async () => {
    const sources = await import('../src/sources.js');
    expect(sources.contextWindowFor('http://127.0.0.1:9/nothing', 'x')).toBeUndefined();
    expect(sources.contextWindowFor('https://api.unorouter.com', 'x')).toBeUndefined();
  });
});
