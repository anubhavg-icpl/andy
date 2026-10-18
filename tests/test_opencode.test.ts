// Vitest port of tests/test_opencode.py — the proxy pool, the rotation, and
// the launch decision (src/opencode.ts).
//
// Contract: nothing here touches the network or spawns a real process.
//  - subprocess.run/call → a mocked node:child_process.spawn (vi.mock at the
//    module level; the TS port spawns directly). Probe verdicts are driven by
//    rc/stdout/stderr exactly as the Python mocks did.
//  - urllib's proxied opener → mutations of the node:net / node:https default
//    exports (property lookup on the CJS exports object is live, so the module
//    under test sees the fakes). The fake speaks CONNECT then a canned response.
//  - shutil.which/Path.home → process.env.PATH and an os.homedir override
//    (again a default-export property, live for the module under test).
// Pool persistence is observed through the real pool.json under a per-test
// ANDY_HOME. Test names are the Python originals.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Hoisted: the child_process mock must exist before src/opencode.ts loads.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

type Oc = typeof import('../src/opencode.js');
let oc: Oc;
let tmp: string;

/** Python's check(): a named assertion; the name is the failure message. */
function check(name: string, ok: boolean, detail = ''): void {
  expect(ok, detail ? `${name}  [${detail}]` : name).toBe(true);
}

// === SECTION === the fake proxied HTTPS layer ================================
//
// proxyGet() speaks CONNECT to net.connect's socket and then hands the TLS
// socket to https.request. The fakes below supply both halves without a
// network: the raw socket answers CONNECT with 200, and https.request
// responds with a canned body after an optional per-host delay (delay is how
// probe latency is simulated for the sort tests).

interface NetState {
  /** 'live' answers with exitIp; 'html' answers with a non-IP body;
   *  'dead' never connects. */
  mode: 'live' | 'html' | 'dead';
  exitIp: string;
  /** Per-host response delay in ms — the measured "latency". */
  delayFor?: (host: string) => number;
}

const netState: NetState = { mode: 'live', exitIp: '203.0.113.7' };

class FakeRaw extends EventEmitter {
  constructor(
    public dead: boolean,
    /** The proxy's own host — the key per-proxy latency is simulated on. */
    public proxyHost: string,
  ) {
    super();
    // The TCP layer: 'connect' on success, 'error' when the port is dead.
    queueMicrotask(() => {
      if (this.dead) this.emit('error', new Error('connection refused'));
      else this.emit('connect');
    });
  }
  write(_data: string): void {
    // The CONNECT request — answer it after this proxy's simulated latency
    // (that delay is what probeProxy's stopwatch measures).
    const delay = netState.delayFor?.(this.proxyHost) ?? 0;
    setTimeout(() => {
      this.emit('data', Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
    }, delay);
  }
  destroy(): void {
    this.removeAllListeners();
  }
}

type HttpsHandler = (
  options: Record<string, unknown>,
  cb: (res: EventEmitter & { statusCode: number }) => void,
) => EventEmitter & { destroy(): void };

const realNetConnect = net.connect;
const realHttpsRequest = https.request;

function installFakeNet(): void {
  (net as unknown as Record<string, unknown>)['connect'] = ((opts: { host: string }) =>
    new FakeRaw(netState.mode === 'dead', opts.host)) as unknown as typeof net.connect;
  (https as unknown as Record<string, unknown>)['request'] = ((options, cb) => {
    const req = new EventEmitter() as EventEmitter & { destroy(): void };
    req.destroy = (): void => {
      req.removeAllListeners();
    };
    setTimeout(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      cb(res);
      setTimeout(() => {
        const body = netState.mode === 'html' ? '<html>blocked</html>' : `${netState.exitIp}\n`;
        res.emit('data', Buffer.from(body));
        res.emit('end');
      }, 0);
    }, 0);
    return req;
  }) as HttpsHandler as typeof https.request;
}

function restoreNet(): void {
  (net as unknown as Record<string, unknown>)['connect'] = realNetConnect;
  (https as unknown as Record<string, unknown>)['request'] = realHttpsRequest;
  netState.mode = 'live';
  netState.exitIp = '203.0.113.7';
  netState.delayFor = undefined;
}

// === SECTION === the fake subprocess layer ====================================

interface SpawnResult {
  code: number | null;
  stdout?: string;
  stderr?: string;
  /** Never close on your own — only when killed (the hung-proxy case). */
  hangUntilKilled?: boolean;
}

