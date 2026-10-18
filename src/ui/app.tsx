/**
 * app.tsx — the Andy shell: Ink+React port of zimzilla/ui/app.py (ZimZillaApp).
 *
 * What this module is: the top-level application — boot screen, then the shell
 * (HeaderBar + LoopRail + ChatPane + ZimPane + TelemetryRail + StatusBar +
 * prompt) with the slash-command surface, the agent turn loop, and the hunt /
 * team / osint / phish / crack / ad campaign workers. Invariants: one Agent
 * constructed with the app's permission modal as its permissionHandler; slash
 * commands dispatch before the busy gate (the busy-permitted set is BUSY_OK);
 * the transcript is append-only through ChatPane's imperative handle.
 *
 * WHY the lazy sibling registry below: every sibling module (config, agent,
 * tools, ui/widgets, …) is ported in parallel by other lanes and may not exist
 * on disk yet, and this file must typecheck with zero errors of its own before
 * they land. Each sibling is therefore imported through a non-literal
 * `import(specifier)` (left unresolved at typecheck, resolved at runtime by
 * tsx/Node) and cast to the PORT-MAP §2 contract written beside it. At
 * integration time these can be swapped for static imports without touching
 * any handler logic.
 */

import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FC, ReactNode, Ref } from 'react';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent,
  ChatMessage,
  Deliverable,
  PermissionDecision,
  PermissionHandler,
  Preview,
  SessionPayload,
  SessionSummary,
  ToolSchema,
} from '../shared.js';
import { PermissionModal } from './screens/permission-modal.js';
import { ReconOverlay } from './screens/recon-overlay.js';
import type { ReconOverlayHandle, ReconEvent } from './screens/recon-overlay.js';
import { WaveOverlay } from './screens/wave-overlay.js';
import type { WaveOverlayHandle } from './screens/wave-overlay.js';
import { ScopePasteScreen } from './screens/scope-paste-screen.js';
import { FindingsPanel } from './screens/findings-panel.js';
import {
  cmdClear,
  cmdCompact,
  cmdCost,
  cmdHelp,
  cmdLimits,
  cmdLoad,
  cmdMode,
  cmdPanes,
  cmdRain,
  cmdSave,
  cmdScope,
  cmdTheme,
  cmdThink,
  cmdZimOpencode,
} from './screens/commands.js';
import {
  cmdGatewayKey,
  cmdLdxhubKey,
  cmdLdxhubModels,
  cmdLogfareModels,
  cmdModel,
  cmdModels,
  cmdTokenharbourKey,
  cmdTokenharbourModels,
  cmdZimGateway,
  cmdZimSource,
  cmdZimTokenharbour,
} from './screens/model-commands.js';
import {
  cmdAd,
  cmdBugHunt,
  cmdCrack,
  cmdFindings,
  cmdOsint,
  cmdOsintTree,
  cmdPhish,
  cmdReportBugHunt,
  cmdScopeValidator,
  cmdStopHunt,
  cmdSummaryHunt,
  cmdTeam,
  finaliseOsint,
  runScopeValidator,
} from './screens/campaigns.js';

// === SECTION === sibling contracts (PORT-MAP §2, one entry per import) ===

/** Non-literal on purpose — see the file contract block. */
async function sibling<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

/** theme.Palette — frozen dataclass of hex/ANSI colour strings. */
export interface Palette {
  name: string;
  bg: string;
  primary: string;
  dim: string;
  accent: string;
  red: string;
  amber: string;
  glow: string;
}

/** Pre-hydration placeholder; identical to PALETTES[DEFAULT_THEME] (ink). */
const INK_PLACEHOLDER: Palette = {
  name: 'zim-ink',
  bg: '#000000',
  primary: '#ece9e4',
  dim: '#5c6470',
  accent: '#e8843c',
  red: '#ff5d5d',
  amber: '#f5b25e',
  glow: '#ece9e4',
};

export interface TerminalColorsLike {
  background?: string;
  foreground?: string;
  colors?: string[];
}

export interface ModeSpec {
  label: string;
  blurb: string;
  loud?: boolean;
}

/** config.Config — a MUTABLE object: the app repoints model/baseUrl/mode on it. */
export interface ConfigLike {
  baseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
  workdir: string;
  unsafe: boolean;
  allowPath: string | null;
  denyPath: string | null;
  legacyScopePath: string | null;
  maxTokens: number;
  temperature: number;
  requestTimeout: number;
  contextWindow: number;
  compactAt: number;
  autoCompact: boolean;
  maxIterations: number;
  maxRounds: number;
  bashTimeout: number;
  maxOutputChars: number;
  theme: string;
  rain: boolean;
  bootRain: boolean;
  showThinking: boolean;
  mode: string;
  agentsPath: string | null;
  stateDir: string;
  apiKeyPresent: boolean;
  redactedEndpoint(): string;
}

export interface HostSetLike {
  domains: string[];
  ips: string[];
  cidrs: string[];
  empty: boolean;
  describe(): string;
}

export interface ScopeLike {
  armed: boolean;
  loaded: boolean;
  allowPath: string | null;
  denyPath: string | null;
  allow: HostSetLike;
  deny: HostSetLike;
  badge(): string;
  allows(host: string): [boolean, string];
  extractTargets(cmd: string): string[];
}

export interface AgentLike {
  messages: ChatMessage[];
  scope: ScopeLike;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCost: number;
  turnCount: number;
  lastTurnCost: number;
  /** Python `agent._last_input_tokens` — read by /limits. */
  lastInputTokens?: number;
  runTurn(
    prompt: string,
    deliverable?: Deliverable,
  ): AsyncGenerator<AgentEvent, void, unknown>;
  setModel(m: string): void;
  setMode(m: string): void;
  clear(): void;
  cancelTurn(): void;
  notice(text: string): void;
  compact(): Promise<[boolean, string]>;
  contextWindow(): number;
  /** Python `agent._client = None` — drop the cached client on source switch. */
  resetClient?(): void;
}

export type AgentCtor = new (
  cfg: ConfigLike,
  permissionHandler?: PermissionHandler,
  toolHook?: unknown,
  canReport?: boolean,
  canHuntRead?: boolean,
  canPeer?: boolean,
  peerInbox?: () => string,
) => AgentLike;

// ---- ui/widgets.tsx: ref handles + prop-driven chrome widgets -------------

export interface ChatPaneHandle {
  writeBlock(node: ReactNode): void;
  clear(): void;
  setStream(text: string): void;
  clearStream(): void;
  setReasoning(text: string): void;
  clearReasoning(): void;
  cardBegin(name: string, args: Record<string, unknown>, targets?: string[]): void;
  cardTick(): void;
  cardFinish(): void;
  setSpinner(text: string): void;
  clearSpinner(): void;
  setRain(on: boolean): void;
  applyPalette(p: Palette): void;
  flashCursor(): void;
}

export interface ZimPaneHandle {
  showCampaign(host: string): void;
  showHunt(target: string, size: number): void;
  noteHunt(event: Record<string, unknown>): void;
  note(event: Record<string, unknown>): void;
  hide(): void;
  applyPalette(p: Palette): void;
}

export interface LoopRailHandle {
  setStage(stage: string): void;
  setCapped(rounds: number, limit: number, hard?: boolean): void;
  clearCap(): void;
  setCounters(turn: number, iteration: number): void;
  setHunt(wave: number | null, agents?: number, done?: number): void;
  tickPulse(): void;
  applyPalette(p: Palette): void;
  clearTrail?(): void;
}

export interface TelemetryRailHandle {
  setCost(cost: number, tokIn: number, tokOut: number): void;
  setContext(used: number, total?: number): void;
  touchFile(p: string): void;
  clearFiles(): void;
  noteCall(name: string): void;
  noteResult(name: string, ok: boolean): void;
  pushWave(sample: number): void;
  applyPalette(p: Palette): void;
}

/** A widget FC taking a React-19 `ref` prop for its imperative handle. */
type HandleWidget<P, H> = FC<P & { ref?: Ref<H> }>;

export interface WidgetsModule {
  HeaderBar: FC<{
    palette: Palette;
    model: string;
    cwd: string;
    unsafe: boolean;
    themeName: string;
    mode: string;
    scopeBadge: string;
    scopeArmed: boolean;
  }>;
  StatusBar: FC<{
    palette: Palette;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    turns: number;
    iterations: number;
    activity: string;
    busy: boolean;
    /** Drives the elapsed clock — bumped once a second by the app. */
    tick: number;
  }>;
  WelcomeHint: FC<{ palette: Palette }>;
  ChatPane: HandleWidget<{ palette: Palette; rain?: boolean }, ChatPaneHandle>;
  ZimPane: HandleWidget<{ palette: Palette }, ZimPaneHandle>;
  NEWLINE_GLYPH?: string;
}

// ---- ui/renderers.tsx (consumed as namespace R) ----------------------------

export type FindingDict = Record<string, unknown> & {
  severity?: string;
  title?: string;
  agent?: string;
};

export interface RenderersModule {
  turnMarker(turn: number, palette: Palette): ReactNode;
  userPromptBlock(text: string, palette: Palette): ReactNode;
  errorBlock(message: string, palette: Palette): ReactNode;
  warningBlock(message: string, palette: Palette): ReactNode;
  blockedBlock(message: string, palette: Palette): ReactNode;
  diffPanel(pathT: string, diff: string, palette: Palette, verb?: string): ReactNode;
  toolResultPanel(
    name: string,
    args: Record<string, unknown>,
    output: string,
    palette: Palette,
    isError?: boolean,
    meta?: Record<string, unknown>,
  ): ReactNode;
  huntToolPanel(
    tool: string,
    args: Record<string, unknown>,
    output: string,
    palette: Palette,
    opts?: {
      agent?: string;
      color?: string;
      isError?: boolean;
      meta?: Record<string, unknown>;
    },
  ): ReactNode;
  renderOutputText(output: string, palette: Palette): ReactNode;
  reasoningPanel(text: string, palette: Palette): ReactNode;
  agentLine(name: string, text: string, color: string, palette: Palette): ReactNode;
  agentEventLine(
    name: string,
    color: string,
    verb: string,
    detail: string,
    palette: Palette,
    opts?: { ok?: boolean },
  ): ReactNode;
  findingLine(f: FindingDict, palette: Palette): ReactNode;
  findingDetail(f: FindingDict, palette: Palette): ReactNode;
}

// ---- ui/markdown.tsx, ui/rails.tsx, ui/web.tsx, ui/boot.tsx ----------------

export interface MarkdownModule {
  markdownRenderable(text: string, palette: Palette): ReactNode;
}

export interface RailsModule {
  LoopRail: HandleWidget<{ palette: Palette }, LoopRailHandle>;
  TelemetryRail: HandleWidget<
    { palette: Palette; totalContext: number },
    TelemetryRailHandle
  >;
}

/** WaveWeb — the hunt grid controller from ui/web.tsx; it accumulates agent
 * state for a whole wave, so it is constructed once per overlay. */
export interface WaveWebLike {
  wave: number;
  hover: { x: number; y: number } | null;
  detail: unknown | null;
  stopping: boolean;
  setPlan(workers: unknown[], opts?: { wave?: number }): void;
  agentStart(name: string, brief: string): void;
  agentActivity(name: string, command: string): void;
  agentResult(name: string, command: string, output: string): void;
  agentText(name: string, text: string): void;
  agentDone(name: string, ok: boolean): void;
  addFinding(f: FindingDict): void;
  plannerText(text: string): void;
  plannerTool(tool: string, args: Record<string, unknown>, cfg: ConfigLike): void;
  end(): void;
  resizeRail(delta: number): void;
  resizeDrawer(delta: number): void;
  scrollDetail?(delta: number): void;
  closeDetail(): void;
  render(w: number, h: number): ReactNode;
}

export type WaveWebCtor = new (
  target: string,
  palette: Palette,
  opts?: { wave?: number; size?: number },
) => WaveWebLike;

export interface WebModule {
  WaveWeb: WaveWebCtor;
}

export interface BannerModule {
  splashMark(palette: Palette, model?: string, baseUrl?: string): ReactNode;
}

export interface BootModule {
  BootScreen: FC<{
    palette: Palette;
    checks: [string, string, boolean][];
    onDone: (typed: string[] | null, submit: boolean) => void;
    rain?: boolean;
  }>;
}

// ---- ui/complete.tsx, ui/palette-cmd.tsx -----------------------------------

export interface CompleteModule {
  SLASH_COMMANDS: [string, string][];
  MODE_NAMES: string[];
  iterFiles?(root: string, limit?: number): string[];
}

export interface PaletteEntryLike {
  key: string;
  title: string;
  hint?: string;
  group?: string;
  run?: () => void;
}

export interface PaletteCmdModule {
  CommandPalette: FC<{
    entries: PaletteEntryLike[];
    palette: Palette;
    onChoose: (entry: PaletteEntryLike | null) => void;
  }>;
}

// ---- core runtime modules ---------------------------------------------------

export interface ThemeModule {
  getPalette(
    name: string,
    bg?: string | null,
    opts?: { colors?: TerminalColorsLike },
  ): Palette;
  setCurrentTheme(name: string): void;
  THEME_NAMES: string[];
  SYSTEM_THEME: string;
  THINKING_VERBS: string[];
  agentColor(index: number, palette?: Palette): string;
}

