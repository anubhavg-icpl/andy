// Regression suite for StatusBar's animated pet glyph (widgets.tsx's
// petGlyph()) — idle breathing, the busy spinner cycle, and the error
// reaction taking priority over both and then expiring on its own.

import { describe, expect, it } from 'vitest';
import { petGlyph } from '../src/ui/widgets.js';

describe('petGlyph — idle', () => {
  it('breathes between a full and a hollow dot, one swap per tick', () => {
    expect(petGlyph(0, false, undefined)).toBe('●');
    expect(petGlyph(1, false, undefined)).toBe('○');
    expect(petGlyph(2, false, undefined)).toBe('●');
  });
});

describe('petGlyph — busy', () => {
  it('cycles through the braille frame set rather than staying static', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 10; t++) seen.add(petGlyph(t, true, undefined));
    // 10 distinct frames over 10 ticks — if this were static, seen.size would be 1.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('wraps around rather than running off the end of the frame set', () => {
    // Frame set is 10 glyphs long; tick 10 should equal tick 0's frame.
    expect(petGlyph(10, true, undefined)).toBe(petGlyph(0, true, undefined));
  });
});

describe('petGlyph — error reaction', () => {
  it('overrides both idle and busy for a short window right after the error tick', () => {
    expect(petGlyph(5, false, 5)).toBe('✕');
    expect(petGlyph(5, true, 5)).toBe('✕');
    expect(petGlyph(7, false, 5)).toBe('✕'); // still within the hold window
  });

  it('expires back to the normal idle/busy glyph after the hold window', () => {
    // PET_ERROR_HOLD_TICKS is 4 — tick 9 is 4 ticks after the error at 5.
    expect(petGlyph(9, false, 5)).not.toBe('✕');
    expect(petGlyph(9, true, 5)).not.toBe('✕');
  });
});
