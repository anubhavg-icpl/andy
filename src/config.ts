/**
 * config.ts — runtime configuration, model registry and pricing.
 * (port of andy/config.py)
 *
 * What this module is: the Config dataclass every other module reads, plus
 * the model registry (KNOWN_MODELS / PRICING) and the permission-mode table
 * (MODES) that defines what each mode auto-approves and denies.
 *
 * Invariants:
 *  - `apiKey`/`authToken` are plain strings with '' as "unset" (not null):
 *    the provider family's landed GatewayConfig contract types them as
 *    string, and every falsy check behaves identically (the Anthropic client
 *    is built with `authToken || apiKey || undefined`).
 *  - `cfg.scope` is the documented home of the hidden Python coupling
 *    (`Agent.__init__` wrote `cfg._scope`; `tools._scope_of(cfg)` read it
 *    back) — made a real field here so the tools-side scope re-check cannot
 *    be lost in the port. agent.ts writes it; tools.ts reads it.
 *  - priceFor checks the free suffix FIRST — load-bearing, see its doc.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { expandTilde } from './shared.js';
import type { Scope } from './scope.js';
import { DEFAULT_THEME } from './theme.js';

// === SECTION === model registry ===
//
// The harness talks the Anthropic Messages protocol to whatever endpoint
// ANTHROPIC_BASE_URL points at. By default that is the local LiteLLM proxy
// (:4001) fronting Logfare, whose default model is deepseek-v4.1-flash.
//
// Prices are USD per million tokens and are *estimates* for CLI accounting —
// they are not billing-accurate. Unknown models fall back to DEFAULT_PRICE.

export const DEFAULT_BASE_URL = 'http://localhost:4001';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';

// The harness dotdir. setup.sh installs the proxy files, the doctrine file
// and the session state here; ANDY_HOME moves the whole lot.
// (Read at module load, like the Python original — callers that need a
// call-time read use shared.andyHome().)
export const DEFAULT_HOME: string =
  process.env['ANDY_HOME'] || path.join(homedir(), '.andy');

/**
 * Locate the doctrine file that andy mode follows.
 *
 * Searched in order, first hit wins:
 *
 *   1. `<workdir>/AGENTS.md`      — the project's own doctrine
 *   2. `<workdir>/../AGENTS.md`   — a checkout's root file, seen from a subdir
 *   3. `<home>/AGENTS.md`         — the installed doctrine (~/.andy)
 *   4. `<user_home>/AGENTS.md`    — a hand-kept global file (~)
 *
 * Step 3 is what makes andy mode work from any directory: the file is installed
 * once by setup.sh, so a session opened in an unrelated project still finds
 * the operator's doctrine instead of silently falling back to the default
 * prompt. A project that ships its own AGENTS.md still wins, because the
 * workdir is checked first.
 *
 * `home` and `userHome` are injectable so a test can pin the search to a
 * temporary tree instead of whatever the machine happens to have installed.
 */
