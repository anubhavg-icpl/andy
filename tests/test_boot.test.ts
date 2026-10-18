/**
 * tests/test_boot.test.ts — regression suite for the boot screen's spinning
 * logo (port of tests/test_boot.py).
 *
 * What this pins, and why it is pinned rather than left to the eye:
 *
 * 1. It must settle onto the static mark — the animation used to end with a
 *    visible snap as the logo changed shape.
 * 2. The spin must be symmetric — keying geometry off |cos theta| put
 *    mirror-image frames on opposite sides of a rounding boundary (one three
 *    columns wide, its own mirror four). Frames are now keyed off the frame
 *    index and the second half-turn is the first read backwards.
 *
 * The clock is never read inside the animation: spinFrameIndex takes the time
 * as a parameter, and the final purity check asserts that promise.
 *
 * The Python suite drove the Textual BootScreen class with stubbed widgets;
 * the TS port split the same object into a pure phase machine (bootTick) plus
 * an Ink component, so the wiring checks here mount the REAL BootScreen on
 * fake streams (ink `debug` frames) — no terminal needed.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { createElement, type ComponentType } from 'react';
import chalk from 'chalk';

import { getPalette, type Palette } from '../src/theme.js';

// banner.tsx and boot.tsx are JSX-flag-free modules (createElement, no JSX
// literals — see boot.tsx's contract block) but resolving ANY .js → .tsx
// mapping needs --jsx, which the repo tsconfig does not set. So both are
// imported through non-literal specifiers (tsc leaves them unresolved;
// vitest resolves them) and typed locally against the exported contract.
const SPEC_BANNER: string = '../src/ui/banner.js';
const SPEC_BOOT: string = '../src/ui/boot.js';

const banner = (await import(SPEC_BANNER)) as {
  EMBLEM: string[];
  EMBLEM_WIDTH: number;
  SPIN_FRAMES: number;
  SPIN_SECONDS: number;
  SPIN_STEP: number;
  SPIN_SHADES: string;
  bannerWidth(): number;
  emblemFrame(theta: number): string[];
  spinFrame(index: number): string[];
  spinFrameIndex(elapsed: number): number;
};
const boot = (await import(SPEC_BOOT)) as {
  TICKS_PER_FRAME: number;
  BootScreen: ComponentType<{
    palette: Palette;
    checks: [string, string, boolean][];
    onDone: (typed: string[], submit: boolean) => void;
    rain?: boolean;
  }>;
};

const { EMBLEM, EMBLEM_WIDTH, SPIN_FRAMES, SPIN_SECONDS, SPIN_STEP, SPIN_SHADES } = banner;
const { emblemFrame, spinFrame, spinFrameIndex } = banner;
const { BootScreen, TICKS_PER_FRAME } = boot;
type BootCheck = [string, string, boolean];

const BANNER_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'banner.tsx'),
  'utf8',
);
const BOOT_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'boot.tsx'),
  'utf8',
);

/** Visible width of a frame — its widest row, stripped. */
function width(frame: string[]): number {
  return Math.max(...frame.map(r => r.trim().length));
}

// ---------------------------------------------------------------------------
// 1 — it lands exactly on the static mark
// ---------------------------------------------------------------------------

describe('test_lands_on_static_mark', () => {
  it('emblemFrame(0.0) is EMBLEM exactly', () => {
    expect(emblemFrame(0.0)).toEqual(EMBLEM);
  });
  it('emblemFrame(pi) is EMBLEM exactly', () => {
    expect(emblemFrame(Math.PI)).toEqual(EMBLEM);
  });
  it('spinFrame(0) is EMBLEM exactly', () => {
    expect(spinFrame(0)).toEqual(EMBLEM);
  });
  it('the far side of the turn is EMBLEM too (a symmetric mark)', () => {
    expect(spinFrame(SPIN_FRAMES / 2)).toEqual(EMBLEM);
  });
  it('the full-width frame keeps its rounded cap, not a flat one', () => {
    // The specific snap that was fixed: a flat cap at full width.
    const full = spinFrame(0);
    expect(full[0]).toContain('▄███▄');
    expect(full[full.length - 1]).toContain('▀███▀');
  });
});

// ---------------------------------------------------------------------------
// 2 — every frame is the same shape, so the layout cannot jump
// ---------------------------------------------------------------------------

