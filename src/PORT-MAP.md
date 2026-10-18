# PORT-MAP — Python original → Andy (TypeScript)

Coordination artifact for the parallel port. Source of truth for who ports what,
against which contract, in which order. Do not edit signatures here without
updating `src/shared.ts` — the two are the same contract written twice.

- Source: the historical Python package — **43 files**, = **41 real modules**
  (the two `__init__.py` files are version/empty markers, folded into
  `package.json` / `cli.ts`; see rows 40–41), ~33,880 lines. The tree was
  removed at cutover; it lives in git history at tag **`pre-andy-port`**
  (`git show pre-andy-port:<module path>` to consult a file).
- Target: this repository's `src/` — ESM, Node ≥ 22, strict TS,
  Ink 8 + React 19 TUI, `@anthropic-ai/sdk`, `markdown-it`, `yaml`, `zod`, `chalk`.
- Package/bin name and product identity: `Andy`.

Naming conventions for the port (apply everywhere, no per-module decisions):

| Python | TypeScript |
|---|---|
| `snake_case` functions/fields | `camelCase` (`is_error` → `isError`) |
| `PascalCase` classes | `class` / interface, keep name (`Scope`, `Agent`) |
| `UPPER_SNAKE` constants | `UPPER_SNAKE` kept (compile-time feel) |
| file `osint_tree.py` | `src/osint-tree.ts` (kebab) |
| leading-underscore helpers | **do not export** (module-private) |
| `Path` (pathlib) | `string` paths via `node:path` unless a Node API needs a `URL` |
| `dict` / tuple payloads | typed interfaces from `src/shared.ts` where 3+ modules share |

---

## 1. Module map (41 rows)

Key: **exports** lists the public surface other modules import (the contract to
reproduce; internal regex/private helpers are omitted — port them unexported).
**Imported-by** is the reverse dependency list from the Python import graph
(`rg '^\s*(from|import)\s+(\.|andy)'`). "lazy" = Python function-level
import → in TS use `await import()` inside the function or restructure.

### Core runtime

