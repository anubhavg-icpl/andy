/**
 * renderers.tsx — transcript panel and line builders (port of zimzilla/ui/renderers.py).
 *
 * What this module is: every fixed-shape transcript block — tool panels, diffs,
 * user prompts, errors, reasoning, team-worker lines, findings — built as pure
 * React nodes over Ink <Text>/<Box>. Rich `Panel` becomes the local <Panel>
 * below; each Rich `Text.append(text, style)` run becomes a sibling <Text>.
 *
 * Invariants:
 *  - Pure builders: no hooks, no state, no side effects — safe to call once per
 *    streaming delta and snapshot-testable with renderToString.
 *  - The severity colour lives HERE once (SEVERITY_PALETTE/severityStyle): the
 *    findings panel and the campaign rail share it, so a CRITICAL cannot read
 *    red in one place and amber in the other.
 *  - Rename rule applied: the banner wordmark is ANDY (was ZIMZILLA).
 */

import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { TOOL_ICONS } from '../theme.js';
import type { Palette } from '../theme.js';
import { bannerLines } from './banner.js';
import { markdownLine, markdownText } from './markdown.js';

// Ink layout rules this module relies on (verified against ink 8):
//  - Sibling <Text> children of a column <Box> each render ONE row; no
//    newline characters are needed or wanted between them (a trailing "\n"
//    adds a blank row, and a <Text>{"\n"}</Text> separator adds two).
//  - Nested <Text> runs inside one outer <Text> stay on that line — that is
//    how multi-run single lines are built.
//  - A blank line is a single-space row; an empty string collapses entirely.
function Blank(): ReactNode {
  return <Text>{' '}</Text>;
}

/** Python `str.splitlines()` semantics: splits on every line boundary, never
 * returns a trailing empty element, and `''` splits to `[]`. Every renderer
 * below iterates tool output / reasoning this way in the Python original, and
 * the difference is visible: `split('\n')` on output ending in a newline adds
 * a blank row the Python transcript never had. */
function pySplitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(/\r\n|\r|\n|\v|\f|\u2028|\u2029/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// === SECTION === language detection for syntax highlighting ===

// Ordered pairs, not a map: Python's dict preserved insertion order and the
// lookup walks it with `endswith`, so ".pyi" must win over ".py" etc.
const EXT_LANG: readonly (readonly [string, string])[] = [
  ['.py', 'python'], ['.pyi', 'python'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'tsx'], ['.jsx', 'jsx'],
  ['.json', 'json'], ['.yaml', 'yaml'], ['.yml', 'yaml'], ['.toml', 'toml'],
  ['.sh', 'bash'], ['.bash', 'bash'], ['.zsh', 'bash'], ['.fish', 'bash'],
  ['.c', 'c'], ['.h', 'c'], ['.cpp', 'cpp'], ['.hpp', 'cpp'], ['.cc', 'cpp'],
  ['.rs', 'rust'], ['.go', 'go'], ['.rb', 'ruby'], ['.php', 'php'],
  ['.html', 'html'], ['.htm', 'html'], ['.css', 'css'], ['.scss', 'scss'],
  ['.xml', 'xml'], ['.sql', 'sql'], ['.md', 'markdown'], ['.java', 'java'],
  ['.kt', 'kotlin'], ['.swift', 'swift'], ['.lua', 'lua'], ['.pl', 'perl'],
  ['.ini', 'ini'], ['.cfg', 'ini'], ['.conf', 'ini'], ['.dockerfile', 'docker'],
];

export function langForPath(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name === 'makefile' || name === 'rakefile') {
    return name === 'dockerfile' ? 'docker' : 'make';
  }
  for (const [ext, lang] of EXT_LANG) {
    if (name.endsWith(ext)) return lang;
  }
  return 'text';
}

export function detectLangForCommand(cmd: string): string {
  const stripped = cmd.trim();
  const first = stripped ? (stripped.split(/\s+/)[0] ?? '') : '';
  const mapping: Record<string, string> = {
    python: 'python', python3: 'python', pip: 'bash', pytest: 'python',
    node: 'javascript', npm: 'bash', npx: 'bash', yarn: 'bash',
    cargo: 'rust', go: 'go', git: 'bash', docker: 'bash',
    make: 'make', curl: 'bash', nmap: 'bash',
  };
  return mapping[first] ?? 'bash';
}

