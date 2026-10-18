/**
 * rain.tsx — matrix rain.
 *
 * What this module is: the shared rain model (RainCanvas) plus the two
 * render paths that use it — MatrixRain (full-screen, boot) and
 * RainRichLog (the transcript scrollback with rain painted into its own
 * blank cells). Ink, like Textual's compositor, does not alpha-blend
 * sibling components and gives every cell to the frontmost one, so an
 * opaque pane hides anything rendered "behind" it; painting rain INSIDE
 * the pane is therefore the only way to get a rain background under the
 * transcript.
 *
 * Invariants:
 *  - Rain never replaces anything but a space cell — text is never obscured.
 *  - The Python original's mouse-selection/copy machinery (_highlight,
 *    get_selection, content offsets) is DESCOPED for Ink per PORT-MAP §3
 *    (ink has no mouse events); do not half-re-add it.
 *  - No JSX literals: the repo tsconfig declares no `jsx` compiler option
 *    (TS17004 would fail the build), so components use createElement.
 */

import {
  createElement,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import {Box, Text, useBoxMetrics, useWindowSize, type DOMElement} from 'ink';
import chalk from 'chalk';

import type { Palette } from '../theme.js';

export const GLYPHS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789';
export const ASCII_GLYPHS = '01ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿ<>[]{}/\\|+=*#$%&@';

export const TAIL_LEN = 9; // glyphs trailing behind a drop head

// Python random.randint(a, b) — inclusive at BOTH ends.
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 0 = brightest head, larger = dimmer tail. `subtle` is used for rain painted
// behind the transcript, where anything bright would fight the text: heads
// drop to the primary colour and the tail is uniformly dim.
//
// In subtle mode there is exactly one palette colour: no invented brightness
// curve (the Python comment warns Textual would have blended text-style
// dimming into a shade outside the palette) and no bright head to fight the
// transcript text.
function styleFor(intensity: number, palette: Palette, subtle = false): (s: string) => string {
  if (subtle) {
    return chalk.hex(palette.dim);
  }
  if (intensity <= 0) {
    return chalk.bold.hex(palette.accent);
  }
  if (intensity <= 2) {
    return chalk.hex(palette.primary);
  }
  if (intensity <= 5) {
    return chalk.hex(palette.dim);
  }
  return chalk.hex(palette.dim).dim;
}

// === SECTION === the rain model ===

export class RainCanvas {
  /** The rain model: one falling drop per column, ticked on a timer. */

  palette: Palette;
  readonly density: number;
  readonly asciiOnly: boolean;
  width = 0;
  height = 0;
  drops: number[] = [];
  frame = 0;
  active = true;

  constructor(palette: Palette, density = 0.55, asciiOnly = true) {
    this.palette = palette;
    this.density = density;
    this.asciiOnly = asciiOnly;
  }

  get glyphs(): string {
    return this.asciiOnly ? ASCII_GLYPHS : GLYPHS;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.drops = Array.from({length: this.width}, () =>
      Math.random() < this.density ? randInt(-this.height, 0) : -10_000,
    );
  }

  tick(): void {
    if (!this.active || this.drops.length === 0) {
      return;
    }
    this.frame += 1;
    if (this.frame % 3 === 0) {
      this.drops = this.drops.map(d => d + 1);
      for (let i = 0; i < this.drops.length; i++) {
        if (Math.random() < 0.03) {
          this.drops[i] = randInt(-8, 0);
        }
      }
    }
  }

  /** Rain glyphs sitting on row `y`: `{x: [glyph, intensity]}`. */
  cellsForRow(y: number): Map<number, [string, number]> {
    if (!this.active || this.drops.length === 0) {
      return new Map();
    }
    const cells = new Map<number, [string, number]>();
    const gl = this.glyphs;
    for (let x = 0; x < Math.min(this.width, this.drops.length); x++) {
      const head = this.drops[x]!;
      if (head - TAIL_LEN <= y && y <= head) {
        cells.set(x, [gl[Math.floor(Math.random() * gl.length)]!, head - y]);
      }
    }
    return cells;
  }

  grid(): Map<number, [string, number]>[] {
    return Array.from({length: this.height}, (_, y) => this.cellsForRow(y));
  }
}

/**
 * One full rain row as a per-column array of already-styled cells.
 *
 * Exported (not in the Python surface) because Ink has no layer stack: the
 * boot screen cannot render a MatrixRain widget *behind* its content the way
 * Textual's `layers:` CSS did, so it composites rain rows and content lines
 * itself, and needs the cells to splice content into.
 */
export function rainRowCells(
  canvas: RainCanvas,
  y: number,
  palette: Palette,
): string[] {
  const cells = canvas.cellsForRow(y);
  const bgHex = palette.bg.startsWith('#') ? chalk.bgHex(palette.bg) : null;
  const out: string[] = [];
  for (let x = 0; x < canvas.width; x++) {
    const cell = cells.get(x);
    if (cell === undefined) {
      out.push(' ');
      continue;
    }
    const painted = styleFor(cell[1], palette)(cell[0]);
    out.push(bgHex !== null ? bgHex(painted) : painted);
  }
  return out;
}

// === SECTION === ANSI-aware string helpers ===
//
// Ink renders strings, not rich Segments, so "paint into blank cells" and
// "wrap at a width" have to walk the string without letting escape
// sequences consume columns.

const ANSI_CSI = /\u001B\[[0-9;?]*[A-Za-z]/;

/** Visible width of an ANSI-styled string (escape sequences cost 0 columns). */
export function visibleWidth(s: string): number {
  let n = 0;
  for (const part of s.split(ANSI_CSI)) {
    n += [...part].length;
  }
  return n;
}

/**
 * A copy of `line` with rain glyphs painted into its blank cells.
 *
 * Only cells whose current character is a space are touched, so text is never
 * obscured — the same rule as the Python `_blend`. (Run merging is
 * unnecessary here: chalk already emits one escape run per styled piece.)
 */
function blendRain(
  line: string,
  cells: Map<number, [string, number]>,
  palette: Palette,
): string {
  if (cells.size === 0) {
    return line;
  }
  let out = '';
  let col = 0;
  const chars = [...line];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (ch === '\u001B') {
      // Skip a whole escape sequence (ESC [ params letter) without
      // consuming a column.
      let j = i + 1;
      if (chars[j] === '[') {
        j++;
        while (j < chars.length && !/[A-Za-z]/.test(chars[j]!)) {
          j++;
        }
        if (j < chars.length) {
          j++;
        }
      } else {
        j++;
      }
      out += chars.slice(i, j).join('');
      i = j;
      continue;
    }
    const cell = cells.get(col);
    // All rain glyphs in play here are single-column (ASCII_GLYPHS); if the
    // full katakana set is ever used behind text, the column arithmetic
    // needs wide-character handling.
    out += cell !== undefined && ch === ' ' ? styleFor(cell[1], palette, true)(cell[0]) : ch;
    col += 1;
    i += 1;
  }
  return out;
}

/**
 * Greedy word wrap that is ANSI-aware: escapes are copied through without
 * consuming columns, and the SGR state open at a break is re-emitted at the
 * start of the next line so styling survives the wrap. (Python got this from
 * rich's Segment machinery; nothing in the dependency set provides it.)
 */
function wrapAnsi(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) {
    return [line];
  }
  const lines: string[] = [];
  let cur = '';
  let col = 0;
  let sgr = ''; // concatenated open SGR sequences, re-emitted after a break
  let lastSpace = -1; // index into cur of the last break opportunity
  const chars = [...line];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === '\u001B') {
      // Copy a whole escape sequence through without consuming a column.
      let j = i + 1;
      if (chars[j] === '[') {
        j++;
        while (j < chars.length && !/[A-Za-z]/.test(chars[j]!)) {
          j++;
        }
        if (j < chars.length) {
          j++;
        }
      } else {
        j++;
      }
      const esc = chars.slice(i, j).join('');
      cur += esc;
      if (esc.endsWith('m')) {
        sgr = /^\u001B\[0?m$/.test(esc) ? '' : sgr + esc;
      }
      i = j;
      continue;
    }
    cur += c;
    if (c === ' ') {
      lastSpace = cur.length - 1;
    }
    col += 1;
    if (col > width) {
      if (lastSpace > 0) {
        const head = cur.slice(0, lastSpace);
        const tail = cur.slice(lastSpace + 1);
        lines.push(head);
        cur = sgr + tail;
        col = visibleWidth(tail);
        lastSpace = cur.lastIndexOf(' ');
      } else {
        // No break opportunity — hard-cut rather than overflow.
        lines.push(cur.slice(0, -1));
        cur = sgr + c;
        col = 1;
        lastSpace = -1;
      }
    }
    i += 1;
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  return lines;
}