| # | Python | Target TS | Exports (TS signatures) | Imported-by |
|---|---|---|---|---|
| 1 | `config.py` (307) | `src/config.ts` | `DEFAULT_BASE_URL: string` (`"http://localhost:4001"`); `DEFAULT_MODEL`; `DEFAULT_HOME: string` (`~/.andy`); `findAgentsFile(workdir: string, home?: string, userHome?: string): string \| undefined` (search order: `<workdir>/AGENTS.md`, parent, `$ANDY_HOME/AGENTS.md`, `~/AGENTS.md`); `MODES: Record<ModeName, {label, blurb, auto: Set<string>, deny: Set<string>, loud?: boolean}>`; `DEFAULT_MODE`; `PRICING: Record<string, [number, number]>`; `DEFAULT_PRICE`; `KNOWN_MODELS: string[]`; `priceFor(model: string): [number, number]` (free-suffix check FIRST — load-bearing, keep); `class Config` — all fields from §2.4 below, plus `apiKeyPresent: boolean` (getter), `static Config.fromEnv(overrides?: Partial<Config>): Config` (reads `ANTHROPIC_BASE_URL/API_KEY/AUTH_TOKEN`, `ANDY_MODEL`, `ANTHROPIC_MODEL`), `redactedEndpoint(): string` | `__main__`, `team`, `hunt`, `agent`, `ui/app`, lazy: `ui/widgets`, `ui/complete` |
| 2 | `agent.py` (1396) | `src/agent.ts` | `MAX_OUTPUT_CEILING = 131072`; `IDENTITY`, `SYSTEM_PROMPT`, `MODE_PROMPTS`, `UNCENSORED_PROMPT: string`; `type PermissionHandler = (name: string, args: Record<string, unknown>, preview: Preview \| null) => Promise<"yes"\|"no"\|"always">`; `type ToolHook = (name: string, args: Record<string, unknown>) => AsyncContext<null>` (returns an object with `enter/exit` — spans the whole call); `class Deliverable {path: string; label: string; maxNudges: number}`; `class Agent` — ctor `(cfg: Config, permissionHandler?: PermissionHandler, toolHook?: ToolHook, canReport?: boolean, canHuntRead?: boolean, canPeer?: boolean, peerInbox?: () => string)`; fields `messages: ChatMessage[]`, `scope: Scope`, `sessionInputTokens/sessionOutputTokens: number`, `sessionCost: number`, `turnCount: number`, `lastTurnCost: number`; methods `runTurn(prompt: string \| ChatMessage[], deliverables?: Deliverable[]): AsyncGenerator<AgentEvent>` (the whole §2.1 event union), `setModel(m)`, `setMode(m)`, `toolSchemas(): ToolSchema[]` (mode + canReport/canHuntRead/canPeer/ldxhub-key filtered), `clear()`, `cancelTurn()`, `notice(text)` (buffered facts folded into next turn), `compact(): Promise<[boolean, string]>`, `get client(): Anthropic` (lazy; bearer-token and api-key are MUTUALLY EXCLUSIVE — port that comment, it is a measured trap) | `team`, `hunt`, `ui/app` |
| 3 | `tools.py` (1591) | `src/tools.ts` | `TOOL_SCHEMAS: ToolSchema[]` (bash, read_file, write_file, edit_file, glob, grep, list_dir, search_web, web_fetch, report_finding, hunt_findings, ldxhub_structflow, ldxhub_analyze, ldxhub_extract, ldxhub_convert, ldxhub_refine, ldxhub_list); `PEER_SCHEMAS` (agent_peers, agent_send, agent_inbox); `TOOL_NAMES`; `GATED_TOOLS: Set<string>` (bash, write_file, edit_file); `HUNT_ONLY_TOOLS` (report_finding); `MAIN_ONLY_TOOLS` (hunt_findings); `PEER_TOOLS`; `LDXHUB_TOOLS`; `class ToolResult {output: string; isError?: boolean; meta?: Record<string, unknown>}` (in shared.ts); `class Preview {kind: "command"\|"diff"\|"text"; title: string; body: string}` (in shared.ts); `class ToolError extends Error`; `needsPermission(name): boolean`; `buildPreview(name, args, cfg): Preview`; `execute(name: string, args: Record<string, unknown>, cfg: Config): Promise<ToolResult>` (async in TS — bash is subprocess); `summariseCall(name, args, cfg, maxLen=70): string` (ui/web imports this) | `team`, `hunt`, `agent`, `ui/app`, lazy: `ui/web` |
| 4 | `scope.py` (561) | `src/scope.ts` | `NETWORK_TOOLS: Set<string>`; `class ScopeViolation`; `class HostSet` (domains/ips/cidrs + matching); `class Scope` — `static load(allowPath?: string, denyPath?: string): Scope`, `.armed: boolean` (allow-file PRESENCE arms the session), `.loaded`, `checkCommand(cmd): string \| undefined` (violation msg), `checkUrl(url)`, `checkPath/Host`…; `findLegacyScope(workdir, home?): string \| undefined`. `_DOMAIN_KEYS/_IP_KEYS/_CIDR_KEYS` are imported by scope_validator — export them (or a single `SCOPE_KEY_SETS`) | `__main__`, `agent`, `scope_validator`, lazy: `tools` (×2), `ui/app` |
| 5 | `session.py` (101) | `src/session.ts` | `sessionsDir(cfg): string` (`$ANDY_HOME/sessions`); `save(cfg, agent, name?): string` (writes `SessionPayload` JSON, `YYYYMMDD-HHMMSS[-slug].json`); `load(cfg, agent, path): Promise<[boolean, string]>` (bare-name + glob fallback); `listSessions(cfg): SessionSummary[]` | `__main__`, `ui/app` |
| 6 | `sandbox.py` (89) | `src/sandbox.ts` | `class SandboxError extends Error`; `resolveInJail(workdir: string, raw: string, unsafe?: boolean, opts?: {mustExist?: boolean}): string`; `containedInJail(workdir, path, unsafe?): boolean`; `safeGlobPattern(pattern): boolean`; `displayPath(workdir, path): string` | `tools`, lazy: `ui/app` (×2) |
| 7 | `websearch.py` (615) | `src/websearch.ts` | `class Result {title, url, snippet}`; `class WebError extends Error`; `search(query, maxResults=5, timeout?): Promise<Result[]>` (DDG-lite → 4get → mwmbl → rightdao fallback chain; order overridable via `ANDY_SEARCH_BACKENDS`); `fetch(url, maxChars=20000, timeout=20): Promise<[string, string]>` (returns `[text, finalUrl]`); `parseResults/parse4get/parseMwmbl/parseRightdao(htmlOrPayload): Result[]` (parsers are pure — good unit-test seam); `htmlToText(html): string`; `ddgIsChallenged(status, text): boolean` | `tools` only |
| 8 | `team.py` (531) | `src/team.ts` | `TEAM_MAX_AGENTS=5`, `TEAM_CONCURRENCY=4`, `MAX_BRIEF_CHARS=2000`; `PLANNER_PROMPT`; `class WorkerSpec {name, brief, owns: string[]}`; `class Roster {workers, waves: WorkerSpec[][]}`; `class WorkerResult {name, ok, text, ...}`; `parseRoster(text, maxAgents?): Roster \| null`; `runTeam(cfg, task, opts?): Promise<WorkerResult[]>` (wave scheduler; `_write_lock_hook` → the `ToolHook` serialisation point — port as an async mutex handed to each Agent); `synthesisPrompt(task, results): string` | `hunt`, `ui/app` |
| 9 | `hunt.py` (2628) | `src/hunt.ts` | `HUNT_WAVE_SIZE=10`, `HUNT_CONCURRENCY=10`; `VALID_SEVERITIES`, `SEVERITY_ORDER` (ui/web imports both), `normaliseSeverity(raw): string`; `HUNT_VECTORS`, `AD-style prompt templates` (`FINDING_CONTRACT`, `RECON_PROMPT`, `WAVE_PLANNER_PROMPT`, `SUMMARY_PROMPT`); `class CampaignKind`, `HUNT_KIND`; `class Finding`, `WaveRecord`, `HuntRun`, `ReconNote`; `fallbackRoster(wave, waveSize, ...)`, `briefContext(run, limit?)`, `parseFindings(text, {wave, agent}): Finding[]`; `caseDir(cfg, target, kind?): string` (`$ANDY_HOME/hunts/<scope>-<stamp>/wave-N/` layout); `waveDirs/nextWaveNumber/waveDir/waveFindingsDir`; `migrateHunts(cfg)`, `reorganiseWaves(cfg)` (on-disk migration — port AFTER layout is pinned by tests); `loadRun(directory): HuntRun \| undefined`; `findRecon(directory)` | `ad`, `ui/app`, `ui/web` |
| 10 | `ad.py` (1339) | `src/ad.ts` | AD (Active Directory) attack-surface module. `validateTarget(raw): string`; `ackPhrase(refusal)`; `class ToolProbe {name, path, available}`, `probeTools(): ToolProbe[]`, `renderTools(probes)`, `unavailableVectors(probes)`; `class Verdict`, `inspect(command): Verdict` (interlock static analysis — the tier-2 gate for AD commands); `makeInterlock(...)`; `class InterlockRefusal extends RuntimeError`; `class Throttle`, `class AttemptBudget`; `AD_VECTORS`, `AD_LATER_VECTORS`, `PLANNER_PROMPT`, `FINDING_CONTRACT`, `SUMMARY_PROMPT`, `buildReconPrompt(probes)` | `ui/app` only (and internally `hunt`) |
| 11 | `crack.py` (869) | `src/crack.ts` | Hashcat planner. `HASH_MODES: Record<number, [string, string]>`; `identify(text)/identify(path): Detected[]`; `class Stage`, `LADDER: Stage[]`; `plan(mode, maxTime, {deep}): PlannedStage[]`; `estimate(mode, stage): number`; `humanTime(s): string`; exit-code map `EXIT_CRACKED…EXIT_FINISH`, `exitMeaning(code)`, `STOPPED: Set<number>`; `runStage(...)` (spawns hashcat); `recovered(hashfile, mode, potfile, ...)`, `potfile(cfg)`, `caseDir(cfg, target)`, `reportsDir(cfg)`, `finaliseCase(cfg, case)`, `validatePath(raw): [string \| undefined, string]`; `PLAYBOOK` prompt template | `ui/app` only |
| 12 | `phish.py` (1124) | `src/phish.ts` | Credential-capture lab (operator-authorised targets only). `normaliseTarget/targetUrl/validateTarget`, `loginCandidates(raw): string[]`, `looksLikeLogin(html): boolean`, `caseSlug`, `campaignDir(cfg, target)`; `cloneLogin(raw, timeout?): Promise<[string \| null, string, string]>`; `pickCredentials(fields): [string, string]`; `class Tunnel {kind, url, proc, ...}`, `openTunnel(port): Promise<Tunnel>` (cloudflared → ngrok → localtunnel → pagekite order), `pagekiteBin/pagekiteName`; `class Campaign`, `active(): Campaign \| undefined`, `start(cfg, target, opts?): Campaign`, `stop(): Campaign \| undefined` (local HTTP capture server — port to `node:http`) | `ui/app` only |
| 13 | `osint.py` (2298) | `src/osint.ts` | `class Kind {name, label, blurb, playbook, ...}`; `OSINT_KINDS: Record<string, Kind>` (email, github, discord, facebook, tiktok, instagram); `KIND_ORDER: string[]` (osint_tree + ui/complete import); `normalise(kind, target)`, `validate(kind, target): [boolean, string]`, per-kind `normaliseX` fns; `caseSlug`, `caseDir(cfg, kind, target)`, `reportsDir(cfg)`, `finaliseCase(cfg, case): [string \| undefined, boolean]`; `buildPrompt(kind, target, case): string`; the six `*_PLAYBOOK` prompt templates (~1500 lines of the file) | `osint_tree`, `ui/complete`, `ui/app` |
| 14 | `osint_tree.py` (655) | `src/osint-tree.ts` | Report-tree renderer over osint reports. `class Node`; `CONFIDENCES`, `CONFIDENCE_STYLE`, `confidenceStyle(conf, palette, {bold})`; `parseReport(text, {fallbackTitle}): Node`, `parseReportFile(path)`, `findReport(cfg, which?): string \| undefined`; `countFindings(node): [number, Record<string, number>]`, `summaryLine(node)`, `renderTree(node, palette)` | `ui/app` only |
| 15 | `scope_validator.py` (524) | `src/scope-validator.ts` | Scope bootstrap from a programme brief. `EXTRACT_PROMPT`, `RANK_PROMPT`; `class ScopeEntry/Extraction/Ranked/HostRecon/Report`; `parseExtraction(text)`, `parseRanking(text, assets)`; `buildScope(entriesIn, entriesOut): [allow, deny, assets]`; `writeScopeFiles(dest, allow, deny, programme?): [string, string]`, `verifyScopeFiles(allowPath, denyPath): string[]`; `reconHost(host, timeout?)`, `reconAll(hosts, deny?, ...)`, `reconLine(r)`, `rankPrompt(...)`, `renderPlainTree(...)` | `ui/app` only (lazy) |

