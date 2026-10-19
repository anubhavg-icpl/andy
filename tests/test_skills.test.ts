// Regression suite for skills.ts (discovery, frontmatter parsing, the
// project-overrides-global precedence) and the Skill tool's real dispatch
// path through tools.execute() — not just skills.ts in isolation, so a
// regression in the wiring (not just the module) would be caught here too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Skills = typeof import('../src/skills.js');
type Tools = typeof import('../src/tools.js');
type ConfigMod = typeof import('../src/config.js');

let skills: Skills;
let tools: Tools;
let Config: ConfigMod['Config'];
let tmp: string;
let workdir: string;
let home: string;
let savedAndyHome: string | undefined;

function writeSkill(root: string, dir: string, frontmatter: string, body: string): void {
  const skillDir = path.join(root, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-skills-test-'));
  workdir = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(workdir, { recursive: true });
  savedAndyHome = process.env['ANDY_HOME'];
  process.env['ANDY_HOME'] = home;
  skills = await import('../src/skills.js');
  tools = await import('../src/tools.js');
  ({ Config } = await import('../src/config.js'));
});

afterAll(() => {
  if (savedAndyHome !== undefined) process.env['ANDY_HOME'] = savedAndyHome;
  else delete process.env['ANDY_HOME'];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('skills — discovery', () => {
  it('reads as empty before any skill exists', () => {
    expect(skills.list(workdir)).toEqual([]);
    expect(skills.load('nope', workdir)).toBeNull();
  });

  it('discovers a well-formed skill and loads its body', () => {
    writeSkill(
      path.join(home, 'skills'),
      'greeter',
      'name: greet\ndescription: says hello',
      '\nSay a friendly hello back to the operator.\n',
    );
    const found = skills.list(workdir);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'greet', description: 'says hello' });
    expect(skills.load('greet', workdir)).toBe('Say a friendly hello back to the operator.');
  });

  it('skips a skill with no name or description rather than crashing discovery', () => {
    writeSkill(path.join(home, 'skills'), 'broken', 'license: MIT', 'body with no routing info');
    const found = skills.list(workdir);
    // greeter still there; broken is silently absent, not an error
    expect(found.map((s) => s.name)).toEqual(['greet']);
  });

  it('a project-local skill of the same name shadows the global one', () => {
    writeSkill(
      path.join(workdir, '.andy', 'skills'),
      'greeter',
      'name: greet\ndescription: PROJECT version',
      '\nproject-specific greeting instructions\n',
    );
    const found = skills.list(workdir);
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toBe('PROJECT version');
    expect(skills.load('greet', workdir)).toBe('project-specific greeting instructions');
  });

  it('toolDescription lists every discoverable skill by name and description', () => {
    const desc = skills.toolDescription(workdir);
    expect(desc).toContain('greet');
    expect(desc).toContain('PROJECT version');
  });

  it('a corrupt frontmatter block is treated as no frontmatter, not a crash', () => {
    const dir = path.join(home, 'skills', 'badyaml');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\n[ not: valid: yaml\n---\nbody');
    // Must not throw, and must not appear in the list (no name/description).
    const found = skills.list(workdir);
    expect(found.some((s) => s.dir.includes('badyaml'))).toBe(false);
  });
});

describe('skill tool — real dispatch path', () => {
  it('tools.execute("skill", ...) round-trips through the actual dispatch table', async () => {
    const cfg = new Config();
    cfg.workdir = workdir;
    const result = await tools.execute('skill', { skill: 'greet' }, cfg);
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('project-specific greeting instructions');
  });

  it('an unknown skill name fails cleanly and names what is available', async () => {
    const cfg = new Config();
    cfg.workdir = workdir;
    const result = await tools.execute('skill', { skill: 'does-not-exist' }, cfg);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('greet');
  });

  it('needsPermission does NOT gate the skill tool — loading is not executing', () => {
    expect(tools.needsPermission('skill')).toBe(false);
  });
});
