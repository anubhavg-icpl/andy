/**
 * tools.ts — the tool layer: JSON schemas, permission previews and execution.
 *
 * What this module is: everything the model can call. Reads are auto-approved;
 * writes and bash go through the permission gate in the UI; the network tools
 * are bounded by the scope guard instead, so an out-of-scope host is refused no
 * matter which mode is armed. `report_finding` is hunt-only, `hunt_findings`
 * main-session-only, the `ldxhub_*` block is withheld until a key exists.
 *
 * Invariants:
 *  - `execute()` NEVER throws for tool-level failures — errors ride
 *    `ToolResult.isError` + `meta` (the bash exit code lives in `meta`).
 *  - Every path argument passes through the sandbox (`resolveInJail` /
 *    `containedInJail` / `safeGlobPattern`) — no tool reads or writes outside
 *    the jail unless `cfg.unsafe` is set.
 *  - Tool inputs are never schema-validated; coerce defensively (`_text`).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { SandboxError, containedInJail, displayPath, resolveInJail, safeGlobPattern } from './sandbox.js';
import { WebError, fetch as webFetch, search as webSearch } from './websearch.js';
import { andyHome } from './shared.js';
import type { Preview, ToolResult, ToolSchema } from './shared.js';

// === SECTION === JSON schemas advertised to the model ===

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'bash',
    description:
      'Run a shell command in the working directory. Returns combined ' +
      'stdout/stderr and the exit code. Use for builds, tests and git. ' +
      'Commands touching a host listed in out-of-scope.yaml are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeout: {
          type: 'integer',
          description: 'Optional timeout in seconds (default 120).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file. Optionally a line range.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        offset: { type: 'integer', description: '1-based first line.' },
        limit: { type: 'integer', description: 'Max lines to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must occur exactly ' +
      'once unless replace_all is true.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: "Find files by glob pattern (e.g. '**/*.py').",
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern.' },
        path: { type: 'string', description: "Directory to search (default '.')." },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex to search for.' },
        path: { type: 'string', description: "File or directory (default '.')." },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "Directory (default '.')." },
      },
      required: [],
    },
  },
  {
    // Named search_web, NOT web_search: LiteLLM special-cases the literal
    // name "web_search" and rewrites it into OpenAI's built-in
    // web_search_preview tool, which the upstream adapter then rejects with
    // a 400 ("Unsupported Responses tools type"). Any other name is passed
    // through as an ordinary function tool. Do not rename this back.
    name: 'search_web',
    description:
      'Search the web and return titles, URLs and snippets. Use it to ' +
      'look up anything not in this repository — library APIs, error ' +
      'messages, current versions, unfamiliar terms. Follow up with ' +
      'web_fetch on a result to read the page in full.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: {
          type: 'integer',
          description: 'How many results to return (default 5).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text. Use it to read a page ' +
      'found with search_web, or any documentation URL. Hosts listed in ' +
      'out-of-scope.yaml are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to read.' },
        max_chars: {
          type: 'integer',
          description: 'Truncate the text at this many characters.',
        },
      },
      required: ['url'],
    },
  },
  {
    // The one tool that exists only during a hunt. A wave agent confirms a
    // bug in the middle of its turn and, until this existed, had no way to
    // say so: findings were read out of the agent's FINAL text by
    // hunt.parse_findings after the whole wave had finished, so a confirmed
    // SQLi at minute two stayed invisible until minute twenty. Calling this
    // publishes the finding the instant it is confirmed, which is what lets
    // the live tracker show it while the hunt is still running.
    //
    // Withheld from an ordinary session by Agent.can_report — see the note
    // there for why it must not be advertised outside a hunt.
    name: 'report_finding',
    description:
      'Report a confirmed vulnerability to the engagement tracker, the ' +
      'moment you confirm it. Use this DURING your work, not only at the ' +
      'end: it is how the operator\'s live tracker learns what you found ' +
      'while the wave is still running. Call it once per distinct bug, as ' +
      'soon as you have the evidence — do not wait until you are done, ' +
      'and do not batch them up for your final message. Reporting a bug ' +
      'you cannot evidence is worse than not reporting it.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: "Short name for the bug, e.g. 'SQL injection in ?id'.",
        },
        severity: {
          type: 'string',
          // Spelled out rather than imported from hunt.VALID_SEVERITIES:
          // hunt imports agent, which imports this module, so reaching back
          // the other way would close an import cycle. The two are pinned
          // together by a test instead.
          enum: ['critical', 'high', 'medium', 'low', 'info'],
          description:
            "Judge it honestly: a theoretical weakness with no demonstrated impact is 'low', not 'critical'.",
        },
        asset: { type: 'string', description: 'The host, URL or path affected.' },
        summary: {
          type: 'string',
          description: 'What the bug is, in two or three sentences.',
        },
        evidence: {
          type: 'string',
          description:
            'The exact request, output or file:line that proves it. Required — a finding with no evidence is a guess.',
        },
        remediation: { type: 'string', description: 'How to fix it.' },
      },
      required: ['title', 'severity', 'evidence'],
    },
  },
  {
    // The read side of a campaign, for the MAIN agent. A hunt runs on its
    // own Agent instances and the main agent sees none of it, so when the
    // operator stopped a wave and said "save the findings", the main agent
    // had no path to the campaign directory and answered "nothing found" —
    // while recon had already written a high-severity finding to disk. This
    // is that path: a read-only view of what the campaign actually
    // recorded, so the command resolves against real artefacts.
    //
    // Withheld from a hunt agent by Agent.can_hunt_read: a wave agent
    // reading the whole campaign would be handed every other wave's work,
    // which is the opposite of the independence the briefs are built on.
    name: 'hunt_findings',
    description:
      'Read what a /bug-hunt campaign actually recorded on disk: the ' +
      'findings it confirmed, the recon notes it wrote, and the plans for ' +
      'each wave. Use this when the operator refers to a hunt\'s findings — ' +
      "'save the findings', 'summarize the campaign', 'what did we find on " +
      "<host>'. With no campaign named it reads the most recent one. Always " +
      'check this before saying nothing was found.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description:
            'Host or domain the campaign ran against. Omit for the most recent campaign.',
        },
        include: {
          type: 'string',
          enum: ['findings', 'recon', 'plans', 'all'],
          description:
            "Which part of the campaign to read. 'findings' (default) lists what was " +
            "confirmed; 'recon' is the mapping notes; 'plans' is what each wave was " +
            "aimed at; 'all' is everything.",
        },
      },
    },
  },
  // LDXHub document jobs (see ldxhub.ts). LDXHub has no Messages endpoint, so
  // its six services are tools rather than a chat source, and the whole block
  // is withheld until a key exists — Agent.toolSchemas unions LDXHUB_TOOLS
  // into the deny set when hasKey() is false.
  {
    name: 'ldxhub_structflow',
    description:
      'Generate or rewrite a document with LDXHub StructFlow (remote, paid per job). ' +
      'Give a prompt for free-form generation, or a file_path to transform an ' +
      'existing document — exactly one of the two. The result comes back as JSON; ' +
      'pass dest to also save any file output.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to generate, when not transforming a file.' },
        file_path: { type: 'string', description: 'Existing document to transform, when not generating.' },
        model: { type: 'string', description: 'StructFlow model id. Omit for the profile default.' },
        system_prompt: { type: 'string', description: 'Instructions for the model. Optional.' },
        example_output: {
          type: 'object',
          description: 'JSON object shaped like the desired result. Optional.',
        },
        dest: { type: 'string', description: 'Local path to also save any file output. Optional.' },
      },
    },
  },
  {
    name: 'ldxhub_analyze',
    description:
      'Structured analysis of a document or image via LDXHub AnalyzeDoc (remote, paid per ' +
      'job). The JSON shape is driven by prompt and example_output. Always returns JSON inline.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Document or image to analyze.' },
        prompt: { type: 'string', description: 'What to extract or how to structure the analysis.' },
        model: { type: 'string', description: 'AnalyzeDoc model id. Omit for the profile default.' },
        example_output: {
          type: 'object',
          description: 'JSON object shaped like the desired result. Optional.',
        },
        output_format: { type: 'string', description: 'Output encoding. Optional; defaults to json.' },
      },
      required: ['file_path', 'prompt'],
    },
  },
  {
    name: 'ldxhub_extract',
    description:
      'Extract raw text from a document via LDXHub ExtractDoc (remote, paid per job). ' +
      'Returns the extracted text inline; pass dest to also save it.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Document to extract text from.' },
        output_format: {
          type: 'string',
          enum: ['text', 'jsonl'],
          description: 'Extraction encoding. Defaults to text.',
        },
        engine: { type: 'string', description: 'ExtractDoc engine id. Omit for the profile default.' },
        dest: { type: 'string', description: 'Local path to also save the output. Optional.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'ldxhub_convert',
    description:
      "Convert a document to another format via LDXHub (remote, paid per job). mode='renderocr' " +
      "OCRs scans and images; mode='castdoc' converts PDFs. The converted file is written to dest.",
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Source document.' },
        mode: {
          type: 'string',
          enum: ['renderocr', 'castdoc'],
          description: 'OCR (renderocr) or PDF conversion (castdoc).',
        },
        dest: { type: 'string', description: 'Local path to write the converted file.' },
        output_format: {
          type: 'string',
          enum: ['docx', 'xlsx', 'pptx'],
          description: 'Target format. Defaults to docx.',
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: "OCR language codes (renderocr only). Defaults to ['en'].",
        },
        engine: { type: 'string', description: 'Engine id. Omit for the profile default.' },
      },
      required: ['file_path', 'mode', 'dest'],
    },
  },
  {
    name: 'ldxhub_refine',
    description:
      'Revise an XLIFF translation file via LDXHub RefineLoop (remote, paid per job). ' +
      'file_path must be an existing XLIFF file. Result comes back inline unless dest is given.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'XLIFF file to refine.' },
        model: { type: 'string', description: 'RefineLoop model id. Omit for the profile default.' },
        dest: { type: 'string', description: 'Local path to save the refined file. Optional.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'ldxhub_list',
    description:
      'List LDXHub models and engines, live from the gateway. Pass service to show only ' +
      "one; omit to show all six. '*' marks the profile default for that service.",
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['structflow', 'analyzedoc', 'refineloop', 'renderocr', 'castdoc', 'extractdoc'],
          description: 'Which service to list. Omit for all.',
        },
      },
    },
  },
];