### Provider / credential sources

All historical provider modules + `sources.py` form one lazily-circular family in
Python (`sources` knows the providers; each provider falls back to
`sources.model_ids`). In TS keep the cycle lazy with function-level
`await import()`, or split a tiny `provider-contract.ts` with the shared
`Model`/`catalog` interface and break the cycle structurally.

| # | Python | Target TS | Exports (TS signatures) | Imported-by |
|---|---|---|---|---|
| 16 | `sources.py` (430) | `src/sources.ts` | `class Source {key, label, port, baseUrl, model, ...}`; `BUILTIN_KEYS: Set<string>` (tokenharbour, openrouter, unorouter, antseed, aihubmix, zai); `LOGFARE_MODELS`, `TOKENJUICE_MODELS`, `ZAI_MODELS`, `MODELS_BY_KEY`; `discover(): Record<string, Source>` (scans LiteLLM proxy service/config/profile files); `modelsFor(baseUrl): string[] \| undefined`; `contextWindowFor(baseUrl, model): number \| undefined`; `sourceForPort(port)`, `currentKey(): string \| undefined` (reads `$ANDY_HOME/current-source`), `setCurrent(key)`; `activeKey(baseUrl)`; `loadProfile(src): Record<string, string>`; `proxyHealthy(port, timeout?): boolean`, `startProxy(src, timeout?): Promise<[boolean, string]>` | `__main__`, `agent` (lazy), `ui/complete` (lazy), `ui/app`; lazy back-refs from the provider family |
| 17 | `logfare.py` (219) | `src/logfare.ts` | `class Model`; `fetchModels({hours, timeout}): Promise<[Model[] \| null, string]>` (memoised 300 s); `modelIds(**kw)`, `cachedModels()`, `cachedIds()`, `catalogAge()`, `clearCache()`; `healthFor(model)`, `isLogfare(baseUrl): boolean` | `sources` (lazy ×2), `__main__`, `ui/app` |
| 18 | `tokenharbour.py` (438) | `src/tokenharbour.ts` | Same catalog contract as openrouter (Model class, `fetchModels(token?)`, `freeModels`, `modelIds`, `cached*`, `clearCache`, `priceFor(model, models?)`, `catalogAge`); credential side: `loadCredentials(): [string, string, string] \| null` (profile file → `ANTHROPIC_*` env → `~/.claude` source), `saveKey(token, model?)`, `hasKey()`, `looksLikeKey(v)`, `applyTo(cfg)`, `appliesToDefaultEndpoint(baseUrl)`, `currentKey/setCurrent` | `sources` (lazy ×2), `__main__`, `ui/app` |
| 19 | `openrouter.py` (532) | `src/openrouter.ts` | Identical contract shape to #18 against `openrouter.ai/api`; plus `usableFreeModels(token?)` | `sources` (lazy ×2), `__main__`, `ui/app` |
| 20 | `aihubmix.py` (530) | `src/aihubmix.ts` | Identical contract shape to #18 against `aihubmix.com` (free suffixes `-free`/`:free`) | `sources` (lazy ×2), `__main__`, `ui/app` |
| — | *(TS-only)* | `src/zai.ts` | Z.ai GLM Coding Plan source: Anthropic base `https://api.z.ai/api/anthropic`, credential-scoped `/v1/models`, Coding Plan key profile, subscription-safe model metadata | `sources` (lazy ×2), `__main__`, `ui/app` |
| 21 | `unorouter.py` (804) | `src/unorouter.ts` | Identical contract shape plus `modelFor(model, models?)`, `defaultFreeModel(token?)`, per-model metadata (`contextWindow`) | `sources` (lazy ×2), `__main__`, `ui/app` |
| 22 | `antseed.py` (856) | `src/antseed.ts` | Local P2P buyer. `buyerConfig(): Record<string, unknown>`, `proxyPort()`, `isAntseed(baseUrl)`, `reachable(timeout?)`; `class Peer`, `class Model`; `fetchModels(baseUrl?, {timeout}): Promise<[Model[] \| null, string]>` + full cached suite; `PREFERRED_FREE_MODELS`, `defaultFreePin(baseUrl?)`, `freeModelIds`, `agenticModels`; pin side: `loadPin()/savePin(model, peer?)` (NOT saveKey — antseed has no key); `applyTo(cfg)`, `appliesToDefaultEndpoint`, `looksLikeKey`, `currentKey/setCurrent` | `sources` (lazy ×2), `__main__`, `ui/app` |
| 23 | `ldxhub.py` (587) | `src/ldxhub.ts` | Document-job service client. `SERVICES: Record<string, string>`, `DEFAULT_VAR`; `class Entry`; `loadCredentials(): [string, Record<string, string>, string] \| null` (`LDXHUB_API_KEY` env → `$ANDY_HOME/ldxhub/source`), `saveKey(token, defaults?)`, `saveDefault(service, entryId)`, `hasKey(): boolean`; `fetchCatalog(service, token?, {timeout}): Promise<Entry[]>` (300 s cache), `cachedCatalog`, `clearCache`, `catalogAge`; `resolveEntry(service, explicit?, creds?)`, `defaultFor(service, creds?)`; `uploadFile(path, token): Promise<[string, string]>`, `downloadFile(fileId, token, dest)`, `createJob/getJob/runJob(service, payload, token, ...)`, `jobOutput(job): [string \| null, string \| null, string]`; `serviceHelp()` | `agent` (lazy ×2 — hasKey gates tool schemas), `tools` (lazy ×7), `ui/app` |

