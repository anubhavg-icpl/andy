/**
 * markdown.ts — assistant markdown, rendered as the thing it describes.
 *
 * A model answers in markdown whether or not anything asked it to: `#` for a
 * heading, `**` for emphasis, a dash and a space for a bullet, a fenced block
 * for code, a pipe grid for a table. Rendering the markdown instead of showing
 * its source is the whole point of this module. The parse is markdown-it's,
 * not a regex of ours, and that is the load-bearing choice: a regex that pairs
 * `**` sees the asterisks in `26*26**5*100` — mask syntax, the sort of thing a
 * pentest answer is full of — and eats them, and a glob of double-asterisks
 * and a `.py` inside backticks must stay a glob, which only a parser that
 * knows about code spans can promise.
 *
 * Invariants:
 *  - Two entry points, because the streaming path cannot afford the other one:
 *    `markdownText` (flat styled text; called once per text_delta; parse and
 *    build, no layout) and `markdownRenderable` (once per turn, when the
 *    answer is finished; fenced code comes back highlighted and tables as a
 *    real wrapping grid).
 *  - Output is React nodes for Ink. `markdownText` yields only <Text> nodes
 *    (safe anywhere a string is); `markdownRenderable` may contain <Box>
 *    (tables) — mount it under a Box, not a Text.
 *  - `Palette` below is the structural shape of theme.Palette (theme.ts is
 *    ported in a parallel lane); any palette with these fields satisfies it,
 *    so ui code can pass a theme palette straight through.
 */

import { createElement, type ReactNode } from "react";
import { Box, Text } from "ink";
import MarkdownIt from "markdown-it";
import type { Palette } from "../theme.js";

// === SECTION === parser + styled-text model ===

type MdToken = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

/** `commonmark` for the spec, plus the two extensions a model actually uses:
 *  `table` is a GitHub extension rather than CommonMark proper and answers are
 *  full of them; `strikethrough` costs nothing and a model that writes
 *  `~~retired~~` means it. */
const PARSER = new MarkdownIt("commonmark").enable("table").enable("strikethrough");

