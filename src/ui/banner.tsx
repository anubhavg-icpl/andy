/**
 * banner.tsx — the ANDY ASCII banner, in a few styles.
 *
 * What this module is: the block-font wordmark, the splash emblem, and the
 * coin-spin geometry the boot screen animates. Pure functions and constants
 * only — no React, no terminal, and (pinned by tests/test_boot.py) no clock
 * reads: every spin function takes its time/frame as a parameter, the
 * `spinner_at(now)` idiom from web.py. The one flaky check in the suite is
 * flaky precisely because the other animation reads the clock internally
 * with no injectable `now`; nothing here may join it.
 *
 * Invariants:
 *  - Each glyph is 6 rows tall. The boot screen reveals them with a
 *    per-column glitch/typewriter animation.
 *  - The two "facing" spin frames return EMBLEM itself, so the animation
 *    settles onto the static mark with no visible jump.
 *  - Despite the .tsx extension this file holds no JSX literals (the repo
 *    tsconfig declares no `jsx` compiler option); it is pure TS.
 */

import chalk from 'chalk';

import type { Palette } from '../theme.js';

// A compact block font for the characters in "ANDY" (plus the rest of the
// original wordmark's glyphs — renderWord is generic). 6 columns x 6 rows
// per glyph; '█' = lit pixel, ' ' = dark.
export const FONT: Record<string, string[]> = {
  Z: [
    '██████',
    '    ██',
    '   ██ ',
    '  ██  ',
    ' ██   ',
    '██████',
  ],
  I: [
    '██████',
    '  ██  ',
    '  ██  ',
    '  ██  ',
    '  ██  ',
    '██████',
  ],
  M: [
    '██  ██',
    '██████',
    '██████',
    '██  ██',
    '██  ██',
    '██  ██',
  ],
  L: [
    '██    ',
    '██    ',
    '██    ',
    '██    ',
    '██    ',
    '██████',
  ],
  '-': [
    '      ',
    '      ',
    '██████',
    '██████',
    '      ',
    '      ',
  ],
  H: [
    '██  ██',
    '██  ██',
    '██████',
    '██  ██',
    '██  ██',
    '██  ██',
  ],
  A: [
    ' ████ ',
    '██  ██',
    '██████',
    '██  ██',
    '██  ██',
    '██  ██',
  ],
  R: [
    '█████ ',
    '██  ██',
    '█████ ',
    '██ ██ ',
    '██  ██',
    '██  ██',
  ],
  N: [
    '██  ██',
    '███ ██',
    '██████',
    '██ ███',
    '██  ██',
    '██  ██',
  ],
  E: [
    '██████',
    '██    ',
    '█████ ',
    '██    ',
    '██    ',
    '██████',
  ],
  S: [
    '██████',
    '██    ',
    '██████',
    '    ██',
    '    ██',
    '██████',
  ],
  // D and Y are new for the ANDY wordmark (the pre-rename wordmark's glyph
  // set had no need of them); drawn in the same 6x6 block style so the
  // wordmark reads as one font.
  D: [
    '█████ ',
    '██  ██',
    '██  ██',
    '██  ██',
    '██  ██',
    '█████ ',
  ],
  Y: [
    '██  ██',
    '██  ██',
    '██████',
    '  ██  ',
    '  ██  ',
    '  ██  ',
  ],
  ' ': [
    '   ',
    '   ',
    '   ',
    '   ',
    '   ',
    '   ',
  ],
};

export const FONT_HEIGHT = 6;

export function renderWord(word: string, spacing = 1): string[] {
  /** Render `word` as FONT_HEIGHT lines of block text. */
  const rows = Array.from({length: FONT_HEIGHT}, () => '');
  for (const ch of word.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[' ']!;
    for (let i = 0; i < FONT_HEIGHT; i++) {
      rows[i] += glyph[i]! + ' '.repeat(spacing);
    }
  }
  return rows;
}

export function bannerLines(spacing = 1): string[] {
  return renderWord('ANDY', spacing);
}

