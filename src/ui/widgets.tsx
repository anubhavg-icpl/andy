/**
 * widgets.tsx — layout widgets: header, chat pane, status bar (port of
 * zimzilla/ui/widgets.py).
 *
 * What this module is: the four fixed chrome pieces of the app — PromptInput
 * (the paste-retaining prompt field), HeaderBar, ChatPane (transcript + live
 * slots), StatusBar — plus ZimPane, the /phish and /bug-hunt campaign rail.
 *
 * Invariants:
 *  - PromptInput keeps a WHOLE paste: line breaks are stored as real
 *    newlines so the model receives the text as written, and only the display
 *    folds them to NEWLINE_GLYPH.
 *  - ChatPane and ZimPane are driven through imperative handles (the PORT-MAP
 *    §3 mapping for Textual's query_one + reactive writes); HeaderBar,
 *    StatusBar and PromptInput are pure props.
 *  - Ink throws on bare string children of <Box>, so every line break
 *    between styled rides inside a <Text> run.
 *  - Rename rule applied: identity strings are ANDY (was ZIMZILLA/ZIM).
 */

import { forwardRef, Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import type { Palette } from '../theme.js';
import { MODES } from '../config.js';
import { RainRichLog } from './rain.js';
import { markdownText } from './markdown.js';
import { reasoningLive, SEVERITY_ORDER, severityStyle, toolRunningPanel } from './renderers.js';

// === SECTION === cell-width math (rich cell_len approximation) ===
//
// HeaderBar fits its fields by measured width, so it needs to know how many
// cells a string paints. This is a compact approximation of rich's cell_len:
// combining marks 0, East-Asian/wide/emoji ranges 2, everything else 1. Tabs
// count as one cell (the Python field expanded them to 4 for cursor math;
// tabs in a one-row prompt are vanishingly rare next to pasted newlines).

function charWidth(code: number): number {
  if (code === 0) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x200b && code <= 0x200f) || // zero-width + bidi marks
    (code >= 0xfe00 && code <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK radicals..Yi
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

function visualWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += charWidth(text.codePointAt(i) ?? 0x20);
  }
  return w;
}

// Ink layout rules this module relies on (verified against ink 8):
//  - Sibling <Text> children of a column <Box> each render ONE row; no
//    newline characters between them (a trailing "\n" adds a blank row).
//  - Nested <Text> runs inside one outer <Text> stay on that line.
//  - A blank line is a single-space row; an empty string collapses entirely.
function Blank(): ReactNode {
  return <Text>{' '}</Text>;
}

// === SECTION === PromptInput ===

// A pasted line break is drawn as this glyph. The field is one row tall, so a
// real `\n` in the strip would push the rows below it down the screen; the
// glyph is one cell wide and keeps the value's character indices 1:1 with the
// cells they paint into, which the cursor math assumes.
export const NEWLINE_GLYPH = '↵';

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface PromptInputProps {
  palette: Palette;
  /** The field value, newlines included; the caller owns it (controlled). */
  value: string;
  onChange(value: string): void;
  onSubmit?(value: string): void;
  placeholder?: string;
  password?: boolean;
  /** Input gating — the PORT-MAP §3 stand-in for Input.focus()/disabled. */
  active?: boolean;
}

/** The prompt field — a one-row input that keeps a whole paste.
 *
 * Textual's stock Input kept only the *first line* of a paste and silently
 * discarded the rest, so any prompt copied with a line break in it arrived
 * truncated. This port keeps the entire paste on the `usePaste` channel
 * (Ink 8 routes bracketed pastes there, away from keypresses). Line endings
 * are normalised to `\n` (some terminals bracket-paste CRLF) and stored as
 * real newlines so the model receives the text as written; only the
 * *display* folds them to NEWLINE_GLYPH, because a raw newline inside a
 * one-row field would corrupt every row beneath it.
 *
 * The Python subclass also carried cursor cell-math (`_position_to_cell`) to
 * place Textual's cursor; Ink has no cell-level cursor API, so the cursor is
 * rendered inline as a reversed cell at the caret offset instead.
 */