// === SECTION === syntax highlighting (Rich `Syntax` → lightweight tokenizer) ===
//
// The Python original built a pygments `Syntax` renderable with a monochrome
// green/amber style (`_mono_theme`). pygments is not in the dependency set, so
// this port re-implements the *style contract* with a small heuristic
// tokenizer: comments dim, keywords bold accent, strings amber, numbers
// accent, everything else primary. The pygments distinctions the mono theme
// made between builtins/functions/classes collapse into the keyword and plain
// buckets — the console still reads green-tinted, which was the point.

/** One styled run of code — the shared return shape of the tokenizer. */
interface Hue {
  text: string;
  color?: string;
  bold?: boolean;
}

const KW: Record<string, ReadonlySet<string>> = {
  python: new Set([
    'def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for',
    'while', 'try', 'except', 'finally', 'with', 'as', 'lambda', 'pass',
    'raise', 'yield', 'not', 'and', 'or', 'in', 'is', 'None', 'True', 'False',
    'async', 'await', 'assert', 'global', 'del',
  ]),
  javascript: new Set([
    'function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while',
    'class', 'import', 'export', 'from', 'async', 'await', 'new', 'true',
    'false', 'null', 'undefined', 'typeof', 'instanceof', 'switch', 'case',
    'break', 'continue', 'try', 'catch', 'finally', 'throw', 'extends',
    'interface', 'type', 'enum', 'public', 'private', 'readonly', 'implements',
  ]),
  bash: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
    'case', 'esac', 'function', 'local', 'export', 'return', 'in', 'select',
    'echo', 'cd', 'set', 'source', 'sudo',
  ]),
  rust: new Set([
    'fn', 'let', 'mut', 'pub', 'use', 'mod', 'struct', 'enum', 'impl',
    'trait', 'for', 'if', 'else', 'match', 'while', 'loop', 'return', 'Some',
    'None', 'Ok', 'Err', 'where', 'async', 'await', 'move', 'dyn', 'const',
    'static', 'type', 'unsafe', 'crate', 'self', 'super', 'true', 'false',
    'as', 'ref',
  ]),
  go: new Set([
    'func', 'package', 'import', 'var', 'const', 'type', 'struct',
    'interface', 'map', 'chan', 'go', 'defer', 'if', 'else', 'for', 'range',
    'switch', 'case', 'default', 'return', 'select', 'break', 'continue',
    'nil', 'true', 'false',
  ]),
  ruby: new Set([
    'def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'while',
    'until', 'do', 'then', 'return', 'yield', 'require', 'attr_accessor',
    'puts', 'nil', 'true', 'false', 'self', 'lambda', 'proc', 'case', 'when',
    'begin', 'rescue', 'ensure', 'raise', 'new',
  ]),
  make: new Set([
    'ifeq', 'ifneq', 'else', 'endif', 'include', 'export', 'all', 'clean',
    '.PHONY',
  ]),
  docker: new Set([
    'FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY',
    'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD',
    'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'AS',
  ]),
  sql: new Set([
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set',
    'delete', 'create', 'table', 'drop', 'alter', 'join', 'left', 'right',
    'inner', 'outer', 'on', 'group', 'by', 'order', 'limit', 'and', 'or',
    'not', 'null', 'primary', 'key', 'index', 'as', 'distinct', 'union',
    'having',
  ]),
};
KW.typescript = KW.javascript;
KW.tsx = KW.javascript;
KW.jsx = KW.javascript;
KW.mjs = KW.javascript;
KW.cjs = KW.javascript;

const CLIKE: ReadonlySet<string> = new Set([
  'if', 'else', 'for', 'while', 'return', 'switch', 'case', 'break',
  'continue', 'struct', 'class', 'enum', 'typedef', 'static', 'const', 'void',
  'int', 'char', 'long', 'short', 'unsigned', 'float', 'double', 'public',
  'private', 'protected', 'new', 'delete', 'sizeof', 'namespace', 'template',
  'using', 'virtual', 'override', 'null', 'nullptr', 'true', 'false',
]);

const HASH_COMMENT: readonly string[] = ['#'];
const SLASH_COMMENT: readonly string[] = ['//'];
const COMMENT_STARTERS: Record<string, readonly string[]> = {
  python: HASH_COMMENT, bash: HASH_COMMENT, yaml: HASH_COMMENT,
  toml: HASH_COMMENT, ini: HASH_COMMENT, docker: HASH_COMMENT,
  make: HASH_COMMENT, ruby: HASH_COMMENT, perl: HASH_COMMENT,
  javascript: SLASH_COMMENT, typescript: SLASH_COMMENT, tsx: SLASH_COMMENT,
  jsx: SLASH_COMMENT, c: SLASH_COMMENT, cpp: SLASH_COMMENT,
  rust: SLASH_COMMENT, go: SLASH_COMMENT, java: SLASH_COMMENT,
  kotlin: SLASH_COMMENT, swift: SLASH_COMMENT, scss: SLASH_COMMENT,
  css: SLASH_COMMENT, php: ['#', '//'],
  sql: ['--'],
};

