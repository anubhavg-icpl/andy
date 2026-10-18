/**
 * tests/test_reasoning.test.ts — regression suite for the model-reasoning
 * display (port of tests/test_reasoning.py).
 *
 * What this pins, and why:
 *
 * The Anthropic protocol carries a model's reasoning as a `thinking` content
 * block — a content_block_start of type thinking, then content_block_delta
 * events whose delta type is `thinking_delta` and whose text lives on
 * `delta.thinking` (NOT `delta.text`; the two deltas are different classes).
 * The original Python bug: `_stream_once` handled exactly one delta type, so
 * every `thinking_delta` was discarded before the UI could see it (measured
 * against OpenRouter 2026-10-16: 107 thinking_delta events for one prompt,
 * all silently dropped).
 *
 * 1. Forwarding: thinking_delta routes to a `reasoning_delta` event,
 *    text_delta stays `text_delta`, and their arrival order is preserved. The
 *    event is deliberately NOT named `thinking` — that name is taken by the
 *    spinner stage, and reusing it would light the rail instead of showing
 *    content.
 * 2. Rendering: the live form windows the tail and elides the rest; the
 *    committed form keeps every line. Neither may raise on empty input.
 *
 * Not covered, deliberately: whether an endpoint *sends* thinking blocks.
 * That is a property of the endpoint (an Anthropic-native one does; LiteLLM's
 * /v1/messages bridge drops reasoning entirely) — the code must be correct
 * and silent when none arrives, which is check 4 below.
 *
 * No network: the SDK stream is faked (a fake client is injected through the
 * Agent's `_client` seam, the TS equivalent of Python's `agent._client =`).
 *
 * renderers.tsx is a JSX module and tsconfig sets no --jsx, so it is imported
 * with a non-literal specifier — tsc leaves the specifier unresolved (only
 * tsc needs the dodge; vitest resolves it fine).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Agent } from '../src/agent.js';
import { Config } from '../src/config.js';
import { getPalette } from '../src/theme.js';
import type { AgentEvent } from '../src/shared.js';

const SPEC_RENDERERS: string = '../src/ui/renderers.js';
type Renderers = {
  reasoningLive: (text: string, palette: ReturnType<typeof getPalette>, cursor?: string) => unknown;
  reasoningPanel: (text: string, palette: ReturnType<typeof getPalette>) => unknown;
};

// ---------------------------------------------------------------------------
// Fakes — the shape the SDK actually hands streamOnce
// ---------------------------------------------------------------------------

/** One content_block_delta payload. Only the fields its type carries. */
class FakeDelta {
  type: string;
  text?: string;
  thinking?: string;

  constructor(dtype: string, fields: Record<string, string> = {}) {
    this.type = dtype;
    Object.assign(this, fields);
  }
}

class FakeEvent {
  type: string;
  delta: FakeDelta | null;

  constructor(etype: string, delta: FakeDelta | null = null) {
    this.type = etype;
    this.delta = delta;
  }
}

/** A stand-in for client.messages.stream(...)'s async-iterable result. */
class FakeStream {
  private readonly events: FakeEvent[];
  private readonly final: unknown;

  constructor(events: FakeEvent[], final: unknown) {
    this.events = events;
    this.final = final;
  }

  [Symbol.asyncIterator](): AsyncIterator<FakeEvent> {
    let i = 0;
    return {
      next: async (): Promise<IteratorResult<FakeEvent>> =>
        i < this.events.length
          ? { value: this.events[i++]!, done: false }
          : { value: undefined as never, done: true },
    };
  }

  finalMessage(): Promise<unknown> {
    return Promise.resolve(this.final);
  }
}

class FakeMessages {
  private readonly streamObj: FakeStream;
  captured: Record<string, unknown> | null = null;

  constructor(streamObj: FakeStream) {
    this.streamObj = streamObj;
  }

  stream(params: Record<string, unknown>): FakeStream {
    this.captured = { ...params };
    return this.streamObj;
  }
}

class FakeClient {
  messages: FakeMessages;