function wrapBlocks(blocks: string[], width: number): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    for (const raw of block.split('\n')) {
      out.push(...wrapAnsi(raw, width));
    }
  }
  return out;
}

// === SECTION === MatrixRain (full screen) ===

export interface MatrixRainProps {
  palette: Palette;
  asciiOnly?: boolean;
  density?: number;
  /** Pause/blank the rain without unmounting (Python `set_active`). */
  active?: boolean;
}

/** Full-screen rain component (used on the boot screen). */
export const MatrixRain: FC<MatrixRainProps> = ({
  palette,
  asciiOnly = true,
  density = 0.55,
  active = true,
}) => {
  const canvasRef = useRef<RainCanvas | null>(null);
  if (canvasRef.current === null) {
    canvasRef.current = new RainCanvas(palette, density, asciiOnly);
  }
  const canvas = canvasRef.current;
  const [, setTickFrame] = useState(0);
  const {columns, rows} = useWindowSize();

  useEffect(() => {
    canvas.palette = palette;
  }, [canvas, palette]);
  useEffect(() => {
    canvas.active = active;
  }, [canvas, active]);
  useEffect(() => {
    canvas.resize(columns, rows);
  }, [canvas, columns, rows]);
  useEffect(() => {
    const t = setInterval(() => {
      canvas.tick();
      setTickFrame(f => (f + 1) % 1_000_000);
    }, 110);
    return () => {
      clearInterval(t);
    };
  }, [canvas]);

  if (!active || canvas.width <= 0 || canvas.height <= 0 || canvas.drops.length === 0) {
    // Still occupy the full area when blank, as the Python widget did.
    return createElement(Box, {width: '100%', height: '100%'});
  }

  const screen: string[] = [];
  for (let y = 0; y < canvas.height; y++) {
    screen.push(rainRowCells(canvas, y, palette).join(''));
  }
  return createElement(
    Box,
    {flexDirection: 'column', width: canvas.width, height: canvas.height},
    ...screen.map((line, i) => createElement(Text, {key: i, wrap: 'truncate'}, line)),
  );
};

