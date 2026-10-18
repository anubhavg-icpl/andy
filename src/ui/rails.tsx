/**
 * rails.tsx — Mission Control rails: the loop state machine and the telemetry
 * column (port of zimzilla/ui/rails.py).
 *
 * What this module is: the two instrument columns either side of the
 * transcript. LoopRail renders the agent cycle as a lit state machine;
 * TelemetryRail composes Waveform/ContextGauge/CallStrip/FileRiver. Both are
 * plain FCs over Ink <Text> — no rendering machinery of their own.
 *
 * Invariants:
 *  - Deliberately *not* rain-aware: Ink paints layers top-down with no
 *    compositing, so a rail that tried to blend rain with its numbers would
 *    hurt legibility for nothing. The rails stay crisp.
 *  - Sub-widgets (Waveform, ContextGauge, FileRiver, CallStrip) are pure
 *    functions of their props; LoopRail and TelemetryRail hold the mutable
 *    state, exposed via imperative handles that mirror the Python methods
 *    (the app renders `<LoopRail palette ref/>` and drives it per event).
 *  - The loop rail is comprehension, not information: it tells the operator
 *    nothing they could not read off the transcript; its job is to make the
 *    agent's cycle legible at a glance.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { Palette } from '../theme.js';

// The cycle, in order. `idle` is the resting state between turns.
//
// `hacking` is the one stage that is not part of a turn. A `/bug-hunt`
// campaign is not a turn — it is a run of its own that outlives any single
// one, and it drives its workers itself rather than streaming them through
// the main agent. Without a stage of its own the rail had nothing to show for
// it and sat on IDLE for the whole engagement, which reads as "nothing is
// happening" while ten agents are in fact attacking the target. While it is
// lit, the per-call nodes below are dark — and that is the honest reading:
// the main agent's cycle is genuinely not the thing running.
export const STAGES = ['thinking', 'calling', 'observing', 'hacking', 'idle'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  thinking: 'THINK',
  calling: 'CALL',
  observing: 'OBSERVE',
  hacking: 'HACK',
  idle: 'IDLE',
};

// Block glyphs, low to high. Index = intensity.
const SPARK = ' ▁▂▃▄▅▆▇█';
// Fill glyphs for the context gauge.
const FULL = '▓';
const EMPTY = '░';

// === SECTION === rail resize (RailResizeMixin → useRailResize) ===
//
// The Python mixin dragged the rail's inner border with the mouse to resize
// it. Ink has no mouse events (PORT-MAP §3 descope), so the drag plumbing is
// gone; what survives is the width state and the clamped setter, so the rail
// width is still adjustable programmatically (and by the layout on narrow
// terminals).

export interface UseRailResize {
  railWidth: number;
  /** Clamp into [min, max] and store — the `_apply_rail_width` half of the mixin. */
  applyRailWidth(width: number): void;
}

