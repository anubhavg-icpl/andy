/**
 * session.ts — session persistence: save / load / list conversation state.
 * (port of andy/session.py)
 *
 * What this module is: the ~/.andy/sessions JSON store behind /save, /resume,
 * /sessions and the --resume launch flag.
 *
 * Invariants:
 *  - Payload shape is `SessionPayload` from shared.ts (camelCase keys, version
 *    1) — the one format this port's save and load agree on, and the shape
 *    ui/app hands to AndyApp's `resume` prop.
 *  - cfg/agent are duck-typed via the two structural interfaces below (the
 *    Python duck-types the same way); the real Config/Agent satisfy them
 *    without session.ts importing agent.ts.
 *  - Loading never throws to the caller: a bad path or unparseable file is
 *    returned as [false, message] and the caller decides what to say.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expandTilde } from './shared.js';
import type { ChatMessage, SessionPayload, SessionSummary } from './shared.js';

/**
 * The slice of Config save/load touch. Structural, so the real Config class
 * satisfies it unchanged.
 */
export interface SessionConfigView {
  model: string;
  baseUrl: string;
  workdir: string;
  unsafe: boolean;
  allowPath: string | null;
  denyPath: string | null;
  stateDir: string;
}

/** The slice of Agent save/load touch (all mutable — load restores them). */
export interface SessionAgentView {
  messages: ChatMessage[];
  turnCount: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCost: number;
  scope: { armed: boolean; loaded: boolean };
}

const SLUG_RE = /[^a-zA-Z0-9._-]+/g;

/** The sessions directory, created on demand. */
export function sessionsDir(cfg: SessionConfigView): string {
  const d = path.join(cfg.stateDir, 'sessions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function slug(text: string, limit = 40): string {
  const cleaned = text.trim().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, limit) || 'session';
}

/** `YYYYMMDD-HHMMSS` in local time, like Python's time.strftime default. */
function stamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** Persist the current conversation. Returns the file written. */
export function save(
  cfg: SessionConfigView,
  agent: SessionAgentView,
  name?: string | null,
): string {
  const now = stamp();
  const label = name ? slug(name) : now;
  const filename = name ? `${now}-${label}.json` : `${now}.json`;
  const file = path.join(sessionsDir(cfg), filename);

  const payload: SessionPayload = {
    version: 1,
    savedAt: Date.now() / 1000, // epoch seconds, like Python time.time()
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    workdir: cfg.workdir,
    unsafe: cfg.unsafe,
    allowPath: cfg.allowPath ?? null,
    denyPath: cfg.denyPath ?? null,
    scopeArmed: agent.scope.armed,
    scopeLoaded: agent.scope.loaded,
    tokens: {
      input: agent.sessionInputTokens,
      output: agent.sessionOutputTokens,
    },
    cost: agent.sessionCost,
    turnCount: agent.turnCount,
    messages: agent.messages,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/**
 * Resolve a --resume / /resume argument to a session file: an explicit path,
 * a bare name inside the sessions dir, or the newest file matching it as a
 * substring (Python's `glob(f"*{path}*")` + last). Undefined when nothing
 * matches. Split out of load() so cli.ts can hand the parsed payload to the
 * Ink app without going through an Agent instance first.
 */
export function findSessionFile(cfg: SessionConfigView, p: string): string | undefined {
  const direct = expandTilde(p);
  if (fs.existsSync(direct)) return direct;
  // Allow loading by bare name from the sessions dir.
  const candidate = path.join(sessionsDir(cfg), p);
  if (fs.existsSync(candidate)) return candidate;
  const matches = fs
    .readdirSync(sessionsDir(cfg))
    .filter((f) => f.includes(p))
    .sort();
  return matches.length > 0 ? path.join(sessionsDir(cfg), matches[matches.length - 1]!) : undefined;
}

/** Read and parse a session file. Undefined when unreadable or unparseable. */
export function readSessionPayload(file: string): SessionPayload | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionPayload;
  } catch {
    return undefined;
  }
}

/** Restore a conversation into *agent*. Returns [ok, message]. */
export function load(
  cfg: SessionConfigView,
  agent: SessionAgentView,
  p: string,
): [boolean, string] {
  const file = findSessionFile(cfg, p);
  if (file === undefined) {
    return [false, `no session matching '${p}'`];
  }
  let data: SessionPayload;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionPayload;
  } catch (e) {
    return [false, `cannot parse session: ${String(e)}`];
  }

  agent.messages = data.messages ?? [];
  agent.turnCount = intOr(data.turnCount, 0);
  agent.sessionInputTokens = intOr(data.tokens?.input, 0);
  agent.sessionOutputTokens = intOr(data.tokens?.output, 0);
  agent.sessionCost = Number(data.cost ?? 0.0) || 0.0;
  if (data.model) cfg.model = data.model;
  return [true, `loaded ${agent.messages.length} messages from ${path.basename(file)}`];
}

function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Every saved session, newest first. Unparseable rows are skipped. */
export function listSessions(cfg: SessionConfigView): SessionSummary[] {
  const out: SessionSummary[] = [];
  const files = fs
    .readdirSync(sessionsDir(cfg))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files) {
    const data = readSessionPayload(path.join(sessionsDir(cfg), f));
    if (data === undefined) continue;
    out.push({
      file: f,
      savedAt: Number(data.savedAt ?? 0) || 0,
      model: data.model ?? '?',
      turns: intOr(data.turnCount, 0),
      messages: (data.messages ?? []).length,
    });
  }
  return out;
}
