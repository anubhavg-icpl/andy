/**
 * theme.ts — hacker themes for the TUI. (port of zimzilla/theme.py)
 *
 * What this module is: the colour system. Three fixed variants, each a tight
 * palette so the whole UI reads as one neon system — no stray colors anywhere.
 * Plus `system`, which has no colours of its own: it takes the terminal's.
 *
 * Invariants:
 *  - THEME_NAMES is the single source of truth for the theme list — the CLI's
 *    --theme choices, /theme's validation and help, the completion popup and
 *    the palette menu all read this, because the names had already been
 *    written out in six places and drifted.
 *  - The remembered theme lives in `$ANDY_HOME/current-theme` (mirroring the
 *    current-source file the upstream selection uses) so the choice survives
 *    a restart without a config file to edit. Persisting is never fatal: a
 *    read-only home must not break the TUI.
 *  - (Port note) Python's `Palette.rich_theme()` built a Textual Theme; Ink
 *    styles read the palette's colour strings directly, so it has no
 *    equivalent here and is dropped.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { andyHome } from './shared.js';
import type { TerminalColors } from './termcolors.js';

/**
 * One colour scheme: tight by design, so the whole UI reads as a single neon
 * system. Fields are chalk/Ink-compatible colour strings (hex).
 */
export class Palette {
  readonly name: string;
  readonly bg: string;
  readonly primary: string;
  readonly dim: string;
  readonly accent: string;
  readonly red: string;
  readonly amber: string;
  readonly glow: string;

  constructor(init: {
    name: string;
    bg: string;
    primary: string;
    dim: string;
    accent: string;
    red: string;
    amber: string;
    glow: string;
  }) {
    this.name = init.name;
    this.bg = init.bg;
    this.primary = init.primary;
    this.dim = init.dim;
    this.accent = init.accent;
    this.red = init.red;
    this.amber = init.amber;
    this.glow = init.glow;
  }

  /** Python `dataclasses.replace(palette, bg=...)` — same shape, new bg. */
  withBg(bg: string): Palette {
    return new Palette({ ...this, bg });
  }
}

export const PALETTES: Record<string, Palette> = {
  ink: new Palette({
    name: 'zim-ink',
    bg: '#000000',
    primary: '#ece9e4',
    dim: '#5c6470',
    accent: '#e8843c',
    red: '#ff5d5d',
    amber: '#f5b25e',
    glow: '#ece9e4',
  }),
  green: new Palette({
    name: 'zim-green',
    bg: '#000000',
    primary: '#00ff41',
    dim: '#1f6f3a',
    accent: '#8affb9',
    red: '#ff2d2d',
    amber: '#ffb000',
    glow: '#00ff41',
  }),
  amber: new Palette({
    name: 'zim-amber',
    bg: '#000000',
    primary: '#ffb000',
    dim: '#8a6220',
    accent: '#ffd98a',
    red: '#ff2d2d',
    amber: '#ffe08a',
    glow: '#ffb000',
  }),
  cyan: new Palette({
    name: 'zim-cyan',
    bg: '#000000',
    primary: '#00ffd5',
    dim: '#1b7f7a',
    accent: '#a5fff1',
    red: '#ff2d2d',
    amber: '#ffb000',
    glow: '#00ffd5',
  }),
  violet: new Palette({
    name: 'zim-violet',
    bg: '#000000',
    primary: '#bd5cff',
    dim: '#5f2f91',
    accent: '#e2b8ff',
    red: '#ff2d2d',
    amber: '#ffb000',
    glow: '#bd5cff',
  }),
};

export const DEFAULT_THEME = 'ink';

/**
 * The theme that takes its colours from the terminal rather than declaring
 * them. It is not a key in PALETTES because there is nothing to look up —
 * see systemPalette().
 */
export const SYSTEM_THEME = 'system';

/** Every theme name, in the order they are offered. */
export const THEME_NAMES: string[] = [...Object.keys(PALETTES), SYSTEM_THEME];

/**
 * A palette built from the terminal's own colours.
 *
 * The role mapping is the conventional one, so a scheme generator's intent
 * comes through: the foreground becomes `primary`, ANSI 8 (bright black) is
 * the natural `dim`, cyan and yellow are `accent` and `amber`, and red is
 * `red`. `glow` follows `primary` exactly as the green palette's does.
 *
 * Every slot falls back to the green palette's value independently, so a
 * terminal that answers only some of the sixteen degrades field by field
 * rather than all at once — and a terminal that answers nothing gives exactly
 * the green palette, which is the honest default and not a broken one.
 */
