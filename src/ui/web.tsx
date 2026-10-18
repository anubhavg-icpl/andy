/**
 * web.tsx — the wave view: ten agents, a tracker rail, and the detail drawer.
 *
 * `/bug-hunt` runs its wave as ten concurrent agents, and without this view
 * the operator's only window on that is a scrolling transcript: ten
 * interleaved streams of tool output with the findings buried in whichever one
 * happened to print them. This draws the shape of the wave instead: one pane
 * per agent showing the command it is running and what that command returned,
 * beside a rail that tallies what the engagement has actually found.
 *
 * Invariants (the load-bearing ones, ported from ui/web.py):
 *  - Why a rail and not a web: the first cut drew a centre node with panes
 *    around it joined by diagonals. It looked right and worked badly — the
 *    diagonals cost gutter columns, the centre node took 30 columns out of the
 *    middle, and the panes were left too small to read an HTTP response. The
 *    tracker is a rail on the left now and the panes get every column left.
 *  - ANDY-TRACK is a view, not an agent: a deterministic tally fed by
 *    report_finding events as they land. It costs nothing, it cannot
 *    hallucinate a bug, and it updates in the same event that carries the
 *    finding.
 *  - Everything is drawn into a character grid and converted to React nodes
 *    at the end. The grid is what makes this testable — render is a pure
 *    function of the model and a size — and it is also the hit map: the grid
 *    records what each cell belongs to as it paints, which is what lets a
 *    click on a severity lane or an agent's pane resolve to the thing drawn
 *    there. The model predicts nothing about its own layout; the drawing IS
 *    the layout.
 *  - WaveWeb is deliberately free of React state: every mutation is driven by
 *    a hunt event and every read is a pure render. The owning screen drives
 *    repaints on a timer.
 *
 * Sections:
 *   1. severity + palette          4. the character grid (and hit map)
 *   2. geometry constants          5. WaveWeb — mutation
 *   3. text helpers                6. WaveWeb — reads / layout / render
 */

import { createElement, Fragment, type ReactNode } from "react";
import { Text } from "ink";
import { SEVERITY_ORDER, VALID_SEVERITIES, normaliseSeverity } from "../hunt.js";
import { summariseCall } from "../tools.js";
import type { Config } from "../config.js";
import type { Palette } from "../theme.js";

// === SECTION === 1. severity + palette ===

/**
 * The severity ladder, worst first, with the colour each rung is drawn in.
 * Read off the palette rather than invented, so a theme change carries.
 */
const SEVERITY_ATTR: Record<string, "red" | "amber" | "primary" | "dim"> = {
  critical: "red",
  high: "red",
  medium: "amber",
  low: "primary",
  info: "dim",
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
  info: "INFO",
};

/**
 * Rungs the rail shows. INFO is deliberately absent: it is the bucket a
 * finding lands in when a model gave no severity at all, so a lane for it
 * would mostly count parser noise.
 */
export const LANES = ["critical", "high", "medium", "low"] as const;

/** The style string for a severity rung, on this palette. */
export function severityStyle(palette: Palette, severity: string): string {
  const attr = SEVERITY_ATTR[normaliseSeverity(severity)] ?? "dim";
  return palette[attr] || palette.dim;
}

// === SECTION === 2. geometry ===

/**
 * Geometry. The view needs room for the rail, at least one column of panes and
 * a pane wide enough to read a command in; below this it degrades to a plain
 * list rather than drawing panes that overlap.
 */
export const MIN_WIDTH = 92;
export const MIN_HEIGHT = 26;

/**
 * The tracker rail. Narrow enough to leave the panes most of a 118-column
 * terminal, wide enough for a lane bar and a truncated finding title. The
 * default is the narrow end of that range on purpose: at 118 columns the four
 * columns a 30-wide rail would cost come straight out of the panes, and the
 * panes are where the commands and output are — the rail only has to fit
 * "ANDY-TRACK" and a severity label, which 26 columns does with room to spare.
 */
export const RAIL_W = 26;
export const RAIL_MIN_W = 22;
export const RAIL_MAX_W = 44;

/**
 * The detail drawer, opened by clicking a lane or a pane. It takes width from
 * the right; the panes are re-laid out around whatever is left, so opening it
 * never covers the work it is describing.
 */
export const DRAWER_W = 54;
export const DRAWER_MIN_W = 34;
export const DRAWER_MAX_W = 76;

/**
 * Pane geometry. PANE_PREF_W is the width a pane prefers — enough for a full
 * curl command without eliding the interesting flag — and the layout only goes
 * below it when the terminal leaves no choice.
 */
export const PANE_PREF_W = 32;
export const PANE_MIN_W = 22;
/**
 * The width past which a pane is only holding empty space. A command is
 * clipped to the pane either way, so a 60-column pane with a 26-column command
 * in it is a command and a hole — and a two-agent wave would otherwise draw
 * two 80-column panes and leave the middle of the screen blank.
 */
export const PANE_MAX_W = 44;
export const BOX_MIN_H = 5; // top border, command, one output row, tail, bottom border
/**
 * The height below which a pane is not worth drawing: a command and three
 * lines of what it returned. This is the number the column choice is built
 * around — a 28-column pane that shows four output rows beats a 40-column one
 * that shows one, because the output is the thing that was unreadable.
 */
export const BOX_GOOD_H = 7;
export const BOX_MAX_H = 16;

/** Findings echoed in the rail under the lanes. */
export const FEED_LINES = 3;

/**
 * How long an agent's pane stays lit after it reports something. Long enough
 * to catch the eye, short enough that a quiet agent does not look active.
 */
export const FLASH_SECONDS = 2.5;

/** Command history kept per agent, for the drawer that is opened on it later. */
export const HISTORY_MAX = 40;

/**
 * How long the hidden-agent window holds still before rotating to the next
 * quiet agents. Slow enough to read a pane, fast enough that a stalled agent
 * is not invisible for long.
 */
export const ROTATE_SECONDS = 8.0;

/**
 * How many output lines a pane keeps from the last result. The pane draws what
 * its height allows; the rest are for the drawer.
 */
export const OUTPUT_MAX = 60;

/**
 * Braille spinner. One glyph per tick, so a running agent is visibly running
 * even when its command and output have not changed for a while — a frozen
 * pane is otherwise indistinguishable from a stalled agent, which is the fault
 * this view exists to expose.
 */
export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const SPINNER_SECONDS = 0.09;

/**
 * How long a command takes to type itself into its pane. Fast enough not to
 * delay the information, slow enough that a change of command is caught by the
 * eye while reading a different pane.
 */
export const REVEAL_SECONDS = 0.45;

/**
 * A finding's pulse travelling along the rail. Cosmetic, but it is the one
 * animation here that points at *where* the news landed.
 */
export const PULSE_SECONDS = 1.4;

/** Monotonic clock in seconds (Python time.monotonic; drives every animation). */
function mono(): number {
  return performance.now() / 1000;
}

/** The spinner glyph for this instant. Driven off the clock, not a counter.
 *
 *  render runs several times a second and is also called directly by tests and
 *  by the findings path, so a frame counter would advance at a rate that
 *  depends on how often the view happened to be painted. The clock does not.
 */
export function spinnerAt(now?: number): string {
  const t = now ?? mono();
  return SPINNER[Math.floor(t / SPINNER_SECONDS) % SPINNER.length];
}

// === SECTION === 3. text helpers ===

/** Truncate to width, with an ellipsis when something was cut. */
function clip(text: string, width: number): string {
  const s = String(text ?? "").replace(/\n/g, " ").trim();
  if (width <= 0) return "";
  if (s.length <= width) return s;
  return s.slice(0, width - 1) + "…";
}

/**
 * Wrap a URL or host so it stays recognisable when it does not fit.
 *
 * A URL broken at an arbitrary column reads as two URLs — `orders/10` on one
 * line and `42` on the next is not the asset that was found, and the drawer is
 * the one place the operator goes to copy it down. So the scheme goes first
 * (it says nothing about *which* asset this is), then breaks happen at path
 * separators, so every line after the first is still a real path prefix.
 */
