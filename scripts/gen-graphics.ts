/**
 * gen-graphics.ts — regenerate the animated README graphics
 * (docs/hero.svg, docs/terminal.svg).
 *
 * Run:  npx tsx scripts/gen-graphics.ts   (from the checkout)
 *
 * Port of docs/gen_graphics.py (preserved at git tag pre-andy-port). Both
 * files are plain, self-contained SVG — no external assets, no JS. GitHub
 * renders the CSS animations in place. Every animation is layered ON TOP of a
 * fully-visible base state, so a renderer that samples the first frame (or
 * ignores animation entirely) still shows the complete graphic.
 *
 * Byte-faithful to the Python output, which required two deliberate choices:
 *
 *  - The random layer (rain positions, durations, digits) is drawn from a
 *    from-scratch MT19937 — CPython's `random` — seeded the way
 *    `random.seed(7)` seeds, so the generated SVG matches the committed one
 *    glyph for glyph. Swap in `Math.random()` and every rain line moves.
 *
 *  - Number formatting rounds half-to-even, the way Python's `f"{x:.0f}"`
 *    does. The wordmark's origin lands on 117.5 / 250.5 / …, and
 *    `Math.round` would print 251 where Python (and the committed asset)
 *    print 250.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .js extension on a .tsx module: the repo's NodeNext ESM convention (the
// TS source behind it), same as the tests use.
import { FONT, FONT_HEIGHT } from '../src/ui/banner.js';

// === SECTION === CPython's random (MT19937), seeded like random.seed(7) ===

/** One CPython `_random.Random`; `seed(int)` with init_by_array, like CPython. */
class PyRandom {
  private mt = new Uint32Array(624);
  private idx = 625; // force regeneration on first draw

