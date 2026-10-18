/**
 * wave-overlay.tsx — the wave view: panes around a tracker rail (WaveOverlay).
 *
 * What this module is: the Ink port of zimzilla/ui/app.py's WaveOverlay — the
 * full-screen hunt visualiser for the duration of a wave. Invariants: the
 * drawing itself lives in ui/web.tsx (WaveWeb); this screen owns the repaint
 * timer, the size it paints at, and the keys. The repaint is timer-driven
 * (TICK = 0.25s) rather than event-driven because three things on it change
 * with no event: the elapsed clock, the flash fading off an agent, and the
 * spinner saying a quiet agent still works. Keys: escape closes the detail
 * drawer, ctrl+x asks the campaign to stop (the prompt is painted over here,
 * so /stop-hunt cannot be typed — see the Python docstring), arrows resize.
 * Ink has no mouse: click/hover handling from Textual is descoped.
 */

import { Box, useInput, useWindowSize } from 'ink';
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import type {
  ConfigLike,
  FindingDict,
  Palette,
  ToolsModule,
  WaveWebCtor,
  WaveWebLike,
} from '../app.js';

/** Repaint interval: fast enough that the spinner and flash read as live,
 * slow enough that a full-canvas redraw is not competing with the agents'
 * streaming for the render pass. */
const TICK = 0.25;

export interface WaveOverlayProps {
  target: string;
  palette: Palette;
  cfg: ConfigLike;
  tools: ToolsModule;
  /** The WaveWeb class from ui/web.tsx (loaded lazily by the app). */
  web: WaveWebCtor;
  wave?: number;
  size?: number;
  /** ctrl+x — the operator asked to end the campaign from the wave view. */
  onStop: () => void;
  ref?: Ref<WaveOverlayHandle>;
}

export interface WaveOverlayHandle {
  note(event: Record<string, unknown>): void;
}

export function WaveOverlay(props: WaveOverlayProps) {
  const { target, palette, cfg, tools, web: WaveWebCtorLocal } = props;
  const [tick, setTick] = useState(0);

  // One WaveWeb per overlay. Constructed once: it accumulates agent state for
  // the whole wave, so a re-render must never rebuild it.
  const webRef = useRef<WaveWebLike | null>(null);
  if (webRef.current === null) {
    webRef.current = new WaveWebCtorLocal(target, palette, {
      wave: props.wave ?? 1,
      size: props.size ?? 10,
    });
  }
  const web = webRef.current;

  // Timer-driven repaint (see contract block).
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK * 1000);
    return () => clearInterval(t);
  }, []);

  const { columns, rows } = useWindowSize();

  // One key router for the whole overlay: escape closes the detail drawer,
  // ctrl+x asks the campaign to stop, and the arrows resize — plain left/right
  // narrows/widens the rail, shift+left/right the drawer. Ink reports
  // modifiers on the key object, so route on that rather than on characters.
  useInput(
    (input, key) => {
      if (key.escape) {
        if (web.detail) web.closeDetail();
      } else if (key.ctrl && input === 'x') {
        // Idempotent, and the footer confirms the keypress at once (the stop
        // line the app writes goes to the transcript behind this overlay).
        web.stopping = true;
        props.onStop();
      } else if (key.leftArrow) {
        if (key.shift) web.resizeDrawer(-4);
        else web.resizeRail(-2);
      } else if (key.rightArrow) {
        if (key.shift) web.resizeDrawer(4);
        else web.resizeRail(2);
      }
    },
    { isActive: true },
  );

  const note = (event: Record<string, unknown>) => {
    const etype = String(event['type'] ?? '');
    // Every event a wave produces that has something to draw is handled here.
    // Three of these (hunt_plan_text, hunt_plan_tool, hunt_agent_result) were
    // dropped on the floor in an earlier Python revision — which is why the
    // panes showed a command and no output, and the planner's turn was blank.
    if (etype === 'hunt_plan') {
      web.setPlan((event['workers'] as unknown[]) ?? [], {
        wave: Number(event['wave'] ?? web.wave),
      });
    } else if (etype === 'hunt_agent_start') {
      web.agentStart(String(event['name'] ?? ''), String(event['brief'] ?? ''));
    } else if (etype === 'hunt_agent_tool') {
      // The command, not the summary: the summary is clipped to 70 columns for
      // a transcript line, and the whole point of the pane is that it has room
      // for the real command.
      web.agentActivity(
        String(event['name'] ?? ''),
        tools.summariseCall(
          String(event['tool'] ?? ''),
          (event['args'] as Record<string, unknown>) ?? {},
          cfg,
          400,
        ),
      );
    } else if (etype === 'hunt_agent_result') {
      web.agentResult(
        String(event['name'] ?? ''),
        tools.summariseCall(
          String(event['tool'] ?? ''),
          (event['args'] as Record<string, unknown>) ?? {},
          cfg,
          400,
        ),
        String(event['output'] ?? ''),
      );
    } else if (etype === 'hunt_agent_text') {
      web.agentText(String(event['name'] ?? ''), String(event['text'] ?? ''));
    } else if (etype === 'hunt_agent_done') {
      web.agentDone(String(event['name'] ?? ''), Boolean(event['ok']));
    } else if (etype === 'hunt_finding') {
      web.addFinding((event['finding'] as FindingDict) ?? {});
      // A finding landing is the one thing on this screen the operator is
      // watching for; repaint at once rather than waiting for the tick.
      setTick((n) => n + 1);
    } else if (etype === 'hunt_plan_text') {
      web.plannerText(String(event['text'] ?? ''));
    } else if (etype === 'hunt_plan_tool') {
      web.plannerTool(
        String(event['tool'] ?? ''),
        (event['args'] as Record<string, unknown>) ?? {},
        cfg,
      );
    } else if (etype === 'hunt_wave_end') {
      web.end();
    }
  };

  const noteRef = useRef(note);
  noteRef.current = note;
  useImperativeHandle(
    props.ref,
    () => ({ note: (ev: Record<string, unknown>) => noteRef.current(ev) }),
    [],
  );

  const canvas = useMemo(
    () => web.render(columns, rows),
    // Repaint on tick, on size change, and on every note() — via the tick
    // bump note() performs for findings. eslint-disable is implicit (no lint
    // in this repo); tick is the repaint driver by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, columns, rows, web],
  );

  return (
    <Box width="100%" height="100%" backgroundColor={palette.bg}>
      {canvas}
    </Box>
  );
}

export default WaveOverlay;