// A second, small style: layered outline for the header bar / splash.
// Box width is derived from the content so the corners always line up.
export function outlineLines(width = 48): string[] {
  const body = 'A N D Y   //   n e t . s h e l l';
  const pad = Math.max(0, width - 2 - body.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return [
    '╔' + '═'.repeat(width - 2) + '╗',
    '║' + ' '.repeat(left) + body + ' '.repeat(right) + '║',
    '╚' + '═'.repeat(width - 2) + '╝',
  ];
}

export function bannerSubtitle(): string {
  /** One-line tagline shown under the splash banner. */
  return 'n e t . s h e l l   //   autonomous coding agent';
}

export function bannerWidth(spacing = 1): number {
  const lines = bannerLines(spacing);
  return Math.max(...lines.map(l => l.length));
}

// === SECTION === the splash mark ===

// The splash mark: a small emblem with the name beside it.
//
// Deliberately not the block wordmark above. That one is tens of columns of
// solid glyph, which is a wall of green in a transcript whose job is to be
// read, and it has to be centred by hand — a job the transcript's own
// reflow then undoes on the next rail drag. This is four rows of a
// two-column mark beside text, which stays legible in a narrow pane and
// centres itself at any width.

// The mark, four rows. Drawn by hand with half-blocks rather than run through
// FONT: the 6x6 block font has no concept of them, so there is nothing to
// reuse. It is a rounded block, the shape a terminal can actually hold —
// a circular logo would need far more rows to read as one.
export const EMBLEM: string[] = [
  ' ▄███▄ ',
  '███████',
  '███████',
  ' ▀███▀ ',
];

export const EMBLEM_GAP = '  ';

// The emblem's fixed width, in columns. Every spin frame is padded to this so
// the boot screen's layout does not jump as the mark turns.
export const EMBLEM_WIDTH = Math.max(...EMBLEM.map(row => row.length));

// === SECTION === the spin ===

// The spin. The operator asked for the logo to turn on load ("so it will look
// cool"), so the emblem above is rotated on its vertical axis — a coin-spin.
//
// Two properties matter more than the look, and both are load-bearing:
//
//   * The width narrows and the fill lightens as the mark turns away, so it
//     reads as *turning* rather than shrinking. A frame that only got narrower
//     would look like the logo being squeezed.
//   * The frames facing the viewer and facing away both return EMBLEM
//     itself, so the animation settles onto the static mark with no visible
//     jump. Without that the last frame would snap — a flat `▄▄▄▄▄` cap
//     against the rounded `▄███▄`.

// Frames per revolution, and how long each is held. Twelve frames over 1.08s
// reads as a smooth turn. The duration is not arbitrary: the boot screen ticks
// every 0.045s, and 1.08 / 0.045 / 12 is exactly 2, so each frame is held for
// a whole number of ticks and the two clocks agree. At 0.96s they did not —
// the tick loop could only manage 1.08s, so the constant was a lie.
export const SPIN_FRAMES = 12;
export const SPIN_SECONDS = 1.08;
export const SPIN_STEP = SPIN_SECONDS / SPIN_FRAMES;

// Geometry for one half-turn, indexed by how far round the mark is: entry 0 is
// facing the viewer, the middle entry is edge-on, and the second half of the
// revolution is this table read backwards. Deriving the second half rather
// than tabulating it is what makes the spin *exactly* symmetric.
//
// That symmetry is not a nicety. Scaling the width by `|cos theta|` directly
// was tried first and produced a visible artifact: the mirror-image frames are
// both `|cos| == 0.5`, but `cos(pi/3)` and `cos(2pi/3)` land either side
// of 0.5 in floating point, so one frame rendered three columns wide and its
// own mirror rendered four — and the shading glyph differed too. Folding the
// index removes the float boundary from the picture entirely.
export const SPIN_WIDTHS = [7, 5, 3, 1, 3, 5, 7] as const;
export const SPIN_SHADES = '██▒▒██';

// Python's `%` returns a non-negative result for a positive modulus; JS's
// returns the sign of the dividend. The spin index is fed counters that only
// rise, but emblemFrame/spinFrameIndex accept any angle/elapsed — the boot
// tests feed them negatives — so the modulo must behave like Python's.
function positiveMod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Python str.center, including its quirk of biasing the extra space LEFT when
// both the margin and the width are odd (`marg & width & 1`). Every margin in
// play here is even so the quirk never fires, but porting it exactly costs
// nothing and keeps spinFrame byte-identical to the Python output.
function center(s: string, width: number): string {
  const marg = width - s.length;
  if (marg <= 0) return s;
  const left = Math.floor(marg / 2) + (marg & width & 1);
  return ' '.repeat(left) + s + ' '.repeat(marg - left);
}

export function spinFrame(index: number): string[] {
  /**
   * The emblem at frame `index` of SPIN_FRAMES, as 4 rows of EMBLEM_WIDTH.
   *
   * The two "facing" frames — toward the viewer and away from it — return
   * EMBLEM itself. A symmetric mark has the same silhouette at 0 and 180
   * degrees, so that is both correct and what lets the animation settle onto
   * the static mark with no visible jump.
   */
  const i = positiveMod(index, SPIN_FRAMES);
  const half = Math.floor(SPIN_FRAMES / 2);
  const fold = i <= half ? i : SPIN_FRAMES - i;
  if (fold === 0 || fold === half) {
    return [...EMBLEM];
  }

  const outw = SPIN_WIDTHS[fold]!;
  const shade = SPIN_SHADES[fold]!;
  const rows: string[] = [];
  for (let r = 0; r < EMBLEM.length; r++) {
    if (r === 0 || r === EMBLEM.length - 1) {
      // Top and bottom keep their half-block caps — that rounding is what
      // makes it read as the same mark at any width.
      const cap = r === 0 ? '▄' : '▀';
      const n = Math.max(1, outw - 2);
      const pad = ' '.repeat(Math.floor((outw - n) / 2));
      rows.push(center(pad + cap.repeat(n) + pad, EMBLEM_WIDTH));
    } else {
      rows.push(center(shade.repeat(outw), EMBLEM_WIDTH));
    }
  }
  return rows;
}

// Python round() on a float is round-half-to-EVEN (banker's rounding); JS
// Math.round is half-away-from-zero. An arbitrary caller angle (15°, 45°, …)
// lands theta/2pi*SPIN_FRAMES exactly on .5, where the two disagree — the
// frame-table stepping the boot tests pin never hits a half, but a faithful
// port must not diverge from the Python output at any angle.
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) {
    return f;
  }
  if (diff > 0.5) {
    return f + 1;
  }
  return f % 2 === 0 ? f : f + 1; // exactly .5 — to the even neighbour
}