function wrapAsset(asset: string, width: number): string[] {
  if (width <= 0) return [];
  let a = String(asset ?? "").trim();
  if (!a) return [""];
  // Fits as it is: left exactly as found, scheme and all. Dropping the scheme
  // here would be a loss for no gain — a URL the operator copies out of the
  // drawer should be the URL that was found.
  if (a.length <= width) return [a];
  // It does not fit, so something has to go. The scheme is the least
  // informative part and the easiest to drop, and dropping it alone often
  // makes the rest fit. Dropped up front rather than left on the first line:
  // at a narrow width the first break would otherwise land right after it and
  // leave a line reading "http://" on its own, which is worse than useless.
  for (const scheme of ["https://", "http://"]) {
    if (a.startsWith(scheme)) {
      a = a.slice(scheme.length);
      break;
    }
  }
  if (a.length <= width) return [a];
  const out: string[] = [];
  let rest = a;
  while (rest.length > width) {
    // Prefer a separator, so the line is a prefix of the real path. A host
    // with no separator at all still has to be split, or it would overflow.
    let cut = rest.lastIndexOf("/", width);
    if (cut <= 0) cut = rest.lastIndexOf("?", width);
    if (cut <= 0) cut = width;
    else cut += 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Wrap text to width, on words where it can.
 *
 * The planner's prose is the only account of why a wave is aimed where it is,
 * so it is wrapped rather than clipped — a line cut at the pane edge is not an
 * account of anything. A word longer than the line is split rather than
 * allowed to overflow.
 */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (let para of String(text ?? "").split(/\r?\n/)) {
    para = para.trim();
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of para.split(/\s+/)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

// === SECTION === 4. the character grid (and hit map) ===

/** What a click resolved to: ("lane", severity) | ("pane", name) | ... */
type Hit = [string, string];

/**
 * A mutable character canvas. Out-of-bounds writes are dropped.
 *
 * Also the hit map. The grid is the only thing that knows where anything was
 * drawn, so it records what each cell belongs to as it paints: a lane row in
 * the rail, an agent's pane, a row in the drawer. WaveWeb.hit reads it back,
 * which is what makes the view clickable without the model having to predict
 * its own layout.
 */
class Grid {
  readonly width: number;
  readonly height: number;
  readonly cells: [string, string][][];
  /** "x,y" -> (kind, key). Kinds: lane, pane, drawer, agent, rail, planner. */
  readonly hits = new Map<string, Hit>();

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => [" ", ""] as [string, string]),
    );
  }

  /**
   * Mark every cell of a rectangle as belonging to kind/key.
   *
   * Called before the content is drawn, so a later write over one of these
   * cells does not erase the hit — the whole pane stays clickable, not only
   * the glyphs that happen to sit on it.
   */
  region(x: number, y: number, w: number, h: number, kind: string, key: string): void {
    for (let j = Math.max(0, y); j < Math.min(this.height, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.width, x + w); i++) {
        this.hits.set(`${i},${j}`, [kind, key]);
      }
    }
  }

  put(x: number, y: number, ch: string, style = ""): void {
    if (0 <= x && x < this.width && 0 <= y && y < this.height) {
      this.cells[y][x] = [ch, style];
    }
  }

  text(x: number, y: number, s: string, style = ""): void {
    for (let i = 0; i < s.length; i++) this.put(x + i, y, s[i], style);
  }

  /** A bordered pane, optionally with a title in its top border. */
  box(x: number, y: number, w: number, h: number, title = "", style = "", heavy = false): void {
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br, hz, vt] = heavy
      ? ["┏", "┓", "┗", "┛", "━", "┃"]
      : ["┌", "┐", "└", "┘", "─", "│"];
    this.put(x, y, tl, style);
    this.put(x + w - 1, y, tr, style);
    this.put(x, y + h - 1, bl, style);
    this.put(x + w - 1, y + h - 1, br, style);
    for (let i = 1; i < w - 1; i++) {
      this.put(x + i, y, hz, style);
      this.put(x + i, y + h - 1, hz, style);
    }
    for (let j = 1; j < h - 1; j++) {
      this.put(x, y + j, vt, style);
      this.put(x + w - 1, y + j, vt, style);
    }
    if (title && w >= 8) {
      const label = ` ${clip(title, w - 6)} `;
      this.text(x + 2, y, label, style);
    }
  }

  hline(x0: number, x1: number, y: number, ch = "─", style = ""): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.put(x, y, ch, style);
  }

  vline(x: number, y0: number, y1: number, ch = "│", style = ""): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.put(x, y, ch, style);
  }

  /**
   * The grid as React nodes, merging runs that share a style.
   *
   * Merging matters for size, not looks: a 100x40 canvas is 4,000 cells, and
   * one styled span per cell would be 4,000 elements for Ink to reconcile on
   * every repaint.
   */
  toReact(): ReactNode {
    const rows = this.cells.map((row, y) => {
      const kids: ReactNode[] = [];
      let run: string[] = [];
      let runStyle: string | null = null;
      const flush = () => {
        if (!run.length) return;
        kids.push(gridSpan(run.join(""), runStyle!, kids.length));
        run = [];
      };
      for (const [ch, style] of row) {
        if (runStyle === null || style === runStyle) {
          runStyle = style;
          run.push(ch);
        } else {
          flush();
          runStyle = style;
          run.push(ch);
        }
      }
      flush();
      if (!kids.length) kids.push(""); // keep the row: blank rows are layout
      return createElement(Text, { key: y }, ...kids);
    });
    return createElement(Fragment, null, ...rows);
  }
}

/** One merged grid run as an Ink span. Style is "bold <color>" or "<color>". */
function gridSpan(s: string, style: string, key: number): ReactNode {
  if (!style) return s;
  let bold = false;
  let color: string | undefined;
  for (const tok of style.split(" ")) {
    if (tok === "bold") bold = true;
    else if (tok && !color) color = tok;
  }
  if (!bold && !color) return s;
  return createElement(Text, { key, bold: bold || undefined, color }, s);
}

// === SECTION === 5. model types ===

/** One agent's pane: what it is doing, and what it has found. */
export class AgentCell {
  name: string;
  brief = "";
  activity = "waiting";
  status: "idle" | "running" | "done" | "failed" = "idle";
  findings = 0;
  worst = ""; // worst severity it has reported
  last = ""; // title of its most recent finding
  flash = 0.0; // monotonic stamp of its last report
  /** The command this agent is running, one line — `$ curl -s $U/admin`. */
  command = "";
  /**
   * The last few lines of what that command returned. Bounded, and the pane
   * draws only as many of them as its height allows.
   */
  output: string[] = [];
  /** (command, output) pairs, oldest first, for the drawer. This is the
   *  agent's whole run, not only where it ended up. */
  history: [string, string][] = [];
  /** Monotonic stamp of the last thing this agent did — a call or a result.
   *  Drives visibleAgents, which shows the busiest panes first. */
  activityAt = 0.0;
  /** Monotonic stamp the current command was set, so it can type itself in. */
  commandAt = 0.0;
  /**
   * Index into history of a tool call whose result has not arrived yet, or
   * -1. The call is recorded when it starts so the drawer does not lag the
   * pane, and the result fills that same entry in rather than appending a
   * second one — otherwise every step appears twice.
   */
  pending = -1;

  constructor(name: string, brief = "") {
    this.name = name;
    this.brief = brief;
  }

  /** Whether the pane is still flashing from a recent report. */
  lit(now?: number): boolean {
    return this.flash > 0 && (now ?? mono()) - this.flash < FLASH_SECONDS;
  }

  /** Whether the finding pulse is still travelling for this agent. */
  pulse(now?: number): boolean {
    return this.flash > 0 && (now ?? mono()) - this.flash < PULSE_SECONDS;
  }

  /**
   * The command, typed in as far as this instant has got.
   *
   * A command appearing whole in a pane that the eye is not currently on is
   * easy to miss; typing it in over half a second is the difference between
   * noticing the agent moved on and assuming it is stuck.
   */
  revealed(now?: number): string {
    if (!this.command) return "";
    const t = now ?? mono();
    if (!this.commandAt) return this.command;
    const age = t - this.commandAt;
    if (age >= REVEAL_SECONDS) return this.command;
    const n = Math.floor(this.command.length * (age / REVEAL_SECONDS));
    return this.command.slice(0, Math.max(1, n));
  }
}

/**
 * What the drawer is showing, if anything.
 *
 * kind is "findings" (the list behind one severity lane) or "agent" (one
 * agent's command history). key is the severity or the agent name. A null
 * WaveWeb.detail means the drawer is closed (Python's Detail.__bool__).
 */
export class Detail {
  kind: string;
  key: string;

  constructor(kind: string, key: string) {
    this.kind = kind;
    this.key = key;
  }
}

/**
 * Where everything goes at one size. Computed once per render.
 *
 * Kept as a value rather than recomputed at each draw site so the drawing code
 * and the hit map can never disagree about where a pane was: both read this.
 */
export class Layout {
  railW = 0;
  drawerW = 0;
  paneW = 0;
  boxH = 0;
  cols = 0;
  rows = 0;
  panesX = 0;
  panesW = 0;
  capacity = 0;
  /** How far the block of panes is inset from panesX, so a wave that does not
   *  fill the width is centred in it rather than stretched across it. */
  inset = 0;

