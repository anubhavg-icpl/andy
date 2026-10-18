/**
 * src/ui — the andy terminal UI: boot screen, matrix rain, panels and the
 * main app.
 *
 * The Python package marker (andy/ui/__init__.py) was an empty
 * docstring; TypeScript needs no package markers (PORT-MAP row 43), so this
 * file is documentation only and deliberately re-exports nothing — import
 * directly from the module you need ('./banner.js', './rain.js',
 * './boot.jsx', ...). Keeping it empty of re-exports also avoids a barrel
 * that would eagerly pull every ui module (including app.tsx) into any
 * importer's graph.
 */

export {};