// Pane messaging. Advertised only to a pane-session agent (Agent.can_peer),
// which is what lets the Andy panes talk to each other. See panes.ts.
export const PEER_SCHEMAS: ToolSchema[] = [
  {
    name: 'agent_peers',
    description:
      'List the other Andy agents running in your tmux panes. Use it to find out who you can message.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_send',
    description:
      'Send a message to another Andy agent in a pane. The recipient sees it at the start of ' +
      'its next turn. Use agent_peers for names. Messages are not replies: write what they need to act on.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Name of the recipient agent.' },
        body: { type: 'string', description: 'The message.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'agent_inbox',
    description:
      'Read and clear your unread messages from other agents. Messages also arrive ' +
      'automatically at the start of a turn; use this to check mid-turn.',
    input_schema: { type: 'object', properties: {} },
  },
];

export const TOOL_NAMES: string[] = TOOL_SCHEMAS.map((t) => t.name);

// Tools that require an explicit user confirmation.
export const GATED_TOOLS = new Set<string>(['bash', 'write_file', 'edit_file']);

// The tools a hunt agent may call but an ordinary session may not. See
// Agent.can_report: advertising report_finding to a session that has no
// tracker to report into would let a model call a tool whose result goes
// nowhere, which reads as the harness losing the finding.
export const HUNT_ONLY_TOOLS = new Set<string>(['report_finding']);

// The reverse: the tools only an ordinary session may call. hunt_findings
// reads the whole campaign, which a wave agent must not see — its brief is
// deliberately blind to the other agents' work. See Agent.can_hunt_read.
export const MAIN_ONLY_TOOLS = new Set<string>(['hunt_findings']);

// Tools that exist only for a pane-session agent. Withheld from /team workers
// and hunt agents, which are deliberately isolated from one another.
export const PEER_TOOLS = new Set<string>(['agent_peers', 'agent_send', 'agent_inbox']);

// The LDXHub tools that run a paid job. Withheld until ldxhub.hasKey()
// — see Agent.toolSchemas. They are jobs against a remote gateway, not a
// chat source; see ldxhub.ts for why they are not in sources.ts.
export const LDXHUB_TOOLS = new Set<string>([
  'ldxhub_structflow',
  'ldxhub_analyze',
  'ldxhub_extract',
  'ldxhub_convert',
  'ldxhub_refine',
]);

// ldxhub_list is deliberately *not* in the gated set. The catalogs are
// public and unauthenticated, so listing them works before a key exists —
// which is exactly when knowing what is on offer is most useful. Gating it
// would also make Agent.denied() claim it needs a key, which would be untrue.

const _SKIP_DIRS = new Set([
  '.git', '__pycache__', 'node_modules', '.venv', 'venv', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', 'dist', 'build', '.idea', '.tox',
]);

/** Error thrown by tool internals that execute() turns into an error result. */
export class ToolError extends Error {}

export function needsPermission(name: string): boolean {
  return GATED_TOOLS.has(name);
}

// === SECTION === small coercion / formatting helpers ===

/** Coerce a tool argument to text. Inputs come straight from the model and
 *  are never schema-validated, so a field the schema declares as a string can
 *  arrive as an int, list or null. Coercing here keeps the builders from raising. */
function _text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Python-style repr for a short string ('single quotes'), used in labels. */
function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** POSIX shell-quote (Python shlex.quote), for the unknown-tool label. */
function shlexQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

function _truncate(text: string, limit: number): string {
  // Fast path: JS string length is an upper bound on the codepoint count, so
  // if it fits, the Python len()-based check would not have truncated either.
  if (text.length <= limit) return text;
  const cps = Array.from(text);
  if (cps.length <= limit) return text;
  const head = cps.slice(0, Math.floor(limit / 2)).join('');
  // Python's tail is text[-limit // 2:], and floor division of the NEGATIVE
  // limit rounds down — so an odd limit takes ceil(limit/2) chars from the end.
  const tailCount = Math.ceil(limit / 2);
  const tail = cps.slice(cps.length - tailCount).join('');
  return `${head}\n\n... [truncated ${cps.length - limit} chars] ...\n\n${tail}`;
}

function _human(n: number): string {
  let v = n;
  for (const unit of ['B', 'K', 'M', 'G']) {
    if (v < 1024) return `${v}${unit}`;
    v = Math.floor(v / 1024);
  }
  return `${v}T`;
}

/** Strict-ish int coercion mirroring Python int(): garbage throws, and
 *  execute() turns the throw into an error ToolResult (Python: ValueError). */
