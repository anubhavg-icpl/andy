/**
 * findings-panel.tsx — the hunt finding tracker window (FindingsPanel).
 *
 * What this module is: the Ink port of zimzilla/ui/app.py's FindingsPanel —
 * a worst-first list of everything the engagement found, floating over the
 * shell. Invariants: it is a view, not a gate — escape (or /findings again,
 * which the app handles) closes it. While it is up the prompt underneath is
 * not reachable (the app disables its input router), and ctrl+c — a priority
 * binding that lives on the app, not here — is the way to interrupt from it.
 * There is deliberately no click-to-dismiss: a click inside the panel would
 * close the window the moment the operator clicked a finding to read it.
 */

import { Box, Text, useInput } from 'ink';
import type { FindingDict, Palette, RenderersModule } from '../app.js';

export interface FindingsPanelProps {
  palette: Palette;
  target: string;
  /** Whether a campaign is still running, so the header says LIVE vs a
   * finished campaign read back off disk. */
  live: boolean;
  findings: FindingDict[];
  renderers: RenderersModule;
  onClose: () => void;
}

export function FindingsPanel(props: FindingsPanelProps) {
  const { palette: p, target, live, findings, renderers: R } = props;

  useInput(
    (input, key) => {
      if (key.escape) props.onClose();
    },
    { isActive: true },
  );

  let body: React.ReactNode;
  if (!findings.length) {
    body = (
      <Box flexDirection="column">
        <Text color={p.dim}>{'\n  nothing confirmed yet.\n'}</Text>
        <Text color={p.dim}>
          {
            '  A finding appears here the moment an agent reports one —\n  a title, the asset, and the evidence that proves it.\n'
          }
        </Text>
      </Box>
    );
  } else {
    body = (
      <Box flexDirection="column">
        {findings.map((f, i) => (
          <Box key={i} flexDirection="column">
            {i > 0 ? <Text>{'\n'}</Text> : null}
            {R.findingLine(f, p)}
            {R.findingDetail(f, p)}
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Box
        flexDirection="column"
        borderStyle="bold"
        borderColor={p.accent}
        backgroundColor={p.bg}
        paddingX={2}
        paddingY={1}
        width="84%"
      >
        <Box>
          <Text bold color={p.bg} backgroundColor={p.accent}>
            {'  ⟩ FINDINGS  '}
          </Text>
          <Text color={p.dim}>{'  '}</Text>
          <Text bold color={p.primary}>
            {target || '?'}
          </Text>
          <Text color={p.dim}>{'   '}</Text>
          <Text bold color={p.primary}>
            {String(findings.length)}
          </Text>
          <Text color={p.dim}> found</Text>
          {live ? (
            <Text>
              <Text color={p.dim}>{'   ·   '}</Text>
              <Text bold color={p.accent}>
                LIVE
              </Text>
            </Text>
          ) : null}
          <Text color={p.dim}>{'      [esc] close'}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1} maxHeight={28}>
          {body}
        </Box>
      </Box>
    </Box>
  );
}

export default FindingsPanel;
