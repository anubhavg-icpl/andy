/**
 * opencode.ts — run the `opencode` CLI behind a rotating, per-process IP
 * (port of zimzilla/opencode.py).
 *
 * What this module is: a pool of ordinary HTTP proxies, validated in two
 * stages, that each `opencode` launch rotates through — plus the
 * `opencode-andy` shell alias that calls back into this module.
 *
 * Invariants (measured — see the long notes below and in the Python original):
 *  - Nothing global is touched: the proxy reaches only the child, via
 *    HTTPS_PROXY/HTTP_PROXY in its environment (with NO_PROXY for localhost —
 *    opencode's own local server must not be routed through the proxy).
 *  - `provenAt` (does it work) and `usedAt` (was it handed out) are tracked
 *    separately and persisted, so consecutive launches differ AND work.
 *  - JSON state keys stay snake_case (`proven_at`, `used_at`, …) — pool.json is
 *    a persisted format shared with the Python original.
 *  - Multi-arg options replace Python keyword args (opts objects); bare Python
 *    `None` returns become `undefined` (tuples keep `null`, as in ldxhub.ts).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { type ClientRequest } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { andyHome, expandTilde } from './shared.js';

// The module docstring of the Python original, kept because every paragraph is
// a measured constraint the code below depends on:
//
// `opencode` ships a set of models it serves itself, and the free ones need no
// account, no key and no signup — verified by *deleting the credential and
// keeping the config*: copy ~/.local/share/opencode and ~/.config/opencode to
// a temp HOME, remove auth.json, and `opencode run -m
// opencode/deepseek-v4.1-flash-free` still answers. So the whole feature is
// reachable with nothing but the binary.
//
// (An empty $HOME does NOT prove this, though it looks like it should. A fresh
// home has no config and no model cache, so opencode fails there for reasons
// that have nothing to do with credentials — and a refusal is not a "no
// credential needed" signal. Delete the credential, keep the config. A machine
// that has an auth.json is also not evidence against keyless operation: the
// key is simply unused for these model ids.)
//
// The catch is that opencode's free tier REFUSES Tor exit IPs — a request
// through Tor comes back "OpenCode's free tier can only be used from within
// OpenCode", while the identical request through a proxy that exits from an
// ordinary address succeeds. The block is against Tor specifically, not
// against proxying and not against datacenter ranges: Tor publishes its exit
// list, so anyone can refuse it in one line. That is why a commercial VPN
// (Proton, say) works where Tor does not, and it is what makes free proxies
// usable here at all. So rotation is done with a pool of ordinary HTTP
// proxies rather than Tor.
//
// Why HTTP proxies and not SOCKS: opencode's fetch layer accepts an http://
// proxy URL and rejects socks5:// outright ("UnsupportedProxyProtocol"). A
// SOCKS-only route therefore needs a bridge process. Free proxy lists are
// overwhelmingly plain HTTP already, so no bridge is needed for the pool —
// the Tor path, which IS SOCKS-only, is deliberately not used.
//
// Rotation: every launch takes a proxy that has completed a turn and marks it
// used, so consecutive runs leave from different addresses AND each of them
// works. Those two goals contradict each other, which is the trap here: a
// pool built by turn-validation has every entry proven, so "prefer a proven
// proxy" hands back the same address on every launch. Hence provenAt vs
// usedAt, each launch taking a proven proxy not yet used; only once those run
// out does the plain cursor take over, so a small pool degrades into reuse
// rather than failure. Both markers persist, so a restart does not reset
// rotation. A refusal retires a proxy (newer evidence than the proof — free
// proxies die without warning; recovery clears it).
//
// Validation is two stages, and the second is the one that matters. An ipify
// fetch through a candidate proves it carries traffic; it says nothing about
// whether opencode will accept the exit IP. Measured on this pool, those two
// are close to independent: validated on liveness alone a pool ran ~12%
// usable, while the same pool re-validated with real turns ran 79%. So the
// survivors of the cheap stage get a real one-shot turn, in parallel, and only
// the ones that answer are kept — stamped with provenAt at the moment they
// pass. The gate has no pattern worth predicting (residential and datacenter
// addresses scored identically), so the only check that predicts a working
// launch is a launch. Working proxies are not volatile (re-tested hours later,
// four of five still answered), so a validated pool is worth caching to disk,
// refreshed when it runs dry or ages out, with known-good entries carried
// across a rebuild.
//
// Nothing here writes a credential: these proxies take no authentication, and
// the free model ids need no credential either (see the note above).

// === SECTION === constants ===

/** The binary opencode installs. Also the name the operator types. */
export const BINARY = 'opencode';

/** The alias this module installs, so opencode can be launched behind a fresh
 * proxy from a plain shell as well as from inside Andy. */
export const ALIAS = 'opencode-andy';

/**
 * Default model. One of opencode's own free models — no key, no account. Kept
 * as a single id rather than a list because the free set rotates: opencode
 * retires and adds these over time, and a stale id fails loudly with "Model is
 * unavailable" rather than silently costing money, which is the failure we
 * want. `/zim-opencode --model <id>` overrides it; `opencode models` lists.
 */
export const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free';

/** Public lists of plain-HTTP proxies. Only HTTP: see the module notes above. */
export const PROXY_SOURCES: readonly string[] = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=yes&anonymity=all',
];

/**
 * How many candidates to probe per validation pass, and how many live proxies
 * a full pool wants. Probing is the slow part, so the pool is built to last
 * several launches rather than exactly one.
 */
export const PROBE_LIMIT = 600;
export const POOL_TARGET = 24;
export const PROBE_WORKERS = 96;