function keywordsFor(lang: string): ReadonlySet<string> {
  return KW[lang] ?? CLIKE;
}

/** Split one line into [code, comment] — the comment runs to end of line. */
function splitComment(line: string, starters: readonly string[]): [string, string | null] {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i++; // skip the escaped char so an escaped quote cannot close the string
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    for (const starter of starters) {
      if (line.startsWith(starter, i)) {
        return [line.slice(0, i), line.slice(i)];
      }
    }
  }
  return [line, null];
}

function tokenizeCode(code: string, lang: string, palette: Palette): Hue[] {
  const keywords = keywordsFor(lang);
  const hues: Hue[] = [];
  let plain = '';
  const flushPlain = () => {
    if (plain) {
      hues.push({ text: plain, color: palette.primary });
      plain = '';
    }
  };
  let i = 0;
  while (i < code.length) {
    const ch = code[i]!;
    // String literal (single, double, or backtick), escapes honoured.
    if (ch === '"' || ch === "'" || ch === '`') {
      flushPlain();
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      hues.push({ text: code.slice(i, j), color: palette.amber });
      i = j;
      continue;
    }
    // Number.
    if (/\d/.test(ch)) {
      flushPlain();
      let j = i;
      while (j < code.length && /[\w.]/.test(code[j]!)) j++;
      hues.push({ text: code.slice(i, j), color: palette.accent });
      i = j;
      continue;
    }
    // Word (identifier or keyword).
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < code.length && /\w/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      if (keywords.has(word)) {
        flushPlain();
        hues.push({ text: word, color: palette.accent, bold: true });
      } else {
        plain += word;
      }
      i = j;
      continue;
    }
    plain += ch;
    i++;
  }
  flushPlain();
  return hues;
}

export function hackerSyntax(
  code: string,
  lang: string,
  palette: Palette,
  opts: { lineNumbers?: boolean } = {},
): ReactNode {
  const { lineNumbers = true } = opts;
  const starters = COMMENT_STARTERS[lang] ?? [];
  // Rich's Syntax walks `code.splitlines()` — a trailing newline must not add
  // a blank row the Python panel never had.
  const lines = pySplitLines(code);
  const gutter = String(lines.length).length;
  return (
    <>
      {lines.map((line, i) => {
        const [codePart, commentPart] = splitComment(line, starters);
        const hues = tokenizeCode(codePart, lang, palette);
        if (line === '') return <Blank key={i} />;
        return (
          // One outer <Text> per source line so gutter + token runs stay on
          // that line rather than stacking.
          <Text key={i}>
            {lineNumbers ? (
              <Text color={palette.dim}>{String(i + 1).padStart(gutter)} </Text>
            ) : null}
            {hues.map((hue, k) => (
              <Text key={k} color={hue.color} bold={hue.bold}>{hue.text}</Text>
            ))}
            {commentPart !== null ? (
              <Text color={palette.dim}>{commentPart}</Text>
            ) : null}
          </Text>
        );
      })}
    </>
  );
}

// === SECTION === shared panel chrome ===
//
// Rich `Panel` puts its title on the top border; Ink boxes cannot embed text
// in a border, so the title/subtitle ride as the first row inside the box.
// `padding=(0, 1)` becomes paddingX; the default Rich border (square) maps to
// Ink's "single" style.

interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  border?: string;
  children: ReactNode;
}