export function useRailResize(minWidth: number, maxWidth: number, defaultWidth: number): UseRailResize {
  const [railWidth, setRailWidth] = useState(defaultWidth);
  const applyRailWidth = useCallback(
    (width: number) => {
      setRailWidth(Math.max(minWidth, Math.min(maxWidth, Math.trunc(width))));
    },
    [minWidth, maxWidth],
  );
  return { railWidth, applyRailWidth };
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// === SECTION === LoopRail ===

/** Live campaign progress shown in place of turn/iter while a hunt runs. */
export interface HuntProgress {
  wave: number;
  agents: number;
  done: number;
}

/** A turn that stopped at a round cap rather than finishing. */
export interface CapInfo {
  rounds: number;
  limit: number;
  hard: boolean;
}

/** Everything the rail paints, as one snapshot — the state the Python widget
 * held as reactive attributes. Split out so the layout can be asserted
 * without a running Ink app, which is the WHY behind Python's `rail_text`
 * being separate from `render_rail`. */
export interface LoopRailState {
  stage: string;
  turn: number;
  iteration: number;
  /** Makes the active node breathe; toggled by tickPulse. */
  pulse: boolean;
  /** Live campaign progress; null when no hunt is up (turn/iter fallback). */
  hunt: HuntProgress | null;
  /** Set when the turn stopped at a round cap; survives `setStage("idle")`. */
  cap: CapInfo | null;
  /** Last few stages, newest last — a short breadcrumb of the cycle. */
  trail: readonly string[];
}

/** The imperative surface the app drives the rail through (Python methods). */
export interface LoopRailHandle {
  setStage(stage: string): void;
  /** Record that the turn stopped at a round cap, and repaint.
   *
   * Deliberately *not* cleared by `setStage("idle")`: the whole point is to
   * outlive the idle transition, so the rail still says the turn was cut
   * short after it has gone quiet. Cleared at the start of the next turn. */
  setCapped(rounds: number, limit: number, hard?: boolean): void;
  /** Forget a previous turn's cap — called when a new turn starts. */
  clearCap(): void;
  setCounters(turn: number, iteration: number): void;
  /** Show live campaign progress, or clear it by passing `wave = null`.
   *
   * A hunt has no turn and no iteration to report — those belong to the main
   * agent, which is not the thing running. What the operator wants from the
   * rail mid-campaign is how far in it is and how many agents are working. */
  setHunt(wave: number | null, agents?: number, done?: number): void;
  /** Called on a timer; makes the active node breathe. */
  tickPulse(): void;
  applyPalette(palette: Palette): void;
  /** Drop the stage breadcrumb (extra beyond the app contract). */
  clearTrail(): void;
}

/** Trail length — Python's `deque(maxlen=6)`. */
const TRAIL_MAX = 6;

function glyphFor(stage: string): string {
  const map: Record<string, string> = {
    thinking: '▪', calling: '▸', observing: '▪', hacking: '◈', idle: '·',
  };
  return map[stage] ?? '·';
}

// Ink layout rules this module relies on (verified against ink 8):
//  - Sibling <Text> children of a column <Box> each render ONE row; no
//    newline characters between them (a trailing "\n" adds a blank row, and
//    a <Text>{"\n"}</Text> separator adds two).
//  - Nested <Text> runs inside one outer <Text> stay on that line.
//  - A blank line is a single-space row; an empty string collapses entirely.
function Blank(): ReactNode {
  return <Text>{' '}</Text>;
}

/** Build the rail's content from one state snapshot, without any widget
 * machinery — the port of Python's `rail_text` (split out of render_rail so
 * the layout can be asserted without a running app). */
export function loopRailNode(palette: Palette, state: LoopRailState, width = 14): ReactNode {
  const p = palette;
  const nodes: ReactNode[] = [];

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i]!;
    const active = stage === state.stage;
    const last = i === STAGES.length - 1;
    // A capped turn is sitting at `idle` but is NOT finished, so the idle
    // node must not read as the resting state. Rendered amber with its own
    // label rather than the dim IDLE, because the two are otherwise
    // indistinguishable — the failure this exists to fix.
    const cappedIdle = stage === 'idle' && state.cap !== null;
    let mark: string;
    let color: string;
    let bold: boolean;
    if (cappedIdle) {
      mark = '◼';
      color = p.amber;
      bold = true;
    } else if (active) {
      // The lit node alternates between two marks so it reads as alive
      // without needing a colour the palette does not carry.
      mark = state.pulse ? '◉' : '◎';
      color = p.accent;
      bold = true;
    } else {
      mark = '○';
      color = p.dim;
      bold = false;
    }
    nodes.push(
      <Text key={`stage-${stage}`} bold={bold} color={color}>
        {` ${mark} ${cappedIdle ? 'CAPPED' : STAGE_LABEL[stage]}`}
      </Text>,
    );
    if (!last) {
      // Connector: bright only up to the active node.
      const below = STAGES[i + 1] === state.stage;
      nodes.push(
        <Text key={`conn-${stage}`} color={below ? p.accent : p.dim}>{'  │'}</Text>,
      );
    }
  }

  let counters: ReactNode;
  if (state.hunt === null) {
    // Each row is one outer <Text> so its label and value runs share a line.
    counters = state.cap !== null ? (
      // The round count replaces the iteration readout: after a cap the
      // iteration number is the same thing, and what matters is that it hit
      // a limit. `/continue` is named because that is the command that picks
      // the work back up.
      <>
        <Text>
          <Text color={p.dim}>turn </Text>
          <Text color={p.primary}>{state.turn}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>rounds </Text>
          <Text bold color={p.amber}>{state.cap.rounds}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>cap </Text>
          <Text bold color={p.amber}>{state.cap.limit}</Text>
        </Text>
      </>
    ) : (
      <>
        <Text>
          <Text color={p.dim}>turn </Text>
          <Text color={p.primary}>{state.turn}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>iter </Text>
          <Text color={p.primary}>{state.iteration}</Text>
        </Text>
      </>
    );
  } else {
    // A campaign has no turn or iteration to report, so showing the main
    // agent's would be a lie about what is running. Wave and agent count are
    // what is actually moving.
    const wave = state.hunt.wave || 0;
    const agents = state.hunt.agents || 0;
    const done = state.hunt.done || 0;
    counters = (
      <>
        <Text>
          <Text color={p.dim}>wave </Text>
          <Text bold color={p.accent}>{wave}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>agent </Text>
          <Text color={p.primary}>{agents ? `${done}/${agents}` : '-'}</Text>
        </Text>
      </>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderRight
      borderColor={p.dim}
      paddingX={1}
    >
      <Text bold color={p.accent}>LOOP</Text>
      <Blank />
      {nodes}
      <Blank />
      {counters}
      {state.trail.length > 0 ? (
        <>
          <Blank />
          <Text color={p.dim}>│{state.trail.map((s) => glyphFor(s)).join('')}</Text>
        </>
      ) : null}
    </Box>
  );
}