function asInt(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${what} must be an integer`);
  }
  return n;
}

/** Python truthiness for JSON tool args: `args.get(k) or default` treats
 *  absent, false, 0 and '' all as "use the default" (None/False/0/'' are
 *  falsy in Python). JS `||` misses numeric 0 only via type checks being
 *  explicit — this predicate is that one surface, so e.g. `timeout: 0` from
 *  the model falls back to the configured default exactly as Python did. */
function pyFalsy(value: unknown): boolean {
  return value === undefined || value === null || value === false || value === 0 || value === '';
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Python str.split(sep, maxsplit)[-1]: the remainder after the maxsplit-th
 *  separator (further separators left intact). Used on frontmatter bodies. */
function pySplitLast(s: string, sep: string, maxsplit: number): string {
  let rest = s;
  let n = 0;
  while (n < maxsplit) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    rest = rest.slice(i + sep.length);
    n += 1;
  }
  return rest;
}

// === SECTION === preview builders (used by the permission gate) ===

export function buildPreview(name: string, args: Record<string, unknown>, cfg: Config): Preview {
  if (name === 'bash') {
    return { kind: 'command', title: 'BASH', body: _text(args['command'] ?? '') };
  }
  if (name === 'write_file') {
    const p = _text(args['path'] ?? '?');
    const content = _text(args['content'] ?? '');
    let existing = '';
    try {
      const resolved = resolveInJail(cfg.workdir, p, cfg.unsafe);
      // Sync read on purpose: the preview must be ready before the gate
      // renders, and it is a single bounded file read.
      if (fsSync.existsSync(resolved) && fsSync.statSync(resolved).isFile()) {
        existing = fsSync.readFileSync(resolved, 'utf8');
      }
    } catch {
      // A preview must never raise; an unreadable target just means no "old" side.
    }
    const diff = unifiedDiff(existing, content, p, !existing);
    return { kind: 'diff', title: `WRITE ${p}`, body: diff };
  }
  if (name === 'edit_file') {
    const p = _text(args['path'] ?? '?');
    const old = _text(args['old_string'] ?? '');
    const nw = _text(args['new_string'] ?? '');
    const diff = unifiedDiff(old, nw, p);
    return { kind: 'diff', title: `EDIT ${p}`, body: diff };
  }
  return { kind: 'text', title: name.toUpperCase(), body: String(JSON.stringify(args)) };
}

/**
 * Minimal unified diff (difflib.unified_diff, n=3). No diff dependency is
 * declared, so this is hand-rolled: a SequenceMatcher-shaped opcode list over
 * the whole file (common prefix/suffix trimmed for the LCS, then re-expressed
 * as equal-opcodes so context lines and line numbers come out right), grouped
 * difflib-style into hunks. A middle too large for the LCS degrades to one
 * whole-range replace hunk — valid, just coarser, so previews of huge
 * rewrites stay fast.
 */
function unifiedDiff(oldS: string, newS: string, label: string, newFile = false): string {
  const a = splitLinesKeepEnds(_text(oldS));
  const b = splitLinesKeepEnds(_text(newS));
  // difflib's convention: an unterminated final line is diffed as if it had
  // one, so the body always ends with a newline.
  if (a.length > 0 && !a[a.length - 1].endsWith('\n')) a[a.length - 1] += '\n';
  if (b.length > 0 && !b[b.length - 1].endsWith('\n')) b[b.length - 1] += '\n';
  const fromFile = newFile ? '/dev/null' : `a/${label}`;
  const toFile = `b/${label}`;

  // Opcodes over the FULL sequences: [tag, i1, i2, j1, j2].
  type Opcode = ['equal' | 'delete' | 'insert' | 'replace', number, number, number, number];
  const opcodes: Opcode[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return '(no textual change)';
  if (start > 0) opcodes.push(['equal', 0, start, 0, start]);

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const MAX_MID = 2000;
  if (midA.length > MAX_MID || midB.length > MAX_MID) {
    opcodes.push(['replace', start, endA, start, endB]);
  } else {
    // LCS over the differing middle; backtrace into delete/insert runs.
    const dp: number[][] = Array.from({ length: midA.length + 1 }, () =>
      new Array<number>(midB.length + 1).fill(0),
    );
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let runA = -1; // start of the pending delete run, in a-coordinates
    let runB = -1; // start of the pending insert run, in b-coordinates
    const flush = (): void => {
      if (runA >= 0 && runB >= 0) {
        opcodes.push(['replace', runA, start + i, runB, start + j]);
      } else if (runA >= 0) {
        opcodes.push(['delete', runA, start + i, start + j, start + j]);
      } else if (runB >= 0) {
        opcodes.push(['insert', start + i, start + i, runB, start + j]);
      }
      runA = -1;
      runB = -1;
    };
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        flush();
        // The two sides advance 1:1 through a match, but their ABSOLUTE
        // positions can differ after asymmetric delete/insert runs — track
        // both coordinates.
        const aStart = start + i;
        const bStart = start + j;
        let n = 0;
        while (i < midA.length && j < midB.length && midA[i] === midB[j]) {
          i += 1;
          j += 1;
          n += 1;
        }
        opcodes.push(['equal', aStart, aStart + n, bStart, bStart + n]);
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        if (runA < 0) runA = start + i;
        i += 1;
      } else {
        if (runB < 0) runB = start + j;
        j += 1;
      }
    }
    if (i < midA.length && runA < 0) runA = start + i;
    if (j < midB.length && runB < 0) runB = start + j;
    while (i < midA.length) i += 1;
    while (j < midB.length) j += 1;
    flush();
  }
  if (endA < a.length) opcodes.push(['equal', endA, a.length, endB, b.length]);

  // difflib.get_grouped_opcodes(n=3): context around each changed run, an
  // equal run longer than 2n splits the hunks.
  const CONTEXT = 3;
  const codes = opcodes.slice();
  if (codes.length > 0 && codes[0][0] === 'equal') {
    const [, i1, i2, j1, j2] = codes[0];
    codes[0] = ['equal', Math.max(i1, i2 - CONTEXT), i2, Math.max(j1, j2 - CONTEXT), j2];
  }
  if (codes.length > 1 && codes[codes.length - 1][0] === 'equal') {
    const last = codes[codes.length - 1];
    const [, i1, i2, j1, j2] = last;
    codes[codes.length - 1] = ['equal', i1, Math.min(i2, i1 + CONTEXT), j1, Math.min(j2, j1 + CONTEXT)];
  }
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  const nn = CONTEXT * 2;
  for (const code of codes) {
    const [tag, i1, i2, j1, j2] = code;
    if (tag === 'equal' && i2 - i1 > nn) {
      group.push(['equal', i1, Math.min(i2, i1 + CONTEXT), j1, Math.min(j2, j1 + CONTEXT)]);
      groups.push(group);
      group = [];
      const ni1 = Math.max(i1, i2 - CONTEXT);
      const nj1 = Math.max(j1, j2 - CONTEXT);
      group.push([tag, ni1, i2, nj1, j2]);
      continue;
    }
    group.push(code);
  }
  if (group.length > 0 && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group);

  const out: string[] = [`--- ${fromFile}\n`, `+++ ${toFile}\n`];
  for (const g of groups) {
    const first = g[0];
    const last = g[g.length - 1];
    out.push(`@@ -${fmtRange(first[1], last[2] - first[1])} +${fmtRange(first[3], last[4] - first[3])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of g) {
      if (tag === 'equal') {
        for (let k = i1; k < i2; k += 1) out.push(` ${a[k]}`);
      } else {
        if (tag === 'replace' || tag === 'delete') {
          for (let k = i1; k < i2; k += 1) out.push(`-${a[k]}`);
        }
        if (tag === 'replace' || tag === 'insert') {
          for (let k = j1; k < j2; k += 1) out.push(`+${b[k]}`);
        }
      }
    }
  }

  const text = out.join('');
  if (!text.trim()) return '(no textual change)';
  return text;
}

/** Python str.splitlines(keepends=True) over '\n' boundaries (the tool's
 *  files are \n-oriented; \r and friends stay inside the line, unlike
 *  Python's wider split — a deliberate narrowing). A trailing '' from
 *  split() on a newline-terminated string is NOT a line. */
function splitLinesKeepEnds(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  const last = parts.pop() as string;
  const out = parts.map((l) => `${l}\n`);
  if (last !== '') out.push(last); // unterminated final line, no \n
  return out;
}

/** difflib._format_range_unified: "begin" for length 1, "begin-1,0" for empty. */
function fmtRange(start: number, count: number): string {
  let beginning = start + 1;
  if (count === 1) return String(beginning);
  if (count === 0) beginning -= 1;
  return `${beginning},${count}`;
}

// === SECTION === execution ===

export async function execute(
  name: string,
  args: Record<string, unknown>,
  cfg: Config,
): Promise<ToolResult> {
  // Run a tool. Never raises for ordinary failures — returns ToolResult.
  try {
    const fn = DISPATCH[name];
    if (fn === undefined) return { output: `unknown tool: ${name}`, isError: true };
    return await fn(args, cfg);
  } catch (e) {
    if (e instanceof SandboxError) return { output: `sandbox: ${e.message}`, isError: true };
    if (e instanceof ToolError) return { output: e.message, isError: true };
    const name_ = e instanceof Error ? (e.name || e.constructor.name) : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    // Surface any tool failure to the model rather than aborting the turn.
    return { output: `${name_}: ${msg}`, isError: true };
  }
}

// ---- bash -----------------------------------------------------------------