describe('test_every_frame_is_four_by_seven', () => {
  it('all frames are 4 rows x EMBLEM_WIDTH cols', () => {
    const bad: Array<[number, number[]]> = [];
    for (let i = 0; i < SPIN_FRAMES; i++) {
      const fr = spinFrame(i);
      if (fr.length !== EMBLEM.length || fr.some(r => r.length !== EMBLEM_WIDTH)) {
        bad.push([i, fr.map(r => r.length)]);
      }
    }
    expect(bad).toEqual([]);
  });
  it('EMBLEM_WIDTH still matches EMBLEM', () => {
    expect(EMBLEM_WIDTH).toBe(Math.max(...EMBLEM.map(r => r.length)));
  });
});

// ---------------------------------------------------------------------------
// 3 — the spin is symmetric (the regression this feature actually had)
// ---------------------------------------------------------------------------

describe('test_spin_is_symmetric', () => {
  it('mirror-image frames are identical', () => {
    const asym: Array<[number, number, string, string]> = [];
    for (let i = 0; i < SPIN_FRAMES; i++) {
      const j = (SPIN_FRAMES - i) % SPIN_FRAMES;
      if (JSON.stringify(spinFrame(i)) !== JSON.stringify(spinFrame(j))) {
        asym.push([i, j, spinFrame(i)[1]!, spinFrame(j)[1]!]);
      }
    }
    expect(asym).toEqual([]);
  });
  it('mirror-image angles agree too', () => {
    // ...and the same must hold through the public angle-based entry point,
    // which is what the boot screen and any future caller use.
    const asymAngle: number[] = [];
    for (let i = 0; i < SPIN_FRAMES; i++) {
      const a = (i * 2 * Math.PI) / SPIN_FRAMES;
      const b = ((SPIN_FRAMES - i) * 2 * Math.PI) / SPIN_FRAMES;
      if (JSON.stringify(emblemFrame(a)) !== JSON.stringify(emblemFrame(b))) {
        asymAngle.push(i);
      }
    }
    expect(asymAngle).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 — it actually spins
// ---------------------------------------------------------------------------

describe('test_it_actually_spins', () => {
  const widths = Array.from({length: SPIN_FRAMES}, (_, i) => width(spinFrame(i)));
  it('the width varies across the turn', () => {
    expect(new Set(widths).size).toBeGreaterThan(1);
  });
  it('there is an edge-on frame narrower than the mark', () => {
    expect(Math.min(...widths)).toBeLessThan(EMBLEM_WIDTH);
  });
  it('there is a full-width frame', () => {
    expect(Math.max(...widths)).toBe(EMBLEM_WIDTH);
  });
  it('frame 0 is the full-width one, so it starts legible', () => {
    expect(widths[0]).toBe(EMBLEM_WIDTH);
  });
  it('frames are not all the same renderable', () => {
    // Distinct frames, not just distinct widths — the shading has to move too.
    expect(new Set(Array.from({length: SPIN_FRAMES}, (_, i) => spinFrame(i).join('\n'))).size)
      .toBeGreaterThan(2);
  });
});

describe('test_shading_is_monotone', () => {
  // An earlier table (`█ █ ▓ ▒ ▓ ▓ █`) plateaued and then jumped, so the last
  // step read as a flash rather than a turn.
  const order = '█▓▒░'; // lit -> dark
  const folds = [...SPIN_SHADES].map(c => order.indexOf(c));

  it('shading is mirrored about edge-on', () => {
    expect(folds).toEqual([...folds].reverse());
  });
  it('shading never brightens on the way in', () => {
    const inward = folds.slice(0, Math.floor(folds.length / 2) + 1);
    expect(inward.every((a, i) => i === 0 || inward[i - 1]! <= a)).toBe(true);
  });
  it('the darkest glyphs sit on the narrowest frames', () => {
    const mid = spinFrame(Math.floor(folds.length / 2));
    const glyph = mid[1]!.trim()[0]!;
    expect(order.indexOf(glyph)).toBe(Math.max(...folds));
  });
  it('the lit glyph is reserved for the widest frames', () => {
    const full = Array.from({length: SPIN_FRAMES}, (_, i) => i)
      .filter(i => width(spinFrame(i)) === EMBLEM_WIDTH);
    for (const i of full) {
      expect(spinFrame(i)[1]!.trim()[0]).toBe('█');
    }
  });
});

// ---------------------------------------------------------------------------
// 5 — the frame index is total and cyclic
// ---------------------------------------------------------------------------

describe('test_frame_index_is_total_and_cyclic', () => {
  it('elapsed 0 is frame 0', () => {
    expect(spinFrameIndex(0.0)).toBe(0);
  });
  it('exactly one revolution wraps to frame 0', () => {
    expect(spinFrameIndex(SPIN_SECONDS)).toBe(0);
  });
  it('a negative elapsed still lands in range', () => {
    expect(spinFrameIndex(-SPIN_STEP)).toBeGreaterThanOrEqual(0);
    expect(spinFrameIndex(-SPIN_STEP)).toBeLessThan(SPIN_FRAMES);
  });
  it('a large elapsed still lands in range', () => {
    const big = [999.9, 1e6, SPIN_STEP * 10_000].map(t => spinFrameIndex(t));
    for (const i of big) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(SPIN_FRAMES);
    }
  });
  it('a fractional elapsed steps one frame at a time', () => {
    const frac = Array.from({length: SPIN_FRAMES}, (_, k) =>
      spinFrameIndex(SPIN_STEP * k + SPIN_STEP / 3),
    );
    expect(frac).toEqual(Array.from({length: SPIN_FRAMES}, (_, i) => i));
  });
  it('one revolution visits every frame once', () => {
    const seen = Array.from({length: SPIN_FRAMES}, (_, k) => spinFrameIndex(SPIN_STEP * k));
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({length: SPIN_FRAMES}, (_, i) => i));
  });
});

describe('test_angle_rounding_hits_each_frame_once', () => {
  it('each frame angle maps to its own frame', () => {
    const got = Array.from({length: SPIN_FRAMES}, (_, i) =>
      emblemFrame((i * 2 * Math.PI) / SPIN_FRAMES),
    );
    const want = Array.from({length: SPIN_FRAMES}, (_, i) => spinFrame(i));
    expect(got).toEqual(want);
  });
});

// ---------------------------------------------------------------------------
// 6 — the boot screen wiring (the real component, mounted on fake streams)
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** `#rrggbb` → the SGR true-color sequence chalk emits for it. */
function hexSeq(hex: string): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `38;2;${r};${g};${b}`;
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(_mode?: boolean): void {
    /* ink asks; we have no real terminal */
  }
}

interface Frame {
  raw: string;
  plain: string;
  lines: string[];
}

/** Mount the real BootScreen with rain off, collecting one entry per render. */
async function mountBoot(checks: BootCheck[], onDone: (typed: string[], submit: boolean) => void) {
  chalk.level = 3; // the emblem style check needs the ANSI codes on the frames
  const out = new PassThrough();
  const frames: Frame[] = [];
  out.on('data', (c: Buffer) => {
    const raw = c.toString('utf8');
    const plain = stripAnsi(raw);
    frames.push({raw, plain, lines: plain.split('\n')});
  });
  const stdin = new FakeStdin();
  const palette = getPalette('green');
  const instance = render(
    createElement(BootScreen, {palette, checks, onDone, rain: false}),
    {
      stdout: out as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
    },
  );
  return {frames, instance, palette};
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The trimmed 4-line emblem block of a frame's picture, or null. */
function emblemPicture(frame: Frame): string[] | null {
  const trims = frame.lines.map(l => l.trim());
  for (let i = 0; i + EMBLEM.length <= trims.length; i++) {
    const block = trims.slice(i, i + EMBLEM.length)!;
    if (block.every(r => r.length > 0) && block[0]!.startsWith('▄') && block[3]!.startsWith('▀')) {
      // The fill rows are full blocks or shade glyphs — not banner glyphs.
      if (/^[█▓▒░ ]+$/.test(block[1]!) && /^[█▓▒░ ]+$/.test(block[2]!)) return block;
    }
  }
  return null;
}

const STATIC_PICTURE = EMBLEM.map(r => r.trim());

describe('test_wiring_before_first_tick', () => {
  it('renders the static emblem before the first tick', async () => {
    const {frames, instance} = await mountBoot(
      [
        ['CHECK 0', 'ok', true],
        ['CHECK 1', 'ok', true],
        ['CHECK 2', 'ok', true],
      ],
      () => {},
    );
    try {
      await sleep(150); // the initial render (state at ticks=0)
      const first = frames[0]!;
      expect(first).toBeDefined();
      const pic = emblemPicture(first);
      expect(pic).not.toBeNull();
      // It starts as the static mark: spinFrame(0) is EMBLEM.
      expect(pic).toEqual(STATIC_PICTURE);
    } finally {
      instance.unmount();
    }
  }, 15_000);
});

describe('test_wiring_spins_then_settles', () => {
  it('turns during the reveal and stops when it is done', async () => {
    const {frames, instance} = await mountBoot(
      Array.from({length: 3}, (_, i): BootCheck => [`CHECK ${i}`, 'ok', true]),
      () => {},
    );
    try {
      // Walk the banner phase, collecting what the widget was shown. Phase
      // marker: the boot screen renders the SYSTEM CHECK header in every
      // phase, but the author credits only appear once the banner is done
      // (boot.tsx gates them on `phase !== 'banner'`), so "has credits" is
      // the honest "past the banner" signal.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const past = frames.some(f => f.plain.includes('Mr-Destroyer'));
        if (past && frames.length > 4) break;
        await sleep(40);
      }
      const bannerFrames = frames.filter(f => !f.plain.includes('Mr-Destroyer'));
      const seen = bannerFrames
        .map(emblemPicture)
        .filter((p): p is string[] => p !== null)
        .map(p => p.join('\n'));
      const after = frames.filter(f => f.plain.includes('Mr-Destroyer'));

      // The banner phase ends within a sane number of ticks.
      expect(after.length).toBeGreaterThan(0);

      // The emblem changed while the wordmark revealed.
      expect(new Set(seen).size).toBeGreaterThan(1);

      // The spin must actually complete before it settles. The first cut of
      // this feature held each frame for a single tick, so all twelve went by
      // well before the wordmark finished revealing. The mark is symmetric,
      // so five distinct pictures is correct; what must hold is that the
      // whole revolution was walked — the frame-slot count.
      expect(seen.length).toBeGreaterThanOrEqual(SPIN_FRAMES * TICKS_PER_FRAME);

      // It is not already static partway through the reveal.
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[0]).not.toBe(seen[Math.floor(seen.length / 2)]);

      // It settles on the static mark once revealed, and stays settled while
      // the system check runs.
      for (const f of after.slice(0, 4)) {
        expect(emblemPicture(f)).toEqual(STATIC_PICTURE);
      }
    } finally {
      instance.unmount();
    }
  }, 20_000);
});