export function emblemFrame(theta: number): string[] {
  /**
   * The emblem at angle `theta` (radians), as 4 rows of EMBLEM_WIDTH cols.
   *
   * A coin-spin: the mark narrows and lightens as it turns edge-on, then
   * widens again. Rounds to the nearest frame rather than flooring, so a
   * caller stepping by `2*pi / SPIN_FRAMES` lands on each frame exactly
   * once.
   */
  return spinFrame(roundHalfEven((theta / (2 * Math.PI)) * SPIN_FRAMES));
}

export function spinFrameIndex(elapsed: number): number {
  /**
   * Which of SPIN_FRAMES is showing at `elapsed` seconds.
   *
   * Pure and explicit — the time is a parameter, never read from a clock
   * inside. That is the `spinner_at(now)` idiom from web.py, and it is
   * deliberate: the one flaky check in the suite is flaky precisely because
   * the other animation reads the clock internally with no injectable `now`.
   * Taking the time as an argument means this cannot join it.
   */
  // Math.trunc mirrors Python int() (truncate toward zero); positiveMod then
  // lands negatives in [0, SPIN_FRAMES) exactly like Python's `%`.
  return positiveMod(Math.trunc(elapsed / SPIN_STEP), SPIN_FRAMES);
}

// === SECTION === the composed splash ===

export function splashMark(palette: Palette, model = '', baseUrl = ''): string {
  /**
   * The splash banner: emblem and name side by side, as one styled string.
   *
   * Returned as a single multi-line string (ANSI-styled, \n-joined) rather
   * than an array of lines so the caller can centre it as one block — and
   * re-centre it every time the transcript reflows to a new width.
   * Centring this by padding the strings instead would look right at launch
   * and drift off-centre the first time a rail was dragged, which is the
   * fault this replaces.
   *
   * The lower rows carry the model and the endpoint, so the banner is the one
   * place that says what this session is actually pointed at.
   */
  const accentBold = chalk.bold.hex(palette.accent);
  const right: Array<[string, (s: string) => string]> = [
    ['ANDY', accentBold],
    [bannerSubtitle(), chalk.hex(palette.primary)],
    [model, chalk.hex(palette.dim)],
    [
      'type /help for commands' + (baseUrl ? `   ·   ${baseUrl}` : ''),
      chalk.hex(palette.dim),
    ],
  ];
  const width = Math.max(...EMBLEM.map(row => row.length));
  const lines: string[] = [];
  for (let i = 0; i < EMBLEM.length; i++) {
    lines.push(
      accentBold(EMBLEM[i]!.padEnd(width) + EMBLEM_GAP) + right[i]![1](right[i]![0]),
    );
  }
  return lines.join('\n');
}
