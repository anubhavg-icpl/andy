/**
 * tests/test_deliverable_ui.test.ts — app-level coverage for the deliverable
 * check (port of tests/test_deliverable_ui.py).
 *
 * What the Python file pins, and why it exists as a separate file:
 * tests/test_deliverable.py pins the logic inside Agent.runTurn; this file
 * pinned the half that logic cannot see — that /osint actually *declares* a
 * deliverable, and that _handle_event renders the two new events as the
 * operator's own sentence rather than leaving them to be inferred from the
 * transcript. The original failure was a run that printed "All phases
 * complete. Writing the report." and stopped, with nothing anywhere saying
 * the file was absent.
 *
 * Port status:
 *  - The four Python scenarios each drove the live Textual app through its
 *    pilot harness (`app.run_test`, a stubbed `agent._stream_once`, a call to
 *    `app._handle_command`, and a read of the rendered transcript). The Ink
 *    port has no equivalent surface: AndyApp builds its Agent inside the
 *    component (no stream-injection seam), `handleEvent`/`handleCommand`
 *    are closures inside the component (no query_one), and a raw stdin
 *    keystroke drive cannot even submit a slash command (the key router
 *    accepts a completion on Enter while the popup is open). Those four
 *    drives are therefore skipped below with per-test reasons — the same
 *    treatment tests/test_phase4.test.ts gives the other pilot drives.
 *  - What IS reachable here is pinned live: the deliverable *declaration*
 *    (test_osint.test.ts pins it end-to-end through the exported cmdOsint),
 *    the operator-facing event sentences at their source (the wiring the
 *    pilot was reading back), and the output-ceiling invariant.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '../src/config.js';

const APP_SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'ui',
    'app.tsx',
  ),
  'utf8',
);

/**
 * The shared reason the four pilot drives cannot be ported as-is. Inline in
 * each it.skip so the reason travels with the test it explains.
 */
const PILOT_GAP =
  'SKIP (port gap): the Python test drove the live Textual app — app.run_test, ' +
  'a stubbed agent._stream_once serving canned replies, app._handle_command(' +
  '"/osint ..."), and a read-back of the rendered #transcript. The Ink AndyApp ' +
  'has no equivalent: the Agent is constructed inside the component (no seam to ' +
  'stub the stream), handleEvent/handleCommand are closures inside the component ' +
  '(no query_one/pilot), and a raw stdin drive cannot submit a slash command ' +
  '(the key router accepts a completion on Enter while the popup is visible). ' +
  'Needs an app test seam (an agent-factory prop or an exported event renderer) ' +
  'owned by the ui/app lane.';

// ---------------------------------------------------------------------------
// The four pilot scenarios, skipped with their reasons
// ---------------------------------------------------------------------------

describe('test_a_missing_report_is_said_out_loud', () => {
  it.skip(
    'ui: a missing report is nudged to its budget, then named in the transcript — ' + PILOT_GAP,
    () => {
      // Python's pins: /osint creates the case dir; the narration-only model
      // is nudged to its budget (3 stream calls: narration + one per nudge);
      // "report.md was not written", "report.md was never written", and the
      // case-slug name all appear in the transcript; the failed run keeps its
      // case dir and nothing is archived under reports/.
    },
  );
});

describe('test_a_written_report_is_confirmed_and_finalised', () => {
  it.skip(
    'ui: a written report is confirmed in the transcript and the case finalised — ' + PILOT_GAP,
    () => {
      // Python's pins: two stream calls (write + done); "report.md written:"
      // appears and "was never written" does not; the report is archived
      // under reports/ and the bulky case dir is cleared.
    },
  );
});

describe('test_a_truncated_finish_is_named_as_truncation', () => {
  it.skip(
    'ui: a ceiling hit is named as truncation, with the number, and is NOT nudged — ' + PILOT_GAP,
    () => {
      // Python's pins: "truncated at <max_tokens>" in the transcript; exactly
      // one stream call (truncation must not be re-prompted — that would
      // spend another ceiling); no "was not written" nudge announce.
    },
  );
});

describe('test_an_empty_truncation_is_named_and_retried', () => {
  it.skip(
    'ui: an empty ceiling hit says "empty reply at N", names the raised retry, and retries — ' + PILOT_GAP,
    () => {
      // Python's pins: "empty reply at <max_tokens>", the doubled ceiling
      // named as what it is retrying with, "truncated at" NOT used (an empty
      // reply is not a mid-write cut), and exactly two stream calls.
    },
  );
});

// ---------------------------------------------------------------------------
// What is reachable: the sentences the pilot was reading back
// ---------------------------------------------------------------------------

describe('the event sentences the app renders (wiring)', () => {
  // These are the operator-facing strings the four skipped drives asserted
  // out of the rendered transcript. They live in AndyApp's handleEvent
  // (unexported), so the wiring is pinned at the source — the same idiom
  // tests/test_osint.test.ts uses for app-internal seams ("wiring:"). A
  // change to any sentence trips its pin here; the behavioural drive waits
  // on the app seam described in PILOT_GAP.

  it('wiring: a nudge is announced as "was not written — asking again"', () => {
    expect(APP_SRC.includes('was not written — asking again')).toBe(true);
  });

  it('wiring: a failed deliverable is stated plainly, with where it was expected', () => {
    expect(APP_SRC.includes('was never written — the turn ended without it')).toBe(true);
    expect(APP_SRC.includes('(expected at ${ev.path})')).toBe(true);
  });

  it('wiring: a written deliverable is confirmed with its path', () => {
    expect(APP_SRC.includes('`${ev.label} written: ${ev.path}`')).toBe(true);
  });

  it('wiring: truncation is named with the ceiling number', () => {
    expect(APP_SRC.includes('reply truncated at ${ev.maxTokens} output tokens')).toBe(true);
  });

  it('wiring: an empty truncation is named separately, with the raised retry', () => {
    // Named separately from `truncated` because the advice differs: nothing
    // the model asked for was dropped, so "the requested action may not have
    // run" would be a lie.
    expect(APP_SRC.includes('empty reply at ${fmtInt(ev.maxTokens)} output tokens')).toBe(true);
    expect(APP_SRC.includes('retrying with ${fmtInt(ev.retryTokens)}')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ceiling invariant the truncated-scenario polices
// ---------------------------------------------------------------------------

describe('the output ceiling is well clear of a real report', () => {
  it('the ceiling is well clear of a real report', () => {
    // The two archived reports on this box are 4880 and 6169 tokens; a
    // ceiling too close to that cuts a report mid-write, and the SDK then
    // discards the truncated tool call — leaving a transcript that looks
    // exactly like one where the model narrated instead of writing.
    expect(new Config().maxTokens).toBeGreaterThanOrEqual(32768);
  });
});
