/**
 * shared.ts — cross-cutting helpers and contract types for the andy port.
 *
 * What this module is: the ONE place for things 3+ ported modules need —
 * home/root path resolution, tilde helpers, env access, and the shared
 * Tool/Message/Session/Event types from src/PORT-MAP.md §2. Nothing else
 * belongs here; if only one or two modules use it, it lives in their file.
 *
 * Invariants:
 *  - All env reads for the app go through envStr/envPath so the ANDY→ANDY
 *    rename (PORT-MAP §4) has exactly one surface to audit.
 *  - Paths are plain `string`s (node:path semantics), never Path objects.
 *  - Type names mirror the Python originals (ToolResult, Preview, Deliverable)
 *    with camelCase fields, per PORT-MAP naming conventions.
 */

import { homedir } from 'node:os';
import path from 'node:path';

// === SECTION === paths — ANDY home/root resolution ===

/**
 * The andy dotdir (replaces ANDY_HOME / ~/.andy).
 * `$ANDY_HOME` moves the whole state tree: sessions, hunts, provider
 * profiles, current-theme, current-source, panes mailboxes.
 */
export function andyHome(): string {
  return envStr('ANDY_HOME', path.join(homedir(), '.andy'));
}

/**
 * The checkout root (replaces ANDY_ROOT). Set by the `packaging/andy`
 * launcher before it execs the interpreter; empty when running from source.
 */
export function andyRoot(): string | undefined {
  const root = process.env['ANDY_ROOT'];
  return root && root.length > 0 ? root : undefined;
}

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

/** Inverse of expandTilde, for display: absolute path under home → `~/...`. */
export function toTilde(p: string): string {
  const home = homedir();
  const norm = path.normalize(p);
  if (norm === home) return '~';
  if (norm.startsWith(home + path.sep)) {
    return '~' + path.sep + norm.slice(home.length + 1);
  }
  return norm;
}

// === SECTION === env access ===

/** Read an env var as a string with a fallback; empty string counts as unset. */
export function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

/**
 * Read an env var as a path with a fallback. Empty/unset → fallback.
 * Does NOT expand `~` — call expandTilde when user input may carry it.
 */
export function envPath(name: string, fallback: string): string {
  return envStr(name, fallback);
}

// === SECTION === tool contract (tools.ts, agent.ts, ui/*) ===

/** Result of one tool execution (tools.execute). Never throws for tool failures. */
export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Extra context (e.g. bash exit code) — Python `meta: dict`. */
  meta?: Record<string, unknown>;
}

/** A permission-gate preview for a gated tool call (tools.buildPreview). */
export interface Preview {
  kind: 'command' | 'diff' | 'text';
  title: string;
  body: string;
}

/** Gate answers: "always" also feeds the agent's always-allowed set. */
export type PermissionDecision = 'yes' | 'no' | 'always';

/** Python agent.PermissionHandler: async (name, args, preview) => decision. */
export type PermissionHandler = (
  name: string,
  args: Record<string, unknown>,
  preview: Preview | null,
) => Promise<PermissionDecision>;

/**
 * Python agent.ToolHook: (name, args) => async context manager entered around
 * the tool's execution, so a lock can span the whole call (team serialisation).
 */
export interface ToolHook {
  enter(name: string, args: Record<string, unknown>): Promise<void>;
  exit(name: string, args: Record<string, unknown>): Promise<void>;
}

/** JSON tool schema advertised to the model (tools.TOOL_SCHEMAS entries). */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// === SECTION === message shapes (agent.ts, session.ts, ui/*) ===

/** Anthropic Messages API content block (the subset this harness emits/reads). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
    };

/** One entry of Agent.messages / SessionPayload.messages. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

// === SECTION === agent event stream (PORT-MAP §2.1) ===

/**
 * The event union yielded by Agent.runTurn and dispatched on `type` by the UI.
 * Payload keys confirmed against the Python yield sites by the agent.ts port
 * (PORT-MAP §2.1 assigned that confirmation to this porter):
 *  - tool_result carries the call args and the pre-execution diff alongside
 *    the output.
 *  - blocked carries the violation text as `targets` (no id/reason keys).
 *  - deliverable carries `written` (fact read off disk) and `nudges`.
 *  - turn_end carries `model`, not `rounds`.
 *  - continuing.continued is the COUNT of soft-cap passes (a number), not a
 *    boolean.
 */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'thinking'; iteration: number }
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      id: string;
      preview: Preview | null;
      gated: boolean;
    }
  | {
      type: 'tool_result';
      name: string;
      id: string;
      args: Record<string, unknown>;
      output: string;
      isError?: boolean;
      meta?: Record<string, unknown>;
      /** Pre-execution diff captured before the tool mutated the file. */
      diff: string | null;
    }
  | { type: 'blocked'; name: string; targets: string }
  | { type: 'retry'; reason: string; attempt: number; max: number; delay: number }
  | { type: 'usage'; input: number; output: number; cost: number }
  | { type: 'truncated'; maxTokens: number }
  | { type: 'reasoning_exhausted'; maxTokens: number; retryTokens: number | null }
  | { type: 'nudged'; label: string; attempt: number }
  | { type: 'deliverable'; path: string; label: string; written: boolean; nudges: number }
  | { type: 'continuing'; rounds: number; limit: number; continued: number }
  | { type: 'iteration_cap'; rounds: number; limit: number; hard: boolean }
  | { type: 'compacting'; used: number; window: number; trigger: 'threshold' | 'overflow' }
  | { type: 'compacted'; ok: boolean; note: string; used: number; window: number }
  | { type: 'error'; message: string }
  | {
      type: 'turn_end';
      input: number;
      output: number;
      cost: number;
      model: string;
    };

// === SECTION === session persistence (session.ts, ui/app.tsx) ===

/** JSON payload written by session.save (version 1 format). */
export interface SessionPayload {
  version: 1;
  savedAt: number; // epoch seconds — Python `saved_at`
  model: string;
  baseUrl: string;
  workdir: string;
  unsafe: boolean;
  allowPath: string | null;
  denyPath: string | null;
  scopeArmed: boolean;
  scopeLoaded: boolean;
  tokens: { input: number; output: number };
  cost: number;
  turnCount: number;
  messages: ChatMessage[];
}

/** One row from session.listSessions. */
export interface SessionSummary {
  file: string;
  savedAt: number;
  model: string;
  turns: number;
  messages: number;
}

/** A file a turn is expected to leave behind (agent.Deliverable). */
export interface Deliverable {
  path: string;
  label: string;
  maxNudges: number;
}