export interface LoopRailProps {
  palette: Palette;
  width?: number;
}

/** The agent's cycle as a four-node state machine, with the active node lit.
 *
 * Holds the cycle state itself (the Python widget did too) and exposes the
 * Python method surface through an imperative handle — the app lane renders
 * `<LoopRail palette={p} ref={railRef}/>` and drives it per agent event.
 */
export const LoopRail = forwardRef<LoopRailHandle, LoopRailProps>(function LoopRail(props, ref) {
  const [palette, setPalette] = useState(props.palette);
  const [state, setState] = useState<LoopRailState>({
    stage: 'idle',
    turn: 0,
    iteration: 0,
    pulse: false,
    hunt: null,
    cap: null,
    trail: [],
  });

  // No deps array: the handle is recreated each render AND every method
  // writes through a functional setState, so a handle captured earlier in a
  // turn still lands on current state rather than a stale snapshot.
  useImperativeHandle(ref, () => ({
    setStage(next: string) {
      if (!(STAGES as readonly string[]).includes(next)) return;
      setState((prev) => {
        // Python appended to the trail only on a *change* — holding the two
        // in one object keeps that transition atomic.
        if (next === prev.stage) return prev;
        const trail = [...prev.trail, next];
        if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
        return { ...prev, stage: next, trail };
      });
    },
    setCapped(rounds: number, limit: number, hard = false) {
      setState((prev) => ({ ...prev, cap: { rounds, limit, hard } }));
    },
    clearCap() {
      setState((prev) => (prev.cap === null ? prev : { ...prev, cap: null }));
    },
    setCounters(turn: number, iteration: number) {
      setState((prev) => ({ ...prev, turn, iteration }));
    },
    setHunt(wave: number | null, agents = 0, done = 0) {
      setState((prev) => ({
        ...prev,
        hunt: wave === null ? null : { wave, agents, done },
      }));
    },
    tickPulse() {
      setState((prev) => ({ ...prev, pulse: !prev.pulse }));
    },
    applyPalette(next: Palette) {
      setPalette(next);
    },
    clearTrail() {
      setState((prev) => ({ ...prev, trail: [] }));
    },
  }));

  return loopRailNode(palette, state, props.width ?? 14);
});

// === SECTION === Waveform ===

export interface WaveformProps {
  palette: Palette;
  /** Sample window width in cells; the caller keeps `samples.length <= width`. */
  width: number;
  samples: readonly number[];
  /** The newest sample, kept so the caption can name the live rate. */
  latest: number;
}