/** A fence's info string, first word only (python title="x" means python). */
const INFO_RE = /^\s*([\w+.#-]*)/;

/** Rules under a heading. A fixed run rather than the heading's own length: a
 *  heading is short and the rule is a separator, not an underline, so it should
 *  read the same under every heading on the page. */
const RULE_WIDTH = 44;

const RULE = "─".repeat(RULE_WIDTH);

/** One styled run of text. The Rich `Text` had spans; Ink has nested <Text>
 *  props, so a run IS the span, built at append time. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  color?: string;
}

/** Parse a Rich-style style string ("bold #00ff41", "italic", "#0b6e2a"). */
function parseStyle(style: string): Omit<Run, "text"> {
  const out: Omit<Run, "text"> = {};
  for (const tok of style.trim().split(/\s+/)) {
    if (!tok) continue;
    if (tok === "bold") out.bold = true;
    else if (tok === "italic") out.italic = true;
    else if (tok === "strike" || tok === "strikethrough") out.strike = true;
    else if (tok === "underline") out.underline = true;
    else if (!out.color) out.color = tok;
  }
  return out;
}

/** The flat styled-string this module's callers pass around (the Rich `Text`
 *  equivalent): append-only, splittable, convertible to React nodes. */
class StyledText {
  runs: Run[] = [];

  append(text: string, style = ""): this {
    if (!text) return this;
    this.runs.push({ text, ...parseStyle(style) });
    return this;
  }

  appendText(other: StyledText): this {
    this.runs.push(...other.runs);
    return this;
  }

  get plain(): string {
    return this.runs.map((r) => r.text).join("");
  }

  /** Split on a separator that may fall inside runs, carrying each run's
   *  style onto the pieces (quote bodies and one-line flattening need this). */
  split(sep: string): StyledText[] {
    const out: StyledText[] = [new StyledText()];
    for (const run of this.runs) {
      const pieces = run.text.split(sep);
      pieces.forEach((piece, i) => {
        if (i > 0) out.push(new StyledText());
        if (piece) out[out.length - 1].runs.push({ ...run, text: piece });
      });
    }
    return out;
  }
}

// === SECTION === inline: emphasis, code, links ===

/** The token stream of one inline run, as styled text.
 *
 * Style is carried on a stack rather than recomputed per token, so nested
 * markup composes — `**bold with `code` inside**` keeps the code span's own
 * colour and inherits nothing that would fight it.
 */
function inlineTokens(children: MdToken[] | null, palette: Palette, base = ""): StyledText {
  const t = new StyledText();
  const stack: string[] = [];
  // Hrefs of the links currently open, innermost last. The href lives on
  // `link_open` and the closing token carries nothing, so it has to be held
  // from the open until the close to be emitted after the label.
  const hrefs: string[] = [];

  const style = (): string => {
    const parts = [...stack];
    if (base) parts.push(base);
    return parts.length ? parts.join(" ") : palette.primary;
  };

  for (const tok of children ?? []) {
    const kind = tok.type;
    if (kind === "text" || kind === "text_special") {
      // text_special (escaped chars/entities) is folded in as text: dropping
      // it, as a literal port of the Python did, would swallow `\*` escapes.
      t.append(tok.content, style());
    } else if (kind === "code_inline") {
      // Its own style, and deliberately not the inherited one: a code span
      // inside bold should still read as a code span.
      t.append(tok.content, `bold ${palette.accent}`);
    } else if (kind === "strong_open") {
      stack.push("bold");
    } else if (kind === "em_open") {
      stack.push("italic");
    } else if (kind === "s_open") {
      stack.push("strike");
    } else if (kind === "strong_close" || kind === "em_close" || kind === "s_close") {
      if (stack.length) stack.pop();
    } else if (kind === "link_open") {
      stack.push(`underline ${palette.accent}`);
      hrefs.push(String(tok.attrGet("href") ?? ""));
    } else if (kind === "link_close") {
      if (stack.length) stack.pop();
      // The href is the reason a link is worth having in a pentest report,
      // and it is invisible once the label is all that shows. Read from the
      // *open* — link_close carries no attrs at all.
      const href = hrefs.length ? hrefs.pop()! : "";
      if (href) t.append(` <${href}>`, palette.dim);
    } else if (kind === "softbreak") {
      t.append(" ", style());
    } else if (kind === "hardbreak") {
      t.append("\n", style());
    } else if (kind === "image") {
      // No image protocol here; name it so the operator knows one was there
      // rather than silently dropping it.
      const src = tok.attrGet("src") ?? "";
      const alt = (tok.children ?? []).map((c) => c.content).join("");
      t.append(`[image: ${alt || src}]`, palette.dim);
    } else if (kind === "html_inline") {
      t.append(tok.content, palette.dim);
    }
  }
  return t;
}

// === SECTION === blocks ===

/** A heading, sized by level the only way a terminal can size anything.
 *  The inline body is flattened and restyled, exactly as the Python did. */
function headingText(level: number, body: StyledText, palette: Palette): StyledText {
  const t = new StyledText();
  if (level === 1) {
    t.append(body.plain.toUpperCase(), `bold ${palette.accent}`);
    t.append("\n");
    t.append(RULE, palette.dim);
  } else if (level === 2) {
    t.append(body.plain, `bold ${palette.accent}`);
    t.append("\n");
    t.append(RULE, palette.dim);
  } else {
    // h3 and deeper are structure inside a section, not a new section — a
    // marker keeps them findable without competing with the h1/h2 rule.
    t.append("#".repeat(level) + " ", palette.dim);
    t.append(body.plain, `bold ${palette.primary}`);
  }
  return t;
}

/** A blockquote: a bar down the left, the same bar the transcript uses. */
function quoteBlock(body: StyledText, palette: Palette): StyledText {
  const t = new StyledText();
  body.split("\n").forEach((line, n) => {
    if (n) t.append("\n");
    t.append("▌ ", palette.dim);
    t.appendText(line);
  });
  return t;
}

// === SECTION === fenced code (the "rich" half) ===

/**
 * The syntax colour map renderers' hackerSyntax uses, for fenced code.
 *
 * Duplicated deliberately rather than imported: renderers imports this module,
 * so importing back would be a cycle. The two must stay in step — a fenced
 * block in an answer and a tool's output should read the same. There is no
 * pygments in the TS stack, so highlighting is a conservative tokenizer over
 * the same colour map: comments, strings, numbers and a common keyword set.
 * Wrong guesses only recolour a word, never change the text.
 */
function monoTheme(palette: Palette) {
  return {
    base: palette.primary,
    comment: palette.dim,
    keyword: palette.accent,
    str: palette.amber,
    number: palette.accent,
  };
}

/** `#` starts a comment in these languages (and bare text); `//` in the rest. */
const HASH_COMMENT_LANGS = new Set([
  "", "text", "bash", "sh", "shell", "zsh", "fish", "python", "py", "python3",
  "yaml", "yml", "toml", "ini", "conf", "ruby", "rb", "r", "perl", "makefile",
  "dockerfile", "powershell", "ps1",
]);
const SLASH_COMMENT_LANGS = new Set([
  "js", "javascript", "ts", "typescript", "tsx", "jsx", "c", "cpp", "c++",
  "cc", "h", "hpp", "go", "golang", "java", "rust", "rs", "swift", "kotlin",
  "kt", "http", "php", "dart", "scala",
]);
const KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
  "esac", "def", "function", "return", "import", "from", "class", "const",
  "let", "var", "export", "async", "await", "new", "this", "self", "try",
  "except", "catch", "finally", "throw", "raise", "pass", "with", "not",
  "and", "or", "true", "false", "null", "none", "True", "False", "None",
  "NULL", "echo", "exit", "local", "yield", "break", "continue", "switch",
  "fn", "pub", "use", "struct", "impl", "enum", "interface", "type",
]);