function Panel({ title, subtitle, border, children }: PanelProps): ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
      {title !== undefined || subtitle !== undefined ? (
        <Box justifyContent="space-between" flexShrink={0}>
          {title !== undefined ? <Text>{title}</Text> : <Text> </Text>}
          {subtitle !== undefined ? <Text>{subtitle}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}

/** `[ TOOL ]  tag  detail  status` — the panel title line.
 *
 * `tag` is the agent a hunt call belongs to; it sits directly after the tool
 * label so the attribution reads first and the command second.
 */
function toolHeader(
  name: string,
  args: Record<string, unknown>,
  palette: Palette,
  status = '',
  maxLen: number | null = 200,
  tag = '',
  tagColor = '',
): ReactNode {
  const icon = TOOL_ICONS[name] ?? '▸';
  const label = name.toUpperCase().replaceAll('_', ' ');
  return (
    <>
      <Text bold color={palette.primary}>[ {icon} {label} ]</Text>
      {tag ? <Text bold color={tagColor || palette.accent}>  {tag}</Text> : null}
      {(() => {
        const detail = detailGist(name, args, maxLen);
        return detail ? <Text color={palette.accent}>  {detail}</Text> : null;
      })()}
      {status ? <Text color={palette.dim}>  {status}</Text> : null}
    </>
  );
}

/** The one-line gist of a tool call.
 *
 * `maxLen` of null means no truncation at all — used by the hunt panels,
 * where a long pipeline has to be readable in full rather than cut off at the
 * point the interesting part starts.
 */
function detailGist(name: string, args: Record<string, unknown>, maxLen: number | null = 200): string {
  if (name === 'bash') {
    const cmd = typeof args['command'] === 'string' ? args['command'] : '';
    if (!cmd) {
      // No command to show — a bare "$" in a title is noise, and the hunt
      // panels put the command in the body and pass empty args here.
      return '';
    }
    if (maxLen === null || cmd.length <= maxLen) return `$ ${cmd}`;
    return `$ ${cmd.slice(0, maxLen - 1)}…`;
  }
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'list_dir') {
    return String(args['path'] ?? '');
  }
  if (name === 'glob') {
    return `${String(args['pattern'] ?? '')} @ ${String(args['path'] ?? '.')}`;
  }
  if (name === 'grep') {
    return `/${String(args['pattern'] ?? '')}/ @ ${String(args['path'] ?? '.')}`;
  }
  return '';
}

// === SECTION === tool panels ===

/** Panel shown when a tool is *requested*. */
export function toolCallPanel(
  name: string,
  args: Record<string, unknown>,
  palette: Palette,
): ReactNode {
  const detail = detailGist(name, args);
  const color = name === 'bash' ? palette.primary : palette.accent;
  return (
    <Panel title={toolHeader(name, args, palette)} border={palette.dim}>
      <Text color={color}>{detail}</Text>
    </Panel>
  );
}

/** The body of a finished tool call: bash gets shell highlighting, a read
 * gets its file's language, everything else gets the diff/error heuristic. */
function toolBody(
  name: string,
  args: Record<string, unknown>,
  output: string,
  palette: Palette,
): ReactNode {
  if (name === 'bash') {
    const lang = detectLangForCommand(typeof args['command'] === 'string' ? args['command'] : '');
    return hackerSyntax(output, lang, palette, { lineNumbers: false });
  }
  if (name === 'read_file') {
    const lang = langForPath(String(args['path'] ?? ''));
    return hackerSyntax(output, lang, palette, { lineNumbers: false});
  }
  return renderOutputText(output, palette);
}

/** The right-hand status chip on a bash panel. */
function exitBadge(meta: Record<string, unknown>, palette: Palette): ReactNode {
  const exitCode = meta['exit'];
  if (meta['timeout']) {
    return <Text bold color="white" backgroundColor={palette.amber}> TIMEOUT </Text>;
  }
  if (exitCode === undefined || exitCode === null) {
    return <Text bold color="white" backgroundColor={palette.dim}> EXEC </Text>;
  }
  if (exitCode === 0) {
    return <Text bold color="black" backgroundColor={palette.accent}> EXIT 0 </Text>;
  }
  return <Text bold color="white" backgroundColor={palette.red}> EXIT {String(exitCode)} </Text>;
}

/** Panel shown when a tool *finishes*, with syntax-highlighted output. */
export function toolResultPanel(
  name: string,
  args: Record<string, unknown>,
  output: string,
  palette: Palette,
  isError = false,
  meta: Record<string, unknown> | null = null,
): ReactNode {
  const m = meta ?? {};
  const border = isError ? palette.red : palette.dim;
  const body = toolBody(name, args, output, palette);

  if (name === 'bash') {
    return (
      <Panel
        title={toolHeader(name, args, palette)}
        subtitle={exitBadge(m, palette)}
        border={border}
      >
        {body}
      </Panel>
    );
  }
  return <Panel title={toolHeader(name, args, palette)} border={border}>{body}</Panel>;
}

/** One finished tool call from a hunt worker, rendered in full.
 *
 * Same treatment a normal turn gives a call — the operator's real view of the
 * engagement — with two differences that matter when ten agents run at once:
 *
 * - the command is **never truncated**. A recon or exploitation one-liner is
 *   routinely 200+ characters and the part that says what is being tested is
 *   at the end of it, not the beginning. It goes in the *body*, not the
 *   title: a panel title is one line and gets clipped at the border, so a
 *   long command there is exactly the truncation this exists to remove.
 * - the agent's name is in the title. Interleaved, unattributed panels would
 *   be unreadable, and attributing them is what lets the operator follow one
 *   thread through the noise.
 */
/** Options bag for a hunt worker panel — the app lane consumes this as
 * `huntToolPanel(name, args, output, palette, {agent, color, isError, meta})`,
 * which is why the trailing Python positionals became one object. */
export interface HuntToolPanelOpts {
  /** The agent the call belongs to; rendered as the tag in the title. */
  agent?: string;
  /** The agent's roster colour for the tag. */
  color?: string;
  isError?: boolean;
  meta?: Record<string, unknown> | null;
}

export function huntToolPanel(
  name: string,
  args: Record<string, unknown>,
  output: string,
  palette: Palette,
  opts: HuntToolPanelOpts = {},
): ReactNode {
  const agent = opts.agent ?? '';
  const color = opts.color ?? '';
  const m = opts.meta ?? {};
  const border = opts.isError ? palette.red : palette.dim;

  if (name === 'bash') {
    // The full command leads, then a blank line, then the output — so the
    // two are never mistaken for each other. A fragment rather than one Text:
    // the output half is highlighted code, which cannot be appended to.
    const cmd = detailGist('bash', args, null);
    return (
      <Panel
        title={toolHeader(name, {}, palette, '', 200, agent, color)}
        subtitle={exitBadge(m, palette)}
        border={border}
      >
        <Text color={palette.primary}>{cmd}</Text>
        <Text> </Text>
        {toolBody(name, args, output, palette)}
      </Panel>
    );
  }

  return (
    <Panel
      title={toolHeader(name, args, palette, '', 200, agent, color)}
      border={border}
    >
      {toolBody(name, args, output, palette)}
    </Panel>
  );
}

// Braille spinner, advanced one frame per rail tick (~0.25s).
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** The *live* card for a tool that is still running.
 *
 * Same shape as `toolCallPanel`, but the border is lit and the title carries
 * a spinner and a running clock, so a slow command is visibly in flight
 * rather than indistinguishable from a hung one.
 */
export function toolRunningPanel(
  name: string,
  args: Record<string, unknown>,
  palette: Palette,
  elapsed = 0.0,
  frame = 0,
  targets: readonly string[] | null = null,
): ReactNode {
  const detail = detailGist(name, args);
  const body = (
    <>
      <Text color={name === 'bash' ? palette.primary : palette.accent}>{detail}</Text>
      {targets && targets.length > 0 ? (
        /* The hosts the command names, read straight off the command text.
           Same best-effort scan the scope guard uses — shown, not enforced,
           because the gate is unreachable in the shipped modes. */
        <Text>
          <Text color={palette.dim}>⌖ </Text>
          <Text color={palette.amber}>{targets.join(', ')}</Text>
        </Text>
      ) : null}
    </>
  );
  const spin = SPINNER[frame % SPINNER.length]!;
  const status = `${spin} ${elapsed.toFixed(1)}s`;
  return (
    <Panel
      title={toolHeader(name, args, palette, status)}
      border={palette.accent}
    >
      {body}
    </Panel>
  );
}

// === SECTION === markers, output text, diffs, prompt and error blocks ===

/** The spine joint that opens a turn in the transcript. */
export function turnMarker(turn: number, palette: Palette, width = 58): ReactNode {
  const stamp = new Date().toTimeString().slice(0, 5); // "HH:MM"
  const head = `├─ turn ${turn} ─ ${stamp} `;
  // One outer <Text> so the two runs share a line: sibling <Text> in a
  // column context each get their own row, which would break the rule here.
  return (
    <Text>
      <Text bold color={palette.accent}>{head}</Text>
      <Text color={palette.dim}>{'─'.repeat(Math.max(0, width - head.length))}</Text>
    </Text>
  );
}

/** Render plain tool output with heuristic red/green for diffs and errors. */
export function renderOutputText(output: string, palette: Palette): ReactNode {
  return (
    <>
      {pySplitLines(output).map((line, i) => {
        if (line === '') return <Blank key={i} />;
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
          return <Text key={i} bold color={palette.accent}>{line}</Text>;
        }
        if (line.startsWith('+')) {
          return <Text key={i} color={palette.accent}>{line}</Text>;
        }
        if (line.startsWith('-')) {
          return <Text key={i} color={palette.red}>{line}</Text>;
        }
        if (/\b(error|Error|ERROR|failed|FAILED|Traceback)\b/.test(line)) {
          return <Text key={i} color={palette.red}>{line}</Text>;
        }
        if (/\b(ok|OK|passed|PASSED|success|done)\b/.test(line)) {
          return <Text key={i} color={palette.accent}>{line}</Text>;
        }
        return <Text key={i} color={palette.primary}>{line}</Text>;
      })}
    </>
  );
}