describe('test_wiring_styles_the_frame_as_a_unit', () => {
  it('every row of a spun frame shares one style — lit frames bright, edge-on dim', async () => {
    // Styling row by row was the first cut: it lit the half-block caps and
    // dimmed the fill *on the same frame*. The style now comes from the
    // frame's own fill glyph, so it tracks the shade table.
    const p = getPalette('green');
    const accent = hexSeq(p.accent);
    const dim = hexSeq(p.dim);
    const {frames, instance} = await mountBoot([['A', '1', true]], () => {});
    try {
      const deadline = Date.now() + 8_000;
      let narrowRaw: string[] | null = null;
      let litRaw: string[] | null = null;
      while (Date.now() < deadline && (narrowRaw === null || litRaw === null)) {
        for (const f of frames) {
          // The spin belongs to the banner phase; once the credits are up the
          // mark has settled (boot.tsx: `phase !== 'banner' ? EMBLEM : spin`).
          if (f.plain.includes('Mr-Destroyer')) continue;
          const pic = emblemPicture(f);
          if (pic === null) continue;
          const rawRows = f.raw.split('\n').filter(l => {
            const t = stripAnsi(l).trim();
            return t.length > 0 && (t === pic[1] || t === pic[2]);
          });
          if (pic[1] === '▒' && narrowRaw === null) narrowRaw = rawRows;
          if (pic.join('\n') === STATIC_PICTURE.join('\n') && litRaw === null) litRaw = rawRows;
        }
        await sleep(40);
      }
      // The edge-on frame is reached during the banner phase: it is the
      // narrowest picture, and it is dim, not the accent.
      expect(narrowRaw).not.toBeNull();
      for (const row of narrowRaw!) {
        expect(row).toContain(dim);
        expect(row).not.toContain('\x1b[1m'); // not bold
        expect(row).not.toContain(accent);
      }
      // The upright frame is full width and lit: bold accent, every row.
      expect(litRaw).not.toBeNull();
      for (const row of litRaw!) {
        expect(row).toContain('\x1b[1m');
        expect(row).toContain(accent);
        expect(row).not.toContain(dim);
      }
    } finally {
      instance.unmount();
    }
  }, 20_000);
});