export interface ConfigModule {
  MODES: Record<string, ModeSpec>;
  KNOWN_MODELS: string[];
  findAgentsFile(workdir: string, home?: string): string | undefined;
  priceFor(model: string): [number, number];
}

export interface SessionModule {
  save(cfg: ConfigLike, agent: AgentLike, name?: string | null): string;
  load(cfg: ConfigLike, agent: AgentLike, name: string): Promise<[boolean, string]>;
  listSessions(cfg: ConfigLike): SessionSummary[];
}

export interface ToolsModule {
  TOOL_SCHEMAS: ToolSchema[];
  summariseCall(
    name: string,
    args: Record<string, unknown>,
    cfg: ConfigLike,
    maxLen?: number,
  ): string;
  /** Python tools._campaign_dirs — newest-artefact-ordered campaign dirs. */
  campaignDirs?(stateDir: string): string[];
}

export interface ScopeModule {
  Scope: { load(allow?: string, deny?: string): ScopeLike };
}

export interface SandboxModule {
  resolveInJail(
    workdir: string,
    raw: string,
    unsafe?: boolean,
    opts?: { mustExist?: boolean },
  ): string;
}

// ---- provider / credential sources -----------------------------------------

export interface SourceLike {
  key: string;
  label: string;
  port: number;
  baseUrl: string;
  model: string;
  profile?: string;
  service?: string;
}

export interface CatalogModel {
  id: string;
  blurb: string;
  free?: boolean;
  healthy?: boolean;
  status?: string;
  redundancy?: string;
  upstreamNote?: string;
  pin?(): string | null;
}

/** The shared provider-catalog contract (PORT-MAP §2.5); members only the
 * module actually serves are non-optional. */
export interface ProviderModule {
  loadCredentials(): [string, string, string] | null;
  fetchModels(token?: string): Promise<[CatalogModel[] | null, string]>;
  cachedModels(): CatalogModel[] | null;
  catalogAge(): number | null;
  CACHE_TTL: number;
  clearCache(): void;
  looksLikeKey(v: string): boolean;
  applyTo(cfg: ConfigLike): [string, string] | null;
  setCurrent(key: string): void;
  activeEndpoint?(baseUrl: string): boolean;
  isTokenharbour?(baseUrl: string): boolean;
  PROFILE?: string;
  priceFor?(model: string, models?: CatalogModel[] | null): [number, number] | null;
  healthFor?(model: string): { healthy: boolean; status: string } | null;
  usableFreeModels?(token?: string): Promise<[CatalogModel[] | null, string]>;
  freeModels?(token?: string): Promise<[CatalogModel[] | null, string]>;
  saveKey?(key: string, model?: string): string;
  savePin?(model: string, peer: string): void;
  proxyPort?(): number;
  reachable?(): boolean;
  HOST?: string;
  STATUS_PATH?: string;
}

export interface LdxEntry {
  id: string;
  summary: string;
}

export interface LdxhubModule {
  SERVICES: Record<string, string>;
  loadCredentials(): [string, Record<string, string>, string] | null;
  saveKey(key: string): string;
  looksLikeKey(v: string): boolean;
  clearCache(): void;
  saveDefault(service: string, entryId: string): string | null;
  fetchCatalog(service: string, token?: string): Promise<[LdxEntry[] | null, string]>;
  PROFILE?: string;
}

// ---- campaign engines ------------------------------------------------------

export type HuntEvent = Record<string, unknown> & { type: string };
export type TeamEvent = Record<string, unknown> & { type: string };

/** asyncio.Event stand-in handed to runHunt as the stop flag. */
export interface StopSignal {
  isSet(): boolean;
  set(): void;
}

export interface HuntRunLike {
  target: string;
  directory: string;
  wave: number;
  findings: FindingDict[];
  waveRecords: unknown[];
  ranked(): unknown[];
}

export interface HuntModule {
  HUNT_WAVE_SIZE: number;
  AD_KIND: unknown;
  caseDir(cfg: ConfigLike, target: string, kind?: unknown): string;
  findRecon(directory: string):
    | { path: { name: string }; ageDays: number }
    | undefined;
  nextWaveNumber(directory: string): number;
  HuntRun: new (opts: { target: string; directory: string }) => HuntRunLike;
  runHunt(
    cfg: ConfigLike,
    target: string,
    opts: {
      onEvent: (ev: HuntEvent) => void | Promise<void>;
      agentFactory: (cfg: ConfigLike) => AgentLike;
      stop: StopSignal;
      summaryFlag: () => boolean;
      run: HuntRunLike;
      fresh?: boolean;
      waveNumber?: number | null;
      kind?: unknown;
    },
  ): Promise<void>;
  summaryPrompt(run: HuntRunLike): string;
  writeSummary(cfg: ConfigLike, run: HuntRunLike, text: string): string;
  buildEvidenceReport(run: HuntRunLike): string;
  writeEvidenceReport(cfg: ConfigLike, run: HuntRunLike): string | null;
  loadRun(directory: string): HuntRunLike | undefined;
  migrateHunts(cfg: ConfigLike): string[];
  reorganiseWaves(cfg: ConfigLike): string[];
  /** Python hunt._finding_dict — unexported upstream, so optional here. */
  findingDict?(f: unknown): FindingDict;
}

export interface WorkerResultLike {
  name: string;
  ok: boolean;
  text: string;
  error?: string;
  cost?: number;
}

export interface TeamModule {
  runTeam(
    cfg: ConfigLike,
    task: string,
    opts: {
      onEvent: (ev: TeamEvent) => void;
      agentFactory: (cfg: ConfigLike) => AgentLike;
    },
  ): Promise<WorkerResultLike[]>;
  synthesisPrompt(task: string, results: WorkerResultLike[]): string;
}

export interface OsintKind {
  name: string;
  targetLabel: string;
  blurb: string;
  built: boolean;
}

export interface OsintModule {
  OSINT_KINDS: Record<string, OsintKind>;
  KIND_ORDER: string[];
  validate(kind: OsintKind, target: string): [boolean, string];
  caseDir(cfg: ConfigLike, kind: OsintKind, target: string): string;
  buildPrompt(kind: OsintKind, target: string, caseDir: string): string;
  normalise(kind: OsintKind, target: string): string;
  finaliseCase(cfg: ConfigLike, caseDir: string): [string | null, boolean];
  reportsDir(cfg: ConfigLike): string;
}

export interface OsintNode {
  title?: string;
  children: OsintNode[];
  [k: string]: unknown;
}

export interface OsintTreeModule {
  parseReportFile(report: string): OsintNode;
  summaryLine(node: OsintNode): string;
  renderTree(node: OsintNode, palette: Palette): ReactNode;
  findReport(cfg: ConfigLike, which?: string | null): string | undefined;
}

export interface PhishCampaign {
  host: string;
  alive: boolean;
  localUrl: string;
  publicUrl: string | null;
  cloneNote: string;
  directory: string;
  creds: unknown[];
  hits: unknown[];
  tunnel: { tool?: string; error?: string };
}

export interface PhishModule {
  validateTarget(raw: string): [boolean, string];
  normaliseTarget(raw: string): string;
  active(): PhishCampaign | null;
  start(
    cfg: ConfigLike,
    target: string,
    onEvent: (ev: Record<string, unknown>) => void,
    opts?: { tunnel?: boolean },
  ): Promise<PhishCampaign>;
  stop(): PhishCampaign | null;
}

export interface CrackDetected {
  name: string;
  count: number;
  mode: number;
}

export interface CrackPlannedStage {
  stage: { name: string };
  run: boolean;
  seconds: number;
  reason?: string;
}

export interface CrackModule {
  HASH_MODES: Record<number, [string, string]>;
  rateFor(mode: number): number;
  plan(mode: number, maxTime: number, opts?: { deep?: boolean }): CrackPlannedStage[];
  humanTime(s: number): string;
  identify(source: string): CrackDetected[];
  validatePath(raw: string): [string | null, string];
  caseDir(cfg: ConfigLike, source: string): string;
  potfile(cfg: ConfigLike): string;
  finaliseCase(cfg: ConfigLike, caseDir: string): string | null;
  buildPrompt(
    cfg: ConfigLike,
    source: string,
    caseDir: string,
    detected: CrackDetected[],
    maxTime: number,
  ): string;
}

export interface AdToolProbe {
  name: string;
  present: boolean;
  vector: string;
  hint: string;
}

export interface AdVerdict {
  destructive: boolean;
  reason: string;
}

export interface AdModule {
  DEFAULT_LOCKOUT: number;
  DEFAULT_RATE: number;
  DEFAULT_BURST: number;
  validateTarget(raw: string): string;
  refusal(domain: string): string;
  probeTools(): AdToolProbe[];
  unavailableVectors(probes: AdToolProbe[]): string[];
  adKind(opts: {
    lockout: number;
    armed: boolean;
    probes: AdToolProbe[];
    onRefuse: (verdict: AdVerdict, command: string) => void;
  }): unknown;
  AD_KIND: unknown;
}

export interface PanesModule {
  currentSession(): string | null;
  tmuxAvailable(): boolean;
  Relaunch: new (opts: { resume?: string | null }) => unknown;
  transcriptOf(messages: ChatMessage[]): [string, string][];
  mailboxRoot(stateDir: string, session: string): string;
  register(root: string, agent: string): void;
  currentAgent(): string | null;
  drain(root: string, agent: string): unknown[];
  formatMessages(msgs: unknown[]): string;
}

export interface OcProxy {
  url: string;
}

export interface OpencodeModule {
  findBinary(): string | null;
  DEFAULT_MODEL: string;
  getPool(opts: {
    refresh?: boolean;
    binary: string;
    model: string;
  }): { proxies: OcProxy[] };
  findWorkingProxy(
    binary: string,
    opts: { model: string; attempts: number; pool: { proxies: OcProxy[] } },
  ): [OcProxy | null, string];
  installAlias(): [boolean, string];
  ALIAS: string;
  run(
    proxy: OcProxy | null,
    binary: string,
    opts?: { args?: string[]; model?: string | null; cwd?: string },
  ): Promise<number>;
  probeExitIp(proxy: OcProxy): string | null;
}

export interface ScopeEntryLike {
  asset: string;
  note?: string;
}

export interface ExtractionLike {
  inScope: ScopeEntryLike[];
  outOfScope: ScopeEntryLike[];
  programme: string;
  rules: string[];
}

export interface RankedLike {
  asset: string;
  rank: number;
  value: string;
  why?: string;
}

export interface ScopeValidatorModule {
  EXTRACT_PROMPT: string | ((opts: { overview: string }) => string);
  parseExtraction(text: string): ExtractionLike | null;
  buildScope(
    ins: ScopeEntryLike[],
    outs: ScopeEntryLike[],
  ): [string, string, string[]];
  writeScopeFiles(
    dest: string,
    allow: string,
    deny: string,
    programme?: string,
  ): [string, string];
  verifyScopeFiles(allowPath: string, denyPath: string): string[];
  reconAll(
    hosts: string[],
    scope: ScopeLike,
  ): Promise<Record<string, Record<string, unknown>>>;
  reconLine(r: Record<string, unknown>): string;
  rankPrompt(
    programme: string,
    assets: string[],
    recon: Record<string, Record<string, unknown>>,
  ): string;
  parseRanking(text: string, assets: string[]): [RankedLike[], string] | null;
  Ranked: new (asset: string, rank: number, value: string, why: string) => RankedLike;
  hostOf?(asset: string): string;
}

export interface SourcesModule {
  activeKey(baseUrl: string): string | undefined;
  modelsFor(baseUrl: string): string[] | undefined;
  discover(): Record<string, SourceLike>;
  proxyHealthy(port: number): boolean;
  startProxy(src: SourceLike): Promise<[boolean, string]>;
  loadProfile(src: SourceLike): Record<string, string>;
  setCurrent(key: string): void;
  catalogFor?(baseUrl: string): CatalogModel[] | undefined;
}

export interface Mods {
  config: ConfigModule;
  theme: ThemeModule;
  session: SessionModule;
  tools: ToolsModule;
  scope: ScopeModule;
  sandbox: SandboxModule;
  sources: SourcesModule;
  logfare: ProviderModule;
  tokenharbour: ProviderModule;
  openrouter: ProviderModule;
  unorouter: ProviderModule;
  aihubmix: ProviderModule;
  antseed: ProviderModule;
  ldxhub: LdxhubModule;
  agent: { Agent: AgentCtor };
  team: TeamModule;
  hunt: HuntModule;
  ad: AdModule;
  crack: CrackModule;
  osint: OsintModule;
  osintTree: OsintTreeModule;
  phish: PhishModule;
  panes: PanesModule;
  opencode: OpencodeModule;
  scopeValidator: ScopeValidatorModule;
  widgets: WidgetsModule;
  renderers: RenderersModule;
  markdown: MarkdownModule;
  rails: RailsModule;
  web: WebModule;
  banner: BannerModule;
  boot: BootModule;
  complete: CompleteModule;
  paletteCmd: PaletteCmdModule;
}

/** Load every sibling module once. tsx/Node resolves the relative specifiers
 * at runtime; the non-literal argument keeps TypeScript from failing on files
 * that are still being ported in parallel lanes. */