  /** Whether there is room for the rail-and-panes layout at all. */
  get web(): boolean {
    return this.cols >= 1 && this.boxH >= BOX_MIN_H;
  }
}

/** A finding as the wave view records it (hunt's report_finding payload). */
export interface WaveFinding {
  severity?: string;
  agent?: string;
  title?: string;
  asset?: string;
  wave?: number | string;
  summary?: string;
  evidence?: string;
  remediation?: string;
  [key: string]: unknown;
}

/** One entry of the planning feed: a reasoning block or a tool summary. */
export type PlannerEntry = ["text" | "tool", string];

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

/** Lexicographic > over equal-length score tuples (Python tuple compare). */
function lexGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// === SECTION === 6. WaveWeb — the model behind the view ===

/**
 * The model behind the wave view: ten agents, a rail, and a drawer.
 *
 * Deliberately free of React state. Every mutation here is driven by a hunt
 * event and every read is a pure render, which is what lets the whole thing be
 * tested by feeding it events and asserting on the text it draws.
 */
export class WaveWeb {
  target: string;
  palette: Palette;
  wave: number;
  size: number;
  agents: AgentCell[] = [];
  findings: WaveFinding[] = [];
  started = mono();
  ended = 0.0;
  /**
   * The planner's reasoning while the roster is being written. Bounded like
   * the recon log — a planner turn can run long and the view only has room
   * for the tail.
   */
  planner: PlannerEntry[] = [];
  /** What the drawer is showing. null means closed. */
  detail: Detail | null = null;
  /** How far the drawer's contents are scrolled, in rows. */
  detailScroll = 0;
  /** (x, y) of the mouse, for the hover highlight. [-1, -1] means no mouse. */
  hover: [number, number] = [-1, -1];
  /** Rail and drawer widths, as the operator has resized them. null means
   *  "whatever fits", which is what the layout falls back to. */
  railW: number | null = null;
  drawerW: number | null = null;
  /**
   * Set when the operator has asked the campaign to stop from the wave view.
   * The wave ends at its next boundary rather than instantly, so without this
   * the key would look like it did nothing — the transcript line it writes is
   * on the screen this one is covering.
   */
  stopping = false;
  /** "x,y" -> (kind, key), rebuilt on every render. See Grid.region. */
  private hits = new Map<string, Hit>();
  /** The previous frame's hit map, used to resolve the hover — see hovered. */
  private prevHits = new Map<string, Hit>();
  /** The layout the last render used, so a click can be interpreted against
   *  the same geometry that was drawn. */
  private lastLayout = new Layout();

  constructor(target: string, palette: Palette, opts?: { wave?: number; size?: number }) {
    this.target = target;
    this.palette = palette;
    this.wave = opts?.wave ?? 1;
    this.size = opts?.size ?? 10;
  }

  // ---- mutation ---------------------------------------------------------
  /** Lay out the roster the planner returned, one pane per worker. */
  setPlan(workers: ReadonlyArray<{ name?: string; brief?: string }>, opts?: { wave?: number }): void {
    if (opts?.wave != null) this.wave = opts.wave;
    this.agents = (workers ?? [])
      .slice(0, this.size)
      .map((w, i) => new AgentCell(String(w?.name ?? `agent-${i + 1}`), String(w?.brief ?? "")));
  }

  agentStart(name: string, brief = ""): void {
    const cell = this.cell(name);
    if (!cell) return;
    cell.status = "running";
    cell.activity = brief || cell.brief || "starting";
    if (brief) cell.brief = brief;
    cell.activityAt = mono();
  }

  /**
   * Record what an agent is doing now — a tool call, usually.
   *
   * The call is recorded in history as it *starts*, so the drawer shows what
   * the agent is doing now rather than only what it has finished, and
   * agentResult fills that same entry in when the output arrives so the step
   * is not listed twice.
   */
  agentActivity(name: string, activity: string): void {
    const cell = this.cell(name);
    if (!cell) return;
    cell.status = "running";
    cell.activity = activity;
    cell.command = activity;
    cell.commandAt = mono();
    // The previous command's output belongs to the previous command. Left up,
    // a pane would show the new command over the old command's results, which
    // reads as though this call returned them.
    cell.output = [];
    cell.activityAt = cell.commandAt;
    cell.history.push([activity, ""]);
    cell.pending = cell.history.length - 1;
    if (cell.history.length > HISTORY_MAX) {
      cell.history = cell.history.slice(-HISTORY_MAX);
      cell.pending = Math.max(-1, cell.pending - 1);
    }
  }

  /**
   * Record what an agent's last command returned.
   *
   * This is the half of a tool call the pane never had: it showed the command
   * and then replaced it with the next one, so an agent's actual findings —
   * the HTTP response, the directory listing, the error — were only legible in
   * the scrolling transcript. Kept bounded, and kept in history as well so the
   * drawer can show the whole run.
   */
  agentResult(name: string, command: string, output: string): void {
    const cell = this.cell(name);
    if (!cell) return;
    const lines = String(output ?? "")
      .split("\n")
      .map((ln) => ln.trimEnd());
    // Leading blank lines are noise from a command that printed a banner
    // first; trailing ones are the shell's final newline.
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    cell.output = lines.slice(0, OUTPUT_MAX);
    if (command) {
      cell.command = command;
      // A result is the end of a command, so it is drawn whole — the typing
      // animation is for the moment a command *starts*.
      cell.commandAt = 0.0;
      const entry: [string, string] = [command, lines.slice(0, OUTPUT_MAX).join("\n")];
      if (cell.pending >= 0 && cell.pending < cell.history.length) {
        // Fill in the step this result belongs to, so a call and its output
        // are one entry in the drawer rather than two.
        cell.history[cell.pending] = entry;
        cell.pending = -1;
      } else {
        cell.history.push(entry);
      }
      if (cell.history.length > HISTORY_MAX) {
        cell.history = cell.history.slice(-HISTORY_MAX);
      }
    }
    cell.activityAt = mono();
  }

  /**
   * Record an agent's own reasoning, shown in its drawer.
   *
   * The pane has no room for prose — it is a command and its output — but an
   * agent's reasoning is the only account of *why* a command was run, and
   * until this existed it was visible only in the transcript.
   */
  agentText(name: string, text: string): void {
    const cell = this.cell(name);
    const t = String(text ?? "").trim();
    if (!cell || !t) return;
    cell.history.push(["", t]);
    if (cell.history.length > HISTORY_MAX) {
      cell.history = cell.history.slice(-HISTORY_MAX);
    }
    cell.activityAt = mono();
  }

  /** Append a block of the planner's reasoning to the planning feed. */
  plannerText(text: string): void {
    const t = String(text ?? "").trim();
    if (t) this.planner.push(["text", t]);
  }

  /**
   * Append a planner tool call to the planning feed.
   *
   * Summarised with its arguments rather than recorded as a bare tool name:
   * "grep" says nothing about what the planner is looking for, and the
   * arguments are the only part of the call that explains where the wave is
   * being aimed. cfg is optional so a caller with no config to hand still gets
   * a usable summary. The try/catch is the Python's: the summary is a nicety,
   * and a malformed call must not blank the feed.
   */
  plannerTool(tool: string, args?: Record<string, unknown> | null, cfg?: unknown): void {
    const name = String(tool ?? "");
    if (!name) return;
    let label = name;
    if (args) {
      try {
        label = summariseCall(name, args, cfg as Config, 200) || name;
      } catch {
        label = name;
      }
    }
    this.planner.push(["tool", label]);
  }

  agentDone(name: string, ok = true): void {
    const cell = this.cell(name);
    if (!cell) return;
    cell.status = ok ? "done" : "failed";
    cell.activity = ok ? "finished" : "failed";
    cell.activityAt = mono();
  }

  /**
   * Tally a finding and light the pane of the agent that reported it.
   *
   * Called for every finding the run accepts — including the ones the
   * post-wave harvest finds, which is why the flash is keyed off the event
   * rather than off the wave boundary.
   */
  addFinding(finding: WaveFinding): void {
    const sev = normaliseSeverity(finding.severity as string | undefined);
    const agent = String(finding.agent || "?");
    this.findings.push({ ...finding, severity: sev });
    const cell = this.cell(agent);
    if (cell) {
      cell.findings += 1;
      cell.last = String(finding.title || "");
      if (!cell.worst || (SEVERITY_ORDER[sev] ?? 9) < (SEVERITY_ORDER[cell.worst] ?? 9)) {
        cell.worst = sev;
      }
      cell.flash = mono();
    }
  }

  end(): void {
    this.ended = mono();
    for (const cell of this.agents) {
      if (cell.status === "running") {
        cell.status = "done";
        cell.activity = "finished";
      }
    }
  }