export function PromptInput(props: PromptInputProps): ReactNode {
  const { palette, value, onChange, onSubmit } = props;
  const active = props.active ?? true;
  const [cursor, setCursor] = useState(value.length);

  // External value changes (app clearing the field, session restore) clamp
  // the caret rather than letting it dangle past the end.
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value.length, cursor]);

  const insert = useCallback(
    (text: string) => {
      const t = normalizeNewlines(text);
      if (!t) return;
      // Every path into the value funnels through here — typing and paste
      // alike — so normalising once means no stray `\r` can enter the value.
      onChange(value.slice(0, cursor) + t + value.slice(cursor));
      setCursor(cursor + t.length);
    },
    [value, cursor, onChange],
  );

  const wordLeft = (from: number): number => {
    let i = from;
    while (i > 0 && /\s/.test(value[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
    return i;
  };
  const wordRight = (from: number): number => {
    let i = from;
    while (i < value.length && /\s/.test(value[i]!)) i++;
    while (i < value.length && !/\s/.test(value[i]!)) i++;
    return i;
  };

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursor(key.ctrl ? wordLeft(cursor) : Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(key.ctrl ? wordRight(cursor) : Math.min(value.length, cursor + 1));
        return;
      }
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(value.length);
        return;
      }
      if (key.backspace) {
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
        return;
      }
      if (key.delete) {
        if (cursor < value.length) {
          onChange(value.slice(0, cursor) + value.slice(cursor + 1));
        }
        return;
      }
      if (key.tab || key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input) insert(input);
    },
    { isActive: active },
  );

  // The whole paste, not just its first line — see the class docstring.
  usePaste(
    (text) => {
      if (text) insert(text);
    },
    { isActive: active },
  );

  const { columns } = useWindowSize();
  const fieldWidth = Math.max(10, columns - 4);

  // The value as rendered — newlines shown as a one-cell glyph, passwords
  // masked to one bullet per character (length-preserving, like the Python).
  const display = props.password
    ? '•'.repeat(value.length)
    : value.replaceAll('\n', NEWLINE_GLYPH);

  // Keep the caret visible: drop cells from the left until the caret sits
  // inside the field with two cells of headroom (approximation: astral
  // characters may overshoot by one cell, never hiding the caret).
  const cellsBefore = visualWidth(display.slice(0, cursor));
  let start = 0;
  if (cellsBefore > fieldWidth - 2) {
    let acc = cellsBefore;
    while (start < cursor && acc > fieldWidth - 2) {
      acc -= charWidth(display.codePointAt(start) ?? 0x20);
      start++;
    }
  }
  let end = start;
  for (let w = 0; end < display.length && w <= fieldWidth; end++) {
    w += charWidth(display.codePointAt(end) ?? 0x20);
  }
  const rel = cursor - start;
  const atCell = display[rel] ?? ' ';

  return (
    <Box paddingX={1}>
      <Text>
        {value === '' && props.placeholder ? (
          <Text color={palette.dim}>{props.placeholder}</Text>
        ) : null}
        <Text color={palette.primary}>{display.slice(start, rel)}</Text>
        <Text backgroundColor={palette.accent} color={palette.bg}>{atCell}</Text>
        <Text color={palette.primary}>{display.slice(rel + 1, end)}</Text>
      </Text>
    </Box>
  );
}

// === SECTION === HeaderBar ===

export interface HeaderBarProps {
  palette: Palette;
  model: string;
  cwd: string;
  unsafe: boolean;
  /** Theme name for the droppable tail field (`theme:...`). Named
   * `themeName`, not `theme`, to match the app lane's consumer contract. */
  themeName: string;
  mode?: string;
  /** Scope summary text; defaults to "off" (the Python ctor's resting state). */
  scopeBadge?: string;
  /** False renders the scope field in red — a security fact, never dropped. */
  scopeArmed?: boolean;
}

/** One styled run — the Rich `Text.append` analogue used by the fit loop. */
interface Seg {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
}

function segWidth(segs: readonly Seg[]): number {
  return segs.reduce((acc, s) => acc + visualWidth(s.text), 0);
}

function renderSegs(segs: readonly Seg[]): ReactNode {
  return (
    <Text>
      {segs.map((s, i) => (
        <Text key={i} color={s.color} backgroundColor={s.bg} bold={s.bold}>{s.text}</Text>
      ))}
    </Text>
  );
}

