/**
 * termcolors.ts — ask the terminal for its whole palette, not just its
 * background. (port of andy/termcolors.py)
 *
 * What this module is: the `system` theme's data source. termbg.ts asks one
 * question — OSC 11, "what is your background?" — because that is all the
 * fixed palettes needed. A *system* theme needs the opposite: the terminal's
 * colours ARE the theme, and the harness should adopt them. Themes like
 * omarchy's `aether` generate a full scheme from a wallpaper and install it
 * as the terminal's palette, so the terminal is the single place the current
 * colours can be read from. Three queries cover it:
 *
 *   OSC 11            `]11;rgb:1010/1313/1515`   the background
 *   OSC 10            `]10;rgb:...`              the foreground
 *   OSC 4;N (N=0..15) `]4;N;rgb:...`             each ANSI slot
 *
 * Invariants:
 *  - All three are sent in ONE raw-mode session (termbg.query owns the tty
 *    handling and takes a terminator count), so a terminal that does not
 *    implement OSC 4 costs one timeout rather than eighteen.
 *  - parseColors is pure — no tty, no I/O — so the suite can test it against
 *    captured replies. A reply for a slot that was not asked about, or a
 *    malformed one, is simply absent from the result.
 *  - Best-effort like termbg: a terminal that answers nothing yields
 *    undefined, and one that answers only some slots yields those, leaving
 *    the rest for the caller to fall back on.
 */

import { isDark, query, scaleChannel } from './termbg.js';

// OSC code, optional per-slot index, then the colour in either form a
// terminal sends it. One pattern for all three queries rather than three,
// because the only difference between them is the OSC number in group 1.
const OSC_RGB_RE =
  /\](\d+)(?:;(\d+))?;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/g;
const OSC_HASH_RE = /\](\d+)(?:;(\d+))?;#([0-9a-fA-F]{6})/g;

/** How many ANSI slots to ask for. 0-15 is the whole standard palette — 0-7
 * normal, 8-15 bright — and is what a theme generator writes. */
export const ANSI_SLOTS = 16;

/** What the terminal reported. Any field may be missing. */
export class TerminalColors {
  readonly bg: string | undefined;
  readonly fg: string | undefined;
  readonly ansi: ReadonlyMap<number, string>;

  constructor(init?: {
    bg?: string;
    fg?: string;
    ansi?: ReadonlyMap<number, string>;
  }) {
    this.bg = init?.bg;
    this.fg = init?.fg;
    this.ansi = init?.ansi ?? new Map();
  }

  /**
   * The background, but only if it is dark enough for the fixed palettes.
   *
   * The three neon palettes refuse a light background (see termbg.isDark);
   * a system palette does not, because its colours come from the terminal and
   * are readable on whatever it paints. So the filter lives here as an
   * opt-in property rather than being applied on the way in — `system` reads
   * `.bg` directly, everything else reads this.
   */
  get darkBg(): string | undefined {
    return this.bg && isDark(this.bg) ? this.bg : undefined;
  }

  /** Whether the terminal told us anything at all. */
  any(): boolean {
    return Boolean(this.bg || this.fg || this.ansi.size > 0);
  }
}

function hexOfRgb(m: RegExpExecArray): string {
  const [r, g, b] = [m[3]!, m[4]!, m[5]!].map(scaleChannel);
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Turn a batch of OSC replies into a TerminalColors. Pure — no tty, no I/O. */
export function parseColors(reply: Buffer): TerminalColors {
  const text = reply.toString('latin1');
  // Keyed by "<osc-code>;<slot-or-empty>" so OSC 4's per-slot index and the
  // index-less OSC 10/11 do not collide.
  const found = new Map<string, string>();

  for (const m of text.matchAll(OSC_RGB_RE)) {
    found.set(`${m[1]};${m[2] ?? ''}`, hexOfRgb(m));
  }
  // The #rrggbb form. rgb: wins where both are present for a slot, which
  // cannot happen from a single terminal but keeps the precedence defined.
  for (const m of text.matchAll(OSC_HASH_RE)) {
    const key = `${m[1]};${m[2] ?? ''}`;
    if (!found.has(key)) found.set(key, `#${m[3]!.toLowerCase()}`);
  }

  const ansi = new Map<number, string>();
  for (const [key, color] of found) {
    const [code, index] = key.split(';');
    if (code !== '4' || !index) continue;
    const slot = Number.parseInt(index, 10);
    if (Number.isNaN(slot)) continue;
    if (0 <= slot && slot < ANSI_SLOTS) ansi.set(slot, color);
  }

  return new TerminalColors({
    bg: found.get('11;'),
    fg: found.get('10;'),
    ansi,
  });
}

/** The three queries, batched into one escape sequence. */
function payload(): Buffer {
  const parts = ['\x1b]11;?\x1b\\', '\x1b]10;?\x1b\\'];
  for (let i = 0; i < ANSI_SLOTS; i++) parts.push(`\x1b]4;${i};?\x1b\\`);
  return Buffer.from(parts.join(''), 'latin1');
}

/**
 * Ask the terminal for its palette. Undefined when it tells us nothing.
 * Timeout is in SECONDS — slightly longer than termbg's single-query one
 * because there is more to send and more to read back.
 */
export async function detectColors(timeout = 0.4): Promise<TerminalColors | undefined> {
  const colors = parseColors(await query(payload(), timeout));
  return colors.any() ? colors : undefined;
}
