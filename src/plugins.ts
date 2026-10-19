/**
 * plugins.ts — installed-plugin registry: bundles of skills, as directories.
 *
 * What this module is: the local-install half of Claude Code's plugin
 * model, scoped to what this harness can actually support today. A plugin
 * is a directory under ~/.andy/plugins/<name>/ containing a `plugin.json`
 * manifest ({name, description, version?}) and a `skills/` subdirectory of
 * normal skill directories (the exact SKILL.md format skills.ts already
 * reads). skills.ts merges each installed plugin's skills into the live
 * skill list, namespaced `<plugin>:<skill>` — Claude Code's own convention
 * for a plugin-provided resource, so a plugin's skill can never silently
 * collide with (or be collided into by) a bare global/project one.
 *
 * What this deliberately does NOT do, and why:
 *  - No marketplace / git-fetch install. `installLocal()` only ever copies
 *    an already-local directory the operator points at — fetching and
 *    running arbitrary code from a URL is its own supply-chain-sensitive
 *    feature (this repo's supply-chain doctrine treats "pull and execute
 *    someone else's code" as needing its own explicit go-ahead, not a
 *    silent extension of "add a skill"). A remote-install variant would
 *    layer on top of this module's install() without changing its shape.
 *  - No commands/agents/hooks bundling. This harness's slash commands are
 *    a compiled-in dispatch map (see app.tsx's `dispatch` object), not a
 *    runtime-pluggable registry — supporting that is a real architecture
 *    change (a dynamic command registry, dynamically rendered /help, a
 *    permission story for a plugin-registered command), not an extension
 *    of what plugins.ts owns. Skills were the one resource type this
 *    harness already discovers dynamically, which is what makes them the
 *    honest MVP rather than an arbitrary smaller slice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { andyHome, expandTilde } from './shared.js';

export interface PluginManifest {
  name: string;
  description: string;
  version?: string;
}

export interface InstalledPlugin extends PluginManifest {
  /** The directory name under ~/.andy/plugins/ — usually equal to `name`,
   * but kept distinct because a manifest could in principle disagree with
   * the directory it was installed into, and the directory is what every
   * path operation actually needs. */
  dir: string;
  skillDirs: string[];
}

function pluginsRoot(): string {
  return path.join(andyHome(), 'plugins');
}

export function looksLikePluginName(name: string): boolean {
  // Becomes the namespace prefix of every skill it bundles
  // (<name>:<skill>), sent to the model same as a skill name is.
  return /^[A-Za-z0-9_-]{1,40}$/.test(name);
}

function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, 'plugin.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    const description = typeof rec['description'] === 'string' ? rec['description'].trim() : '';
    if (!name || !description) return null;
    const version = typeof rec['version'] === 'string' ? rec['version'] : undefined;
    return { name, description, version };
  } catch {
    return null;
  }
}

/** Every installed plugin, skipping (not throwing on) one whose
 * plugin.json is missing or malformed — same discipline as skills.ts: a
 * broken entry must not take the others down. */
export function list(): InstalledPlugin[] {
  const root = pluginsRoot();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: InstalledPlugin[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const manifest = readManifest(dir);
    if (!manifest) continue;
    let skillDirs: string[] = [];
    try {
      skillDirs = fs
        .readdirSync(path.join(dir, 'skills'))
        .filter((s) => fs.statSync(path.join(dir, 'skills', s)).isDirectory());
    } catch {
      /* a plugin with no skills/ dir bundles nothing yet — not an error */
    }
    out.push({ ...manifest, dir: entry, skillDirs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills/ root for one installed plugin, for skills.ts's merge step.
 * Returns null for a plugin that isn't actually installed (or has no
 * skills/ directory) rather than a path that would fail to stat. */
export function skillsRootFor(pluginDir: string): string | null {
  const p = path.join(pluginsRoot(), pluginDir, 'skills');
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Copy an already-local directory into ~/.andy/plugins/<name>/. Validates
 * the source has a readable plugin.json before copying anything — an
 * operator pointing this at the wrong directory should get a clear error,
 * not a plugin that "installed" with nothing in it. Overwrites an existing
 * install of the same name (re-running this after editing a plugin locally
 * is the normal workflow, not a special case).
 */
export function installLocal(sourceDir: string): PluginManifest {
  const resolved = path.resolve(expandTilde(sourceDir));
  const manifest = readManifest(resolved);
  if (!manifest) {
    throw new Error(`${resolved}/plugin.json is missing or does not have both name and description`);
  }
  if (!looksLikePluginName(manifest.name)) {
    throw new Error(
      `plugin name '${manifest.name}' must be 1-40 chars of letters, digits, - or _ (it becomes a skill-name prefix)`,
    );
  }
  const dest = path.join(pluginsRoot(), manifest.name);
  fs.mkdirSync(pluginsRoot(), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(resolved, dest, { recursive: true });
  return manifest;
}

export function remove(name: string): boolean {
  const dir = path.join(pluginsRoot(), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