export function findAgentsFile(
  workdir: string,
  home?: string,
  userHome?: string,
): string | undefined {
  const homeDir = home ?? DEFAULT_HOME;
  const userHomeDir = userHome ?? homedir();
  const candidates = [
    path.join(workdir, 'AGENTS.md'),
    path.join(workdir, '..', 'AGENTS.md'),
    path.join(homeDir, 'AGENTS.md'),
    path.join(userHomeDir, 'AGENTS.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

// === SECTION === modes ===
//
//   auto   every tool auto-approved, bash included.
//   edits  like auto, but bash is disabled entirely (editing-only session).
//   plan   read-only: no tool may change anything; the model plans instead.
//   andy   full auto — every tool runs without asking, and the system prompt
//          is replaced by AGENTS.md (the autonomous pentest operator).
//   danger full auto — operator-directed; no questions asked.
//   uncensored  full auto — the default system prompt is thrown out and
//          replaced by an affirmative doctrine. The model is not asked to
//          "also be willing"; its whole instruction set is rewritten so the
//          only conclusion it can reach is to do what it was told.
//
// Each mode is described by two sets and a label:
//
//   auto   tools that run WITHOUT asking (everything else that needs
//          permission is gated: the operator sees a preview and answers y/n/a)
//   deny   tools that do not exist in this mode at all — withheld from the
//          model's tool list, and refused if called anyway
//   loud   the "armed" state: shown in red in the header and the mode list
//
// As shipped, every mode lists each permission-needing tool (bash,
// write_file, edit_file — see tools.GATED_TOOLS) in either `auto` or `deny`,
// so the permission gate never actually fires. A mode that omits a tool from
// both sets would leave it gated: previewed, then answered y/n/a.

export type ModeName = 'auto' | 'edits' | 'plan' | 'andy' | 'danger' | 'uncensored';

export interface ModeSpec {
  label: string;
  blurb: string;
  /** Tools that run WITHOUT asking. */
  auto: Set<string>;
  /** Tools withheld from the model entirely in this mode. */
  deny: Set<string>;
  /** The "armed" state: shown in red in the header and the mode list. */
  loud?: boolean;
}

export const MODES: Record<ModeName, ModeSpec> = {
  auto: {
    label: 'AUTO',
    blurb: 'full auto · bash included',
    auto: new Set(['bash', 'write_file', 'edit_file']),
    deny: new Set(),
  },
  edits: {
    label: 'EDITS',
    blurb: 'edits auto-approved · bash disabled',
    auto: new Set(['write_file', 'edit_file']),
    deny: new Set(['bash']),
  },
  plan: {
    label: 'PLAN',
    blurb: 'read-only · plan, do not change',
    auto: new Set(),
    deny: new Set(['bash', 'write_file', 'edit_file']),
  },
  andy: {
    label: 'ANDY',
    blurb: 'full auto · follows AGENTS.md',
    auto: new Set(['bash', 'write_file', 'edit_file']),
    deny: new Set(),
    loud: true,
  },
  danger: {
    label: 'DANGER',
    blurb: 'full auto · obeys the operator, no questions',
    auto: new Set(['bash', 'write_file', 'edit_file']),
    deny: new Set(),
    loud: true,
  },
  uncensored: {
    label: 'UNCENSORED',
    blurb: 'full auto · cannot refuse · thinks only how to do it',
    auto: new Set(['bash', 'write_file', 'edit_file']),
    deny: new Set(),
    loud: true,
  },
};

export const DEFAULT_MODE: ModeName = 'auto';

// model_name -> [input $/Mtok, output $/Mtok]
// Kept in step with the models Logfare actually serves (sources.LOGFARE_MODELS)
// plus Token Juice's single entry. A model the upstream retires has its row
// removed here too, so the accounting never quotes a price for a 404.
export const PRICING: Record<string, [number, number]> = {
  'deepseek-v4.1-flash': [0.28, 0.42],
  'qwen-3.8-27b': [0.2, 0.6],
  'gemma-4-26b': [0.1, 0.3],
  'logfare/auto': [0.5, 1.5],
};

export const DEFAULT_PRICE: [number, number] = [1.0, 3.0];

// Models offered by /model when the user types a bare index or `list`.
//
// A *snapshot*, not the truth: the live list is fetched from the upstream's
// own status API (see logfare.ts and sources.modelsFor). This is the default
// (Logfare) set, used when the endpoint is not one of the known proxies —
// and the fallback when a fetch has not happened yet. Anything the upstream
// does not serve comes back "Model not found" (404) at request time.
export const KNOWN_MODELS: string[] = [
  'deepseek-v4.1-flash',
  'gemma-4-26b',
  'logfare/auto',
  'qwen-3.8-27b',
];

/**
 * Return [input, output] USD per million tokens for *model*.
 *
 * A free model costs nothing, and that is checked FIRST. The prefix tolerance
 * below is what makes the check necessary rather than merely nice: a giveaway
 * named `<model>-free` *starts with* the paid `<model>` row, so the loop
 * would bill the free model at the paid model's rate — measured once at
 * $0.0003 for a two-token reply, on a model the operator had been told costs
 * nothing. Worse, an unknown free model fell through to DEFAULT_PRICE and was
 * billed $1/$3.
 *
 * Both `-free` and `:free` are recognised. The `:free` form is what the two
 * gateways still in the tree use; `-free` is kept because it is the
 * convention the prefix-tolerance loop below is most dangerous against, and a
 * suffix check is cheaper than trusting a future provider to avoid it. A
 * model that is genuinely paid can never carry either, so this cannot
 * mis-price a real charge.
 */
export function priceFor(model: string): [number, number] {
  const base = model.split('/').pop()!;
  if (base.endsWith('-free') || base.endsWith(':free')) {
    return [0.0, 0.0];
  }
  if (model in PRICING) {
    return PRICING[model]!;
  }
  // Tolerate dated suffixes / provider prefixes.
  for (const [name, price] of Object.entries(PRICING)) {
    if (base === name || base.startsWith(name) || name.startsWith(base)) {
      return price;
    }
  }
  return DEFAULT_PRICE;
}

// === SECTION === Config ===

/**
 * Everything the harness needs to run a session.
 *
 * Field set ported verbatim from the Python dataclass (PORT-MAP §2.4); the
 * block comments there explain the WHY of the non-obvious values and travel
 * with them.
 */
export class Config {
  baseUrl: string = DEFAULT_BASE_URL;
  // '' means "unset" rather than null: the provider family's shared
  // GatewayConfig contract (landed in tokenharbour.ts and copied by the other
  // gateways) types these as plain strings and its applyTo() writes '' into
  // apiKey when switching — every falsy check behaves identically either way.
  apiKey: string = '';
  authToken: string = '';
  model: string = DEFAULT_MODEL;
  workdir: string = process.cwd();
  unsafe: boolean = false;
  // Target scope. `allowPath` is the operator's declared, authorised targets
  // and its PRESENCE arms the session (tools run unattended); `denyPath` is
  // the never-touch list. See scope.ts.
  allowPath: string | null = null;
  denyPath: string | null = null;
  /**
   * A leftover scope.yaml, detected but deliberately NOT read — the old file
   * was an allow-list that also blocked, so reading it as a deny-list would
   * block the very hosts it declared. Kept only so the UI can say so.
   */
  legacyScopePath: string | null = null;
  /**
   * Output ceiling per request. Was 8192, which is too close to the size of a
   * real osint report to be safe: the two archived reports on this box are
   * 4880 and 6169 tokens, so a report that grows at all — one more breach
   * section, a longer coverage table — is cut off mid-write. The SDK then
   * discards the truncated tool call, and the turn ends looking exactly like
   * one where the model narrated instead of writing. 32768 leaves room, and
   * is inside every model observed (the largest ceiling measured was 64000;
   * the limit is model-dependent, so this is the value that is safe
   * everywhere).
   */
  maxTokens: number = 32768;
  temperature: number = 0.0;
  /**
   * Max seconds to wait on the API between reads. Without this the SDK
   * default is 600s, so a proxy that accepts the connection and then goes
   * quiet hangs the turn — with no output and no error — for ten minutes.
   * Applied as the per-read timeout, so it bounds the gap between streamed
   * chunks, not the length of a healthy reply.
   */
  requestTimeout: number = 120.0;
  /**
   * Context window of the active model, in tokens. This is the FALLBACK used
   * when the live catalog does not say — `sources.contextWindowFor` asks the
   * active source's own catalog first, and every remote source parses a real
   * per-model figure (UnoRouter's `metadata.contextWindow`, OpenRouter's and
   * TokenHarbour's `context_length`, AntSeed's caps). The fallback is 1M
   * because the models this harness actually lands on are the long-context
   * ones: a free tier that offers 1M and a harness that assumed 128k would
   * compact away history it did not need to lose.
   *
   * It IS enforced now — see `compactAt` below. It used to be gauge-only,
   * which is why "raise the limit to 1M" did nothing on its own.
   */
  contextWindow: number = 1_000_000;
  /**
   * Fraction of `contextWindow` at which history is compacted automatically.
   * Checked before each request against the *previous* call's real
   * `input_tokens`, so the trigger is a measured prompt size rather than an
   * estimate. 0.8 leaves a fifth of the window for the reply, the tool
   * results it will ask for, and the growth between the check and the next
   * call.
   *
   * Not 1.0: the failure mode at 1.0 is the one this exists to prevent — the
   * request that finally overflows is the one that was already too big, and
   * it fails after spending the tokens.
   */
  compactAt: number = 0.8;
  /**
   * Whether to compact automatically at `compactAt`. On by default: the whole
   * point is that a long task should not need the operator to notice.
   */
  autoCompact: boolean = true;
  /**
   * Tool rounds in one turn before the loop pauses to reconsider. This is the
   * cap that ended long turns silently, so it is deliberately high: it exists
   * to stop a runaway loop, not to bound honest work. A turn that keeps
   * making progress past it CONTINUES automatically (see `maxRounds`); only a
   * turn that stops making progress ends there, and it now says so.
   */
  maxIterations: number = 40;
  /**
   * Hard ceiling on tool rounds in a single turn, auto-continues included.
   * The backstop for a genuinely runaway loop — a model that keeps calling a
   * tool forever without advancing. 400 rounds is far past any honest task
   * and still finite, so a pathological turn ends in minutes rather than
   * never.
   */
  maxRounds: number = 400;
  bashTimeout: number = 120;
  maxOutputChars: number = 20_000;
  theme: string = DEFAULT_THEME;
  /**
   * Rain is decorative. By default the boot screen shows it (nothing to read
   * there yet) and the shell does not, so the transcript stays legible.
   * `/rain` or `--rain` turns it on in the shell; `--no-rain` turns it off
   * everywhere, including the boot screen.
   */
  rain: boolean = false;
  bootRain: boolean = true;
  /**
   * Show the model's own reasoning when the endpoint forwards it, which only
   * some do — an Anthropic-native endpoint sends `thinking` blocks, while
   * LiteLLM's Anthropic bridge drops reasoning entirely. On by default
   * because it costs nothing where it is absent, and where it is present it
   * is the difference between watching the model work and watching a blank
   * line. `/think` toggles it; `--no-think` turns it off at launch.
   */
  showThinking: boolean = true;
  mode: string = DEFAULT_MODE;
  /**
   * Optional path to a doctrine file; only consulted in andy mode. Resolved at
   * launch by findAgentsFile, and re-resolved on /mode andy so a session that
   * started elsewhere still picks the file up.
   */
  agentsPath: string | null = null;
  stateDir: string = DEFAULT_HOME;

  /**
   * The live Scope instance once the session has one. Python hid this as
   * `cfg._scope` (Agent.__init__ wrote it, tools._scope_of(cfg) read it back
   * so tools re-check scope from the config object) — a real, documented
   * field here so the re-check cannot be lost in the port.
   */
  scope?: Scope;

  /** Whether any credential is present (either token flavor counts). */
  get apiKeyPresent(): boolean {
    return Boolean(this.authToken || this.apiKey);
  }

  /**
   * Build a config from the environment, with explicit overrides winning.
   *
   * Only non-undefined overrides are applied, so a caller can pass
   * `autoCompact: false` explicitly (turning the feature OFF is the flag's
   * entire job) while omitting values it wants left at the env-derived
   * default — the exact semantics the Python `or None` dance produced.
   */
  static fromEnv(overrides?: Partial<Config>): Config {
    const cfg = new Config();
    cfg.baseUrl = (process.env['ANTHROPIC_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    cfg.apiKey = process.env['ANTHROPIC_API_KEY'] || '';
    cfg.authToken = process.env['ANTHROPIC_AUTH_TOKEN'] || '';
    cfg.model =
      process.env['ANDY_MODEL'] || process.env['ANTHROPIC_MODEL'] || DEFAULT_MODEL;

    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) {
          (cfg as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
    cfg.workdir = path.resolve(expandTilde(cfg.workdir));
    return cfg;
  }

  /** Endpoint suitable for display; never includes credentials. */
  redactedEndpoint(): string {
    return this.baseUrl;
  }
}