describe('test_wiring_reaches_done', () => {
  it('the phase machine still reaches done and hands off once', async () => {
    const done: Array<[string[], boolean]> = [];
    const {frames, instance} = await mountBoot([['A', '1', true]], (typed, submit) => {
      done.push([typed, submit]);
    });
    try {
      const deadline = Date.now() + 10_000;
      let doneAt = 0;
      while (Date.now() < deadline) {
        if (frames.some(f => f.plain.includes('SHELL READY'))) {
          doneAt = Date.now();
          break;
        }
        await sleep(40);
      }
      // The phase machine still reaches done.
      expect(doneAt).toBeGreaterThan(0);
      // banner -> checks -> fade -> done, in order. 'SYSTEM CHECK' cannot
      // mark the checks phase here (the header renders in every phase), so
      // the credits — gated on `phase !== 'banner'` in boot.tsx — do.
      const iChecks = frames.findIndex(f => f.plain.includes('Mr-Destroyer'));
      expect(iChecks).toBeGreaterThan(0);
      expect(frames[0]!.plain.includes('Mr-Destroyer')).toBe(false); // banner first
      const iDone = frames.findIndex(f => f.plain.includes('SHELL READY'));
      expect(iDone).toBeGreaterThan(iChecks);

      // The handoff fires after the documented dwell (2.2s), and only once.
      // The dwell constant itself is pinned straight off the source — the
      // Python suite read it off the recorded timer — while the behaviour
      // (fires, once, not instantly) is measured.
      expect(BOOT_SRC).toMatch(/},\s*2200\)/);
      while (done.length === 0 && Date.now() - doneAt < 6_000) await sleep(50);
      expect(done.length).toBe(1);
      const firstFire = Date.now();
      expect(firstFire - doneAt).toBeGreaterThanOrEqual(1_500); // the dwell, minus polling slack
      await sleep(300);
      expect(done.length).toBe(1); // on_done fires only once
    } finally {
      instance.unmount();
    }
  }, 25_000);
});