/** Top bar: model, cwd, scope status, theme name. */
export function HeaderBar(props: HeaderBarProps): ReactNode {
  const p = props.palette;
  const mode = props.mode ?? 'auto';
  const scopeOk = props.scopeArmed ?? true;
  const { columns } = useWindowSize();
  // The bar sheds fields by measured fit, so a resize can change what fits —
  // useWindowSize re-renders here, which is the port of Python's on_resize.
  const limit = columns || 200;

  const m = (MODES as Record<string, { label?: string; loud?: boolean }>)[mode] ?? {};
  // Modes marked "loud" (zim, danger, uncensored) are the armed states —
  // shout them.
  const loud = m.loud === true;
  const label = m.label ?? mode.toUpperCase();

  const head: Seg[] = [
    { text: '◈ ANDY', color: p.primary, bold: true },
    { text: '  │  ', color: p.dim },
    loud
      ? { text: `◆ ${label} `, color: 'white', bg: p.red, bold: true }
      : { text: `◆ ${label} `, color: p.accent, bold: true },
    { text: '  │  ', color: p.dim },
    { text: '◉ ', color: p.accent },
    { text: props.model, color: p.accent, bold: true },
  ];

  // Everything after the model is optional, in order of how little it
  // matters. The bar is one row and the terminal clips the overflow, so an
  // over-long cwd would silently eat the scope status — the one field that
  // says whether the sandbox is armed. So: build the tail, then drop the
  // least important pieces until the whole thing fits the row we actually
  // have. Measured, not guessed: a fixed width threshold is wrong the moment
  // the cwd is a real project path rather than /tmp. Ordered
  // least-important-LAST, because the fit loop pops from the end: the theme
  // goes first, then the cwd, and the sandbox indicator — which is a
  // security fact, not decoration — goes last.
  let tail: Seg[] = [
    { text: '⛨ sandbox on', color: p.dim },
    { text: `⌂ ${props.cwd}`, color: p.primary },
    { text: `theme:${props.themeName}`, color: p.dim },
  ];
  // The sandbox being OFF is not cosmetic — it never gets dropped.
  if (props.unsafe) {
    tail = [
      { text: '⚠ SANDBOX OFF', color: 'white', bg: p.red, bold: true },
      ...tail.filter((f) => f.text !== '⛨ sandbox on'),
    ];
  }

  // Scope sits between the fixed head and the droppable tail.
  const fixed: Seg[] = [
    ...head,
    { text: '  │  ', color: p.dim },
    { text: '⌖ scope ', color: p.dim },
    { text: props.scopeBadge ?? 'off', color: scopeOk ? p.accent : p.red, bold: true },
  ];

  let chosen: readonly Seg[] = fixed;
  while (tail.length > 0) {
    const attempt: Seg[] = [...fixed];
    for (const f of tail) {
      attempt.push({ text: '  │  ', color: p.dim });
      attempt.push(f);
    }
    if (segWidth(attempt) <= limit) {
      chosen = attempt;
      break;
    }
    tail.pop(); // shed the least important field and try again
  }

  return <Box paddingX={1}>{renderSegs(chosen)}</Box>;
}

// === SECTION === ChatPane ===

interface CardState {
  name: string;
  args: Record<string, unknown>;
  targets: string[];
  started: number;
  frame: number;
}

export interface ChatPaneHandle {
  /** Append a finished block to the transcript (panels, markers, prose). */
  writeBlock(node: ReactNode): void;
  setStream(text: string): void;
  clearStream(): void;
  setReasoning(text: string): void;
  clearReasoning(): void;
  /** Show a transient status line. An empty *text* hides the slot. */
  setSpinner(text: string): void;
  clearSpinner(): void;
  /** Open the live card for a tool that just started. Only one card exists
   * at a time: a tool call flushes the previous card first, so the slot
   * always belongs to the newest call. */
  cardBegin(name: string, args: Record<string, unknown>, targets?: readonly string[] | null): void;
  /** Repaint the running card — spinner frame and elapsed clock. */
  cardTick(): void;
  /** Close the card slot. The finished panel is written by the caller: the
   * result is a transcript entry (it scrolls, it survives a clear); the card
   * is not. */
  cardFinish(): void;
  cardActive(): boolean;
  setRain(active: boolean): void;
  applyPalette(palette: Palette): void;
  clear(): void;
  /** Toggle the streaming cursor block; driven by the app's blink timer. */
  flashCursor(): void;
}

export interface ChatPaneProps {
  palette: Palette;
  rain?: boolean;
}