// === SECTION === RainRichLog (the transcript) ===

/** The imperative surface the app/widget holds via a ref (Python methods). */
export interface RainRichLogHandle {
  /** Append a block of text (may be multi-line and ANSI-styled). */
  write(content: string): void;
  /** Drop every block (Python `clear`). */
  clear(): void;
  /** Toggle the rain behind the transcript (Python `set_rain`). */
  setRain(active: boolean): void;
}

export interface RainRichLogProps {
  palette: Palette;
  asciiOnly?: boolean;
  rainOn?: boolean;
  /**
   * Controlled content: pre-rendered React nodes (the ChatPane's transcript
   * blocks). Rendered as-is — Ink's own layout wraps and reflows ReactNode
   * children on resize, so the ANSI wrap/rain-blend path below does not
   * (and cannot) apply to them. Composed after any blocks written through
   * the ref handle; use one source or the other.
   */
  blocks?: ReactNode[];
  /**
   * Render only the last `height` lines, bottom-anchored — the analog of
   * RichLog's fixed height with `scroll_end` pinned. Applies to the
   * string-line (write()) portion; ReactNode blocks are laid out by Ink.
   */
  height?: number;
  /** React 19 ref-as-prop; receives the write/clear/setRain handle. */
  ref?: Ref<RainRichLogHandle>;
}

