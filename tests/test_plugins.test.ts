// Regression suite for plugins.ts (install/remove/manifest reading) and its
// merge into skills.ts's discovery (namespaced plugin:skill), including a
// real round trip through tools.execute()'s actual dispatch path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Plugins = typeof import('../src/plugins.js');
type Skills = typeof import('../src/skills.js');
type Tools = typeof import('../src/tools.js');
type ConfigMod = typeof import('../src/config.js');

let plugins: Plugins;
let skills: Skills;
let tools: Tools;
let Config: ConfigMod['Config'];
let tmp: string;
let workdir: string;
let home: string;
let fixtureDir: string;
let savedAndyHome: string | undefined;

function writeFixturePlugin(dir: string, manifest: object, skillDirName: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  const skillDir = path.join(dir, 'skills', skillDirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: greet\ndescription: plugin-bundled greeting\n---\n\nSay hello, plugin style.\n',
  );
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-plugins-test-'));
  workdir = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fixtureDir = path.join(tmp, 'fixture-plugin');
  fs.mkdirSync(workdir, { recursive: true });
  savedAndyHome = process.env['ANDY_HOME'];
  process.env['ANDY_HOME'] = home;
  plugins = await import('../src/plugins.js');
  skills = await import('../src/skills.js');
  tools = await import('../src/tools.js');
  ({ Config } = await import('../src/config.js'));
});

afterAll(() => {
  if (savedAndyHome !== undefined) process.env['ANDY_HOME'] = savedAndyHome;
  else delete process.env['ANDY_HOME'];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('plugins — registry', () => {
  it('reads as empty before any plugin is installed', () => {
    expect(plugins.list()).toEqual([]);
  });

  it('rejects installLocal on a directory with no plugin.json', () => {
    const emptyDir = path.join(tmp, 'not-a-plugin');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(() => plugins.installLocal(emptyDir)).toThrow(/plugin\.json/);
  });

  it('installs a well-formed local plugin and lists it with its skill dirs', () => {
    writeFixturePlugin(
      fixtureDir,
      { name: 'demo', description: 'a demo plugin', version: '0.1.0' },
      'greeter',
    );
    const manifest = plugins.installLocal(fixtureDir);
    expect(manifest).toMatchObject({ name: 'demo', description: 'a demo plugin', version: '0.1.0' });

    const installed = plugins.list();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ name: 'demo', dir: 'demo', skillDirs: ['greeter'] });
  });

  it('re-installing the same name overwrites rather than duplicating', () => {
    writeFixturePlugin(
      fixtureDir,
      { name: 'demo', description: 'updated description', version: '0.2.0' },
      'greeter',
    );
    plugins.installLocal(fixtureDir);
    const installed = plugins.list();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.description).toBe('updated description');
    expect(installed[0]?.version).toBe('0.2.0');
  });

  it('rejects a plugin name that could not safely prefix a skill name', () => {
    const badDir = path.join(tmp, 'bad-name-plugin');
    writeFixturePlugin(badDir, { name: 'has space', description: 'x' }, 'greeter');
    expect(() => plugins.installLocal(badDir)).toThrow(/letters, digits/);
  });

  it('remove() reports false for an unknown name, true for a real removal', () => {
    expect(plugins.remove('nope')).toBe(false);
  });
});

describe('plugins — skill namespacing and real dispatch', () => {
  it('a plugin-bundled skill shows up in skills.list() as plugin:skill', () => {
    const found = skills.list(workdir).find((s) => s.name === 'demo:greet');
    expect(found).toBeDefined();
    expect(found?.description).toBe('plugin-bundled greeting');
  });

  it('skills.load() resolves the namespaced name to the plugin skill body', () => {
    expect(skills.load('demo:greet', workdir)).toBe('Say hello, plugin style.');
  });

  it('tools.execute("skill", ...) loads a plugin skill through the real dispatch path', async () => {
    const cfg = new Config();
    cfg.workdir = workdir;
    const result = await tools.execute('skill', { skill: 'demo:greet' }, cfg);
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('Say hello, plugin style.');
  });

  it('removing the plugin removes its skill from discovery', () => {
    expect(plugins.remove('demo')).toBe(true);
    expect(skills.list(workdir).some((s) => s.name === 'demo:greet')).toBe(false);
  });
});