describe('test_ticks_per_frame_keeps_the_turn_in_step', () => {
  it('a revolution lasts about SPIN_SECONDS', () => {
    const seconds = TICKS_PER_FRAME * SPIN_FRAMES * 0.045;
    expect(Math.abs(seconds - SPIN_SECONDS)).toBeLessThan(0.05);
  });
  it('each frame is held at least one tick', () => {
    expect(TICKS_PER_FRAME).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 7 — purity: no clock, no state, no flakiness
// ---------------------------------------------------------------------------

describe('test_the_animation_reads_no_clock', () => {
  it('spinFrame is a pure function of its index', () => {
    for (let i = 0; i < SPIN_FRAMES; i++) {
      expect(spinFrame(i)).toEqual(spinFrame(i));
    }
  });
  it('emblemFrame is a pure function of its angle', () => {
    for (const a of [0.0, 0.3, Math.PI / 2, 2.4, Math.PI]) {
      expect(emblemFrame(a)).toEqual(emblemFrame(a));
    }
  });
  it('spinFrameIndex is a pure function of its elapsed', () => {
    for (const t of [0.0, 0.08, 0.37, 5.0]) {
      expect(spinFrameIndex(t)).toBe(spinFrameIndex(t));
    }
  });
  it('banner.tsx imports no clock module and reads no clock', () => {
    // Python AST-checked the imports; in TS the clock needs no import, so the
    // honest equivalent is a token check on the module source: no timers
    // import, no Date/performance access anywhere in the module.
    const clockTokens = [
      'node:timers',
      'node:perf_hooks',
      'Date.now',
      'new Date',
      'performance.now',
      'performance.',
      'setTimeout',
      'setInterval',
    ];
    for (const tok of clockTokens) {
      expect(BANNER_SRC.includes(tok)).toBe(false);
    }
  });
  it('all three spin functions are defined', () => {
    expect(typeof spinFrame).toBe('function');
    expect(typeof emblemFrame).toBe('function');
    expect(typeof spinFrameIndex).toBe('function');
  });
});