async function toolBash(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const command = _text(args['command'] ?? '');
  if (!command.trim()) return { output: 'empty command', isError: true };

  const rawTimeout = args['timeout'];
  const base = pyFalsy(rawTimeout) ? cfg.bashTimeout : rawTimeout;
  let timeout: number;
  try {
    timeout = asInt(base, 'timeout');
  } catch {
    return { output: 'timeout must be an integer number of seconds', isError: true };
  }
  if (timeout <= 0) {
    return { output: 'timeout must be a positive number of seconds', isError: true };
  }

  // Scope guard is enforced by the caller (agent) before we ever get here,
  // but re-check defensively for programmatic use. Python imports Scope at
  // function level; the TS port keeps the same laziness via dynamic import.
  const { Scope } = await import('./scope.js');
  const scope = (cfg as Config & { scope?: unknown }).scope;
  if (scope instanceof Scope && scope.loaded) {
    const violations = scope.checkCommand(command) as unknown[];
    if (violations && violations.length > 0) {
      const detail = violations.map((v) => `  • ${violationText(v)}`).join('\n');
      return {
        output: `BLOCKED by scope guard — command targets out-of-scope host(s):\n${detail}`,
        isError: true,
        meta: { blocked: true },
      };
    }
  }

  const ran = await runShell(command, cfg.workdir, timeout);
  if (ran.timedOut) {
    const partial = ran.stdout + ran.stderr;
    return {
      output: _truncate(`[timeout after ${timeout}s]\n${partial}`, cfg.maxOutputChars),
      isError: true,
      meta: { exit: null, timeout: true },
    };
  }

  let combined = ran.stdout;
  if (ran.stderr) {
    combined += (ran.stdout ? '\n' : '') + '[stderr]\n' + ran.stderr;
  }
  if (!combined.trim()) combined = '(no output)';
  combined = _truncate(combined, cfg.maxOutputChars);
  return {
    output: combined,
    isError: ran.code !== 0,
    meta: { exit: ran.code, timeout: false },
  };
}

/** One shell invocation. SIGKILL on timeout (Python subprocess.run kills), so
 *  partial output captured up to that point survives, like TimeoutExpired. */
async function runShell(
  command: string,
  cwd: string,
  timeoutSec: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8'); // invalid → U+FFFD, like errors="replace"
      const stderr = Buffer.concat(errChunks).toString('utf8') + extraErr;
      resolve({ stdout, stderr, code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout?.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', (e: Error) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
  });
}

// ---- read_file ------------------------------------------------------------