/** A CapturedRun-shaped child: pipes captured via setEncoding().on('data'). */
function makeChild(result: SpawnResult): EventEmitter {
  const child = new EventEmitter();
  const mkPipe = (): EventEmitter & { setEncoding: () => unknown } => {
    const e = new EventEmitter();
    Object.assign(e, { setEncoding: () => e });
    return e as EventEmitter & { setEncoding: () => unknown };
  };
  const outPipe = mkPipe();
  const errPipe = mkPipe();
  (child as unknown as Record<string, unknown>)['stdout'] = outPipe;
  (child as unknown as Record<string, unknown>)['stderr'] = errPipe;
  (child as unknown as Record<string, unknown>)['kill'] = (): void => {
    queueMicrotask(() => child.emit('close', null, null));
  };
  queueMicrotask(() => {
    outPipe.emit('data', result.stdout ?? '');
    errPipe.emit('data', result.stderr ?? '');
    if (!result.hangUntilKilled) {
      queueMicrotask(() => child.emit('close', result.code, null));
    }
  });
  return child;
}

/** Route spawn results by the child's proxied host (from env.HTTPS_PROXY). */
function spawnByHost(
  verdictFor: (host: string, callIndex: number) => SpawnResult,
): void {
  let calls = 0;
  spawnMock.mockImplementation((_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
    const env = opts?.env ?? {};
    const host = (env['HTTPS_PROXY'] ?? '').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    const result = verdictFor(host, calls++);
    return makeChild(result);
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-oc-test-'));
  process.env['ANDY_HOME'] = path.join(tmp, 'home');
  oc = await import('../src/opencode.js');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  spawnMock.mockReset();
  restoreNet();
  delete process.env['ANDY_BIN_DIR'];
  const home = path.join(tmp, 'home');
  process.env['ANDY_HOME'] = home;
  fs.rmSync(home, { recursive: true, force: true });
});

// === SECTION === parsing the lists ============================================

describe('opencode', () => {
  it('test_parse_candidates', () => {
    const body = [
      '# a comment',
      '',
      '1.2.3.4:8080',
      '1.2.3.4:8080', // duplicate
      'http://5.6.7.8:3128', // scheme prefix
      '9.9.9.9', // no port
      '10.0.0.1:abc', // port not numeric
      '  11.1.1.1:80  ', // padded
      ':::', // junk
    ].join('\n');
    const got = oc.parseCandidates(body);
    const pairs = got.map((p) => [p.host, p.port]);
    check('blank lines and comments skipped',
      JSON.stringify(pairs) === JSON.stringify([
        ['1.2.3.4', 8080], ['5.6.7.8', 3128], ['11.1.1.1', 80]]), String(pairs));
    check('duplicates collapsed', got.length === 3, String(pairs));
    check('scheme prefix stripped', got[1]!.host === '5.6.7.8', got[1]!.host);
    check('one malformed line does not cost the list', got.length === 3, String(pairs));

    check('Proxy.url is a plain http URL',
      new oc.Proxy('1.2.3.4', 8080).url === 'http://1.2.3.4:8080');
    // SOCKS is rejected by opencode's fetch layer, so the pool must never
    // hand one out even if a list carries the scheme.
    check('no socks scheme survives parsing',
      !oc.parseCandidates('socks5://1.2.3.4:1080').some((p) => p.url.includes('socks')));
  });

  // === the pool: rotation, freshness, persistence ===

  it('test_pool_rotation', () => {
    const ps = Array.from({ length: 3 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 8000 + i));
    const pool = new oc.Pool(ps);

    const got = Array.from({ length: 4 }, () => pool.nextProxy()!.host);
    check('rotation walks the pool in order',
      JSON.stringify(got.slice(0, 3)) === JSON.stringify(['10.0.0.0', '10.0.0.1', '10.0.0.2']),
      String(got));
    check('rotation wraps around', got[3] === '10.0.0.0', String(got));
    check('cursor advanced and wrapped', pool.cursor === 1, String(pool.cursor));

    check('empty pool yields None', new oc.Pool().nextProxy() === undefined);
  });

  it('test_pool_freshness', () => {
    const p = new oc.Pool([new oc.Proxy('1.1.1.1', 80)], 0, 1000.0);
    check('fresh just after validation', p.isFresh(1000.0 + 60));
    check('stale past POOL_MAX_AGE', !p.isFresh(1000.0 + oc.POOL_MAX_AGE + 1));
    // An empty pool is never fresh, or getPool would skip the rebuild.
    check('empty pool is never fresh', !new oc.Pool([], 0, 9e12).isFresh(9e12));
  });

  it('test_pool_persistence', () => {
    const p = path.join(tmp, 'pool.json');
    const ps = [new oc.Proxy('1.2.3.4', 8080, 0.4), new oc.Proxy('5.6.7.8', 3128)];
    oc.savePool(new oc.Pool(ps, 1, 123.0), p);
    const back = oc.loadPool(p);
    check('round-trips the proxies',
      JSON.stringify(back.proxies.map((x) => [x.host, x.port, x.latency])) ===
        JSON.stringify([['1.2.3.4', 8080, 0.4], ['5.6.7.8', 3128, null]]),
      String(back.proxies));
    check('round-trips the cursor', back.cursor === 1, String(back.cursor));
    check('round-trips validated_at', back.validatedAt === 123.0);

    // The cursor is the whole point of persisting: a reloaded pool must resume
    // where it left off, not restart at the top.
    check('reloaded pool resumes rotation',
      oc.loadPool(p).nextProxy()!.host === '5.6.7.8');

    fs.writeFileSync(p, '{not json', 'utf-8');
    check('corrupt pool degrades to empty', oc.loadPool(p).proxies.length === 0);
    check('missing pool degrades to empty',
      oc.loadPool(path.join(tmp, 'nope.json')).proxies.length === 0);

    // A read-only home must not break the launch: a blocker FILE where the
    // parent directory should be makes every write under it fail.
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    oc.savePool(new oc.Pool(ps), path.join(blocker, 'x.json'));
    check('save failure is never fatal', true);
  });

  // === probing ===

  it('test_probe_requires_real_traffic', async () => {
    installFakeNet();
    // probeProxy is private; validate is the public seam that runs it, and
    // the probe result (latency filled / dropped) is visible in its return.
    netState.mode = 'live';
    netState.exitIp = '203.0.113.7';
    const live = await oc.validate([new oc.Proxy('1.2.3.4', 8080)], { target: 1 });
    check('live proxy returns with latency filled',
      live.length === 1 && live[0]!.latency !== null, String(live));

    // A port that answers and then refuses to forward is the common failure.
    netState.mode = 'dead';
    const dead = await oc.validate([new oc.Proxy('1.2.3.4', 8080)], { target: 1 });
    check('dead proxy dropped', dead.length === 0, String(dead));

    // Something that answers but is not an exit IP must not be kept either.
    netState.mode = 'html';
    const html = await oc.validate([new oc.Proxy('1.2.3.4', 8080)], { target: 1 });
    check('non-IP body rejected', html.length === 0, String(html));
  });

  it('test_validate_sorts_and_caps', async () => {
    installFakeNet();
    netState.mode = 'live';
    netState.delayFor = (host) => Number(host.split('.').pop() ?? '0') * 15;
    const cands = Array.from({ length: 10 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 80));

    const live = await oc.validate(cands, { target: 4, workers: 4 });
    check('stops at the target', live.length === 4, String(live.length));
    const latencies = live.map((p) => p.latency ?? -1);
    check('fastest first',
      JSON.stringify(latencies) === JSON.stringify([...latencies].sort((a, b) => a - b)),
      String(latencies));

    netState.mode = 'dead';
    check('all-dead sample yields nothing',
      (await oc.validate(cands, { target: 4 })).length === 0);
    check('empty sample is not an error', (await oc.validate([])).length === 0);
  });

  it('test_progress_callback', async () => {
    installFakeNet();
    netState.mode = 'dead';
    const seen: [number, number][] = [];
    await oc.validate(
      Array.from({ length: 5 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 80)),
      { progress: (d, t) => seen.push([d, t]) },
    );
    check('progress reports every probe',
      seen.length > 0 && JSON.stringify(seen[seen.length - 1]) === JSON.stringify([5, 5]),
      String(seen));
  });

  // === the retry policy ===

  it('test_classify', () => {
    // The refusal opencode returns for a Tor exit — the failure that started
    // this whole design.
    check('free-tier refusal is retryable',
      oc.classify("OpenCode's free tier can only be used from within OpenCode") === 'retry');
    check('MITM certificate is retryable',
      oc.classify('self signed certificate in certificate chain') === 'retry');
    check('dead proxy is retryable',
      oc.classify('Unable to connect. Is the computer able to access the url?') === 'retry');
    check('retired model is a model error',
      oc.classify('Model is unavailable') === 'model');
    check('a clean transcript is ok', oc.classify('> build · deepseek ·\nok') === 'ok');
    check('empty transcript is ok', oc.classify('') === 'ok');
    check('None transcript is ok', oc.classify(null as unknown as string) === 'ok');
    // Order matters: this text mentions a connection AND a model error.
    check('model error wins over connection noise',
      oc.classify('model not found — connection closed') === 'model');
  });

  it('test_probe_launch_verdicts', async () => {
    const binary = '/usr/bin/opencode';
    const proxy = new oc.Proxy('1.2.3.4', 8080);

    spawnMock.mockImplementation(() => makeChild({ code: 0, stdout: 'ok', stderr: '' }));
    check('rc=0 and clean output is ok',
      (await oc.probeLaunch(proxy, binary)) === 'ok');

    spawnMock.mockImplementation(() => makeChild({ code: 1, stderr: 'Model is unavailable' }));
    check('retired model reported as model',
      (await oc.probeLaunch(proxy, binary)) === 'model');

    spawnMock.mockImplementation(() =>
      makeChild({ code: 1, stderr: 'self signed certificate in certificate chain' }));
    check('MITM reported as retry', (await oc.probeLaunch(proxy, binary)) === 'retry');

    // A hung proxy must not hang the launch: killed on timeout → retry.
    spawnMock.mockImplementation(() => makeChild({ code: 0, hangUntilKilled: true }));
    check('timeout reported as retry',
      (await oc.probeLaunch(proxy, binary, { timeout: 0.02 })) === 'retry');

    // rc=0 with a refusal in the output is still a refusal.
    spawnMock.mockImplementation(() =>
      makeChild({ code: 0, stderr: 'can only be used from within opencode' }));
    check('refusal on rc=0 still retries',
      (await oc.probeLaunch(proxy, binary)) === 'retry');
  });

  it('test_find_working_proxy', async () => {
    const binary = '/usr/bin/opencode';

    // Third time lucky: the loop must keep going rather than give up early.
    spawnByHost((_host, i) =>
      i === 2
        ? { code: 0, stdout: 'ok' }
        : { code: 1, stderr: 'can only be used from within opencode' });
    const pool = new oc.Pool(
      Array.from({ length: 6 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 80)));
    let [got, note] = await oc.findWorkingProxy(binary, { attempts: 6, pool });
    check('finds a working proxy after failures', got !== null && note === '', note);
    check('tried until it worked', spawnMock.mock.calls.length === 3,
      String(spawnMock.mock.calls.length));

    // A model error must stop immediately.
    spawnMock.mockClear();
    spawnByHost(() => ({ code: 1, stderr: 'Model is unavailable' }));
    const p2 = new oc.Pool(
      Array.from({ length: 6 }, (_, i) => new oc.Proxy(`10.1.0.${i}`, 80)));
    [got, note] = await oc.findWorkingProxy(binary, { attempts: 6, pool: p2 });
    check('model error stops the loop', spawnMock.mock.calls.length === 1,
      String(spawnMock.mock.calls.length));
    check('model error is reported as such', note.includes('model'), note);

    spawnByHost(() => ({ code: 1, stderr: 'can only be used from within opencode' }));
    const [none, noNote] = await oc.findWorkingProxy(binary, { attempts: 3, pool: new oc.Pool() });
    check('no proxies reported honestly', none === null && noNote.includes('no proxies'), noNote);

    const p3 = new oc.Pool(
      Array.from({ length: 6 }, (_, i) => new oc.Proxy(`10.2.0.${i}`, 80)));
    const [exhausted, exNote] = await oc.findWorkingProxy(binary, { attempts: 2, pool: p3 });
    check('exhausted attempts reported honestly',
      exhausted === null && exNote.includes('2 proxies'), exNote);
  });

  it('test_every_launch_is_a_different_proxy', async () => {
    // The requirement the command exists for: a second launch must leave from
    // a different address than the first. A pool built by validateTurns has
    // *every* entry proven, so "prefer the proven proxy" and "be different
    // each time" contradict each other.
    const now = Date.now() / 1000;
    const pool = new oc.Pool(
      Array.from({ length: 5 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 80, null, now)));

    spawnByHost(() => ({ code: 0, stdout: 'ok' }));
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [got] = await oc.findWorkingProxy('/usr/bin/opencode', { attempts: 4, pool });
      seen.push(got!.key);
    }
    check('five launches gave five distinct proxies',
      new Set(seen).size === 5, String(seen));
    check('no proxy repeated before the pool was exhausted',
      seen.length === new Set(seen).size, String(seen));

    // Once every proven proxy has been handed out, the cursor must take over.
    const more: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [got] = await oc.findWorkingProxy('/usr/bin/opencode', { attempts: 4, pool });
      more.push(got!.key);
    }
    check('an exhausted pool keeps cycling', more.every(Boolean), String(more));
    check('cycling does not stall on one proxy', new Set(more).size > 1, String(more));
  });

  it('test_a_dead_proxy_stops_being_trusted', async () => {
    // A failure is newer evidence than a proof, so it cancels it.
    const now = Date.now() / 1000;
    const dead = new oc.Proxy('10.0.0.1', 80, null, now - 300);
    const alive = new oc.Proxy('10.0.0.2', 80, null, now - 300);
    const pool = new oc.Pool([dead, alive]);

    check('both start out trusted', pool.knownGood().length === 2,
      String(pool.knownGood().length));
    pool.markFailed(dead);
    check('a failed proxy is no longer proven', !dead.isProven());
    check('the other one is unaffected', alive.isProven());
    check('known_good drops the failed one',
      JSON.stringify(pool.knownGood().map((p) => p.key)) === JSON.stringify([alive.key]),
      String(pool.knownGood().map((p) => p.key)));

    // Ordering matters: a failure only cancels a proof it is newer than.
    const oldFail = new oc.Proxy('10.0.0.3', 80, null, now, 0.0);
    oldFail.failedAt = now - 500;
    check('a failure older than the proof does not cancel it', oldFail.isProven());

    // Recovering must clear the failure.
    pool.markProven(dead);
    check('a proxy that works again is trusted again', dead.isProven());
    check('recovery clears failed_at', dead.failedAt === 0.0, String(dead.failedAt));

    // And a refusal during a hunt must be persisted, not just held in memory.
    spawnByHost(() => ({ code: 1, stderr: 'can only be used from within opencode' }));
    const failing = new oc.Pool([new oc.Proxy('10.0.0.9', 80, null, now)]);
    const [got] = await oc.findWorkingProxy('/usr/bin/opencode', { attempts: 1, pool: failing });
    check('a refused hunt returns nothing', got === null, String(got));
    check('the refusal is recorded', failing.proxies[0]!.failedAt > 0);
    check('a refused pool is still saved', fs.existsSync(oc.poolFile()));
  });

  it('test_failed_at_survives_a_save', () => {
    const p = new oc.Proxy('1.2.3.4', 8080, null, 100.0, 0.0, 150.0);
    check('a later failure cancels the proof', !p.isProven(200.0));
    oc.savePool(new oc.Pool([p], 0, 1.0));
    const back = oc.loadPool().proxies[0]!;
    check('failed_at survives a save/load', back.failedAt === 150.0, String(back.failedAt));
    check('so the dead proxy stays retired after a restart', !back.isProven(200.0));
    fs.writeFileSync(oc.poolFile(),
      '{"proxies":[{"host":"9.9.9.9","port":80,"proven_at":5.0}],'
      + '"cursor":0,"validated_at":1.0}', 'utf-8');
    check('a pre-failed_at pool file loads', oc.loadPool().proxies[0]!.failedAt === 0.0);
  });

  it('test_used_at_survives_a_save', () => {
    // used_at is what makes rotation survive a restart.
    const p = new oc.Proxy('1.2.3.4', 8080, null, 100.0, 200.0);
    oc.savePool(new oc.Pool([p], 0, 1.0));
    const back = oc.loadPool().proxies[0]!;
    check('used_at survives a save/load', back.usedAt === 200.0, String(back.usedAt));
    fs.writeFileSync(oc.poolFile(),
      '{"proxies":[{"host":"9.9.9.9","port":80,"proven_at":5.0}],'
      + '"cursor":0,"validated_at":1.0}', 'utf-8');
    const old = oc.loadPool().proxies[0]!;
    check('a pre-used_at pool file loads', old.usedAt === 0.0, String(old.usedAt));
    check('and its proof is still honoured', old.isProven(6.0));
  });

  it('test_known_good_is_tried_first', async () => {
    // The pool's memory is the point: a proxy that worked once is better
    // evidence than any liveness measurement.
    const stale = Array.from({ length: 4 }, (_, i) => new oc.Proxy(`10.0.0.${i}`, 80));
    const proven = new oc.Proxy('10.9.9.9', 8080, null, Date.now() / 1000 - 60);
    const pool = new oc.Pool([...stale, proven]);

    check('known_good finds the proven one',
      JSON.stringify(pool.knownGood().map((p) => p.key)) === JSON.stringify([proven.key]),
      String(pool.knownGood().map((p) => p.key)));

    // A proven proxy is tried first, whatever its position in the list.
    const order: string[] = [];
    spawnByHost((host) => {
      order.push(`${host}:80`);
      return { code: 0, stdout: 'ok' };
    });
    const [got] = await oc.findWorkingProxy('/usr/bin/opencode', { attempts: 6, pool });
    check('proven proxy tried first',
      order.length > 0 && order[0] === '10.9.9.9:80', String(order));
    check('proven proxy returned', got !== null && got.key === proven.key);

    // Success is recorded, which is what makes the next launch cheaper.
    const fresh = new oc.Pool([new oc.Proxy('10.5.5.5', 80)]);
    const [got2] = await oc.findWorkingProxy('/usr/bin/opencode', { attempts: 3, pool: fresh });
    check('success is marked proven', got2!.provenAt > 0, String(got2!.provenAt));
    check('pool was saved after success', fs.existsSync(oc.poolFile()));
    check('marked proxy is now known_good', fresh.knownGood().length !== 0);

    // An aged-out success must not be trusted forever.
    const old = new oc.Proxy('10.7.7.7', 80, null, Date.now() / 1000 - oc.KNOWN_GOOD_AGE - 1);
    check('stale proof is not trusted', !old.isProven());
    check('fresh proof is trusted',
      new oc.Proxy('1.1.1.1', 80, null, Date.now() / 1000).isProven());
    check('never-proven is not trusted', !new oc.Proxy('1.1.1.1', 80).isProven());
  });

  it('test_proven_at_round_trips', () => {
    const p2 = path.join(tmp, 'pool2.json');
    const p = new oc.Proxy('1.2.3.4', 8080, 0.5, 1234.0);
    oc.savePool(new oc.Pool([p], 0, 1.0), p2);
    const back = oc.loadPool(p2).proxies[0]!;
    check('proven_at survives a save/load', back.provenAt === 1234.0, String(back.provenAt));
    check('latency still survives', back.latency === 0.5);
    fs.writeFileSync(p2,
      JSON.stringify({ proxies: [{ host: '1.1.1.1', port: 80 }], cursor: 0, validated_at: 1.0 }),
      'utf-8');
    check('a pre-proven_at pool file still loads',
      oc.loadPool(p2).proxies[0]!.provenAt === 0.0);
  });

  it('test_build_pool_two_stages', async () => {
    // The decisive stage: liveness alone is not enough, so the survivors of
    // the cheap probe must get a real turn before they are kept.
    installFakeNet();
    netState.mode = 'live';
    netState.delayFor = () => 0;
    const body = Array.from({ length: 10 }, (_, i) => `10.0.0.${i}:80`).join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    // No binary: degraded path, keeps the liveness result.
    let pool = await oc.buildPool({ target: 4, binary: null });
    check('no binary falls back to liveness',
      pool.proxies.length === 4, String(pool.proxies.length));

    // With a binary: only turn-proven proxies are kept, stamped proven_at.
    spawnByHost((_host, i) =>
      i < 2
        ? { code: 0, stdout: 'ok' }
        : { code: 1, stderr: 'can only be used from within opencode' });
    pool = await oc.buildPool({ target: 2, binary: '/usr/bin/opencode' });
    check('only turn-proven proxies are kept',
      pool.proxies.length === 2, String(pool.proxies.length));
    check('the decisive stage actually ran',
      spawnMock.mock.calls.length > 0, String(spawnMock.mock.calls.length));
    check('survivors are stamped proven_at',
      pool.proxies.every((x) => x.provenAt > 0),
      String(pool.proxies.map((x) => x.provenAt)));
    check('a freshly built pool knows its good proxies',
      pool.knownGood().length === 2, String(pool.knownGood().length));

    // A turn-stage that finds nothing must not persist an empty pool.
    fs.rmSync(oc.poolFile(), { force: true });
    spawnByHost(() => ({ code: 1, stderr: 'can only be used from within opencode' }));
    pool = await oc.buildPool({ target: 2, binary: '/usr/bin/opencode' });
    check('all-refused build yields an empty pool', pool.proxies.length === 0);
    check('empty pool is not saved', !fs.existsSync(oc.poolFile()));
  });

  // === the child environment ===

  it('test_child_env', () => {
    const proxy = new oc.Proxy('1.2.3.4', 8080);
    const env = oc.childEnv(proxy, { PATH: '/usr/bin' });

    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
      'ALL_PROXY', 'all_proxy']) {
      check(`${name} set`, env[name] === 'http://1.2.3.4:8080', String(env[name]));
    }
    // Without the bypass opencode's own local server is proxied and the TUI
    // breaks — its docs call this required.
    for (const name of ['NO_PROXY', 'no_proxy']) {
      check(`${name} bypasses localhost`,
        env[name] === 'localhost,127.0.0.1,::1', String(env[name]));
    }
    check('base environment preserved', env['PATH'] === '/usr/bin');

    // Nothing global: building a child env must not touch this process's own
    // environment.
    const before = JSON.stringify(process.env);
    oc.childEnv(proxy);
    check('process.env not polluted', JSON.stringify(process.env) === before);
  });

  it('test_build_argv', () => {
    const b = '/usr/bin/opencode';
    check('TUI with no model is a bare argv', JSON.stringify(oc.buildArgv(b)) === JSON.stringify([b]));
    check('TUI with a model passes -m',
      JSON.stringify(oc.buildArgv(b, { model: 'opencode/x' })) ===
        JSON.stringify([b, '-m', 'opencode/x']));
    check('passthrough args reach the TUI',
      JSON.stringify(oc.buildArgv(b, { args: ['--auto'], model: 'm' })) ===
        JSON.stringify([b, '-m', 'm', '--auto']));
    // One-shot form with the default model when none was named.
    check('one-shot form uses run -m <model> <prompt>',
      JSON.stringify(oc.buildArgv(b, { prompt: 'hi' })) ===
        JSON.stringify([b, 'run', '-m', oc.DEFAULT_MODEL, 'hi']),
      String(oc.buildArgv(b, { prompt: 'hi' })));
  });

  it('test_run_env_and_status', async () => {
    const proxy = new oc.Proxy('1.2.3.4', 8080);
    spawnMock.mockImplementation(() => makeChild({ code: 0 }));
    const rc = await oc.run(proxy, '/usr/bin/opencode', { args: ['--auto'], cwd: '/tmp' });
    check('exit status propagated', rc === 0, String(rc));
    // spawn(argv[0], argv.slice(1), {env, cwd, ...}) — the call shape the
    // Python original asserted through subprocess.call's argv/kwargs.
    const [cmd, args, kw] = spawnMock.mock.calls[0]! as unknown as [
      string, string[], Record<string, unknown>,
    ];
    const env = kw['env'] as Record<string, string>;
    check('child got the proxied env', env['HTTPS_PROXY'] === 'http://1.2.3.4:8080');
    check('child ran in the given cwd', kw['cwd'] === '/tmp');
    check('argv is the TUI form',
      cmd === '/usr/bin/opencode' && JSON.stringify(args) === JSON.stringify(['--auto']),
      `${cmd} ${String(args)}`);

    // No proxy means inherit the environment untouched — the TS port passes
    // process.env itself (the reference, not a copy), which IS the inheritance.
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => makeChild({ code: 0 }));
    await oc.run(undefined, '/usr/bin/opencode');
    const kw2 = spawnMock.mock.calls[0]![2] as Record<string, unknown>;
    check('no proxy inherits the environment', kw2['env'] === process.env);

    spawnMock.mockClear();
    spawnMock.mockImplementation(() => makeChild({ code: 0, hangUntilKilled: true }));
    check('timeout becomes rc 124',
      (await oc.run(proxy, '/usr/bin/opencode', { timeout: 0.05 })) === 124);
  });

  // === the alias ===

  it('test_alias', () => {
    const binDir = path.join(tmp, 'bin');
    process.env['ANDY_BIN_DIR'] = binDir;
    check('alias path honours the override',
      oc.aliasPath() === path.join(binDir, oc.ALIAS), String(oc.aliasPath()));
    check('alias reports not installed before install', !oc.aliasInstalled());

    const [ok, detail] = oc.installAlias();
    check('install reports success', ok, detail);
    check('alias exists and is executable', oc.aliasInstalled(), detail);
    const mode = fs.statSync(oc.aliasPath()).mode & 0o777;
    check('alias is mode 755', mode === 0o755, mode.toString(8));

    const body = fs.readFileSync(oc.aliasPath(), 'utf-8');
    check('alias is a bash shim', body.startsWith('#!/usr/bin/env bash'), body.slice(0, 40));
    check('alias does not reimplement rotation',
      body.includes('exec ') && body.includes('opencode'), body);
    // The shim must name the interpreter that can run this module, not a bare
    // `node` from PATH (the TS analogue of Python's sys.executable pin).
    check('alias pins the interpreter', body.includes(process.execPath), body);

    // Re-running must REWRITE the shim rather than leave a stale interpreter
    // behind — a moved checkout re-points itself.
    fs.writeFileSync(oc.aliasPath(), '#!/usr/bin/env bash\nexec /stale/interpreter\n', 'utf-8');
    const [ok2] = oc.installAlias();
    const body2 = fs.readFileSync(oc.aliasPath(), 'utf-8');
    check('reinstall rewrites the interpreter', body2.includes(process.execPath), body2);
    check('reinstall reports success', ok2);

    delete process.env['ANDY_BIN_DIR'];
    check('alias defaults to ~/.local/bin',
      oc.aliasPath() === path.join(os.homedir(), '.local', 'bin', oc.ALIAS),
      String(oc.aliasPath()));
  });

  it('test_missing_binary_message', async () => {
    // Hide every way the binary could be found: empty PATH, empty HOME.
    const realHome = os.homedir;
    (os as unknown as Record<string, unknown>)['homedir'] = () => path.join(tmp, 'empty-home');
    const realPath = process.env.PATH;
    process.env.PATH = '';
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      const rc = await oc.main([]);
      check('missing binary message is exact',
        (writes.join('') ).trim() === 'opencode not found - install it please !',
        JSON.stringify(writes.join('')));
      check('missing binary exits 127', rc === 127, String(rc));
    } finally {
      stderrSpy.mockRestore();
      process.env.PATH = realPath;
      (os as unknown as Record<string, unknown>)['homedir'] = realHome;
    }
  });

  it('test_binary_lookup', () => {
    const fakeDir = path.join(tmp, 'bindir');
    fs.mkdirSync(fakeDir, { recursive: true });
    const fake = path.join(fakeDir, 'opencode');
    fs.writeFileSync(fake, '#!/bin/sh\n', 'utf-8');
    fs.chmodSync(fake, 0o755);

    const realPath = process.env.PATH;
    const realHome = os.homedir;
    try {
      process.env.PATH = fakeDir;
      check('PATH hit wins', oc.findBinary() === fake);

      process.env.PATH = '';
      const home = path.join(tmp, 'home-lookup');
      (os as unknown as Record<string, unknown>)['homedir'] = () => home;
      const shimDir = path.join(home, '.local', 'bin');
      fs.mkdirSync(shimDir, { recursive: true });
      const shim = path.join(shimDir, 'opencode');
      fs.writeFileSync(shim, '#!/bin/sh\n', 'utf-8');
      fs.chmodSync(shim, 0o755);
      // A session launched from a desktop entry inherits a PATH without
      // ~/.local/bin, so the fallback is what makes "installed" true.
      check('falls back to ~/.local/bin', oc.findBinary() === shim);

      (os as unknown as Record<string, unknown>)['homedir'] = () => path.join(tmp, 'empty2');
      check('reports None when truly absent', oc.findBinary() === undefined);
      check('is_installed agrees', !oc.isInstalled());
    } finally {
      process.env.PATH = realPath;
      (os as unknown as Record<string, unknown>)['homedir'] = realHome;
    }
  });

  it('test_state_paths', () => {
    const state = path.join(tmp, 'state');
    process.env['ANDY_HOME'] = state;
    check('state dir honours ANDY_HOME',
      oc.stateDir() === path.join(state, 'opencode'), String(oc.stateDir()));
    check('pool file lives in the state dir',
      oc.poolFile() === path.join(state, 'opencode', 'pool.json'), String(oc.poolFile()));
    check('state dir is created', fs.statSync(oc.stateDir()).isDirectory());
  });

  // === the UI wiring ===

  it('test_ui_wiring', async () => {
    const appUrl = new URL('../src/ui/app.tsx', import.meta.url);
    const app = fs.readFileSync(appUrl, 'utf-8');
    const commandsUrl = new URL('../src/ui/screens/commands.tsx', import.meta.url);
    const commands = fs.readFileSync(commandsUrl, 'utf-8');
    const completeUrl = new URL('../src/ui/complete.tsx', import.meta.url);
    const complete = fs.readFileSync(completeUrl, 'utf-8');
    // Non-literal specifier: keeps the .tsx module out of this file's
    // type graph (the tsconfig JSX flag is not this port's to set).
    const completeSpec = '../src/ui/complete.js';
    const { SLASH_COMMANDS } = (await import(completeSpec)) as {
      SLASH_COMMANDS: [string, string][];
    };

    check('dispatch has the command', app.includes("'andy-opencode':"));
    check('handler exists', commands.includes('export function cmdAndyOpencode'));
    // The terminal hand-off suspends the TUI around the child.
    check('launch suspends the TUI', commands.includes('suspendTerminal'));
    check('busy sessions still allow it', app.includes("'andy-opencode',"));
    check('completion popup lists it',
      SLASH_COMMANDS.some(([c]) => c === '/andy-opencode'));

    // The `--refresh` flag has to reach the pool loader, or it is a no-op.
    check('--refresh reaches the worker',
      commands.includes("a === '--refresh'") &&
        /getPool\(\{[^}]*refresh/s.test(commands));

    // The courtesy exit-IP lookup must not render "(exit undefined)" — the
    // parenthetical is built only when the IP is known.
    check('exit IP is guarded, never "(exit None)"',
      commands.includes('(exit ${ip})') && commands.includes(': proxy.url;'),
      'guard missing');
  });

  it('test_hunt_spinner', async () => {
    const appUrl = new URL('../src/ui/app.tsx', import.meta.url);
    const app = fs.readFileSync(appUrl, 'utf-8');
    const widgetsUrl = new URL('../src/ui/widgets.tsx', import.meta.url);
    const widgets = fs.readFileSync(widgetsUrl, 'utf-8');

    // The waiting message: the exact wording asked for, no counts.
    const hunting = /const HUNTING = '([^']*)'/.exec(app)?.[1] ?? '';
    check('the hunting message is the one asked for',
      hunting === 'ANDY IS MAKING IT UNLIMITED - FINDING THE BEST PROXIES ...', hunting);
    check('it does not announce a count',
      ![...hunting].some((c) => /\d/.test(c)), hunting);
    const frames = /const HUNT_FRAMES = '([^']*)'/.exec(app)?.[1] ?? '';
    check('spinner has multiple frames', [...frames].length > 3, String([...frames].length));
    check('spinner frames are single-width',
      [...frames].every((f) => f.length === 1), frames);

    // The animation must be on a UI timer: the worker blocks in single socket
    // calls for tens of seconds, so a callback-driven spinner would freeze.
    check('spinner runs on a UI interval',
      app.includes('setInterval(') && app.includes('}, 120);'));
    check('spinner is stopped after the hunt', app.includes('clearInterval('));
    check('spinner state is initialised as refs',
      app.includes('spinnerTimerRef = useRef') && app.includes('spinnerFrameRef = useRef(0)'));
    // A timer can fire during teardown; the pane lookup must tolerate it.
    check('pane lookup tolerates teardown', app.includes('const chat = () => chatRef.current;'));

    check('ChatPane has a spinner slot',
      widgets.includes('setSpinner(text: string): void;'));
    check('ChatPane can set and clear it',
      widgets.includes('setSpinner(text: string)') && widgets.includes('clearSpinner()'));

    // No counts and no unproven addresses on screen while it works.
    check('no proxy count is printed while hunting', !app.includes('proxies live'));
    check('no per-attempt address is printed', !app.includes('attempt ${i}/${n}'));
  });
});
