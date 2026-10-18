/**
 * scope-paste-screen.tsx — multi-line paste box for the scope validator.
 *
 * What this module is: the Ink port of zimzilla/ui/app.py's ScopePasteScreen.
 * The prompt is one row and would fold a pasted programme overview into a
 * single line, so this takes the paste as a multi-line buffer instead.
 * Invariants: ctrl+s submits the text (empty/whitespace submits as null),
 * escape cancels with null; while mounted it owns the keyboard.
 */

import { Box, Text, useInput, usePaste } from 'ink';
import { useRef, useState } from 'react';
import type { Palette } from '../app.js';

export interface ScopePasteScreenProps {
  palette: Palette;
  onSubmit: (text: string | null) => void;
}

const MAX_SHOWN = 18;

export function ScopePasteScreen(props: ScopePasteScreenProps) {
  const p = props.palette;
  const [lines, setLines] = useState<string[]>(['']);
  // Line + column cursor; kept in a ref because every keystroke moves it and
  // only the rendered slice needs a re-render.
  const cursor = useRef<{ row: number; col: number }>({ row: 0, col: 0 });
  const [, forceRender] = useState(0);

  const submit = () => {
    const text = lines.join('\n');
    props.onSubmit(text.trim() ? text : null);
  };

  // Bracketed paste arrives whole, newlines included — that is the entire
  // reason this screen exists, so it is handled before per-key logic.
  usePaste((text) => {
    const parts = text.split(/\r?\n/);
    setLines((prev) => {
      const next = [...prev];
      next[cursor.current.row] =
        (next[cursor.current.row] ?? '').slice(0, cursor.current.col) +
        parts[0];
      for (let i = 1; i < parts.length; i++) next.push(parts[i]);
      cursor.current = {
        row: next.length - 1,
        col: (next[next.length - 1] ?? '').length,
      };
      return next;
    });
  });

  useInput(
    (input, key) => {
      if (key.ctrl && input === 's') return submit();
      if (key.escape) return props.onSubmit(null);
      const cur = cursor.current;
      if (key.return) {
        setLines((prev) => {
          const next = [...prev];
          const row = next[cur.row] ?? '';
          const tail = row.slice(cur.col);
          next[cur.row] = row.slice(0, cur.col);
          next.splice(cur.row + 1, 0, tail);
          return next;
        });
        cursor.current = { row: cur.row + 1, col: 0 };
        forceRender((n) => n + 1);
      } else if (key.backspace || key.delete) {
        if (cur.col > 0) {
          setLines((prev) => {
            const next = [...prev];
            const row = next[cur.row] ?? '';
            next[cur.row] = row.slice(0, cur.col - 1) + row.slice(cur.col);
            return next;
          });
          cursor.current = { ...cur, col: cur.col - 1 };
          forceRender((n) => n + 1);
        } else if (cur.row > 0) {
          setLines((prev) => {
            const next = [...prev];
            const row = next[cur.row] ?? '';
            const above = next[cur.row - 1] ?? '';
            next[cur.row - 1] = above + row;
            next.splice(cur.row, 1);
            return next;
          });
          cursor.current = {
            row: cur.row - 1,
            col: (lines[cur.row - 1] ?? '').length,
          };
          forceRender((n) => n + 1);
        }
      } else if (key.upArrow && cur.row > 0) {
        cursor.current = { row: cur.row - 1, col: Math.min(cur.col, (lines[cur.row - 1] ?? '').length) };
        forceRender((n) => n + 1);
      } else if (key.downArrow && cur.row < lines.length - 1) {
        cursor.current = { row: cur.row + 1, col: Math.min(cur.col, (lines[cur.row + 1] ?? '').length) };
        forceRender((n) => n + 1);
      } else if (key.leftArrow && cur.col > 0) {
        cursor.current = { ...cur, col: cur.col - 1 };
        forceRender((n) => n + 1);
      } else if (key.rightArrow && cur.col < (lines[cur.row] ?? '').length) {
        cursor.current = { ...cur, col: cur.col + 1 };
        forceRender((n) => n + 1);
      } else if (input && input.length > 0 && !key.ctrl && !key.meta) {
        setLines((prev) => {
          const next = [...prev];
          const row = next[cur.row] ?? '';
          next[cur.row] = row.slice(0, cur.col) + input + row.slice(cur.col);
          return next;
        });
        cursor.current = { ...cur, col: cur.col + input.length };
        forceRender((n) => n + 1);
      }
    },
    { isActive: true },
  );

  const shown = lines.slice(-MAX_SHOWN);
  const offset = lines.length - shown.length;
  const cur = cursor.current;

  return (
    <Box flexDirection="column" alignItems="center">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={p.dim}
        backgroundColor={p.bg}
        paddingX={2}
        width="90%"
      >
        <Box marginBottom={1}>
          <Text color={p.primary}>
            {
              'Paste the whole programme overview — scope, out of scope, rules.'
            }
          </Text>
        </Box>
        <Box>
          <Text color={p.dim}>ctrl+s runs the validator · escape cancels</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, i) => {
            const rowIdx = offset + i;
            const isCursor = rowIdx === cur.row;
            const before = line.slice(0, isCursor ? cur.col : 0);
            const at = isCursor ? line[cur.col] ?? ' ' : '';
            const after = isCursor ? line.slice(cur.col + 1) : line;
            return (
              <Box key={rowIdx}>
                {isCursor ? (
                  <Text color={p.primary}>
                    {before}
                    <Text backgroundColor={p.accent} color={p.bg}>
                      {at}
                    </Text>
                    {after}
                  </Text>
                ) : (
                  <Text color={p.primary}>{line}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export default ScopePasteScreen;