/** A proxy that cannot complete an HTTPS fetch in this many seconds is dropped.
 * Generous, because a slow proxy still works and the pool is chosen from. */
export const PROBE_TIMEOUT = 7.0;

/**
 * The second, decisive stage: how many of the ipify-live proxies get a real
 * opencode turn, how many run at once, and how long each is given.
 *
 * This stage is why the pool is worth anything — measured, ipify-liveness
 * alone ran ~12% usable while turn-validation ran 79% (see module notes). It
 * is affordable because it is parallel and the yield is high: 24 candidates at
 * 12 workers is ~90s to fill a pool that then works on the first try, against
 * ~25s to build one that mostly fails.
 */
export const TURN_LIMIT = 48;
export const TURN_WORKERS = 12;
export const TURN_TIMEOUT = 60.0;

/** Working proxies are NOT volatile — re-tested hours later, 4 of 5 still
 * answered — so a validated pool is worth keeping, and a proxy that worked
 * once is worth trying first next time. This is how long that is trusted. */
export const KNOWN_GOOD_AGE = 24 * 3600;

/** The pool is re-validated when it is older than this. Free proxies die
 * within hours, so a day-old pool is mostly dead entries. */
export const POOL_MAX_AGE = 6 * 3600;

/** A model reply can legitimately take a while; this bounds the whole run. */
export const RUN_TIMEOUT = 600;

/** Wall clock in seconds — replaces Python's `time.time()`. */
function epochNow(): number {
  return Date.now() / 1000;
}

/** Monotonic clock in seconds — replaces Python's `time.monotonic()`. */
function monotonic(): number {
  return performance.now() / 1000;
}

// === SECTION === state directory & binary discovery ===