  private cell(name: string): AgentCell | null {
    for (const cell of this.agents) if (cell.name === name) return cell;
    return null;
  }

    // ---- interaction ------------------------------------------------------
  /** Open the drawer on every finding on one rung. */
  openFindings(severity: string): void {
    const sev = normaliseSeverity(severity);
    this.detail = new Detail("findings", sev);
  }

  /** Open the drawer on one agent's command history. */
  openAgent(name: string): void {
    if (this.cell(name) !== null) this.detail = new Detail("agent", name);
  }

  /** Close the drawer. */
  closeDetail(): void {
    this.detail = null;
    this.detailScroll = 0;
  }

  /**
   * Scroll the drawer's contents by delta rows.
   *
   * The drawer holds a whole agent run, which can be longer than the screen,
   * and there is no scroll widget under it to do this — the drawer is drawn
   * into the same character grid as everything else. Clamped at zero and at
   * the end of the content so a wheel that keeps turning does not scroll the
   * list into blank space.
   */
  scrollDetail(delta: number): void {
    this.detailScroll = clamp(this.detailScroll + delta, 0, this.detailMaxScroll());
  }

  /** How far the drawer's contents can scroll before running out. */
  detailMaxScroll(): number {
    const d = this.detail;
    if (d && d.kind === "agent") {
      const cell = this.cell(d.key);
      if (!cell) return 0;
      // Two rows of header, then each step is its command plus its output.
      let used = 4;
      for (const [cmd, out] of cell.history) {
        used += Math.max(1, cmd ? wrap(cmd, 40).length : 1);
        used += String(out ?? "")
          .split("\n")
          .filter((ln) => ln.trim()).length;
      }
      return Math.max(0, used - 10);
    }
    return 0;
  }

  /**
   * Act on a click at (x, y) and return what was hit.
   *
   * The one place that decides what a click means, so the screen does not have
   * to know which regions exist. render must have run at the same size first —
   * the hit map is a by-product of drawing, and there is no other honest way
   * to know where a pane ended up.
   */
  click(x: number, y: number): Hit | null {
    const found = this.hit(x, y);
    if (!found) {
      // A click on bare canvas closes the drawer, which is the only dismiss
      // gesture available on a screen that must not take focus.
      this.closeDetail();
      return null;
    }
    const [kind, key] = found;
    if (kind === "lane") this.openFindings(key);
    else if (kind === "pane") this.openAgent(key);
    return found;
  }

  /**
   * What the pointer is over, resolved against the last completed frame.
   *
   * See renderPanes for why the previous frame's map is the correct one to
   * ask.
   */
  hovered(): Hit | null {
    if (this.hover[0] < 0) return null;
    return this.prevHits.get(`${this.hover[0]},${this.hover[1]}`) ?? null;
  }

  /**
   * What sits at (x, y) in the last render: (kind, key) or null.
   *
   * The kinds are "lane" (a severity lane in the rail, keyed by severity),
   * "pane" (an agent, keyed by name), "agent" (an agent row in the drawer,
   * keyed by name) and "drawer" (the drawer body, keyed "close").
   */
  hit(x: number, y: number): Hit | null {
    return this.hits.get(`${x},${y}`) ?? null;
  }

  /** Widen or narrow the rail by delta columns, within its bounds.
   *
   *  Grows from the width actually in use, not from the stored preference: an
   *  unset preference is 0, and 0 + delta clamps straight to the minimum, so
   *  the first press of "wider" would snap the rail to its narrowest setting
   *  instead of widening it. */
  resizeRail(delta: number): void {
    const base = this.railW || this.lastLayout.railW || RAIL_W;
    this.railW = clamp(base + delta, RAIL_MIN_W, RAIL_MAX_W);
  }

  /**
   * Widen or narrow the drawer by delta columns, within its bounds.
   *
   * The drawer is only ever open while there is something in it, so a resize
   * that arrives with it closed is remembered rather than applied — the
   * layout gives the drawer no width until a detail is open.
   */
  resizeDrawer(delta: number): void {
    const base = this.drawerW || this.lastLayout.drawerW || DRAWER_W;
    this.drawerW = clamp(base + delta, DRAWER_MIN_W, DRAWER_MAX_W);
  }

  // ---- reads ------------------------------------------------------------
  /** Findings per severity rung, including the rungs with none. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of VALID_SEVERITIES) out[s] = 0;
    for (const f of this.findings) {
      const sev = normaliseSeverity(f.severity as string | undefined);
      out[sev] = (out[sev] ?? 0) + 1;
    }
    return out;
  }

  elapsed(): number {
    const end = this.ended || mono();
    return Math.floor(end - this.started);
  }

  /** The most recently reported findings, newest first. */
  recent(limit = FEED_LINES): WaveFinding[] {
    return [...this.findings.slice(-limit)].reverse();
  }

  /** The worst severity reported so far, or "" if nothing has been. */
  worst(): string {
    if (!this.findings.length) return "";
    let best = "info";
    let bestRank = 9;
    for (const f of this.findings) {
      const s = normaliseSeverity(f.severity as string | undefined);
      const r = SEVERITY_ORDER[s] ?? 9;
      if (r < bestRank) {
        bestRank = r;
        best = s;
      }
    }
    return best;
  }

  /**
   * Every finding on one rung, worst-first within it by arrival.
   *
   * Newest first, because the drawer is opened to read the finding that just
   * landed, and the older ones on the same rung are context.
   */
  onRung(severity: string): WaveFinding[] {
    const sev = normaliseSeverity(severity);
    return [...this.findings]
      .reverse()
      .filter((f) => normaliseSeverity(f.severity as string | undefined) === sev);
  }

  /**
   * The agents whose panes to draw, busiest first.
   *
   * Ten panes of the size that shows a command and its output do not fit on
   * every terminal, so the view shows a window of them. The window is chosen
   * rather than truncated: an agent that has reported something, or is
   * running, is worth more of the screen than one that has not started, and
   * sorting by "most recently active" is what keeps the operator looking at
   * the work in progress.
   *
   * The tail is rotated rather than dropped, so an agent that has been quiet
   * still comes round. Without that a wave where four agents do all the work
   * would never show the other six again, and a stalled agent would be
   * invisible — which is exactly the fault this view exists to expose.
   *
   * The rotation is keyed off the clock, not off a call counter: render runs
   * on a timer several times a second, and a counter would cycle the window so
   * fast the panes flickered.
   *
   * A pane that is open in the drawer is never rotated out — the drawer
   * describes the pane beside it.
   */
  visibleAgents(limit: number): AgentCell[] {
    if (limit <= 0) return [];
    if (this.agents.length <= limit) return [...this.agents];

    const d = this.detail;
    const pinned = this.agents.filter((c) => d !== null && d.kind === "agent" && c.name === d.key);
    const pinnedSet = new Set(pinned);
    const rest = this.agents.filter((c) => !pinnedSet.has(c));
    const active = rest
      .filter((c) => c.status !== "idle" || c.findings)
      .sort((a, b) => b.activityAt - a.activityAt);
    const activeSet = new Set(active);
    const idle = rest.filter((c) => !activeSet.has(c));

    const chosen = [...pinned, ...active.slice(0, Math.max(0, limit - pinned.length))];
    const room = limit - chosen.length;
    if (room > 0 && idle.length) {
      // Rotate through the quiet ones so each gets a turn on screen.
      const start = Math.floor(mono() / ROTATE_SECONDS) % idle.length;
      const spun = [...idle.slice(start), ...idle.slice(0, start)];
      chosen.push(...spun.slice(0, room));
    }
    // Drawn in the original roster order, so a pane does not jump between
    // cells from one repaint to the next.
    const order = new Map(this.agents.map((c, i) => [c.name, i] as const));
    return chosen.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  }