/** Render a unified diff with green adds / red removes. */
export function diffPanel(
  path: string,
  diff: string,
  palette: Palette,
  verb = 'EDIT',
): ReactNode {
  let added = 0;
  let removed = 0;
  const body = (
    <>
      {pySplitLines(diff).map((line, i) => {
        if (line === '') return <Blank key={i} />;
        if (line.startsWith('+++') || line.startsWith('---')) {
          return <Text key={i} bold color={palette.primary}>{line}</Text>;
        }
        if (line.startsWith('@@')) {
          return <Text key={i} bold color={palette.accent}>{line}</Text>;
        }
        if (line.startsWith('+')) {
          added += 1;
          return <Text key={i} color={palette.accent}>{line}</Text>;
        }
        if (line.startsWith('-')) {
          removed += 1;
          return <Text key={i} color={palette.red}>{line}</Text>;
        }
        return <Text key={i} color={palette.dim}>{line}</Text>;
      })}
    </>
  );

  return (
    <Panel
      title={
        <>
          <Text bold color={palette.primary}>[ ± {verb} ]</Text>
          <Text color={palette.accent}>  {path}</Text>
        </>
      }
      subtitle={
        <>
          <Text color={palette.accent}>+{added} </Text>
          <Text color={palette.red}>-{removed}</Text>
        </>
      }
      border={palette.dim}
    >
      {body}
    </Panel>
  );
}

