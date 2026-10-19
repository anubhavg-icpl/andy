/**
 * skills.ts — SKILL.md discovery and the Skill tool.
 *
 * What this module is: Claude Code's own skill mechanic, ported to this
 * harness. A skill is a directory containing SKILL.md: YAML frontmatter
 * (`name`, `description` — description is what the model reads to decide
 * WHEN to invoke it, so it never sees the skill's full body until it asks)
 * plus a markdown body of instructions. The model calls the `Skill` tool
 * with a skill name; the tool's job is only to hand back that body as a
 * ToolResult, exactly like Claude Code's own — Andy does not execute a
 * skill, it loads one into the model's own next round of reasoning.
 *
 * Invariants:
 *  - Discovery roots, first-listed wins on a name collision (a project's
 *    own skill shadows a global one with the same name — same precedence
 *    findAgentsFile uses for AGENTS.md, for the same reason: the project
 *    you're standing in should be able to override what's installed
 *    globally):
 *      1. <workdir>/.andy/skills/<name>/SKILL.md
 *      2. <home>/skills/<name>/SKILL.md   (ANDY_HOME, e.g. ~/.andy/skills)
 *  - Directory layout only — a bare `<root>/<name>.md` is not a skill. This
 *    matches Claude Code's own layout and leaves room for a skill to ship
 *    scripts/references/assets alongside SKILL.md later without a format
 *    change.
 *  - Listing skills (list()) is a directory walk plus a frontmatter parse
 *    of each SKILL.md — bounded, synchronous, cheap; it is NOT gated (same
 *    reasoning as ldxhub_list: it is read-only and knowing what's on offer
 *    is exactly what you want before deciding whether to load one).
 *    Invoking a skill (load()) returns ITS BODY AS TEXT — never executed,
 *    so it is not gated either; the tools a skill's instructions eventually
 *    lead the model to call go through their own normal gates same as any
 *    other turn.
 *  - A skill with no name/description in its frontmatter is skipped from
 *    list() (it cannot be routed to sensibly) but the directory itself is
 *    not touched — a malformed skill must not crash discovery for the
 *    others.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { andyHome, expandTilde } from './shared.js';
import * as plugins from './plugins.js';

export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the skill's own directory — shown in /skills so an
   * operator can find and edit it, never sent to the model. */
  dir: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a SKILL.md into (frontmatter object, body). A file with no
 * frontmatter block at all reads as ({}, wholeFileAsBody) rather than
 * failing — a plain markdown file dropped into a skills dir by mistake
 * should not crash discovery, it just won't have a name/description to
 * route on and list() will skip it. */
function splitFrontmatter(text: string): [Record<string, unknown>, string] {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return [{}, text];
  try {
    const parsed = parseYaml(m[1] ?? '');
    const fm = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return [fm, m[2] ?? ''];
  } catch {
    // A frontmatter block that doesn't parse as YAML is treated the same as
    // no frontmatter at all — the skill just won't be listable.
    return [{}, text];
  }
}

/** Discovery roots, in precedence order — see the file contract above for
 * why this order and why directory-only. */
function skillRoots(workdir: string): string[] {
  return [path.join(workdir, '.andy', 'skills'), path.join(andyHome(), 'skills')];
}

/** `namePrefix` is how a plugin-provided skill becomes `<plugin>:<skill>` —
 * see pluginSkills() below. Bare global/project skills pass '' (no ':'). */
function readSkillDir(root: string, entry: string, namePrefix = ''): SkillMeta | null {
  const dir = path.join(root, entry);
  const file = path.join(dir, 'SKILL.md');
  let raw: string;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const [fm] = splitFrontmatter(raw);
  const skillName = typeof fm['name'] === 'string' ? fm['name'].trim() : '';
  const description = typeof fm['description'] === 'string' ? fm['description'].trim() : '';
  if (!skillName || !description) return null;
  return { name: namePrefix ? `${namePrefix}:${skillName}` : skillName, description, dir };
}

/**
 * Every skill bundled by an installed plugin, namespaced `<plugin>:<skill>`
 * — Claude Code's own convention for a plugin-provided resource. Synchronous
 * (plugins.ts's own reads are plain fs sync calls — same reason list() below
 * must stay sync: it's called from agent.ts's toolSchemas(), which the turn
 * loop calls synchronously once per round).
 */
function pluginSkills(): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const plugin of plugins.list()) {
    const root = plugins.skillsRootFor(plugin.dir);
    if (!root) continue;
    for (const entry of plugin.skillDirs) {
      const meta = readSkillDir(root, entry, plugin.name);
      if (meta) out.push(meta);
    }
  }
  return out;
}

/**
 * Every discoverable skill, deduplicated by frontmatter `name` (not by
 * directory name — the two may differ) with the first root in precedence
 * order winning a collision.
 */
export function list(workdir: string = process.cwd()): SkillMeta[] {
  const seen = new Map<string, SkillMeta>();
  for (const root of skillRoots(workdir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // root doesn't exist — not an error, just nothing there
    }
    for (const entry of entries) {
      const meta = readSkillDir(root, entry);
      if (meta && !seen.has(meta.name)) seen.set(meta.name, meta);
    }
  }
  // Plugin skills are namespaced (plugin:skill), so they can never collide
  // with a bare global/project skill name — added after the loop above
  // rather than folded into precedence, since there is no shadowing
  // question to resolve between them.
  for (const meta of pluginSkills()) {
    if (!seen.has(meta.name)) seen.set(meta.name, meta);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The body of one skill by frontmatter name, or null if no discoverable
 * skill has that name. Re-walks discovery rather than caching list()'s
 * result — a skill directory can change between a model deciding to call
 * Skill and the call actually running (an operator editing it live is the
 * whole point of a plain-file format), and this is a bounded local read,
 * not a network call, so re-walking costs nothing worth caching against.
 */
export function load(name: string, workdir: string = process.cwd()): string | null {
  const target = list(workdir).find((s) => s.name === name);
  if (!target) return null;
  try {
    const raw = fs.readFileSync(path.join(target.dir, 'SKILL.md'), 'utf-8');
    const [, body] = splitFrontmatter(raw);
    return body.trim();
  } catch {
    return null;
  }
}

/**
 * The Skill tool's own description, built from whatever is actually
 * discoverable right now — Claude Code's own pattern: the model sees name +
 * description for every skill up front (cheap, a few lines each) and only
 * pays the cost of a skill's full body when it decides to invoke one. A
 * session with zero skills gets a description saying so, rather than an
 * empty bullet list that reads like a bug.
 */
export function toolDescription(workdir: string = process.cwd()): string {
  const skills = list(workdir);
  if (skills.length === 0) {
    return (
      'Load a packaged skill by name. No skills are discoverable right now — ' +
      'none found under .andy/skills/ or ~/.andy/skills/.'
    );
  }
  const lines = skills.map((s) => `  - ${s.name}: ${s.description}`);
  return (
    'Load a packaged skill by name — its instructions become part of what ' +
    "you're doing next. Available:\n" +
    lines.join('\n')
  );
}

/** Andy home's expanded form, exported for /skills' own display use (it
 * wants to show the two root paths even when neither has anything in it
 * yet, which list() alone cannot distinguish from "checked and empty"). */
export function skillRootsFor(workdir: string = process.cwd()): string[] {
  return skillRoots(workdir).map((r) => expandTilde(r));
}