/** Directory holding the pool, the cache and the shim: `$ANDY_HOME/opencode`. */
export function stateDir(): string {
  const d = path.join(andyHome(), 'opencode');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function poolFile(): string {
  return path.join(stateDir(), 'pool.json');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** shutil.which, POSIX flavour: first executable file named `bin` on PATH. */
function which(bin: string): string | undefined {
  const searchPath = process.env.PATH ?? '';
  if (!searchPath) return undefined;
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.resolve(dir, bin);
    if (isFile(candidate) && isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Path to the opencode binary, or undefined when it is not installed.
 *
 * A PATH lookup covers a normal install. The mise/npm layouts put the binary
 * under the user's own data dir and only expose it through a shim, so a
 * session that inherited a different PATH — which is exactly what happens when
 * Andy is launched from a desktop entry — would otherwise report "not found"
 * for a binary that is plainly installed.
 */
export function findBinary(): string | undefined {
  const found = which(BINARY);
  if (found) return found;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.opencode', 'bin', BINARY),
    path.join(home, '.local', 'bin', BINARY),
    path.join(home, '.local', 'share', 'mise', 'installs', 'opencode', 'latest', BINARY),
  ];
  // mise keeps one directory per version; newest first is close enough, and a
  // wrong pick still runs — it is simply an older build.
  const mise = path.join(home, '.local', 'share', 'mise', 'installs', 'opencode');
  try {
    if (fs.statSync(mise).isDirectory()) {
      for (const version of fs.readdirSync(mise).sort().reverse()) {
        candidates.push(path.join(mise, version, BINARY));
      }
    }
  } catch {
    // no mise dir (or unreadable) — fall through to the fixed candidates
  }
  for (const c of candidates) {
    if (isFile(c) && isExecutable(c)) return c;
  }
  return undefined;
}

export function isInstalled(): boolean {
  return findBinary() !== undefined;
}

// === SECTION === the proxy pool ===

/** One candidate HTTP proxy. */
export class Proxy {
  constructor(
    public host: string,
    public port: number,
    /** Measured seconds to complete one HTTPS fetch through it, when known. */
    public latency: number | null = null,
    /**
     * When this proxy last completed a real opencode turn, if it ever has.
     * This is the only field that predicts anything: `latency` says the proxy
     * carries traffic, which is nearly unrelated to whether opencode accepts
     * its exit IP. A proxy with a provenAt is worth trying before one
     * without, whatever their latencies say.
     */
    public provenAt: number = 0.0,
    /**
     * When this proxy was last handed to a launch. Distinct from provenAt,
     * which records whether it *works*. Rotation needs to know what the
     * operator has already been given: a pool where every entry is proven
     * would otherwise hand out its best proxy every single time, which is the
     * one thing the command must not do.
     */
    public usedAt: number = 0.0,
    /**
     * When this proxy last failed a turn, if it has failed since it last
     * worked. A failure is *newer evidence* than a proof, so it invalidates
     * one: free proxies die without warning, and a proxy still trusted on the
     * strength of yesterday's success would be tried first on every launch
     * and cost a ~40s timeout each time before the pool moved on.
     */
    public failedAt: number = 0.0,
  ) {}

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  get key(): string {
    return `${this.host}:${this.port}`;
  }

  /**
   * True if this proxy completed a turn recently enough to trust.
   *
   * A failure after the proof cancels it. Without that, a proxy that worked
   * yesterday and died overnight keeps its place at the head of the queue and
   * is retried — and timed out — on every single launch.
   */
  isProven(now?: number): boolean {
    if (!this.provenAt) return false;
    if (this.failedAt > this.provenAt) return false;
    const t = now ?? epochNow();
    return t - this.provenAt < KNOWN_GOOD_AGE;
  }

  /** snake_case keys: pool.json is a persisted format shared with Python. */
  toJson(): Record<string, unknown> {
    return {
      host: this.host,
      port: this.port,
      latency: this.latency,
      proven_at: this.provenAt,
      used_at: this.usedAt,
      failed_at: this.failedAt,
    };
  }

  static fromJson(d: Record<string, unknown>): Proxy {
    // Python's d["host"] raised KeyError and int(d["port"]) raised
    // ValueError/TypeError on a corrupt row — loadPool's catch turned that into
    // an empty Pool. Validate the same way instead of synthesising a
    // `http://undefined:NaN` proxy from garbage.
    const host = d['host'];
    const rawPort = d['port'];
    const port = Number(rawPort);
    if (typeof host !== 'string' || host.length === 0) {
      throw new Error('corrupt proxy entry: missing host');
    }
    if (rawPort === null || rawPort === undefined || !Number.isFinite(port)) {
      throw new Error('corrupt proxy entry: bad port');
    }
    return new Proxy(
      host,
      port,
      (d['latency'] as number | undefined) ?? null,
      Number(d['proven_at'] ?? 0.0),
      Number(d['used_at'] ?? 0.0),
      Number(d['failed_at'] ?? 0.0),
    );
  }
}

/** The validated proxies plus the bookkeeping that makes rotation work. */
export class Pool {
  constructor(
    public proxies: Proxy[] = [],
    /**
     * Index of the next proxy to hand out. Persisted so consecutive launches
     * differ even across restarts — an in-memory counter would reset and the
     * operator would see the same IP twice in a row.
     */
    public cursor: number = 0,
    public validatedAt: number = 0.0,
  ) {}

  toJson(): Record<string, unknown> {
    return {
      proxies: this.proxies.map((p) => p.toJson()),
      cursor: this.cursor,
      validated_at: this.validatedAt,
    };
  }

  static fromJson(d: Record<string, unknown>): Pool {
    const rawProxies = Array.isArray(d['proxies']) ? d['proxies'] : [];
    return new Pool(
      rawProxies.map((p) => Proxy.fromJson(p as Record<string, unknown>)),
      Number(d['cursor'] ?? 0),
      Number(d['validated_at'] ?? 0.0),
    );
  }

  /**
   * The next proxy in rotation, advancing the cursor. Undefined if empty.
   *
   * `mark` stamps usedAt, which is what the proven-first path reads to decide
   * what has already been handed out. A dry peek at the next proxy should
   * leave it false so looking does not consume it.
   */
  nextProxy(mark = false): Proxy | undefined {
    if (this.proxies.length === 0) return undefined;
    const p = this.proxies[this.cursor % this.proxies.length];
    this.cursor = (this.cursor + 1) % this.proxies.length;
    if (mark) p.usedAt = epochNow();
    return p;
  }

  /** Proxies that have completed a turn, most recent first. */
  knownGood(): Proxy[] {
    return this.proxies.filter((p) => p.isProven()).sort((a, b) => b.provenAt - a.provenAt);
  }

  /**
   * A proven proxy the operator has not been handed yet.
   *
   * The two requirements pull against each other: the launch must work, so it
   * wants a proven proxy, and it must differ from last time, so it wants one
   * that has not been used. Proven-and-unused satisfies both. Ordering by
   * usedAt ascending makes this a rotation rather than a fixed favourite —
   * without it the same proxy would win every launch, because every entry in
   * a fresh pool is proven.
   *
   * `exclude` is a set of keys to skip, for a caller assembling several at
   * once that must not be handed the same one twice. It is a parameter rather
   * than a side effect so that merely *considering* a proxy does not consume
   * it. Undefined when every proven proxy has already been handed out; the
   * caller then falls back to the plain cursor, which is what keeps a small
   * pool cycling instead of failing.
   */
  nextUnused(exclude?: Set<string>): Proxy | undefined {
    const skip = exclude ?? new Set<string>();
    const unused = this.proxies.filter(
      (p) => p.isProven() && !p.usedAt && !skip.has(p.key),
    );
    if (unused.length === 0) return undefined;
    // min by the tuple (usedAt, -provenAt) from the Python original: least
    // recently handed out first, ties broken by most recent proof
    return unused.reduce((best, p) => {
      if (p.usedAt !== best.usedAt) return p.usedAt < best.usedAt ? p : best;
      return p.provenAt > best.provenAt ? p : best;
    });
  }

  /**
   * Record that *proxy* was handed to a launch, so it rotates out.
   *
   * Only this makes consecutive launches differ. provenAt cannot do it: it
   * answers "does this work", and in a freshly validated pool every entry
   * answers yes.
   */
  markUsed(proxy: Proxy): void {
    const now = epochNow();
    for (const p of this.proxies) {
      if (p.key === proxy.key) {
        p.usedAt = now;
        return;
      }
    }
    proxy.usedAt = now;
    this.proxies.push(proxy);
  }

  /**
   * Record that *proxy* completed a real turn, and keep it in the pool.
   *
   * Called on every success, so the pool improves the more it is used. A
   * proxy that answered once is the best evidence available that it will
   * answer again — better than any liveness measurement.
   */
  markProven(proxy: Proxy): void {
    const now = epochNow();
    for (const p of this.proxies) {
      if (p.key === proxy.key) {
        p.provenAt = now;
        p.failedAt = 0.0; // it just worked, so the last failure is moot
        return;
      }
    }
    proxy.provenAt = now;
    proxy.failedAt = 0.0;
    this.proxies.push(proxy);
  }

  /**
   * Record that *proxy* was refused, retiring it from the trusted set.
   *
   * Free proxies die without warning, so a failure is newer evidence than the
   * proof it contradicts and has to cancel it — otherwise a proxy that worked
   * yesterday and died overnight keeps being tried first, costing a ~40s
   * timeout on every launch before the pool moves on.
   */
  markFailed(proxy: Proxy): void {
    const now = epochNow();
    for (const p of this.proxies) {
      if (p.key === proxy.key) {
        p.failedAt = now;
        return;
      }
    }
    proxy.failedAt = now;
    this.proxies.push(proxy);
  }

  isFresh(now?: number): boolean {
    const t = now ?? epochNow();
    return this.proxies.length > 0 && t - this.validatedAt < POOL_MAX_AGE;
  }
}

/** Read the cached pool. A corrupt or missing file is an empty pool. */
export function loadPool(filePath?: string): Pool {
  const p = filePath ?? poolFile();
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return new Pool();
    return Pool.fromJson(d as Record<string, unknown>);
  } catch {
    return new Pool();
  }
}

/** Persist the pool. Never fatal — a read-only home must not break the run. */
export function savePool(pool: Pool, filePath?: string): void {
  const p = filePath ?? poolFile();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pool.toJson(), null, 1), 'utf-8');
  } catch {
    // read-only home &c. — rotation still works for this launch, it just
    // will not survive a restart
  }
}

