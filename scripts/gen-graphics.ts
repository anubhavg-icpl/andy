/**
 * gen-graphics.ts — regenerate the README graphics (docs/hero.svg,
 * docs/terminal.svg).
 *
 * Run:  npx tsx scripts/gen-graphics.ts   (from the checkout)
 *
 * Both files are plain, self-contained SVG — no external assets, no JS.
 * GitHub renders the CSS animations in place. Every animation is layered ON
 * TOP of a fully-visible base state, so a renderer that samples the first
 * frame (or ignores animation entirely) still shows the complete graphic.
 *
 * The identity is "ink": graphite, bone, one ember accent. No neon, no
 * matrix rain — the wordmark and the chrome carry it. Deterministic
 * throughout, so repeated runs emit identical bytes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// The ink tokens — mirrors src/theme.ts `ink`, plus SVG-only surfaces.
const BG = '#0e1116';
const PANEL = '#151a21';
const HAIR = '#2a313c';
const BONE = '#ece9e4';
const BONE_BRIGHT = '#ffffff';
const DIM = '#5c6470';
const EMBER = '#e8843c';
const EMBER_SOFT = '#f2a56b';

// === SECTION === the ANDY wordmark ==========================================
//
// Four letters on a 4×7 cell grid. Rows are strings; '#' paints a cell.
const LETTERS: Record<string, string[]> = {
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#', '#..#'],
  N: ['#..#', '##.#', '##.#', '#.##', '#.##', '#..#', '#..#'],
  D: ['###.', '#..#', '#..#', '#..#', '#..#', '#..#', '###.'],
  Y: ['#..#', '#..#', '#..#', '.##.', '.##.', '.##.', '.##.'],
};

/** The wordmark as per-letter <g>s of merged cell rects, for stagger. */
function wordmark(x: number, y: number, cell: number, row: number, gap: number): string {
  const groups: string[] = [];
  Object.keys(LETTERS).forEach((ch, li) => {
    const rects: string[] = [];
    LETTERS[ch]!.forEach((line, r) => {
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '#') {
          rects.push(`<rect x="${x + li * (4 * cell + gap) + c * cell}" y="${y + r * row}" width="${cell}" height="${row}"/>`);
        }
      }
    });
    groups.push(`<g class="ltr" style="animation-delay:${(li * 0.14).toFixed(2)}s">${rects.join('')}</g>`);
  });
  return groups.join('\n    ');
}

// === SECTION === hero.svg ====================================================

function hero(): string {
  const W = 1280;
  const H = 460;

  // A fine dot grid, statically painted — the only texture.
  const dots: string[] = [];
  for (let gy = 26; gy < H; gy += 46) {
    for (let gx = 26; gx < W; gx += 46) dots.push(`<circle cx="${gx}" cy="${gy}" r="1.1"/>`);
  }

  const wordX = 317;
  const wordW = 4 * 4 * 34 + 3 * 34; // 646

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ANDY">
  <defs>
    <linearGradient id="bone" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${BONE_BRIGHT}"/>
      <stop offset="60%" stop-color="${BONE}"/>
      <stop offset="100%" stop-color="#a8a39b"/>
    </linearGradient>
    <linearGradient id="emberline" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${EMBER}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${EMBER}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${EMBER}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${EMBER}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}" rx="12"/></clipPath>
  </defs>

  <style>
    /* Base state fully visible — the pulse only breathes, never hides. */
    .ltr { fill: url(#bone); animation: breathe 4.2s ease-in-out infinite; }
    @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.82; } }

    .rule { animation: ember 4.6s ease-in-out infinite; }
    @keyframes ember { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }

    .scan { animation: scan 7s linear infinite; }
    @keyframes scan { 0% { transform: translateY(-140px); } 100% { transform: translateY(600px); } }

    .cur { animation: blink 1.05s steps(1,end) infinite; }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }

    .tag  { font: 600 16px ${MONO}; letter-spacing: 3.4px; fill: ${BONE};
             paint-order: stroke; stroke: ${BG}; stroke-width: 6; stroke-linejoin: round; }
    .meta { font: 13px ${MONO}; letter-spacing: 1.8px; fill: ${DIM}; }

    @media (prefers-reduced-motion: reduce) {
      .ltr, .rule, .scan, .cur { animation: none; }
    }
  </style>

  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <g fill="${HAIR}" opacity="0.55">${dots.join('')}</g>

    <g>
    ${wordmark(wordX, 86, 34, 26, 34)}
    </g>

    <!-- ember rule under the wordmark: the one accent, and it breathes -->
    <rect class="rule" x="${wordX}" y="290" width="${wordW}" height="3" rx="1.5" fill="url(#emberline)"/>

    <rect class="scan" x="0" y="0" width="${W}" height="140" fill="url(#beam)"/>

    <text class="tag" x="${W / 2}" y="336" text-anchor="middle">andy // autonomous terminal agent</text>
    <rect class="cur" x="${W / 2 + 268}" y="321" width="10" height="19" fill="${EMBER_SOFT}"/>

    <text class="meta" x="${W / 2}" y="378" text-anchor="middle">streaming · tool-using · scope-aware · session-kept</text>
    <text class="meta" x="${W / 2}" y="406" text-anchor="middle" opacity="0.85">by Andy</text>

    <!-- corner ticks: the terminal frame hinted, not drawn -->
    <g stroke="${DIM}" stroke-width="2" opacity="0.8">
      <path d="M 18 34 V 18 H 34" fill="none"/>
      <path d="M ${W - 18} 34 V 18 H ${W - 34}" fill="none"/>
      <path d="M 18 ${H - 34} V ${H - 18} H 34" fill="none"/>
      <path d="M ${W - 18} ${H - 34} V ${H - 18} H ${W - 34}" fill="none"/>
    </g>
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${HAIR}"/>
  </g>
