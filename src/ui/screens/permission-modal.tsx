/**
 * permission-modal.tsx — confirmation overlay for gated tools (PermissionModal).
 *
 * What this module is: the Ink port of zimzilla/ui/app.py's PermissionModal
 * ModalScreen — a centred panel showing a tool call's preview and taking
 * yes/no/always. Invariant: while it is mounted it owns the keyboard (its
 * useInput is the only active one), so approval keystrokes like "y" never leak
 * into the prompt underneath. Dismisses by resolving onChoose exactly once.
 */

import { Box, Text, useInput } from 'ink';
import { useEffect, useRef } from 'react';
import type { Ref } from 'react';
import type { Preview } from '../../shared.js';
import type { Palette, RenderersModule } from '../app.js';

export interface PermissionModalProps {
  toolName: string;
  preview: Preview | null;
  palette: Palette;
  /** The loaded renderers module (R) — panels are its, not ours. */
  renderers: RenderersModule;
  /** One line naming what the call would touch. Empty string hides the row. */
  radius: string;
  /** How many more gated calls are queued this turn (0 hides the note). */
  remaining: number;
  onChoose: (value: 'yes' | 'no' | 'always') => void;
  ref?: Ref<unknown>;
}

export function PermissionModal(props: PermissionModalProps) {
  const { preview, palette: p, renderers: R, onChoose } = props;
  // Resolve once: the app's interrupt path can also answer the modal, and a
  // double resolve would be a silent no-op on a promise that already settled —
  // but guarding here keeps the keystroke path honest on its own.
  const settled = useRef(false);
  const choose = (value: 'yes' | 'no' | 'always') => {
    if (settled.current) return;
    settled.current = true;
    onChoose(value);
  };

  // Trap focus inside the modal so stray keys never reach the prompt: this is
  // the ONLY useInput with isActive while the modal is up (the app-level router
  // disables itself), which is the Ink equivalent of the Textual focus trap.
  useInput(
    (input, key) => {
      if (key.escape) return choose('no');
      if (key.return) return choose('yes');
      if (input === 'y') return choose('yes');
      if (input === 'n') return choose('no');
      if (input === 'a') return choose('always');
    },
    { isActive: true },
  );

  // The body: a diff preview renders as a diff panel; anything else as
  // output text. Decided once per mount, not per keystroke.
  let content: React.ReactNode = null;
  if (preview) {
    if (preview.kind === 'diff') {
      const verb = preview.title.split(' ', 2)[0] ?? '';
      const rest = preview.title.split(' ').slice(1).join(' ') || preview.title;
      content = R.diffPanel(rest, preview.body, p, verb);
    } else {
      content = R.renderOutputText(preview.body, p);
    }
  }

  useEffect(() => {
    // Nothing to mount beyond the render itself in Ink; kept as the seam the
    // Textual version used to focus the box first thing.
  }, []);

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={p.amber}
      backgroundColor={p.bg}
      paddingX={2}
      paddingY={1}
      width="84%"
    >
      <Box>
        <Text bold color={p.bg} backgroundColor={p.amber}>
          {'⚠ PERMISSION REQUIRED  '}
        </Text>
        <Text bold color={p.primary}>
          {'  ' + (preview ? preview.title : props.toolName)}
        </Text>
      </Box>
      {props.radius ? (
        <Box>
          <Text color={p.dim}>⌖ </Text>
          <Text color={p.amber}>{props.radius}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" maxHeight={24}>
        {content}
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold color={p.accent}>
            [y]
          </Text>
          <Text color={p.dim}> execute   </Text>
          <Text bold color={p.red}>
            [n]
          </Text>
          <Text color={p.dim}> deny      </Text>
          <Text bold color={p.primary}>
            [a]
          </Text>
          <Text color={p.dim}> always this session</Text>
        </Text>
      </Box>
      {props.remaining ? (
        <Box>
          <Text color={p.dim}>
            {`  (${props.remaining} more tool call(s) queued this turn)`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export default PermissionModal;
