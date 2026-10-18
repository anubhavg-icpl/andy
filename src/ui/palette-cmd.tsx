/**
 * palette-cmd.tsx — command palette: Ctrl+K, every action in one
 * fuzzy-searchable list.
 *
 * What this module is: the fuzzy matcher (fuzzy/rank — pure, directly
 * testable) and the CommandPalette overlay. The slash commands are
 * discoverable only by reading /help; this makes them *findable*. Type a
 * few letters, arrow down, Enter. It also reaches things that have no slash
 * command at all (jump to a file, switch to a model by name).
 *
 * Invariants:
 *  - The palette itself is dumb: the app builds the entries, each with a
 *    callable, and the palette just filters and returns the chosen one via
 *    onChoose. That keeps every action's definition next to the thing it
 *    acts on.
 *  - ink 8 ships no TextInput core component, so the query field is a
 *    minimal hand-rolled input over useInput (printable chars + backspace).
 *  - No JSX literals: the repo tsconfig declares no `jsx` compiler option
 *    (TS17004 would fail the build), so the component uses createElement.
 */

import {createElement, useEffect, useMemo, useRef, useState, type FC} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import chalk from 'chalk';

import type { Palette } from '../theme.js';

export const MAX_ROWS = 10;

/** One selectable action. */
export interface PaletteEntry {
  key: string;
  title: string;
  hint?: string;
  group?: string;
  /** What to do when chosen. Built by the app, so the palette needs no knowledge of the commands it offers. */
  run?: () => void;
}

export function fuzzy(query: string, text: string): [number, number[]] | undefined {
  /**
   * Subsequence match of `query` in `text`.
   *
   * Returns [score, matchedIndices] — higher score is better — or undefined
   * if the query's characters do not all appear, in order. Scores reward
   * contiguous runs and word-boundary starts, so `md` ranks /model above a
   * title where those letters are scattered.
   */
  if (!query) {
    return [0, []];
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let prev = -2;
  let cursor = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, cursor);
    if (found === -1) {
      return undefined;
    }
    indices.push(found);
    if (found === prev + 1) {
      score += 3; // a contiguous run reads as a real prefix
    }
    if (found === 0 || ' /-_.'.includes(t[found - 1]!)) {
      score += 4; // starting a word beats matching mid-word
    }
    score -= Math.min(found - cursor, 4); // penalise long skips, but not unbounded
    prev = found;
    cursor = found + 1;
  }
  score -= Math.floor(t.length / 12); // ties go to the shorter, more specific title
  return [score, indices];
}

export function rank(entries: PaletteEntry[], query: string): [PaletteEntry, number[]][] {
  /** Filter and order `entries` for `query`, best first. */
  const q = query.trim();
  if (!q) {
    return entries.map(e => [e, []] as [PaletteEntry, number[]]);
  }
  const scored: [number, number, PaletteEntry, number[]][] = [];
  entries.forEach((e, i) => {
    let hit = fuzzy(q, e.title);
    if (hit === undefined) {
      // Fall back to the hint, so "cost" finds "$0.0142 session total".
      hit = fuzzy(q, e.hint ?? '');
    }
    if (hit === undefined) {
      return;
    }
    scored.push([-hit[0], i, e, hit[1]]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.map(([, , e, idx]) => [e, idx]);
}

// === SECTION === the palette component ===

export interface CommandPaletteProps {
  entries: PaletteEntry[];
  palette: Palette;
  /** The chosen entry, or null on cancel (the Python dismiss(None)). */
  onChoose: (entry: PaletteEntry | null) => void;
}

/** A top-dropped fuzzy search over the app's actions. */
export const CommandPalette: FC<CommandPaletteProps> = ({entries, palette, onChoose}) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const results = useMemo(() => rank(entries, query), [entries, query]);
  const {columns, rows} = useWindowSize();
  // Guard so a key that lands during the same frame as the choose callback
  // cannot fire onChoose twice (Python dismissed the ModalScreen, which
  // unmounted its bindings; React needs the explicit flag).
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, []);

  const choose = (entry: PaletteEntry | null) => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    onChoose(entry);
  };

  const move = (delta: number) => {
    if (results.length === 0) {
      return;
    }
    const limit = Math.min(results.length, MAX_ROWS);
    setIndex(i => (((i + delta) % limit) + limit) % limit);
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'k')) {
      choose(null);
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      move(-1);
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      move(1);
      return;
    }
    if (key.return) {
      if (results.length === 0) {
        choose(null);
        return;
      }
      const [entry] = results[Math.min(index, results.length - 1)]!;
      choose(entry);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(q => [...q].slice(0, -1).join(''));
      setIndex(0);
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
      setQuery(q => q + input);
      setIndex(0);
    }
  });

  // ---- list rendering -----------------------------------------------------

  const listLines: string[] = [];
  if (results.length === 0) {
    listLines.push(chalk.hex(palette.dim)('  no matches'));
  }
  for (let i = 0; i < Math.min(results.length, MAX_ROWS); i++) {
    const [entry, indices] = results[i]!;
    const selected = i === index;
    const prefix = selected ? chalk.bold.hex(palette.accent)('▌ ') : '  ';
    const base = selected ? chalk.bold.hex(palette.accent) : chalk.hex(palette.primary);
    // Title with the matched characters picked out.
    const marked = new Set(indices);
    let title = '';
    [...entry.title].forEach((ch, ci) => {
      title += marked.has(ci) ? chalk.bold.hex(palette.accent)(ch) : base(ch);
    });
    let line = prefix + title;
    if (entry.hint) {
      line += chalk.hex(palette.dim)(`  ${entry.hint}`);
    }
    if (entry.group) {
      line += chalk.hex(palette.dim)(`   [${entry.group}]`);
    }
    listLines.push(line);
  }
  if (results.length > MAX_ROWS) {
    listLines.push(chalk.hex(palette.dim)(`  … ${results.length - MAX_ROWS} more`));
  }

  // Plain ASCII for the key hints: the fancier arrows (⏎, ↵) are missing
  // from many terminal fonts and render as a blank box.
  const foot =
    chalk.bold.hex(palette.accent)('  ↑↓') +
    chalk.hex(palette.dim)(' move   ') +
    chalk.bold.hex(palette.accent)('enter') +
    chalk.hex(palette.dim)(' run   ') +
    chalk.bold.hex(palette.accent)('esc') +
    chalk.hex(palette.dim)(' close');

  const queryLine =
    query.length > 0
      ? chalk.hex(palette.primary)('❯ ' + query) + chalk.bold.hex(palette.accent)('▊')
      : chalk.hex(palette.dim)('❯ search commands, models, files…');

  // The Python modal dimmed the background toward the palette background
  // ($background 75%) — not toward black, see the PermissionModal note in
  // app.py. Ink has no alpha and cannot dim what is behind an overlay, so
  // the box itself carries palette.bg and the app renders the main UI
  // un-dimmed underneath.
  const width = Math.min(Math.floor(columns * 0.76), 110);

  return createElement(
    Box,
    {height: rows, flexDirection: 'column', alignItems: 'center'},
    createElement(
      Box,
      {
        flexDirection: 'column',
        width,
        marginTop: 3,
        // Textual's "heavy" border (thick ┏ lines) — cli-boxes calls the
        // same style "bold".
        borderStyle: 'bold',
        borderColor: palette.accent,
        backgroundColor: palette.bg,
        paddingX: 1,
      },
      createElement(Text, null, queryLine),
      ...listLines.map((line, i) => createElement(Text, {key: i}, line)),
      createElement(Text, null, foot),
    ),
  );
};
