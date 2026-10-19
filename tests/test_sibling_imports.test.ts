// Regression guard for the loadMods() bundling bug: every `sibling<T>(...)`
// call in ui/app.tsx MUST pass a literal `import('./x.js')` expression, never
// a bare string. esbuild/tsup can only rewrite a dynamic import's specifier
// to the real emitted chunk filename when it can see that literal directly
// at the import() call site — one layer of indirection (a wrapper taking the
// path as a string, calling import(specifier) itself) makes it invisible to
// the bundler, and the raw src-relative path survives unrewritten into the
// published dist. There, ANY real session failed instantly with
// ERR_MODULE_NOT_FOUND the moment the app tried to load its first sibling
// module — --version/--help/--list-models never reached that code path,
// which is how it shipped undetected.
//
// There is no ink-testing-library in this repo (installs of it are barred —
// see the several it.skip()s in test_phase4.test.ts), so there is no harness
// that renders AndyApp and actually calls loadMods(). This is the cheapest
// test that still catches the exact regression class: a static check on the
// source text, not a runtime render.
//
// Seen failing against the unfixed code: the pre-fix source had
// `sibling<ConfigModule>('../config.js')` — a bare string literal argument —
// for all ~32 call sites; this test's regex matches that shape and fails on
// it, confirmed before writing the fix in the same session this test was
// added.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_TSX = fileURLToPath(new URL('../src/ui/app.tsx', import.meta.url));

describe('ui/app.tsx — sibling() call sites must pass a literal import()', () => {
  it('finds at least the known sibling-module count, so the check is not vacuous', () => {
    const src = fs.readFileSync(APP_TSX, 'utf-8');
    const siblingCalls = src.match(/\bsibling<[^>]+>\(/g) ?? [];
    expect(siblingCalls.length).toBeGreaterThanOrEqual(30);
  });

  it('never passes a bare string literal to sibling<T>(...)', () => {
    const src = fs.readFileSync(APP_TSX, 'utf-8');
    // A bare-string call looks like: sibling<Foo>('../x.js') or sibling<Foo>("./x.js")
    // A correct call looks like:      sibling<Foo>(import('../x.js'))
    // Matching the bad shape directly, rather than asserting the good one,
    // is what makes this fail loudly against the exact regression instead of
    // just happening to pass on an unrelated refactor.
    const badCalls = src.match(/\bsibling<[^>]+>\(\s*['"]/g) ?? [];
    expect(badCalls).toEqual([]);
  });

  it('every sibling<T>(...) argument is itself a literal import(...) expression', () => {
    const src = fs.readFileSync(APP_TSX, 'utf-8');
    // Excludes the function definition itself (`sibling<T>(mod: Promise<unknown>)`)
    // and the doc-comment's own example text above it — neither is a call
    // site, and both have a `name: Type` shape a real call argument never
    // has (every real call passes either `import('./x.js')` or nothing).
    const siblingCalls = [...src.matchAll(/\bsibling<[^>]+>\(([^)]*)\)/g)].filter(
      ([, arg]) => !/^\s*\w+\s*:/.test(arg),
    );
    expect(siblingCalls.length).toBeGreaterThanOrEqual(30);
    for (const [whole, arg] of siblingCalls) {
      expect(arg.trim().startsWith("import('") || arg.trim().startsWith('import("')).toBe(
        true,
      );
      void whole;
    }
  });
});