/** One code line as coloured runs. Base colour carries everything the
 *  tokenizer does not claim, so unhighlighted code still reads as code.
 *  keyBase offsets the element keys so multi-line blocks stay unique. */
function highlightLine(line: string, lang: string, palette: Palette, keyBase = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const th = monoTheme(palette);
  const alts: string[] = [];
  if (HASH_COMMENT_LANGS.has(lang)) alts.push("(#[^\\n]*)");
  else if (SLASH_COMMENT_LANGS.has(lang)) alts.push("((?<![:\\w])//[^\\n]*)");
  alts.push('("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)');
  alts.push("(\\b\\d+(?:\\.\\d+)?\\b)");
  alts.push("([A-Za-z_][A-Za-z0-9_]*)");
  const re = new RegExp(alts.join("|"), "g");
  let last = 0;
  let k = keyBase;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(line.slice(last, m.index));
    const full = m[0];
    const comment = m[1];
    const str = m[2];
    const num = m[3];
    const word = m[4];
    if (comment !== undefined) out.push(createElement(Text, { key: k++, color: th.comment }, full));
    else if (str !== undefined) out.push(createElement(Text, { key: k++, color: th.str }, str));
    else if (num !== undefined) out.push(createElement(Text, { key: k++, color: th.number }, num));
    else if (word !== undefined && KEYWORDS.has(word))
      out.push(createElement(Text, { key: k++, bold: true, color: th.keyword }, word));
    else out.push(full);
    last = m.index + full.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out.length ? out : [line];
}

/** A fenced block as React nodes: highlighted, no box — the answer is prose,
 *  and boxing every snippet would bury it. Ink <Text> wraps long lines, which
 *  is the word_wrap the Syntax renderable gave us. The wrapper carries the
 *  theme's base colour so untokenised code stays palette.primary. */