    // ---- layout -----------------------------------------------------------
  /**
   * Where everything goes at width x height.
   *
   * Panes are sized from the space that is left after the rail and the
   * drawer, and the count is derived from the size rather than the other way
   * round. The previous version asked for a fixed six-row pane and then
   * computed how many fit — which returned six at 118x36 while only four
   * could be drawn, so two panes were laid out off the bottom of the canvas
   * and silently dropped, taking their hit regions with them. Nothing is ever
   * laid out off-canvas here: the grid is divided, and the division is what
   * gets drawn.
   */
  layout(width: number, height: number): Layout {
    const lay = new Layout();
    if (width < MIN_WIDTH || height < MIN_HEIGHT) return lay;

    lay.railW = clamp(this.railW ?? RAIL_W, RAIL_MIN_W, RAIL_MAX_W);
    // The drawer only opens when it can pay for itself. It has to leave two
    // columns of panes behind it: at one column the wave stops reading as a
    // wave and the operator is looking at a list beside a panel, which is
    // what the drawer was supposed to save them from. So its width is
    // computed from what is left, not requested and then hoped for — a
    // terminal too narrow to hold both gets no drawer, rather than panes
    // squashed to nothing.
    if (this.detail) {
      const want = clamp(this.drawerW ?? DRAWER_W, DRAWER_MIN_W, DRAWER_MAX_W);
      // Exactly what two minimum-width columns and the margins around them
      // need: the pane width is a floor division, so two columns occupy
      // 2 * PANE_MIN_W + 1 of pane space, and the block is inset by one
      // column from the rail and from the drawer. Reserving one column too
      // few is the difference between a drawer at 118 columns leaving two
      // columns of panes and leaving one.
      const room = width - lay.railW - (2 * PANE_MIN_W + 1) - 2;
      if (room >= DRAWER_MIN_W) lay.drawerW = Math.min(want, room);
    }

    lay.panesX = lay.railW + 1;
    lay.panesW = width - lay.panesX - (lay.drawerW ? lay.drawerW + 1 : 1);
    if (lay.panesW < PANE_MIN_W) return railOnly(lay.railW);

    // Columns. The choice is made to get every agent on screen at a height
    // that can show its output, and only then to make the panes wide: at 118
    // columns a two-column layout gives 40-column panes but only five rows
    // tall, which is one row of output — so the layout takes three columns
    // and 26x7 instead, and all ten agents are readable at once.
    const cols = this.chooseColumns(lay.panesW, height, lay.drawerW ? 2 : 1);
    if (cols < 1) return railOnly(lay.railW);
    lay.cols = cols;
    lay.paneW = Math.min(PANE_MAX_W, Math.floor((lay.panesW - (lay.cols - 1)) / lay.cols));

    // Leftover width is not spent on making panes wider than they are useful
    // — see PANE_MAX_W. It goes into the margins, so the block stays centred
    // under the rail's eye line.
    const block = lay.cols * lay.paneW + (lay.cols - 1);
    lay.inset = Math.max(0, Math.floor((lay.panesW - block) / 2));
    lay.panesX += lay.inset;

    // Rows: enough to hold every agent, and never more rows than there is
    // height for. Both numbers come out of the same division, so a pane
    // cannot be laid out past the bottom of the canvas — see the note above.
    const rowsNeeded = Math.max(1, ceilDiv(this.size || 1, lay.cols));
    lay.boxH = Math.min(BOX_MAX_H, Math.max(BOX_MIN_H, Math.floor((height - 2) / rowsNeeded) - 1));
    lay.rows = Math.max(1, Math.floor((height - 2) / (lay.boxH + 1)));
    // Capacity is what the height can actually hold, not what the division
    // hoped for. The two differ whenever boxH was floored at BOX_MIN_H: three
    // columns needing four rows each is twelve slots on paper, but at 36 rows
    // only three rows of panes fit, so the view has to say nine rather than
    // claim twelve and draw six. It is also capped at the number of agents,
    // because a slot no agent will ever occupy is not a slot the window can
    // show.
    const rowsThatFit = Math.max(1, Math.floor((height - 2 + 1) / (lay.boxH + 1)));
    const slots = lay.cols * Math.min(lay.rows, rowsThatFit);
    lay.capacity = Math.min(slots, Math.max(1, this.size || 1));
    return lay;
  }

  /**
   * How many panes across, given the room and how many agents there are.
   *
   * Scored rather than derived, because "how many fit" and "how many are worth
   * drawing" are different questions. A candidate is only considered if its
   * panes clear PANE_MIN_W, and the ladder is: readable output first, every
   * agent on screen second, room for the output third, and more panes across
   * last. Ranking columns above width would split a four-agent wave into
   * three narrow columns with a column of the terminal going spare; ranking
   * width above readability would give ten agents 40-column panes five rows
   * tall, which is one row of output each.
   *
   * atLeast forces a floor on the count. It is how the drawer asks for its
   * space without flattening the wave into one column: with a drawer open the
   * widest pane that fits is often a single 44-column one, and a single
   * column beside a panel does not read as a wave at all. The floor is applied
   * by discarding candidates below it rather than by scoring them down,
   * because "wide" outranks "many" in the ladder below and one 44-column pane
   * would otherwise always beat two 22-column ones.
   */
  private chooseColumns(panesW: number, height: number, atLeast = 1): number {
    const n = Math.max(1, this.size || 1);
    // The most columns that could ever clear PANE_MIN_W, by the same
    // arithmetic the loop below uses. A simpler panesW / (PANE_MIN_W + 1) is
    // off by one here — it counts the separator between two panes as a whole
    // extra pane — which capped the drawer's two-column request at one column
    // at 118 wide.
    const ceiling = Math.max(1, Math.floor((panesW + 1) / (PANE_MIN_W + 1)));
    const floor = Math.max(1, Math.min(atLeast, ceiling));

    const cands: Array<{ cols: number; paneW: number; boxH: number; fits: boolean; shown: number }> = [];
    for (let cols = 1; cols <= Math.min(n, ceiling); cols++) {
      // Capped the same way layout caps it, so the two cannot disagree about
      // how wide a pane would actually be: scoring the uncapped width here
      // would have this choose one 44-column column while the layout drew two
      // 22-column ones.
      const paneW = Math.min(PANE_MAX_W, Math.floor((panesW - (cols - 1)) / cols));
      if (paneW < PANE_MIN_W) continue;
      const rowsNeeded = Math.max(1, ceilDiv(n, cols));
      const boxH = Math.min(BOX_MAX_H, Math.max(BOX_MIN_H, Math.floor((height - 2) / rowsNeeded) - 1));
      const fits = boxH * rowsNeeded + (rowsNeeded - 1) <= height - 2;
      const shown = Math.min(n, cols * Math.max(1, Math.floor((height - 2) / (boxH + 1))));
      cands.push({ cols, paneW, boxH, fits, shown });
    }
    if (!cands.length) return 0;
    const atFloor = cands.filter((c) => c.cols >= floor);
    const pool = atFloor.length ? atFloor : cands;

    let bestScore: number[] | null = null;
    let bestCols = 0;
    for (const { cols, paneW, boxH, fits, shown } of pool) {
      const score = [
        // Readability of the output, which is what the pane is for.
        fits && boxH >= BOX_GOOD_H ? 1 : 0,
        fits ? 1 : 0,
        // Then the room left over for it, counted only up to the width a
        // pane can actually use: a 60-column pane with a 26-column command
        // in it is a command and a hole.
        fits ? Math.min(paneW, PANE_PREF_W) : 0,
        // Ties go to the layout that shows more agents. Once the panes are
        // as wide as they are useful the extra width is worth nothing, so
        // splitting it into another column is strictly better — and this has
        // to run the other way round from the width term above, or a
        // two-column layout that fits just as well as a three-column one
        // loses for being wider.
        fits ? cols : 0,
        // Nothing fits at a readable height: show as many as possible.
        shown,
      ];
      if (bestScore === null || lexGreater(score, bestScore)) {
        bestScore = score;
        bestCols = cols;
      }
    }
    return bestCols;
  }

  /**
   * The top-left cell of the index-th pane, in the computed layout.
   *
   * Laid out row-major, and the block is centred vertically in whatever rows
   * are available so a short wave does not cling to the top of the screen.
   */
  private gridPos(index: number, lay: Layout, height: number): [number, number] {
    const col = index % lay.cols;
    const row = Math.floor(index / lay.cols);
    const x = lay.panesX + col * (lay.paneW + 1);
    const usedRows = Math.max(1, ceilDiv(Math.min(this.size || 1, lay.capacity), lay.cols));
    const block = usedRows * (lay.boxH + 1) - 1;
    const top = Math.max(1, Math.floor((height - block) / 2));
    const y = top + row * (lay.boxH + 1);
    return [x, y];
  }

    // ---- render -----------------------------------------------------------
  /** Draw the wave. Degrades to a list when there is no room for panes. */
  render(width: number, height: number): ReactNode {
    const lay = this.layout(width, height);
    this.lastLayout = lay;
    if (!lay.web) return this.renderCompact(width, height);
    return this.renderPanes(width, height, lay);
  }

  /**
   * Whether the wave is still being planned — no roster has arrived.
   *
   * The screen is pushed at hunt_wave_start, but the roster only lands with
   * hunt_plan, which is emitted after the planner's turn returns. That turn is
   * a real model call over recon, findings, wave history and a long
   * instruction, so it runs for tens of seconds — and for all of it the view
   * held zero agents and drew "WAVE 1 · 0 agents" under a header claiming a
   * wave. That is not a cosmetic gap: it reads as a wave that started with
   * nobody in it, which is exactly the fault this class was built to make
   * visible.
   */
  get planning(): boolean {
    return !this.agents.length && !this.findings.length;
  }

