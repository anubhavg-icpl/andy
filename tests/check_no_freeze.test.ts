/**
 * tests/check_no_freeze.test.ts — vitest port of tests/check_no_freeze.py.
 *
 * Prove the event loop keeps ticking while a slow bash tool runs: a blocking
 * tool call would report ~0 heartbeat ticks here, an async one ~60. The
 * Python suite monkeypatched Agent._stream_once with a fake stream; the TS
 * port's streamOnce is private, so the same seam is reached through a
 * structural cast (private is a compile-time-only notion in TS — the Python
 * suite reached past the underscore the same way).
 */

import { describe, expect, it } from 'vitest'

import { Agent } from '../src/agent.js'
import { Config } from '../src/config.js'
import type { AgentEvent } from '../src/shared.js'

/** The shape runTurn reads off a final message (the SDK's Message, faked). */
interface FakeMsg {
  content: Array<Record<string, unknown>>
  usage: unknown
  stop_reason?: string | null
}

/** The private seam this suite replaces, typed structurally for the cast. */
interface StreamSeam {
  streamOnce(maxTokens?: number): AsyncGenerator<[AgentEvent | null, FakeMsg | null]>
}

describe('check_no_freeze', () => {
  it('the event loop stays responsive while a slow bash tool runs', async () => {
    const cfg = Config.fromEnv({
      workdir: '/tmp',
      apiKey: 'x',
      baseUrl: 'http://localhost:4001',
      mode: 'auto',
    })
    const agent = new Agent(cfg)
    let n = 0
    const fakeStream = async function* (_maxTokens?: number): AsyncGenerator<
      [AgentEvent | null, FakeMsg | null]
    > {
      n += 1
      if (n === 1) {
        yield [
          null,
          {
            content: [
              { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'sleep 3; echo DONE' } },
            ],
            usage: null,
          },
        ]
        return
      }
      yield [null, { content: [{ type: 'text', text: 'ok' }], usage: null }]
    }
    ;(agent as unknown as StreamSeam).streamOnce = fakeStream

    // Heartbeat: how many times can we tick during the 3s command?
    let ticks = 0
    let stop = false
    const beat = async (): Promise<void> => {
      while (!stop) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        ticks += 1
      }
    }
    const hb = beat()

    const events: AgentEvent[] = []
    const t0 = Date.now()
    for await (const ev of agent.runTurn('run it')) events.push(ev)
    const elapsed = (Date.now() - t0) / 1000
    stop = true
    await hb

    const out = events.find((e) => e.type === 'tool_result') as
      | Extract<AgentEvent, { type: 'tool_result' }>
      | undefined
    const output = out?.output ?? ''
    console.log(`command took ${elapsed.toFixed(2)}s, heartbeat ticks during it: ${ticks}`)
    console.log(`tool output: ${JSON.stringify(output.trim())}`)
    // A frozen loop would tick ~0 times; a healthy one ticks ~60.
    expect(ticks).toBeGreaterThan(30)
    expect(output).toContain('DONE')
  }, 30_000)
})