  /** CPython turns a small non-negative int seed into one key word. */
  constructor(seed: number) {
    this.initByArray([seed >>> 0]);
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    mt[0] = 19650218;
    for (let i = 1; i < 624; i++) {
      mt[i] = (Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1812433253) + i) >>> 0;
    }
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      // mt[i] = (mt[i] ^ ((mt[i-1] ^ (mt[i-1]>>30)) * 1664525)) + key[j] + j
      // — the multiply binds to the inner XOR only, then the outer XOR, then
      // the add. Grouping it the other way diverges from CPython on draw #1.
      mt[i] =
        ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) +
          key[j]! +
          j) >>>
        0;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private uint32(): number {
    if (this.idx >= 624) {
      const mt = this.mt;
      for (let i = 0; i < 624; i++) {
        const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
        mt[i] = (mt[(i + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.idx = 0;
    }
    let y = this.mt[this.idx++]!;
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = y ^ (y >>> 18);
    return y >>> 0;
  }

  /** random.random(): 53 bits from two draws, exactly as CPython builds it. */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** random.getrandbits(k) for 1 <= k <= 32: the top k bits of one draw. */
  private getrandbits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** random._randbelow(n): rejection-sample below n on k = n.bit_length()
   *  bits. k must be CPython's exactly — a different width draws a different
   *  number of bits per attempt and the whole sequence diverges. */
  private randbelow(n: number): number {
    let k = 1;
    while ((1 << k) <= n) k++; // bit_length(n) for n >= 1
    for (;;) {
      const r = this.getrandbits(k);
      if (r < n) return r;
    }
  }

  /** random.randint(a, b), inclusive. */
  randint(a: number, b: number): number {
    return a + this.randbelow(b - a + 1);
  }

  /** random.uniform(a, b). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  /** random.choice(seq). */
  choice<T>(seq: T[]): T {
    return seq[this.randbelow(seq.length)]!;
  }
}

// === SECTION === Python number formatting ===

/**
 * `f"{x:.0f}"` — round half to EVEN, like Python. The banner geometry is
 * full of *.5 origins; Math.round would round them half-up and shift every
 * other glyph a pixel off the committed asset.
 */
function fmt0(x: number): string {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff === 0.5) {
    // An exact tie: pick the even neighbour.
    return floor % 2 === 0 ? String(floor) : String(floor + 1);
  }
  return String(Math.round(x)); // no tie: plain nearest is identical
}

/** `f"{x:.2f}"` (toFixed matches Python away from exact binary ties, which
 * the arithmetic here — products of non-representable decimals — never hits;
 * kept as a named seam next to fmt0 so the pair reads as one decision). */
function fmt2(x: number): string {
  return x.toFixed(2);
}

// === SECTION === the hero ===

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const [BG, GRID, GREEN, DIM, ACCENT, AMBER] = [
  '#040704',
  '#0a1a0d',
  '#00ff41',
  '#0c5a22',
  '#7dffb0',
  '#ffb000',
];

const W = 1280;
const H = 420;
const word = 'ZIMZILLA'; // the wordmark the committed assets carry — see header
const GW = 6;
const SP = 1;
const cell = 19;
const totalCells = word.length * GW + (word.length - 1) * SP;
const x0 = (W - totalCells * cell) / 2;
const y0 = 126;

const glyphs: string[] = [];
for (let gi = 0; gi < word.length; gi++) {
  const ch = word[gi]!;
  const gx = x0 + gi * (GW + SP) * cell;
  const rects: string[] = [];
  const glyph = FONT[ch]!;
  for (let r = 0; r < FONT_HEIGHT; r++) {
    const row = glyph[r]!;
    let c = 0;
    while (c < row.length) {
      if (row[c] === '█') {
        let run = 0;
        while (c + run < row.length && row[c + run] === '█') run++;
        rects.push(
          `<rect x="${fmt0(gx + c * cell)}" y="${y0 + r * cell}" ` +
            `width="${run * cell}" height="${cell}"/>`,
        );
        c += run;
      } else {
        c += 1;
      }
    }
  }
  // base opacity is 1 — the animation only adds a glitch flicker on top.
  glyphs.push(
    `<g class="gl" style="animation-delay:${fmt2(gi * 0.11)}s">` + rects.join('') + '</g>',
  );
}
const banner = glyphs.join('\n      ');

const rng = new PyRandom(7);
const RAIN_DIGITS = '0123456789ABCDEF'.split('');
const rain = Array.from({ length: 34 }, (_, i) => {
  // The Python f-string evaluates its placeholders left to right BEFORE the
  // digit generator joins the expression, so the draw order is x, duration,
  // delay, digits — not digits first.
  const x = 18 + i * 37 + rng.randint(-6, 6);
  const duration = fmt2(rng.uniform(3.4, 8.2));
  const delay = fmt2(rng.uniform(0, 6));
  const digits = Array.from({ length: 9 }, () => rng.choice(RAIN_DIGITS)).join('');
  return (
    `<text class="rain" x="${x}" y="-150" ` +
    `style="animation-duration:${duration}s;` +
    `animation-delay:-${delay}s">` +
    digits +
    '</text>'
  );
}).join('\n      ');

const subY = 288;
const heroSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ZIMZILLA">
  <defs>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <linearGradient id="rainfade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${GREEN}" stop-opacity="0.04"/>
    </linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="${ACCENT}" stop-opacity="0"/>
      <stop offset="50%"  stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${GREEN}" stop-opacity="0"/>
      <stop offset="50%"  stop-color="${GREEN}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${GREEN}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}" rx="10"/></clipPath>
  </defs>

  <style>
    .rain { font: 16px ui-monospace, Menlo, Consolas, monospace;
             fill: url(#rainfade); animation: fall linear infinite; }
    @keyframes fall { from { transform: translateY(0); } to { transform: translateY(${H + 270}px); } }

    /* Base state is fully visible; the loop only dips it briefly. */
    .gl rect { fill: ${GREEN};
                animation: flicker 7s steps(1,end) infinite; }
    @keyframes flicker {
      0%, 88%   { opacity: 1; }
      89%       { opacity: 0.62; }
      90%       { opacity: 1; }
      91%       { opacity: 0.38; }
      92%, 100% { opacity: 1; }
    }

    .halo { animation: halo 3.6s ease-in-out infinite; }
    @keyframes halo { 0%,100% { opacity: .45; } 50% { opacity: .95; } }

    .band { animation: band 3.8s cubic-bezier(.4,0,.2,1) infinite; }
    @keyframes band { 0% { transform: translateX(-${W}px); }
                       55%,100% { transform: translateX(${W}px); } }

    .sweep { animation: sweep 5.4s linear infinite; }
    @keyframes sweep { 0% { transform: translateY(-90px); } 100% { transform: translateY(${H + 90}px); } }

    .cur { animation: blink 1.05s steps(1,end) infinite; }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }

    .tag, .meta { paint-order: stroke; stroke: ${BG}; stroke-width: 5;
                   stroke-linejoin: round; }
    .tag { font: 600 15px ui-monospace, Menlo, Consolas, monospace;
            letter-spacing: 3.2px; fill: ${ACCENT}; }
    .meta { font: 13px ui-monospace, Menlo, Consolas, monospace;
             letter-spacing: 1.6px; fill: ${DIM}; }

    @media (prefers-reduced-motion: reduce) {
      .rain, .gl rect, .band, .sweep, .cur, .halo { animation: none; }
    }
  </style>

  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <g opacity="0.5">${Array.from({ length: Math.ceil(H / 26) }, (_, k) => `<line x1="0" y1="${k * 26}" x2="${W}" y2="${k * 26}" stroke="${GRID}"/>`).join('')}</g>
    <g opacity="0.32">${rain}</g>

    <g filter="url(#glow)" class="halo">${banner}</g>

    <rect class="band" x="0" y="${y0 - 16}" width="300" height="${FONT_HEIGHT * cell + 32}"
          fill="url(#band)" style="mix-blend-mode:screen"/>
    <rect class="sweep" x="0" y="0" width="${W}" height="90" fill="url(#scan)"/>

    <text class="tag" x="${fmt0(W / 2)}" y="${subY}" text-anchor="middle">net.shell // autonomous coding agent</text>
    <rect class="cur" x="${fmt0(W / 2 + 232)}" y="${subY - 15}" width="10" height="18" fill="${ACCENT}"/>

    <text class="meta" x="${fmt0(W / 2)}" y="332" text-anchor="middle">terminal-native · streaming · tool-using · scope-aware</text>
    <text class="meta" x="${fmt0(W / 2)}" y="360" text-anchor="middle" opacity="0.8">by Mr-Destroyer / ZIM</text>

    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="${DIM}" stroke-opacity="0.55"/>
  </g>
</svg>
`;

// === SECTION === the terminal ===

const LINES: [kind: string, text: string][] = [
  ['prompt', 'recon the target and map the attack surface'],
  ['dim', '· enumerating · decrypting · probing'],
  ['tool', 'bash  nmap -sV -p- target.example.com'],
  ['ok', '✓ 9 hosts up · 412 open ports · 0 blocked'],
  ['tool', 'write_file  findings/attack-surface.md'],
  ['ok', '✓ diff applied  +84 −0'],
  ['info', 'turn 3 · iter 7 · $0.0142 · 18.4k tok'],
];

function esc(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function terminalSvg(): string {
  const W = 1100;
  const H = 430;
  const pad = 34;
  const lh = 34;
  const top = 104;
  const rows: string[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const [kind, text] = LINES[i]!;
    const delay = 0.55 + i * 0.62;
    const color = { prompt: GREEN, dim: DIM, tool: ACCENT, ok: GREEN, info: AMBER }[kind]!;
    const prefix = kind === 'prompt' ? '› ' : kind === 'ok' || kind === 'dim' ? '  ' : '$ ';
    rows.push(
      `<text class="ln" x="${pad}" y="${top + i * lh}" fill="${color}" ` +
        `style="animation-delay:${fmt2(delay)}s">${prefix}${esc(text)}</text>`,
    );
  }
  const body = rows.join('\n      ');
  const lastY = top + (LINES.length - 1) * lh;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ZIMZILLA session">
  <defs>
    <clipPath id="tframe"><rect x="0" y="0" width="${W}" height="${H}" rx="12"/></clipPath>
    <filter id="tglow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>
    /* Opacity is never animated: a staggered fade would leave every line
       invisible during its own delay, which is exactly what a renderer that
       ignores animation (or samples frame zero) would show. Only the slide
       moves, so the text is legible in every renderer and still animates in. */
    .ln { font: 16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
           animation: rise .5s ease-out backwards; }
    @keyframes rise { from { transform: translateY(8px); }
                       to   { transform: translateY(0); } }
    .cur { animation: blink 1.05s steps(1,end) infinite; }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
    .title { font: 600 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              letter-spacing: 2px; fill: ${ACCENT}; }
    @media (prefers-reduced-motion: reduce) {
      .ln { animation: none; opacity: 1; } .cur { animation: none; }
    }
  </style>

  <g clip-path="url(#tframe)">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect width="${W}" height="46" fill="#0a140c"/>
    <circle cx="28" cy="23" r="6.5" fill="#ff5f57"/>
    <circle cx="50" cy="23" r="6.5" fill="#febc2e"/>
    <circle cx="72" cy="23" r="6.5" fill="#28c840"/>
    <text class="title" x="${fmt0(W / 2)}" y="28" text-anchor="middle">zimzilla — net.shell</text>
    <line x1="0" y1="46" x2="${W}" y2="46" stroke="${DIM}" stroke-opacity="0.6"/>

    <text x="${pad}" y="76" fill="${DIM}" style="font:13px ui-monospace,Menlo,monospace;letter-spacing:1.4px">
      ◆ ZIMZILLA   ◆ AUTO   ◆ deepseek-v4.1-flash   ▸ /home/zim   ◈ scope off   ⛨ sandbox on
    </text>

      ${body}

    <rect class="cur" x="${pad + 2}" y="${lastY + 22}" width="9" height="17" fill="${GREEN}" filter="url(#tglow)"/>

    <line x1="0" y1="${H - 42}" x2="${W}" y2="${H - 42}" stroke="${DIM}" stroke-opacity="0.6"/>
    <text x="${pad}" y="${H - 17}" fill="${DIM}" style="font:13px ui-monospace,Menlo,monospace">
      ● deepseek-v4.1-flash   |   tok ↑18.4k ↓612   |   $ 0.0142   |   turn 3   |   ● idle
    </text>
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${DIM}" stroke-opacity="0.55"/>
  </g>
</svg>
`;
}

fs.writeFileSync(path.join(OUT, 'hero.svg'), heroSvg);
fs.writeFileSync(path.join(OUT, 'terminal.svg'), terminalSvg());
console.log('wrote docs/hero.svg and docs/terminal.svg');