async function loadMods(): Promise<Mods> {
  const [
    config,
    theme,
    session,
    tools,
    scope,
    sandbox,
    sources,
    logfare,
    tokenharbour,
    openrouter,
    unorouter,
    aihubmix,
    antseed,
    ldxhub,
    agent,
    team,
    hunt,
    ad,
    crack,
    osint,
    osintTree,
    phish,
    panes,
    opencode,
    scopeValidator,
    widgets,
    renderers,
    markdown,
    rails,
    web,
    banner,
    boot,
    complete,
    paletteCmd,
  ] = await Promise.all([
    sibling<ConfigModule>('../config.js'),
    sibling<ThemeModule>('../theme.js'),
    sibling<SessionModule>('../session.js'),
    sibling<ToolsModule>('../tools.js'),
    sibling<ScopeModule>('../scope.js'),
    sibling<SandboxModule>('../sandbox.js'),
    sibling<SourcesModule>('../sources.js'),
    sibling<ProviderModule>('../logfare.js'),
    sibling<ProviderModule>('../tokenharbour.js'),
    sibling<ProviderModule>('../openrouter.js'),
    sibling<ProviderModule>('../unorouter.js'),
    sibling<ProviderModule>('../aihubmix.js'),
    sibling<ProviderModule>('../antseed.js'),
    sibling<LdxhubModule>('../ldxhub.js'),
    sibling<{ Agent: AgentCtor }>('../agent.js'),
    sibling<TeamModule>('../team.js'),
    sibling<HuntModule>('../hunt.js'),
    sibling<AdModule>('../ad.js'),
    sibling<CrackModule>('../crack.js'),
    sibling<OsintModule>('../osint.js'),
    sibling<OsintTreeModule>('../osint-tree.js'),
    sibling<PhishModule>('../phish.js'),
    sibling<PanesModule>('../panes.js'),
    sibling<OpencodeModule>('../opencode.js'),
    sibling<ScopeValidatorModule>('../scope-validator.js'),
    sibling<WidgetsModule>('./widgets.js'),
    sibling<RenderersModule>('./renderers.js'),
    sibling<MarkdownModule>('./markdown.js'),
    sibling<RailsModule>('./rails.js'),
    sibling<WebModule>('./web.js'),
    sibling<BannerModule>('./banner.js'),
    sibling<BootModule>('./boot.js'),
    sibling<CompleteModule>('./complete.js'),
    sibling<PaletteCmdModule>('./palette-cmd.js'),
  ]);
  return {
    config,
    theme,
    session,
    tools,
    scope,
    sandbox,
    sources,
    logfare,
    tokenharbour,
    openrouter,
    unorouter,
    aihubmix,
    antseed,
    ldxhub,
    agent,
    team,
    hunt,
    ad,
    crack,
    osint,
    osintTree,
    phish,
    panes,
    opencode,
    scopeValidator,
    widgets,
    renderers,
    markdown,
    rails,
    web,
    banner,
    boot,
    complete,
    paletteCmd,
  };
}

// === SECTION === module constants and free helpers ===

/** What `/zim-opencode` says while it works. Deliberately no counts: how many
 * proxies are in the pool says nothing about how many will be accepted (a pool
 * of 24 measured 12% usable at one point and 79% at another), so a number
 * would be noise dressed as information. The promise it does make — a working
 * route, and a different one next time — is one the command can actually keep. */
const HUNTING = 'ZIM IS MAKING IT UNLIMITED - FINDING THE BEST PROXIES ...';

/** Braille spinner. Chosen over the ASCII `|/-\\` because it advances in place
 * without the baseline jitter that makes an ASCII spinner look like the line
 * is being rewritten. */
const HUNT_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** Order-preserving de-dupe. Scope.extractTargets can return the same host
 * twice — its URL pass and its bare-token pass both match — and the operator
 * should read the target once, not twice. */
export function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** A catalog's age in words. `null` means nothing has been fetched, which is
 * not an age and must not render as one — the whole point of the line is that
 * "fetched a moment ago" and "fetched at startup" look identical otherwise. */
export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'never fetched';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h old`;
  return `${Math.floor(seconds / 86400)}d old`;
}

/** One honest clause about how current a fetched catalog is. `age` is null
 * when nothing was ever fetched; at or past the ttl the module's own readers
 * already hand back null in place of the list, so calling that "live" would
 * contradict the very list above it. */
export function catalogClause(age: number | null | undefined, ttl: number): string {
  if (age === null || age === undefined) return 'not fetched yet';
  if (age >= ttl) return `expired (${ago(age)})`;
  return `live (${ago(age)})`;
}

/** `/crack`'s default budget. Thirty minutes, chosen so the ladder's *useful*
 * stages actually fit the case this command exists for. A Kerberoast hash —
 * what `/ad` produces — runs the dictionary in ~12s and best64 in ~16m on this
 * class of host, so a ten-minute default would drop best64, which is precisely
 * the stage that cracks corporate passwords. A default that excludes the stage
 * that works is not a default, it is a trap. The mask is still excluded (7h on
 * a Kerberoast, 4m on an NTLM), and that is correct: it is the escalation of
 * last resort and the plan prints it as dropped, by name. */
const CRACK_DEFAULT_BUDGET = 1800.0;

/** Column the model id is padded to in `/models`, before its blurb. Wide
 * enough for a TokenHarbour id with room to spare, and narrower than most
 * OpenRouter ids — which is the point of the over-long branch in showModels:
 * those wrap rather than truncate, because the id is what the operator retypes. */
const MODEL_COL = 34;

/** The colour for a UnoRouter upstream-redundancy tier. This is Andy's tier,
 * not UnoRouter's status: the gateway's catalog publishes a channel *list* and
 * no per-channel health, so there is no green dot to read and none is invented
 * — what is coloured here is how many channels stand behind a model, which is
 * a fact, mapped through thresholds that are ours. `unknown` is deliberately
 * dim rather than green or amber: a catalog that did not say is not a good sign
 * or a bad one, and colouring it either way would be reading a fact into a
 * blank. */
export function upstreamStyle(p: Palette, tier: string): string {
  return (
    {
      good: p.accent,
      thin: p.amber,
      single: p.red,
      unknown: p.dim,
    }[tier] ?? p.dim
  );
}

/** `/crack`'s argument parse, split out of the command so it is testable on
 * its own — every malformed flag is refused here, with the value named, rather
 * than silently becoming part of the path or a nonsense budget. `--mode` is
 * validated against the modes this command knows, because a wrong mode number
 * does not fail: it spends the entire budget on a format that cannot match. */
export function parseCrackArgs(args: string[]): [string, number | null, number, boolean, string] {
  let pathArg = '';
  let mode: number | null = null;
  let maxTime = CRACK_DEFAULT_BUDGET;
  let deep = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (name === '--mode' || name === '--max-time') {
      let value = eq >= 0 ? arg.slice(eq + 1) : args[i + 1] ?? '';
      if (eq < 0) i += 1; // consume the value too
      if (!value) {
        return [
          '',
          null,
          maxTime,
          deep,
          `${name} needs a value, e.g. /crack hashes.txt ${name} ${name === '--mode' ? '13100' : '600'}`,
        ];
      }
      if (name === '--mode') {
        if (!/^\d+$/.test(value)) {
          return [
            '',
            null,
            maxTime,
            deep,
            `--mode takes a hashcat mode number, not '${value}' — try /crack --help for the ones this knows`,
          ];
        }
        mode = Number(value);
        // The known-mode check happens in the command (it owns crack.HASH_MODES).
      } else {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return ['', null, maxTime, deep, `--max-time takes seconds, not '${value}'`];
        }
        maxTime = n;
        if (maxTime <= 0) {
          return ['', null, maxTime, deep, '--max-time must be greater than zero'];
        }
      }
    } else if (arg === '--deep') {
      deep = true;
    } else if (arg.startsWith('--')) {
      return [
        '',
        null,
        maxTime,
        deep,
        `unknown flag '${arg}' — /crack takes <file|dir> [--mode N] [--max-time S] [--deep]`,
      ];
    } else if (!pathArg) {
      pathArg = arg;
    } else {
      return ['', null, maxTime, deep, `unexpected extra argument '${arg}' — /crack takes one path`];
    }
    i += 1;
  }
  return [pathArg, mode, maxTime, deep, ''];
}

/** Python `f'{n:,}'`. */
export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Python `f'{x:g}'` — shortest round-trip without exponent noise. */
export function fmtG(x: number): string {
  return String(parseFloat(x.toFixed(6)));
}

/** `TypeError: msg` / `Error: msg` — the Python `f'{type(e).__name__}: {e}'`. */
export function errName(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error';
  const msg = e instanceof Error ? e.message : String(e);
  return `${name}: ${msg}`;
}

/** Port of complete._iter_files, kept as the fallback when the complete
 * module has not landed; walks with pruning so the limit bounds the work
 * (sorting a materialised rglob would visit the whole tree first). */
export function iterFilesFallback(root: string, limit: number): string[] {
  const skip = new Set([
    '.git',
    '__pycache__',
    'node_modules',
    '.venv',
    'venv',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    'dist',
    'build',
    '.tox',
    '.idea',
  ]);
  const out: string[] = [];
  const resolved = path.resolve(root);
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !skip.has(e.name))
      .map((e) => e.name)
      .sort();
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    for (const d of dirs) {
      if (out.length >= limit) return;
      out.push(path.relative(resolved, path.join(dir, d)) + '/');
    }
    for (const f of files) {
      if (out.length >= limit) return;
      out.push(path.relative(resolved, path.join(dir, f)));
    }
    for (const d of dirs) walk(path.join(dir, d));
  };
  walk(resolved);
  return out.sort();
}

/** sv._hostOf is private upstream; this local fallback extracts the host from
 * an asset string when the module does not export one. */
export function hostOfFallback(asset: string): string {
  try {
    return new URL(asset.includes('://') ? asset : `http://${asset}`).hostname;
  } catch {
    return asset.split('/')[0] ?? '';
  }
}

// === SECTION === exit-result hook (cli.ts reads this after unmount) =========
//
// Python handed /panes' Relaunch back as app.run()'s return value; an Ink
// component cannot return, so the last exit value carrying a relaunch request
// is recorded here and cli.ts polls relaunchRequest() once the render tree has
// exited. Only actionQuitWith sets it; a plain quit (or a fresh mount in the
// same process, as in tests) clears it — mirroring Python's `self.exit(None)`.

let lastExitResult: { resume?: string } | null = null;

/** The relaunch request /panes left behind, if any — see cli.ts's exit path. */
export function relaunchRequest(): { resume?: string } | null {
  return lastExitResult;
}

// === SECTION === the application component ===

export interface AndyAppProps {
  cfg: ConfigLike;
  resume?: SessionPayload | null;
  /** The terminal's own background/colours, detected over OSC 11 by cli.ts.
   * Null on a terminal that does not answer; stored (not consumed) so /theme
   * can re-skin onto the same colour without asking again mid-render. */
  termBg?: string | null;
  termColors?: TerminalColorsLike | null;
  /** Ink's exit carries no return value; /panes hands its Relaunch back
   * through this seam so cli.ts can perform the tmux relaunch. */
  onExit?: (result: unknown) => void;
}

interface BarState {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
  iterations: number;
  activity: string;
  busy: boolean;
  tick: number;
}

interface HeaderState {
  model: string;
  mode: string;
  scopeBadge: string;
  scopeArmed: boolean;
}

interface PermState {
  name: string;
  args: Record<string, unknown>;
  preview: Preview | null;
  radius: string;
  remaining: number;
  resolve: (d: PermissionDecision) => void;
}

interface CompState {
  visible: boolean;
  kind: 'slash' | 'file' | '';
  items: [string, string][];
  index: number;
}

const MAX_ROWS = 8;
const MAX_FILES = 200;