### Launcher / shell integration

| # | Python | Target TS | Exports (TS signatures) | Imported-by |
|---|---|---|---|---|
| 24 | `__main__.py` (352) | `src/cli.ts` (scaffold exists) | `buildParser(): ArgumentParser` (flags: `--model/-m --workdir/-C --allow --deny --scope(deprecated) --unsafe --theme --rain --no-rain --no-think --mode --agents --max-tokens --no-auto-compact --no-update --list-models --panes --resume --version`); `main(argv?): number \| Promise<number>` — env gating (`ANDY_NO_UPDATE`, `ANDY_UPDATED`, `ANDY_ROOT` for the launcher path), then `render(<AndyApp/>)`. Use `commander` or hand-rolled arg parsing (NOT in deps — decide at port time; `util.parseArgs` is stdlib and sufficient) | entry point |
| 25 | `panes.py` (358) | `src/panes.ts` | tmux multi-agent panes. `ENV_SESSION = "ANDY_PANE_SESSION"`; `TMUX_SOCKET = TMUX_SESSION = "andy"`; `Relaunch`; `nestedInTmux(): boolean`; `tmuxConf(andyCmd, nested?): string`, `writeTmuxConf(stateDir, andyCmd, nested?)`, `tmuxAvailable()`, `currentSession()`, `currentAgent()`, `agentNameForPane(paneId)`; mailbox: `mailboxRoot(stateDir, session): string`, `register(root, agent)`, `knownAgents(root): string[]`, `send(root, sender, to, body): Message`, `drain(root, agent): Message[]`, `formatMessages(msgs): string`, `transcriptOf(msgs): [string, string][]`; `tmuxPaneId()`, `applyConfig(conf, socket?)`, `launch(conf, andyCmd, workdir, ...)` | `__main__` (×2 lazy), `tools` (lazy — agent_inbox/peers), `ui/app` (lazy ×3) |
| 26 | `opencode.py` (985) | `src/opencode.ts` | Rotating-proxy opencode launcher. `BINARY="opencode"`, `ALIAS="opencode-andy"`; `stateDir()` (`$ANDY_HOME/opencode`), `poolFile()`; `findBinary()`, `isInstalled()`; `class Proxy`, `class Pool`; `loadPool/savePool`, `parseCandidates(text): Proxy[]`, `fetchCandidates(timeout?)`; `validate(candidates, target?): Proxy[]`, `validateTurns(...)`, `buildPool/getPool/rotate(...)`; `childEnv(proxy, base?): Record<string,string>`, `buildArgv(binary, args?, ...)`, `run(proxy, binary, args?)`, `probeExitIp(proxy)`, `classify(text)`, `findWorkingProxy(...)`, `probeLaunch(...)`; `aliasPath()`, `installAlias(): [boolean, string]`, `aliasInstalled()`, `main(argv?)` | `ui/app` only |
| 27 | `update.py` (336) | `src/update.ts` | `class UpdateResult`; `findCheckout(): string \| undefined` (walk up from `import.meta.url`/argv[1]); `inspect(root, timeout?): UpdateResult` (git fetch + HEAD compare); `apply(root, result): UpdateResult`; `run({enabled}): UpdateResult`; `formatResult(result, stream?)` | `__main__` only |

### Theme / terminal detection