/** Scrollable transcript plus the live streaming line. */
export const ChatPane = forwardRef<ChatPaneHandle, ChatPaneProps>(function ChatPane(props, ref) {
  const [palette, setPalette] = useState(props.palette);
  const [rainOn, setRainOn] = useState(props.rain ?? true);
  const [cursorOn, setCursorOn] = useState(true);
  const [blocks, setBlocks] = useState<ReactNode[]>([]);
  const blockKey = useRef(0);
  const [stream, setStreamState] = useState<string | null>(null);
  const [reasoning, setReasoningState] = useState<string | null>(null);
  const [spinner, setSpinnerState] = useState<string | null>(null);
  // The tool call currently in flight, or null. Set by cardBegin and cleared
  // by cardFinish — this is the whole card lifecycle.
  const [card, setCard] = useState<CardState | null>(null);

  // No deps array: the handle is recreated each render so `cardActive()` and
  // the card repaint read current state, not a stale closure.
  useImperativeHandle(ref, () => ({
    writeBlock(node: ReactNode) {
      // `expand` in the Python original filled the pane's content width so a
      // panel fit the width the pane had *now* without baking one in; here
      // the transcript renderer owns width, so a block is appended as-is and
      // a blank line follows it (Python wrote `""` after every block).
      const k = blockKey.current++;
      setBlocks((prev) => [
        ...prev,
        <Fragment key={`b${k}`}>{node}</Fragment>,
        <Text key={`gap${k}`}>{' '}</Text>,
      ]);
    },
    setStream(text: string) {
      setStreamState(text);
    },
    clearStream() {
      setStreamState(null);
    },
    setReasoning(text: string) {
      setReasoningState(text);
    },
    clearReasoning() {
      setReasoningState(null);
    },
    setSpinner(text: string) {
      setSpinnerState(text || null);
    },
    clearSpinner() {
      setSpinnerState(null);
    },
    cardBegin(name: string, args: Record<string, unknown>, targets?: readonly string[] | null) {
      setCard({
        name,
        args: args ?? {},
        targets: [...(targets ?? [])],
        started: performance.now(),
        frame: 0,
      });
    },
    cardTick() {
      setCard((prev) => (prev ? { ...prev, frame: prev.frame + 1 } : prev));
    },
    cardFinish() {
      setCard(null);
    },
    cardActive() {
      return card !== null;
    },
    setRain(active: boolean) {
      setRainOn(active);
    },
    applyPalette(next: Palette) {
      setPalette(next);
    },
    clear() {
      setBlocks([]);
      setStreamState(null);
      setReasoningState(null);
      setCard(null);
    },
    flashCursor() {
      setCursorOn((v) => !v);
    },
  }));

  return (
    <Box flexDirection="column" width="100%">
      {/* min_width=1 in the Python original stopped RichLog clamping writes
          up to 78 columns when the pane was narrower; the port's transcript
          renderer sizes to whatever width it is given. */}
      <RainRichLog palette={palette} rainOn={rainOn} blocks={blocks} />
      {/* The reasoning slot sits ABOVE the answer, because that is the order
          the two arrive in: the model thinks, then it speaks. Once the answer
          starts, the thinking is committed to the transcript and this empties,
          so the two are rarely on screen at once — but when they are, the
          reading order matches the arrival order rather than reversing it. */}
      {reasoning !== null ? (
        // Column: reasoningLive is a multi-row block (header line + tail
        // lines), and a default (row) Box would lay its rows out sideways.
        <Box paddingX={1} flexDirection="column">
          {reasoningLive(reasoning, palette, cursorOn ? '▊' : '')}
        </Box>
      ) : null}
      {stream !== null ? (
        /* The flat markdown form, not the rich one: this re-renders on every
         * delta and on the cursor blink, and a table or highlighted code here
         * would be rebuilt several times a second for a line that is still
         * arriving. Markdown is resolved anyway, so the half-written answer
         * reads as prose rather than as its own source while it streams. */
        <Box paddingX={1} flexDirection="row" flexWrap="nowrap">
          {markdownText(stream, palette)}
          <Text bold color={palette.accent}>{cursorOn ? '▊' : ' '}</Text>
        </Box>
      ) : null}
      {card !== null ? (
        <Box paddingX={1}>
          {toolRunningPanel(
            card.name,
            card.args,
            palette,
            (performance.now() - card.started) / 1000,
            card.frame,
            card.targets,
          )}
        </Box>
      ) : null}
      {/* A slot for a line that changes several times a second. It cannot be
          the transcript: the log is append-only, so each frame would add a new
          line rather than replace the old one, and a spinner that scrolls the
          pane is worse than none. The stream and reasoning slots are already
          spoken for, so this gets its own. */}
      {spinner !== null ? (
        <Box paddingX={1}>
          <Text bold color={palette.accent}>{spinner}</Text>
        </Box>
      ) : null}
    </Box>
  );
});

// === SECTION === StatusBar ===

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface StatusBarProps {
  palette: Palette;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  turns?: number;
  iterations?: number;
  activity?: string;
  busy?: boolean;
  /** Re-render driver for the elapsed clock: the app bumps it once a second,
   * which re-runs this component and recomputes the time since mount — the
   * port of Python's `render_bar()` being re-called on every counter tick. */
  tick?: number;
  /** performance.now() milliseconds the elapsed clock counts from; defaults
   * to mount time (the Python bar captured `time.monotonic()` in its ctor).
   * Optional extra beyond the app contract, kept for tests. */
  startedAt?: number;
}