export function userPromptBlock(text: string, palette: Palette): ReactNode {
  return (
    <Box borderStyle="round" borderColor={palette.primary} paddingX={1}>
      <Text bold color={palette.accent}>❯ </Text>
      <Text bold color={palette.primary}>{text}</Text>
    </Box>
  );
}

export function errorBlock(message: string, palette: Palette): ReactNode {
  return (
    <Panel
      title={<Text bold color={palette.red}>[ ✖ ERROR ]</Text>}
      border={palette.red}
    >
      <Text color={palette.red}>{message}</Text>
    </Panel>
  );
}

export function warningBlock(message: string, palette: Palette): ReactNode {
  return (
    <Panel
      title={<Text bold color={palette.amber}>[ ⚠ WARNING ]</Text>}
      border={palette.amber}
    >
      <Text color={palette.amber}>{message}</Text>
    </Panel>
  );
}

export function blockedBlock(message: string, palette: Palette): ReactNode {
  return (
    <Panel
      title={<Text bold color="white" backgroundColor={palette.red}>[ ⛔ BLOCKED ]</Text>}
      border={palette.red}
    >
      <Text bold color={palette.red}>SCOPE GUARD — HARD BLOCK</Text>
      <Text color={palette.red}>{message}</Text>
    </Panel>
  );
}

// === SECTION === banner ===

/** The ASCII banner; `revealed` limits how many columns are lit. */
export function bannerRenderable(palette: Palette, revealed: number | null = null): ReactNode {
  const lines = bannerLines();
  return (
    <>
      {lines.map((line, rowI) => {
        const cut = revealed === null ? line.length : Math.min(line.length, revealed);
        return (
          <Text key={rowI}>
            <Text bold color={palette.primary}>{line.slice(0, cut)}</Text>
            {cut < line.length ? <Text>{' '.repeat(line.length - cut)}</Text> : null}
          </Text>
        );
      })}
    </>
  );
}

// === SECTION === model reasoning ===
//
// What the model is thinking, when the endpoint forwards it. Kept deliberately
// quieter than the answer: dim and italic, so a transcript where the model
// reasoned at length still reads as one answer with commentary, not as two
// competing replies. Nothing here is a finding or a tool result — it is the
// model talking to itself, and the styling says so.
//
// THINK_LIVE_LINES is the live slot's window. The live view shows the *tail*
// of the reasoning rather than the head, because the interesting part is what
// it is thinking *now* — the same reason a log tail is more useful than a log
// head. The committed block below keeps every line, so nothing is lost by the
// window.

// Lines of reasoning the live (still-streaming) slot shows.
const THINK_LIVE_LINES = 14;

