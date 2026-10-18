/**
 * index.ts — package surface for `andy`. (port of zimzilla/__init__.py)
 *
 * What this module is: the library entry. The Python package marker only
 * exported `__version__`; the TS package additionally re-exports the stable
 * public modules so `import { Config } from 'andy'` works for embedders and
 * tests without reaching into file paths.
 *
 * Invariants:
 *  - VERSION is the single source of the version string (cli.ts owns it;
 *    package.json mirrors it — keep the three in step on release).
 *  - The ui/ components are deliberately NOT re-exported here: they pull in
 *    ink/react and the whole render tree, and a config-only consumer should
 *    not pay for them.
 */

export { VERSION, main } from './cli.js';
export * from './config.js';
export * from './theme.js';
export * from './termcolors.js';
export * from './termbg.js';
export * from './session.js';
export * from './sandbox.js';
// Namespaced: logfare also exports DEFAULT_BASE_URL (its own endpoint),
// which would collide with config's under a star re-export.
export * as logfare from './logfare.js';
export * from './sources.js';
export * from './update.js';