/** Bottom bar: tokens, cost, turns, iteration, elapsed, activity. */
export function StatusBar(props: StatusBarProps): ReactNode {
  const p = props.palette;
  const mountStart = useRef(performance.now());
  const started = props.startedAt ?? mountStart.current;
  const elapsed = Math.max(0, Math.floor((performance.now() - started) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = elapsed % 60;
  const model = props.model ?? '?';
  const inputTokens = props.inputTokens ?? 0;
  const outputTokens = props.outputTokens ?? 0;
  const cost = props.cost ?? 0.0;
  const turns = props.turns ?? 0;
  const iterations = props.iterations ?? 0;
  const activity = props.activity ?? 'idle';
  const busy = props.busy ?? false;

  return (
    <Box paddingX={1}>
      <Text>
        <Text bold color={p.accent}>◉ </Text>
        <Text color={p.primary}>{model}</Text>
        <Text color={p.dim}>{'  │  '}</Text>
        <Text color={p.dim}>tok </Text>
        <Text color={p.primary}>{`↑${fmtK(inputTokens)}`}</Text>
        <Text color={p.dim}> </Text>
        <Text color={p.accent}>{`↓${fmtK(outputTokens)}`}</Text>
        <Text color={p.dim}>{'  │  '}</Text>
        <Text color={p.dim}>$ </Text>
        <Text bold color={p.accent}>{cost.toFixed(4)}</Text>
        <Text color={p.dim}>{'  │  '}</Text>
        <Text color={p.primary}>{`turn ${turns}`}</Text>
        <Text color={p.dim}>{'  │  '}</Text>
        <Text color={p.dim}>{`iter ${iterations}`}</Text>
        <Text color={p.dim}>{'  │  '}</Text>
        <Text color={p.primary}>
          {`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`}
        </Text>
        <Text color={p.dim}>{'  │  '}</Text>
        {busy ? (
          <Text bold color={p.accent}>{`⟳ ${activity}`}</Text>
        ) : (
          <Text color={p.dim}>{`● ${activity}`}</Text>
        )}
      </Text>
    </Box>
  );
}

// === SECTION === ZimPane (campaign rail) ===

/** One engine event off the phish campaign queue. */
export interface PaneEvent {
  kind?: string;
  [key: string]: unknown;
}

/** One hunt event, applied directly on the UI thread. */
export interface HuntPaneEvent {
  type?: string;
  [key: string]: unknown;
}

interface HuntAgentState {
  activity: string;
  status: string;
  index: number;
}

export interface ZimPaneHandle {
  showCampaign(host: string): void;
  showHunt(target: string, size?: number): void;
  /** Apply one hunt event and repaint. */
  noteHunt(event: HuntPaneEvent): void;
  /** Apply one engine event and repaint. */
  note(event: PaneEvent): void;
  hide(): void;
  /** Hide the pane without stopping the campaign. */
  closePane(): void;
  minimize(): void;
  restore(): void;
  toggleMinimized(): void;
  applyPalette(palette: Palette): void;
}

export interface ZimPaneProps {
  palette: Palette;
}

// Hunt agents shown at once. Ten run concurrently, but ten live activity
// lines do not fit a 36-column pane — the most recently active five do, and
// the status bar carries the count for the rest.
const HUNT_SLOTS = 5;
const MAX_HITS = 8;
const MAX_CREDS = 6;

/** A one-glance hint of what a tool call is aimed at. */
function briefHint(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'url', 'query', 'pattern']) {
    const value = record[key];
    if (value) {
      const text = String(value).trim().split('\n')[0] ?? '';
      return text.slice(0, 24);
    }
  }
  return '';
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Live campaign rail: two views, one pane.
 *
 * **phish** (default) — hits, credentials, local + public URLs. Hidden until
 * `/phish` starts a campaign. The engine pushes events onto a thread-safe
 * queue; the app drains that queue on the 0.25s rail tick and calls `note()`,
 * so the HTTP server never touches the render thread.
 *
 * **hunt** — what `/bug-hunt`'s agents are doing right now. Ten agents run
 * concurrently but only HUNT_SLOTS of them fit legibly in 36 columns, so the
 * pane shows the most recently active ones with their current activity; the
 * status bar carries the aggregate for all ten. `showHunt` switches the pane
 * into this view.
 *
 * The Python chrome was mouse-driven (`[–]` minimize, `[×]` hide, drag the
 * left gutter to resize). Ink has no mouse events (PORT-MAP §3 descope), so
 * the glyphs remain as labels and the actions ride on the handle for the
 * app's key bindings; width stays at the default column.
 */
export const ZimPane = forwardRef<ZimPaneHandle, ZimPaneProps>(function ZimPane(props, ref) {
  const [palette, setPalette] = useState(props.palette);
  // Which campaign the pane is showing: "phish" or "hunt". The two views
  // share the chrome (minimize, close) and nothing else, so a hunt never
  // renders phish labels or vice versa.
  const [view, setView] = useState<'phish' | 'hunt'>('phish');
  const [visible, setVisible] = useState(false);
  const [host, setHost] = useState('');
  const [localUrl, setLocalUrl] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [tunnelTool, setTunnelTool] = useState('');
  const [cloneNote, setCloneNote] = useState('');
  const [cloned, setCloned] = useState(false);
  const [alive, setAlive] = useState(false);
  const [hits, setHits] = useState<PaneEvent[]>([]);
  const [creds, setCreds] = useState<PaneEvent[]>([]);
  // ---- hunt view state
  const [huntTarget, setHuntTarget] = useState('');
  const [huntWave, setHuntWave] = useState(0);
  const [huntSize, setHuntSize] = useState(0);
  const [huntDone, setHuntDone] = useState(0);
  const [huntRunning, setHuntRunning] = useState(false);
  // name -> {activity, status, index}. Ordered by first appearance; the pane
  // renders the tail, so the most recently active agents are the ones on
  // screen. A JS Map preserves insertion order — delete+set moves an entry to
  // the end, which is the Python dict-pop-reinsert trick.
  const [huntAgents, setHuntAgents] = useState<Map<string, HuntAgentState>>(new Map());
  const [huntSeverity, setHuntSeverity] = useState<Map<string, number>>(new Map());
  const [minimized, setMinimized] = useState(false);

  const touch = (agents: Map<string, HuntAgentState>, name: unknown): Map<string, HuntAgentState> => {
    // Move *name* to the end of the activity order.
    if (!name) return agents;
    const key = String(name);
    const state = agents.get(key);
    if (state === undefined) return agents;
    const next = new Map(agents);
    next.delete(key);
    next.set(key, state);
    return next;
  };

  useImperativeHandle(ref, () => ({
    showCampaign(target: string) {
      setView('phish');
      setHost(target);
      setLocalUrl('');
      setPublicUrl('');
      setTunnelTool('');
      setCloneNote('starting…');
      setCloned(false);
      setAlive(true);
      setHits([]);
      setCreds([]);
      setMinimized(false);
      setVisible(true);
    },
    showHunt(target: string, size = 0) {
      setView('hunt');
      setHuntTarget(target);
      setHuntWave(0);
      setHuntSize(size);
      setHuntDone(0);
      setHuntRunning(true);
      setHuntAgents(new Map());
      setHuntSeverity(new Map());
      setMinimized(false);
      setVisible(true);
    },
    noteHunt(event: HuntPaneEvent) {
      const kind = event['type'];
      if (kind === 'hunt_wave_start') {
        setHuntWave(typeof event['wave'] === 'number' ? event['wave'] : huntWave);
        const size = typeof event['size'] === 'number' ? event['size'] : huntSize;
        if (size) setHuntSize(size);
        setHuntDone(0);
        setHuntRunning(true);
        // A new wave re-briefs the roster, so the previous wave's activity
        // lines are stale. Keep the map but mark everything as queued; the
        // agents that actually start will overwrite their own entry.
        setHuntAgents((prev) => {
          const next = new Map<string, HuntAgentState>();
          for (const [name, state] of prev) {
            next.set(name, state.status === 'running'
              ? { ...state, status: 'queued', activity: 'waiting' }
              : state);
          }
          return next;
        });
      } else if (kind === 'hunt_agent_start') {
        const name = String(event['name'] ?? '?');
        setHuntAgents((prev) => {
          const state = prev.get(name) ?? {
            activity: '',
            status: 'running',
            index: typeof event['index'] === 'number' ? event['index'] : 0,
          };
          const next = new Map(prev);
          // Re-insert so the order reflects activity, not first sight: the
          // pane shows the tail, and the agent that just moved is the one the
          // operator wants to see.
          next.delete(name);
          next.set(name, { ...state, status: 'running', activity: 'starting' });
          return next;
        });
      } else if (kind === 'hunt_agent_tool') {
        const name = event['name'];
        if (!name) return;
        setHuntAgents((prev) => {
          const key = String(name);
          const state = prev.get(key);
          if (!state) return prev;
          const tool = String(event['tool'] ?? '?');
          const activity = `${tool} ${briefHint(event['args'])}`.trim();
          const next = new Map(prev);
          next.delete(key);
          next.set(key, { ...state, activity });
          return next;
        });
      } else if (kind === 'hunt_agent_text') {
        const name = event['name'];
        if (!name) return;
        setHuntAgents((prev) => {
          const key = String(name);
          const state = prev.get(key);
          if (!state) return prev;
          const lines = (typeof event['text'] === 'string' ? event['text'] : '').trim().split('\n');
          const activity = lines.length > 0 ? (lines[lines.length - 1] ?? '').slice(0, 40) : '';
          const next = new Map(prev);
          next.delete(key);
          next.set(key, { ...state, activity });
          return next;
        });
      } else if (kind === 'hunt_agent_done') {
        const name = event['name'];
        if (name) {
          setHuntAgents((prev) => {
            const key = String(name);
            const state = prev.get(key);
            if (!state) return prev;
            const ok = event['ok'] === true;
            const next = new Map(prev);
            next.delete(key);
            next.set(key, { ...state, status: ok ? 'done' : 'failed', activity: ok ? 'done' : 'failed' });
            return next;
          });
        }
        setHuntDone((prev) => Math.min(prev + 1, huntSize || prev + 1));
      } else if (kind === 'hunt_finding') {
        const f = (event['finding'] ?? {}) as Record<string, unknown>;
        const sev = String(f['severity'] ?? 'info').toLowerCase();
        setHuntSeverity((prev) => {
          const next = new Map(prev);
          next.set(sev, (next.get(sev) ?? 0) + 1);
          return next;
        });
      } else if (kind === 'hunt_end') {
        setHuntRunning(false);
        setAlive(false);
      }
    },
    note(event: PaneEvent) {
      const kind = event['kind'];
      if (kind === 'ready') {
        if (typeof event['host'] === 'string' && event['host']) setHost(event['host']);
        setLocalUrl(typeof event['local'] === 'string' ? event['local'] : '');
        setPublicUrl(typeof event['public'] === 'string' ? event['public'] : '');
        setTunnelTool(typeof event['tool'] === 'string' ? event['tool'] : '');
        setCloneNote(typeof event['clone'] === 'string' ? event['clone'] : '');
        setCloned(event['cloned'] === true);
        setAlive(true);
      } else if (kind === 'stopped') {
        setAlive(false);
      } else if (kind === 'cred' || kind === 'hit') {
        if (kind === 'cred') {
          setCreds((prev) => {
            const next = [...prev, event];
            return next.length > 40 ? next.slice(next.length - 40) : next;
          });
        }
        setHits((prev) => {
          const next = [...prev, event];
          return next.length > 40 ? next.slice(next.length - 40) : next;
        });
      }
    },
    hide() {
      setAlive(false);
      setHuntRunning(false);
      setMinimized(false);
      setVisible(false);
    },
    closePane() {
      setMinimized(false);
      setVisible(false);
    },
    minimize() {
      setMinimized(true);
    },
    restore() {
      setMinimized(false);
    },
    toggleMinimized() {
      setMinimized((v) => !v);
    },
    applyPalette(next: Palette) {
      setPalette(next);
    },
  }));

  const p = palette;

  if (!visible) return null;

  if (minimized) {
    const label = view === 'hunt' ? huntTarget : host;
    const live = view === 'hunt' ? huntRunning : alive;
    let findings = 0;
    for (const n of huntSeverity.values()) findings += n;
    return (
      <Box flexDirection="column" width={14} borderStyle="single" borderLeft borderColor={p.dim}>
        <Text bold color={p.accent}> ANDY</Text>
        <Text color={p.dim}> [+][×]</Text>
        {label ? (
          <Text>
            <Text color={p.dim}> </Text>
            <Text color={p.primary}>{clip(label, 10)}</Text>
          </Text>
        ) : null}
        <Text bold={live} color={live ? p.accent : p.dim}>{live ? ' LIVE' : ' ---'}</Text>
        {view === 'hunt' ? (
          <Text color={p.primary}>{` ${findings} find`}</Text>
        ) : (
          <Text color={p.primary}>{` ${creds.length} cred`}</Text>
        )}
      </Box>
    );
  }

  if (view === 'hunt') {
    const total = huntSize || huntAgents.size || 0;
    let found = 0;
    for (const n of huntSeverity.values()) found += n;
    const agents = [...huntAgents.entries()].slice(-HUNT_SLOTS);
    return (
      <Box flexDirection="column" width={36} borderStyle="single" borderLeft borderColor={p.dim} paddingX={1}>
        <Text>
          <Text bold color={p.accent}>ANDY-PANE</Text>
          <Text color={p.dim}>{'  [–][×]'}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>hunt   </Text>
          <Text bold color={p.primary}>{huntTarget || '?'}</Text>
        </Text>
        <Text>
          <Text color={p.dim}>state  </Text>
          <Text bold={huntRunning} color={huntRunning ? p.accent : p.amber}>
            {huntRunning ? 'LIVE' : 'stopped'}
          </Text>
        </Text>
        {huntWave ? (
          <Text>
            <Text color={p.dim}>wave   </Text>
            <Text bold color={p.primary}>{`${huntWave}  `}</Text>
            <Text color={p.dim}>{`${huntDone}/${total} done`}</Text>
          </Text>
        ) : null}
        {/* Findings, worst first — the whole point of the pane during a hunt. */}
        <Blank />
        <Text>
          <Text bold color={p.accent}>FINDINGS</Text>
          <Text color={p.dim}>{`  ${found}`}</Text>
        </Text>
        {found === 0 ? (
          <Text color={p.dim}>  (none yet)</Text>
        ) : (
          // The same severity colours the findings panel uses, so a CRITICAL
          // cannot read red in the panel and amber in the rail.
          SEVERITY_ORDER.map((sev) => {
            const n = huntSeverity.get(sev) ?? 0;
            if (!n) return null;
            const st = severityStyle(sev, p, { bold: true });
            return (
              <Text key={sev}>
                <Text bold={st.bold} color={st.color}>{`  ${sev.padEnd(9)}`}</Text>
                <Text color={p.dim}>{String(n)}</Text>
              </Text>
            );
          })
        )}
        {/* The agents, most recently active last. Ten run at once but only
            HUNT_SLOTS fit; the tail is what is moving. */}
        <Blank />
        <Text>
          <Text bold color={p.accent}>AGENTS</Text>
          <Text color={p.dim}>{`  ${huntAgents.size}`}</Text>
        </Text>
        {huntAgents.size === 0 ? (
          <Text color={p.dim}>  (waiting)</Text>
        ) : (
          agents.map(([name, st]) => {
            const status = st.status || 'running';
            let mark = '·';
            let markColor = p.dim;
            let markBold = false;
            if (status === 'running') {
              mark = '▸';
              markColor = p.accent;
              markBold = true;
            } else if (status === 'done') {
              mark = '✔';
              markColor = p.primary;
              markBold = true;
            } else if (status === 'failed') {
              mark = '✘';
              markColor = p.amber;
              markBold = true;
            }
            let activity = st.activity || '';
            if (activity.length > 30) activity = `${activity.slice(0, 29)}…`;
            return (
              <Fragment key={name}>
                <Text>
                  <Text bold={markBold} color={markColor}>{`  ${mark} `}</Text>
                  <Text bold={status === 'running'} color={status === 'running' ? p.primary : p.dim}>
                    {name.slice(0, 14)}
                  </Text>
                </Text>
                {activity && status === 'running' ? (
                  <Text color={p.dim}>{`    ${activity}`}</Text>
                ) : null}
              </Fragment>
            );
          })
        )}
        <Blank />
        <Text color={p.dim}>drag left edge to resize</Text>
        <Text color={p.dim}>/stop-hunt  to end the hunt</Text>
      </Box>
    );
  }

  // ---- phish view -------------------------------------------------------
  return (
    <Box flexDirection="column" width={36} borderStyle="single" borderLeft borderColor={p.dim} paddingX={1}>
      <Text>
        <Text bold color={p.accent}>ANDY-PANE</Text>
        <Text color={p.dim}>{'  [–][×]'}</Text>
      </Text>
      {!host && !alive ? (
        <Text color={p.dim}>idle</Text>
      ) : (
        <>
          <Text>
            <Text color={p.dim}>phish  </Text>
            <Text bold color={p.primary}>{host || '?'}</Text>
          </Text>
          <Text>
            <Text color={p.dim}>state  </Text>
            <Text bold={alive} color={alive ? p.accent : p.amber}>
              {alive ? 'LIVE' : 'stopped'}
            </Text>
          </Text>
          {cloneNote ? (
            <Text>
              <Text color={p.dim}>clone  </Text>
              <Text color={cloned ? p.primary : p.amber}>{clip(cloneNote, 28)}</Text>
            </Text>
          ) : null}
          {localUrl ? (
            <Text>
              <Text color={p.dim}>local  </Text>
              <Text color={p.primary}>{localUrl}</Text>
            </Text>
          ) : null}
          {publicUrl ? (
            <>
              <Text>
                <Text color={p.dim}>public </Text>
                <Text bold color={p.accent}>{publicUrl}</Text>
              </Text>
              {tunnelTool ? (
                <Text>
                  <Text color={p.dim}>via    </Text>
                  <Text color={p.dim}>{tunnelTool}</Text>
                </Text>
              ) : null}
            </>
          ) : alive ? (
            <Text>
              <Text color={p.dim}>public </Text>
              <Text color={p.amber}>none — LAN only</Text>
            </Text>
          ) : null}
          <Blank />
          <Text>
            <Text bold color={p.accent}>CREDS</Text>
            <Text color={p.dim}>{`  ${creds.length}`}</Text>
          </Text>
          {creds.length === 0 ? (
            <Text color={p.dim}>  (waiting)</Text>
          ) : (
            creds.slice(-MAX_CREDS).map((ev, i) => {
              const user = clip(String(ev['user'] ?? '?'), 18);
              const password = String(ev['password'] ?? '');
              return (
                <Text key={`cred${i}`}>
                  <Text bold color={p.red}>  ▸ </Text>
                  <Text bold color={p.primary}>{user}</Text>
                  <Text color={p.dim}>  </Text>
                  <Text color={password ? p.amber : p.dim}>{password || '(no pass)'}</Text>
                </Text>
              );
            })
          )}
          <Blank />
          <Text>
            <Text bold color={p.accent}>HITS</Text>
            <Text color={p.dim}>{`  ${hits.length}`}</Text>
          </Text>
          {hits.length === 0 ? (
            <Text color={p.dim}>  (none yet)</Text>
          ) : (
            hits.slice(-MAX_HITS).map((ev, i) => {
              const method = String(ev['method'] ?? '?');
              const path = clip(String(ev['path'] ?? '/'), 18);
              const isCred = ev['kind'] === 'cred';
              return (
                <Text key={`hit${i}`}>
                  <Text bold={isCred} color={isCred ? p.red : p.dim}>{`  ${isCred ? '●' : '·'} `}</Text>
                  <Text color={p.primary}>{`${method.padEnd(4)} `}</Text>
                  <Text color={p.dim}>{path}</Text>
                </Text>
              );
            })
          )}
          <Blank />
          <Text color={p.dim}>drag left edge to resize</Text>
          <Text color={p.dim}>/phish stop  to tear down</Text>
        </>
      )}
    </Box>
  );
});