| # | Python | Target TS | Exports (TS signatures) | Imported-by |
|---|---|---|---|---|
| 28 | `theme.py` (257) | `src/theme.ts` | `class Palette {bg, fg, dim, accent, warn, err, good, ...}` (string hex/ANSI); `PALETTES: Record<string, Palette>`; `DEFAULT_THEME="green"`, `SYSTEM_THEME="system"`, `THEME_NAMES: string[]`; `systemPalette(colors?: TerminalColors): Palette`; `getPalette(name, bg?, ...): Palette`; `currentTheme(): string \| undefined` (reads `$ANDY_HOME/current-theme`), `setCurrentTheme(name)`; `THINKING_VERBS: string[]`, `AGENT_COLORS: string[]`, `agentColor(index, palette?): string`; `TOOL_ICONS: Record<string, string>` | all 12 `ui/*` modules, `__main__` |
| 29 | `termbg.py` (154) | `src/termbg.ts` | OSC-11 terminal background query. `parseBackground(reply): string \| undefined`, `isDark(hex): boolean`, `query(payload, timeout?): Promise<Buffer>`, `detectBackground(): Promise<string \| undefined>` | `termcolors` |
| 30 | `termcolors.py` (124) | `src/termcolors.ts` | `ANSI_SLOTS=16`, `class TerminalColors`, `parseColors(reply): TerminalColors`, `detectColors(timeout?): Promise<TerminalColors \| undefined>` | `theme` (lazy), `__main__` (lazy), `ui/app` (lazy) |

### ui/ subpackage (Textual → Ink; see §3 for the API mapping)

All ui targets use `.tsx` — Ink components are React components; JSX is the
honest extension. Non-component helpers inside them may live in the same file.