// === SECTION === candidates ===

/**
 * Pull `host:port` lines out of a proxy-list body.
 *
 * Tolerant on purpose: these lists are hand-maintained and carry blank lines,
 * comments and the occasional scheme prefix. Anything that is not a clean
 * host:port pair is skipped rather than raising, because one malformed line
 * should not cost the whole list.
 */
export function parseCandidates(text: string): Proxy[] {
  const out: Proxy[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // rpartition(':') — strip an optional scheme prefix first
    const bare = line.split('://').pop()?.trim() ?? '';
    const sep = bare.lastIndexOf(':');
    if (sep === -1) continue;
    const host = bare.slice(0, sep);
    const port = bare.slice(sep + 1);
    if (!host || !/^\d+$/.test(port)) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new Proxy(host, Number(port)));
  }
  return out;
}

/** Download and merge every configured proxy list. */
export async function fetchCandidates(timeoutSec = 30.0): Promise<Proxy[]> {
  const out: Proxy[] = [];
  const seen = new Set<string>();
  for (const url of PROXY_SOURCES) {
    let body: string;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'andy' },
        signal: AbortSignal.timeout(timeoutSec * 1000),
      });
      if (!resp.ok) continue; // urlopen raised on non-2xx → source skipped
      body = await resp.text();
    } catch {
      continue;
    }
    for (const p of parseCandidates(body)) {
      const key = `${p.host}:${p.port}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

// === SECTION === proxied HTTPS (the urllib ProxyHandler replacement) ===

/**
 * One GET through an HTTP proxy, via a CONNECT tunnel — Node's fetch ignores
 * proxy env, so urllib.request.build_opener(ProxyHandler(...)) becomes this.
 * TLS verification stays on (tls.connect with default CAs + servername SNI).
 * Resolves undefined on ANY failure; callers treat failure as "not usable".
 */
function proxyGet(targetUrl: string, proxy: Proxy, timeoutSec: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const u = new URL(targetUrl);
    const targetHost = u.hostname;
    const targetPort = Number(u.port || 443);
    let settled = false;
    let raw: net.Socket | undefined;
    let req: ClientRequest | undefined;
    const timer = setTimeout(() => finish(undefined), timeoutSec * 1000);
    const finish = (v?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      raw?.destroy();
      resolve(v);
    };

    raw = net.connect({ host: proxy.host, port: proxy.port });
    raw.on('error', () => finish(undefined));
    raw.on('connect', () => {
      raw!.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });
    let head = Buffer.alloc(0);
    raw.on('data', (chunk: Buffer) => {
      if (settled) return;
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (head.length > 8192) finish(undefined); // headers ran away — dead proxy
        return;
      }
      const nl = head.indexOf('\r\n');
      const statusLine = (nl === -1 ? head : head.subarray(0, nl)).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        finish(undefined); // CONNECT refused
        return;
      }
      // Bytes past the CONNECT response would be unexpected (the proxy speaks
      // only after our TLS ClientHello), so dropping `head`'s tail is safe.
      raw!.removeAllListeners('data');
      // The canonical no-agent path: with createConnection provided and no
      // agent option, http.ClientRequest uses our socket verbatim and parses
      // the response (incl. chunked) for us.
      req = https.request(
        {
          host: targetHost,
          port: targetPort,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { Host: targetHost, 'User-Agent': 'andy' },
          createConnection: () =>
            tls.connect({ socket: raw!, servername: targetHost }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            finish(status >= 200 && status < 300 ? Buffer.concat(chunks).toString('utf-8') : undefined);
          });
          res.on('error', () => finish(undefined));
        },
      );
      req.on('error', () => finish(undefined));
    });
  });
}

/**
 * Return the proxy with its latency filled in if it actually carries traffic.
 *
 * The check is a real HTTPS fetch *through* the proxy, not a TCP connect: a
 * port that accepts a connection and then refuses to forward is the common
 * failure in these lists, and a connect-only check would keep every one of
 * them.
 */
async function probeProxy(proxy: Proxy, timeoutSec: number = PROBE_TIMEOUT): Promise<Proxy | null> {
  const started = monotonic();
  const ip = (await proxyGet('https://api.ipify.org', proxy, timeoutSec))?.trim();
  if (!ip || ip.split('.').length - 1 !== 3) return null;
  proxy.latency = Math.round((monotonic() - started) * 100) / 100;
  return proxy;
}

// === SECTION === validation ===

export type ProbeProgress = (done: number, total: number) => void;
export type TurnProgress = (done: number, total: number, verdict: LaunchVerdict) => void;

/**
 * Probe candidates concurrently and return the live ones, fastest first.
 *
 * Concurrency is what makes this bearable: a sequential pass over hundreds of
 * candidates at seven seconds each is an hour, while a pool of workers turns
 * it into well under a minute. The work is entirely blocking socket I/O, so a
 * fixed set of concurrent promises (the ThreadPoolExecutor analogue) is the
 * right tool.
 *
 * `progress` is called with `(done, total)` after each probe so a caller with
 * a UI can show movement.
 */
export async function validate(
  candidates: Proxy[],
  opts: { target?: number; limit?: number; workers?: number; progress?: ProbeProgress } = {},
): Promise<Proxy[]> {
  const target = opts.target ?? POOL_TARGET;
  const limit = opts.limit ?? PROBE_LIMIT;
  const workers = opts.workers ?? PROBE_WORKERS;
  const sample = candidates.slice(0, limit);
  if (sample.length === 0) return [];
  const live: Proxy[] = [];
  let done = 0;
  let stopped = false;
  let next = 0;
  const total = sample.length;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const i = next++;
      if (i >= total) return;
      const got = await probeProxy(sample[i]);
      if (stopped) return; // an in-flight probe, discarded on "cancel"
      done++;
      opts.progress?.(done, total);
      if (got) {
        live.push(got);
        if (live.length >= target) {
          // Enough to rotate with. Remaining probes are abandoned rather than
          // waited on — a launch must not block on candidates it will never
          // use (Python cancelled the not-yet-started futures and broke).
          stopped = true;
        }
      }
    }
  };
  const workerCount = Math.max(1, Math.min(workers, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  live.sort((a, b) => (a.latency ?? 9e9) - (b.latency ?? 9e9));
  return live;
}

/**
 * Keep the proxies that complete a real opencode turn.
 *
 * The decisive stage. An ipify fetch proves a proxy carries traffic; it says
 * nothing about whether opencode's free tier will accept the exit IP, and
 * measured, that distinction is the difference between a pool that runs ~12%
 * usable and one that runs 79%.
 *
 * Parallel because it is slow — a turn is tens of seconds — and the yield is
 * high enough that a small sample fills a pool. A "model" verdict is not this
 * proxy's fault and is reported by the caller instead of being retried here.
 *
 * Every survivor is stamped with provenAt here rather than by the caller.
 * Passing a turn is the strongest evidence available and the whole reason
 * Pool.knownGood exists, so a pool that arrives unstamped would hand the next
 * launch a set of proxies it cannot prefer — the memory would be built and
 * then immediately thrown away.
 *
 * `progress` is called with `(done, total, verdict)` after each attempt.
 */
export async function validateTurns(
  candidates: Proxy[],
  binary: string,
  opts: {
    model?: string | null;
    target?: number;
    limit?: number;
    workers?: number;
    progress?: TurnProgress;
  } = {},
): Promise<Proxy[]> {
  const target = opts.target ?? POOL_TARGET;
  const limit = opts.limit ?? TURN_LIMIT;
  const workers = opts.workers ?? TURN_WORKERS;
  const sample = candidates.slice(0, limit);
  if (sample.length === 0) return [];
  const proven: Proxy[] = [];
  let done = 0;
  let stopped = false;
  let next = 0;
  const total = sample.length;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const i = next++;
      if (i >= total) return;
      const proxy = sample[i];
      // TURN_TIMEOUT here, not probeLaunch's own 90s default — the Python
      // original passes it positionally (probe_launch(p, binary, model, TURN_TIMEOUT))
      const verdict = await probeLaunch(proxy, binary, {
        model: opts.model ?? null,
        timeout: TURN_TIMEOUT,
      });
      if (stopped) return;
      done++;
      opts.progress?.(done, total, verdict);
      if (verdict === 'ok') {
        proxy.provenAt = epochNow();
        // It just answered, so any earlier refusal is superseded. These are
        // freshly fetched candidates and normally carry no history, but a
        // proxy handed in from the old pool does.
        proxy.failedAt = 0.0;
        proven.push(proxy);
        if (proven.length >= target) {
          stopped = true;
        }
      }
    }
  };
  const workerCount = Math.max(1, Math.min(workers, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return proven;
}

/**
 * Fetch, validate and persist a fresh pool.
 *
 * Two stages, and the second is the one that matters: ipify-liveness to cut
 * thousands of candidates down cheaply, then a real opencode turn on the
 * survivors. Skipping the second stage is what made an earlier version of
 * this build pools that were mostly refused — see TURN_LIMIT.
 */
export async function buildPool(
  opts: {
    target?: number;
    progress?: ProbeProgress;
    binary?: string | null;
    model?: string | null;
    turnProgress?: TurnProgress;
  } = {},
): Promise<Pool> {
  const target = opts.target ?? POOL_TARGET;
  const candidates = await fetchCandidates();
  shuffle(candidates);
  const live = await validate(candidates, {
    target: Math.max(target * 2, target),
    progress: opts.progress,
  });
  if (live.length === 0) {
    return new Pool([], 0, epochNow());
  }

  // Without a binary there is no way to run the decisive check, so the
  // liveness result is all there is. The caller has already reported that
  // opencode is missing, so this is a degraded path, not a silent one.
  if (!opts.binary) {
    return new Pool(live.slice(0, target), 0, epochNow());
  }

  const proven = await validateTurns(live, opts.binary, {
    model: opts.model ?? null,
    target,
    progress: opts.turnProgress,
  });
  const pool = new Pool(proven, 0, epochNow());
  if (proven.length > 0) {
    savePool(pool);
  }
  return pool;
}

/** The pool to rotate from: the cache when it is fresh, else a new build. */
export async function getPool(
  opts: {
    refresh?: boolean;
    progress?: ProbeProgress;
    binary?: string | null;
    model?: string | null;
    turnProgress?: TurnProgress;
  } = {},
): Promise<Pool> {
  const pool = loadPool();
  if (!opts.refresh && pool.isFresh()) {
    return pool;
  }
  const fresh = await buildPool(opts);
  // A rebuild that found nothing must not throw away a pool that still has
  // entries — free lists have bad days, and a stale-but-live proxy beats none.
  if (fresh.proxies.length === 0 && pool.proxies.length > 0) {
    return pool;
  }
  // Carry forward what the old pool learned. A proxy that completed a turn
  // yesterday is better evidence than anything the rebuild just measured, and
  // discarding it would make every refresh start from zero knowledge.
  if (fresh.proxies.length > 0 && pool.proxies.length > 0) {
    const seen = new Set(fresh.proxies.map((p) => p.key));
    for (const p of pool.knownGood()) {
      if (!seen.has(p.key)) fresh.proxies.push(p);
    }
  }
  return fresh;
}

/**
 * Take the next proxy and advance the pool's cursor.
 *
 * Returns undefined when no proxy could be found, which the caller must treat
 * as "go direct" and say so — silently falling back to the operator's real IP
 * would defeat the entire point of the command.
 *
 * `preferProven` hands out a proxy that has completed a turn before one that
 * has only been shown to carry traffic, because the second says almost
 * nothing about whether opencode will accept it — but only while there is a
 * proven proxy left that has not already been handed out. Picking from
 * knownGood alone would return the same entry on every call once the whole
 * pool is proven, which is precisely what rotation exists to prevent.
 */
export async function rotate(
  opts: {
    refresh?: boolean;
    progress?: ProbeProgress;
    preferProven?: boolean;
    pool?: Pool | null;
  } = {},
): Promise<Proxy | undefined> {
  const pool = opts.pool ?? (await getPool({ refresh: opts.refresh, progress: opts.progress }));
  let proxy: Proxy | undefined;
  if (opts.preferProven ?? true) {
    proxy = pool.nextUnused();
  }
  if (proxy === undefined) {
    proxy = pool.nextProxy(true);
  } else {
    pool.markUsed(proxy);
  }
  if (proxy !== undefined) {
    savePool(pool); // persist the advanced cursor
  }
  return proxy;
}

// === SECTION === launching ===

/** Python random.shuffle — Fisher-Yates, in place. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function flattenEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The environment for the opencode child: proxied, with localhost bypassed.
 *
 * NO_PROXY is not optional. opencode's TUI talks to a local HTTP server of its
 * own, and with every address routed through the proxy that localhost
 * connection is sent to the proxy too, which breaks the TUI. Its own docs call
 * the bypass required.
 *
 * Both cases of each variable are set because the two spellings are read by
 * different layers — Bun's fetch reads the uppercase form, but plenty of
 * tooling under it (and npm, when opencode shells out) reads the lowercase.
 */
export function childEnv(proxy: Proxy, base?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...(base ?? flattenEnv()) };
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    env[name] = proxy.url;
  }
  for (const name of ['NO_PROXY', 'no_proxy']) {
    env[name] = 'localhost,127.0.0.1,::1';
  }
  // opencode is being driven from inside another TUI; a nested pager or a
  // colour probe would fight for the terminal it has already been given.
  if (env['TERM'] === undefined) {
    env['TERM'] = process.env.TERM ?? 'xterm-256color';
  }
  return env;
}

/**
 * The argv that runs opencode behind the proxy.
 *
 * `opencode run <prompt>` is the one-shot form; with no prompt it is the TUI,
 * which is what the slash command opens so the operator gets the full
 * interface rather than a single answer.
 */
export function buildArgv(
  binary: string,
  opts: { args?: string[] | null; model?: string | null; prompt?: string | null } = {},
): string[] {
  const argv = [binary];
  if (opts.prompt) {
    argv.push('run', '-m', opts.model || DEFAULT_MODEL, opts.prompt);
  } else {
    if (opts.model) {
      argv.push('-m', opts.model);
    }
    argv.push(...(opts.args ?? []));
  }
  return argv;
}

/**
 * Run opencode, returning its exit status.
 *
 * With no proxy the child inherits the environment untouched — that is the
 * honest fallback when rotation could not find one, and the caller is
 * expected to have said so first. A timeout kills the child and yields 124
 * (subprocess.call's TimeoutExpired → 124 in the Python original); a spawn
 * failure rejects, as the OSError propagated there.
 */
export function run(
  proxy: Proxy | null | undefined,
  binary: string,
  opts: {
    args?: string[] | null;
    model?: string | null;
    prompt?: string | null;
    timeout?: number | null;
    cwd?: string | null;
  } = {},
): Promise<number> {
  const argv = buildArgv(binary, { args: opts.args, model: opts.model, prompt: opts.prompt });
  const env = proxy ? childEnv(proxy) : undefined;
  return new Promise<number>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: env ?? process.env,
      stdio: 'inherit',
      cwd: opts.cwd ?? undefined,
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeout * 1000);
    }
    child.on('error', (err) => {
      if (timedOut) {
        resolve(124);
        return;
      }
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? 0));
    });
  });
}

/** The public IP this proxy egresses from, for display. Undefined on failure. */
export async function probeExitIp(proxy: Proxy, timeoutSec = 10.0): Promise<string | undefined> {
  const ip = (await proxyGet('https://api.ipify.org', proxy, timeoutSec))?.trim();
  return ip && ip.split('.').length - 1 === 3 ? ip : undefined;
}

// === SECTION === judging whether a launch actually worked ===
//
// A proxy that carries an ordinary HTTPS fetch is still not necessarily usable
// here, and the three ways it fails are worth telling apart because only two
// of them are worth retrying:
//
//   * opencode refuses the exit IP. Measured repeatedly: the free tier accepts
//     some addresses and rejects others, and because these free proxies rotate
//     their own exits per request, the SAME proxy can succeed and then fail
//     minutes later. Retry — the next proxy, or the next request, may pass.
//   * the proxy MITMs TLS. A free proxy presenting its own certificate breaks
//     the connection outright ("self signed certificate in certificate chain").
//     Retry.
//   * the proxy is simply dead mid-request. Retry.
//
// A model error is NOT retried: "Model is unavailable" means the id is wrong
// or retired, and trying ten more proxies would just fail ten more times
// slowly.
//
// This is why a plain "does it fetch a page" probe is not enough to pick a
// proxy. The only check that predicts a working launch is a launch.

/** Substrings marking a failure that a different exit IP could fix. */
const RETRYABLE: readonly string[] = [
  'can only be used from within opencode',
  'self signed certificate',
  'certificate chain',
  'unable to connect',
  'cannot connect to api',
  'socket connection was closed',
  'connection closed',
  'econnrefused',
  'etimedout',
  'tls',
  'ssl',
];

/** Substrings marking a failure that is about the model, not the route. */
const MODEL_ERROR: readonly string[] = [
  'model is unavailable',
  'model not found',
  'no such model',
];

export type LaunchVerdict = 'ok' | 'retry' | 'model';

/**
 * Judge an opencode transcript: "ok", "retry" or "model".
 *
 * Pure, so the suite can pin the mapping without spawning anything. The order
 * matters: a model error is checked first, because a retired model id can
 * arrive wrapped in text that also mentions a connection.
 */
export function classify(text: string): LaunchVerdict {
  const low = (text ?? '').toLowerCase();
  if (MODEL_ERROR.some((m) => low.includes(m))) return 'model';
  if (RETRYABLE.some((m) => low.includes(m))) return 'retry';
  return 'ok';
}

/** One captured subprocess attempt: exit code, combined-free output, timeout. */
interface CapturedRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * subprocess.run(capture_output=True, text=True, timeout=...) — resolves null
 * for a spawn failure (Python's OSError) instead of rejecting.
 */
function runCapture(
  argv: string[],
  env: Record<string, string>,
  timeoutSec: number,
): Promise<CapturedRun | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null); // OSError analogue
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout?.setEncoding('utf-8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf-8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null); // OSError analogue (ENOENT et al.)
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run one cheap opencode turn through *proxy* and report how it went.
 *
 * This is the pre-flight the TUI depends on. Opening the interactive TUI
 * through a proxy that is going to be refused wastes the operator's time —
 * they see the interface come up and then an error — so the route is proven
 * with a throwaway one-shot first and only a proxy that answered gets the TUI.
 *
 * Returns "ok", "retry" or "model" as classify does; timeouts and spawn
 * failures are "retry" (the Python original's except clauses).
 */
export async function probeLaunch(
  proxy: Proxy,
  binary: string,
  opts: { model?: string | null; timeout?: number } = {},
): Promise<LaunchVerdict> {
  const argv = buildArgv(binary, { model: opts.model ?? null, prompt: 'say ok' });
  const result = await runCapture(argv, childEnv(proxy), opts.timeout ?? 90.0);
  if (result === null || result.timedOut) return 'retry';
  const text = result.stdout + result.stderr;
  if (result.code === 0 && classify(text) === 'ok') return 'ok';
  return classify(text);
}

/**
 * Rotate until a proxy actually completes a turn.
 *
 * Returns `(proxy, note)`. `proxy` is null when nothing worked, and the note
 * says why so the caller can be honest about it instead of opening a TUI that
 * will fail.
 *
 * Two requirements have to hold at once, and they pull in opposite directions:
 * the launch must work, so it wants a proxy that has completed a turn, and it
 * must differ from the last launch, so it wants one that has not been handed
 * out. In a pool built by validateTurns EVERY entry is proven, so "proven"
 * alone would return the same proxy forever. The queue is therefore
 * proven-and-unused first, then proven, then whatever the cursor reaches —
 * and every attempt is stamped as used.
 *
 * On success the proxy is recorded in the pool and saved, which is what makes
 * the next launch cheaper than this one.
 */
export async function findWorkingProxy(
  binary: string,
  opts: {
    model?: string | null;
    attempts?: number;
    progress?: (attempt: number, attempts: number, proxy: Proxy) => void;
    pool?: Pool | null;
  } = {},
): Promise<[Proxy | null, string]> {
  const attempts = opts.attempts ?? 6;
  const pool = opts.pool ?? loadPool();
  // The candidates for this launch: proven proxies the operator has not been
  // handed yet, then the plain cursor once those run out. `exclude` keeps the
  // fill from returning the same proxy repeatedly — and, unlike stamping
  // usedAt as we go, it leaves a proxy that is only *considered* here still
  // available to the next launch.
  const queue: Proxy[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < attempts; i++) {
    const unused = pool.nextUnused(taken);
    if (unused === undefined) break;
    queue.push(unused);
    taken.add(unused.key);
  }
  let last = '';
  let tried = 0;
  for (let i = 0; i < attempts; i++) {
    const proxy = queue.length > 0 ? queue.shift() : pool.nextProxy(true);
    if (proxy === undefined) {
      return [null, 'no proxies in the pool'];
    }
    tried++;
    opts.progress?.(i + 1, attempts, proxy);
    const verdict = await probeLaunch(proxy, binary, { model: opts.model ?? null });
    if (verdict === 'ok') {
      // Remember it, so the next launch starts from here rather than from a
      // cold scan. This is the only place the pool learns anything.
      pool.markProven(proxy);
      pool.markUsed(proxy);
      savePool(pool);
      return [proxy, ''];
    }
    if (verdict === 'model') {
      // The route is fine; the model id is not. Another proxy will not help,
      // so stop and let the caller report it. Not a failure of this proxy,
      // so it must not be retired for it.
      return [proxy, 'model unavailable'];
    }
    // A refusal retires the proxy: it is newer evidence than whatever proof
    // put it at the front of the queue, and without recording it a dead proxy
    // would be retried, and timed out, on every future launch.
    pool.markFailed(proxy);
    pool.markUsed(proxy);
    last = verdict;
  }
  if (tried > 0) {
    savePool(pool);
  }
  return [null, `${tried} proxies tried, none worked (last: ${last})`];
}

// === SECTION === the `opencode-andy` alias ===

/**
 * Where the alias goes: the same bin dir the repo installs `andy` into
 * (`$ANDY_BIN_DIR` override, `~/.local/bin` default).
 */
export function aliasPath(): string {
  const override = process.env['ANDY_BIN_DIR'];
  if (override) {
    return path.join(expandTilde(override), ALIAS);
  }
  return path.join(os.homedir(), '.local', 'bin', ALIAS);
}

/**
 * The shim's body. It does not reimplement rotation — it calls back into this
 * module, so the shell path and the slash command cannot drift apart.
 *
 * Python exec'd `sys.executable -m zimzilla.opencode`; the TS analogue execs
 * node on THIS module's file (self-executing via the main-guard at the bottom
 * of this file). `--experimental-strip-types` is added for a .ts source path
 * (dev/tsx checkout) so the shim works before a build lays down dist JS.
 */
function shimBody(): string {
  const self = fileURLToPath(import.meta.url);
  const stripTypes = self.endsWith('.ts') ? ' --experimental-strip-types' : '';
  return (
    '#!/usr/bin/env bash\n' +
    `# ${ALIAS} — opencode behind a fresh rotating proxy (written by Andy).\n` +
    '#\n' +
    '# Installed by /zim-opencode. Each run leaves from a different address; only\n' +
    '# this process is proxied, never the rest of the system. Delete this file to\n' +
    '# remove it.\n' +
    'set -euo pipefail\n' +
    `exec "${process.execPath}"${stripTypes} "${self}" "$@"\n`
  );
}