async function toolReadFile(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const p = resolveInJail(cfg.workdir, _text(args['path'] ?? ''), cfg.unsafe, { mustExist: true });
  if (await isDir(p)) {
    return { output: `${displayPath(cfg.workdir, p)} is a directory`, isError: true };
  }
  let text: string;
  try {
    text = await fsp.readFile(p, 'utf8');
  } catch (e) {
    return { output: `cannot read: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  const lines = text.split('\n');
  // A trailing '' from split on a newline-terminated file is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  const offset = args['offset'];
  const limit = args['limit'];
  // Python `if offset else 0` / `if limit else len(lines)`: 0 and false count
  // as absent (pyFalsy), so limit:0 reads the WHOLE file, not zero lines.
  const start = Math.max(pyFalsy(offset) ? 0 : asInt(offset, 'offset') - 1, 0);
  const end = pyFalsy(limit) ? lines.length : start + asInt(limit, 'limit');
  const chunk = lines.slice(start, end);

  const width = String(start + chunk.length).length;
  const body = chunk.map((ln, i) => `${String(i + start + 1).padStart(width, ' ')} │ ${ln}`).join('\n');
  const withMore = end < lines.length ? `${body}\n... (${lines.length - end} more lines)` : body;
  return {
    output: _truncate(withMore, cfg.maxOutputChars) || '(empty file)',
    meta: { path: displayPath(cfg.workdir, p), lines: lines.length },
  };
}

// ---- write_file -----------------------------------------------------------

async function toolWriteFile(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const p = resolveInJail(cfg.workdir, _text(args['path'] ?? ''), cfg.unsafe);
  const content = args['content'];
  if (typeof content !== 'string') {
    // Python fails the same way (write_text of a non-str raises, caught by
    // execute) — the model gets an error result, not a silently coerced file.
    throw new Error('content must be a string');
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const existed = await exists(p);
  await fsp.writeFile(p, content, 'utf8');
  const verb = existed ? 'overwrote' : 'created';
  return {
    output: `${verb} ${displayPath(cfg.workdir, p)} (${content.length} bytes)`,
    meta: {
      path: displayPath(cfg.workdir, p),
      bytes: content.length,
      created: !existed,
      old: existed ? null : '',
    },
  };
}

// ---- edit_file ------------------------------------------------------------

async function toolEditFile(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const p = resolveInJail(cfg.workdir, _text(args['path'] ?? ''), cfg.unsafe, { mustExist: true });
  const oldS = args['old_string'];
  const newS = args['new_string'];
  if (typeof oldS !== 'string' || typeof newS !== 'string') {
    throw new Error('old_string and new_string must be strings');
  }
  const replaceAll = Boolean(args['replace_all']);

  if (oldS === '') return { output: 'old_string is empty', isError: true };

  const text = await fsp.readFile(p, 'utf8');
  const count = countOccurrences(text, oldS);
  if (count === 0) return { output: 'old_string not found in file', isError: true };
  if (count > 1 && !replaceAll) {
    return {
      output: `old_string occurs ${count} times; pass replace_all=True or add context`,
      isError: true,
    };
  }

  const updated = replaceAll ? text.split(oldS).join(newS) : replaceFirst(text, oldS, newS);
  await fsp.writeFile(p, updated, 'utf8');
  const n = replaceAll ? count : 1;
  return {
    output: `edited ${displayPath(cfg.workdir, p)} (${n} replacement(s))`,
    meta: { path: displayPath(cfg.workdir, p), replacements: n },
  };
}

/** Literal occurrence count (no regex, no $-substitution anywhere here). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** String.replace treats $&/$' in the replacement specially — Python's
 *  str.replace is literal, so splice by index instead. */
function replaceFirst(text: string, oldS: string, newS: string): string {
  const i = text.indexOf(oldS);
  if (i < 0) return text;
  return text.slice(0, i) + newS + text.slice(i + oldS.length);
}

// ---- glob -----------------------------------------------------------------

async function toolGlob(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const pattern = _text(args['pattern'] ?? '');
  const baseArg = _text(args['path'] ?? '') || '.';
  const base = resolveInJail(cfg.workdir, baseArg, cfg.unsafe);
  if (!(await exists(base))) {
    return { output: `path does not exist: ${baseArg}`, isError: true };
  }
  if (!safeGlobPattern(pattern)) {
    return {
      output: `sandbox: glob pattern escapes the working directory: ${pattern}`,
      isError: true,
    };
  }

  const found: string[] = [];
  await globCollect(base, pattern.split('/'), found);
  // Path.glob order is filesystem-defined; the sort is what makes this stable.
  found.sort();
  const matches: string[] = [];
  for (const p of found) {
    // Path.glob follows '..' and symlinks; re-validate every hit.
    if (!containedInJail(cfg.workdir, p, cfg.unsafe)) continue;
    // The skip-set check runs over the FULL path parts, exactly as pathlib's
    // p.parts does — a workdir that itself sits under a "build" component
    // hides its files here too. That is the Python behaviour, kept.
    if (p.split(path.sep).some((part) => _SKIP_DIRS.has(part))) continue;
    if (await isFile(p)) matches.push(displayPath(cfg.workdir, p));
  }
  if (matches.length === 0) return { output: '(no matches)' };
  const shown = matches.slice(0, 500);
  let body = shown.join('\n');
  if (matches.length > shown.length) body += `\n... (${matches.length - shown.length} more)`;
  return { output: body, meta: { count: matches.length } };
}

/** pathlib-style glob walk. Segments: '*' any chars but '/', '?' one char,
 *  '**' any number of path segments (including zero). */
async function globCollect(dir: string, segs: string[], out: string[]): Promise<void> {
  if (segs.length === 0) {
    out.push(dir);
    return;
  }
  const [seg, ...rest] = segs;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (seg === '**') {
    if (rest.length === 0) out.push(dir); // '**' alone matches this dir too
    else await globCollect(dir, rest, out); // '**' consumed zero segments
    for (const e of entries) {
      if (e.isDirectory()) await globCollect(path.join(dir, e.name), segs, out);
    }
    return;
  }
  const rx = segmentRegex(seg);
  for (const e of entries) {
    if (!rx.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (rest.length === 0) out.push(full);
    else if (e.isDirectory()) await globCollect(full, rest, out);
  }
}

function segmentRegex(seg: string): RegExp {
  let out = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const j = seg.indexOf(']', i + 1);
      if (j > i) {
        const cls = seg.slice(i + 1, j).replace(/^!/, '^');
        out += `[${cls}]`;
        i = j;
      } else out += '\\[';
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// ---- grep -----------------------------------------------------------------

async function toolGrep(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const pattern = _text(args['pattern'] ?? '');
  if (!pattern) return { output: 'empty pattern', isError: true };
  const base = resolveInJail(cfg.workdir, _text(args['path'] ?? '') || '.', cfg.unsafe, {
    mustExist: true,
  });
  const fileGlob = _text(args['glob'] ?? '') || '**/*';
  if (!safeGlobPattern(fileGlob)) {
    return {
      output: `sandbox: glob pattern escapes the working directory: ${fileGlob}`,
      isError: true,
    };
  }
  let rx: RegExp;
  try {
    rx = new RegExp(pattern, args['ignore_case'] ? 'i' : '');
  } catch (e) {
    return { output: `bad regex: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }

  const files: string[] = [];
  if (await isFile(base)) {
    files.push(base);
  } else {
    const found: string[] = [];
    await globCollect(base, fileGlob.split('/'), found);
    for (const p of found) {
      // Path.glob follows '..' and symlinks; re-validate every hit.
      if (!containedInJail(cfg.workdir, p, cfg.unsafe)) continue;
      if ((await isFile(p)) && !p.split(path.sep).some((part) => _SKIP_DIRS.has(part))) {
        files.push(p);
      }
    }
  }

  const hits: string[] = [];
  const filesHit = new Set<string>();
  files.sort();
  for (const f of files) {
    try {
      const content = await fsp.readFile(f, 'utf8');
      const lines = content.split('\n');
      for (let lineno = 1; lineno <= lines.length; lineno += 1) {
        if (rx.test(lines[lineno - 1])) {
          const rel = displayPath(cfg.workdir, f);
          hits.push(`${rel}:${lineno}:${lines[lineno - 1].replace(/\s+$/, '')}`);
          filesHit.add(rel);
          if (hits.length >= 400) break;
        }
      }
    } catch {
      continue;
    }
    if (hits.length >= 400) break;
  }

  if (hits.length === 0) return { output: '(no matches)', meta: { count: 0 } };
  let body = hits.join('\n');
  if (hits.length >= 400) body += '\n... (truncated at 400 matches)';
  return { output: body, meta: { count: hits.length, files: filesHit.size } };
}

// ---- list_dir -------------------------------------------------------------

async function toolListDir(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const rawPath = _text(args['path'] ?? '') || '.';
  const p = resolveInJail(cfg.workdir, rawPath, cfg.unsafe, { mustExist: true });
  if (!(await isDir(p))) {
    return { output: `not a directory: ${rawPath}`, isError: true };
  }
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch (e) {
    return { output: `cannot list: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  // Dirs first, then files, case-insensitive by name — the Python sort key.
  const rows = await Promise.all(entries.map(async (e) => ({ e, isFile: e.isFile() })));
  rows.sort((a, b) => {
    const byKind = Number(a.isFile) - Number(b.isFile);
    if (byKind !== 0) return byKind;
    const an = a.e.name.toLowerCase();
    const bn = b.e.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const lines: string[] = [];
  for (const { e, isFile: f } of rows) {
    if (_SKIP_DIRS.has(e.name)) continue;
    if (!f) {
      lines.push(`${e.name}/`);
    } else {
      let size = 0;
      try {
        size = (await fsp.stat(path.join(p, e.name))).size;
      } catch {
        size = 0;
      }
      lines.push(`${e.name}  (${_human(size)})`);
    }
  }
  return { output: lines.join('\n') || '(empty directory)' };
}

// ---- web ------------------------------------------------------------------

/** The session scope guard, or null when there is nothing to enforce. */
type ScopeInstance = InstanceType<(typeof import('./scope.js'))['Scope']>;

async function scopeOf(cfg: Config): Promise<ScopeInstance | null> {
  const { Scope } = await import('./scope.js');
  const scope = (cfg as Config & { scope?: unknown }).scope;
  if (scope instanceof Scope && scope.loaded) return scope;
  return null;
}

function violationText(v: unknown): string {
  if (typeof v === 'string') return v;
  const msg = (v as { message?: unknown })?.message;
  if (typeof msg === 'string') return msg;
  return String(v);
}

function hostOf(url: string): string {
  try {
    return new URL(url.includes('//') ? url : `https://${url}`).hostname || '';
  } catch {
    return '';
  }
}

async function toolWebSearch(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const query = _text(args['query'] ?? '').trim();
  if (!query) return { output: 'empty query', isError: true };

  const raw = args['max_results'];
  let maxResults: number;
  try {
    maxResults = asInt(pyFalsy(raw) ? 5 : raw, 'max_results');
  } catch {
    return { output: 'max_results must be an integer', isError: true };
  }
  maxResults = Math.max(1, Math.min(maxResults, 20));

  // No scope check here: a search query names no host, and the scope guard
  // only ever blocks named hosts. The engine itself is the operator's own
  // choice of endpoint, not a target.
  let results: Array<{ title: string; url: string; snippet: string }>;
  let backend: string;
  try {
    [results, backend] = await webSearch(query, maxResults);
  } catch (e) {
    if (e instanceof WebError) {
      return { output: `web search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    throw e;
  }

  if (!results || results.length === 0) {
    return { output: `no results for ${pyRepr(query)} (${backend})` };
  }

  const lines: string[] = [`${results.length} result(s) for ${pyRepr(query)} via ${backend}:`, ''];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  lines.push('Use web_fetch on a URL above to read the page in full.');
  return {
    output: _truncate(lines.join('\n'), cfg.maxOutputChars),
    meta: { results: results.length, backend },
  };
}

async function toolWebFetch(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const url = _text(args['url'] ?? '').trim();
  if (!url) return { output: 'empty url', isError: true };

  let maxChars: number;
  try {
    maxChars = asInt(
      pyFalsy(args['max_chars']) ? Math.min(cfg.maxOutputChars, 20_000) : args['max_chars'],
      'max_chars',
    );
  } catch {
    return { output: 'max_chars must be an integer', isError: true };
  }
  maxChars = Math.max(200, Math.min(maxChars, cfg.maxOutputChars));

  // Fetching a URL is reaching a host, so it answers to the deny-list. The
  // allow-list is a declaration and never blocks, so it is not consulted.
  const scope = await scopeOf(cfg);
  if (scope !== null) {
    const host = hostOf(url);
    const [allowed, reason] = scope.allows(host);
    if (!allowed) {
      return {
        output: `BLOCKED by scope guard — ${host}: ${reason}`,
        isError: true,
        meta: { blocked: true },
      };
    }
  }

  let finalUrl: string;
  let text: string;
  try {
    [finalUrl, text] = await webFetch(url, maxChars);
  } catch (e) {
    if (e instanceof WebError) {
      return { output: `web fetch failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    throw e;
  }

  const header = finalUrl !== url ? `# ${finalUrl}\n\n` : '';
  return {
    output: _truncate(header + text, cfg.maxOutputChars),
    meta: { url: finalUrl },
  };
}

// ---- report_finding -------------------------------------------------------

async function toolReportFinding(args: Record<string, unknown>): Promise<ToolResult> {
  // Accept a finding from a hunt agent and hand it back for publication.
  //
  // Nothing is written here. The finding travels out on the tool_result
  // event's meta, which is where hunt._run_agent picks it up and
  // deduplicates it into the run. Keeping the side effect out of the tool is
  // what lets it be tested without a campaign, and what stops a report from
  // being written twice — once here and once when the wave harvests the
  // agent's final text.
  //
  // The tool returns a confirmation the agent can read, because a model that
  // cannot tell whether its report landed will report the same bug again on
  // the next turn.
  const title = _text(args['title'] ?? '').trim();
  const evidence = _text(args['evidence'] ?? '').trim();
  if (!title) return { output: "report_finding: 'title' is required", isError: true };
  if (!evidence) {
    // The contract already demands evidence. Enforcing it here rather than
    // only in the prompt is what keeps the tracker free of guesses: a model
    // that skips the evidence is told so, and the finding does not publish.
    return {
      output:
        "report_finding: 'evidence' is required — quote the request, output or file:line that " +
        'proves the bug. An unevidenced finding is a guess.',
      isError: true,
    };
  }

  const severity = _text(args['severity'] ?? '').trim().toLowerCase() || 'info';
  return {
    output: `recorded: [${severity}] ${title}`,
    meta: {
      finding: {
        title: title.slice(0, 200),
        severity,
        asset: _text(args['asset'] ?? '').trim().slice(0, 300),
        summary: _text(args['summary'] ?? '').trim(),
        evidence,
        remediation: _text(args['remediation'] ?? '').trim(),
      },
    },
  };
}

// === SECTION === hunt_findings (campaign read side) ===

// The campaign store, relative to state_dir. Kept as a literal here rather
// than imported from hunt: hunt imports agent, agent imports this module, so
// reading hunt's constant would close an import cycle.
const _HUNTS_DIR = 'hunts';

/** The flat YAML frontmatter of a campaign artefact, as strings. The same
 *  shape hunt.readFrontmatter writes and reads; duplicated deliberately. */
function readFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return '';
}

/** Every campaign directory, newest first.
 *
 *  "Newest" is the most recently *written artefact* under the directory, not
 *  the directory's own mtime — writing a new file into a directory does not
 *  touch the directory's mtime, while a migration moving files *into* one
 *  bumps it to now. The artefacts' mtimes survive the move, so they decide. */
async function campaignDirs(stateDir: string): Promise<string[]> {
  const root = path.join(stateDir, _HUNTS_DIR);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  const aged = await Promise.all(dirs.map(async (d) => [d, await newestArtefact(d)] as const));
  aged.sort((a, b) => b[1] - a[1]);
  return aged.map(([d]) => d);
}

async function newestArtefact(dir: string): Promise<number> {
  let latest = 0;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      latest = Math.max(latest, await newestArtefact(full));
    } else {
      try {
        latest = Math.max(latest, (await fsp.stat(full)).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return latest;
}

/** The bare scope a target names — https://dev.example.com/login →
 *  dev.example.com. The same reduction hunt.scopeName performs, duplicated
 *  to avoid the import cycle (hunt → agent → tools). The operator types
 *  whatever they think of the engagement, and the campaign is filed under
 *  the bare scope, so the lookup must reduce the same way. */
function scopeName(target: string): string {
  let text = String(target ?? '').trim();
  if (!text) return '';
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  text = text.split('/', 1)[0];
  text = text.split('@').pop() ?? '';
  text = text.split(':', 1)[0];
  return text.toLowerCase();
}

// A wave directory: wave-0, wave-1, … Duplicated from hunt for the same
// import-cycle reason as scopeName.
const _WAVE_DIR_RE = /^wave-(\d+)$/;

/** Every finding report in a campaign, in wave order then by name. Both
 *  layouts: wave-<n>/findings/*.md and the flat findings/*.md of a campaign
 *  the boot migration has not reached yet. */
async function findingFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const name of entries.map((e) => e.name).sort()) {
    const child = path.join(directory, name);
    if (_WAVE_DIR_RE.test(name) && (await isDir(child))) {
      out.push(...(await sortedMd(path.join(child, 'findings'))));
    }
  }
  out.push(...(await sortedMd(path.join(directory, 'findings'))));
  return out;
}

async function sortedMd(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f));
}

/** Every wave plan in a campaign, current layout and legacy alike. */
async function planFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const name of entries.map((e) => e.name).sort()) {
    const child = path.join(directory, name);
    if (_WAVE_DIR_RE.test(name) && (await isDir(child))) {
      let names: string[];
      try {
        names = await fsp.readdir(child);
      } catch {
        continue;
      }
      out.push(
        ...names.filter((f) => f.startsWith('plan') && f.endsWith('.md')).sort().map((f) => path.join(child, f)),
      );
    }
  }
  const flat = path.join(directory, 'plans');
  let flatNames: string[];
  try {
    flatNames = await fsp.readdir(flat);
  } catch {
    flatNames = [];
  }
  out.push(...flatNames.filter((f) => /^wave-.*\.md$/.test(f)).sort().map((f) => path.join(flat, f)));
  return out;
}