| # | Python | Target TS | Exports | Imported-by |
|---|---|---|---|---|
| 31 | `ui/app.py` (6268) | `src/ui/app.tsx` | `class AndyApp → AndyApp: FC<{cfg: Config; resume?: SessionPayload}>` — the shell. Composition: HeaderBar + ChatPane + PromptInput + StatusBar + LoopRail/TelemetryRail + WaveWeb + overlays (PermissionModal, ReconOverlay, WaveOverlay, ScopePasteScreen, FindingsPanel, CompletionPopup, CommandPalette, BootScreen). Public seams other code touches: `requestPermission(name, args, preview): Promise<"yes"\|"no"\|"always">` (passed as `Agent`'s permissionHandler), `_handleEvent(ev: AgentEvent)` (§2.1 dispatch), slash commands (`/model /mode /theme /rain /think /compact /team /hunt /ad /crack /osint /phish /panes /ldxhub-api-setup /sources …` — enumerate from `ui/complete.SLASH_COMMANDS` + `palette_cmd`), `actionInterrupt/actionClear/actionQuit/actionPalette` | `__main__` only |
| 32 | `ui/widgets.py` (1081) | `src/ui/widgets.tsx` | `PromptInput` (Input subclass → wrapped ink `TextInput`), `HeaderBar`, `ChatPane` (the transcript; streaming/reasoning slots `setStream/setReasoning`), `StatusBar` (reactive counters: iterations, turns, tokens, cost, activity), `AndyPane` (the /panes agent grid); `NEWLINE_GLYPH` | `ui/app` |
| 33 | `ui/renderers.py` (647) | `src/ui/renderers.tsx` | Panel/line builders over chalk + Box: `toolCallPanel`, `toolResultPanel`, `toolRunningPanel`, `huntToolPanel`, `turnMarker`, `renderOutputText`, `diffPanel`, `userPromptBlock`, `errorBlock/warningBlock/blockedBlock`, `bannerRenderable`, `reasoningLive/reasoningPanel`, `agentText/agentLabel/agentLine/agentEventLine`, `SEVERITY_PALETTE`, `SEVERITY_ORDER`, `severityStyle`, `findingLine/findingDetail`, `langForPath`, `detectLangForCommand`, `hackerSyntax` (Rich `Syntax` → re-implement with a highlighter or plain chalk) | `ui/app` (as namespace `R`), lazy: `ui/widgets` (×3) |
| 34 | `ui/markdown.py` (479) | `src/ui/markdown.tsx` | markdown-it based renderer → React nodes: `markdownText(text, palette): ReactNode`, `markdownRenderable(text, palette): ReactNode`, `markdownLine(text, palette): ReactNode` | `ui/renderers`, `ui/app`, lazy: `ui/widgets` |
| 35 | `ui/rails.py` (702) | `src/ui/rails.tsx` | `STAGES`, `STAGE_LABEL`; `RailResizeMixin` → custom hook `useRailResize`; `LoopRail`, `Waveform`, `ContextGauge`, `FileRiver`, `CallStrip`, `TelemetryRail` (all `Static` subclasses → FC) | `ui/app` |
| 36 | `ui/web.py` (1621) | `src/ui/web.tsx` | `WaveWeb` — the hunt visualiser grid. `LANES`, `SEVERITY_LABEL`, `severityStyle(palette, severity)`; layout consts (`RAIL_W`, `DRAWER_W`, …); `class AgentCell/Detail/Layout` → types + helpers | `ui/app` |
| 37 | `ui/banner.py` (302) | `src/ui/banner.tsx` | ASCII font banner + emblem + spinner: `FONT`, `renderWord`, `bannerLines(spacing?): string[]`, `outlineLines(width?)`, `bannerSubtitle()`, `bannerWidth()`, `EMBLEM`, `spinFrame(i)`, `emblemFrame(theta)`, `spinFrameIndex(elapsed)`, `splashMark(palette, model?, baseUrl?)` — renders "ANDY" wordmark → **"ANDY"** | `ui/boot`, `ui/renderers` (lazy), `ui/app` (lazy) |
| 38 | `ui/boot.py` (257) | `src/ui/boot.tsx` | `BootScreen: FC` (glitch-decrypt boot animation over the banner + MatrixRain) | `ui/app` |
| 39 | `ui/rain.py` (402) | `src/ui/rain.tsx` | `GLYPHS`, `ASCII_GLYPHS`, `TAIL_LEN`; `MatrixRain: FC` (canvas widget → interval-driven state), `RainRichLog` (RichLog subclass → custom scrollback component), `RainCanvas` | `ui/widgets`, `ui/boot` |
| 40 | `ui/complete.py` (306) | `src/ui/complete.tsx` | `SLASH_COMMANDS: [string, string][]` (single source for the command list — app + palette share it), `MODE_NAMES`; `MAX_ROWS=8`, `MAX_FILES=200`; `iterFiles(root, limit?): string[]`; `CompletionPopup: FC` | `ui/app` |
| 41 | `ui/palette_cmd.py` (215) | `src/ui/palette-cmd.tsx` | `class PaletteEntry → interface {label, hint, action}`; `fuzzy(query, text): [number, number[]] \| undefined`; `rank(entries, query)`, `CommandPalette: FC` (ModalScreen → overlay component) | `ui/app` |

### Package markers (not ported as modules)

| # | Python | Disposition |
|---|---|---|
| 42 | `__init__.py` (9 lines: `__version__ = "1.0.0"`, docstring) | Fold into `package.json` `"version"` (already `1.0.0`); expose as `export const VERSION` in `src/cli.ts` if needed. No standalone module. |
| 43 | `ui/__init__.py` (1 line, empty) | Not needed — TS has no package markers. `src/ui/` is just a directory. |

---

## 2. Cross-module contracts

These are the seams parallel porters must agree on BEFORE touching logic.
`src/shared.ts` already encodes the type-level half of §2.1/§2.2/§2.5.

### 2.1 The agent event stream (agent → ui/app, team, hunt)

`Agent.runTurn()` is an **async generator of plain event objects**
(`{type: "...", ...}`); `ui/app.py:_handle_event` (line 1568) and the
hunt/team loops dispatch on `ev["type"]`. The full union (19 event types,
payload keys read from the yield sites):

```
text_delta          {text}                       reasoning_delta    {text}
thinking            {iteration}                  tool_call          {name, args, id, preview: Preview|null, gated: boolean}
tool_result         {name, id, output, isError, meta}               blocked            {name, id, reason}
retry               {reason, attempt, max, delay} usage             {input, output, cost}
truncated           {max_tokens}                 reasoning_exhausted{max_tokens, retry_tokens: number|null}
nudged              {label, attempt}             deliverable        {label, path, ok}   (confirm keys at agent.ts port)
continuing          {rounds, limit, continued}   iteration_cap      {rounds, limit, hard}
compacting          {used, window, trigger: "threshold"|"overflow"}
compacted           {ok, note, used, window}     error              {message}
turn_end            {input, output, cost, rounds}                   (confirm keys at agent.ts port)
```

TS contract: `AgentEvent` discriminated union in `src/shared.ts`. The
`tool_result` / `turn_end` / `deliverable` payload keys are marked from skim
level — the porter of `agent.ts` owns confirming them and updating `shared.ts`
in the same PR.

### 2.2 The tool execution contract (agent → tools)

- `tools.execute(name, args, cfg)` → `Promise<ToolResult>` (`{output, isError, meta}`). Never throws for tool-level failures — errors ride `isError` + `meta` (bash exit code lives in `meta`).
- Permission gate: `tools.GATED_TOOLS` ∩ mode policy → `agent` calls `buildPreview` then awaits the injected `PermissionHandler` (`"yes" | "no" | "always"`, `"always"` feeds `_always_allowed`).
- `tools` calls: `sandbox.resolveInJail/containedInJail/safeGlobPattern/displayPath` (every path arg), `websearch.search/fetch` (search_web/web_fetch tools), lazy `scope` re-checks, lazy `ldxhub` (all seven ldxhub_* tools), lazy `panes` (agent_peers/agent_send/agent_inbox).
- `agent` calls `tools.TOOL_SCHEMAS/PEER_SCHEMAS` + the four name-sets to compute `toolSchemas()`, and `ldxhub.hasKey()` (lazy) to withhold ldxhub tools entirely when no key exists.

### 2.3 How ui/app consumes the agent (the render loop)

1. `AndyApp` constructs one `Agent` with `permissionHandler = self.request_permission` (a modal: PermissionModal) — TS: `AndyApp` passes a callback that sets React state and resolves a promise on modal answer.
2. Turns are driven by `for await (const ev of agent.runTurn(prompt))` → `_handleEvent(ev)` mutating widget state (StatusBar counters, ChatPane stream buffers, LoopRail stage) — in TS, each handler dispatch is a `setState`.
3. Widgets are addressed with `query_one("#id", Type)` + reactive attribute writes (`bar.iterations = n`) — TS: lift to props/context; no query_one equivalent exists (see §3).
4. Special consumers: `ui/web.py` (WaveWeb) re-renders the hunt grid from hunt events + `hunt.SEVERITY_ORDER/normaliseSeverity`; `ui/widgets.ChatPane` owns the streaming/reasoning buffer pair (`setStream`/`setReasoning`) that `text_delta`/`reasoning_delta` append to.
5. Sessions: `ui/app` calls `session.save/load/listSessions` on `/save /resume /sessions`; the payload shape is `SessionPayload` in `src/shared.ts`.

### 2.4 Config keys shared everywhere (the `Config` dataclass — port verbatim)

`baseUrl, apiKey, authToken, model, workdir, unsafe, allowPath, denyPath,
legacyScopePath, maxTokens (32768), temperature (0.0), requestTimeout (120),
contextWindow (1_000_000), compactAt (0.8), autoCompact (true),
maxIterations (40), maxRounds (400), bashTimeout (120), maxOutputChars (20000),
theme ("green"), rain (false), bootRain (true), showThinking (true),
mode ("auto"), agentsPath, stateDir (= $ANDY_HOME)`

Hidden coupling to preserve or clean up deliberately: `Agent.__init__` writes
`cfg._scope = agent.scope` and `tools._scope_of(cfg)` reads it back — tools
re-check scope from the config object. In TS: make it a real (documented) field
`cfg.scope?: Scope` or an explicit second arg; do NOT lose the re-check.

Other shared config-ish surfaces: `MODES` keys are matched against CLI
`--mode` choices and `ui/complete.MODE_NAMES`; `sources.currentKey()` +
`$ANDY_HOME/current-source` is read by `__main__`, `sources`, and every
provider's `currentKey()`; `theme.currentTheme()` + `current-theme` likewise.

### 2.5 Provider module contract (the six-source family)

Every provider exports the same catalog surface — `Model` class,
`fetchModels(...): Promise<[Model[] | null, string]>` (memoised, `CACHE_TTL`
300 s / 120 s antseed), `cachedModels/cachedIds/catalogAge/clearCache`,
`priceFor(model, models?)`, `isX(baseUrl)`, `applyTo(cfg)`,
`appliesToDefaultEndpoint(baseUrl)`, `loadCredentials/saveKey(or Pin)/hasKey`,
`looksLikeKey`, `currentKey/setCurrent`. `sources.py` aggregates them and is
each provider's lazy fallback. Port one provider first (logfare — smallest,
no credentials), extract the shared interface into `src/shared.ts`-adjacent
`provider-contract`, then the other five are mechanical.