  constructor(streamObj: FakeStream) {
    this.messages = new FakeMessages(streamObj);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(path.join(os.tmpdir(), 'andy-reasoning-'));

/** Python `_cfg`: a real Config pointed at a throwaway workdir. */
function cfgFor(overrides: Record<string, unknown> = {}): Config {
  return Config.fromEnv({
    workdir: TMP,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
    ...overrides,
  } as Partial<Config>);
}

/** Python `_agent_with`: an Agent whose client is the given fake. */
function agentWith(streamObj: FakeStream, overrides: Record<string, unknown> = {}): Agent {
  const agent = new Agent(cfgFor(overrides));
  (agent as unknown as { _client: unknown })._client = new FakeClient(streamObj);
  return agent;
}

/** Python `_drain`: run the real streamOnce and collect the events it yields.
 *
 * streamOnce is method-private in the TS port; Python reached it through the
 * same name. The structural cast is the type-level bridge. */
async function drain(agent: Agent, maxTokens?: number): Promise<AgentEvent[]> {
  const gen = (
    agent as unknown as {
      streamOnce(maxTokens?: number): AsyncGenerator<[AgentEvent | null, unknown]>;
    }
  ).streamOnce(maxTokens);
  const out: AgentEvent[] = [];
  for await (const [ev] of gen) {
    if (ev !== null) out.push(ev);
  }
  return out;
}

const kinds = (events: AgentEvent[]): string[] => events.map((e) => e.type);

// ---------------------------------------------------------------------------
// 1 — a thinking block is forwarded, as its own event type
// ---------------------------------------------------------------------------

describe('test_thinking_is_forwarded', () => {
  it('thinking_delta yields reasoning_delta, read off delta.thinking', async () => {
    const events = [
      new FakeEvent('content_block_start'),
      new FakeEvent('content_block_delta', new FakeDelta('thinking_delta', { thinking: 'We need ' })),
      new FakeEvent('content_block_delta', new FakeDelta('thinking_delta', { thinking: 'to parse this.' })),
      new FakeEvent('content_block_stop'),
    ];
    const agent = agentWith(
      new FakeStream(events, { content: [{ type: 'text', text: '18' }] }),
    );
    const got = await drain(agent);

    expect(kinds(got)).toEqual(['reasoning_delta', 'reasoning_delta']);
    const joined = got
      .map((e) => (e.type === 'reasoning_delta' ? e.text : ''))
      .join('');
    expect(joined).toBe('We need to parse this.');
  });

  it("the event is NOT named 'thinking' (spinner collision)", async () => {
    const events = [
      new FakeEvent('content_block_delta', new FakeDelta('thinking_delta', { thinking: 'x' })),
    ];
    const agent = agentWith(
      new FakeStream(events, { content: [{ type: 'thinking', thinking: 'x' }] }),
    );
    const got = await drain(agent);
    expect(got.every((e) => e.type !== 'thinking')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 — text is untouched, and the two interleave in arrival order
// ---------------------------------------------------------------------------

describe('test_text_still_works_and_order_holds', () => {
  it('order preserved across the two delta types', async () => {
    const events = [
      new FakeEvent('content_block_start'),
      new FakeEvent('content_block_delta', new FakeDelta('thinking_delta', { thinking: 'reasoning' })),
      new FakeEvent('content_block_stop'),
      new FakeEvent('content_block_start'),
      new FakeEvent('content_block_delta', new FakeDelta('text_delta', { text: 'The answer ' })),
      new FakeEvent('content_block_delta', new FakeDelta('text_delta', { text: 'is 18.' })),
      new FakeEvent('content_block_stop'),
    ];
    const agent = agentWith(
      new FakeStream(events, { content: [{ type: 'text', text: 'The answer is 18.' }] }),
    );
    const got = await drain(agent);

    expect(kinds(got)).toEqual(['reasoning_delta', 'text_delta', 'text_delta']);
    expect(
      got
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('The answer is 18.');
  });
});

// ---------------------------------------------------------------------------
// 3 — a reasoning-only reply (no text at all) does not crash or invent text
// ---------------------------------------------------------------------------

describe('test_reasoning_only', () => {
  it('a reasoning-only stream yields only reasoning_delta', async () => {
    const events = [
      new FakeEvent('content_block_delta', new FakeDelta('thinking_delta', { thinking: 'Hmm.' })),
    ];
    const agent = agentWith(
      new FakeStream(events, { content: [{ type: 'thinking', thinking: 'Hmm.' }] }),
    );
    const got = await drain(agent);
    expect(kinds(got)).toEqual(['reasoning_delta']);
  });
});

// ---------------------------------------------------------------------------
// 4 — an endpoint that sends no thinking behaves exactly as before
// ---------------------------------------------------------------------------

describe('test_no_thinking_endpoint_is_unchanged', () => {
  it('no thinking in -> no reasoning_delta out', async () => {
    const events = [
      new FakeEvent('content_block_delta', new FakeDelta('text_delta', { text: '391' })),
    ];
    const agent = agentWith(
      new FakeStream(events, { content: [{ type: 'text', text: '391' }] }),
    );
    const got = await drain(agent);
    expect(kinds(got)).toEqual(['text_delta']);
  });
});

// ---------------------------------------------------------------------------
// 5 — the ceiling override still works (the reasoning-exhaustion retry path)
// ---------------------------------------------------------------------------

describe('test_ceiling_override_still_accepted', () => {
  it('explicit max_tokens reaches the request', async () => {
    const streamObj = new FakeStream([], { content: [{ type: 'text', text: 'ok' }] });
    const agent = agentWith(streamObj);
    await drain(agent, 65536);
    const messages = (agent as unknown as { client: { messages: FakeMessages } }).client.messages;
    expect(messages.captured?.['max_tokens']).toBe(65536);
  });
});

// ---------------------------------------------------------------------------
// 6 — the renderables
// ---------------------------------------------------------------------------

describe('test_renderables', () => {
  // THINK_LIVE_LINES is module-private in the TS port (Python exported it);
  // its value is pinned here as a literal so a change to the window still
  // trips this check. Reported as a port note, not a behaviour gap.
  const THINK_LIVE_LINES = 14;

  it('live view elides the head, says how much, and stays in its window', async () => {
    const R = (await import(SPEC_RENDERERS)) as Renderers;
    const p = getPalette('green');
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const flat = await mountPlain(R.reasoningLive(longText, p));

    // 40 lines, window of 14 -> 26 elided.
    expect(flat.includes('(+26 earlier)')).toBe(true);
    expect(flat.includes('line 40')).toBe(true);
    expect(flat.split('\n').length - 1).toBeLessThanOrEqual(THINK_LIVE_LINES + 1);
    // Labelled — the operator must know what they are reading.
    expect(flat.startsWith('✻ thinking')).toBe(true);
  });

  it('committed panel keeps every line and reports its count', async () => {
    const R = (await import(SPEC_RENDERERS)) as Renderers;
    const p = getPalette('green');
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const body = await mountPlain(R.reasoningPanel(longText, p));
    for (const n of [1, 20, 40]) {
      expect(body.includes(`line ${n}`)).toBe(true);
    }
    expect(body.includes('40 lines')).toBe(true);
  });

  it('renderables tolerate empty reasoning', async () => {
    const R = (await import(SPEC_RENDERERS)) as Renderers;
    const p = getPalette('green');
    expect(() => R.reasoningLive('', p)).not.toThrow();
    expect(() => R.reasoningPanel('', p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7 — the config toggle
// ---------------------------------------------------------------------------

describe('test_show_thinking_default', () => {
  it('showThinking defaults on', () => {
    // On by default: it costs nothing where the endpoint sends none.
    expect(new Config().showThinking).toBe(true);
  });
  it('--no-think maps to false', () => {
    expect(cfgFor({ showThinking: false }).showThinking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mount helper — the Python suite read `.plain` off Rich renderables; the TS
// renderers return React nodes, so "what the operator reads" is the mounted
// Ink output. Static nodes, one frame, ANSI stripped.
// ---------------------------------------------------------------------------

import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { Box } from 'ink';
import type { ReactNode } from 'react';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(_mode?: boolean): void {
    /* ink asks; we have no real terminal */
  }
}

async function mountPlain(node: unknown, columns = 100): Promise<string> {
  const out = new PassThrough();
  (out as unknown as { columns?: number }).columns = columns;
  const frames: string[] = [];
  out.on('data', (c: Buffer) => frames.push(c.toString('utf8')));
  const stdin = new FakeStdin();
  const instance = render(
    createElement(Box, { flexDirection: 'column' }, node as ReactNode),
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
    },
  );
  try {
    await sleep(60);
    // Snapshot BEFORE unmount: ink's debug mode writes the content frames
    // first and a bare "\n" as the unmount frame, so the last frame after
    // unmount would always be blank.
    const last = frames[frames.length - 1] ?? '';
    return stripAnsi(last);
  } finally {
    instance.unmount();
  }
}