function codeBlockReact(code: string, lang: string, palette: Palette): ReactNode {
  const kids: ReactNode[] = [];
  let keyBase = 0;
  code.replace(/\n+$/, "").split("\n").forEach((line, i) => {
    if (i) kids.push("\n");
    const runs = highlightLine(line, lang, palette, keyBase);
    keyBase += runs.length;
    kids.push(...runs);
  });
  return createElement(Text, { color: monoTheme(palette).base }, ...kids);
}

/** A fenced block flattened to plain text for the streaming path. */
function codeFlat(code: string, palette: Palette): StyledText {
  const t = new StyledText();
  code.split("\n").forEach((line, n) => {
    if (n) t.append("\n");
    t.append(line, palette.primary);
  });
  return t;
}

// === SECTION === tables ===

/**
 * A pipe table for the flat path: bold-accent header, two-space gaps. The
 * rich path is a real grid (below) for one reason — a flat aligned text
 * cannot wrap a cell to the width it is given, so a long cell would push the
 * transcript sideways on a narrow terminal; Box-wrapped columns do wrap.
 */
function tableFlat(header: StyledText[], rows: StyledText[][], palette: Palette): StyledText {
  const t = new StyledText();
  header.forEach((cell, n) => {
    if (n) t.append("  ", palette.dim);
    t.append(cell.plain, `bold ${palette.accent}`);
  });
  for (const row of rows) {
    t.append("\n");
    row.forEach((cell, n) => {
      if (n) t.append("  ", palette.dim);
      t.append(cell.plain, palette.primary);
    });
  }
  return t;
}

/** Ragged rows are legal markdown and common in a streamed answer; pad and
 *  trim so every row has the header's arity. */
function fitRow(row: StyledText[], width: number): StyledText[] {
  const cells = [...row];
  while (cells.length < width) cells.push(new StyledText());
  return cells.slice(0, width);
}

/** The rich table: header bold-accent, body primary, two-space gaps, each
 *  column a fixed-width Box whose cells wrap. */
function tableReact(header: StyledText[], rows: StyledText[][], palette: Palette): ReactNode {
  const width = header.length || 1;
  const headCells = fitRow(header, width);
  const bodyCells = rows.map((r) => fitRow(r, width));
  const all = [headCells, ...bodyCells];
  const colW: number[] = [];
  for (let c = 0; c < width; c++) colW[c] = Math.max(1, ...all.map((row) => row[c]?.plain.length ?? 0));

  const rowNode = (cells: StyledText[], ri: number, head: boolean): ReactNode =>
    createElement(
      Box,
      { key: ri, flexDirection: "row" },
      ...cells.flatMap((cell, ci) => {
        const gap = ci ? [createElement(Box, { key: `g${ci}`, width: 2 })] : [];
        const base = head ? `bold ${palette.accent}` : palette.primary;
        return [...gap, createElement(Box, { key: `c${ci}`, width: colW[ci] }, runsToReact(cell, base))];
      }),
    );

  return createElement(
    Box,
    { flexDirection: "column" },
    rowNode(headCells, 0, true),
    ...bodyCells.map((r, i) => rowNode(r, i + 1, false)),
  );
}

// === SECTION === the block walk ===

/** One parsed block: flat styled text, or a rich node (highlighted code /
 *  wrapping table) only the renderable path asks for. */
type Block = { kind: "text"; text: StyledText } | { kind: "node"; node: ReactNode };

interface ListFrame {
  ordered: boolean;
  n: number;
  items: [string, StyledText][];
}

/** The token stream, as a list of blocks — one per block-level element.
 *
 * Open lists are held in a frame stack and emitted at their close, when their
 * depth is finally known; an item's own paragraph is captured into the list
 * (item_depth) rather than also emitted as a standalone block.
 */