// Severity, worst first. Duplicated from hunt.VALID_SEVERITIES for the same
// import-cycle reason as the enum above. Pinned by the hunt tests.
const _SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

async function toolHuntFindings(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  // The main agent's window onto a hunt — reads what is actually on disk.
  // Read-only, and bounded: findings, the newest recon note and the wave
  // plans, each truncated, rather than an entire campaign.
  const stateDir = cfg.stateDir ?? andyHome();
  const scope = _text(args['scope'] ?? '').trim();
  const include = (_text(args['include'] ?? '').trim().toLowerCase() || 'findings') as
    | 'findings'
    | 'recon'
    | 'plans'
    | 'all';
  if (!['findings', 'recon', 'plans', 'all'].includes(include)) {
    return {
      output: `hunt_findings: unknown include ${pyRepr(include)} — use findings, recon, plans or all`,
      isError: true,
    };
  }

  const campaigns = await campaignDirs(stateDir);
  if (campaigns.length === 0) {
    return {
      output: `no /bug-hunt campaign has been recorded under ${path.join(stateDir, _HUNTS_DIR)}`,
    };
  }

  let directory: string | null = null;
  if (scope) {
    // Match on the directory's scope name and, failing that, on the target
    // recorded inside its findings — the directory name is derived, but the
    // frontmatter holds exactly what the operator typed. Both sides are
    // reduced first, so a URL or a host-with-port finds the campaign filed
    // under its bare scope.
    const want = scopeName(scope);
    for (const d of campaigns) {
      if (path.basename(d).toLowerCase() === want) {
        directory = d;
        break;
      }
    }
    if (directory === null) {
      outer: for (const d of campaigns) {
        for (const f of await findingFiles(d)) {
          try {
            const meta = readFrontmatter(await fsp.readFile(f, 'utf8'));
            if (scopeName(meta['target'] ?? '') === want) {
              directory = d;
              break outer;
            }
          } catch {
            continue;
          }
        }
      }
    }
    if (directory === null) {
      const names = campaigns.slice(0, 8).map((d) => path.basename(d)).join(', ');
      return { output: `no campaign for ${pyRepr(scope)}. Known scopes: ${names}` };
    }
  } else {
    directory = campaigns[0];
  }

  const parts: string[] = [`campaign: ${path.basename(directory)}  (${directory})`];

  const files = await findingFiles(directory);

  if (include === 'findings' || include === 'all') {
    if (files.length === 0) {
      parts.push('\nFINDINGS: none were confirmed in this campaign.');
    } else {
      // Worst first, the order /findings and the closing summary use. On
      // disk the files sort by wave then name, which buries a campaign's one
      // critical at position 20 of 43 — a reader skimming the list would
      // have to scan all of it to find the thing that matters most.
      // Ordered here rather than in findingFiles because that helper feeds
      // the "read the newest campaign's frontmatter" probe too, where order
      // is irrelevant and re-reading every file would not be.
      const rows: Array<[number, number, string, string]> = [];
      for (const f of files) {
        let text: string;
        try {
          text = await fsp.readFile(f, 'utf8');
        } catch {
          continue;
        }
        const meta = readFrontmatter(text);
        const severity = _text(meta['severity'] ?? '').trim().toLowerCase();
        let wave = 0;
        try {
          wave = Number.parseInt(String(meta['wave'] ?? '').trim(), 10);
          if (!Number.isFinite(wave)) wave = 0;
        } catch {
          wave = 0;
        }
        const heading = firstHeading(text) || path.basename(f, '.md');
        rows.push([
          _SEVERITY_ORDER[severity] ?? Object.keys(_SEVERITY_ORDER).length,
          wave,
          heading,
          `\n- [${severity.toUpperCase() || '?'}] ${heading}\n` +
            `  wave ${meta['wave'] ?? '?'} · ${meta['asset'] || '(no asset)'} · found by ${meta['agent'] ?? '?'}\n` +
            `  file: ${f}`,
        ]);
      }
      rows.sort(
        (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0),
      );
      parts.push(`\nFINDINGS (${rows.length}), worst first:`);
      parts.push(...rows.map((r) => r[3]));
    }
  }

  if (include === 'recon' || include === 'all') {
    let names: string[];
    try {
      names = await fsp.readdir(directory);
    } catch {
      names = [];
    }
    const notes = names.filter((f) => /^recon-.*\.md$/.test(f)).sort().map((f) => path.join(directory, f));
    if (notes.length === 0) {
      parts.push(
        '\nRECON: no recon notes on disk for this campaign — it was run before recon was ' +
          'recorded, or recon produced nothing.',
      );
    } else {
      // Newest first, and only the newest in full: a scope can accumulate
      // many recon notes and the model does not need all of them.
      const newest = notes[notes.length - 1];
      let body = await fsp.readFile(newest, 'utf8');
      body = body.startsWith('---') ? pySplitLast(body, '\n---', 2) : body;
      parts.push(`\nRECON (${notes.length} note(s); newest ${path.basename(newest)}):\n${_truncate(body.trim(), 4000)}`);
    }
  }

  if (include === 'plans' || include === 'all') {
    const plans = await planFiles(directory);
    if (plans.length === 0) {
      parts.push('\nPLANS: none recorded.');
    } else {
      parts.push(`\nPLANS (${plans.length}):`);
      for (const f of plans) {
        let text: string;
        try {
          text = await fsp.readFile(f, 'utf8');
        } catch {
          continue;
        }
        const meta = readFrontmatter(text);
        const fallback = _text(meta['fell_back'] ?? 'false').toLowerCase() === 'true';
        parts.push(
          `- wave ${meta['wave'] ?? '?'}: ${meta['agents'] ?? '?'} agents` +
            (fallback ? ' (fixed vector fallback)' : '') +
            `  ·  ${f}`,
        );
      }
    }
  }

  parts.push(
    '\nRead a finding in full with read_file on its path. The campaign directory also holds ' +
      'the recon notes and the wave plans.',
  );
  return { output: parts.join('\n') };
}

