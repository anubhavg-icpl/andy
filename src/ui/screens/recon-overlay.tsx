/**
 * recon-overlay.tsx — the live recon window (ReconOverlay).
 *
 * What this module is: the Ink port of zimzilla/ui/app.py's ReconOverlay — a
 * centred window narrating the recon phase (each tool call, the model's prose)
 * while it runs for minutes. Invariants: it is deliberately NOT a gate — no
 * keys, no dismiss — the prompt underneath stays live so /stop-hunt remains
 * typeable while it is up; the app pops it when recon ends. The activity tail
 * is bounded (200 lines kept, last 40 shown) because a recon run makes dozens
 * of calls and the window only has room for the last few.
 */

import { Box, Text } from 'ink';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { ConfigLike, Palette, ToolsModule } from '../app.js';

export interface ReconEvent {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  blocked?: boolean;
  text?: string;
}

export interface ReconOverlayProps {
  target: string;
  palette: Palette;
  cfg: ConfigLike;
  tools: ToolsModule;
  ref?: Ref<ReconOverlayHandle>;
}

export interface ReconOverlayHandle {
  note(event: ReconEvent): void;
}

/** A styled line of the recon log: segments rendered in order. */
type LogLine = Array<{ text: string; color: string; bold?: boolean }>;

export function ReconOverlay(props: ReconOverlayProps) {
  const { target, palette: p, cfg, tools } = props;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [calls, setCalls] = useState(0);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Elapsed clock repaints on a timer because the count changes with no event.
  useEffect(() => {
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  const push = (line: LogLine) => {
    // Bounded tail: keep the last 200, show the last 40 (see contract block).
    setLines((prev) => [...prev, line].slice(-200));
  };

  const note = (event: ReconEvent) => {
    const kind = event.type;
    if (kind === 'hunt_recon_tool') {
      const n = calls + 1;
      setCalls(n);
      const tool = event.tool ?? '?';
      let detail = tools.summariseCall(tool, event.args ?? {}, cfg);
      if (detail.length > 72) detail = detail.slice(0, 71) + '…';
      push([
        { text: `  ${String(n).padStart(3)}  `, color: p.dim },
        {
          text: event.blocked ? '✗ ' : '▸ ',
          color: event.blocked ? p.red : p.accent,
        },
        { text: tool.padEnd(12), color: p.primary, bold: true },
        { text: detail, color: p.dim },
      ]);
    } else if (kind === 'hunt_recon_text') {
      const text = (event.text ?? '').trim();
      if (text) {
        push([
          { text: '       ', color: p.dim },
          { text, color: p.primary },
        ]);
      }
    }
  };

  // Stable imperative handle so the app's hunt worker can feed events in
  // without this component re-mounting per batch.
  const noteRef = useRef(note);
  noteRef.current = note;
  useImperativeHandle(
    props.ref,
    () => ({ note: (ev: ReconEvent) => noteRef.current(ev) }),
    [],
  );

  return (
    <Box flexDirection="column" alignItems="center">
      <Box
        flexDirection="column"
        borderStyle="bold"
        borderColor={p.accent}
        backgroundColor={p.bg}
        paddingX={2}
        paddingY={1}
        width="72%"
      >
        <Box>
          <Text bold color={p.bg} backgroundColor={p.accent}>
            {'  ⟩ RECON  '}
          </Text>
          <Text color={p.dim}>{'  mapping '}</Text>
          <Text bold color={p.primary}>
            {target}
          </Text>
        </Box>
        <Box>
          <Text color={p.dim}>{'  '}</Text>
          <Text color={p.primary}>{`${calls} call${calls !== 1 ? 's' : ''}`}</Text>
          <Text color={p.dim}>{'   ·   '}</Text>
          <Text color={p.primary}>
            {`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}
          </Text>
          <Text color={p.dim}>{'   ·   '}</Text>
          <Text bold color={p.accent}>
            working
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1} maxHeight={20}>
          {lines.slice(-40).map((line, i) => (
            <Box key={i}>
              {line.map((seg, j) => (
                <Text key={j} color={seg.color} bold={seg.bold}>
                  {seg.text}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

export default ReconOverlay;