---

## 3. Textual → Ink dependency mapping

What this codebase actually uses of Textual, and its Ink 8 / React 19 equivalent:

| Textual (Python) | Ink / React (TS) | Notes for this port |
|---|---|---|
| `App` subclass (`AndyApp(App)`) | `render(<AndyApp …/>)` + root `FC` | Single render tree; no App object — state lives in React |
| `compose() -> ComposeResult` | JSX return of the component | children replace compose |
| `on_mount()` | `useEffect(() => {...}, [])` | return cleanup fn for timers |
| `Widget` / `Static` subclass | `FC<Props>` rendering `<Box>`/`<Text>` | reactive attributes → props |
| reactive attributes (`bar.iterations = n`) | `useState` in parent, pass as props | the #1 mechanical rewrite in ui/* |
| `query_one("#id", Type)` | `useRef` + imperative handle, or lift state / React context | no DOM-style query in Ink |
| `set_interval` / `set_timeout` (Textual timers) | `useEffect` + `setInterval`/`setTimeout` + cleanup | rain, spinners, telemetry ticks |
| `ModalScreen` push/pop | overlay component rendered conditionally from a state stack | PermissionModal, CommandPalette, overlays |
| `Screen` | route = conditional render | BootScreen → main screen swap |
| `Input` + `Input.Submitted` | `TextInput` (ink 8 core) + `onSubmit` prop | PromptInput wraps it |
| `VerticalScroll` | `ScrollArea` (ink 8) or `Box` with manual scroll state | CompletionPopup, FindingsPanel |
| `RichLog` | custom component over accumulated state array | RainRichLog extends it — port as FC + buffer |
| `Rich` `Text`/`Style` | `<Text color bold …>` + chalk for computed styles | palette holds chalk-compatible color strings |
| `Rich` `Panel`/`Syntax` | `<Box borderStyle="round" …>`; syntax = highlighter lib or chalk | renderers.py's `hackerSyntax` needs a decision |
| `Markdown` widget | `markdown-it` (in deps) → structured walk → React nodes | ui/markdown already parses with markdown-it — port its token walker |
| CSS grid/dock layout | `<Box>` flexbox (`flexDirection`, `width`, `borderStyle`) | ui/web.py's absolute layout consts become Box props |
| `on_resize(event)` | `useStdout()` (`stdout.columns/rows`) or `useTerminalSize()` | WaveWeb sizing |
| `on_key(event)` / `BINDINGS` | `useInput((input, key) => …)` switch | action_* methods → handler fns |
| `on_click` / `on_mouse_move` / `MouseScroll` | ink has no mouse — DESCOPE or use raw stdout escape handling | flag: mouse interactions in WaveWeb/FindingsPanel are Textual-only; cut or re-implement behind a capability check |
| `TextSelected` event | none — clipboard is out of Ink scope | descope selection copy |
| `query_one("#input", Input).focus()` | ink `TextInput` `focus` prop / component-level input gating | manage a `focused` state |
| asyncio (`asyncio.Lock`, gather, tasks) | native `Promise` + a small mutex util | team/hunt concurrency caps → p-limit style helper (hand-rolled, no new dep unless decided) |
| `argparse` | `util.parseArgs` (stdlib) or commander (new dep) | decide at cli.ts port |
| `subprocess.Popen` (tunnels, hashcat, tmux) | `node:child_process` (`spawn`, `execFile`) | phish tunnels read stdout incrementally — keep streams |
| `urllib.request` | global `fetch` (undici) | all provider/catalog/http calls |
| `html.parser.HTMLParser` | hand-rolled regex walkers or `node-html-parser` (new dep — decide) | websearch parsers, osint_tree |
| `yaml` (PyYAML) | `yaml` (in deps) | scope files |
| `pathlib.Path` | `node:path` + `node:fs/promises`, paths as `string` | `shared.ts` helpers |
| `anthropic` SDK | `@anthropic-ai/sdk` (in deps) | keep the auth_token/api_key mutual-exclusion note from agent.py |

---

## 4. ANDY → ANDY renames (complete inventory)

Every env var, path, file, socket, alias and identity string containing
ANDY in the Python tree, with its replacement. Non-ANDY env vars stay
as-is: `ANTHROPIC_BASE_URL/API_KEY/AUTH_TOKEN/MODEL`, `LDXHUB_API_KEY`,
`ANTSEED_DATA_DIR`, `PAGEKITE_BIN/NAME`, `TMUX`, `TMUX_PANE`, `TERM`, `PATH`.

### Environment variables