/** The cheap, per-delta form of in-flight reasoning: the last few lines.
 *
 * Called once per `reasoning_delta`, so it does no markdown parse — a
 * reasoning stream is prose full of stray symbols (`**`, `\(`, `->`) that
 * would only be misread as markup, and the cost of parsing it several times
 * a second buys nothing.
 */
export function reasoningLive(text: string, palette: Palette, cursor = ''): ReactNode {
  // Python: `(text or "").splitlines() or [""]` — an empty stream still shows
  // one (cursor-carrying) line rather than nothing at all.
  const all = pySplitLines(text || '');
  const lines = all.length > 0 ? all : [''];
  const tail = lines.slice(-THINK_LIVE_LINES);
  const elided = lines.length - tail.length;
  return (
    <>
      {/* Header runs share one outer <Text> so they stay on one line. */}
      <Text>
        <Text bold color={palette.accent}>✻ </Text>
        <Text bold color={palette.accent}>thinking</Text>
        {elided > 0 ? <Text color={palette.dim}>  (+{elided} earlier)</Text> : null}
      </Text>
      {tail.map((line, i) => {
        const isLast = i === tail.length - 1;
        if (line === '' && !(isLast && cursor)) return <Blank key={i} />;
        return (
          <Text key={i}>
            <Text italic color={palette.dim}>{line}</Text>
            {isLast && cursor ? <Text bold color={palette.accent}>{cursor}</Text> : null}
          </Text>
        );
      })}
    </>
  );
}

/** The committed form: the model's reasoning, whole, in the transcript.
 *
 * Every line is kept. The live slot above shows only a window so it cannot
 * push the answer off screen mid-stream; this is where the rest of it lives,
 * and the transcript scrolls, so the operator can read what was elided.
 */
export function reasoningPanel(text: string, palette: Palette): ReactNode {
  const lines = pySplitLines(text || '');
  return (
    <Panel
      title={<Text bold color={palette.accent}>[ ✻ THINKING ]</Text>}
      subtitle={<Text color={palette.dim}>{lines.length} lines</Text>}
      border={palette.dim}
    >
      {lines.map((line, i) =>
        line === '' ? <Blank key={i} /> : (
          <Text key={i} italic color={palette.dim}>{line}</Text>
        ),
      )}
    </Panel>
  );
}

/** Assistant prose, markdown resolved.
 *
 * This used to handle one construct — inline backticks — and hand everything
 * else through as its own source text, so a model's `**Asset:**` and
 * `- item` reached the operator with the markup still on. It now delegates to
 * `markdownText`, which parses with CommonMark rather than a regex.
 */
export function agentText(text: string, palette: Palette): ReactNode {
  return markdownText(text, palette);
}

// === SECTION === team workers ===
//
// `/team` interleaves several workers into one transcript, so every line they
// write has to say who wrote it. The label carries the worker's own colour and
// the body keeps the normal prose styling, so a worker's text reads exactly
// like the main agent's — it is only the prefix that differs.

/** The `[name]` tag that opens every worker line. */
export function agentLabel(name: string, color: string, palette: Palette, width = 14): ReactNode {
  const pad = Math.max(1, width - name.length);
  return (
    <Text>
      <Text bold color={color}>[{name}]</Text>
      <Text color={palette.dim}>{' '.repeat(pad)}</Text>
    </Text>
  );
}

/** A labelled block of worker prose, one per flush.
 *
 * Body text goes through `markdownLine` so backticked code reads the same as
 * it does anywhere else in the transcript — and, unlike `agentText`,
 * flattened onto one line. The `[name]` tag labels the line that follows it,
 * so a worker's markdown must not break that line in two.
 */
export function agentLine(
  name: string,
  text: string,
  color: string,
  palette: Palette,
  width = 14,
): ReactNode {
  return (
    <Text>
      {agentLabel(name, color, palette, width)}
      {markdownLine(text, palette)}
    </Text>
  );
}

/** A labelled one-liner for a worker's tool call or result.
 *
 * `opts.ok` colours the verb: omitted/null keeps it neutral (a call), true
 * green, false red. Used instead of the live tool card, which has only one
 * slot and would be overwritten several times a second by concurrent workers.
 * The ok flag rides in an options bag (not positionally) because the app lane
 * consumes it as `agentEventLine(name, color, verb, detail, palette, {ok})`.
 */
