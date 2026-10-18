/**
 * boot.tsx — the boot screen: ASCII banner reveal + fake system check,
 * then fade to the UI.
 *
 * What this module is: a pure phase machine (bootTick — the port of the
 * Python `_tick`, kept terminal-free and directly drivable, as the Python
 * tests drove `_tick` with stubbed widgets) plus the BootScreen component
 * that runs it on a 0.045s interval and renders the composed frame.
 *
 * Invariants:
 *  - The spin's frame count and duration agree with the tick loop:
 *    TICKS_PER_FRAME is derived from SPIN_SECONDS / 0.045 / SPIN_FRAMES,
 *    never hardcoded, so changing either constant keeps them in step.
 *  - Ink has no layer stack, so where Python mounted a MatrixRain widget
 *    behind the boot widgets via CSS layers, this screen composites the
 *    rain rows (same RainCanvas model) and the centred content itself.
 *  - The clock is never read inside the animation: state carries `ticks`,
 *    and the derived frame index is a pure function of it.
 *  - No JSX literals: the repo tsconfig declares no `jsx` compiler option
 *    (TS17004 would fail the build), so the component uses createElement.
 */

import {createElement, useEffect, useRef, useState, type FC} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import chalk from 'chalk';

import type { Palette } from '../theme.js';
import {
  EMBLEM,
  SPIN_FRAMES,
  SPIN_SECONDS,
  bannerLines,
  bannerWidth,
  spinFrame,
} from './banner.js';
import {RainCanvas, rainRowCells, visibleWidth} from './rain.js';

export const GLITCH = '!<>-_\\/[]{}—=+*^?#@$%&01';

export const SPINNER_STEPS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

// How many 0.045s ticks each spin frame is held. Derived from SPIN_SECONDS so
// the two cannot drift apart; at the current values it is exactly 2, giving a
// full revolution in 1.08s — a deliberate turn rather than a flicker.
export const TICKS_PER_FRAME = Math.max(1, Math.round(SPIN_SECONDS / 0.045 / SPIN_FRAMES));

/** One fake system-check row: [label, value, ok]. */
export type BootCheck = [string, string, boolean];

export type BootPhase = 'banner' | 'checks' | 'fade' | 'done';

export interface BootState {
  phase: BootPhase;
  revealed: number;
  checkIndex: number;
  ticks: number;
  spinner: number;
}

export function initialBootState(): BootState {
  return {phase: 'banner', revealed: 0, checkIndex: 0, ticks: 0, spinner: 0};
}

/**
 * One 0.045s tick of the boot phase machine — the port of BootScreen._tick,
 * extracted so it runs with no terminal, widget or clock.
 */
export function bootTick(state: BootState, width: number, checkCount: number): BootState {
  const ticks = state.ticks + 1;
  const spinner = state.spinner + 1;

  if (state.phase === 'banner') {
    let revealed = state.revealed + Math.max(1, Math.floor(width / 26));
    // Explicit BootPhase: the guard above narrows state.phase to 'banner',
    // which would otherwise make the 'checks' assignment below ill-typed.
    let phase: BootPhase = state.phase;
    if (revealed > width + 6) {
      revealed = width + 6;
      phase = 'checks';
    }
    return {...state, phase, revealed, ticks, spinner};
  }

  if (state.phase === 'checks') {
    // advance one check roughly every 4 ticks (≈180ms)
    let checkIndex = state.checkIndex;
    if (ticks % 4 === 0) {
      checkIndex += 1;
    }
    if (checkIndex >= checkCount) {
      return {...state, phase: 'fade', checkIndex: checkCount, ticks: 0, spinner};
    }
    return {...state, checkIndex, ticks, spinner};
  }

  if (state.phase === 'fade') {
    if (ticks >= 8) {
      return {...state, phase: 'done', ticks, spinner};
    }
    return {...state, ticks, spinner};
  }

  // done: the component's dwell timer owns the handoff from here.
  return state;
}

// Deterministic glitch pick, seeded by (tick, row, col), rather than
// Math.random(): a React re-render can happen without a tick (a rain frame,
// a parent update), and a per-render random would scramble the glitch head
// between ticks. Python chose randomly per render — its render only ran on
// ticks, so this is the same behaviour minus the re-render artifact.
function glitchChar(tick: number, row: number, col: number): string {
  const h = (tick * 31 + row * 7 + col * 13) >>> 0;
  return GLITCH[h % GLITCH.length]!;
}

// Python str.isprintable(): space is printable; control, format, surrogate,
// unassigned and separator code points are not.
function isPrintable(ch: string): boolean {
  if (ch === ' ') {
    return true;
  }
  return !/\p{C}|\p{Z}/u.test(ch);
}