</svg>
`;
}

// === SECTION === terminal.svg ===============================================

function terminal(): string {
  const W = 1100;
  const H = 470;
  const line = (
    y: number,
    fill: string,
    text: string,
    delay: number,
    extra = '',
  ) =>
    `  <text class="ln" x="36" y="${y}" fill="${fill}" style="animation-delay:${delay.toFixed(2)}s"${extra ? ` ${extra}` : ''}>${text}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="ANDY session">
  <defs>
    <clipPath id="tframe"><rect x="0" y="0" width="${W}" height="${H}" rx="14"/></clipPath>
    <filter id="tglow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>
    /* Opacity is never animated: a staggered fade would leave every line
       invisible during its own delay — exactly what a renderer that ignores
       animation (or samples frame zero) would show. Only the slide moves. */
    .ln { font: 15px ${MONO}; animation: rise .5s ease-out backwards; }
    @keyframes rise { from { transform: translateY(8px); } to { transform: translateY(0); } }
    .cur { animation: blink 1.05s steps(1,end) infinite; }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
    .title { font: 600 13px ${MONO}; letter-spacing: 2px; fill: ${BONE}; }
    @media (prefers-reduced-motion: reduce) {
      .ln { animation: none; } .cur { animation: none; }
    }
  </style>

  <g clip-path="url(#tframe)">
    <rect width="${W}" height="${H}" fill="${BG}"/>
    <rect width="${W}" height="46" fill="${PANEL}"/>
    <circle cx="28" cy="23" r="6.5" fill="#ff5f57"/>
    <circle cx="50" cy="23" r="6.5" fill="#febc2e"/>
    <circle cx="72" cy="23" r="6.5" fill="#28c840"/>
    <text class="title" x="${W / 2}" y="28" text-anchor="middle">andy — shell</text>
    <line x1="0" y1="46" x2="${W}" y2="46" stroke="${HAIR}"/>

    <text x="36" y="78" fill="${DIM}" style="font:13px ${MONO};letter-spacing:1.2px">
      ◆ ANDY · [AUTO] · ● deepseek-v4.1-flash · ▸ ~/work/api · scope off · sandbox on
    </text>

${line(112, BONE, '› map every route this API exposes, then write it up', 0.55)}
${line(140, '#7c8592', '  ✻ thinking  (+31 earlier)', 1.05, 'font-style="italic"')}
${line(164, '#7c8592', '  openapi.json in /public is stale — grep the handlers instead…', 1.25, 'font-style="italic"')}
${line(196, EMBER_SOFT, '$ bash  grep -rhoE "@(Get|Post|Put|Delete)\\(\'[^\']+" src/', 1.75)}
${line(224, BONE, '  ✓ 47 routes · 6 auth-gated · 2 admin · 1 upload', 2.25)}
${line(256, EMBER_SOFT, '$ write_file  findings/routes.md', 2.85)}
${line(284, BONE, '  ✓ diff applied  +61 −0', 3.35)}
${line(316, '#f5b25e', '$ turn 3 · iter 7 · $0.0142 · 18.4k tok', 3.95)}

    <rect class="cur" x="38" y="338" width="9" height="17" fill="${BONE}" filter="url(#tglow)"/>

    <line x1="0" y1="424" x2="${W}" y2="424" stroke="${HAIR}"/>
    <text x="36" y="448" fill="${DIM}" style="font:13px ${MONO}">
      ● deepseek-v4.1-flash · tok ↑18.4k ↓612 · $ 0.0142 · turn 3 · 00:47 · ● idle
    </text>
    <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${HAIR}"/>
  </g>
</svg>
`;
}

// === SECTION === write =======================================================

for (const [name, svg] of [
  ['hero.svg', hero()],
  ['terminal.svg', terminal()],
] as const) {
  const out = path.join(ROOT, 'docs', name);
  fs.writeFileSync(out, svg, 'utf8');
  process.stdout.write(`wrote ${path.relative(ROOT, out)} (${svg.length} bytes)\n`);
}