| Python env var | TS env var | Used in (→ target file) |
|---|---|---|
| `ANDY_HOME` | `ANDY_HOME` | config, theme, sources, ldxhub, tokenharbour, openrouter, aihubmix, antseed, unorouter, zai, opencode, phish (×2), `__main__` |
| `ANDY_ROOT` | `ANDY_ROOT` | `__main__._launcher_path` (checkout root for `packaging/andy` launcher) |
| `ANDY_MODEL` | `ANDY_MODEL` | `config.Config.fromEnv` (model override, checked before `ANTHROPIC_MODEL`) |
| `ANDY_CLAUDE_SOURCE` | `ANDY_CLAUDE_SOURCE` | credential fallback in tokenharbour, openrouter, aihubmix, unorouter, zai (defaults to `~/claude-source`) |
| `ANDY_SEARCH_BACKENDS` | `ANDY_SEARCH_BACKENDS` | websearch `_backend_order()` (comma list reordering the engine fallback) |
| `ANDY_PANE_SESSION` | `ANDY_PANE_SESSION` | panes (`ENV_SESSION`), read in `__main__` (nested-tmux detection) |
| `ANDY_NO_UPDATE` | `ANDY_NO_UPDATE` | `__main__` (skip launch-time update check) |
| `ANDY_UPDATED` | `ANDY_UPDATED` | `__main__` (one-shot "updated" notice between runs) |
| `ANDY_NO_PROXY` | `ANDY_NO_PROXY` | ui/app (line 2415 — bypass proxy env scrubbing) |
| `ANDY_BIN_DIR` | `ANDY_BIN_DIR` | opencode `install_alias` (where the `opencode-andy` shim is installed) |

### Filesystem paths

| Python path | TS path |
|---|---|
| `~/.andy` (default home) | `~/.andy` |
| `~/.andy/AGENTS.md` | `~/.andy/AGENTS.md` (doctrine for andy mode — findAgentsFile step 3) |
| `~/.andy/current-theme` | `~/.andy/current-theme` |
| `~/.andy/current-source` | `~/.andy/current-source` |
| `~/.andy/sessions/` | `~/.andy/sessions/` |
| `~/.andy/hunts/` | `~/.andy/hunts/` (hunt case dirs, `wave-N/findings|plans`) |
| `~/.andy/{tokenharbour,openrouter,unorouter,antseed,aihubmix,ldxhub}/source` | `~/.andy/<provider>/source`; the TS-only Z.ai profile is `~/.andy/zai/source` |
| `~/.andy/opencode/` | `~/.andy/opencode/` (proxy pool state) |
| `~/.andy/panes/` (mailbox root under stateDir) | `~/.andy/panes/` |
| `<root>/packaging/andy` (launcher) | `<root>/packaging/andy` |

### Identity / config strings

| Python | TS |
|---|---|
| argparse `prog="andy"`, `--version` string | `andy` (cli.ts) |
| `Agent` identity prompt | "You are Andy…" — keep the rest verbatim (agent.ts owns final wording; it is prompt-sensitive) |
| banner wordmark "ANDY" (ui/banner FONT render) | "ANDY" |
| `AndyApp` class | `AndyApp` |
| tmux `TMUX_SOCKET = "andy"`, `TMUX_SESSION = "andy"` (panes) | `"andy"` / `"andy"` |
| opencode `ALIAS = "opencode-andy"` | `"opencode-andy"` |
| full-auto mode name | `"andy"` (MODES key, `--mode andy`, `/mode andy`) |
| dotdir prose in help strings (`~/.andy`) | `~/.andy` |

---

## 5. Port order (dependency tiers)

Parallel lanes should take modules top-tier-first; a module may start once its
imports are merged. "lazy" imports still block correctness — treat a lazy
import as a soft edge (can be stubbed with a dynamic `import()` + interface).

**Tier 0 — leaves (no andy imports; fully parallel, 16 modules):**
`config`, `session`, `sandbox`, `websearch`, `scope`, `termbg`, `termcolors`,
`crack`, `phish`, `osint`, `ldxhub`, `logfare`, `opencode`, `update`, `panes`,
plus `shared.ts` (already written, extend only via the contracts above).

**Tier 1 — single internal hop:** `theme` (termbg/termcolors, lazy),
`scope-validator` (scope), `osint-tree` (osint).

**Tier 2 — the provider family (circular, lazy):** `sources` ⇄
{`tokenharbour`, `openrouter`, `aihubmix`, `unorouter`, `antseed`} — port
`logfare` first (leaf), extract the provider contract, then all six in
parallel; `sources` last within the family. Also Tier 2: `tools` (sandbox,
websearch + lazy scope/ldxhub/panes).

`zai.ts` is a post-port source and has no Python row; keep its `sources` import
static and its back-reference dynamic, exactly like the other hosted providers.

**Tier 3:** `agent` (config, tools, scope + lazy ldxhub/sources) — the
contract heart; its porter finalises `AgentEvent` in shared.ts.

**Tier 4:** `team` (agent, config, tools).

**Tier 5:** `hunt` (team, agent, config).

**Tier 6:** `ad` (hunt).

**UI track (starts any time after Tier 1 theme; app needs Tier 6):**
`rain`, `banner`, `markdown`, `rails`, `renderers`, `palette-cmd` (theme only)
→ `boot` (banner, rain), `widgets` (theme, rain + lazy renderers/markdown) →
`complete` (osint, theme), `web` (hunt, theme) → **`app`** (everything; the
integration lane — expect it to be the long pole).

**Entry last:** `cli.ts` wiring (`__main__` surface) once `app` renders.

Suggested lane split for parallel porters (5 lanes):
A: config+session+sandbox+scope(+validator) · B: websearch+ldxhub+provider
family+sources · C: agent→team→hunt→ad · D: crack+phish+osint(+tree)+opencode+
update+panes · E: theme/termbg/termcolors→all ui/*→app. C is the critical
path; E is the largest by volume (ui/app.py alone is 6,268 lines).

## Verification of coverage

At cutover (against tag `pre-andy-port`):
`git ls-tree -r --name-only pre-andy-port -- andy/ | wc -l` = **43
files**; minus `andy/__init__.py` and `andy/ui/__init__.py`
(rows 42–43, folded, not ported as modules) = **41 modules**, all present as
rows 1–41 above. Every file on disk is accounted for exactly once.