export function agentEventLine(
  name: string,
  color: string,
  verb: string,
  detail: string,
  palette: Palette,
  opts: { ok?: boolean | null; width?: number } = {},
): ReactNode {
  const ok = opts.ok ?? null;
  const width = opts.width ?? 14;
  let vstyle: { color: string; bold?: boolean };
  if (ok === null) {
    vstyle = { color, bold: true };
  } else if (ok) {
    vstyle = { color: palette.accent, bold: true };
  } else {
    vstyle = { color: palette.red, bold: true };
  }
  return (
    <Text>
      {agentLabel(name, color, palette, width)}
      <Text bold color={vstyle.color}>{verb.padEnd(9)}</Text>
      <Text color={ok === null ? palette.dim : palette.primary}>{detail}</Text>
    </Text>
  );
}

// === SECTION === hunt findings ===
//
// The findings panel and the campaign rail's summary both show the same
// thing, so the severity colour lives here once. Two copies of this map is
// how a CRITICAL ends up red in the panel and amber in the rail.

/** Which palette attribute carries one severity. `info` and anything
 * unrecognised fall through to `dim` in severityStyle. */
export type SeverityPaletteKey = 'red' | 'amber' | 'primary' | 'dim';

export const SEVERITY_PALETTE: Record<string, SeverityPaletteKey> = {
  critical: 'red',
  high: 'amber',
  medium: 'primary',
  low: 'primary',
  info: 'dim',
};

/** The display order, worst first. */
export const SEVERITY_ORDER: readonly string[] = ['critical', 'high', 'medium', 'low', 'info'];

/** The Ink style for one severity, from the palette.
 *
 * Unrecognised severities read as `info` rather than throwing: a model that
 * invents a sixth word should produce a dim line, not break the pane.
 */
export interface SeverityStyle {
  color: string;
  bold?: boolean;
}

export function severityStyle(
  severity: string,
  palette: Palette,
  opts: { bold?: boolean } = {},
): SeverityStyle {
  const attr = SEVERITY_PALETTE[String(severity || '').trim().toLowerCase()] ?? 'dim';
  const colour = (palette[attr] as string | undefined) ?? palette.dim;
  return opts.bold ? { color: colour, bold: true } : { color: colour };
}

/** A finding dict as the hunt events carry it — the panel and the transcript
 * both build from that, so neither needs the Finding dataclass. Fields are
 * `unknown` (the Python took a plain dict); every reader coerces with
 * String() so a hunt event's untyped payload assigns without a cast. */
export interface FindingLike {
  severity?: unknown;
  title?: unknown;
  asset?: unknown;
  wave?: unknown;
  evidence?: unknown;
  summary?: unknown;
  agent?: unknown;
  [key: string]: unknown;
}

/** One finding as a single line: severity, title, asset, wave. */
export function findingLine(f: FindingLike, palette: Palette, opts: { width?: number } = {}): ReactNode {
  const { width = 9 } = opts;
  const sev = String(f.severity || 'info').trim().toLowerCase();
  const style = severityStyle(sev, palette, { bold: true });
  const asset = String(f.asset || '').trim();
  return (
    <Text>
      <Text bold={style.bold} color={style.color}>{sev.toUpperCase().padEnd(width)}</Text>
      <Text bold color={palette.primary}>{String(f.title || '(untitled)')}</Text>
      {asset ? (
        <>
          <Text color={palette.dim}>  ·  </Text>
          <Text color={palette.primary}>{asset}</Text>
        </>
      ) : null}
      {f.wave ? <Text color={palette.dim}>{`  wave ${String(f.wave)}`}</Text> : null}
    </Text>
  );
}

/** The evidence and summary under a finding line, indented and dim.
 *
 * Evidence leads: it is the part that makes a finding a finding rather than
 * an opinion, and it is what an operator copies into a report.
 */
export function findingDetail(f: FindingLike, palette: Palette, opts: { indent?: number } = {}): ReactNode {
  const { indent = 2 } = opts;
  const pad = ' '.repeat(indent);
  const evidence = String(f.evidence || '').trim();
  const summary = String(f.summary || '').trim();
  const agent = String(f.agent || '').trim();
  return (
    <>
      {evidence ? (
        <Text>
          <Text color={palette.dim}>{pad}evidence  </Text>
          <Text color={palette.primary}>{evidence}</Text>
        </Text>
      ) : null}
      {summary ? (
        <Text>
          <Text color={palette.dim}>{pad}summary   </Text>
          <Text color={palette.dim}>{summary}</Text>
        </Text>
      ) : null}
      {agent ? (
        <Text>
          <Text color={palette.dim}>{pad}found by  </Text>
          <Text color={palette.dim}>{agent}</Text>
        </Text>
      ) : null}
    </>
  );
}
