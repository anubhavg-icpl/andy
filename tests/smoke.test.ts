// Smoke test for the TypeScript scaffold — verifies the vitest pipeline
// executes and discovers *.test.ts files under tests/.
import { describe, expect, it } from 'vitest'

describe('smoke', () => {
  it('expects 1 + 1 to equal 2', () => {
    expect(1 + 1).toBe(2)
  })
})
