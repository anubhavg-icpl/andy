/**
 * campaigns.tsx — the campaign workers: /team, /osint, /osint-tree, /phish,
 * /scope-validator, /bug-hunt, /crack, /ad and the hunt engine behind them
 * (split from app.tsx once it passed ~3k lines).
 *
 * What this module is: every long-running worker that is NOT a plain agent
 * turn. Invariants: the hunt engine publishes its run object BEFORE the loop
 * starts (so /stop-hunt and /summary-hunt can see it for the whole campaign);
   * overlays are raised and dropped by identity slots (recon / wave / findings)
   * so a stop or crash mid-wave cannot strand one over a dead campaign; the
   * closing on_finish callback runs from the worker's own finally, because a
   * caller-wrapped try/finally would fire it the instant the worker was
   * scheduled, long before a single agent ran.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { Deliverable } from '../../shared.js';
import type {
  AppCtx,
  AdToolProbe,
  AdVerdict,
  ConfigLike,
  CrackDetected,
  FindingDict,
  HuntEvent,
  HuntRunLike,
  StopSignal,
} from '../app.js';
import { dedupe, errName, fmtInt, hostOfFallback } from '../app.js';
import { parseCrackArgs } from '../app.js';

/** asyncio.Event stand-in: the stop flag /stop-hunt sets mid-wave. */
function createSignal(): StopSignal {
  let flag = false;
  return {
    isSet: () => flag,
    set: () => {
      flag = true;
    },
  };
}

/** shutil.which() equivalent — enough for the one binary /crack requires. */
function hasBinary(name: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter);
  return dirs.some((d) => d && fsSync.existsSync(path.join(d, name)));
}

/** The host half of a scope-validator asset string. sv.hostOf is private
 * upstream (Python `_host_of`), so fall back to a local extraction. */
function hostOf(ctx: AppCtx, asset: string): string {
  const sv = ctx.mods()?.scopeValidator;
  if (sv?.hostOf) return sv.hostOf(asset);
  return hostOfFallback(asset);
}

/** One model turn with no tools, returning only its text. */
async function collectPlain(ctx: AppCtx, prompt: string): Promise<string> {
  const parts: string[] = [];
  // A plan-mode copy of the config: {...cfg} keeps the method and every field.
  const planner = ctx.teamAgentFactory({ ...ctx.cfg, mode: 'plan' });
  for await (const ev of planner.runTurn(prompt)) {
    if (ev.type === 'text_delta') parts.push(ev.text);
  }
  return parts.join('');
}

// === SECTION === /team ==============================================================

export function cmdTeam(ctx: AppCtx, args: string[]): void {
  // Long-running, so it runs as a worker rather than inline.
  const task = args.join(' ').trim();
  if (!task) {
    ctx.sysLine('usage: /team <task>', true);
    return;
  }
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  void runTeamWorker(ctx, task);
}

async function runTeamWorker(ctx: AppCtx, task: string): Promise<void> {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const p = ctx.pal();
  const myGen = ctx.nextWorkerGen();
  const isCurrent = () => ctx.isCurrentWorker(myGen);

  ctx.setBusyBoth(true);
  ctx.cancelledRef.current = false;
  ctx.setRainBoth(false);
  ctx.teamTokensRef.current = [0, 0, 0]; // fresh run, fresh team totals

  // name -> colour. Built from the roster so a worker keeps one colour for its
  // whole run, and every one of its lines is tagged with it.
  const colors = new Map<string, string>();
  const counter = { running: 0, total: 0 };

  const onEvent = (ev: Record<string, unknown>) => {
    if (ctx.cancelledRef.current) return;
    const etype = String(ev['type'] ?? '');

    if (etype === 'team_plan') {
      const workers = (ev['workers'] as { name: string }[]) ?? [];
      workers.forEach((w, i) => colors.set(w.name, m.theme.agentColor(i, p)));
      counter.total = workers.length;
      if (ev['summary']) ctx.sysLine(String(ev['summary']));
      if (!workers.length) {
        ctx.sysLine(
          ev['parsed']
            ? 'no team needed — running it directly'
            : 'could not read a roster — running it directly',
          true,
        );
      } else {
        const names = workers.map((w) => w.name).join(', ');
        ctx.sysLine(`launching ${workers.length} agents — ${names}`, true);
      }
    } else if (etype === 'team_start') {
      counter.running += 1;
      const col = colors.get(String(ev['name'])) ?? p.accent;
      let brief = String(ev['brief'] ?? '');
      if (brief.length > 96) brief = brief.slice(0, 95) + '…';
      ctx.say(
        m.renderers.agentEventLine(String(ev['name']), col, '▸', brief, p),
      );
      ctx.updateBar({
        activity: `team ${counter.running}/${counter.total || '?'}`,
      });
    } else if (etype === 'team_text') {
      const col = colors.get(String(ev['name'])) ?? p.accent;
      ctx.say(
        m.renderers.agentLine(String(ev['name']), String(ev['text'] ?? ''), col, p),
      );
    } else if (etype === 'team_tool') {
      const col = colors.get(String(ev['name'])) ?? p.accent;
      ctx.say(
        m.renderers.agentEventLine(
          String(ev['name']),
          col,
          String(ev['tool'] ?? '?'),
          m.tools.summariseCall(
            String(ev['tool'] ?? ''),
            (ev['args'] as Record<string, unknown>) ?? {},
            ctx.cfg,
          ),
          p,
        ),
      );
    } else if (etype === 'team_result') {
      const col = colors.get(String(ev['name'])) ?? p.accent;
      const output = String(ev['output'] ?? '')
        .trim()
        .split('\n');
      let first = output[0] ? output[0].slice(0, 96) : '(no output)';
      if (output.length > 1) first += `  … +${output.length - 1} lines`;
      ctx.say(
        m.renderers.agentEventLine(
          String(ev['name']),
          col,
          ev['ok'] ? '✔' : '✘',
          first,
          p,
          { ok: Boolean(ev['ok']) },
        ),
      );
    } else if (etype === 'team_done') {
      counter.running = Math.max(0, counter.running - 1);
      const col = colors.get(String(ev['name'])) ?? p.accent;
      const detail = ev['ok']
        ? `done · $${Number(ev['cost'] ?? 0).toFixed(4)}`
        : `failed — ${ev['error'] ?? 'unknown'}`;
      ctx.say(
        m.renderers.agentEventLine(String(ev['name']), col, '■', detail, p, {
          ok: Boolean(ev['ok']),
        }),
      );
      ctx.updateBar({
        activity: `team ${counter.running}/${counter.total || '?'}`,
      });
    } else if (etype === 'team_end') {
      // Bank the workers' usage so the synthesis turn's usage events add to it
      // rather than replacing it.
      ctx.teamTokensRef.current = [
        Number(ev['input'] ?? 0),
        Number(ev['output'] ?? 0),
        Number(ev['cost'] ?? 0),
      ];
      ctx.updateBar({
        inputTokens: a.sessionInputTokens + ctx.teamTokensRef.current[0],
        outputTokens: a.sessionOutputTokens + ctx.teamTokensRef.current[1],
        cost: a.sessionCost + ctx.teamTokensRef.current[2],
      });
    }
  };

  ctx.say(m.renderers.turnMarker(a.turnCount + 1, p));
  ctx.say(m.renderers.userPromptBlock(`⚑ team: ${task}`, p));
  ctx.sysLine('analysing the task…');
  ctx.updateBar({ activity: 'thinking' });

  try {
    const results = await m.team.runTeam(ctx.cfg, task, {
      onEvent,
      agentFactory: ctx.teamAgentFactory,
    });
    if (ctx.cancelledRef.current) return;

    if (!results.length) {
      // No roster — do the task the ordinary way, on the main agent. The
      // planner cost a team, not the task.
      ctx.updateBar({ activity: 'working' });
      for await (const ev of a.runTurn(task)) {
        if (ctx.cancelledRef.current) break;
        ctx.handleEvent(ev);
      }
      return;
    }
    // Synthesis: the main brain folds the reports into one answer.
    const good = results.filter((r) => r.ok).length;
    ctx.sysLine(`synthesising ${good}/${results.length} results…`);
    ctx.updateBar({ activity: 'synthesising' });
    const prompt = m.team.synthesisPrompt(task, results);
    for await (const ev of a.runTurn(prompt)) {
      if (ctx.cancelledRef.current) break;
      ctx.handleEvent(ev);
    }
  } catch (e) {
    ctx.say(m.renderers.errorBlock(`team failed: ${errName(e)}`, p));
  } finally {
    if (isCurrent()) {
      ctx.setBusyBoth(false);
      ctx.chat()?.clearStream();
      ctx.chat()?.cardFinish();
      ctx.streamBufRef.current = '';
      ctx.updateBar({
        activity: 'idle',
        turns: a.turnCount,
        model: ctx.cfg.model,
      });
      ctx.syncRails();
      ctx.setRainBoth(ctx.cfg.rain);
      if (ctx.cancelledRef.current) {
        a.cancelTurn();
        ctx.sysLine('team interrupted', true);
      }
    }
  }
}

// === SECTION === /osint ==============================================================

function osintMenu(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  const rows = m.osint.KIND_ORDER.map((name) => {
    const kind = m.osint.OSINT_KINDS[name];
    if (!kind) return null;
    return (
      <Box key={name}>
        <Text bold={kind.built} color={kind.built ? p.accent : p.dim}>
          {`  ${kind.built ? '◉' : '○'} ${name.padEnd(10)}`}
        </Text>
        <Text color={kind.built ? p.primary : p.dim}>{kind.blurb + '\n'}</Text>
      </Box>
    );
  });
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  OSINT\n\n'}
      </Text>
      {rows}
      <Box>
        <Text color={p.dim}>{'\n  usage: '}</Text>
        <Text color={p.primary}>{'/osint <kind> <target>\n'}</Text>
      </Box>
      {/* Read from cfg rather than hard-coding ~/.andy: state_dir is
          configurable, and a menu that names the wrong directory is worse than
          one that names none. */}
      <Box>
        <Text color={p.dim}>{'  evidence lands in '}</Text>
        <Text color={p.primary}>{`${path.join(ctx.cfg.stateDir, 'osint')}/<kind>-<target>-<stamp>/\n`}</Text>
      </Box>
    </Box>,
  );
}