function parse(text: string, palette: Palette, rich: boolean): Block[] {
  const blocks: Block[] = [];
  const lists: ListFrame[] = [];
  let itemDepth = 0;
  let quoteDepth = 0;

  const quoted = (body: StyledText): StyledText => (quoteDepth ? quoteBlock(body, palette) : body);

  const tokens = PARSER.parse(text, {});
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const kind = tok.type;

    if (kind === "heading_open") {
      const level = parseInt(tok.tag.slice(1), 10);
      const body = inlineTokens(tokens[i + 1].children, palette);
      blocks.push({ kind: "text", text: headingText(level, body, palette) });
      i += 3;
      continue;
    }

    if (kind === "hr") {
      blocks.push({ kind: "text", text: new StyledText().append(RULE, palette.dim) });
      i += 1;
      continue;
    }

    if (kind === "fence" || kind === "code_block") {
      const lang = INFO_RE.exec(tok.info ?? "")?.[1] || "text";
      const code = tok.content;
      blocks.push(
        rich
          ? { kind: "node", node: codeBlockReact(code, lang, palette) }
          : { kind: "text", text: codeFlat(code, palette) },
      );
      i += 1;
      continue;
    }

    if (kind === "blockquote_open") {
      quoteDepth += 1;
      i += 1;
      continue;
    }
    if (kind === "blockquote_close") {
      quoteDepth -= 1;
      i += 1;
      continue;
    }

    if (kind === "bullet_list_open" || kind === "ordered_list_open") {
      lists.push({
        ordered: kind.startsWith("ordered"),
        n: parseInt(String(tok.attrGet("start") ?? "1"), 10) || 1,
        items: [],
      });
      i += 1;
      continue;
    }

    if (kind === "bullet_list_close" || kind === "ordered_list_close") {
      const frame = lists.pop()!;
      const depth = lists.length;
      const body = new StyledText();
      frame.items.forEach(([marker, item], n) => {
        if (n) body.append("\n");
        body.append("  ".repeat(depth), palette.dim);
        body.append(marker, palette.accent);
        body.appendText(item);
      });
      if (lists.length) {
        // A nested list belongs to the item it sits under. Emitting it as its
        // own block would strand it above the parent list.
        const top = lists[lists.length - 1];
        if (top.items.length) {
          const parent = top.items[top.items.length - 1][1];
          for (const line of body.split("\n")) {
            parent.append("\n");
            parent.appendText(line);
          }
        }
      } else {
        blocks.push({ kind: "text", text: quoted(body) });
      }
      i += 1;
      continue;
    }

    if (kind === "list_item_open") {
      itemDepth += 1;
      i += 1;
      continue;
    }
    if (kind === "list_item_close") {
      itemDepth -= 1;
      i += 1;
      continue;
    }

    if (kind === "table_open") {
      const header: StyledText[] = [];
      const rows: StyledText[][] = [];
      let row: StyledText[] = [];
      let inHead = false;
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== "table_close") {
        const inner = tokens[j].type;
        if (inner === "thead_open") inHead = true;
        else if (inner === "thead_close") inHead = false;
        else if (inner === "inline") {
          const cell = inlineTokens(tokens[j].children, palette);
          if (inHead) header.push(cell);
          else row.push(cell);
        } else if (inner === "tr_close" && !inHead) {
          rows.push(row);
          row = [];
        }
        j += 1;
      }
      if (row.length) rows.push(row);
      blocks.push(
        rich
          ? { kind: "node", node: tableReact(header, rows, palette) }
          : { kind: "text", text: tableFlat(header, rows, palette) },
      );
      i = j + 1;
      continue;
    }

    if (kind === "inline") {
      if (itemDepth) {
        // Inside a list item: capture it as the item's text. The list frame
        // is what emits it, at list close.
        if (lists.length) {
          const frame = lists[lists.length - 1];
          const marker = frame.ordered ? `${frame.n}. ` : "• ";
          if (frame.ordered) frame.n += 1;
          frame.items.push([marker, inlineTokens(tok.children, palette)]);
        }
        i += 1;
        continue;
      }
      blocks.push({ kind: "text", text: quoted(inlineTokens(tok.children, palette)) });
      i += 1;
      continue;
    }

    i += 1;
  }

  return blocks;
}