  // -- the panes ----------------------------------------------------------
  private renderPanes(width: number, height: number, lay: Layout): ReactNode {
    const p = this.palette;
    const g = new Grid(width, height);
    const now = mono();
    // The hit map is a by-product of drawing, so at this instant it is still
    // the *previous* frame's. That is the right map to resolve the hover
    // against: the thing under the pointer is wherever the last frame drew it,
    // and the panes are laid out identically from one frame to the next unless
    // the terminal was resized — in which case the pointer is over something
    // else anyway. Reading the new (empty) map instead meant no hover ever
    // resolved and nothing ever highlighted.
    this.prevHits = this.hits;
    this.hits = g.hits;

    this.drawRail(g, lay, height, p, now);

    if (this.planning) {
      // No roster yet, so there are no panes to draw and the planner's
      // reasoning is the only thing there is to show. It gets the whole width
      // the panes would have had.
      this.drawPlanning(g, lay.panesX, lay.panesW, height, p, now);
    } else {
      const shown = this.visibleAgents(lay.capacity);
      const drawn: AgentCell[] = [];
      for (let i = 0; i < shown.length; i++) {
        const cell = shown[i];
        const [x, y] = this.gridPos(i, lay, height);
        // A pane that would run off the bottom is not drawn at all: a
        // half-drawn box reads as a rendering fault, and its hit region would
        // be a lie about what is clickable. capacity is meant to make this
        // unreachable, so it is a backstop rather than the mechanism — see
        // the note in layout.
        if (y + lay.boxH > height - 1) break;
        this.drawAgent(g, cell, x, y, lay, p, now);
        drawn.push(cell);
      }
      const hidden = this.agents.length - drawn.length;
      if (hidden > 0) this.drawHidden(g, lay, height, hidden, drawn, p);
    }

    if (lay.drawerW) this.drawDrawer(g, lay, height, p, now);
    return g.toReact();
  }

