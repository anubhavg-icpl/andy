/**
 * complete.tsx — inline completion popup for the prompt.
 *
 * What this module is: the single source of the slash-command list
 * (SLASH_COMMANDS), the @token file walker (iterFiles), the pure
 * completion/acceptance logic (computeCompletions / acceptCompletion —
 * the port of the widget's refreshFor/accept, split out so the app owns
 * the selection index), and the presentational CompletionPopup.
 *
 * Two triggers:
 *  - a leading `/`  → slash-command menu (opens as soon as the slash is typed)
 *  - an `@token`    → file / directory picker rooted at the working directory
 *
 * Invariants:
 *  - The popup never takes focus — the prompt keeps it, so typing continues
 *    to work normally. Up/Down move the selection (app-side), Tab/Enter
 *    accept, Esc dismisses.
 *  - THEME_NAMES is imported from theme.ts rather than declared here, so the
 *    popup and `/theme` cannot disagree about which themes exist — the two
 *    lists had already drifted apart once. Same for KIND_ORDER from osint.
 *  - No JSX literals: the repo tsconfig declares no `jsx` compiler option
 *    (TS17004 would fail the build), so the component uses createElement.
 */

import {createElement, type FC} from 'react';
import {Box, Text} from 'ink';
import chalk from 'chalk';
import {readdirSync} from 'node:fs';
import path from 'node:path';

import type { Palette } from '../theme.js';
import {THEME_NAMES} from '../theme.js';
import {KIND_ORDER} from '../osint.js';
import {KNOWN_MODELS} from '../config.js';

// (command, description)
export const SLASH_COMMANDS: [string, string][] = [
  ['/help', 'show the command reference'],
  ['/mode', 'switch mode: auto | edits | plan | andy | danger | uncensored'],
  ['/model', 'show or switch the model'],
  ['/cost', 'session token and cost breakdown'],
  ['/scope', 'show scope guard status'],
  ['/rain', 'toggle the matrix-rain background'],
  ['/think', "toggle showing the model's own reasoning"],
  ['/theme', 'switch palette: green | amber | cyan | system'],
  ['/andy-logfare', 'switch upstream to Logfare (:4001)'],
  ['/andy-tokenjuice', 'switch upstream to Token Juice (:4000)'],
  ['/andy-source', 'show upstream sources and status'],
  ['/andy-tokenharbour', 'switch upstream to TokenHarbour (hosted)'],
  ['/andy-openrouter', 'switch upstream to OpenRouter (hosted)'],
  ['/andy-unorouter', 'switch upstream to UnoRouter (hosted, free models)'],
  ['/andy-aihubmix', 'switch upstream to AIHubMix (hosted, free models)'],
  ['/andy-zai', 'switch upstream to Z.ai (GLM Coding Plan)'],
  ['/andy-antseed', 'switch upstream to AntSeed (local buyer, free peers)'],
  ['/tokenharbour-api-setup', 'store your TokenHarbour API key'],
  ['/tokenharbour-models', 'fetch the live catalog; show what is free'],
  ['/openrouter-api-setup', 'store your OpenRouter API key'],
  ['/unorouter-api-setup', 'store your UnoRouter API key'],
  ['/unorouter-models', 'the live free catalog — what is free and usable'],
  ['/aihubmix-api-setup', 'store your AIHubMix API key'],
  ['/aihubmix-models', 'the live free catalog — what is free and usable'],
  ['/zai-api-setup', 'store your Z.ai Coding Plan API key'],
  ['/zai-models', 'the GLM Coding Plan model registry'],
  ['/antseed-models', "list AntSeed's free models, with the peer to pin"],
  ['/ldxhub-api-setup', 'store your LDXHub API key (document jobs)'],
  ['/ldxhub-models', 'LDXHub models/engines — pick the default per service'],
  ['/models', 'free models of an upstream — /models [source]'],
  ['/andy-opencode', 'open opencode behind a fresh rotating IP'],
  ['/save', 'write the session to disk'],
  ['/load', 'restore a saved session'],
  ['/compact', 'summarise history to free context'],
  ['/limits', 'context window, round caps and timeouts'],
  ['/team', 'fan the task out across parallel agents'],
  ['/osint', 'open-source recon on a target'],
  ['/osint-tree', 're-show a finished recon as a result tree'],
  ['/phish', 'clone a login page and harvest creds'],
  ['/scope-validator', 'paste a programme overview → scope files + ranked targets'],
  ['/bug-hunt', 'recon, then one wave of 10 agents'],
  ['/ad', 'Active Directory campaign — gated and interlocked'],
  ['/crack', 'crack hashes offline — CPU only, budgeted'],
  ['/stop-hunt', 'end a running hunt'],
  ['/summary-hunt', 'the hunt report — what each wave did'],
  ['/report-bug-hunt', 'evidence-only report, every wave'],
  ['/findings', 'the hunt finding tracker'],
  ['/clear', 'wipe transcript and history'],
  ['/exit', 'leave the harness'],
];