// === SECTION === React conversion ===

function runToReact(run: Run, base: Omit<Run, "text">, key: number): ReactNode {
  const bold = run.bold || base.bold;
  const italic = run.italic || base.italic;
  const strike = run.strike || base.strike;
  const underline = run.underline || base.underline;
  const color = run.color ?? base.color;
  if (!bold && !italic && !strike && !underline && !color) return run.text;
  return createElement(
    Text,
    {
      key,
      bold: bold || undefined,
      italic: italic || undefined,
      strikethrough: strike || undefined,
      underline: underline || undefined,
      color,
    },
    run.text,
  );
}

/** StyledText to React nodes. `base` is the enclosing default style (the rich
 *  table passes one); runs keep their own styling on top of it. */
function runsToReact(t: StyledText, base = ""): ReactNode {
  if (!t.runs.length) return null;
  const b = parseStyle(base);
  if (t.runs.length === 1) return runToReact(t.runs[0], b, 0);
  return createElement(Text, null, ...t.runs.map((r, i) => runToReact(r, b, i)));
}

/** The parse joined into one flat StyledText (the streaming text form). */
function flatText(text: string, palette: Palette): StyledText {
  const blocks = parse(text, palette, false);
  if (!blocks.length) return new StyledText();
  const out = new StyledText();
  blocks.forEach((b, n) => {
    if (n) out.append("\n\n");
    out.appendText(b.kind === "text" ? b.text : new StyledText());
  });
  return out;
}

// === SECTION === entry points ===

/** Assistant prose as flat styled text nodes, markdown resolved.
 *
 * The streaming path: called on every delta, so it stops at flat text and
 * never builds a table grid or highlights code. Returns only <Text> nodes,
 * safe to mount under another <Text>.
 */
export function markdownText(text: string, palette: Palette): ReactNode {
  return runsToReact(flatText(text, palette));
}

/** Assistant prose for the transcript: tables and code included.
 *
 * Returns a single node for the common case — most answers are one block —
 * and a column of blocks when the answer has more than one, so a table or a
 * highlighted block can sit between the prose rather than being flattened
 * into it. May contain <Box> (tables): mount under a Box.
 */
export function markdownRenderable(text: string, palette: Palette): ReactNode {
  const blocks = parse(text, palette, true);
  if (!blocks.length) return null;
  const nodeOf = (b: Block, i: number): ReactNode =>
    b.kind === "text"
      ? createElement(Text, { key: i }, runsToReact(b.text))
      : b.node;
  if (blocks.length === 1) return nodeOf(blocks[0], 0);
  const kids: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (i) kids.push(createElement(Text, { key: `sep${i}` }, "")); // blank line between blocks
    kids.push(nodeOf(b, i));
  });
  return createElement(Box, { flexDirection: "column" }, ...kids);
}

/** Markdown flattened onto *one* line, for a prefixed worker line.
 *
 * `agentLine` puts a `[name]` tag in front of a worker's prose, and a tag only
 * means anything if the text it labels starts where the tag ends. Blank lines
 * collapse and line breaks become separators, so a worker's markdown reads as
 * the one-line brief it is.
 */
export function markdownLine(text: string, palette: Palette): ReactNode {
  const t = flatText(text, palette);
  const out = new StyledText();
  let written = 0;
  for (const line of t.split("\n")) {
    if (!line.plain.trim()) {
      // Blank lines collapse rather than becoming a gap. A worker's markdown
      // is a brief, not a document, and an empty line here would be a break
      // the tag above it does not label.
      continue;
    }
    if (written) out.append("  ", palette.dim);
    out.appendText(line);
    written += 1;
  }
  return runsToReact(out);
}