export function AndyApp(props: AndyAppProps) {
  const { resume, termBg, termColors } = props;
  const app = useApp();
  const { columns } = useWindowSize();

  // ---- refs: engine state mutated by async workers -------------------------
  const cfgRef = useRef(props.cfg);
  const modsRef = useRef<Mods | null>(null);
  const agentRef = useRef<AgentLike | null>(null);
  const paletteRef = useRef<Palette>(INK_PLACEHOLDER);
  const themeNameRef = useRef(props.cfg.theme);
  const rainOnRef = useRef(props.cfg.rain);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  const workerGenRef = useRef(0);
  const streamBufRef = useRef('');
  const reasonBufRef = useRef('');
  const lastOutTokRef = useRef(0);
  const lastCallInputRef = useRef(0);
  const teamTokensRef = useRef<[number, number, number]>([0, 0, 0]);
  const huntStopRef = useRef<StopSignal | null>(null);
  const huntRunRef = useRef<HuntRunLike | null>(null);
  const huntSummaryQueuedRef = useRef(false);
  const huntDirRef = useRef<string | null>(null);
  const huntTargetRef = useRef('');
  const huntTokensRef = useRef<[number, number, number]>([0, 0, 0]);
  const phishQRef = useRef<Array<Record<string, unknown>>>([]);
  const permLockRef = useRef<Promise<unknown>>(Promise.resolve());
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spinnerFrameRef = useRef(0);
  const filesCacheRef = useRef<string[] | null>(null);
  const inputRef = useRef('');
  const verbIndexRef = useRef(0);
  const bootedRef = useRef(false);
  const inPaneRef = useRef(false);

  // ---- widget handles -------------------------------------------------------
  const chatRef = useRef<ChatPaneHandle>(null);
  const loopRef = useRef<LoopRailHandle>(null);
  const teleRef = useRef<TelemetryRailHandle>(null);
  const zimRef = useRef<ZimPaneHandle>(null);
  const reconRef = useRef<ReconOverlayHandle>(null);
  const waveRef = useRef<WaveOverlayHandle>(null);

  // ---- state: render-relevant mirrors ---------------------------------------
  const [mods, setMods] = useState<Mods | null>(null);
  const [ready, setReady] = useState(false);
  const [booted, setBooted] = useState(false);
  const [palette, setPalette] = useState<Palette>(INK_PLACEHOLDER);
  const [themeName, setThemeName] = useState(props.cfg.theme);
  const [rainOn, setRainOn] = useState(props.cfg.rain);
  const [busy, setBusy] = useState(false);
  const [bar, setBar] = useState<BarState>({
    model: props.cfg.model,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    turns: 0,
    iterations: 0,
    activity: 'idle',
    busy: false,
    tick: 0,
  });
  const barRef = useRef(bar);
  const [header, setHeader] = useState<HeaderState>({
    model: props.cfg.model,
    mode: props.cfg.mode,
    scopeBadge: '',
    scopeArmed: false,
  });
  const headerRef = useRef(header);
  const [perm, setPerm] = useState<PermState | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteEntriesRef = useRef<PaletteEntryLike[]>([]);
  const [scopePasteOpen, setScopePasteOpen] = useState(false);
  const [findings, setFindings] = useState<{
    target: string;
    live: boolean;
    items: FindingDict[];
  } | null>(null);
  // Read-latest mirror of the findings panel state: async hunt workers hold a
  // ctx captured at their start, so they must see panel changes made mid-run.
  const findingsRef = useRef<{ target: string; live: boolean; items: FindingDict[] } | null>(
    null,
  );
  findingsRef.current = findings;
  const [recon, setRecon] = useState<string | null>(null);
  const [wave, setWave] = useState<{
    target: string;
    wave: number;
    size: number;
  } | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [comp, setComp] = useState<CompState>({
    visible: false,
    kind: '',
    items: [],
    index: 0,
  });
  const compRef = useRef(comp);
  compRef.current = comp;
  const [spinnerOn, setSpinnerOn] = useState(false);

  const pal = () => paletteRef.current;
  const cfg = () => cfgRef.current;
  const agent = () => agentRef.current;
  const M = () => modsRef.current;
  const R = () => M()?.renderers;
  const chat = () => chatRef.current;
  const loopRail = () => loopRef.current;
  const teleRail = () => teleRef.current;
  const zimPane = () => zimRef.current;

  /** Transcript write; null-safe because timers can fire in the gap between
   * shutdown starting and the pane unmounting (see Python `_chat_pane`). */
  const say = (node: ReactNode) => {
    chat()?.writeBlock(node);
  };

  const updateBar = (patch: Partial<BarState>) => {
    barRef.current = { ...barRef.current, ...patch };
    setBar(barRef.current);
  };
  const updateHeader = (patch: Partial<HeaderState>) => {
    headerRef.current = { ...headerRef.current, ...patch };
    setHeader(headerRef.current);
  };
  const setBusyBoth = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
    updateBar({ busy: v });
  };
  const setPaletteBoth = (p: Palette, name: string) => {
    paletteRef.current = p;
    themeNameRef.current = name;
    setPalette(p);
    setThemeName(name);
  };
  const setRainBoth = (on: boolean) => {
    rainOnRef.current = on;
    setRainOn(on);
    chat()?.setRain(on);
  };
  const setInputBoth = (v: string) => {
    inputRef.current = v;
    setInputValue(v);
  };

  /** Defer to after the next commit — used where the Python code wrote to the
   * transcript the instant a screen was popped, which in Ink needs one commit
   * for the receiving widget's ref handle to attach. */
  const soon = (fn: () => void) => {
    setTimeout(fn, 0);
  };

  // ---- system lines ----------------------------------------------------------
  /** One dim/warn/ok line in the transcript. */
  const sysLine = (message: string, warn = false, ok = false) => {
    const p = pal();
    say(
      <Text>
        <Text bold color={warn ? p.amber : ok ? p.accent : p.dim}>
          {warn ? '  ⚠ ' : ok ? '  ✔ ' : '  · '}
        </Text>
        <Text color={warn ? p.amber : ok ? p.accent : p.dim}>{message}</Text>
      </Text>,
    );
  };

  // ---- mount: load siblings, construct the agent, boot ----------------------
  useEffect(() => {
    let cancelled = false;
    // A fresh mount in this process must not inherit the previous instance's
    // exit value (tests re-render AndyApp; Python had one App per process).
    lastExitResult = null;
    (async () => {
      const m = await loadMods();
      if (cancelled) return;
      modsRef.current = m;
      setMods(m);
      // Inside an Andy tmux pane the main session can message its peers.
      // Outside one, there is no mailbox and the peer tools stay off.
      inPaneRef.current = m.panes.currentSession() !== null;
      const p = m.theme.getPalette(cfg().theme, termBg ?? null, {
        colors: termColors ?? undefined,
      });
      paletteRef.current = p;
      setPalette(p);
      agentRef.current = new m.agent.Agent(
        cfg(),
        requestPermission,
        undefined,
        undefined,
        undefined,
        inPaneRef.current,
        inPaneRef.current ? drainPeerInbox : undefined,
      );
      // `--resume` (what /panes passes the relaunched process) restores the
      // conversation before the first frame — Python did this in __main__ via
      // session.load(cfg, app.agent, …) before app.run(). Applying it here,
      // before bootDone, is what makes the boot replay show the restored turn
      // and the header carry the saved model. cli.ts already parsed the file;
      // a payload that reached this prop is one that parsed.
      if (resume) {
        const a = agentRef.current;
        a.messages = resume.messages ?? [];
        a.turnCount = resume.turnCount ?? 0;
        a.sessionInputTokens = resume.tokens?.input ?? 0;
        a.sessionOutputTokens = resume.tokens?.output ?? 0;
        a.sessionCost = resume.cost ?? 0;
        if (resume.model) cfgRef.current.model = resume.model;
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- first-run hint (fresh sessions only) -----------------------------------
  //
  // One block in the transcript, never an overlay: it scrolls away as soon
  // as real work starts, and a resumed session (which already knows) never
  // sees it. Guarded by a ref rather than state so a re-render storm around
  // boot cannot write it twice.
  const hintedRef = useRef(false);
  useEffect(() => {
    if (!ready || resume || hintedRef.current) return;
    const Hint = mods?.widgets?.WelcomeHint;
    if (!Hint || !paletteRef.current) return;
    hintedRef.current = true;
    chatRef.current?.writeBlock(<Hint palette={paletteRef.current} />);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---- boot checks + boot completion ------------------------------------------
  const bootChecks = (): [string, string, boolean][] => {
    const c = cfg();
    const a = agent();
    const m = M();
    const checks: [string, string, boolean][] = [
      ['API KEY', c.apiKeyPresent ? 'present' : 'MISSING', c.apiKeyPresent],
      ['ENDPOINT', c.redactedEndpoint(), true],
      ['MODEL', c.model, true],
      ['CWD', c.workdir, true],
    ];
    const scope = a ? a.scope : null;
    if (scope?.armed) {
      checks.push([
        'ALLOW.YAML',
        `${scope.allow.describe()} — session ARMED, tools run unattended`,
        true,
      ]);
    } else {
      checks.push(['ALLOW.YAML', 'not loaded — session not armed', true]);
    }
    if (scope && scope.denyPath !== null) {
      checks.push(['OUT-OF-SCOPE', `${scope.deny.describe()} — blocked`, true]);
    } else {
      checks.push(['OUT-OF-SCOPE', 'not loaded — nothing blocked', true]);
    }
    // A stale scope.yaml is the one genuinely alarming state: the operator
    // may believe a guard is armed when nothing at all is loaded.
    if (c.legacyScopePath !== null) {
      checks.push([
        'SCOPE.YAML',
        `${c.legacyScopePath} ignored — split into allow.yaml / out-of-scope.yaml; nothing is armed`,
        false,
      ]);
    }
    checks.push(['SANDBOX', c.unsafe ? 'DISABLED (--unsafe)' : 'enabled', !c.unsafe]);
    checks.push([
      'TOOLS',
      `${m ? m.tools.TOOL_SCHEMAS.length : 0} registered (bash, io, search, web)`,
      true,
    ]);
    return checks;
  };

  const replayTranscript = () => {
    // Only fires when the agent already holds history at boot — the /panes
    // relaunch, since a normal launch starts empty. The renderers are the same
    // ones a live turn uses, so a replayed answer looks like the answer did.
    const a = agent();
    const m = M();
    if (!a || !m) return;
    const pairs = m.panes.transcriptOf(a.messages);
    if (!pairs.length) return;
    const p = pal();
    say(R()?.warningBlock(`resumed — ${pairs.length} message(s) from before the relaunch`, p));
    for (const [role, text] of pairs) {
      if (role === 'user') say(R()?.userPromptBlock(text, p));
      else say(m.markdown.markdownRenderable(text, p));
    }
  };

  const splash = () => {
    // Written as one renderable and centred by the layout rather than padded
    // into place by hand, so a reflow re-centres it on every re-render because
    // the renderable is kept, not the rendered lines.
    const m = M();
    if (!m) return;
    say(
      <Box justifyContent="center">
        {m.banner.splashMark(pal(), cfg().model, cfg().baseUrl)}
      </Box>,
    );
  };

  const bootDone = (typed: string[] | null, submit = false) => {
    setBooted(true);
    bootedRef.current = true;
    // Seed the status bar so it reflects the configured model from the start,
    // and the header so the scope badge is live before the first prompt.
    const a = agent();
    updateBar({ model: cfg().model });
    if (a) {
      updateHeader({
        model: cfg().model,
        mode: cfg().mode,
        scopeBadge: a.scope.badge(),
        scopeArmed: a.scope.armed,
      });
    }
    soon(() => {
      splash();
      // A session relaunched by /panes arrives with its conversation already
      // in agent.messages and an empty transcript pane — replaying it here is
      // what makes "your session continues there" true rather than a claim.
      replayTranscript();
      // The split is a deliberate weakening on upgrade, so it is said out loud
      // in the transcript too — not just the boot checks, which scroll away.
      if (cfg().legacyScopePath !== null) {
        sysLine(
          `${cfg().legacyScopePath} is ignored — the scope guard was split into allow.yaml (declared targets, arms the session) and out-of-scope.yaml (never touch). Nothing is armed or blocked.`,
          true,
        );
      }
      // Fold old `<scope>-<stamp>` layouts into one directory per scope at
      // boot, before anything reads the hunts store. Idempotent and cheap.
      const m = M();
      if (m) {
        try {
          const merged = m.hunt.migrateHunts(cfg());
          if (merged.length) {
            sysLine(
              `merged ${merged.length} old hunt campaign(s) into one directory per scope under ${path.join(cfg().stateDir, 'hunts')}`,
              true,
            );
          }
        } catch {
          /* best-effort migration; a failure must not stop the boot */
        }
        try {
          const refiled = m.hunt.reorganiseWaves(cfg());
          if (refiled.length) {
            sysLine(`filed ${refiled.length} hunt artefact(s) into per-wave directories`, true);
          }
        } catch {
          /* same */
        }
        // Warm the Logfare catalog while the operator reads the banner, so the
        // first /model is current. Only for the local proxy: on a hosted
        // source this would be a pointless round-trip to a status API.
        if (m.sources.activeKey(cfg().baseUrl) === 'logfare') {
          m.logfare.fetchModels().catch(() => {
            /* silent on purpose: a launch that cannot reach the status API is
               still a working launch; /logfare-models reports on demand. */
          });
        }
      }
      // Replay anything typed while the boot animation ran.
      const text = (typed ?? []).join('');
      if (text && submit) {
        submitText(text);
      } else if (text) {
        setInputBoth(text);
      }
    });
  };

  // ---- timers ----------------------------------------------------------------
  useEffect(() => {
    if (!booted) return;
    // 1s: the status bar's clock, and the tokens-per-second sample. Sampled on
    // the existing tick rather than a timer of its own: the delta over one
    // second *is* the rate.
    const t1 = setInterval(() => {
      updateBar({ tick: barRef.current.tick + 1 });
      const a = agent();
      if (!a) return;
      const now = a.sessionOutputTokens;
      const delta = Math.max(0, now - lastOutTokRef.current);
      lastOutTokRef.current = now;
      if (busyRef.current) teleRail()?.pushWave(delta);
    }, 1000);
    // 0.55s: the cursor flash over the live stream, pushing the current
    // buffers so deltas that arrived between renders are shown.
    const t2 = setInterval(() => {
      if (!busyRef.current) return;
      chat()?.flashCursor();
      if (streamBufRef.current) chat()?.setStream(streamBufRef.current);
      if (reasonBufRef.current) chat()?.setReasoning(reasonBufRef.current);
    }, 550);
    // 0.25s: the loop node breathes, the live card's clock runs, the phish
    // event queue drains onto ZimPane.
    const t3 = setInterval(() => {
      loopRail()?.tickPulse();
      chat()?.cardTick();
      drainPhish();
    }, 250);
    // 0.35s: the thinking-verb spinner. Runs always, mutates only while busy.
    const t4 = setInterval(() => {
      if (!busyRef.current) return;
      const m = M();
      const verbs = m ? m.theme.THINKING_VERBS : ['thinking'];
      verbIndexRef.current = (verbIndexRef.current + 1) % verbs.length;
      updateBar({ activity: verbs[verbIndexRef.current] ?? 'thinking' });
    }, 350);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearInterval(t3);
      clearInterval(t4);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  /** Push the agent's session totals into the rails. Called at boot and after
   * every turn — anywhere the numbers change without an event to carry them. */
  const syncRails = () => {
    const a = agent();
    if (!a) return;
    teleRail()?.setCost(a.sessionCost, a.sessionInputTokens, a.sessionOutputTokens);
    teleRail()?.setContext(lastCallInputRef.current);
    loopRail()?.setCounters(a.turnCount, barRef.current.iterations);
  };

  // ---- permission gate ---------------------------------------------------------
  /** One line naming what a gated call would touch. Latent by design: every
   * shipped mode lists its gated tools in auto or deny, so this modal never
   * fires today. It is correct if a mode is ever added that leaves a tool
   * gated — and the same target scan is shown on the live tool card. */
  const blastRadius = (name: string, args: Record<string, unknown>): string => {
    const m = M();
    const a = agent();
    if (!m || !a) return '';
    args = args ?? {};
    if (name === 'bash') {
      const command = String(args['command'] ?? '');
      let targets: string[] = [];
      try {
        targets = a.scope.extractTargets(command);
      } catch {
        targets = [];
      }
      if (targets.length) return 'targets: ' + dedupe(targets).join(', ');
      return 'no network targets named';
    }
    const p = String(args['path'] ?? '');
    if (!p) return '';
    try {
      const resolved = m.sandbox.resolveInJail(cfg().workdir, p, cfg().unsafe);
      const exists = fsSync.existsSync(resolved);
      return `${resolved}  (${exists ? 'exists' : 'new file'})`;
    } catch (e) {
      return `REFUSED — ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /** The Agent's permissionHandler. One modal at a time: without the lock,
   * /team's parallel workers could each push a modal and the second would sit
   * on top of the first, re-enabling the prompt while a modal is still up. */
  const requestPermission: PermissionHandler = async (name, args, preview) => {
    const prev = permLockRef.current;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    permLockRef.current = gate;
    await prev;
    try {
      return await new Promise<PermissionDecision>((resolve) => {
        setPerm({
          name,
          args,
          preview,
          radius: blastRadius(name, args),
          remaining: 0,
          resolve,
        });
      });
    } finally {
      release();
    }
  };

  // ---- prompt: @refs, submit ----------------------------------------------------
  /** Turn @path mentions into an attached-files block for the model. The
   * visible prompt keeps the short form; the model receives the file contents
   * inline so a mention is immediately actionable. */
  const expandAtRefs = async (text: string): Promise<string> => {
    const m = M();
    if (!m) return text;
    const tokens = [...text.matchAll(/(?<!\w)@([^\s@]+)/g)].map((x) => x[1] ?? '');
    if (!tokens.length) return text;
    const attached: string[] = [];
    for (const tok of dedupe(tokens)) {
      const raw = tok.replace(/[.,;:)]+$/, '');
      let resolved: string;
      try {
        resolved = m.sandbox.resolveInJail(cfg().workdir, raw, cfg().unsafe, {
          mustExist: true,
        });
      } catch {
        continue;
      }
      let st: fsSync.Stats;
      try {
        st = fsSync.statSync(resolved);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        let listing = '(unreadable)';
        try {
          const names = await fsp.readdir(resolved, { withFileTypes: true });
          listing = names
            .map((e) => e.name + (e.isDirectory() ? '/' : ''))
            .sort()
            .join('\n');
        } catch {
          /* keep the placeholder */
        }
        attached.push(`--- ${raw}/ (directory) ---\n${listing}`);
        continue;
      }
      let body: string;
      try {
        body = (await fsp.readFile(resolved)).toString('utf8');
      } catch {
        continue;
      }
      const limit = cfg().maxOutputChars;
      if (body.length > limit) {
        body = body.slice(0, limit) + `\n... [truncated at ${limit} chars] ...`;
      }
      attached.push(`--- ${raw} ---\n${body}`);
    }
    if (!attached.length) return text;
    return text + '\n\n[referenced files]\n' + attached.join('\n\n');
  };

  const submitText = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      handleCommand(text);
    } else {
      void runTurnPromise(expandAtRefs(text));
    }
  };

  /** The prompt's submit path: slash commands dispatch BEFORE the busy check
   * because some commands must work mid-run — /stop-hunt and /summary-hunt are
   * useless otherwise, and a hunt that cannot be stopped from the prompt is a
   * hunt you can only kill with Ctrl+C. handleCommand decides which those are. */
  const submitPrompt = (raw: string) => {
    const text = raw.trim();
    setComp((c) => ({ ...c, visible: false }));
    if (!text) return;
    if (text.startsWith('/')) {
      handleCommand(text);
      return;
    }
    if (busyRef.current) {
      sysLine('harness is busy — Ctrl+C to interrupt', true);
      return;
    }
    void runTurnPromise(expandAtRefs(text));
  };

  const runTurnPromise = (textOrPromise: string | Promise<string>) => {
    void (async () => {
      const text = await textOrPromise;
      await runTurn(text);
    })();
  };

  // ---- the turn worker ----------------------------------------------------------
  const runTurn = async (
    text: string,
    opts?: {
      display?: string;
      osintCase?: string;
      finalise?: () => void;
      deliverable?: Deliverable;
    },
  ) => {
    const a = agent();
    if (!a) return;
    const p = pal();
    const myGen = ++workerGenRef.current;
    const isCurrent = () => workerGenRef.current === myGen;

    setBusyBoth(true);
    cancelledRef.current = false;
    streamBufRef.current = '';
    reasonBufRef.current = '';
    setRainBoth(false); // keep the transcript readable during a turn

    // A previous turn's cap must not carry into this one, or the rail would
    // say CAPPED while the new turn is running fine.
    loopRail()?.clearCap();
    loopRail()?.setStage('thinking');
    loopRail()?.setCounters(a.turnCount + 1, 0);

    // The spine joint that opens the turn, then the prompt it belongs to.
    // `display` lets a caller show a short label for a long synthetic prompt
    // (/osint's playbook is thousands of words) while the agent still receives
    // the full text — the transcript shows what the operator typed.
    say(R()?.turnMarker(a.turnCount + 1, p));
    say(R()?.userPromptBlock(opts?.display ?? text, p));
    updateBar({ activity: 'thinking' });

    try {
      for await (const ev of a.runTurn(text, opts?.deliverable)) {
        if (cancelledRef.current || !isCurrent()) break;
        handleEvent(ev);
      }
    } catch (e) {
      say(R()?.errorBlock(errName(e), p));
    } finally {
      if (isCurrent()) {
        setBusyBoth(false);
        chat()?.clearStream();
        // Before cardFinish and the buffer reset: a turn can end on reasoning
        // that never got an answer after it — committing here is what keeps
        // that thinking rather than dropping it silently.
        flushReasoning();
        chat()?.cardFinish();
        streamBufRef.current = '';
        updateBar({
          activity: 'idle',
          inputTokens: a.sessionInputTokens,
          outputTokens: a.sessionOutputTokens,
          cost: a.sessionCost,
          turns: a.turnCount,
          model: cfg().model,
        });
        loopRail()?.setStage('idle');
        loopRail()?.setCounters(a.turnCount, barRef.current.iterations);
        syncRails();
        setRainBoth(rainOnRef.current);
        if (cancelledRef.current) {
          a.cancelTurn();
          sysLine('turn interrupted', true);
        }
        // An osint run leaves its whole case directory behind — clones, raw
        // API dumps, avatars. Once the report is written, archive it and
        // delete the rest, so ~/.andy does not grow without bound. Runs in the
        // finally block, so an interrupted run is tidied too; finaliseCase
        // deletes NOTHING unless it found a report, so a run that failed or
        // was cut short keeps its evidence for inspection. `finalise` is the
        // general form: /crack keeps its case (the potfile is worth keeping),
        // so the policy lives in the callable, and this block stays ignorant.
        if (opts?.finalise) {
          opts.finalise();
        } else if (opts?.osintCase) {
          finaliseOsint(ctx, opts.osintCase);
        }
      }
    }
  };

  // ---- the agent event stream → widget state -------------------------------------
  /** Events the shared union does not carry yet (args/diff/targets/written)
   * are widened here; the agent.ts porter owns the final keys. */
  type WideEvent = AgentEvent & {
    args?: Record<string, unknown>;
    diff?: string;
    targets?: string[];
    written?: boolean;
    model?: string;
  };

  const fileFor = (name: string, args: Record<string, unknown>): string => {
    if (['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep'].includes(name)) {
      return String(args['path'] ?? '');
    }
    return '';
  };

  /** Hosts a bash command names — shown on the card, never enforced here.
   * Reuses the scope guard's extractor, so the card shows exactly what the
   * deny-list would have looked at. */
  const targetsFor = (name: string, args: Record<string, unknown>): string[] => {
    const a = agent();
    if (name !== 'bash' || !a) return [];
    const command = String(args['command'] ?? '');
    if (!command) return [];
    try {
      return dedupe(a.scope.extractTargets(command)).slice(0, 4);
    } catch {
      return [];
    }
  };

  const flushStream = () => {
    // The finished answer, so this is the expensive half: fenced code comes
    // back highlighted and a table as a real table. The live line above uses
    // the flat text form, cheap enough to run on every delta.
    if (streamBufRef.current.trim()) {
      chat()?.clearStream();
      const m = M();
      if (m) say(m.markdown.markdownRenderable(streamBufRef.current, pal()));
      streamBufRef.current = '';
    }
  };

  /** Commit in-flight reasoning to the transcript, then empty the slot. A
   * no-op when the buffer is empty, which is the common case. */
  const flushReasoning = () => {
    if (reasonBufRef.current.trim()) {
      chat()?.clearReasoning();
      say(R()?.reasoningPanel(reasonBufRef.current, pal()));
    }
    reasonBufRef.current = '';
  };

  const costLine = (ev: { input: number; output: number; cost: number; model?: string }) => {
    const p = pal();
    say(
      <Text>
        <Text color={p.dim}>{'  ⤷ '}</Text>
        <Text color={p.dim}>{`+${ev.input}`}</Text>
        <Text color={p.dim}>{' in / '}</Text>
        <Text color={p.dim}>{`+${ev.output}`}</Text>
        <Text color={p.dim}>{' out tok  ·  '}</Text>
        <Text color={p.accent}>{`$${(ev.cost ?? 0).toFixed(4)}`}</Text>
        <Text color={p.dim}>{`  ·  ${ev.model ?? cfg().model}`}</Text>
      </Text>,
    );
  };

  const handleEvent = (evObj: AgentEvent) => {
    const ev = evObj as WideEvent;
    const a = agent();
    if (!a) return;
    const etype = ev.type;

    if (etype === 'thinking') {
      updateBar({
        iterations: ev.iteration + 1,
        turns: a.turnCount,
        activity: 'thinking',
      });
      loopRail()?.setStage('thinking');
      loopRail()?.setCounters(a.turnCount, barRef.current.iterations);
    } else if (etype === 'reasoning_delta') {
      // The model's own thinking, streamed before it answers. Only some
      // endpoints send this — an endpoint that drops it changes nothing here.
      reasonBufRef.current += ev.text;
      if (cfg().showThinking) chat()?.setReasoning(reasonBufRef.current);
    } else if (etype === 'text_delta') {
      // The first character of the answer means the thinking that produced it
      // is finished, so commit it now — this keeps the transcript in the order
      // the two actually arrived in, and stops the live slot being cleared out
      // from under a half-read block when the answer takes over.
      if (!streamBufRef.current && reasonBufRef.current) {
        flushReasoning();
      }
      streamBufRef.current += ev.text;
      chat()?.setStream(streamBufRef.current);
    } else if (etype === 'retry') {
      flushStream();
      sysLine(
        `transport error (${ev.reason}) — retry ${ev.attempt}/${ev.max} in ${ev.delay.toFixed(1)}s`,
        true,
      );
      updateBar({ activity: `retry ${ev.attempt}/${ev.max}` });
    } else if (etype === 'usage') {
      // The agent has not yet folded this turn's usage into its session
      // totals, so add it here for a live running figure. Team workers' usage
      // rides on top — they spent against the same session, and dropping them
      // here would make the total jump backwards when synthesis starts.
      const [teamIn, teamOut, teamCost] = teamTokensRef.current;
      updateBar({
        inputTokens: a.sessionInputTokens + teamIn + ev.input,
        outputTokens: a.sessionOutputTokens + teamOut + ev.output,
        cost: a.sessionCost + teamCost + ev.cost,
      });
      // ev.input is this one call's prompt size — the closest thing to a live
      // context reading available.
      lastCallInputRef.current = ev.input;
      // The window is passed alongside so the gauge's percentage is a share of
      // *this model's* window, not of the configured fallback — resolved the
      // same way the auto-compact threshold resolves it.
      teleRail()?.setContext(lastCallInputRef.current, a.contextWindow());
    } else if (etype === 'tool_call') {
      flushStream();
      const args = ev.args ?? {};
      // The live card: one slot, transitioning requested → running. It is only
      // *visible* for a slow tool — an instant read finishes before the next
      // paint, which is correct behaviour, not a bug.
      chat()?.cardFinish();
      chat()?.cardBegin(ev.name, args, targetsFor(ev.name, args));
      teleRail()?.touchFile(fileFor(ev.name, args));
      teleRail()?.noteCall(ev.name);
      loopRail()?.setStage('calling');
      if (ev.gated) {
        updateBar({ activity: `awaiting permission: ${ev.name}` });
      }
    } else if (etype === 'tool_result') {
      const args = ev.args ?? {};
      const diff = ev.diff;
      chat()?.cardFinish();
      if (diff && !ev.isError && diff.trim() !== '(no textual change)') {
        const verb = ev.name === 'write_file' ? 'WRITE' : 'EDIT';
        say(R()?.diffPanel(String(args['path'] ?? '?'), diff, pal(), verb));
      } else {
        say(
          R()?.toolResultPanel(
            ev.name,
            args,
            ev.output,
            pal(),
            ev.isError,
            ev.meta,
          ),
        );
      }
      teleRail()?.noteResult(ev.name, !ev.isError);
      loopRail()?.setStage('observing');
    } else if (etype === 'blocked') {
      chat()?.cardFinish();
      const wide = ev as unknown as Record<string, unknown>;
      say(
        R()?.blockedBlock(
          String(wide['targets'] ?? wide['reason'] ?? ''),
          pal(),
        ),
      );
      teleRail()?.noteResult(ev.name ?? 'bash', false);
      loopRail()?.setStage('observing');
    } else if (etype === 'error') {
      flushStream();
      chat()?.cardFinish();
      say(R()?.errorBlock(ev.message, pal()));
    } else if (etype === 'continuing') {
      // The soft round cap was passed because the turn is still getting work
      // done. Said out loud so a long turn is legible rather than looking
      // stuck — and so the count is visible when it does stop.
      flushStream();
      sysLine(
        `${ev.rounds} rounds and still progressing — continuing (${ev.continued} past the ${ev.limit}-round cap)`,
        true,
      );
    } else if (etype === 'iteration_cap') {
      // The turn stopped at a round cap. This is the event whose absence was
      // the bug: without it a capped turn and a finished one looked identical
      // and the rail went IDLE with the task unfinished.
      flushStream();
      chat()?.cardFinish();
      if (ev.hard) {
        sysLine(
          `stopped at the hard limit of ${ev.limit} rounds — this is a runaway guard, so the turn was probably looping without progressing. Send another message to carry on.`,
          true,
        );
      } else {
        sysLine(
          `stopped at ${ev.limit} rounds with no progress in the last one — the task may be unfinished. Send another message to carry on from here.`,
          true,
        );
      }
      loopRail()?.setCapped(ev.rounds, ev.limit, ev.hard);
    } else if (etype === 'compacting') {
      flushStream();
      chat()?.cardFinish();
      const where =
        ev.trigger === 'overflow' ? 'the prompt overflowed' : 'context is nearly full';
      sysLine(
        `${where} — compacting history automatically (${fmtInt(ev.used)} / ${fmtInt(ev.window)} tokens)`,
        true,
      );
      updateBar({ activity: 'compacting' });
    } else if (etype === 'compacted') {
      if (ev.ok) {
        sysLine('history compacted — carrying on with a summary of it', true);
        // The prompt is now a summary, so the live gauge reading is stale by
        // design; drop it to zero rather than leave the old, much larger
        // number on screen as though nothing happened.
        lastCallInputRef.current = 0;
        teleRail()?.setContext(0);
      } else {
        sysLine(`auto-compact failed: ${ev.note}`, true);
      }
      updateBar({ activity: 'thinking' });
    } else if (etype === 'reasoning_exhausted') {
      // A truncation that carried nothing: the reply hit the ceiling and came
      // back empty — what a reasoning model looks like through a proxy that
      // does not forward its thinking. Named separately from `truncated`
      // because the advice differs: nothing the model asked for was dropped,
      // so "the requested action may not have run" would be a lie.
      flushStream();
      chat()?.cardFinish();
      if (ev.retryTokens) {
        sysLine(
          `empty reply at ${fmtInt(ev.maxTokens)} output tokens — the model spent the whole budget on reasoning this endpoint does not forward; retrying with ${fmtInt(ev.retryTokens)}`,
          true,
        );
        updateBar({ activity: 'thinking' });
      } else {
        sysLine(
          `empty reply at ${fmtInt(ev.maxTokens)} output tokens — the model spent the whole budget on reasoning this endpoint does not forward, and the raised retry hit the same wall. Ask again, or narrow the request.`,
          true,
        );
      }
    } else if (etype === 'truncated') {
      // The reply hit the output ceiling and was cut off. Said out loud
      // because the SDK drops a truncated tool call, so a write that ran into
      // the ceiling leaves a transcript that looks exactly like one where the
      // model simply stopped.
      flushStream();
      sysLine(
        `reply truncated at ${ev.maxTokens} output tokens — the requested action may not have run (raise it with --max-tokens)`,
        true,
      );
    } else if (etype === 'nudged') {
      flushStream();
      sysLine(`${ev.label} was not written — asking again (${ev.attempt})`, true);
    } else if (etype === 'deliverable') {
      // The end-of-turn verdict on the file the turn was supposed to leave
      // behind, read off the disk in agent.ts — a fact, not an inference from
      // the transcript. (shared.ts names the key `ok`; Python used `written`,
      // so both are read and the agent.ts porter's choice wins either way.)
      const wide = ev as unknown as Record<string, unknown>;
      const written = Boolean(wide['written'] ?? wide['ok']);
      flushStream();
      if (written) {
        sysLine(`${ev.label} written: ${ev.path}`, true);
      } else {
        sysLine(
          `${ev.label} was never written — the turn ended without it (expected at ${ev.path})`,
          true,
        );
      }
    } else if (etype === 'turn_end') {
      flushStream();
      chat()?.cardFinish();
      costLine(ev);
      teleRail()?.setCost(
        ev.cost + a.sessionCost,
        barRef.current.inputTokens,
        barRef.current.outputTokens,
      );
      loopRail()?.setStage('idle');
    }
  };

  // ---- peer inbox (zim panes) ---------------------------------------------------
  /** Unread pane messages, formatted for the start of the next turn. */
  const drainPeerInbox = (): string => {
    const m = M();
    if (!m) return '';
    const session = m.panes.currentSession();
    const me = m.panes.currentAgent();
    if (!session || !me) return '';
    const root = m.panes.mailboxRoot(cfg().stateDir, session);
    m.panes.register(root, me);
    const msgs = m.panes.drain(root, me);
    if (!msgs.length) return '';
    return '[messages from other Andy panes]\n' + m.panes.formatMessages(msgs);
  };

  /** Build a team Agent. The seam tests replace to stub the model. Every
   * worker gets its own Agent and its own Config copy — see team.ts for why
   * sharing one would clobber the scope guard. */
  const teamAgentFactory = (cfgArg: ConfigLike): AgentLike => {
    const m = M();
    if (!m) throw new Error('modules not loaded');
    return new m.agent.Agent(cfgArg, requestPermission);
  };

  // ---- completion popup (port of complete.CompletionPopup's logic) ------------
  // The popup renders inline above the prompt and never takes focus: typing
  // continues to work normally. Up/Down move, Tab/Enter accept, Esc dismisses.

  const filePool = (): string[] => {
    if (filesCacheRef.current === null) {
      const m = M();
      filesCacheRef.current = m?.complete.iterFiles
        ? m.complete.iterFiles(cfg().workdir, MAX_FILES)
        : iterFilesFallback(cfg().workdir, MAX_FILES);
    }
    return filesCacheRef.current;
  };

  const refreshCompletions = (text: string) => {
    let kind: CompState['kind'] = '';
    let items: [string, string][] = [];
    const m = M();

    if (text.startsWith('/')) {
      kind = 'slash';
      const parts = text.split(/\s+/).filter(Boolean);
      const query = parts[0]?.toLowerCase() ?? text.toLowerCase();
      if (text.trim().includes(' ')) {
        // past the command word — offer sub-arguments
        const arg = parts[1]?.toLowerCase() ?? '';
        const pool: string[] = (() => {
          const cmd = parts[0]?.toLowerCase() ?? '';
          if (cmd === '/model') {
            // Offer whatever the active upstream actually serves, so fetched
            // catalogs show up here too. Null means "no live catalog" — a cold
            // cache or an offline box; the declared list keeps the popup
            // useful there, an empty one would look like a bug.
            return (
              (m ? (m.sources.modelsFor(cfg().baseUrl) ?? m.config.KNOWN_MODELS) : []) ??
              []
            );
          }
          const pools: Record<string, string[]> = {
            '/mode': m?.complete.MODE_NAMES ?? [],
            '/theme': m?.theme.THEME_NAMES ?? [],
            '/osint': m ? m.osint.KIND_ORDER : [],
            '/phish': ['stop', 'status'],
            // Only `tools` — the rest of /ad's arguments are flags, and the
            // target is a domain the operator has to type anyway. Offering the
            // flags here would put a `--ack` in the popup that cannot be
            // accepted without the domain it is a confirmation of.
            '/ad': ['tools'],
            // The argument exists for the gateways whose catalogs are public
            // and worth seeing before a key is set (AntSeed has no key at all).
            '/models': [
              'logfare',
              'tokenjuice',
              'tokenharbour',
              'openrouter',
              'unorouter',
              'antseed',
              'aihubmix',
            ],
          };
          return pools[cmd] ?? [];
        })();
        items = pool
          .filter((a) => a.startsWith(arg) && a !== arg)
          .map((a) => [a, '']);
      } else {
        const cmds = m?.complete.SLASH_COMMANDS ?? [];
        items = cmds.filter(([c]) => c.startsWith(query));
      }
    } else {
      // Find an @token that the cursor is inside: scan back for '@', stopping
      // at whitespace.
      let at: number | null = null;
      for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '@') {
          at = i;
          break;
        }
        if (ch === ' ' || ch === '\t') break;
      }
      if (at !== null) {
        kind = 'file';
        const query = text.slice(at + 1);
        if (query && !/["'|;&]/.test(query)) {
          const q = query.toLowerCase();
          items = filePool()
            .filter((f) => f.toLowerCase().includes(q))
            .slice(0, MAX_FILES)
            .map((f) => [f, '']);
        }
      }
    }

    const trimmed = items.slice(0, MAX_ROWS);
    const index = Math.min(compRef.current.index, Math.max(0, trimmed.length - 1));
    setComp({
      visible: trimmed.length > 0,
      kind,
      items: trimmed,
      index,
    });
  };

  /** Return the new prompt text after accepting the selection, or null. */
  const acceptCompletion = (text: string): string | null => {
    const c = compRef.current;
    const value = c.items[c.index]?.[0];
    if (value === undefined) return null;
    if (c.kind === 'slash') {
      const stripped = text.trim();
      if (stripped.includes(' ') && stripped.split(/\s+/)[0]?.startsWith('/')) {
        const parts = text.split(/\s+/);
        return `${parts[0]} ${value} `;
      }
      return `${value} `;
    }
    // file: replace the @token at/after the last '@'
    const at = text.lastIndexOf('@');
    if (at < 0) return null;
    return text.slice(0, at + 1) + value + ' ';
  };

  // ---- key routing: one router owns stdin --------------------------------------
  // WHY one router: Ink has no focus manager over conditionally-rendered
  // overlays, and two active useInput hooks would both fire on one keypress.
  // The app-level router therefore owns prompt typing, completions and the
  // priority bindings; each overlay disables it by being open and runs its own
  // router. ctrl+c/ctrl+d stay live above everything (Textual priority
  // bindings) so an interrupt is always possible.
  const overlayOwnsKeys =
    perm !== null || paletteOpen || scopePasteOpen || wave !== null || findings !== null;

  useInput(
    (input, key) => {
      // Priority bindings — above the active screen, per the Python App.
      if (key.ctrl && input === 'c') return actionInterrupt();
      if (key.ctrl && input === 'd') return actionQuit();
      if (!bootedRef.current || overlayOwnsKeys) return;
      if (key.ctrl && input === 'l') return actionClear();
      if (key.ctrl && input === 'k') return actionPalette();

      const c = compRef.current;
      // Route completion keys before the prompt sees them.
      if (c.visible) {
        if (key.downArrow) {
          setComp((s) =>
            s.visible ? { ...s, index: (s.index + 1) % Math.max(1, s.items.length) } : s,
          );
          return;
        }
        if (key.upArrow) {
          setComp((s) =>
            s.visible
              ? {
                  ...s,
                  index:
                    (s.index - 1 + Math.max(1, s.items.length)) %
                    Math.max(1, s.items.length),
                }
              : s,
          );
          return;
        }
        if (key.tab || key.return) {
          const newText = acceptCompletion(inputRef.current);
          if (newText !== null) {
            setInputBoth(newText);
            refreshCompletions(newText);
            // Accept only — Enter with a completion taken does not also submit.
            return;
          }
          setComp((s) => ({ ...s, visible: false }));
          // Enter with no completion left should submit, so let it through.
          if (key.return) return submitPrompt(inputRef.current);
          return;
        }
        if (key.escape) {
          setComp((s) => ({ ...s, visible: false }));
          return;
        }
      }

      if (key.return) {
        const v = inputRef.current;
        setInputBoth('');
        setComp((s) => ({ ...s, visible: false }));
        return submitPrompt(v);
      }
      if (key.backspace || key.delete) {
        const next = inputRef.current.slice(0, -1);
        setInputBoth(next);
        refreshCompletions(next);
        return;
      }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.ctrl || key.meta) return;
      if (input && input.length > 0) {
        const next = inputRef.current + input;
        setInputBoth(next);
        refreshCompletions(next);
      }
    },
    { isActive: true },
  );


  // ---- slash commands -------------------------------------------------------------
  /** Commands that answer even while the harness is busy: the ones that report
   * state, control a running campaign, or shut the session down — none starts
   * a turn on the main agent, which is what makes running them mid-flight
   * safe. Everything else is a launcher and would interleave a second turn
   * into the transcript of the first. */
  const BUSY_OK = new Set([
    'help', 'cost', 'scope', 'mode', 'model',
    'stop-hunt', 'summary-hunt', 'findings', 'exit', 'quit',
    // report-bug-hunt: its own refusal is the one the operator reads — the
    // generic busy line points at Ctrl+C, which cancels the workers rather
    // than letting the wave unwind; this command says "stop the wave first".
    'report-bug-hunt',
    // ad is here for `/ad tools` alone — "what does this box have" starts no
    // turn; `/ad <domain>` refuses itself when busy.
    'ad',
    // Setting a key or reading a catalog does not touch the running turn.
    'tokenharbour-api-setup', 'tokenharbour-models', 'zim-tokenharbour',
    'openrouter-api-setup', 'zim-openrouter', 'models',
    'unorouter-api-setup', 'unorouter-models', 'zim-unorouter',
    'aihubmix-api-setup', 'aihubmix-models', 'zim-aihubmix',
    'zim-antseed', 'antseed-models', 'logfare-models',
    // LDXHub: the key and the catalogs are local reads; the catalogs public.
    'ldxhub-api-setup', 'ldxhub-models',
    // Reading an archived report back is a disk read; it starts no turn.
    'osint-tree',
    // Pure reads of in-memory limits — most useful during a long turn.
    'limits',
    // A display toggle reads and writes only harness state, starts no turn.
    'think',
    // zim-opencode hands the terminal to a *different* program and starts no
    // turn; the TUI is suspended and restored around it.
    'zim-opencode',
  ]);

  /** The seam the split-out command handlers receive: the same closures the
   * Python methods reached via `self`. Assembled AFTER every const it names
   * (TDZ: object literals evaluate immediately); handlers read live state
   * through the refs it exposes, never through stale copies. */
  const ctx: AppCtx = {
    cfg: cfg(),
    mods: M,
    agent,
    pal,
    say,
    sysLine,
    updateBar,
    updateHeader,
    setBusyBoth,
    setPaletteBoth,
    setRainBoth,
    setInputBoth,
    chat,
    loopRail,
    teleRail,
    zimPane,
    requestPermission,
    teamAgentFactory,
    runTurn,
    handleEvent,
    expandAtRefs,
    refreshCompletions,
    inputRef,
    busyRef,
    cancelledRef,
    rainOnRef,
    nextWorkerGen: () => ++workerGenRef.current,
    isCurrentWorker: (gen: number) => workerGenRef.current === gen,
    flushStream,
    flushReasoning,
    streamBufRef,
    teamTokensRef,
    huntTokensRef,
    huntStopRef,
    huntRunRef,
    huntSummaryQueuedRef,
    huntDirRef,
    huntTargetRef,
    phishQRef,
    findingsRef,
    setFindings,
    setRecon,
    setWave,
    waveRef,
    reconRef,
    syncRails,
    setPaletteOpen,
    paletteEntriesRef,
    actionQuit,
    actionQuitWith,
    openScopePaste,
    setHuntSpinner,
    termBg,
    termColors,
    suspendTerminal: (fn) => app.suspendTerminal(fn) as Promise<void>,
  };

  const handleCommand = (text: string) => {
    const parts = text.slice(1).split(/\s+/).filter(Boolean);
    const cmd = (parts[0] ?? 'help').toLowerCase();
    const args = parts.slice(1);
    const dispatch: Record<string, (a: string[]) => void | Promise<void>> = {
      help: (a) => cmdHelp(ctx, a),
      clear: () => cmdClear(ctx),
      mode: (a) => cmdMode(ctx, a),
      model: (a) => cmdModel(ctx, a),
      cost: () => cmdCost(ctx),
      scope: () => cmdScope(ctx),
      rain: () => cmdRain(ctx),
      think: () => cmdThink(ctx),
      theme: (a) => cmdTheme(ctx, a),
      save: (a) => cmdSave(ctx, a),
      load: (a) => cmdLoad(ctx, a),
      compact: () => cmdCompact(ctx),
      limits: () => cmdLimits(ctx),
      team: (a) => cmdTeam(ctx, a),
      osint: (a) => cmdOsint(ctx, a),
      'osint-tree': (a) => cmdOsintTree(ctx, a),
      phish: (a) => cmdPhish(ctx, a),
      'bug-hunt': (a) => cmdBugHunt(ctx, a),
      'scope-validator': () => cmdScopeValidator(ctx),
      ad: (a) => cmdAd(ctx, a),
      crack: (a) => cmdCrack(ctx, a),
      'stop-hunt': () => cmdStopHunt(ctx),
      'summary-hunt': () => cmdSummaryHunt(ctx),
      findings: () => cmdFindings(ctx),
      'report-bug-hunt': () => cmdReportBugHunt(ctx),
      panes: () => cmdPanes(ctx),
      'zim-opencode': (a) => cmdZimOpencode(ctx, a),
      'zim-logfare': () => cmdZimSource(ctx, 'logfare'),
      'zim-tokenjuice': () => cmdZimSource(ctx, 'tokenjuice'),
      'zim-tokenharbour': () => cmdZimTokenharbour(ctx),
      'zim-openrouter': () => cmdZimGateway(ctx, 'openrouter'),
      'zim-antseed': () => cmdZimGateway(ctx, 'antseed'),
      'zim-source': () => cmdZimSource(ctx, null),
      'tokenharbour-api-setup': (a) => cmdTokenharbourKey(ctx, a),
      'tokenharbour-models': () => cmdTokenharbourModels(ctx),
      'openrouter-api-setup': (a) => cmdGatewayKey(ctx, 'openrouter', a),
      'zim-unorouter': () => cmdZimGateway(ctx, 'unorouter'),
      'unorouter-api-setup': (a) => cmdGatewayKey(ctx, 'unorouter', a),
      'unorouter-models': () => cmdModels(ctx, ['unorouter']),
      'zim-aihubmix': () => cmdZimGateway(ctx, 'aihubmix'),
      'aihubmix-api-setup': (a) => cmdGatewayKey(ctx, 'aihubmix', a),
      'aihubmix-models': () => cmdModels(ctx, ['aihubmix']),
      'antseed-models': () => cmdModels(ctx, ['antseed']),
      models: (a) => cmdModels(ctx, a),
      'logfare-models': () => cmdLogfareModels(ctx),
      'ldxhub-api-setup': (a) => cmdLdxhubKey(ctx, a),
      'ldxhub-models': (a) => cmdLdxhubModels(ctx, a),
      exit: () => actionQuit(),
      quit: () => actionQuit(),
    };
    const fn = dispatch[cmd];
    if (!fn) {
      sysLine(`unknown command: /${cmd}  — try /help`, true);
      return;
    }
    // The gate lives here rather than at submit so a busy-permitted command
    // can still be dispatched while a run is cooking. See BUSY_OK.
    if (busyRef.current && !BUSY_OK.has(cmd)) {
      sysLine('harness is busy — Ctrl+C to interrupt', true);
      return;
    }
    void fn(args);
  };

  // ---- /phish event queue drain -------------------------------------------------
  /** /phish events arrive from the HTTP server callback. The queue is the only
   * crossing: the 0.25s rail tick drains it onto ZimPane. No lock is needed —
   * JS is single-threaded, these are tiny objects, not renderables. */
  function drainPhish() {
    const batch = phishQRef.current;
    phishQRef.current = [];
    if (!batch.length) return;
    const pane = zimPane();
    if (!pane) return;
    for (const ev of batch) {
      pane.note(ev);
      if (ev['kind'] === 'cred') {
        const user = String(ev['user'] ?? '?');
        sysLine(`phish cred  ${user}  ·  ${mask(String(ev['password'] ?? ''))}`);
      }
    }
  }

  /** `secret` with its middle elided: enough to tell two apart, not enough to
   * be one. */
  function mask(secret: string): string {
    if (!secret) return '(empty)';
    if (secret.length <= 2) return '•'.repeat(secret.length);
    return secret[0] + '•'.repeat(secret.length - 2) + secret[secret.length - 1];
  }

  // ---- /zim-opencode spinner ------------------------------------------------------
  /** Start or stop the proxy-hunt animation. A render-timer rather than worker
   * callbacks on purpose: the worker blocks for tens of seconds at a time
   * inside a single socket call, so a callback-driven animation would freeze
   * for exactly the stretch the operator is waiting through. Function
   * declaration on purpose: the ctx literal below evaluates it immediately. */
  function setHuntSpinner(on: boolean) {
    spinnerFrameRef.current = 0;
    if (on) {
      chat()?.setSpinner(`${HUNT_FRAMES[0]}  ${HUNTING}`);
      if (spinnerTimerRef.current === null) {
        spinnerTimerRef.current = setInterval(() => {
          spinnerFrameRef.current = (spinnerFrameRef.current + 1) % HUNT_FRAMES.length;
          chat()?.setSpinner(`${HUNT_FRAMES[spinnerFrameRef.current]}  ${HUNTING}`);
        }, 120);
      }
      setSpinnerOn(true);
    } else {
      if (spinnerTimerRef.current !== null) {
        clearInterval(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
      chat()?.clearSpinner();
      setSpinnerOn(false);
    }
  }

  // ---- command palette --------------------------------------------------------------
  /** Ctrl+K: every action, fuzzy-searchable. */
  function actionPalette() {
    if (busyRef.current) {
      sysLine('harness is busy — Ctrl+C to interrupt', true);
      return;
    }
    paletteEntriesRef.current = paletteEntries();
    setPaletteOpen(true);
  };

  /** Build the action list. Commands are derived from the same table
   * handleCommand dispatches on, so the palette cannot drift out of sync with
   * the slash commands. */
  const paletteEntries = (): PaletteEntryLike[] => {
    const entries: PaletteEntryLike[] = [];
    const m = M();
    const commands: [string, string, string][] = [
      ['/help', 'command reference', 'help'],
      ['/mode', 'switch mode', 'mode'],
      ['/model', 'show or switch the model', 'model'],
      ['/cost', 'session token and cost breakdown', 'cost'],
      ['/scope', 'scope guard status', 'scope'],
      ['/rain', 'toggle the matrix rain', 'rain'],
      ['/think', "show the model's reasoning", 'think'],
      ['/theme', 'switch palette', 'theme'],
      ['/zim-source', 'upstream sources and status', 'zim-source'],
      ['/zim-tokenharbour', 'switch upstream to TokenHarbour', 'zim-tokenharbour'],
      ['/zim-openrouter', 'switch upstream to OpenRouter', 'zim-openrouter'],
      ['/zim-unorouter', 'switch upstream to UnoRouter', 'zim-unorouter'],
      ['/zim-aihubmix', 'switch upstream to AIHubMix', 'zim-aihubmix'],
      ['/zim-antseed', 'switch upstream to AntSeed', 'zim-antseed'],
      ['/antseed-models', "AntSeed's free models, and the peer to pin", 'antseed-models'],
      ['/tokenharbour-api-setup', 'store your TokenHarbour API key', 'tokenharbour-api-setup'],
      ['/tokenharbour-models', 'fetch the live catalog; show what is free', 'tokenharbour-models'],
      ['/openrouter-api-setup', 'store your OpenRouter API key', 'openrouter-api-setup'],
      ['/unorouter-api-setup', 'store your UnoRouter API key', 'unorouter-api-setup'],
      ['/unorouter-models', 'the live free catalog — what is free and usable', 'unorouter-models'],
      ['/aihubmix-api-setup', 'store your AIHubMix API key', 'aihubmix-api-setup'],
      ['/aihubmix-models', 'the live free catalog — what is free and usable', 'aihubmix-models'],
      ['/models', 'free models of an upstream — /models [source]', 'models'],
      ['/logfare-models', 'fetch the live catalog; show what is up', 'logfare-models'],
      ['/ldxhub-api-setup', 'store your LDXHub API key', 'ldxhub-api-setup'],
      ['/ldxhub-models', 'LDXHub models/engines — pick the default per service', 'ldxhub-models'],
      ['/panes', 're-open this session under tmux', 'panes'],
      ['/zim-opencode', 'open opencode behind a fresh rotating IP', 'zim-opencode'],
      ['/save', 'write the session to disk', 'save'],
      ['/load', 'restore a saved session', 'load'],
      ['/compact', 'summarise history to free context', 'compact'],
      ['/limits', 'context window, round caps and timeouts', 'limits'],
      ['/team', 'fan the task out across parallel agents', 'team'],
      ['/osint', 'open-source recon on a target', 'osint'],
      ['/osint-tree', 're-show a finished recon as a result tree', 'osint'],
      ['/phish', 'clone a login page and harvest creds', 'phish'],
      ['/bug-hunt', 'recon, then one wave of 10 agents', 'bug-hunt'],
      ['/ad', 'Active Directory campaign — gated and interlocked', 'ad'],
      ['/crack', 'crack hashes offline — CPU only, budgeted', 'crack'],
      ['/stop-hunt', 'end a running hunt', 'stop-hunt'],
      ['/summary-hunt', 'the hunt report — what each wave did', 'summary-hunt'],
      ['/report-bug-hunt', 'evidence-only report, every wave', 'report-bug-hunt'],
      ['/findings', 'the hunt finding tracker', 'findings'],
      ['/clear', 'wipe transcript and history', 'clear'],
      ['/exit', 'leave the harness', 'exit'],
    ];
    for (const [title, hint, key] of commands) {
      entries.push({
        key: `cmd:${key}`,
        title,
        hint,
        group: 'command',
        run: () => handleCommand('/' + key),
      });
    }
    if (m) {
      // Modes.
      for (const [name, spec] of Object.entries(m.config.MODES)) {
        entries.push({
          key: `mode:${name}`,
          title: `mode ${name}`,
          hint: spec.blurb,
          group: 'mode',
          run: () => cmdMode(ctx, [name]),
        });
      }
      // Themes.
      for (const name of m.theme.THEME_NAMES) {
        entries.push({
          key: `theme:${name}`,
          title: `theme ${name}`,
          group: 'theme',
          run: () => cmdTheme(ctx, [name]),
        });
      }
      // Models, capped: the catalog can be long and the palette is a shortcut,
      // not a replacement for /model.
      let models: string[] = [...m.config.KNOWN_MODELS];
      try {
        models = m.sources.modelsFor(cfg().baseUrl) ?? models;
      } catch {
        /* keep the declared list */
      }
      for (const name of models.slice(0, 24)) {
        const [pin, pout] = m.config.priceFor(name);
        entries.push({
          key: `model:${name}`,
          title: name,
          hint: `$${pin.toFixed(2)}/${pout.toFixed(2)} per Mtok`,
          group: 'model',
          run: () => cmdModel(ctx, [name]),
        });
      }
      // Files, so the palette can also be a "jump to" — the action inserts the
      // @mention into the prompt rather than submitting it.
      try {
        const files = m.complete.iterFiles
          ? m.complete.iterFiles(cfg().workdir, 120)
          : iterFilesFallback(cfg().workdir, 120);
        for (const fp of files.slice(0, 120)) {
          entries.push({
            key: `file:${fp}`,
            title: fp,
            group: 'file',
            run: () => {
              setInputBoth(`@${fp} `);
            },
          });
        }
      } catch {
        /* a directory that cannot be walked just offers no files */
      }
    }
    return entries;
  };

  // ---- key actions --------------------------------------------------------------
  function actionInterrupt() {
    if (!busyRef.current) {
      sysLine('nothing to interrupt');
      return;
    }
    cancelledRef.current = true;
    // If a permission modal is open, dismiss it so the turn can unwind instead
    // of hanging on an unanswered promise.
    if (perm !== null) {
      perm.resolve('no');
      setPerm(null);
    }
    // Stop any pending worker promptly: bumping the generation makes every
    // running loop's isCurrent() false at its next check.
    workerGenRef.current += 1;
    sysLine('interrupt requested…', true);
  }

  function actionClear() {
    cmdClear(ctx);
  }

  function actionQuit() {
    const m = M();
    try {
      m?.phish.stop();
    } catch {
      /* a campaign that cannot be stopped must not block the exit */
    }
    lastExitResult = null; // a plain exit carries no relaunch request
    props.onExit?.(undefined);
    app.exit();
  }

  /** Exit carrying a result — /panes hands its Relaunch back to cli.ts this
   * way, replacing the Textual `self.exit(value)` idiom: the value is recorded
   * for relaunchRequest() (cli polls it after unmount) and also passed to the
   * optional onExit prop, which tests use to observe it without re-importing. */
  function actionQuitWith(result: unknown) {
    const m = M();
    try {
      m?.phish.stop();
    } catch {
      /* same as actionQuit */
    }
    const r = result as { resume?: unknown } | null | undefined;
    lastExitResult =
      r && typeof r === 'object'
        ? { resume: typeof r.resume === 'string' ? r.resume : undefined }
        : null;
    props.onExit?.(result);
    app.exit();
  }

  /** Open the scope-validator paste box (the screen itself lives in render). */
  function openScopePaste() {
    setScopePasteOpen(true);
  }

  // ---- palette changes propagate to widgets that keep their own renderables ------
  useEffect(() => {
    if (!ready) return;
    chat()?.applyPalette(palette);
    loopRail()?.applyPalette(palette);
    teleRail()?.applyPalette(palette);
    zimPane()?.applyPalette(palette);
  }, [palette, ready]);

  // ---- render -----------------------------------------------------------------------
  if (!mods || !ready) {
    // Modules are still loading; nothing to paint yet. The boot animation is
    // the first thing that needs them, so this gap is sub-perceptual.
    return null;
  }

  if (!booted) {
    const Boot = mods.boot.BootScreen;
    return <Boot palette={palette} checks={bootChecks()} onDone={bootDone} rain={cfg().bootRain} />;
  }

  const W = mods.widgets;
  const Rails = mods.rails;
  // Below ~100 cols the rails are hidden rather than squeezing the chat — the
  // transcript is never the thing that shrinks. ZimPane stays up on a narrow
  // terminal: the operator opened it on purpose.
  const wide = (columns ?? 100) >= 100;

  return (
    <Box flexDirection="column" height="100%" backgroundColor={palette.bg}>
      <W.HeaderBar
        palette={palette}
        model={header.model}
        cwd={cfg().workdir}
        unsafe={cfg().unsafe}
        themeName={themeName}
        mode={header.mode}
        scopeBadge={header.scopeBadge}
        scopeArmed={header.scopeArmed}
      />
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        {wide ? <Rails.LoopRail palette={palette} ref={loopRef} /> : null}
        <W.ChatPane palette={palette} rain={rainOn} ref={chatRef} />
        <W.ZimPane palette={palette} ref={zimRef} />
        {wide ? (
          <Rails.TelemetryRail palette={palette} totalContext={cfg().contextWindow} ref={teleRef} />
        ) : null}
      </Box>
      <Box flexDirection="column">
        {comp.visible ? (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={palette.dim}
            backgroundColor={palette.bg}
            paddingX={1}
            marginX={1}
          >
            {comp.items.map(([value, desc], i) => {
              const selected = i === comp.index;
              return (
                <Box key={value}>
                  <Text color={selected ? palette.accent : palette.dim} bold={selected}>
                    {selected ? '▸ ' : '  '}
                  </Text>
                  <Text color={selected ? palette.accent : palette.primary} bold={selected}>
                    {value}
                  </Text>
                  {desc ? (
                    <Text color={selected ? palette.primary : palette.dim}>
                      {'  ' + desc}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            <Text color={palette.dim}>{'  ↑↓ select · tab accept · esc close'}</Text>
          </Box>
        ) : null}
        <W.StatusBar
          palette={palette}
          model={bar.model}
          inputTokens={bar.inputTokens}
          outputTokens={bar.outputTokens}
          cost={bar.cost}
          turns={bar.turns}
          iterations={bar.iterations}
          activity={bar.activity}
          busy={bar.busy}
          tick={bar.tick}
        />
        <Box
          borderStyle="round"
          borderColor={overlayOwnsKeys ? palette.primary : palette.accent}
          backgroundColor={palette.bg}
          paddingX={1}
          marginX={1}
        >
          <Text color={inputValue ? palette.primary : palette.dim}>
            {inputValue || '❯ message Andy…   ( / commands · @ files · ^K palette )'}
          </Text>
        </Box>
      </Box>
      {recon !== null ? (
        <ReconOverlay
          target={recon}
          palette={palette}
          cfg={cfg()}
          tools={mods.tools}
          ref={reconRef}
        />
      ) : null}
      {wave !== null ? (
        <WaveOverlay
          target={wave.target}
          palette={palette}
          cfg={cfg()}
          tools={mods.tools}
          web={mods.web.WaveWeb}
          wave={wave.wave}
          size={wave.size}
          onStop={() => cmdStopHunt(ctx)}
          ref={waveRef}
        />
      ) : null}
      {findings !== null ? (
        <FindingsPanel
          palette={palette}
          target={findings.target}
          live={findings.live}
          findings={findings.items}
          renderers={mods.renderers}
          onClose={() => setFindings(null)}
        />
      ) : null}
      {scopePasteOpen ? (
        <ScopePasteScreen
          palette={palette}
          onSubmit={(text) => {
            setScopePasteOpen(false);
            if (!text) {
              sysLine('scope-validator cancelled', true);
              return;
            }
            runScopeValidator(ctx, text);
          }}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPaletteLazy
          entries={paletteEntriesRef.current}
          palette={palette}
          onChoose={(entry) => {
            setPaletteOpen(false);
            if (!entry) return;
            entry.run?.();
          }}
        />
      ) : null}
      {perm !== null ? (
        <PermissionModal
          toolName={perm.name}
          preview={perm.preview}
          palette={palette}
          renderers={mods.renderers}
          radius={perm.radius}
          remaining={perm.remaining}
          onChoose={(value) => {
            perm.resolve(value);
            setPerm(null);
          }}
        />
      ) : null}
    </Box>
  );
}

/** CommandPalette from ui/palette-cmd.tsx — reached through the module (not a
 * static import) for the same reason as every other sibling: it may not exist
 * on disk yet. Wrapped as a tiny component so JSX stays declarative. */
function CommandPaletteLazy(props: {
  entries: PaletteEntryLike[];
  palette: Palette;
  onChoose: (entry: PaletteEntryLike | null) => void;
}) {
  const [Comp, setComp] = useState<FC<{
    entries: PaletteEntryLike[];
    palette: Palette;
    onChoose: (entry: PaletteEntryLike | null) => void;
  }> | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const m = await sibling<PaletteCmdModule>('./palette-cmd.js');
      if (alive) setComp(() => m.CommandPalette);
    })();
    return () => {
      alive = false;
    };
  }, []);
  if (!Comp) return null;
  return <Comp entries={props.entries} palette={props.palette} onChoose={props.onChoose} />;
}

// === SECTION === the command-handler context (the split seam) ====================
//
// The Python App kept every command as a method on `self`; here the handlers
// live in ./screens/*.tsx (split once app.tsx passed ~3k lines) and receive
// everything they need through this context. Refs are shared, not copied, so
// handlers always read live state; setState-shaped members are the component's
// own stable closures.

export interface AppCtx {
  cfg: ConfigLike;
  mods(): Mods | null;
  agent(): AgentLike | null;
  pal(): Palette;
  say(node: ReactNode): void;
  sysLine(message: string, warn?: boolean, ok?: boolean): void;
  updateBar(patch: Partial<BarState>): void;
  updateHeader(patch: Partial<HeaderState>): void;
  setBusyBoth(v: boolean): void;
  setPaletteBoth(p: Palette, name: string): void;
  setRainBoth(on: boolean): void;
  setInputBoth(v: string): void;
  chat(): ChatPaneHandle | null;
  loopRail(): LoopRailHandle | null;
  teleRail(): TelemetryRailHandle | null;
  zimPane(): ZimPaneHandle | null;
  requestPermission: PermissionHandler;
  teamAgentFactory(cfg: ConfigLike): AgentLike;
  runTurn(
    text: string,
    opts?: {
      display?: string;
      osintCase?: string;
      finalise?: () => void;
      deliverable?: Deliverable;
    },
  ): Promise<void>;
  handleEvent(ev: AgentEvent): void;
  expandAtRefs(text: string): Promise<string>;
  refreshCompletions(text: string): void;
  inputRef: { current: string };
  busyRef: { current: boolean };
  cancelledRef: { current: boolean };
  rainOnRef: { current: boolean };
  nextWorkerGen(): number;
  isCurrentWorker(gen: number): boolean;
  flushStream(): void;
  flushReasoning(): void;
  streamBufRef: { current: string };
  teamTokensRef: { current: [number, number, number] };
  huntTokensRef: { current: [number, number, number] };
  huntStopRef: { current: StopSignal | null };
  huntRunRef: { current: HuntRunLike | null };
  huntSummaryQueuedRef: { current: boolean };
  huntDirRef: { current: string | null };
  huntTargetRef: { current: string };
  phishQRef: { current: Array<Record<string, unknown>> };
  findingsRef: { current: { target: string; live: boolean; items: FindingDict[] } | null };
  setFindings(v: { target: string; live: boolean; items: FindingDict[] } | null): void;
  setRecon(target: string | null): void;
  setWave(w: { target: string; wave: number; size: number } | null): void;
  waveRef: { current: WaveOverlayHandle | null };
  reconRef: { current: ReconOverlayHandle | null };
  syncRails(): void;
  setPaletteOpen(open: boolean): void;
  paletteEntriesRef: { current: PaletteEntryLike[] };
  actionQuit(): void;
  /** Exit carrying a result value (/panes' Relaunch). */
  actionQuitWith(result: unknown): void;
  /** Open the /scope-validator paste box. */
  openScopePaste(): void;
  setHuntSpinner(on: boolean): void;
  termBg?: string | null;
  termColors?: TerminalColorsLike | null;
  suspendTerminal(fn: () => Promise<void>): Promise<void>;
}

export default AndyApp;