export const MODE_NAMES = ['auto', 'edits', 'plan', 'andy', 'danger', 'uncensored'];
// THEME_NAMES is imported from theme.ts rather than declared here, so the popup
// and `/theme` cannot disagree about which themes exist — the two lists had
// already drifted apart once. (See the module contract block.)

export const MAX_ROWS = 8;
export const MAX_FILES = 200;

const SKIP_DIRS = new Set([
  '.git',
  '__pycache__',
  'node_modules',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.tox',
  '.idea',
]);

export function iterFiles(root: string, limit = MAX_FILES): string[] {
  /**
   * Up to `limit` relative paths under `root`, skipping heavy directories.
   *
   * Walks with a hand-rolled depth-first walk that prunes in place (the
   * os.walk analogue) rather than materialising the whole tree first:
   * collecting every path and only then applying the limit — what a
   * `sorted(rglob('*'))` does — visits the entire tree before the check
   * can stop it, which on a large repo is a visible stall the first time
   * the popup opens. Pruning as it goes keeps the work genuinely bounded
   * by `limit`.
   *
   * The result is still sorted for a stable display order, which sorts only
   * the (at most `limit`) entries actually collected.
   */
  const out: string[] = [];
  const rootAbs = path.resolve(root);
  const relOf = (dir: string, name: string): string | undefined => {
    const rel = path.relative(rootAbs, path.join(dir, name));
    if (rel.startsWith('..')) {
      return undefined; // escaped the root — the ValueError analog
    }
    return rel.split(path.sep).join('/');
  };
  const walk = (dir: string): boolean => {
    // Returns true once the limit is hit, so recursion unwinds immediately.
    let dirents;
    try {
      dirents = readdirSync(dir, {withFileTypes: true});
    } catch {
      return false; // an unreadable directory contributes nothing
    }
    const dirnames: string[] = [];
    const filenames: string[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) {
        dirnames.push(d.name);
      } else if (d.isFile()) {
        filenames.push(d.name);
      }
    }
    dirnames.sort();
    filenames.sort();
    // This directory's entries first (dirs before files, as os.walk yields
    // them), then descend — skipping the heavy directories entirely.
    const kept = dirnames.filter(name => !SKIP_DIRS.has(name));
    for (const name of kept) {
      const rel = relOf(dir, name);
      if (rel === undefined) {
        continue;
      }
      out.push(rel + '/');
      if (out.length >= limit) {
        return true;
      }
    }
    for (const name of filenames) {
      const rel = relOf(dir, name);
      if (rel === undefined) {
        continue;
      }
      out.push(rel);
      if (out.length >= limit) {
        return true;
      }
    }
    for (const name of kept) {
      if (walk(path.join(dir, name))) {
        return true;
      }
    }
    return false;
  };
  walk(rootAbs);
  return out.sort();
}

// The file pool is cached per workdir for the popup's lifetime — the analog
// of the Python widget's `self._files`. The walk is bounded but not free,
// and without the cache it would run on every keystroke.
const filePoolCache = new Map<string, string[]>();

function filePool(workdir: string): string[] {
  let pool = filePoolCache.get(workdir);
  if (pool === undefined) {
    pool = iterFiles(workdir);
    filePoolCache.set(workdir, pool);
  }
  return pool;
}

export interface CompletionContext {
  workdir: string;
  /** The live endpoint, so `/model <TAB>` can offer that upstream's catalog. */
  baseUrl?: string;
  /**
   * The app's `sources.modelsFor` — injected rather than imported so this
   * module keeps no package-level edge on the provider family. Python
   * imported sources lazily *inside* refreshFor for exactly that reason;
   * a callback is the honest TS restructure of the same avoidance.
   */
  modelPool?: (baseUrl: string) => string[] | undefined;
}

export interface CompletionResult {
  kind: 'slash' | 'file' | '';
  items: [string, string][];
}

const tokenize = (s: string): string[] => s.split(/\s+/).filter(w => w.length > 0);