  // -- the tracker rail ---------------------------------------------------
  /**
   * The tracker: liveness, the severity lanes, and the feed.
   *
   * A rail rather than a centre node. The lanes are buttons — their whole row
   * is marked clickable, so the operator goes from "MED 1" to the finding
   * behind it — and the rail is the one region on screen that never rotates,
   * which makes it the right place to put the controls.
   */
  private drawRail(g: Grid, lay: Layout, height: number, p: Palette, now: number): void {
    const x = 1;
    const w = lay.railW;
    const worst = this.worst();
    const border = worst ? severityStyle(p, worst) : p.accent;
    g.region(x, 0, w, height, "rail", "");
    g.box(x, 0, w, height, "ANDY-TRACK", `bold ${border}`, true);

    const secs = this.elapsed();
    let head = `● LIVE  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    if (this.ended) head = `● CLOSED  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    if (this.planning) head = `${spinnerAt(now)} PLANNING  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    g.text(x + 2, 1, clip(head, w - 4), `bold ${p.accent}`);

    const counts = this.counts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    g.text(x + 2, 2, clip(`${total} finding${total !== 1 ? "s" : ""}`, w - 4), p.primary);
    g.hline(x + 2, x + w - 3, 3, "─", p.dim);

    // The lanes. The bar is scaled to the *lane* count, not to the busiest
    // lane: normalising across lanes made a single LOW draw the same length as
    // a single CRIT, which is the one comparison the bar exists to make. A
    // fixed width also means a lane only changes when its own count does.
    const barW = Math.max(0, w - 16);
    const span = Math.max(1, Math.max(...LANES.map((s) => counts[s] ?? 0)));
    const hov = this.hovered();
    const rule = 4 + LANES.length;
    LANES.forEach((sev, i) => {
      const row = 4 + i;
      const n = counts[sev] ?? 0;
      if (n) g.region(x + 2, row, w - 4, 1, "lane", sev);
      const sel = this.detail?.kind === "findings" && this.detail.key === sev;
      const on = (hov?.[0] === "lane" && hov?.[1] === sev) || sel;
      g.text(x + 2, row, SEVERITY_LABEL[sev].padEnd(5), severityStyle(p, sev));
      g.text(x + 8, row, String(n).padStart(2), n ? `bold ${severityStyle(p, sev)}` : p.dim);
      if (n) {
        const filled = Math.max(1, Math.round(barW * (n / span)));
        g.text(x + 11, row, "█".repeat(filled), severityStyle(p, sev));
        g.text(x + 11 + filled, row, sel ? " ◂" : " ▸", `bold ${p.accent}`);
      }
      if (on) {
        // The hover/selection highlight, drawn last so the lane's own content
        // is not written over. A marker in the gutter rather than a background
        // colour: no palette here defines a surface colour to fill with, and
        // the rail is only 26 columns wide, so a rule on a row of its own
        // would either overwrite the lane below or push the lanes down a row.
        g.text(x + 1, row, "▸", `bold ${severityStyle(p, sev)}`);
      }
    });

    g.hline(x + 2, x + w - 3, rule, "─", p.dim);
    // The feed. Newest first: who reported what, then the asset under it. No
    // blank row between entries — at three entries that is two rows of padding
    // spent on nothing, and the severity colour already separates them.
    const feed = this.recent(FEED_LINES);
    let row = rule + 1;
    if (!feed.length) {
      g.text(x + 2, row, "nothing confirmed yet", p.dim);
      row += 1;
    }
    const textW = Math.max(4, w - 6);
    for (const f of feed) {
      // Each entry is two rows, and the footer below is now four — rule,
      // three hints — so the last row an entry may claim is height - 6.
      if (row + 1 > height - 6) break;
      const sev = normaliseSeverity(f.severity as string | undefined);
      g.text(x + 2, row, clip(String(f.agent || "?"), textW), p.dim);
      g.text(x + 2, row + 1, clip(String(f.title ?? ""), textW), `bold ${severityStyle(p, sev)}`);
      row += 2;
    }

    // The controls, pinned to the bottom of the rail so they do not move when
    // the feed grows. Three lines rather than two since the stop key was
    // added: the prompt underneath is covered by this screen, so a key that
    // ends the campaign is only usable if it is written down here.
    const hint = height - 4;
    g.hline(x + 2, x + w - 3, hint - 1, "─", p.dim);
    g.text(x + 2, hint, "click lane ▸ findings", p.dim);
    g.text(x + 2, hint + 1, "click pane ▸ agent run", p.dim);
    if (this.stopping) {
      // Confirmation, because the /stop-hunt line the app writes goes to the
      // transcript this screen is covering. Without it the key looks inert
      // until the wave actually ends.
      g.text(x + 2, hint + 2, clip("stopping — wave ends", w - 4), `bold ${p.amber}`);
    } else {
      g.text(x + 2, hint + 2, "ctrl+x  stop hunt", p.dim);
    }
  }

    /**
   * What fills the screen while the roster is being written.
   *
   * The planner's turn is a real model call over the whole recon, every finding
   * so far and the wave history — tens of seconds during which this view had
   * no roster to draw and showed the operator nothing at all. The planner's
   * own reasoning and its real tool calls fill that gap, because they are the
   * account of *why* the wave is aimed where it is, and they are already being
   * streamed by the time they arrive here.
   */
  private drawPlanning(g: Grid, x: number, w: number, height: number, p: Palette, now: number): void {
    if (w < 20) return;
    g.box(x, 1, w, height - 2, "PLANNING", `bold ${p.accent}`);

    // The header line: a sweep, so a planner that is thinking without emitting
    // anything still reads as alive rather than as a hang.
    const sweepW = Math.max(4, w - 24);
    const pos = Math.floor(((now % 2.0) / 2.0) * sweepW);
    g.text(x + 2, 2, spinnerAt(now), `bold ${p.accent}`);
    g.text(x + 4, 2, `${this.planner.length} block(s)`, p.primary);
    for (let i = 0; i < sweepW; i++) {
      const ch = i === pos ? "━" : "┈";
      g.put(x + 18 + i, 2, ch, i === pos ? `bold ${p.accent}` : p.dim);
    }

    const top = 4;
    const bottom = height - 4;
    if (!this.planner.length) {
      g.text(x + 2, top, "the planner is reading recon and the findings so far…", p.dim);
      g.text(x + 2, top + 2, "its reasoning appears here as it writes it", p.dim);
      g.text(x + 2, top + 3, "— the roster lands when the turn returns", p.dim);
      return;
    }
    this.drawPlanner(g, w, top, bottom, p, x + 2);
  }

  /**
   * Name the agents the window is not showing.
   *
   * A pane that simply is not there reads as a wave that lost a worker;
   * "+4 not shown" reads as a view that is windowing, which is what it is.
   */
  private drawHidden(g: Grid, lay: Layout, height: number, hidden: number, shown: AgentCell[], p: Palette): void {
    const onScreen = new Set(shown.map((c) => c.name));
    const names = this.agents.filter((c) => !onScreen.has(c.name)).map((c) => c.name);
    g.text(
      lay.panesX,
      height - 2,
      clip(`+${hidden} not shown: ${names.join(", ")}`, lay.panesW),
      p.dim,
    );
  }

  // -- one agent ----------------------------------------------------------
  private drawAgent(g: Grid, cell: AgentCell, x: number, y: number, lay: Layout, p: Palette, now: number): void {
    const isLit = cell.lit(now);
    const selected = this.detail?.kind === "agent" && this.detail.key === cell.name;
    const hov = this.hovered();
    const isHovered = hov?.[0] === "pane" && hov?.[1] === cell.name;
    let border: string;
    if (selected) {
      border = `bold ${p.accent}`;
    } else if (isHovered) {
      // Bold, not merely accent: a running pane's border is already accent,
      // so hovering one would otherwise change nothing and the pane would
      // look inert exactly when the pointer says it is live.
      border = `bold ${p.accent}`;
    } else if (isLit && cell.worst) {
      border = `bold ${severityStyle(p, cell.worst)}`;
    } else if (cell.status === "failed") {
      border = p.red;
    } else if (cell.status === "done") {
      border = p.dim;
    } else if (cell.status === "running") {
      border = p.accent;
    } else {
      border = p.dim;
    }

    // Marked before it is drawn, so the whole pane is clickable — not only the
    // glyphs that happen to land on it.
    g.region(x, y, lay.paneW, lay.boxH, "pane", cell.name);

    // The marker rides in the title; the count is right-aligned in the same
    // border. A running agent spins, so a pane whose command and output have
    // not changed for a while is still visibly working.
    let mark: string;
    if (selected) mark = "▶";
    else if (cell.findings) mark = "◆";
    else if (cell.status === "running") mark = spinnerAt(now);
    else mark = "·";
    let title = `${mark} ${cell.name}`;
    if (cell.history.length > 1) title = `${title} ·${cell.history.length}`;
    g.box(x, y, lay.paneW, lay.boxH, title, border);
    if (cell.findings) {
      g.text(x + lay.paneW - 4, y, `×${cell.findings}`, `bold ${severityStyle(p, cell.worst || "info")}`);
    }

    const inner = Math.max(0, lay.paneW - 4);
    // Row 1: the command, in the agent's own colour, typed in as it starts.
    const cmdStyle =
      isLit && cell.worst
        ? severityStyle(p, cell.worst)
        : cell.status === "running"
          ? `bold ${p.primary}`
          : p.primary;
    const command = cell.revealed(now) || cell.activity;
    g.text(x + 2, y + 1, clip(command, inner), cmdStyle);

    // The middle rows: what the command returned, dim — reference rather than
    // news. The last row carries a `>N` when there is more output than fits,
    // so a clipped listing does not read as a short one.
    const tail = y + lay.boxH - 2;
    const avail = Math.max(0, tail - (y + 2));
    const rows = cell.output.slice(0, avail);
    const more = cell.output.length - rows.length;
    for (let i = 0; i < avail; i++) {
      const row = y + 2 + i;
      if (i < rows.length) {
        let text = rows[i];
        if (i === rows.length - 1 && more > 0) text = `${text} >${more}`;
        g.text(x + 2, row, clip(text, inner), p.dim);
      } else if (i === 0 && !rows.length && cell.status === "running") {
        g.text(x + 2, row, "…", p.dim);
      }
    }

    // The tail: what this agent has to show for itself. A finding leads —
    // that is the news — and the command count follows, so the pane says both
    // what was found and how much was run to find it.
    if (isLit && cell.last) {
      g.text(x + 2, tail, `◆ ${clip(cell.last, inner - 2)}`, `bold ${severityStyle(p, cell.worst || "info")}`);
    } else if (cell.findings) {
      g.text(
        x + 2,
        tail,
        `${cell.findings} finding${cell.findings !== 1 ? "s" : ""}`,
        `bold ${severityStyle(p, cell.worst || "info")}`,
      );
    } else if (cell.status === "failed") {
      g.text(x + 2, tail, "failed", p.red);
    } else if (cell.history.length > 1) {
      g.text(x + 2, tail, `+${cell.history.length - 1} earlier step(s)`, p.dim);
    } else if (cell.status === "done") {
      g.text(x + 2, tail, "finished", p.dim);
    }

    // The pulse: a finding travelling from the pane that reported it to the
    // rail that tallied it. The one animation here that points at where the
    // news came from.
    if (cell.pulse(now)) {
      const age = (now - cell.flash) / PULSE_SECONDS;
      const col = x + Math.floor(lay.paneW * (1 - age));
      g.put(Math.max(0, Math.min(g.width - 1, col)), y, "◆", `bold ${severityStyle(p, cell.worst || "info")}`);
    }
  }

    // -- the drawer ---------------------------------------------------------
  /**
   * The detail behind a lane or a pane, on the right.
   *
   * Opened by a click, closed by a click on bare canvas or escape. It takes
   * width rather than covering anything: the panes are laid out around it, so
   * reading a finding never hides the agent that is still working.
   */
  private drawDrawer(g: Grid, lay: Layout, height: number, p: Palette, _now: number): void {
    const x = g.width - lay.drawerW - 1;
    const w = lay.drawerW;
    const d = this.detail;
    let rows: WaveFinding[] = [];
    let title: string;
    if (d && d.kind === "findings") {
      title = `${SEVERITY_LABEL[d.key] ?? d.key} findings`;
      rows = this.onRung(d.key);
    } else {
      title = `agent ${d?.key ?? ""}`;
    }
    g.region(x, 0, w, height, "drawer", "close");
    g.box(x, 0, w, height, title, `bold ${p.accent}`, true);
    // The dismiss affordance, inside the top border rather than over it — a
    // click anywhere in the drawer also closes it, so this is a label rather
    // than the only way out.
    if (w >= 12) g.text(x + w - 5, 0, " × ", `bold ${p.dim}`);

    if (d && d.kind === "findings") {
      this.drawFindings(g, x, w, height, rows, p);
    } else {
      this.drawAgentRun(g, x, w, height, p);
    }
  }

  /**
   * One severity rung, every finding on it, with the evidence.
   *
   * This is the answer to "MED 1 — but *what*": the title, the asset it was
   * found on, the agent and wave, and the evidence that makes it a finding
   * rather than an opinion.
   */
  private drawFindings(g: Grid, x: number, w: number, height: number, rows: WaveFinding[], p: Palette): void {
    if (!rows.length) {
      g.text(x + 2, 2, "nothing on this rung", p.dim);
      return;
    }
    let y = 2;
    // The body is indented one column past the list number, not five: the
    // drawer is narrow by design (it exists to leave the panes their width),
    // so every column it spends on indentation is a column off the asset URL
    // — and a URL broken across three lines is not readable as a URL.
    const textW = Math.max(4, w - 5);
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i];
      if (y > height - 4) {
        g.text(x + 2, height - 3, `+${rows.length - i} more`, p.dim);
        break;
      }
      const sev = normaliseSeverity(f.severity as string | undefined);
      g.text(x + 2, y, `${String(i + 1).padStart(2)} `, p.dim);
      for (const ln of wrap(String(f.title || "(untitled)"), textW).slice(0, 2)) {
        g.text(x + 5, y, ln, `bold ${severityStyle(p, sev)}`);
        y += 1;
      }
      const asset = String(f.asset || "").trim();
      if (asset) {
        for (const ln of wrapAsset(asset, textW).slice(0, 2)) {
          g.text(x + 5, y, ln, p.primary);
          y += 1;
        }
      }
      const who = `agent ${f.agent ?? "?"} · wave ${f.wave ?? "?"}`;
      g.text(x + 5, y, clip(who, textW), p.dim);
      y += 1;
      const fields: Array<[string, string | undefined]> = [
        ["why", f.summary],
        ["proof", f.evidence],
        ["fix", f.remediation],
      ];
      for (const [label, valueRaw] of fields) {
        const value = String(valueRaw ?? "").trim();
        if (!value) continue;
        const lines = wrap(value, textW - 7).slice(0, 4);
        for (let j = 0; j < lines.length; j++) {
          if (y > height - 4) break;
          g.text(x + 5, y, j === 0 ? `${label.padEnd(5)} ` : " ".repeat(6), p.dim);
          g.text(x + 11, y, lines[j], label !== "proof" ? p.dim : p.primary);
          y += 1;
        }
      }
      y += 1;
    }
  }

  /**
   * One agent's whole run: every command it ran, and what came back.
   *
   * The pane shows the agent's last command and a few lines of its output.
   * This is the rest of it — the commands that led there, and the responses
   * the pane had no room for. It is the view that answers "what has this
   * agent actually been doing", which the scrolling transcript answers only by
   * being read backwards.
   */
  private drawAgentRun(g: Grid, x: number, w: number, height: number, p: Palette): void {
    const cell = this.cell(this.detail?.key ?? "");
    if (!cell) {
      g.text(x + 2, 2, "no such agent", p.dim);
      return;
    }
    const textW = Math.max(4, w - 4);
    let y = 2;
    const head = `${cell.status} · ${cell.findings} finding(s) · ${cell.history.length} step(s)`;
    g.text(x + 2, y, clip(head, textW), p.primary);
    y += 1;
    if (cell.brief) {
      for (const ln of wrap(cell.brief, textW - 2).slice(0, 3)) {
        g.text(x + 2, y, ln, p.dim);
        y += 1;
      }
    }
    g.hline(x + 2, x + w - 3, y, "─", p.dim);
    y += 1;
    if (!cell.history.length) {
      g.text(x + 2, y, "nothing run yet", p.dim);
      return;
    }

    // Oldest first: a run reads as a sequence, and the newest step is already
    // on the pane the operator clicked. detailScroll skips whole steps from
    // the top rather than lines, so a scrolled view never starts in the
    // middle of a command.
    const steps = cell.history.slice(this.detailScroll);
    if (this.detailScroll) {
      g.text(x + 2, y, `↑ ${this.detailScroll} step(s) above`, p.dim);
      y += 1;
    }
    for (const [cmd, out] of steps) {
      if (y > height - 3) {
        g.text(x + 2, height - 2, "↓ more below — scroll", p.dim);
        break;
      }
      if (cmd) {
        for (const ln of wrap(cmd, textW - 2).slice(0, 3)) {
          g.text(x + 2, y, ln, `bold ${p.primary}`);
          y += 1;
        }
      } else {
        g.text(x + 2, y, "(reasoning)", p.dim);
        y += 1;
      }
      const body = String(out ?? "")
        .split("\n")
        .filter((ln) => ln.trim());
      for (const ln of body.slice(0, 8)) {
        if (y > height - 3) break;
        g.text(x + 4, y, clip(ln, textW - 4), p.dim);
        y += 1;
      }
      if (body.length > 8) {
        g.text(x + 4, y, `… +${body.length - 8} line(s)`, p.dim);
        y += 1;
      }
      y += 1;
    }
  }

  // -- the planning feed --------------------------------------------------
  /**
   * The planner's reasoning, wrapped into rows top..bottom.
   *
   * Wrapped rather than clipped: the planner's prose is the only account of
   * *why* the wave is aimed where it is, and a line cut at the pane edge is
   * not an account of anything. Newest first, so the live edge is at the top
   * where the eye already is.
   *
   * x0 shifts the whole block right, so the same renderer serves the
   * full-width compact view and the panes region.
   */
  private drawPlanner(g: Grid, width: number, top: number, bottom: number, p: Palette, x0 = 0): void {
    const labelW = 9;
    const textW = Math.max(10, width - labelW - 1);
    let row = top;
    for (const [kind, text] of [...this.planner].reverse()) {
      if (row >= bottom) break;
      let style: string;
      let lines: string[];
      if (kind === "tool") {
        style = p.accent;
        lines = [`$ ${text}`];
      } else {
        style = p.primary;
        lines = wrap(text, textW);
      }
      for (let i = 0; i < lines.length; i++) {
        if (row >= bottom) break;
        g.region(x0, row, width, 1, "planner", "");
        if (i === 0) g.text(x0, row, " planner ", `bold ${p.accent}`);
        else g.text(x0, row, " ".repeat(labelW), p.dim);
        g.text(x0 + labelW, row, clip(lines[i], textW), style);
        row += 1;
      }
      // A blank row between blocks, so two turns do not run together.
      row += 1;
    }
  }

    // -- the fallback -------------------------------------------------------
  /**
   * The panes at a size that cannot hold them: a list, in the same order.
   *
   * A terminal too small for the geometry still gets every fact — which agents
   * are running, the command each is on, what it returned, and the tally —
   * laid out as lines instead of panes. Drawing the panes anyway would overlap
   * the boxes and produce something unreadable, which is worse than not
   * drawing them.
   *
   * While the planner is running there is no roster, so this shows the
   * planning feed instead — the same reasoning the full view shows, at
   * whatever width there is.
   */
  private renderCompact(width: number, height: number): ReactNode {
    const p = this.palette;
    const g = new Grid(width, height);
    this.hits = g.hits;
    let row = 0;

    const line = (s: string, style = ""): void => {
      if (row < height) {
        g.text(0, row, clip(s, width), style);
        row += 1;
      }
    };

    const counts = this.counts();
    const secs = this.elapsed();
    const ruleW = Math.max(0, Math.min(width, 60) - 2);
    if (this.planning) {
      // No roster yet. Say so, rather than counting zero agents under a
      // header that announces a wave — see `planning`.
      line(` WAVE ${this.wave} · planning · ${this.target}`, `bold ${p.accent}`);
    } else {
      line(` WAVE ${this.wave} · ${this.agents.length} agents · ${this.target}`, `bold ${p.accent}`);
    }
    line(
      ` ANDY-TRACK  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}  ${Object.values(counts).reduce((a, b) => a + b, 0)} finding(s)`,
      p.primary,
    );
    line(" " + "─".repeat(ruleW), p.dim);

    if (this.planning && this.planner.length) {
      // The planner is thinking and there is no roster to list. Show what it
      // is thinking, which is the whole point of this branch. It fills the
      // gap between the header rule and the lanes at the bottom.
      const bottom = height - LANES.length - 1;
      this.drawPlanner(g, width, row, Math.max(row, bottom), p);
      row = Math.max(row, bottom);
    } else if (this.planning) {
      line(" · planning the wave — the roster lands when the planner returns", p.dim);
    } else {
      // The roster shares the height with the header, the tally and the feed,
      // so a short terminal cannot list every agent. Whoever is cut is shown
      // as a count rather than dropped: a list that stops at agent-9 under a
      // header reading "10 agents" reads as a wave that lost a worker.
      //
      // The count row is reserved *before* the roster is chosen, not after it
      // is drawn, and only when something is actually hidden. Trimming
      // afterwards and then counting against the untrimmed list
      // under-reported by one: at 40x12 it listed five agents and said "+5
      // more". Reserving unconditionally over-corrects the other way,
      // spending a row on a count of zero.
      const tail = height - LANES.length - 2;
      let roster = this.visibleAgents(Math.max(0, tail));
      let hidden = this.agents.length - roster.length;
      if (hidden > 0 && tail >= 1) {
        roster = roster.slice(0, Math.max(0, tail - 1));
        hidden = this.agents.length - roster.length;
      }
      const listed: AgentCell[] = [];
      for (const cell of roster) {
        const mark = cell.findings ? "◆" : cell.status === "running" ? spinnerAt() : "·";
        const style = cell.findings
          ? severityStyle(p, cell.worst)
          : cell.status === "running"
            ? p.primary
            : p.dim;
        const body = cell.command || cell.activity;
        line(` ${mark} ${cell.name.padEnd(12)} ${clip(body, Math.max(0, width - 17))}`, style);
        listed.push(cell);
        // One line of output under the command, so the compact view carries
        // the same information as a pane rather than less.
        if (cell.output.length && row < height - LANES.length - 2) {
          line(`     ${clip(cell.output[0], Math.max(0, width - 7))}`, p.dim);
        }
      }
      hidden = this.agents.length - listed.length;
      if (hidden > 0) line(` · +${hidden} more`, p.dim);
      if (!listed.length) line(" · no agents", p.dim);
    }

    line(" " + "─".repeat(ruleW), p.dim);
    const lanes = LANES.map((s) => `${SEVERITY_LABEL[s]} ${counts[s] ?? 0}`).join("  ");
    line(" " + lanes, p.primary);
    for (const f of this.recent(2)) {
      const sev = normaliseSeverity(f.severity as string | undefined);
      line(
        ` · ${f.agent ?? "?"} ─▶ [${SEVERITY_LABEL[sev] ?? sev}] ${f.title ?? ""}`,
        severityStyle(p, sev),
      );
    }
    return g.toReact();
  }
}

/**
 * The layout the too-narrow branches return: a rail width and nothing else,
 * so a resize still has the in-use width to grow from.
 */
function railOnly(railW: number): Layout {
  const lay = new Layout();
  lay.railW = railW;
  return lay;
}