export function cmdOsint(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // A router, not an engine: pick the kind, validate the target, open a case
  // directory, then hand that kind's playbook to the main agent as a single
  // turn. Bare `/osint` shows the menu so the surface is discoverable.
  if (!args.length) {
    osintMenu(ctx);
    return;
  }
  const kindName = (args[0] ?? '').toLowerCase();
  const kind = m.osint.OSINT_KINDS[kindName];
  if (!kind) {
    ctx.sysLine(
      `unknown osint kind: ${kindName} — try ${m.osint.KIND_ORDER.join(' | ')}`,
      true,
    );
    return;
  }
  const target = args.slice(1).join(' ').trim();
  if (!kind.built) {
    // Name the kinds that *do* work rather than the one that does not: the
    // list grows every time a playbook lands, and a hard-coded "email is the
    // one that works" goes stale the moment it does.
    const live = m.osint.KIND_ORDER.filter(
      (n) => m.osint.OSINT_KINDS[n]?.built,
    ).join(' ');
    ctx.sysLine(`/osint ${kind.name} is not built yet — try: ${live}`, true);
    return;
  }
  if (!target) {
    ctx.sysLine(`usage: /osint ${kind.name} <${kind.targetLabel}>`, true);
    return;
  }
  const [ok, err] = m.osint.validate(kind, target);
  if (!ok) {
    ctx.sysLine(`usage: /osint ${kind.name} <${kind.targetLabel}>  (${err})`, true);
    return;
  }
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  const caseDir = m.osint.caseDir(ctx.cfg, kind, target);
  const prompt = m.osint.buildPrompt(kind, target, caseDir);
  const label = m.osint.normalise(kind, target);
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ CASE      '}
        </Text>
        <Text color={p.primary}>{`${kind.name} · ${label}\n`}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ EVIDENCE  '}
        </Text>
        <Text color={p.dim}>{caseDir + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.amber}>
          {'  ◈ NOTICE    '}
        </Text>
        <Text color={p.dim}>
          {
            'authorised use only — your own footprint, a consented audit, or a declared engagement\n'
          }
        </Text>
      </Box>
    </Box>,
  );
  void ctx.runTurn(prompt, {
    display: `⚑ /osint ${kind.name} ${label}`,
    osintCase: caseDir,
    // The whole point of the run is this file. Declaring it means a model that
    // narrates "Writing the report." and stops is asked again, and one that
    // still will not write it is reported as having failed rather than ending
    // in silence.
    deliverable: { path: path.join(caseDir, 'report.md'), label: 'report.md', maxNudges: 2 },
  });
}

/** Archive the run's report, show it as a tree, clear the case directory.
 * Reports are the one artefact worth keeping, so they move to
 * <state_dir>/reports/ and everything else — clones, raw API responses,
 * avatars — is deleted. A run that produced no report is left untouched so
 * the operator can see what it managed to collect. */
export function finaliseOsint(ctx: AppCtx, caseDir: string): void {
  const m = ctx.mods();
  if (!m) return;
  const [report, cleaned] = m.osint.finaliseCase(ctx.cfg, caseDir);
  if (report !== null) {
    ctx.sysLine(`report archived: ${report}`, true);
    showOsintTree(ctx, report);
    if (cleaned) {
      ctx.sysLine('case directory cleared (evidence discarded)');
    }
  } else {
    ctx.sysLine(
      `no report found — case directory kept for inspection: ${caseDir}`,
      true,
    );
  }
}

/** Render an archived report as a tree in the transcript. */
function showOsintTree(ctx: AppCtx, report: string): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  const node = m.osintTree.parseReportFile(report);
  if (!node.children.length) {
    ctx.sysLine(`no sections parsed from ${path.basename(report)} — open it directly`, true);
    return;
  }
  ctx.say(
    <Box>
      <Text bold color={p.accent}>
        {'  ⚑ RESULT    '}
      </Text>
      <Text color={p.primary}>{m.osintTree.summaryLine(node)}</Text>
    </Box>,
  );
  ctx.say(m.osintTree.renderTree(node, p));
}

export function cmdOsintTree(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  // The tree is printed when a run finalises, but a transcript scrolls and
  // /clear empties it. Reports are archived permanently under
  // <state_dir>/reports/, so this reads one back.
  const which = args.join(' ').trim() || null;
  const report = m.osintTree.findReport(ctx.cfg, which);
  if (report === undefined) {
    const where = m.osint.reportsDir(ctx.cfg);
    if (which) {
      // Say "recon", not "report": <state_dir>/reports/ is shared with
      // /bug-hunt and /crack, so `/osint-tree crack` would otherwise read as
      // "that file does not exist" when the truth is "that is not a recon".
      ctx.sysLine(
        `no recon report matches '${which}' — /osint-tree reads /osint runs only; try it with no argument for the latest`,
        true,
      );
    } else {
      ctx.sysLine(`no recon reports found — run /osint first (archive: ${where})`, true);
    }
    return;
  }
  ctx.sysLine(`report: ${report}`);
  showOsintTree(ctx, report);
}

// === SECTION === /phish ==============================================================

function phishUsage(ctx: AppCtx): void {
  const p = ctx.pal();
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  PHISH\n\n'}
      </Text>
      <Box>
        <Text bold color={p.primary}>
          {'  /phish <host>     '}
        </Text>
        <Text color={p.dim}>{'clone the login page, serve it, tunnel it\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /phish status     '}
        </Text>
        <Text color={p.dim}>{'show the live URLs and capture counts\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /phish stop       '}
        </Text>
        <Text color={p.dim}>{'tear the campaign down\n'}</Text>
      </Box>
      <Box>
        <Text color={p.dim}>{'\n  hits and credentials stream into '}</Text>
        <Text color={p.primary}>zim-pane</Text>
        <Text color={p.dim}>{' on the right.\n'}</Text>
      </Box>
      <Box>
        <Text color={p.dim}>{'  campaigns land in '}</Text>
        <Text color={p.primary}>{`${path.join(ctx.cfg.stateDir, 'phish')}/<host>-<stamp>/\n`}</Text>
      </Box>
    </Box>,
  );
}