export function computeCompletions(text: string, ctx: CompletionContext): CompletionResult {
  /**
   * Recompute completions for the current prompt text (the port of the
   * widget's refreshFor). Pure apart from the file-pool cache; the caller
   * owns the selection index and shows/hides on `items.length === 0`.
   */
  let kind: CompletionResult['kind'] = '';
  let items: [string, string][] = [];

  if (text.startsWith('/')) {
    kind = 'slash';
    const words = tokenize(text);
    const query = (words[0] ?? text).toLowerCase();
    if (text.trim().includes(' ')) {
      // past the command word — offer sub-arguments
      const parts = tokenize(text.slice(1));
      const head = (parts[0] ?? '').toLowerCase();
      const arg = parts[1]?.toLowerCase() ?? '';
      let pool: string[] = [];
      if (head === 'mode') {
        pool = MODE_NAMES;
      } else if (head === 'theme') {
        pool = THEME_NAMES;
      } else if (head === 'osint') {
        pool = KIND_ORDER;
      } else if (head === 'phish') {
        pool = ['stop', 'status'];
      } else if (head === 'ad') {
        // Only `tools` — the rest of /ad's arguments are flags, and the
        // target is a domain the operator has to type anyway. Offering the
        // flags here would put a `--ack` in the popup that cannot be
        // accepted without the domain it is a confirmation of.
        pool = ['tools'];
      } else if (head === 'models') {
        // The argument exists for OpenRouter, UnoRouter and AntSeed, whose
        // catalogs are public and worth seeing before a key is set (AntSeed
        // has no key at all). Offering all of them rather than just those
        // three keeps the popup honest about what /models accepts.
        pool = [
          'logfare',
          'tokenjuice',
          'tokenharbour',
          'openrouter',
          'unorouter',
          'antseed',
          'aihubmix',
          'zai',
        ];
      } else if (head === 'model') {
        // Offer whatever the active upstream actually serves, so Logfare's
        // and TokenHarbour's fetched catalogs show up here too. `undefined`
        // from the pool means "no live catalog" — a cold cache or an
        // offline box. Falling back to the declared list keeps the popup
        // useful there; an empty popup would look like a bug.
        pool = ctx.modelPool?.(ctx.baseUrl ?? '') ?? KNOWN_MODELS;
      }
      items = pool.filter(a => a.startsWith(arg) && a !== arg).map(a => [a, '']);
    } else {
      items = SLASH_COMMANDS.filter(([c]) => c.startsWith(query));
    }
  } else {
    // Find an @token that the cursor is inside.
    let at = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i]!;
      if (ch === '@') {
        at = i;
        break;
      }
      if (ch === ' ' || ch === '\t') {
        break;
      }
    }
    if (at >= 0) {
      kind = 'file';
      const query = text.slice(at + 1);
      if (query && !/"'|;&/.test(query)) {
        const pool = filePool(ctx.workdir);
        const q = query.toLowerCase();
        items = pool
          .filter(f => f.toLowerCase().includes(q))
          .slice(0, MAX_FILES)
          .map(f => [f, '']);
      }
    }
  }

  return {kind, items: items.slice(0, MAX_ROWS)};
}

export function acceptCompletion(text: string, kind: string, value: string): string | undefined {
  /**
   * The new prompt text after accepting the selection (the port of the
   * widget's accept). `undefined` when there is nothing sensible to do.
   */
  if (kind === 'slash') {
    const trimmed = text.trim();
    if (trimmed.includes(' ') && (tokenize(trimmed)[0] ?? '').startsWith('/')) {
      const parts = tokenize(text);
      return `${parts[0]} ${value} `;
    }
    return value + ' ';
  }
  // file: replace the @token at/after the last '@'
  const at = text.lastIndexOf('@');
  if (at < 0) {
    return undefined;
  }
  return text.slice(0, at + 1) + value + ' ';
}

// === SECTION === the popup component ===

export interface CompletionPopupProps {
  palette: Palette;
  /** (value, description) rows, already sliced to MAX_ROWS. */
  items: [string, string][];
  /** The selection index — owned by the app, which sees the arrow keys. */
  index: number;
  /** Hidden when falsy (the Python widget toggled a `visible` CSS class). */
  visible?: boolean;
}

/**
 * Floating list of completions; does not take focus. Purely presentational —
 * the prompt keeps the cursor, the app drives `items`/`index` from
 * computeCompletions and its own key handling.
 */
export const CompletionPopup: FC<CompletionPopupProps> = ({palette, items, index, visible = true}) => {
  if (!visible || items.length === 0) {
    return null;
  }
  const rows: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const [value, desc] = items[i]!;
    const selected = i === index;
    const prefix = selected ? '▸ ' : '  ';
    if (selected) {
      let line = chalk.bold.hex(palette.accent)(prefix + value);
      if (desc) {
        line += chalk.hex(palette.primary)(`  ${desc}`);
      }
      rows.push(line);
    } else {
      let line = chalk.hex(palette.dim)(prefix) + chalk.hex(palette.primary)(value);
      if (desc) {
        line += chalk.hex(palette.dim)(`  ${desc}`);
      }
      rows.push(line);
    }
  }
  const hint = '  ↑↓ select · tab accept · esc close';
  return createElement(
    Box,
    {
      flexDirection: 'column',
      marginX: 1,
      borderStyle: 'round',
      borderColor: palette.dim,
      paddingX: 1,
    },
    ...rows.map((line, i) => createElement(Text, {key: i}, line)),
    createElement(Text, null, chalk.hex(palette.dim)(hint)),
  );
};