// === SECTION === LDXHub document jobs ===
//
// Six services from https://gw.ldxhub.io, each a job: create, poll, fetch.
// LDXHub has no Messages endpoint (see ldxhub.ts), so this is the integration
// surface — not a chat source. All of it is withheld until a key exists
// (LDXHUB_TOOLS / Agent.toolSchemas).

/** Structural stand-in for ldxhub.Entry — duck-typed so this module does not
 *  depend on the ldxhub module graph at type time (it is dynamically imported). */
interface LdxEntryLike {
  id: string;
  summary: string;
}

async function ldxToken(): Promise<string> {
  const ldx = await import('./ldxhub.js');
  const creds = await ldx.loadCredentials();
  if (!creds) throw new ToolError('no LDXHub key — run /ldxhub-api-setup');
  return creds[0];
}

async function ldxEntry(service: string, explicit: string): Promise<[LdxEntryLike, string]> {
  const ldx = await import('./ldxhub.js');
  const token = await ldxToken();
  // Python: resolve_entry(service, explicit, token=token) — creds unused when
  // the token is passed explicitly. The TS port flattened the keyword arg to
  // a positional fourth parameter.
  const [entry, err] = (await ldx.resolveEntry(service, explicit, null, token)) as [
    LdxEntryLike | null,
    string,
  ];
  if (entry === null) throw new ToolError(err || `no ${service} model/engine available`);
  return [entry, token];
}

/** example_output must arrive as a native JSON object. A string — even a
 *  JSON-encoded object — is rejected by the API with malformed_json, so
 *  coerce defensively and refuse anything that is not a dict. */
function ldxObject(value: unknown, name = 'example_output'): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const obj: unknown = JSON.parse(value);
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // fall through to the refusal
    }
  }
  throw new ToolError(`${name} must be a JSON object`);
}

async function ldxUpload(filePath: string, cfg: Config, token: string): Promise<string> {
  const ldx = await import('./ldxhub.js');
  const src = resolveInJail(cfg.workdir, _text(filePath), cfg.unsafe, { mustExist: true });
  const [fileId, err] = await ldx.uploadFile(src, token);
  if (err) throw new ToolError(`upload failed: ${err}`);
  return fileId;
}

async function ldxText(fileId: string, token: string, limit = 60_000): Promise<string> {
  const ldx = await import('./ldxhub.js');
  const tmp = path.join(os.tmpdir(), `andy-ldx-${randomBytes(12).toString('hex')}`);
  let data: Buffer;
  try {
    const err = await ldx.downloadFile(fileId, token, tmp);
    if (err) throw new ToolError(`download failed: ${err}`);
    data = await fsp.readFile(tmp);
  } finally {
    try {
      await fsp.unlink(tmp);
    } catch {
      // temp cleanup is best-effort
    }
  }
  let text = data.toString('utf8');
  if (text.length > limit) {
    text = text.slice(0, limit) + `\n... [truncated — ${data.length} bytes total]`;
  }
  return text;
}

async function ldxDeliver(
  inline: string | null,
  fileId: string | null,
  token: string,
  cfg: Config,
  dest = '',
  opts: { asText?: boolean } = {},
): Promise<ToolResult> {
  const ldx = await import('./ldxhub.js');
  const parts: string[] = [];
  if (inline) parts.push(inline);
  if (!fileId) {
    if (parts.length === 0) throw new ToolError('job finished with no output');
    return { output: parts.join('\n') };
  }
  if (dest) {
    const out = resolveInJail(cfg.workdir, _text(dest), cfg.unsafe);
    const err = await ldx.downloadFile(fileId, token, out);
    if (err) throw new ToolError(`download failed: ${err}`);
    parts.push(`wrote ${displayPath(cfg.workdir, out)}`);
    return { output: parts.join('\n') };
  }
  if (opts.asText) {
    parts.push(await ldxText(fileId, token));
    return { output: parts.join('\n') };
  }
  parts.push(`output file id: ${fileId} — pass dest to save it`);
  return { output: parts.join('\n') };
}

async function ldxJob(
  service: string,
  payload: Record<string, unknown>,
  token: string,
  cfg: Config,
  dest = '',
  opts: { asText?: boolean } = {},
): Promise<ToolResult> {
  const ldx = await import('./ldxhub.js');
  const [job, err] = (await ldx.runJob(service, payload, token)) as [
    Record<string, unknown> | null,
    string,
  ];
  if (job === null) throw new ToolError(err || `${service} job failed`);
  const [inline, fileId, oerr] = (await ldx.jobOutput(job)) as [string | null, string | null, string];
  if (oerr) throw new ToolError(oerr);
  return ldxDeliver(inline, fileId, token, cfg, dest, opts);
}

async function toolLdxhubStructflow(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const prompt = _text(args['prompt'] ?? '').trim();
  const filePath = _text(args['file_path'] ?? '').trim();
  if (Boolean(prompt) === Boolean(filePath)) {
    throw new ToolError('give exactly one of prompt or file_path');
  }
  const [entry, token] = await ldxEntry('structflow', _text(args['model'] ?? ''));
  const payload: Record<string, unknown> = {
    model: entry.id,
    system_prompt:
      _text(args['system_prompt'] ?? '').trim() || 'Produce the requested document exactly as specified.',
    example_output: ldxObject(args['example_output'] ?? { result: '' }),
  };
  // inputs and file_id are mutually exclusive — the gateway 400s if both are
  // present, and requires exactly one.
  if (filePath) {
    payload['file_id'] = await ldxUpload(filePath, cfg, token);
  } else {
    payload['inputs'] = [{ role: 'user', content: prompt }];
  }
  return ldxJob('structflow', payload, token, cfg, _text(args['dest'] ?? ''));
}

async function toolLdxhubAnalyze(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const filePath = _text(args['file_path'] ?? '').trim();
  const prompt = _text(args['prompt'] ?? '').trim();
  if (!filePath || !prompt) {
    throw new ToolError('file_path and prompt are both required');
  }
  const [entry, token] = await ldxEntry('analyzedoc', _text(args['model'] ?? ''));
  const payload: Record<string, unknown> = {
    model: entry.id,
    system_prompt: prompt,
    example_output: ldxObject(args['example_output'] ?? { result: '' }),
    file_id: await ldxUpload(filePath, cfg, token),
    output_format: _text(args['output_format'] ?? '') || 'json',
  };
  return ldxJob('analyzedoc', payload, token, cfg);
}