/** Throughput as a scrolling signal — dense while streaming, flat when idle. */
export function Waveform(props: WaveformProps): ReactNode {
  const p = props.palette;
  // Defensive tail-slice: the caller owns the window, but a resize race
  // (width grew, next sample not yet pushed) must never draw past the column.
  const samples = props.samples.length > props.width
    ? props.samples.slice(-props.width)
    : props.samples;
  const peak = samples.length > 0 ? Math.max(...samples) || 1.0 : 1.0;
  const glyphs: ReactNode[] = [];
  for (const v of samples) {
    const level = Math.round((v / peak) * (SPARK.length - 1));
    glyphs.push(
      <Text key={glyphs.length} color={level > 2 ? p.accent : p.dim}>{SPARK[level]!}</Text>,
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        {glyphs}
        {'\n'}
        {/* Name the signal: an unlabelled graph reads as decoration. The
            number is the newest sample, which is the same thing the
            rightmost glyph shows, said in digits. */}
        <Text color={p.dim}>tok/s </Text>
        <Text bold={props.latest !== 0} color={props.latest !== 0 ? p.accent : p.dim}>
          {props.latest.toFixed(1).padStart(5)}
        </Text>
        <Text color={p.dim}>  peak </Text>
        <Text color={p.primary}>{peak.toFixed(1).padStart(5)}</Text>
      </Text>
    </Box>
  );
}

// === SECTION === ContextGauge ===

export interface ContextGaugeProps {
  palette: Palette;
  total: number;
  used: number;
  width: number;
}

/** How full the model's context window is. */
export function ContextGauge(props: ContextGaugeProps): ReactNode {
  const p = props.palette;
  const total = Math.max(1, props.total);
  const used = Math.max(0, props.used);
  const ratio = Math.min(1.0, used / total);
  const filled = Math.round(ratio * props.width);
  // Amber past 70%, red past 90% — the same escalation the modes use.
  let barColor: string;
  let barBold = false;
  if (ratio >= 0.9) {
    barColor = p.red;
    barBold = true;
  } else if (ratio >= 0.7) {
    barColor = p.amber;
    barBold = true;
  } else {
    barColor = p.accent;
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={p.dim}>context{'\n'}</Text>
        <Text bold={barBold} color={barColor}>{FULL.repeat(filled)}</Text>
        <Text color={p.dim}>{EMPTY.repeat(Math.max(0, props.width - filled))}</Text>
        <Text bold={barBold} color={barColor}>{` ${Math.floor(ratio * 100)}%`}</Text>
        {'\n'}
        <Text color={p.dim}>{`${fmtK(used)} / ${fmtK(total)}`}</Text>
      </Text>
    </Box>
  );
}

// === SECTION === FileRiver ===

function shortPath(path: string, limit = 18): string {
  /** A path short enough for the rail: basename, prefixed if ambiguous. */
  const name = path.replace(/\/+$/, '').split('/').pop() ?? '';
  if (name.length > limit) return `${name.slice(0, limit - 1)}…`;
  return name;
}

export interface FileRiverProps {
  palette: Palette;
  /** path -> touch count, in first-seen order (a Map's insertion order). */
  touched: readonly (readonly [string, number])[];
}

/** Files touched this session, with a bar per file showing how often. */
export function FileRiver(props: FileRiverProps): ReactNode {
  const p = props.palette;
  const MAX_ROWS = 10;
  if (props.touched.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={p.accent}>FILES</Text>
        <Text color={p.dim}>(none yet)</Text>
      </Box>
    );
  }
  // Newest first, capped — the rail is a live view, not a full audit.
  const items = props.touched.slice(-MAX_ROWS);
  const width = Math.max(...items.map(([path]) => shortPath(path).length));
  const rows: ReactNode[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const [path, count] = items[i]!;
    // Bars are absolute (one per touch, capped at 4), not normalised to the
    // busiest file: a lone touch is one bar, not a full gauge. A relative
    // scale would draw a single edit as if the file were hot.
    const bars = Math.min(count, 4);
    rows.push(
      <Text key={path}>
        <Text color={count > 1 ? p.accent : p.dim}>
          {'▎'.repeat(bars) + ' '.repeat(4 - bars + 1)}
        </Text>
        <Text color={p.primary}>{shortPath(path).padEnd(width) + ' '}</Text>
        {count > 1 ? <Text color={p.dim}>{`×${count}`}</Text> : null}
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={p.accent}>FILES</Text>
      {rows}
    </Box>
  );
}

// === SECTION === CallStrip ===

export type CallOutcome = 'run' | 'ok' | 'fail';
export type CallEntry = readonly [string, CallOutcome];

export interface CallStripProps {
  palette: Palette;
  /** (name, outcome) newest last. */
  calls: readonly CallEntry[];
}

/** The last few tool calls, newest first, with their outcome.
 *
 * The file river only knows about paths, so a session spent in bash would
 * leave the rail blank. This is the condensed call log the old ActivityPane
 * carried — the full output still lives in the transcript, where it belongs.
 */
export function CallStrip(props: CallStripProps): ReactNode {
  const p = props.palette;
  // glyph + palette colour per outcome
  const MARK: Record<CallOutcome, readonly [string, string]> = {
    run: ['⟳', p.accent],
    ok: ['✔', p.accent],
    fail: ['✖', p.red],
  };
  if (props.calls.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={p.accent}>RECENT</Text>
        <Text color={p.dim}>(none yet)</Text>
      </Box>
    );
  }
  const rows: ReactNode[] = [];
  for (let i = props.calls.length - 1; i >= 0; i--) {
    const [name, outcome] = props.calls[i]!;
    const mark = MARK[outcome] ?? ['·', p.dim];
    rows.push(
      <Text key={`${i}:${name}`}>
        <Text bold color={mark[1]!}>{` ${mark[0]!} `}</Text>
        <Text color={outcome !== 'fail' ? p.primary : p.red}>{name}</Text>
      </Text>,
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={p.accent}>RECENT</Text>
      {rows}
    </Box>
  );
}

// === SECTION === TelemetryRail ===

export interface TelemetryRailHandle {
  /** Push one throughput sample onto the waveform. */
  pushWave(sample: number): void;
  /** Set the gauge's reading, and the window it is a share of.
   *
   * `total` is passed when the active model's real window is known (the live
   * catalog's figure, resolved in agent.contextWindow) so the percentage is a
   * share of *that* model's window rather than of the configured fallback.
   * Omitted, the gauge keeps the total it was built with — which is what the
   * boot paths want, since they have no model reading to offer.
   */
  setContext(used: number, total?: number): void;
  setCost(cost: number, tokIn: number, tokOut: number): void;
  touchFile(path: string): void;
  clearFiles(): void;
  noteCall(name: string): void;
  /** The newest still-running call for `name` finished. */
  noteResult(name: string, ok: boolean): void;
  applyPalette(palette: Palette): void;
}

export interface TelemetryRailProps {
  /** Initial palette; replaced wholesale by `applyPalette`. */
  palette: Palette;
  totalContext?: number;
}

/** The right-hand column: throughput, context, cost, files.
 *
 * Composes the sub-widgets rather than drawing them itself, so each can be
 * updated independently and the rail stays cheap to refresh. In the port the
 * sub-widgets stay pure (props in, JSX out) and this component owns all the
 * mutable state behind an imperative handle — the closest Ink equivalent of
 * the Python pass-through methods.
 */
export const TelemetryRail = forwardRef<TelemetryRailHandle, TelemetryRailProps>(
  function TelemetryRail(props, ref) {
    // RESIZE_EDGE "left"; MIN 24 / MAX 72 / DEFAULT 32.
    const { railWidth } = useRailResize(24, 72, 32);
    const [palette, setPalette] = useState(props.palette);
    // gauge.total is the single copy of the window size — the Python rail
    // kept `self.total_context` in step with the gauge so a later
    // setContext(used) without a total would not snap it back to the
    // boot-time value; here that "keeping in step" is just reading
    // gauge.total, which always carries the last explicitly-set total.
    const [gauge, setGauge] = useState<{ used: number; total: number }>({
      used: 0,
      total: Math.max(1, props.totalContext ?? 128_000),
    });
    const [cost, setCost] = useState<{ cost: number; tokIn: number; tokOut: number }>({
      cost: 0.0,
      tokIn: 0,
      tokOut: 0,
    });
    // The rail is resizable in principle, so the waveform/gauge follow the
    // column rather than stranding a fixed-width signal in a wider rail.
    const waveWidth = Math.max(8, railWidth - 2);
    const gaugeWidth = Math.max(8, railWidth - 2 - 5);
    const [wave, setWave] = useState<{ samples: number[]; latest: number }>(() => ({
      samples: new Array(waveWidth).fill(0),
      latest: 0,
    }));
    const [files, setFiles] = useState<Map<string, number>>(new Map());
    const [calls, setCalls] = useState<CallEntry[]>([]);

    // Keep the newest samples and pad the left with idle ones when the
    // window grows, so the live edge of the signal stays anchored right.
    useEffect(() => {
      setWave((prev) => {
        if (prev.samples.length === waveWidth) return prev;
        const next = prev.samples.slice(-waveWidth);
        while (next.length < waveWidth) next.unshift(0);
        return { ...prev, samples: next };
      });
    }, [waveWidth]);

    useImperativeHandle(ref, () => ({
      pushWave(sample: number) {
        setWave((prev) => {
          const latest = Math.max(0, sample);
          const next = [...prev.samples, latest];
          if (next.length > waveWidth) next.splice(0, next.length - waveWidth);
          return { samples: next, latest };
        });
      },
      setContext(used: number, total?: number) {
        setGauge((prev) => ({
          used: Math.max(0, Math.trunc(used)),
          total: total ? Math.max(1, Math.trunc(total)) : prev.total,
        }));
      },
      setCost(costV: number, tokIn: number, tokOut: number) {
        setCost({ cost: costV, tokIn, tokOut });
      },
      touchFile(path: string) {
        if (!path) return;
        setFiles((prev) => {
          const next = new Map(prev);
          next.set(path, (next.get(path) ?? 0) + 1);
          return next;
        });
      },
      clearFiles() {
        setFiles(new Map());
        setCalls([]);
      },
      noteCall(name: string) {
        setCalls((prev) => {
          const next = [...prev, [name, 'run'] as const];
          if (next.length > 6) next.splice(0, next.length - 6);
          return next;
        });
      },
      noteResult(name: string, ok: boolean) {
        setCalls((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const entry = prev[i]!;
            if (entry[0] === name && entry[1] === 'run') {
              const next = [...prev];
              next[i] = [name, ok ? 'ok' : 'fail'] as const;
              return next;
            }
          }
          return prev;
        });
      },
      applyPalette(next: Palette) {
        setPalette(next);
      },
    }), [waveWidth]);

    const p = palette;
    return (
      // Pack the sections from the top: without packing, the last child
      // absorbs the leftover height and FILES drifts to the bottom of the
      // column, disconnected from the readout it belongs to.
      <Box
        flexDirection="column"
        width={railWidth}
        borderStyle="single"
        borderLeft
        borderColor={p.dim}
      >
        <Box paddingX={1}>
          <Text bold color={p.accent}>⚡ TELEMETRY</Text>
        </Box>
        <Waveform palette={p} width={waveWidth} samples={wave.samples} latest={wave.latest} />
        <ContextGauge palette={p} total={gauge.total} used={gauge.used} width={gaugeWidth} />
        <Box paddingX={1}>
          <Text>
            <Text color={p.dim}>$ </Text>
            <Text bold color={p.accent}>{cost.cost.toFixed(4)}</Text>
            <Text color={p.dim}>   </Text>
            <Text color={p.primary}>{`↑${fmtK(cost.tokIn)}`}</Text>
            <Text color={p.dim}> </Text>
            <Text color={p.accent}>{`↓${fmtK(cost.tokOut)}`}</Text>
          </Text>
        </Box>
        <CallStrip palette={p} calls={calls} />
        <FileRiver palette={p} touched={[...files.entries()]} />
      </Box>
    );
  },
);