/**
 * Write the `opencode-andy` shim. Returns `(ok, message)`.
 *
 * Idempotent: rewritten every time so a moved checkout re-points itself, the
 * same way install.sh rewrites its own launcher.
 */
export function installAlias(): [boolean, string] {
  const p = aliasPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, shimBody(), 'utf-8');
    fs.chmodSync(p, 0o755);
  } catch (e) {
    return [false, `could not write ${p}: ${String(e)}`];
  }
  const dir = path.dirname(p);
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
  if (!onPath) {
    return [true, `${p} (add ${dir} to PATH to use it)`];
  }
  return [true, p];
}

export function aliasInstalled(): boolean {
  const p = aliasPath();
  return isFile(p) && isExecutable(p);
}

// === SECTION === entry point ===

/**
 * Entry point for the `opencode-andy` shim.
 *
 * Kept deliberately small: rotate, say which address is in use, exec. The shim
 * is a convenience for the shell, and the interesting logic stays in the
 * functions above where the tests can reach it.
 */
export async function main(argv?: string[]): Promise<number> {
  const args = argv ?? process.argv.slice(2);
  const binary = findBinary();
  if (binary === undefined) {
    process.stderr.write('opencode not found - install it please !\n');
    return 127;
  }

  // A shell launch has no UI to show progress in, but it should not hand back
  // a TUI that is about to be refused either — so it converges on a working
  // route the same way the slash command does, just more quietly.
  const [proxy, note] = await findWorkingProxy(binary, { attempts: 6 });
  if (proxy === null) {
    process.stderr.write(
      `andy: no working proxy (${note}) — running from your own address\n`,
    );
  } else {
    const ip = await probeExitIp(proxy);
    process.stderr.write(
      `andy: routing through ${proxy.url}${ip ? ` (exit ${ip})` : ''}\n`,
    );
  }
  return run(proxy, binary, { args });
}

// `node …/opencode.ts` (the opencode-andy shim) lands here — the analogue of
// `python -m zimzilla.opencode` hitting `if __name__ == "__main__"`.
//
// Guard is the launched file's basename stem, NOT a bare
// `import.meta.url === pathToFileURL(argv[1])` comparison: once tsup bundles
// everything into dist/cli.js, this module's import.meta.url IS the bundle's
// URL, so a URL comparison would make main() fire on every `andy` launch.
// The stem 'opencode' matches src/opencode.ts and a dist/opencode.js entry
// alike, and never cli.js.
if (process.argv[1]) {
  try {
    const launched = path.resolve(process.argv[1]);
    const stem = path.basename(launched).replace(/\.[cm]?[jt]s$/, '');
    if (stem === 'opencode') {
      void main().then(
        (code) => process.exit(code),
        (err) => {
          process.stderr.write(`${String(err)}\n`);
          process.exit(1);
        },
      );
    }
  } catch {
    // argv[1] was not a usable filesystem path — imported, not executed
  }
}