export function systemPalette(colors?: TerminalColors | null): Palette {
  const base = PALETTES[DEFAULT_THEME]!;
  if (!colors) return base;

  const primary = colors.fg ?? base.primary;
  return new Palette({
    name: 'zim-system',
    // `.bg`, not `.darkBg`: a system palette is readable on a light terminal
    // because its text colour came from the same place. The three fixed
    // palettes are the ones that must refuse light, and they still do.
    bg: colors.bg ?? base.bg,
    primary,
    dim: colors.ansi.get(8) ?? base.dim,
    accent: colors.ansi.get(6) ?? colors.ansi.get(4) ?? base.accent,
    red: colors.ansi.get(1) ?? base.red,
    amber: colors.ansi.get(3) ?? base.amber,
    glow: primary,
  });
}

/**
 * The palette for *name*, on *bg* if given.
 *
 * `bg` comes from the terminal itself (see termbg.ts). Omitting it — or
 * passing undefined — keeps the palette's own black, which is what happens on
 * a terminal that does not answer OSC 11.
 *
 * `colors` is the full terminal palette, used only by `system`.
 */
export function getPalette(
  name: string,
  bg?: string | null,
  colors?: TerminalColors | null,
): Palette {
  if (name === SYSTEM_THEME) return systemPalette(colors);
  const palette = PALETTES[name] ?? PALETTES[DEFAULT_THEME]!;
  return bg ? palette.withBg(bg) : palette;
}

// === SECTION === the remembered theme (persisted so a restart keeps the last choice) ===

function themeFile(): string {
  // Call-time ANDY_HOME read (Python read it at import time; the difference
  // is observable only if the env mutates mid-process, which it never does —
  // and call-time keeps tests that set ANDY_HOME honest).
  return `${andyHome()}/current-theme`;
}

/**
 * The theme last selected, if it is still one we know.
 *
 * Undefined when nothing was ever saved, when the file cannot be read, or
 * when it names a theme that no longer exists — an unknown name is ignored
 * rather than obeyed, so a file left by an older or newer build cannot put
 * the UI into a state it has no palette for.
 */
export function currentTheme(): string | undefined {
  let name: string;
  try {
    name = readFileSync(themeFile(), 'utf8').trim();
  } catch {
    return undefined;
  }
  return THEME_NAMES.includes(name) ? name : undefined;
}

/** Record the choice. Never fatal — a read-only home must not break the TUI. */
export function setCurrentTheme(name: string): void {
  if (!THEME_NAMES.includes(name)) return;
  try {
    mkdirSync(andyHome(), { recursive: true });
    writeFileSync(themeFile(), `${name}\n`, 'utf8');
  } catch {
    /* a read-only home must not break the TUI */
  }
}

// === SECTION === spinner verbs, worker colours, tool icons ===

/** Verbs cycled by the "thinking" spinner.
 *
 * Professional operator copy: the spinner names what the agent is doing, so
 * the verbs read like work in progress, not a movie.
 */
export const THINKING_VERBS: string[] = [
  'analyzing',
  'searching',
  'planning',
  'verifying',
  'reading',
  'reasoning',
  'cross-checking',
  'indexing',
  'tracing',
  'comparing',
  'drafting',
  'revising',
  'measuring',
  'resolving',
  'summarizing',
  'prioritizing',
];

/**
 * One colour per team worker, assigned by roster position so a worker keeps
 * the same colour for its whole run. `/team` interleaves every worker into a
 * single transcript, and the colour is what tells them apart at a glance.
 *
 * These are deliberately NOT drawn from the active palette: with three
 * workers on screen the point is that they differ from each other, and a
 * palette's own primary/accent/dim are already spoken for by the surrounding
 * chrome. Each is bright enough to read on any of the palettes' backgrounds.
 */
export const AGENT_COLORS: string[] = [
  '#00ffaa', // aqua
  '#ffb000', // amber
  '#7dfff0', // ice
  '#ff8fd0', // rose
  '#b6ff6b', // lime
  '#ff6b6b', // red
];

/**
 * The colour for worker *index*. Wraps, so any roster size is covered.
 * (The palette parameter exists for signature parity with the Python; the
 * colours are deliberately palette-independent — see AGENT_COLORS.)
 */
export function agentColor(index: number, _palette?: Palette | null): string {
  return AGENT_COLORS[index % AGENT_COLORS.length]!;
}

/** Icons per tool, for panel headers. */
export const TOOL_ICONS: Record<string, string> = {
  bash: '❯',
  read_file: '▤',
  write_file: '✎',
  edit_file: '✂',
  glob: '✳',
  grep: '⌕',
  list_dir: '☰',
  search_web: '◎',
  web_fetch: '⇅',
};