function phishStatus(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const camp = m.phish.active();
  if (camp === null || !camp.alive) {
    ctx.sysLine('no phishing campaign is running', true);
    return;
  }
  const p = ctx.pal();
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ PHISH     '}
        </Text>
        <Text color={p.primary}>{`${camp.host}  (${camp.alive ? 'LIVE' : 'stopped'})\n`}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ LOCAL     '}
        </Text>
        <Text color={p.primary}>{camp.localUrl + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ PUBLIC    '}
        </Text>
        <Text color={camp.publicUrl ? p.primary : p.amber}>
          {(camp.publicUrl ?? 'none — LAN only') + '\n'}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ CLONE     '}
        </Text>
        <Text color={p.dim}>{camp.cloneNote + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ CAPTURED  '}
        </Text>
        <Text color={p.primary}>{`${camp.creds.length} cred  ·  ${camp.hits.length} hit\n`}</Text>
      </Box>
    </Box>,
  );
}

function phishStop(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const camp = m.phish.stop();
  ctx.zimPane()?.note({ kind: 'stopped' });
  if (camp === null) {
    ctx.sysLine('no phishing campaign is running', true);
    return;
  }
  ctx.sysLine(
    `phish stopped — ${camp.host}  ·  ${camp.creds.length} cred  ·  ${camp.hits.length} hit  ·  ${camp.directory}`,
    true,
  );
}

async function launchPhish(ctx: AppCtx, target: string): Promise<void> {
  // Build the campaign off the render thread: fetch + bind + tunnel.
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  ctx.setBusyBoth(true);
  ctx.updateBar({ activity: 'phish: cloning' });
  let camp;
  try {
    camp = await m.phish.start(ctx.cfg, target, (ev) => ctx.phishQRef.current.push(ev), {
      tunnel: true,
    });
  } catch (e) {
    ctx.setBusyBoth(false);
    ctx.updateBar({ activity: 'idle' });
    ctx.sysLine(`phish failed: ${errName(e)}`, true);
    ctx.zimPane()?.hide();
    return;
  }
  ctx.setBusyBoth(false);
  ctx.updateBar({ activity: 'idle' });
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ LOCAL     '}
        </Text>
        <Text color={p.primary}>{camp.localUrl + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ PUBLIC    '}
        </Text>
        {camp.publicUrl ? (
          <Text>
            <Text bold color={p.accent}>
              {camp.publicUrl}
            </Text>
            {camp.tunnel.tool ? (
              <Text color={p.dim}>{`  via ${camp.tunnel.tool}`}</Text>
            ) : null}
            <Text>{'\n'}</Text>
          </Text>
        ) : (
          <Text>
            <Text color={p.amber}>none — LAN only</Text>
            {camp.tunnel.error ? (
              <Text color={p.dim}>{`  (${camp.tunnel.error})`}</Text>
            ) : null}
            <Text>{'\n'}</Text>
          </Text>
        )}
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ CLONE     '}
        </Text>
        <Text color={p.dim}>{camp.cloneNote + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ LOGS      '}
        </Text>
        <Text color={p.dim}>{camp.directory + '\n'}</Text>
      </Box>
      <Text color={p.dim}>{'  · watch zim-pane for hits and credentials\n'}</Text>
    </Box>,
  );
}

export function cmdPhish(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  // Subcommands: stop tears the campaign down, status reprints the live URLs.
  // A second /phish <host> replaces the running one.
  if (!args.length) {
    phishUsage(ctx);
    return;
  }
  const verb = (args[0] ?? '').toLowerCase();
  if (['stop', 'off', 'kill'].includes(verb)) {
    phishStop(ctx);
    return;
  }
  if (['status', 'info'].includes(verb)) {
    phishStatus(ctx);
    return;
  }
  const target = args.join(' ').trim();
  const [ok, err] = m.phish.validateTarget(target);
  if (!ok) {
    ctx.sysLine(`usage: /phish <host>  (${err})`, true);
    return;
  }
  const host = m.phish.normaliseTarget(target);
  const [allowed, reason] = a.scope.allows(host);
  if (!allowed) {
    ctx.sysLine(`⛔ BLOCKED — ${host} — ${reason}`, true);
    return;
  }
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  ctx.zimPane()?.showCampaign(host);
  const p = ctx.pal();
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ PHISH     '}
        </Text>
        <Text color={p.primary}>{host + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.amber}>
          {'  ◈ NOTICE    '}
        </Text>
        <Text color={p.dim}>
          {
            'authorised use only — your own property, a consented audit, or a declared engagement\n'
          }
        </Text>
      </Box>
    </Box>,
  );
  void launchPhish(ctx, target);
}

// === SECTION === /scope-validator =====================================================

export function cmdScopeValidator(ctx: AppCtx): void {
  // Opens the multi-line paste box so the whole overview arrives intact, then
  // runs the worker: it makes model calls and network requests.
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  // The paste screen itself is owned by app.tsx (it gates the keyboard); it
  // calls runScopeValidator back with the text.
  ctx.openScopePaste();
}

export async function runScopeValidator(ctx: AppCtx, overview: string): Promise<void> {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const sv = m.scopeValidator;
  const p = ctx.pal();
  const myGen = ctx.nextWorkerGen();

  ctx.setBusyBoth(true);
  ctx.cancelledRef.current = false;
  ctx.setRainBoth(false);
  ctx.sysLine('scope-validator: reading the overview…');
  try {
    // 1. extract the structured scope from the pasted text
    ctx.updateBar({ activity: 'scope: reading' });
    const extractPrompt =
      typeof sv.EXTRACT_PROMPT === 'function'
        ? sv.EXTRACT_PROMPT({ overview })
        : sv.EXTRACT_PROMPT.replace('{overview}', overview);
    const extracted = sv.parseExtraction(await collectPlain(ctx, extractPrompt));
    if (
      extracted === null ||
      (!extracted.inScope.length && !extracted.outOfScope.length)
    ) {
      ctx.sysLine(
        'scope-validator: could not find any scope entries in that text — nothing was written',
        true,
      );
      return;
    }
    if (ctx.cancelledRef.current) return;

    // 2. write and verify the scope files in the working directory
    const [allow, deny, skipped] = sv.buildScope(
      extracted.inScope,
      extracted.outOfScope,
    );
    const dest = ctx.cfg.workdir;
    const [allowPath, denyPath] = sv.writeScopeFiles(
      dest,
      allow,
      deny,
      extracted.programme,
    );
    const problems = sv.verifyScopeFiles(allowPath, denyPath);

    // 3. read-only recon of the in-scope hosts, deny-list respected
    const hosts = dedupe(extracted.inScope.map((e) => hostOf(ctx, e.asset))).filter(
      Boolean,
    );
    ctx.sysLine(`recon: ${hosts.length} in-scope host(s), read-only`);
    ctx.updateBar({ activity: 'scope: recon' });
    const recon = await sv.reconAll(hosts, a.scope);

    // 4. rank with the model, from the evidence
    ctx.updateBar({ activity: 'scope: ranking' });
    const inAssets = extracted.inScope.map((e) => e.asset);
    const rankedRaw = sv.parseRanking(
      await collectPlain(ctx, sv.rankPrompt(extracted.programme, inAssets, recon)),
      inAssets,
    );
    const [ranked, summary] = rankedRaw ?? [
      inAssets.map((assetV, i) => new sv.Ranked(assetV, i + 1, 'unranked', 'ranking unavailable')),
      '',
    ];

    // 5. show the tree
    const rules = extracted.rules.slice(0, 12);
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {`  SCOPE VALIDATOR — ${extracted.programme || 'programme'}\n\n`}
        </Text>
        <Text color={p.primary}>{`  wrote  ${allowPath}\n`}</Text>
        <Text color={p.primary}>{`  wrote  ${denyPath}\n`}</Text>
        {skipped.length ? (
          <Text color={p.amber}>
            {`  skipped ${skipped.length} asset(s) the guard cannot hold: ${skipped.slice(0, 6).join(', ')}\n`}
          </Text>
        ) : null}
        {problems.map((prob) => (
          <Text key={prob} color={p.amber}>
            {`  ⚠ ${prob}\n`}
          </Text>
        ))}
        {rules.length ? (
          <Box flexDirection="column">
            <Text bold color={p.accent}>
              {'\n  RULES\n'}
            </Text>
            {rules.map((rule) => (
              <Text key={rule} color={p.dim}>
                {`    · ${rule}\n`}
              </Text>
            ))}
          </Box>
        ) : null}
        <Text bold color={p.accent}>
          {'\n  TARGET ORDER\n'}
        </Text>
        {summary ? <Text color={p.primary}>{`  ${summary}\n`}</Text> : null}
        {ranked.map((r) => {
          const host = hostOf(ctx, r.asset);
          const rec = recon[host];
          return (
            <Box key={r.asset} flexDirection="column">
              <Box>
                <Text bold color={p.accent}>{`    #${r.rank} `}</Text>
                <Text color={p.dim}>{`[${r.value}] `}</Text>
                <Text color={p.primary}>{`${r.asset}\n`}</Text>
              </Box>
              {rec ? <Text color={p.dim}>{`        ${sv.reconLine(rec)}\n`}</Text> : null}
              {r.why ? <Text color={p.dim}>{`        why: ${r.why}\n`}</Text> : null}
            </Box>
          );
        })}
        {extracted.outOfScope.length ? (
          <Box flexDirection="column">
            <Text bold color={p.accent}>
              {`\n  OUT OF SCOPE (${extracted.outOfScope.length})\n`}
            </Text>
            {extracted.outOfScope.slice(0, 20).map((e, i) => (
              <Box key={i}>
                <Text color={p.primary}>{`    ✕ ${e.asset}`}</Text>
                {e.note ? <Text color={p.dim}>{` — ${e.note}`}</Text> : null}
                <Text>{'\n'}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        <Text color={p.dim}>
          {
            '\n  The scope files are a declaration of what you are cleared to test. Check them before you run a tool.\n'
          }
        </Text>
      </Box>,
    );

    // The guard is re-read so the new files take effect this session.
    a.scope = m.scope.Scope.load(allowPath, denyPath);
    ctx.syncRails();
  } catch (e) {
    ctx.sysLine(`scope-validator failed: ${errName(e)}`, true);
  } finally {
    if (ctx.isCurrentWorker(myGen)) {
      ctx.setBusyBoth(false);
      ctx.updateBar({ activity: 'idle' });
    }
  }
}

// === SECTION === /bug-hunt ==============================================================

function huntUsage(ctx: AppCtx): void {
  const p = ctx.pal();
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  BUG HUNT\n\n'}
      </Text>
      <Box>
        <Text bold color={p.primary}>
          {'  /bug-hunt <target>   '}
        </Text>
        <Text color={p.dim}>{'recon, then the next wave of 10 agents, then stop\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /bug-hunt <target> --wave N  '}
        </Text>
        <Text color={p.dim}>{'run wave N specifically (wave 1 first)\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /bug-hunt --fresh <target>  '}
        </Text>
        <Text color={p.dim}>{'remap even if recon is already on disk\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /stop-hunt           '}
        </Text>
        <Text color={p.dim}>{'end the wave and print what it found\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /summary-hunt        '}
        </Text>
        <Text color={p.dim}>{'the report — what each wave did (works mid-wave)\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /report-bug-hunt     '}
        </Text>
        <Text color={p.dim}>{'evidence only, every wave, no narrative\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /findings            '}
        </Text>
        <Text color={p.dim}>{'the tracker — every bug found, worst first\n'}</Text>
      </Box>
      <Text color={p.dim}>
        {
          '\n  Each wave: the planner reads what every earlier wave found and\n  aims the next ten somewhere new. Run it under '
        }
      </Text>
      <Text color={p.primary}>/mode zim</Text>
      <Text color={p.dim}>{' so the\n  agents follow your AGENTS.md doctrine.\n'}</Text>
      <Box>
        <Text color={p.dim}>{'\n  evidence lands in '}</Text>
        <Text color={p.primary}>{`${path.join(ctx.cfg.stateDir, 'hunts')}/<scope>/\n`}</Text>
      </Box>
      <Text color={p.dim}>
        {
          '  one directory per scope, reused, and one directory per wave:\n  wave-N/plan.md and wave-N/findings/ sit together, so the tree\n  says what each wave aimed at and what it found\n'
        }
      </Text>
    </Box>,
  );
}

export function cmdBugHunt(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const p = ctx.pal();
  // /bug-hunt [--fresh] [--wave N] <target> — recon, then one wave. Whether
  // there is another wave is the operator's call, which is the point: a
  // campaign that planned wave 2 straight after wave 1 found a critical was
  // spending tokens on work nobody asked for and could not decline.
  //
  // The flags may sit either side of the target, because both read naturally
  // and an operator who has to remember which is which will get it wrong.
  // Stripped before the target is joined, so a stray flag never reaches
  // scope_slug and becomes part of a directory name.
  const fresh = args.some((x) => x === '--fresh' || x === '-f');
  const rest0 = args.filter((x) => x !== '--fresh' && x !== '-f');

  // --wave takes a value, so it is parsed rather than filtered: the flag and
  // the number after it are both consumed, and every malformed form is refused
  // here rather than becoming part of the target string.
  let waveNumber: number | null = null;
  const stripped: string[] = [];
  let i = 0;
  while (i < rest0.length) {
    const arg = rest0[i] ?? '';
    const eq = arg.indexOf('=');
    const isWave = arg === '--wave' || arg.startsWith('--wave=');
    if (isWave) {
      const value = eq >= 0 ? arg.slice(eq + 1) : (rest0[i + 1] ?? '');
      if (eq < 0) i += 1;
      if (!value) {
        ctx.sysLine('--wave needs a number, e.g. /bug-hunt x.com --wave 2', true);
        return;
      }
      if (!/^\d+$/.test(value) || Number(value) < 1) {
        ctx.sysLine(
          `⚠ --wave takes a wave number of 1 or more, not '${value}'. Wave 0 is recon — it has no briefs to run.`,
          true,
        );
        return;
      }
      waveNumber = Number(value);
    } else {
      stripped.push(arg);
    }
    i += 1;
  }
  if (!stripped.length) {
    huntUsage(ctx);
    return;
  }
  const target = stripped.join(' ').trim();
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  // Warn but proceed: AGENTS.md treats any target the operator declares as
  // authorised, so an unarmed session is a notice, not a refusal — but the
  // out-of-scope guard still hard-blocks mid-hunt.
  const [allowed, reason] = a.scope.allows(target);
  if (!allowed) {
    ctx.sysLine(`⚠ not in allow.yaml — ${reason}`, true);
    ctx.sysLine('hunting anyway; out-of-scope hosts stay hard-blocked');
  }
  // The scope decides the directory, and a target that is not host-shaped is
  // refused here rather than slugged into a misleading folder name. This used
  // to accept anything: a sentence typed into the target field became a
  // directory named after its first sixty characters.
  let directory: string;
  try {
    directory = m.hunt.caseDir(ctx.cfg, target);
  } catch (e) {
    ctx.sysLine(`⚠ ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  // What recon the campaign will actually run, probed before it starts,
  // because "we already have this mapped" decides whether the operator waits
  // minutes or gets briefs immediately.
  const reused = fresh ? undefined : m.hunt.findRecon(directory);
  const running = waveNumber ?? m.hunt.nextWaveNumber(directory);
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ HUNT      '}
        </Text>
        <Text bold color={p.primary}>
          {target + '\n'}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ RECON     '}
        </Text>
        {fresh ? (
          <Text color={p.primary}>{'--fresh — remapping the target\n'}</Text>
        ) : reused ? (
          <Text color={p.primary}>
            {`reusing notes from ${reused.path.name} (${reused.ageDays}d old) — no remap\n`}
          </Text>
        ) : (
          <Text color={p.primary}>{'mapping the surface\n'}</Text>
        )}
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ WAVE      '}
        </Text>
        <Text bold color={p.primary}>
          {`wave ${running} — `}
        </Text>
        <Text color={p.primary}>
          {waveNumber === null
            ? `${m.hunt.HUNT_WAVE_SIZE} agents, all concurrent, then it stops\n`
            : `${m.hunt.HUNT_WAVE_SIZE} agents, all concurrent\n`}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ EVIDENCE  '}
        </Text>
        <Text color={p.dim}>{directory + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.amber}>
          {'  ◈ NOTICE    '}
        </Text>
        <Text color={p.dim}>
          {
            'authorised use only — your own asset, a consented audit, or a declared engagement\n'
          }
        </Text>
      </Box>
      <Box>
        <Text color={p.dim}>{'  · '}</Text>
        <Text color={p.primary}>/stop-hunt</Text>
        <Text color={p.dim}>{' ends the wave   ·   '}</Text>
        <Text color={p.primary}>/summary-hunt</Text>
        <Text color={p.dim}>{' writes the report   ·   '}</Text>
        <Text color={p.primary}>/report-bug-hunt</Text>
        <Text color={p.dim}>{' evidence only   ·   '}</Text>
        <Text color={p.primary}>/findings</Text>
        <Text color={p.dim}>{' shows the tracker\n'}</Text>
      </Box>
    </Box>,
  );
  ctx.zimPane()?.showHunt(target, m.hunt.HUNT_WAVE_SIZE);
  void runHunt(ctx, target, { fresh, waveNumber });
}

// === SECTION === /crack =================================================================

export function cmdCrack(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // A router, like /osint: identify what is in the file, work out what is
  // affordable on *this* host, print that arithmetic, then hand the playbook
  // to the main agent as one turn. The estimate is the feature — there is no
  // GPU here, and an operator who starts a rule set against a Kerberoast hash
  // without knowing it is a ten-minute run will cancel it.
  const [pathArg, mode, maxTime, deep, err] = parseCrackArgs(args);
  if (err) {
    ctx.sysLine(err, true);
    return;
  }
  if (!pathArg) {
    ctx.sysLine('usage: /crack <file|dir> [--mode N] [--max-time S] [--deep]', true);
    return;
  }
  if (mode !== null && !(mode in m.crack.HASH_MODES)) {
    const known = Object.keys(m.crack.HASH_MODES)
      .map(Number)
      .sort((x, y) => x - y)
      .join(', ');
    ctx.sysLine(
      `mode ${mode} is not one /crack knows (${known}) — pass --mode only for a format in that list, or let the file be identified`,
      true,
    );
    return;
  }
  const [source, verr] = m.crack.validatePath(pathArg);
  if (source === null) {
    ctx.sysLine(verr, true);
    return;
  }
  if (!hasBinary('hashcat')) {
    ctx.sysLine(
      'hashcat is not installed — /crack drives hashcat. Install it (apt install hashcat) and try again.',
      true,
    );
    return;
  }
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  const detected = m.crack.identify(source);
  // A --mode the operator gave wins; otherwise the most prevalent format
  // found. A file that identifies as nothing still runs — the playbook tells
  // the agent to establish the mode with --identify — but the banner has to
  // say the estimate is unknown rather than invent one.
  const chosen = mode !== null ? mode : detected.length ? detected[0].mode : null;
  const caseDir = m.crack.caseDir(ctx.cfg, source);
  const pot = m.crack.potfile(ctx.cfg);
  const planRows: ReactNode[] = [];
  if (chosen !== null) {
    const rate = m.crack.rateFor(chosen);
    planRows.push(
      <Box key="rate">
        <Text bold color={p.accent}>
          {'  ⚒ RATE      '}
        </Text>
        <Text color={p.primary}>
          {`${m.crack.HASH_MODES[chosen]?.[0] ?? `mode ${chosen}`} · ${(rate / 1e6).toFixed(1)} MH/s  `}
        </Text>
        <Text color={p.dim}>{'(CPU only — this host has no GPU)\n'}</Text>
      </Box>,
    );
    const plan = m.crack.plan(chosen, maxTime, { deep });
    planRows.push(
      <Box key="plan-head">
        <Text bold color={p.accent}>
          {'  ⚒ PLAN      '}
        </Text>
        <Text color={p.primary}>{`budget ${m.crack.humanTime(maxTime)}\n`}</Text>
      </Box>,
    );
    for (const ps of plan) {
      planRows.push(
        <Box key={ps.stage.name}>
          <Text color={ps.run ? p.primary : p.dim}>{`      [${ps.run ? 'run ' : 'skip'}] `}</Text>
          <Text color={ps.run ? p.primary : p.dim}>{ps.stage.name.padEnd(38)}</Text>
          <Text color={ps.run ? p.primary : p.dim}>
            {`~${m.crack.humanTime(ps.seconds).padStart(7)}`}
          </Text>
          {!ps.run ? <Text color={p.dim}>{`   ${ps.reason ?? ''}`}</Text> : null}
          <Text>{'\n'}</Text>
        </Box>,
      );
    }
  } else {
    planRows.push(
      <Box key="plan-unknown">
        <Text bold color={p.accent}>
          {'  ⚒ PLAN      '}
        </Text>
        <Text color={p.amber}>{'cannot estimate until the mode is known\n'}</Text>
      </Box>,
    );
  }
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ⚒ TARGET    '}
        </Text>
        <Text color={p.primary}>{source + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ⚒ EVIDENCE  '}
        </Text>
        <Text color={p.dim}>{caseDir + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ⚒ POTFILE   '}
        </Text>
        <Text color={p.dim}>{`${pot}  (shared across runs)\n`}</Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ⚒ FORMATS   '}
        </Text>
        {detected.length ? (
          <Text color={p.primary}>
            {detected.map((d) => `${d.name} ×${d.count}`).join(', ') + '\n'}
          </Text>
        ) : (
          <Text color={p.amber}>
            {'none recognised — the agent will run `hashcat --identify`\n'}
          </Text>
        )}
      </Box>
      {planRows}
      <Box>
        <Text bold color={p.amber}>
          {'  ⚒ NOTICE    '}
        </Text>
        <Text color={p.dim}>{'authorised use only — hashes you are entitled to test\n'}</Text>
      </Box>
    </Box>,
  );
  const prompt = m.crack.buildPrompt(ctx.cfg, source, caseDir, detected, maxTime);
  const isFile = fsSync.existsSync(source) && fsSync.statSync(source).isFile();
  const label = isFile ? `⚒ /crack ${path.basename(source)}` : `⚒ /crack ${source}`;
  void ctx.runTurn(prompt, {
    display: label,
    finalise: () => finaliseCrack(ctx, caseDir),
    // Same shape as /osint: the run exists to produce report.md, so it gets
    // the same nudge-then-report-honestly treatment.
    deliverable: { path: path.join(caseDir, 'report.md'), label: 'report.md', maxNudges: 2 },
  });
}

/** Archive the run's report, and keep the case directory. Deliberately not
 * osint's policy: osint deletes its case because the clones and API dumps
 * have no further use, but a crack case holds the hash copy and the potfile,
 * and the potfile is what makes a *second* run pick up where this one
 * stopped. */
function finaliseCrack(ctx: AppCtx, caseDir: string): void {
  const m = ctx.mods();
  if (!m) return;
  const report = m.crack.finaliseCase(ctx.cfg, caseDir);
  if (report !== null) {
    ctx.sysLine(`report archived: ${report}`, true);
    ctx.sysLine(`case kept (potfile and hashes): ${caseDir}`);
  } else {
    ctx.sysLine(`no report found — case kept for inspection: ${caseDir}`, true);
  }
}

// === SECTION === /ad =====================================================================

function adUsage(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  ACTIVE DIRECTORY\n\n'}
      </Text>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad <domain> --ack <domain>  '}
        </Text>
        <Text color={p.dim}>{'recon, then one wave of AD vectors, then stop\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad <domain> --ack <domain> --wave N  '}
        </Text>
        <Text color={p.dim}>{'run wave N specifically\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad <domain> --ack <domain> --lockout N  '}
        </Text>
        <Text color={p.dim}>{'how many bad passwords lock an account (default 5)\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad <domain> --ack <domain> --fresh  '}
        </Text>
        <Text color={p.dim}>{'remap even if recon is already on disk\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad <domain> --ack <domain> --arm  '}
        </Text>
        <Text color={p.dim}>{'permit destructive commands (off by default)\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.primary}>
          {'  /ad tools            '}
        </Text>
        <Text color={p.dim}>{'what AD tooling this host actually has\n'}</Text>
      </Box>
      <Text color={p.dim}>
        {
          '\n  The gate is the domain typed back. It is not a security\n  control — it makes the target something you had to say.\n\n  The interlock is arithmetic, not a promise: one shared\n  throttle, a hard attempt counter, and a breaker that trips\n  at '
        }
      </Text>
      <Text color={p.primary}>lockout - 1</Text>
      <Text color={p.dim}>
        {
          ' and refuses every credential-bearing\n  command after it. Writes to the directory are refused\n  outright unless you pass '
        }
      </Text>
      <Text color={p.primary}>--arm</Text>
      <Text color={p.dim}>
        {
          '.\n\n  Wave 1 is the unauthenticated surface — null sessions,\n  AS-REP roasting, anonymous LDAP, SMB signing, ADCS\n  reachability. Later waves are planned against what it got.\n  Evidence lands in '
        }
      </Text>
      <Text color={p.primary}>{`${path.join(ctx.cfg.stateDir, 'hunts')}/ad-<domain>/\n`}</Text>
      <Text color={p.dim}>{'  Run it under '}</Text>
      <Text color={p.primary}>/mode zim</Text>
      <Text color={p.dim}>{' so the agents follow your AGENTS.md doctrine.\n'}</Text>
    </Box>,
  );
}

function adToolsView(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // The same probe the campaign runs, on demand: an operator about to plan
  // around certipy wants to know whether certipy is here *before* the run.
  const probes = m.ad.probeTools();
  const present = probes.filter((q) => q.present);
  const missing = probes.filter((q) => !q.present);
  const skipped = m.ad.unavailableVectors(probes);
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {'  AD TOOLING\n\n'}
      </Text>
      <Text color={p.primary}>{`  ${present.length}/${probes.length} present\n\n`}</Text>
      <Text bold color={p.accent}>
        {'  PRESENT\n'}
      </Text>
      {present.map((q) => (
        <Box key={q.name}>
          <Text color={p.primary}>{`  ✔ ${q.name.padEnd(22)}`}</Text>
          <Text color={p.dim}>{q.vector + '\n'}</Text>
        </Box>
      ))}
      {!present.length ? <Text color={p.dim}>{'  (none)\n'}</Text> : null}
      {missing.length ? (
        <Box flexDirection="column">
          <Text bold color={p.accent}>
            {'\n  ABSENT\n'}
          </Text>
          {missing.map((q) => (
            <Box key={q.name}>
              <Text color={p.amber}>{`  ✘ ${q.name.padEnd(22)}`}</Text>
              <Text color={p.dim}>{q.hint + '\n'}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box>
        <Text color={p.dim}>{'\n  '}</Text>
        {skipped.length ? (
          <Text>
            <Text bold color={p.amber}>
              {'SKIPPED VECTORS  '}
            </Text>
            <Text color={p.dim}>
              {`${skipped.join(', ')} — every tool for these is absent, so a campaign would report them as skipped rather than run them\n`}
            </Text>
          </Text>
        ) : (
          <Text>
            <Text bold color={p.accent}>
              {'SKIPPED VECTORS  '}
            </Text>
            <Text color={p.dim}>{'none — every vector has at least one tool\n'}</Text>
          </Text>
        )}
      </Box>
    </Box>,
  );
}

export function cmdAd(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const p = ctx.pal();
  // /bug-hunt with a different doctrine and a safety interlock, and one gate
  // in front of it: the operator typing the domain back — not a security
  // control, a speed bump that makes "I am about to run credential attacks
  // against *this* domain" something they had to say. --wave/--fresh mean the
  // same as /bug-hunt's and parse the same way. --lockout N is AD's alone: it
  // is the number the interlock is built from, and getting it wrong is the
  // one mistake here that costs a client their Monday.
  if (args.length && (args[0] ?? '').toLowerCase() === 'tools') {
    adToolsView(ctx);
    return;
  }
  const fresh = args.some((x) => x === '--fresh' || x === '-f');
  let rest = args.filter((x) => x !== '--fresh' && x !== '-f');
  // --arm is the opt-in to the destructive verbs. Off unless asked for, and
  // named in the banner either way so an armed run is never invisible.
  const armed = args.includes('--arm');
  rest = rest.filter((x) => x !== '--arm');

  let waveNumber: number | null = null;
  let lockout = m.ad.DEFAULT_LOCKOUT;
  let ack: string | null = null;
  const stripped: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i] ?? '';
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name === '--wave' || name === '--lockout' || name === '--ack') {
      const value = eq >= 0 ? arg.slice(eq + 1) : (rest[i + 1] ?? '');
      if (eq < 0) i += 1;
      if (!value) {
        ctx.sysLine(
          `${name} needs a value, e.g. /ad corp.local ${name} ${name !== '--ack' ? '3' : 'corp.local'}`,
          true,
        );
        return;
      }
      if (name === '--ack') {
        ack = value;
      } else if (!/^\d+$/.test(value) || Number(value) < 1) {
        if (name === '--wave') {
          ctx.sysLine(
            `⚠ --wave takes a wave number of 1 or more, not '${value}'. Wave 0 is recon — it has no briefs to run.`,
            true,
          );
        } else {
          ctx.sysLine(
            `⚠ --lockout takes a whole number of attempts, not '${value}' — the count after which the domain locks an account.`,
            true,
          );
        }
        return;
      } else if (name === '--wave') {
        waveNumber = Number(value);
      } else {
        lockout = Number(value);
      }
    } else {
      stripped.push(arg);
    }
    i += 1;
  }
  rest = stripped;

  if (!rest.length) {
    adUsage(ctx);
    return;
  }
  // The domain is one token, not a sentence: validate_target says so, and it
  // is also what normalises the case and the trailing dot the ack is compared
  // against.
  let domain: string;
  try {
    domain = m.ad.validateTarget(rest.join(' '));
  } catch (e) {
    ctx.sysLine(`⚠ ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  // The gate. A missing ack and a wrong ack are refused identically — the
  // message is the line to run, either way, and saying which half was wrong
  // would only help someone guessing.
  if (ack === null || ack.trim().toLowerCase().replace(/\.+$/, '') !== domain) {
    ctx.sysLine('⚠ /ad is gated. Confirm the domain by typing it back:', true);
    ctx.sysLine(`  ${m.ad.refusal(domain)}`, true);
    return;
  }
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — Ctrl+C to interrupt', true);
    return;
  }
  // The probe runs here, once, and its result goes three places: this banner,
  // the recon prompt, and the list of vectors out of scope for the run. That
  // is the "detect and degrade" decision — a vector whose tooling is absent
  // is skipped and *named as skipped*.
  const probes = m.ad.probeTools();
  // Warn but proceed, exactly as /bug-hunt does.
  const [allowed, reason] = a.scope.allows(domain);
  if (!allowed) {
    ctx.sysLine(`⚠ not in allow.yaml — ${reason}`, true);
    ctx.sysLine('running anyway; out-of-scope hosts stay hard-blocked');
  }
  let directory: string;
  try {
    directory = m.hunt.caseDir(ctx.cfg, domain, m.ad.AD_KIND);
  } catch (e) {
    ctx.sysLine(`⚠ ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  const reused = fresh ? undefined : m.hunt.findRecon(directory);
  const present = probes.filter((q) => q.present);
  const missing = probes.filter((q) => !q.present);
  const skipped = m.ad.unavailableVectors(probes);
  const running = waveNumber ?? m.hunt.nextWaveNumber(directory);
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ DOMAIN    '}
        </Text>
        <Text bold color={p.primary}>
          {domain + '\n'}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ RECON     '}
        </Text>
        {fresh ? (
          <Text color={p.primary}>{'--fresh — remapping the domain\n'}</Text>
        ) : reused ? (
          <Text color={p.primary}>
            {`reusing notes from ${reused.path.name} (${reused.ageDays}d old) — no remap\n`}
          </Text>
        ) : (
          <Text color={p.primary}>
            {'mapping the domain — DCs, functional level, surface\n'}
          </Text>
        )}
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ TOOLS     '}
        </Text>
        <Text color={p.primary}>{`${present.length}/${probes.length} present`}</Text>
        {missing.length ? (
          <Text color={p.dim}>{`  ·  absent: ${missing.map((q) => q.name).join(', ')}`}</Text>
        ) : null}
        <Text color={p.dim}>{'\n'}</Text>
      </Box>
      {skipped.length ? (
        <Box>
          <Text bold color={p.amber}>
            {'  ◈ DEGRADED  '}
          </Text>
          <Text color={p.dim}>
            {`${skipped.join(', ')} — no tooling on this host; those vectors are skipped and will be reported as skipped\n`}
          </Text>
        </Box>
      ) : null}
      {/* The interlock's settings, stated before the run rather than
          discovered by hitting them: `limit` is the number the operator can
          actually spend, which is lockout - 1. */}
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ INTERLOCK '}
        </Text>
        <Text color={p.primary}>
          {`locks at ${lockout}  ·  ${Math.max(1, lockout - 1)} credential attempt(s) permitted  ·  ${m.ad.DEFAULT_RATE}/s, burst ${m.ad.DEFAULT_BURST}\n`}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ WRITES    '}
        </Text>
        {armed ? (
          <Text bold color={p.amber}>
            {'ARMED — destructive commands are permitted this run\n'}
          </Text>
        ) : (
          <Text color={p.primary}>
            {
              'read-only — ACL changes, password resets and relay writes are refused (--arm to permit)\n'
            }
          </Text>
        )}
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ WAVE      '}
        </Text>
        <Text bold color={p.primary}>
          {`wave ${running} — `}
        </Text>
        <Text color={p.primary}>
          {waveNumber === null
            ? `${m.hunt.HUNT_WAVE_SIZE} agents, all concurrent, then it stops\n`
            : `${m.hunt.HUNT_WAVE_SIZE} agents, all concurrent\n`}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ EVIDENCE  '}
        </Text>
        <Text color={p.dim}>{directory + '\n'}</Text>
      </Box>
      <Box>
        <Text bold color={p.amber}>
          {'  ◈ NOTICE    '}
        </Text>
        <Text color={p.dim}>
          {
            'authorised use only — a domain you own, a consented audit, or a declared engagement with a known lockout policy\n'
          }
        </Text>
      </Box>
      <Box>
        <Text color={p.dim}>{'  · '}</Text>
        <Text color={p.primary}>/stop-hunt</Text>
        <Text color={p.dim}>{' ends the wave   ·   '}</Text>
        <Text color={p.primary}>/summary-hunt</Text>
        <Text color={p.dim}>{' writes the report   ·   '}</Text>
        <Text color={p.primary}>/findings</Text>
        <Text color={p.dim}>{' shows the tracker   ·   '}</Text>
        <Text color={p.primary}>/ad tools</Text>
        <Text color={p.dim}>{' re-probes the tooling\n'}</Text>
      </Box>
    </Box>,
  );
  ctx.zimPane()?.showHunt(domain, m.hunt.HUNT_WAVE_SIZE);
  runAd(ctx, domain, { probes, fresh, waveNumber, lockout, armed });
}

/** /ad — build the doctrine, then run the campaign engine on it. A thin
 * wrapper over runHunt: recon, the wave web, the tracker rail, the stop flag
 * and the closing report are the engine's. What /ad adds is the interlock and
 * one extra sink, writing the refusal to the transcript the instant the
 * breaker trips rather than the operator inferring it from a wave that went
 * quiet. A FRESH adKind per campaign, never the module-level AD_KIND: the
 * interlock holds a throttle and an attempt counter, and those belong to one
 * run — a shared kind would carry the first campaign's spent budget into the
 * second and refuse it early. */
function runAd(
  ctx: AppCtx,
  domain: string,
  opts: {
    probes: AdToolProbe[];
    fresh: boolean;
    waveNumber: number | null;
    lockout: number;
    armed: boolean;
  },
): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // The breaker's own state, read back for the closing line. Held here rather
  // than on the ctx because it is this campaign's, and a second /ad must start
  // from zero.
  const spent = { n: 0, lockout: opts.lockout, limit: Math.max(1, opts.lockout - 1) };
  const onRefuse = (verdict: AdVerdict, command: string) => {
    const head = verdict.destructive ? 'write refused' : 'credential attempt refused';
    ctx.say(
      <Box flexDirection="column">
        <Box>
          <Text bold color={p.red}>
            {`  ⛔ ${head} — `}
          </Text>
          <Text color={p.amber}>{verdict.reason + '\n'}</Text>
        </Box>
        <Box>
          <Text color={p.dim}>{'     '}</Text>
          <Text color={p.dim}>{command.trim().slice(0, 160) + '\n'}</Text>
        </Box>
      </Box>,
    );
  };
  const reportRefusal = (verdict: AdVerdict, command: string) => {
    if (!verdict.destructive) spent.n += 1;
    onRefuse(verdict, command);
  };
  const kind = m.ad.adKind({
    lockout: opts.lockout,
    armed: opts.armed,
    probes: opts.probes,
    onRefuse: reportRefusal,
  });
  const onFinish = () => {
    // Including "nothing", because a run that never touched the budget is a
    // fact worth stating: it is the difference between an unauthenticated
    // sweep and a campaign that spent its four attempts.
    if (spent.n === 0) {
      ctx.sysLine(
        `interlock: no credential attempt was refused — the budget of ${spent.limit} went unspent`,
        true,
      );
    } else {
      ctx.sysLine(
        `interlock: ${spent.n} credential command(s) refused against a lockout of ${spent.lockout}`,
        true,
      );
    }
  };
  void runHunt(ctx, domain, {
    fresh: opts.fresh,
    waveNumber: opts.waveNumber,
    kind,
    onFinish,
  });
}

// === SECTION === the hunt engine =========================================================

/** The campaign directory /summary-hunt and /findings should read. This
 * session's own campaign wins, and that is the fix for a real misfire: the
 * operator runs a wave, asks for the report one line later, and the report is
 * written about a *different* target. The heuristic below is a guess, and on
 * a machine holding more than one campaign the guess is wrong often enough to
 * matter — so the run this session started, which is not a guess at all, is
 * preferred whenever there is one. */
function latestHuntDir(ctx: AppCtx): string | undefined {
  const m = ctx.mods();
  if (ctx.huntDirRef.current && fsSync.existsSync(ctx.huntDirRef.current)) {
    return ctx.huntDirRef.current;
  }
  if (m?.tools.campaignDirs) {
    try {
      return m.tools.campaignDirs(ctx.cfg.stateDir)[0];
    } catch {
      return undefined;
    }
  }
  // Fallback: the most recently written campaign, ordered by the newest
  // *artefact* rather than the directory's own mtime — writing a file into a
  // directory does not touch the directory, but moving files into one bumps it
  // to now, so the directory's mtime can rank a campaign that ran last week
  // above one that finished an hour ago.
  try {
    const root = path.join(ctx.cfg.stateDir, 'hunts');
    const entries = fsSync
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
      .map((d) => {
        let newest = 0;
        const walk = (dir: string, depth: number) => {
          if (depth > 3) return;
          for (const ent of fsSync.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            let mtime = 0;
            try {
              mtime = fsSync.statSync(full).mtimeMs;
            } catch {
              continue;
            }
            if (mtime > newest) newest = mtime;
            if (ent.isDirectory()) walk(full, depth + 1);
          }
        };
        walk(d, 0);
        return { dir: d, newest };
      })
      .sort((x, y) => y.newest - x.newest);
    return entries[0]?.dir;
  } catch {
    return undefined;
  }
}

/** Map a Finding to the dict shape the panel and the transcript line share.
 * Python used hunt._finding_dict (private); when the port does not export an
 * equivalent, the finding passes through as-is. */
function findingDict(ctx: AppCtx, f: unknown): FindingDict {
  const m = ctx.mods();
  if (m?.hunt.findingDict) return m.hunt.findingDict(f);
  return (f ?? {}) as FindingDict;
}

/** Repaint the open tracker from the live run, if there is one. Reads the run
 * rather than the event so the panel and the transcript cannot disagree about
 * what was found, and a duplicate the tracker dropped stays dropped. */
function refreshFindings(ctx: AppCtx): void {
  const run = ctx.huntRunRef.current;
  if (!ctx.findingsRef.current || !run) return;
  const items = run.ranked().map((f) => findingDict(ctx, f));
  ctx.findingsRef.current = { ...ctx.findingsRef.current, items };
  ctx.setFindings(ctx.findingsRef.current);
}

/** Tell the main agent a campaign just finished, and where it landed. A hunt
 * runs on its own Agent instances, so the main agent sees none of it. Without
 * this, "save the findings" reached an agent with no idea a hunt had happened
 * — and it answered "nothing found" over a directory full of evidence. */
function registerHunt(ctx: AppCtx, ev: Record<string, unknown>): void {
  const a = ctx.agent();
  const directory = String(ev['directory'] ?? '');
  if (!directory || !a) return;
  const findings = Number(ev['findings'] ?? 0);
  // Named from the campaign's own doctrine rather than hardcoded: an AD
  // campaign described as /bug-hunt would have the agent look in the wrong
  // directory.
  const command = String(ev['command'] ?? 'bug-hunt');
  const summary =
    `[hunt] A /${command} campaign just ended against ${ctx.huntTargetRef.current || 'the target'}.\n` +
    `directory: ${directory}\n` +
    `waves: ${Number(ev['wave'] ?? 0)} · findings: ${findings} · reports saved: ${Number(ev['saved'] ?? 0)}\n` +
    'Everything the campaign recorded — the findings, the recon notes and each wave\'s plan — is in that directory. Use the hunt_findings tool, or read_file on a path under it, before saying nothing was found.';
  try {
    a.notice(summary);
  } catch {
    /* a reporting seam must not take the app down */
  }
}

export async function runHunt(
  ctx: AppCtx,
  target: string,
  opts?: {
    fresh?: boolean;
    waveNumber?: number | null;
    kind?: unknown;
    onFinish?: () => void;
  },
): Promise<void> {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const p = ctx.pal();
  const myGen = ctx.nextWorkerGen();
  const isCurrent = () => ctx.isCurrentWorker(myGen);

  ctx.setBusyBoth(true);
  ctx.cancelledRef.current = false;
  ctx.setRainBoth(false);
  ctx.huntStopRef.current = createSignal();
  ctx.huntSummaryQueuedRef.current = false;
  ctx.huntTokensRef.current = [0, 0, 0];
  // Publish the run BEFORE the loop starts, not after it returns: this is what
  // /stop-hunt and /summary-hunt read, and the loop does not return until the
  // campaign is over — publishing it at the end left both commands looking at
  // nothing for the entire hunt. `kind` is resolved here so the directory the
  // run is published with is the same one runHunt will use.
  let run: HuntRunLike;
  try {
    run = new m.hunt.HuntRun({
      target,
      directory: m.hunt.caseDir(ctx.cfg, target, opts?.kind),
    });
  } catch (e) {
    ctx.setBusyBoth(false);
    ctx.say(m.renderers.errorBlock(errName(e), p));
    return;
  }
  ctx.huntRunRef.current = run;
  ctx.huntTargetRef.current = target;
  ctx.huntDirRef.current = run.directory;

  const counter = {
    running: 0,
    total: 0,
    wave: 0,
    done: 0,
    agents: 0,
  };
  // name -> colour, so a tool line, its prose and its result panel all agree
  // on which agent they belong to. Ten interleaved agents are unreadable
  // without that. Keyed by name because the result event carries the name.
  const colors = new Map<string, string>();

  // Light the loop rail's HACK node for the whole campaign. A hunt is not a
  // turn, so nothing else sets a stage for it — without this the rail sat on
  // IDLE from recon to the closing report, which reads as an idle harness
  // while ten agents are attacking the target.
  ctx.loopRail()?.setHunt(0);
  ctx.loopRail()?.setStage('hacking');

  // Overlay slots. In the Textual original these were pushed/popped screens
  // removed by identity; in Ink each is a conditional render behind one state
  // slot, which carries the same invariant: a stop or crash mid-wave cannot
  // strand one over a dead campaign, and replacing a wave's web takes the old
  // one down rather than stacking a second above it.
  // Findings carried in from an earlier campaign, held from the skip event
  // until the first wave's web is up — a tracker that opened empty over a
  // scope with twelve known bugs would read as though nothing had ever been
  // found. Consumed once, by the first wave.
  const seed: { findings: Record<string, unknown>[] } = { findings: [] };

  const onEvent = (evObj: HuntEvent): void => {
    if (ctx.cancelledRef.current) return;
    const ev = evObj as Record<string, unknown>;
    const etype = String(ev['type'] ?? '');

    ctx.zimPane()?.noteHunt(ev);

    // The wave view sees every event that describes a wave, fed before the
    // transcript branches so a finding reaches the tracker in the same tick
    // the transcript prints it.
    if (
      ctx.waveRef.current &&
      [
        'hunt_plan',
        'hunt_agent_start',
        'hunt_agent_tool',
        'hunt_agent_result',
        'hunt_agent_text',
        'hunt_agent_done',
        'hunt_finding',
        'hunt_wave_end',
      ].includes(etype)
    ) {
      try {
        ctx.waveRef.current.note(ev);
      } catch {
        /* a torn-down overlay must not kill the campaign */
      }
    }

    // Recon narrates into its own window; every recon event is consumed here
    // and returns — nothing recon does belongs in the transcript.
    if (etype === 'hunt_recon_tool' || etype === 'hunt_recon_text') {
      try {
        ctx.reconRef.current?.note(ev as never);
      } catch {
        /* same */
      }
      return;
    }
    // The planner narrates into the wave view, which is already up and has no
    // roster to draw yet. Consumed here rather than falling through: this is
    // the wave's own thinking, not campaign output.
    if (etype === 'hunt_plan_tool' || etype === 'hunt_plan_text') {
      try {
        ctx.waveRef.current?.note(ev);
      } catch {
        /* same */
      }
      return;
    }

    if (etype === 'hunt_recon_skipped') {
      // The scope was already mapped by an earlier campaign, so no recon runs
      // and no recon window goes up. The carried findings are held for the
      // first wave's web, where the tracker can actually show them.
      const carried = (ev['findings'] as Record<string, unknown>[]) ?? [];
      seed.findings = carried;
      const days = Number(ev['age_days'] ?? 0);
      const age = days === 0 ? 'today' : `${days}d old`;
      ctx.sysLine(
        `recon already done — reusing notes (${age}), planning from ${carried.length} earlier finding(s)`,
        true,
      );
      ctx.sysLine(`  ${ev['path'] ?? ''}`);
      ctx.updateBar({ activity: 'hunt: planning' });
    } else if (etype === 'hunt_refused') {
      // A wave with nothing to follow: runHunt decided it, and this is the one
      // place the reason can be shown — before recon, with no overlay to
      // close and no wave to unwind.
      ctx.sysLine(`⚠ ${ev['message'] ?? 'refused'}`, true);
      ctx.updateBar({ activity: 'idle' });
    } else if (etype === 'hunt_recon_start') {
      ctx.sysLine('recon — mapping the target…');
      ctx.updateBar({ activity: 'hunt: recon' });
      // The recon window is not a gate — no keys, no dismiss — but it does
      // paint over the prompt, so /stop-hunt is not typeable while recon runs.
      // ctrl+c is (a priority binding).
      ctx.setRecon(String(ev['target'] ?? target));
    } else if (etype === 'hunt_recon_done') {
      ctx.setRecon(null);
      const text = String(ev['text'] ?? '').trim();
      if (text) {
        ctx.say(m.renderers.agentLine('recon', text, p.accent, p));
      }
      // The recon notes are on disk, and the operator is told where.
      const saved = String(ev['saved'] ?? '').trim();
      if (saved) {
        ctx.sysLine(`recon done — notes in ${saved}`, true);
      } else {
        ctx.sysLine('recon done — planning wave 1', true);
      }
    } else if (etype === 'hunt_wave_start') {
      counter.wave = Number(ev['wave'] ?? 0);
      // `size` is the concurrency cap the planner was *asked* for, not the
      // roster it returned, so it is the denominator but not the agent count —
      // that only arrives with the plan, below.
      counter.total = Number(ev['size'] ?? 0);
      counter.running = 0;
      counter.done = 0;
      counter.agents = 0;
      ctx.loopRail()?.setHunt(counter.wave, 0, 0);
      ctx.say(m.renderers.turnMarker(a.turnCount + counter.wave, p));
      ctx.say(
        m.renderers.userPromptBlock(`⚑ wave ${counter.wave} · ${counter.total} agents`, p),
      );
      // The web goes up with the wave, before the plan arrives, so the screen
      // is already painting when the roster lands.
      ctx.setWave({ target, wave: counter.wave, size: counter.total });
      // Seed the tracker with what earlier campaigns confirmed. Consumed once
      // — later waves already have their own tracker state.
      if (seed.findings.length) {
        for (const f of seed.findings) {
          try {
            ctx.waveRef.current?.note({ type: 'hunt_finding', finding: f });
          } catch {
            /* overlay not up yet — the seed is best-effort */
          }
        }
        seed.findings = [];
      }
    } else if (etype === 'hunt_plan') {
      if (ev['fell_back']) {
        ctx.sysLine('planner reply unreadable — using the fixed vector matrix', true);
        // Show what it actually said: without this the operator cannot tell a
        // prose-wrapped reply from an empty turn from a prompt that needs
        // rewriting.
        const raw = String(ev['raw'] ?? '').trim();
        if (raw) {
          const head = raw.slice(0, 400) + (raw.length > 400 ? '…' : '');
          ctx.say(m.renderers.agentLine('planner', head, p.amber, p));
        } else {
          ctx.sysLine('  (the planner returned nothing)', true);
        }
      }
      if (ev['summary']) ctx.sysLine(String(ev['summary']));
      // The roster is the only place the real agent count appears.
      const workers = (ev['workers'] as { name: string }[]) ?? [];
      counter.agents = workers.length;
      ctx.loopRail()?.setHunt(counter.wave, counter.agents, 0);
      const names = workers.map((w) => w.name).join(', ');
      if (names) ctx.sysLine(`launching ${workers.length} — ${names}`, true);
    } else if (etype === 'hunt_agent_start') {
      counter.running += 1;
      const color = m.theme.agentColor(Number(ev['index'] ?? 0), p);
      colors.set(String(ev['name'] ?? ''), color);
      ctx.loopRail()?.setHunt(counter.wave, counter.agents, counter.done);
      let brief = String(ev['brief'] ?? '');
      if (brief.length > 96) brief = brief.slice(0, 95) + '…';
      ctx.say(
        m.renderers.agentEventLine(String(ev['name'] ?? ''), color, '▸', brief, p),
      );
      ctx.updateBar({
        activity: `hunt w${counter.wave} ${counter.running}/${counter.total}`,
      });
    } else if (etype === 'hunt_agent_tool') {
      ctx.say(
        m.renderers.agentEventLine(
          String(ev['name'] ?? ''),
          colors.get(String(ev['name'] ?? '')) ?? p.dim,
          String(ev['tool'] ?? '?'),
          m.tools.summariseCall(
            String(ev['tool'] ?? ''),
            (ev['args'] as Record<string, unknown>) ?? {},
            ctx.cfg,
          ),
          p,
        ),
      );
    } else if (etype === 'hunt_agent_text') {
      // The worker's own reasoning. Dropped in an earlier revision, which
      // meant the transcript showed commands with no explanation of why.
      ctx.say(
        m.renderers.agentLine(
          String(ev['name'] ?? ''),
          String(ev['text'] ?? ''),
          p.dim,
          p,
        ),
      );
    } else if (etype === 'hunt_agent_result') {
      // The other half of the call above: what the command actually returned,
      // rendered as the same panel a normal turn uses.
      if (ev['blocked']) {
        ctx.say(m.renderers.blockedBlock(String(ev['output'] ?? ''), p));
      } else {
        ctx.say(
          m.renderers.huntToolPanel(
            String(ev['tool'] ?? '?'),
            (ev['args'] as Record<string, unknown>) ?? {},
            String(ev['output'] ?? ''),
            p,
            {
              agent: String(ev['name'] ?? ''),
              color: colors.get(String(ev['name'] ?? '')) ?? '',
              isError: !ev['ok'],
              meta: (ev['meta'] as Record<string, unknown>) ?? {},
            },
          ),
        );
      }
    } else if (etype === 'hunt_agent_done') {
      counter.running = Math.max(0, counter.running - 1);
      counter.done += 1;
      ctx.loopRail()?.setHunt(counter.wave, counter.agents, counter.done);
      if (!ev['ok']) {
        ctx.sysLine(`  ${ev['name']} failed — ${ev['error'] ?? 'unknown'}`, true);
      }
    } else if (etype === 'hunt_finding') {
      const f = (ev['finding'] ?? {}) as FindingDict;
      const sev = String(f['severity'] ?? 'info').toUpperCase();
      ctx.say(
        m.renderers.agentEventLine(
          String(f['agent'] ?? '?'),
          p.accent,
          ev['saved'] ? '◆' : '·',
          `[${sev}] ${f['title'] ?? ''}` + (ev['saved'] ? '  ·  saved' : ''),
          p,
          { ok: Boolean(ev['saved']) },
        ),
      );
      // Keep the tracker in step with the transcript: it reads the run's own
      // list, so a finding the tracker already had is not added twice.
      refreshFindings(ctx);
    } else if (etype === 'hunt_wave_end') {
      // The wave is over, so the web comes down and the transcript — which
      // has the whole wave's tool output in it — is readable again. Dropped
      // here rather than at the next wave start so the operator gets the
      // transcript back while the planner thinks.
      ctx.setWave(null);
      // Every agent has reported, so `done` is already the roster size. Leave
      // it — forcing it to the concurrency cap would show a wave that planned
      // three agents as 10/10.
      ctx.loopRail()?.setHunt(counter.wave, counter.agents, counter.done);
      ctx.huntTokensRef.current = [
        ctx.huntTokensRef.current[0] + Number(ev['input'] ?? 0),
        ctx.huntTokensRef.current[1] + Number(ev['output'] ?? 0),
        ctx.huntTokensRef.current[2] + Number(ev['cost'] ?? 0),
      ];
      ctx.sysLine(
        `wave ${ev['wave']} done — ${ev['ok']}/${ev['agents']} ok, ${ev['found']} finding(s)  ·  $${Number(ev['cost'] ?? 0).toFixed(4)}`,
        true,
      );
    } else if (etype === 'hunt_summary_done') {
      ctx.say(
        m.renderers.agentLine('summary', String(ev['text'] ?? ''), p.accent, p),
      );
      ctx.sysLine(`report archived: ${ev['path']}`, true);
    } else if (etype === 'hunt_end') {
      ctx.sysLine(
        `hunt ended — ${ev['wave']} wave(s), ${ev['findings']} finding(s), ${ev['saved']} report(s) in ${ev['directory']}`,
        true,
      );
      registerHunt(ctx, ev);
      // The campaign is over; if the tracker is open it becomes a record of
      // the run rather than a live view.
      if (ctx.findingsRef.current) {
        ctx.findingsRef.current = { ...ctx.findingsRef.current, live: false };
        ctx.setFindings(ctx.findingsRef.current);
        refreshFindings(ctx);
      }
    }
  };

  ctx.updateBar({ activity: 'thinking' });

  try {
    await m.hunt.runHunt(ctx.cfg, target, {
      onEvent,
      agentFactory: ctx.teamAgentFactory,
      stop: ctx.huntStopRef.current,
      summaryFlag: () => ctx.huntSummaryQueuedRef.current,
      run,
      fresh: opts?.fresh ?? false,
      waveNumber: opts?.waveNumber ?? null,
      kind: opts?.kind,
    });
    // A summary asked for but never delivered — the hunt was stopped between
    // the request and a wave boundary. Offer it now rather than dropping it.
    if (ctx.huntSummaryQueuedRef.current) {
      ctx.huntSummaryQueuedRef.current = false;
      ctx.sysLine('summary was queued but never ran — use /summary-hunt');
    }
  } catch (e) {
    ctx.say(m.renderers.errorBlock(`hunt failed: ${errName(e)}`, p));
  } finally {
    if (isCurrent()) {
      // A stop or a crash during recon must not leave the window up over a
      // dead campaign — and the same for a wave stopped mid-flight.
      ctx.setRecon(null);
      ctx.setWave(null);
      ctx.setBusyBoth(false);
      ctx.huntRunRef.current = null;
      ctx.chat()?.clearStream();
      ctx.chat()?.cardFinish();
      ctx.streamBufRef.current = '';
      ctx.updateBar({
        activity: 'idle',
        inputTokens: a.sessionInputTokens + ctx.huntTokensRef.current[0],
        outputTokens: a.sessionOutputTokens + ctx.huntTokensRef.current[1],
        cost: a.sessionCost + ctx.huntTokensRef.current[2],
        turns: a.turnCount,
        model: ctx.cfg.model,
      });
      // Hand the rail back to the main agent. Three separate calls because
      // each owns one thing: setHunt drops the campaign counters, setStage
      // clears HACK, and syncRails pushes the session totals back in. Without
      // the second the rail stayed lit on HACK after the campaign ended.
      ctx.loopRail()?.setHunt(null);
      ctx.loopRail()?.setStage('idle');
      ctx.syncRails();
      ctx.setRainBoth(ctx.cfg.rain);
    }
    // Last, and inside the finally, so it runs on a campaign that crashed
    // exactly as it does on one that finished. The callback owns its own
    // exceptions: a reporting seam that took the app down over a formatting
    // error would be worse than the silence it replaced.
    if (opts?.onFinish) {
      try {
        opts.onFinish();
      } catch {
        /* see above */
      }
    }
  }
}

// === SECTION === hunt commands: stop / summary / findings / report =======================

export function cmdStopHunt(ctx: AppCtx): void {
  // Works while the harness is busy — that is its whole job.
  if (!ctx.huntRunRef.current) {
    ctx.sysLine('no hunt is running', true);
    return;
  }
  ctx.huntStopRef.current?.set();
  ctx.sysLine('stop requested — cancelling the wave…', true);
}

export function cmdSummaryHunt(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  // Mid-hunt this only *queues* the summary: it runs at the next wave
  // boundary, because a second turn streaming into the same transcript would
  // corrupt the one already running.
  if (ctx.huntRunRef.current) {
    ctx.huntSummaryQueuedRef.current = true;
    ctx.sysLine(
      `summary queued — it runs at the end of wave ${ctx.huntRunRef.current.wave}`,
      true,
    );
    return;
  }
  const latest = latestHuntDir(ctx);
  if (latest === undefined) {
    ctx.sysLine('no hunt has run in this session yet', true);
    return;
  }
  const run = m.hunt.loadRun(latest);
  if (!run) {
    ctx.sysLine(`no findings archived in ${latest}`, true);
    return;
  }
  void runSummary(ctx, run);
}

async function runSummary(ctx: AppCtx, run: HuntRunLike): Promise<void> {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const p = ctx.pal();
  ctx.setBusyBoth(true);
  ctx.updateBar({ activity: 'writing the hunt report' });
  ctx.say(m.renderers.turnMarker(a.turnCount + 1, p));
  ctx.say(m.renderers.userPromptBlock('⚑ /summary-hunt', p));
  try {
    let text = '';
    for await (const ev of a.runTurn(m.hunt.summaryPrompt(run))) {
      if (ev.type === 'text_delta') text += ev.text;
      ctx.handleEvent(ev);
    }
    // No prose means the narrative half failed — the findings are already on
    // disk, so the report falls back to what was recorded rather than to an
    // empty file, and says so, so nobody reads a machine-written report as the
    // model's assessment.
    const narrated = Boolean(text.trim());
    if (!narrated) text = m.hunt.buildEvidenceReport(run);
    const outPath = m.hunt.writeSummary(ctx.cfg, run, text);
    if (narrated) {
      ctx.sysLine(`report archived: ${outPath}`, true);
    } else {
      ctx.sysLine(
        `the model returned no report — archived the recorded evidence instead: ${outPath}`,
        true,
      );
    }
  } catch (e) {
    ctx.say(m.renderers.errorBlock(`summary failed: ${errName(e)}`, p));
  } finally {
    ctx.setBusyBoth(false);
    ctx.updateBar({ activity: 'idle' });
    ctx.syncRails();
  }
}

export function cmdFindings(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  // Mid-hunt it opens the live campaign's findings; with no hunt running it
  // reads the most recent campaign off disk, the same way /summary-hunt does.
  // Opening it again closes it, so the command toggles.
  if (ctx.findingsRef.current) {
    ctx.findingsRef.current = null;
    ctx.setFindings(null);
    return;
  }
  let target: string;
  let live: boolean;
  let run: HuntRunLike | undefined;
  if (ctx.huntRunRef.current) {
    run = ctx.huntRunRef.current;
    target = run.target;
    live = true;
  } else {
    const latest = latestHuntDir(ctx);
    run = latest !== undefined ? m.hunt.loadRun(latest) : undefined;
    if (!run) {
      ctx.sysLine(
        'no findings yet — run /bug-hunt, or /findings after one has finished',
        true,
      );
      return;
    }
    target = run.target;
    live = false;
  }
  const items = run.ranked().map((f) => findingDict(ctx, f));
  ctx.findingsRef.current = { target, live, items };
  ctx.setFindings(ctx.findingsRef.current);
}

export function cmdReportBugHunt(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // No model call: the report is assembled from what was recorded, so nothing
  // in it is a paraphrase of evidence. Refused while busy because the live
  // run's findings are still arriving and a report built from half a wave
  // under-counts; the command says "stop the wave first" itself.
  if (ctx.busyRef.current) {
    ctx.sysLine('harness is busy — /stop-hunt the wave first, then write the report', true);
    return;
  }
  const latest = latestHuntDir(ctx);
  if (latest === undefined) {
    ctx.sysLine('no hunt has run in this session yet', true);
    return;
  }
  const run = m.hunt.loadRun(latest);
  if (!run || !run.findings.length) {
    ctx.sysLine(`no findings archived in ${latest}`, true);
    return;
  }
  let outPath: string | null;
  try {
    outPath = m.hunt.writeEvidenceReport(ctx.cfg, run);
  } catch (e) {
    ctx.sysLine(`⚠ could not write the report — ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  if (outPath === null) {
    ctx.sysLine('nothing to report', true);
    return;
  }
  ctx.say(
    <Box flexDirection="column">
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ REPORT    '}
        </Text>
        <Text bold color={p.primary}>
          {`${run.findings.length} finding(s), ${run.waveRecords.length || run.wave} wave(s)\n`}
        </Text>
      </Box>
      <Box>
        <Text bold color={p.accent}>
          {'  ◈ EVIDENCE  '}
        </Text>
        <Text color={p.dim}>{outPath + '\n'}</Text>
      </Box>
    </Box>,
  );
  ctx.sysLine(
    'evidence only — no remediation, no narrative; /summary-hunt writes the other report',
    true,
  );
}