export interface BootScreenProps {
  palette: Palette;
  checks: BootCheck[];
  /** Called once when boot finishes: (buffered keys, submitFlag). */
  onDone: (typed: string[], submit: boolean) => void;
  rain?: boolean;
}

/** Animated boot sequence. Calls `onDone` when finished. */
export const BootScreen: FC<BootScreenProps> = ({palette, checks, onDone, rain = true}) => {
  const [state, setState] = useState<BootState>(initialBootState);
  const [, setRainFrame] = useState(0);
  const {columns, rows} = useWindowSize();

  // Printable keys seen while booting; the app replays them into the prompt
  // so a fast typist loses nothing. Kept in a ref mirror as well as state so
  // the delayed finish callback always reads the latest buffer, not the one
  // captured when the dwell timer was armed.
  const [typed, setTyped] = useState<string[]>([]);
  const typedRef = useRef<string[]>([]);
  const submitRef = useRef(false);
  const finishedRef = useRef(false);

  const canvasRef = useRef<RainCanvas | null>(null);
  if (rain && canvasRef.current === null) {
    canvasRef.current = new RainCanvas(palette, 0.55, true);
  }
  const canvas = canvasRef.current;
  const rainActive = rain && canvas !== null && canvas.active;

  useEffect(() => {
    if (canvas) {
      canvas.palette = palette;
    }
  }, [canvas, palette]);
  useEffect(() => {
    if (canvas) {
      canvas.resize(columns, rows);
    }
  }, [canvas, columns, rows]);

  useEffect(() => {
    const t = setInterval(() => {
      setState(s => bootTick(s, bannerWidth(), checks.length));
    }, 45);
    return () => {
      clearInterval(t);
    };
  }, [checks.length]);

  // The rain runs on its own 0.11s clock, as in Python — a second timer, not
  // a faster boot tick.
  useEffect(() => {
    if (!canvas) {
      return;
    }
    const t = setInterval(() => {
      canvas.tick();
      setRainFrame(f => (f + 1) % 1_000_000);
    }, 110);
    return () => {
      clearInterval(t);
    };
  }, [canvas]);

  const finish = (submit: boolean) => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onDone(typedRef.current, submit);
  };

  // Auto-continue once the machine reaches `done`. Any buffered text is
  // preserved in the prompt, so finishing here never truncates what the user
  // typed. The dwell is long enough to read the credits and the ready line.
  useEffect(() => {
    if (state.phase !== 'done') {
      return;
    }
    const t = setTimeout(() => {
      finish(submitRef.current);
    }, 2200);
    return () => {
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  useInput((input, key) => {
    // Printable characters are buffered and replayed into the prompt by the
    // app, so a fast typist loses nothing. Enter finishes boot AND marks the
    // line for submission (otherwise the Enter that submits a buffered
    // prompt would be swallowed as "skip"). ink hands whole pastes through
    // as one string — spread so each printable char is its own entry.
    if (key.escape) {
      finish(false); // BINDINGS: escape → skip
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      submitRef.current = true;
      finish(true);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      const printable = [...input].filter(isPrintable);
      if (printable.length > 0) {
        typedRef.current = [...typedRef.current, ...printable];
        setTyped(typedRef.current);
      }
    }
  });

  // ---- derived render -----------------------------------------------------

  // The spin index is driven off the tick counter — no second timer, and no
  // clock read. TICKS_PER_FRAME is derived from the two constants rather
  // than hardcoded so changing either one keeps them in step.
  const spinIndex = Math.floor(state.ticks / TICKS_PER_FRAME) % SPIN_FRAMES;
  // The spin belongs to the "logo is arriving" moment. Leaving it turning
  // through the system check would be a distraction next to text the
  // operator is meant to read, so once the wordmark is fully revealed it
  // settles on EMBLEM and stays there.
  const emblemRows = state.phase !== 'banner' ? EMBLEM : spinFrame(spinIndex);
  // Style the frame as a unit, taken from its own fill glyph, so it tracks
  // SPIN_SHADES rather than inventing a second brightness curve. Testing
  // row by row instead lit the caps and dimmed the fill on an edge-on
  // frame, which reads as a mistake rather than as a turn.
  const lit = emblemRows[1]!.trim().startsWith('█');
  const emblemStyle = lit ? chalk.bold.hex(palette.accent) : chalk.hex(palette.dim);
  const emblemLines = emblemRows.map(row => emblemStyle(row));

  const bannerPaint: string[] = [];
  const lines = bannerLines();
  for (let rowI = 0; rowI < lines.length; rowI++) {
    const line = lines[rowI]!;
    let out = '';
    for (let colI = 0; colI < line.length; colI++) {
      const ch = line[colI]!;
      if (ch === ' ') {
        out += ' ';
        continue;
      }
      if (colI < state.revealed) {
        // settled glyph; tail glyphs glow with the accent color
        const near = colI > state.revealed - 6;
        out += (near ? chalk.bold.hex(palette.accent) : chalk.hex(palette.primary))(ch);
      } else if (colI < state.revealed + 4) {
        // glitch head just ahead of the reveal edge
        out += chalk.bold.hex(palette.accent)(glitchChar(state.ticks, rowI, colI));
      } else {
        out += ' ';
      }
    }
    bannerPaint.push(out);
  }

  const checksLines: string[] = [];
  checksLines.push(chalk.bold.hex(palette.accent)('  ⟩ SYSTEM CHECK'));
  checksLines.push('');
  for (let i = 0; i < checks.length; i++) {
    const [label, value, ok] = checks[i]!;
    const dots = '·'.repeat(Math.max(2, 18 - label.length));
    const labelPad = `  ${label.padEnd(14)}`;
    if (i < state.checkIndex) {
      const mark = ok ? '[ OK ]' : '[ !! ]';
      const markStyle = ok ? chalk.bold.hex(palette.accent) : chalk.bold.hex(palette.red);
      checksLines.push(
        chalk.hex(palette.dim)(labelPad) +
          chalk.hex(palette.dim)(dots) +
          markStyle(` ${mark} `) +
          chalk.hex(palette.primary)(` ${value}`),
      );
    } else if (i === state.checkIndex && state.phase === 'checks') {
      const spin = SPINNER_STEPS[state.spinner % SPINNER_STEPS.length]!;
      checksLines.push(
        chalk.hex(palette.dim)(labelPad) +
          chalk.hex(palette.dim)(dots) +
          chalk.hex(palette.primary)(` ${spin} `) +
          chalk.hex(palette.dim)(` ${value}`),
      );
    } else {
      checksLines.push(chalk.hex(palette.dim)(labelPad));
    }
  }

  if (typed.length > 0) {
    checksLines.push(
      chalk.bold.hex(palette.accent)('  ❯ ') +
        chalk.hex(palette.primary)(typed.join('')) +
        chalk.bold.hex(palette.accent)('▊'),
    );
  }

  if (state.phase === 'done') {
    checksLines.push('');
    checksLines.push('');
    checksLines.push(chalk.bold.hex(palette.accent)('  ▸ SHELL READY — handshake complete'));
    checksLines.push(chalk.hex(palette.dim)('  ▸ press enter to continue'));
  }

  // Author credits — shown for the whole check phase, not just the tail, so
  // they are actually readable before the splash hands off to the UI.
  if (state.phase !== 'banner') {
    checksLines.push('');
    checksLines.push(
      chalk.hex(palette.dim)('  author     ') + chalk.hex(palette.primary)('Mr-Destroyer / ZIM'),
    );
    checksLines.push(
      chalk.hex(palette.dim)('  youtube    ') + chalk.hex(palette.primary)('@Study_Hard69'),
    );
    checksLines.push(
      chalk.hex(palette.dim)('  instagram  ') + chalk.hex(palette.primary)('zimthegoat'),
    );
  }

  // ---- compose the frame (Ink has no layers; splice content into rain) ----
  const contentLines = [...emblemLines, ...bannerPaint, '', ...checksLines];
  const top = Math.max(0, Math.floor((rows - contentLines.length) / 2));
  const screen: string[] = [];
  for (let y = 0; y < rows; y++) {
    const cells =
      rainActive && canvas !== null ? rainRowCells(canvas, y, palette) : Array.from({length: columns}, () => ' ');
    const ci = y - top;
    if (ci >= 0 && ci < contentLines.length) {
      const content = contentLines[ci]!;
      // Each line centred on its own width (the Python screen centred the
      // emblem, banner and checks widgets independently).
      const cw = Math.min(visibleWidth(content), columns);
      const col0 = Math.max(0, Math.floor((columns - cw) / 2));
      screen.push(cells.slice(0, col0).join('') + content + cells.slice(col0 + cw).join(''));
    } else {
      screen.push(cells.join(''));
    }
  }

  return createElement(
    Box,
    {flexDirection: 'column', width: columns, height: rows},
    ...screen.map((line, i) => createElement(Text, {key: i, wrap: 'truncate'}, line)),
  );
};