// Seconds to wait for a resize burst to settle before re-wrapping (Python
// REFLOW_DELAY). A terminal drag emits a resize event per frame; reflowing
// the whole transcript on each one would stutter.
const REFLOW_DELAY_MS = 50;

/**
 * The transcript scrollback: rain rendered behind its own blank cells.
 *
 * Also carries the reflow behaviour the transcript needs: lines are wrapped
 * lazily at the CURRENT width, so a terminal resize re-wraps everything
 * without the Python original having to keep renderables and replay them.
 * A height-only resize changes nothing (wrap depends on width alone).
 */
export const RainRichLog: FC<RainRichLogProps> = ({
  palette,
  asciiOnly = true,
  rainOn = true,
  blocks,
  height,
  ref,
}) => {
  const boxRef = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(boxRef as RefObject<DOMElement | null>);
  const {columns, rows} = useWindowSize();
  // Content size ignores the pane border, so drops line up with the text —
  // measure the box itself, falling back to the window before the first
  // layout pass (metrics read zero until then).
  const measuredWidth = metrics.hasMeasured ? Math.max(1, metrics.clientWidth) : columns;
  const measuredHeight = metrics.hasMeasured ? metrics.clientHeight : rows;

  const blocksRef = useRef<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [rainActive, setRainActive] = useState(rainOn);

  // Sparse and dim: this rain sits behind live text, so it is texture,
  // not a focal point (density 0.18, subtle styles).
  const canvasRef = useRef<RainCanvas | null>(null);
  if (canvasRef.current === null) {
    canvasRef.current = new RainCanvas(palette, 0.18, asciiOnly);
  }
  const canvas = canvasRef.current;

  useEffect(() => {
    canvas.palette = palette;
  }, [canvas, palette]);
  useEffect(() => {
    canvas.active = rainActive;
  }, [canvas, rainActive]);
  useEffect(() => {
    canvas.resize(measuredWidth, measuredHeight || rows);
  }, [canvas, measuredWidth, measuredHeight, rows]);
  useEffect(() => {
    if (!rainActive) {
      return;
    }
    const t = setInterval(() => {
      canvas.tick();
      setRevision(r => (r + 1) % 1_000_000);
    }, 110);
    return () => {
      clearInterval(t);
    };
  }, [canvas, rainActive]);

  // Debounce the wrap width: only a WIDTH change can change how the
  // transcript wraps, and re-wrapping per drag frame is the stutter the
  // Python reflow timer avoided.
  const [wrapWidth, setWrapWidth] = useState(measuredWidth);
  useEffect(() => {
    const t = setTimeout(() => {
      setWrapWidth(measuredWidth);
    }, REFLOW_DELAY_MS);
    return () => {
      clearTimeout(t);
    };
  }, [measuredWidth]);

  // `revision` covers writes/clears (blocksRef mutations); wrapWidth covers
  // reflows. React cannot see ref contents, so it must be told.
  const lines = useMemo(
    () => wrapBlocks(blocksRef.current, wrapWidth),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, wrapWidth],
  );

  useImperativeHandle(
    ref,
    () => ({
      // Strings are immutable, so the Python `_freeze` copy-on-write guard
      // is satisfied by construction — the caller cannot mutate what we
      // hold.
      write(content: string) {
        blocksRef.current.push(content);
        setRevision(r => r + 1);
      },
      clear() {
        blocksRef.current = [];
        setRevision(r => r + 1);
      },
      setRain(active: boolean) {
        setRainActive(active);
      },
    }),
    [],
  );

  const display = height !== undefined ? lines.slice(-height) : lines;
  const painted = display.map((line, y) =>
    rainActive ? blendRain(line, canvas.cellsForRow(y), palette) : line,
  );

  return createElement(
    Box,
    {ref: boxRef, flexDirection: 'column', height},
    ...painted.map((line, i) => createElement(Text, {key: i}, line)),
    ...(blocks ?? []).map((block, i) =>
      createElement(Box, {key: `b${i}`, flexDirection: 'column'}, block),
    ),
  );
};