async function toolLdxhubExtract(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const filePath = _text(args['file_path'] ?? '').trim();
  if (!filePath) throw new ToolError('file_path is required');
  const [entry, token] = await ldxEntry('extractdoc', _text(args['engine'] ?? ''));
  const payload: Record<string, unknown> = {
    engine: entry.id,
    file_id: await ldxUpload(filePath, cfg, token),
    output_format: _text(args['output_format'] ?? '') || 'text',
  };
  return ldxJob('extractdoc', payload, token, cfg, _text(args['dest'] ?? ''), { asText: true });
}

async function toolLdxhubConvert(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const filePath = _text(args['file_path'] ?? '').trim();
  const dest = _text(args['dest'] ?? '').trim();
  const mode = _text(args['mode'] ?? '').trim();
  if (!filePath || !dest) throw new ToolError('file_path and dest are both required');
  if (mode !== 'renderocr' && mode !== 'castdoc') {
    throw new ToolError("mode must be 'renderocr' (OCR) or 'castdoc' (PDF)");
  }
  const [entry, token] = await ldxEntry(mode, _text(args['engine'] ?? ''));
  const payload: Record<string, unknown> = {
    engine: entry.id,
    file_id: await ldxUpload(filePath, cfg, token),
    output_format: _text(args['output_format'] ?? '') || 'docx',
  };
  if (mode === 'renderocr') {
    let langs = args['languages'];
    if (typeof langs === 'string' && langs.trim()) {
      langs = langs.split(',').map((p) => p.trim()).filter((p) => p);
    }
    if (!Array.isArray(langs) || langs.length === 0) langs = ['en'];
    payload['languages'] = (langs as unknown[]).map((x) => String(x));
  }
  return ldxJob(mode, payload, token, cfg, dest);
}

async function toolLdxhubRefine(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const filePath = _text(args['file_path'] ?? '').trim();
  if (!filePath) throw new ToolError('file_path is required');
  const [entry, token] = await ldxEntry('refineloop', _text(args['model'] ?? ''));
  const payload: Record<string, unknown> = {
    model: entry.id,
    file_id: await ldxUpload(filePath, cfg, token),
  };
  return ldxJob('refineloop', payload, token, cfg, _text(args['dest'] ?? ''), { asText: true });
}

async function toolLdxhubList(args: Record<string, unknown>): Promise<ToolResult> {
  // List the live catalogs. Keyless is fine — they are public.
  const ldx = await import('./ldxhub.js');
  const services = ldx.SERVICES as Record<string, string>;

  const service = _text(args['service'] ?? '').trim();
  if (service && !(service in services)) {
    throw new ToolError(
      `unknown service ${pyRepr(service)} — choose one of ${Object.keys(services).join(', ')}`,
    );
  }
  const names = service ? [service] : Object.keys(services);
  // No ldxToken() here: browsing must work before /ldxhub-api-setup, which is
  // exactly when a catalog is most useful. Only the job tools require a key.
  const creds = await ldx.loadCredentials();
  const token = creds ? creds[0] : '';
  const defaults: Record<string, string> = creds ? creds[1] : {};
  const parts: string[] = [];
  for (const name of names) {
    const [entries, err] = (await ldx.fetchCatalog(name, token)) as [LdxEntryLike[] | null, string];
    if (entries === null) {
      parts.push(`${name}: ${err}`);
      continue;
    }
    const kind = services[name];
    const mark = defaults[name] ?? '';
    parts.push(`${name} (${entries.length} ${kind}):`);
    for (const e of entries) {
      const star = e.id === mark ? ' *' : '';
      parts.push(`  ${e.summary}${star}`);
    }
  }
  if (!service) {
    parts.push("\n'*' is the default for that service — change it with /ldxhub-models.");
  }
  if (!creds) {
    parts.push('A key is needed to run a job, not to browse — /ldxhub-api-setup.');
  }
  return { output: parts.join('\n') };
}

// === SECTION === pane messaging ===

async function peerRoot(
  cfg: Config,
): Promise<{ panes: typeof import('./panes.js'); root: string; me: string }> {
  const panes = await import('./panes.js');
  const session = panes.currentSession();
  if (!session) {
    throw new ToolError(
      'not running inside an Andy tmux pane — start with `andy --panes` and split with ctrl+b h / ctrl+b v',
    );
  }
  return {
    panes,
    root: panes.mailboxRoot(cfg.stateDir, session),
    me: panes.currentAgent() || 'unknown',
  };
}

async function toolAgentPeers(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const { panes, root, me } = await peerRoot(cfg);
  panes.register(root, me);
  const others = (await panes.knownAgents(root)).filter((a: string) => a !== me);
  if (others.length === 0) {
    return { output: `you are '${me}'. No other agents in this session yet.` };
  }
  return { output: `you are '${me}'. Peers: ${others.join(', ')}` };
}

async function toolAgentSend(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const { panes, root, me } = await peerRoot(cfg);
  panes.register(root, me);
  const to = _text(args['to'] ?? '');
  try {
    await panes.send(root, me, to, _text(args['body'] ?? ''));
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
  return { output: `sent to ${to}` };
}

async function toolAgentInbox(args: Record<string, unknown>, cfg: Config): Promise<ToolResult> {
  const { panes, root, me } = await peerRoot(cfg);
  panes.register(root, me);
  const msgs = await panes.drain(root, me);
  if (!msgs || msgs.length === 0) return { output: 'no new messages' };
  return { output: panes.formatMessages(msgs) };
}

// === SECTION === dispatch + labels ===

const DISPATCH: Record<string, (args: Record<string, unknown>, cfg: Config) => Promise<ToolResult>> = {
  bash: toolBash,
  read_file: toolReadFile,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  glob: toolGlob,
  grep: toolGrep,
  list_dir: toolListDir,
  search_web: toolWebSearch,
  web_fetch: toolWebFetch,
  report_finding: toolReportFinding,
  hunt_findings: toolHuntFindings,
  agent_peers: toolAgentPeers,
  agent_send: toolAgentSend,
  agent_inbox: toolAgentInbox,
  ldxhub_structflow: toolLdxhubStructflow,
  ldxhub_analyze: toolLdxhubAnalyze,
  ldxhub_extract: toolLdxhubExtract,
  ldxhub_convert: toolLdxhubConvert,
  ldxhub_refine: toolLdxhubRefine,
  ldxhub_list: toolLdxhubList,
};

export function summariseCall(
  name: string,
  args: Record<string, unknown>,
  _cfg: Config,
  maxLen = 70,
): string {
  // One-line human label for a tool call, e.g. `$ nmap -sV host`.
  if (name === 'bash') {
    const cmd = _text(args['command'] ?? '');
    return '$ ' + (cmd.length <= maxLen ? cmd : cmd.slice(0, maxLen - 1) + '…');
  }
  if (['read_file', 'write_file', 'edit_file', 'list_dir'].includes(name)) {
    return _text(args['path'] ?? '');
  }
  if (name === 'glob') {
    return `${_text(args['pattern'] ?? '')}  in ${_text(args['path'] ?? '.')}`;
  }
  if (name === 'grep') {
    return `/${_text(args['pattern'] ?? '')}/  in ${_text(args['path'] ?? '.')}`;
  }
  if (name === 'search_web') {
    const q = _text(args['query'] ?? '');
    return q.length <= maxLen ? q : q.slice(0, maxLen - 1) + '…';
  }
  if (name === 'web_fetch') {
    const u = _text(args['url'] ?? '');
    return u.length <= maxLen ? u : u.slice(0, maxLen - 1) + '…';
  }
  if (name === 'report_finding') {
    const sev = _text(args['severity'] ?? 'info').toUpperCase();
    const title = _text(args['title'] ?? '');
    const label = `[${sev}] ${title}`;
    return label.length <= maxLen ? label : label.slice(0, maxLen - 1) + '…';
  }
  if (name.startsWith('ldxhub_')) {
    const svc = name.slice('ldxhub_'.length);
    const what = _text(args['file_path'] ?? args['service'] ?? args['prompt'] ?? '');
    const label = `ldxhub ${svc} ${what}`.trim();
    return label.length <= maxLen ? label : label.slice(0, maxLen - 1) + '…';
  }
  return shlexQuote(JSON.stringify(args)).slice(0, maxLen);
}
