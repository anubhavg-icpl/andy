// `/phish` and zim-pane regression suite (vitest port of tests/test_phish.py).
// Two layers, matching the split in src/phish.ts itself: the pure logic —
// target validation, form rewrite, credential picking, the campaign directory,
// the local server — exercised directly with no terminal; and the wiring —
// that the dispatch, the help table, the palette, the completion menu and the
// ZimPane rail all actually expose the command, so a rename in one place
// cannot silently orphan it in another.
// The Python suite's Textual pilot (run_test) has no Ink equivalent here, so
// the live-app checks run against the exported dispatch (cmdPhish) with a
// stubbed AppCtx — the same seam AndyApp's handleCommand drives — and the
// ZimPane state machine is driven through a real ink render on a fake stdout.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { render } from 'ink'

import * as phish from '../src/phish.js'
import { Config } from '../src/config.js'
import { HostSet, Scope } from '../src/scope.js'
import { getPalette } from '../src/theme.js'
import { SLASH_COMMANDS } from '../src/ui/complete.js'
import { ZimPane, type ZimPaneHandle } from '../src/ui/widgets.js'
import { cmdPhish } from '../src/ui/screens/campaigns.js'
import type { AppCtx, AgentLike, Mods } from '../src/ui/app.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let TMP = ''
function cfgFor(dir: string, stateName: string): Config {
  // Python: Config.from_env(workdir=…, api_key='x', base_url=localhost:4001)
  const cfg = Config.fromEnv({
    workdir: dir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
  })
  cfg.stateDir = path.join(dir, stateName)
  return cfg
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-phish-'))
})

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

describe('target', () => {
  it('validate: accepts real hosts and refutes junk', () => {
    const good = [
      'site.com',
      'https://site.com',
      'http://login.site.com/path',
      'www.example.co.uk',
      '10.0.0.5',
      'SITE.COM/login',
    ]
    for (const raw of good) {
      const [ok, err] = phish.validateTarget(raw)
      expect(ok, `validate: accepts ${raw} (${err})`).toBe(true)
    }

    const bad = ['', '   ', 'nope', 'not a host', '-bad.com', 'http://']
    for (const raw of bad) {
      const [ok] = phish.validateTarget(raw)
      expect(ok, `validate: rejects '${raw}'`).toBe(false)
    }
  })

  it('normalise: strips scheme, path and case', () => {
    expect(phish.normaliseTarget('https://Login.Site.COM/app')).toBe('login.site.com')
    expect(phish.normaliseTarget('  ')).toBe('')
  })

  it('target_url: scheme, path, and the known login hosts', () => {
    expect(phish.targetUrl('site.com/login')).toBe('https://site.com/login')
    // facebook's real login form, both with and without www
    expect(phish.targetUrl('www.facebook.com')).toBe('https://www.facebook.com/login/')
    expect(phish.targetUrl('facebook.com')).toBe('https://www.facebook.com/login/')
    // a pasted path is authoritative
    expect(phish.targetUrl('https://www.facebook.com/login.php')).toBe(
      'https://www.facebook.com/login.php',
    )
    // an explicit scheme / empty path keeps the exact pinned string —
    // urlunsplit (and the port's empty-path handling) drop the empty path,
    // so no trailing slash is invented for a bare host.
    expect(phish.targetUrl('http://site.com')).toBe('http://site.com')
    expect(phish.targetUrl('shop.example')).toBe('https://shop.example')
  })

  it('login_candidates: /login is among the guesses for an unknown host', () => {
    const cands = phish.loginCandidates('shop.example')
    expect(
      cands.includes('https://shop.example/login'),
      `candidates: ${cands.slice(0, 4)}`,
    ).toBe(true)

    const candsFb = phish.loginCandidates('www.facebook.com')
    expect(candsFb[0]).toBe('https://www.facebook.com/login/')

    const candsPath = phish.loginCandidates('shop.example/custom')
    expect(candsPath).toEqual(['https://shop.example/custom'])
    // the primary candidate is the exact typed string — no invented slash
    expect(phish.loginCandidates('shop.example')[0]).toBe('https://shop.example')
  })

  it('looks_like_login: password forms and JS shells count; marketing does not', () => {
    expect(phish.looksLikeLogin('<form><input type="password" name="p"></form>')).toBe(true)
    expect(phish.looksLikeLogin('<html><body><h1>Welcome</h1><p>shop the sale</p></body>')).toBe(
      false,
    )
    expect(phish.looksLikeLogin('')).toBe(false)
    // a JS Google shell still counts — that was the bug
    expect(
      phish.looksLikeLogin(
        '<!doctype html><html><title>Sign in - Google Accounts</title><body></body></html>',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Page rewrite
// ---------------------------------------------------------------------------

describe('rewrite', () => {
  const src =
    '<html><head><title>x</title></head><body>' +
    '<form action="https://real.example/login" method="GET" ' +
    'onsubmit="return false" target="_blank">' +
    '<input name="user"><input name="pass"></form></body></html>'

  it('a live page is rewritten to post at the capture endpoint', () => {
    const [page, cloned] = phish.buildPage('real.example', 'https://real.example/login', src)
    expect(cloned).toBe(true)
    expect(page).toContain('action="/__zim_capture"')
    expect(page).toContain('method="POST"')
    // the original action is gone once a <base> carries the origin
    expect(!page.includes('https://real.example/login') || page.includes('<base')).toBe(true)
    // client-side validation must not be able to skip the capture
    expect(page.toLowerCase()).not.toContain('onsubmit')
    // relative assets still resolve against the cloned origin
    expect(page).toContain('<base href="https://real.example/">')
    // the JS capture hook is present for JS-built forms
    expect(page).toContain('zimHooked')
  })

  it('an existing <base> is replaced, not doubled', () => {
    const already = '<head><base href="https://old.example/"></head><form></form>'
    const [page2] = phish.buildPage('real.example', 'https://real.example/', already)
    expect(page2.toLowerCase().split('<base').length - 1).toBe(1)
  })

  it('no live html falls back to the branded template, still posting here', () => {
    const [tmpl, cloned] = phish.buildPage('lab.example', 'https://lab.example/', null)
    expect(cloned).toBe(false)
    expect(tmpl).toContain('action="/__zim_capture"')
    expect(tmpl).toContain('lab.example')
  })
})

// ---------------------------------------------------------------------------
// clone_login picks the real form
// ---------------------------------------------------------------------------

/** Serve `routes` (path → html) on a loopback port; 404 for anything else. */
function serve(routes: Record<string, string>): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = routes[req.url ?? '/']
      if (body === undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end(`miss ${req.url}`)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

// The Python suite monkeypatched phish.fetch_page; the ESM module namespace is
// frozen and cloneLogin binds its own fetchPage, so the same pinned behaviors
// are driven through the REAL fetch path against a loopback origin — which is
// a stronger check, not a weaker one.
describe('clone_login', () => {
  it('skips a homepage with no form and takes /login', async () => {
    const { server, port } = await serve({
      '/': '<html><title>Shop</title><body>welcome</body></html>',
      '/login':
        '<html><form action="/auth"><input name="email">' +
        '<input type="password" name="pass"></form></html>',
    })
    try {
      const [html, note, used] = await phish.cloneLogin(`http://127.0.0.1:${port}`)
      expect(used).toBe(`http://127.0.0.1:${port}/login`)
      expect(html !== null && html.includes('type="password"')).toBe(true)
      expect(note.includes('cloned') && note.includes('/login')).toBe(true)
    } finally {
      server.close()
      server.closeAllConnections()
    }
  })

  it('a JS-only shell (Google) is served, not the generic card', async () => {
    const { server, port } = await serve({
      '/ServiceLogin':
        '<!doctype html><html><title>Sign in - Google Accounts</title>' +
        '<body>js app</body></html>',
    })
    try {
      const [html] = await phish.cloneLogin(`http://127.0.0.1:${port}/ServiceLogin`)
      expect(html !== null && html.includes('Google Accounts')).toBe(true)
      // the branded template would say `Sign in to <host>`; the shell must not
      expect(html !== null && html.includes('Sign in to 127.0.0.1')).toBe(false)
    } finally {
      server.close()
      server.closeAllConnections()
    }
  })
})

// ---------------------------------------------------------------------------
// PageKite
// ---------------------------------------------------------------------------

describe('pagekite', () => {
  it('open_tunnel tries pagekite first; the kite is vendored in packaging/', () => {
    const phishSrc = fs.readFileSync(path.join(ROOT, 'src', 'phish.ts'), 'utf8')
    expect(phishSrc).toContain('const attempts = [openPagekite, openCloudflared')
    expect(fs.statSync(path.join(ROOT, 'packaging', 'pagekite', 'pagekite.py')).isFile()).toBe(
      true,
    )
  })

  it('name lookup: no env and no file → empty; PAGEKITE_NAME wins', () => {
    const saved = { ...process.env }
    try {
      delete process.env.PAGEKITE_NAME
      delete process.env.PAGEKITE_BIN
      process.env.ANDY_HOME = path.join(os.tmpdir(), 'andy-no-such-home')
      expect(phish.pagekiteName()).toBe('')
      process.env.PAGEKITE_NAME = 'zim.pagekite.me'
      expect(phish.pagekiteName()).toBe('zim.pagekite.me')
    } finally {
      for (const k of ['PAGEKITE_NAME', 'PAGEKITE_BIN', 'ANDY_HOME']) {
        if (saved[k] !== undefined) process.env[k] = saved[k]
        else delete process.env[k]
      }
    }
  })

  it('a missing kite name is a skip, not a hang', async () => {
    const saved = { ...process.env }
    try {
      delete process.env.PAGEKITE_NAME
      delete process.env.PAGEKITE_BIN
      // Strip PATH so the fallback tunnel tools are "not installed" rather
      // than actually spawning cloudflared/ngrok on this host. pagekiteBin
      // still resolves the vendored packaging/pagekite/pagekite.py (an
      // absolute path), so the missing NAME is what must stop it.
      process.env.PATH = path.join(os.tmpdir(), 'andy-empty-path')
      const t0 = Date.now()
      const tun = await phish.openTunnel(9)
      expect(tun.ok).toBe(false)
      expect(tun.error).toContain('PAGEKITE_NAME')
      expect(Date.now() - t0).toBeLessThan(10_000)
    } finally {
      for (const k of ['PAGEKITE_NAME', 'PAGEKITE_BIN', 'PATH']) {
        if (saved[k] !== undefined) process.env[k] = saved[k]
        else delete process.env[k]
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Credential picking
// ---------------------------------------------------------------------------

describe('pick_credentials', () => {
  it('finds the pair under any naming, and degrades honestly', () => {
    let [user, pw] = phish.pickCredentials({ email: 'a@b.co', password: 's3cret' })
    expect(user === 'a@b.co' && pw === 's3cret').toBe(true)

    ;[user, pw] = phish.pickCredentials({ Username: 'bob', Passwd: 'x' })
    expect(user === 'bob' && pw === 'x').toBe(true)

    ;[user, pw] = phish.pickCredentials({ q: 'only-this' })
    expect(user === 'only-this' && pw === '').toBe(true)

    ;[user, pw] = phish.pickCredentials({})
    expect(user === '' && pw === '').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Campaign directory + local server
// ---------------------------------------------------------------------------

describe('campaign_dir', () => {
  it('lives under state_dir/phish and is named after the host', () => {
    const cfg = cfgFor(TMP, 'state')
    const d = phish.campaignDir(cfg, 'https://Login.Site.COM/app')
    expect(path.dirname(d)).toBe(path.join(cfg.stateDir, 'phish'))
    expect(d.startsWith(path.join(cfg.stateDir, 'phish', 'login.site.com-'))).toBe(true)
    expect(fs.statSync(d).isDirectory()).toBe(true)
  })
})

describe('server', () => {
  it('serves the page, captures a POST, persists, and stops cleanly', async () => {
    const cfg = cfgFor(TMP, 'srv-state')
    const events: phish.PhishEvent[] = []

    const camp = await phish.start(cfg, 'lab.example', (ev) => events.push(ev), {
      fetch: false,
      tunnel: false,
    })
    try {
      expect(camp.alive).toBe(true)
      expect(camp.localUrl.startsWith('http://127.0.0.1:')).toBe(true)
      expect(camp.publicUrl).toBe('') // no tunnel was requested
      expect(fs.statSync(path.join(camp.directory, 'index.html')).isFile()).toBe(true)
      expect(
        events.some((e) => e.kind === 'ready'),
        `ready event: ${events.map((e) => e.kind).join(',')}`,
      ).toBe(true)

      // GET the page.
      const res = await fetch(camp.localUrl, { signal: AbortSignal.timeout(2000) })
      const body = await res.text()
      expect(body).toContain('lab.example')
      expect(
        events.some((e) => e.kind === 'hit' && e.method === 'GET'),
        'GET is logged as a hit',
      ).toBe(true)

      // POST credentials.
      const post = await fetch(camp.localUrl + '__zim_capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          email: 'victim@lab.example',
          password: 'hunter2',
        }),
        signal: AbortSignal.timeout(2000),
      })
      const thanks = await post.text()
      expect(thanks).toContain('Checking')
      type CredEvent = Extract<phish.PhishEvent, { kind: 'hit' | 'cred' }>
      const creds = events.filter((e): e is CredEvent => e.kind === 'cred')
      expect(creds.length).toBe(1)
      expect(creds[0]!.user).toBe('victim@lab.example')
      expect(creds[0]!.password).toBe('hunter2')

      // Persistence.
      expect(fs.statSync(camp.logPath).isFile()).toBe(true)
      expect(fs.statSync(camp.credsPath).isFile()).toBe(true)
      const lines = fs.readFileSync(camp.credsPath, 'utf8').trim().split('\n')
      expect(lines.length).toBe(1)
      expect((JSON.parse(lines[0]!) as { password: string }).password).toBe('hunter2')
    } finally {
      const stopped = phish.stop()
      expect(stopped).toBe(camp)
      expect(camp.alive).toBe(false)
      expect(phish.active()).toBeNull()
      // The port should refuse new connections.
      let refused = false
      try {
        await fetch(camp.localUrl, { signal: AbortSignal.timeout(2000) })
      } catch {
        refused = true
      }
      expect(refused).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('scope', () => {
  it('a denied host is refused; an unlisted host is not', () => {
    const scope = new Scope()
    scope.denyPath = '/tmp/out-of-scope.yaml' // presence is what arms deny
    scope.deny = HostSet.fromMapping({ domains: ['bank.example'] })
    const [allowed, reason] = scope.allows('bank.example')
    expect(allowed).toBe(false) // reason carried in the message
    expect(reason.length).toBeGreaterThan(0)
    const [allowed2] = scope.allows('lab.example')
    expect(allowed2).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ZimPane (state machine, through a real ink render on a fake stdout)
// ---------------------------------------------------------------------------

/** Strip CSI/SGR sequences so text assertions see the words, not the colours. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
}

describe('zim pane', () => {
  it('hidden until a campaign starts, then tracks it through its events', async () => {
    // Same harness as test_boot: ink `debug` frames on a PassThrough stdout,
    // one chunk per render, polled — React schedules the re-render off the
    // event loop, so each handle call is awaited by its visible effect rather
    // than by a fixed sleep.
    const out = new PassThrough()
    const frames: string[] = []
    out.on('data', (c: Buffer) => frames.push(stripAnsi(c.toString('utf8'))))
    const holder: { pane: ZimPaneHandle | null } = { pane: null }
    const instance = render(
      createElement(ZimPane, {
        palette: getPalette('green'),
        ref: (h: ZimPaneHandle | null) => {
          holder.pane = h
        },
      }),
      {
        stdout: out as unknown as NodeJS.WriteStream,
        stdin: new PassThrough() as unknown as NodeJS.ReadStream,
        debug: true,
      },
    )
    /** First frame at index >= `from` matching `pred` (5 s budget). */
    const waitFor = async (pred: (f: string) => boolean, from: number): Promise<string> => {
      const deadline = Date.now() + 5_000
      for (let i = from; ; ) {
        while (i < frames.length) {
          const f = frames[i++]!
          if (pred(f)) return f
        }
        if (Date.now() > deadline) {
          throw new Error(`frame not found (scanned to ${i}, have ${frames.length})`)
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    /** Hidden transitions render an all-null tree, which ink writes as *no*
     * output at all — so "became hidden" is asserted after the frame stream
     * goes quiet, not by waiting for an (absent) empty frame. */
    const settle = async (quiet = 150): Promise<void> => {
      for (;;) {
        const n = frames.length
        await new Promise((r) => setTimeout(r, quiet))
        if (frames.length === n) return
      }
    }
    try {
      // The ref fires on mount commit; wait for it rather than assuming
      // render() commits synchronously.
      const refDeadline = Date.now() + 5_000
      while (holder.pane === null) {
        if (Date.now() > refDeadline) throw new Error('ZimPane handle never arrived')
        await new Promise((r) => setTimeout(r, 20))
      }
      const pane = holder.pane

      // hidden until a campaign starts: nothing visible was ever written
      await settle()
      expect(frames.some((f) => f.includes('ANDY-PANE'))).toBe(false)

      pane.showCampaign('lab.example')
      const shown = await waitFor((f) => f.includes('ANDY-PANE'), frames.length)
      expect(shown).toContain('lab.example')

      pane.note({
        kind: 'ready',
        host: 'lab.example',
        local: 'http://127.0.0.1:9/',
        public: 'https://x.trycloudflare.com',
        tool: 'cloudflared',
        clone: 'template (fetch skipped)',
        cloned: false,
      })
      await waitFor((f) => f.includes('https://x.trycloudflare.com'), frames.length)

      pane.note({
        kind: 'cred',
        user: 'a@b.co',
        password: 'pw',
        method: 'POST',
        path: '/__zim_capture',
      })
      const withCred = await waitFor((f) => f.includes('a@b.co'), frames.length)
      expect(withCred).toContain('CREDS')

      pane.note({ kind: 'stopped' })
      await waitFor((f) => f.includes('stopped'), frames.length)

      pane.minimize()
      const mini = await waitFor(
        (f) => !f.includes('ANDY-PANE') && f.includes('ANDY'),
        frames.length,
      )
      expect(mini).toContain('1 cred') // the credential count survives minimize
      pane.restore()
      await waitFor((f) => f.includes('ANDY-PANE'), frames.length)
      pane.closePane()
      const closedAt = frames.length
      await settle() // let the hidden render flush (or write nothing) on its own
      expect(frames.slice(closedAt).some((f) => f.includes('ANDY-PANE'))).toBe(false)
      // a new campaign un-hides the closed pane
      pane.showCampaign('lab.example')
      await waitFor((f) => f.includes('ANDY-PANE'), frames.length)
      pane.minimize()
      await waitFor((f) => !f.includes('ANDY-PANE') && f.includes('ANDY'), frames.length)
      pane.showCampaign('other.example')
      const switched = await waitFor((f) => f.includes('ANDY-PANE'), frames.length)
      expect(switched).toContain('other.example') // and it un-minimized
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  }, 20_000)

  it.skip('pane: width floors at MIN_WIDTH and caps at MAX_WIDTH', () => {
    // Descoped with the Ink port: the Python pane was mouse-resizable and
    // clamped its width; Ink has no mouse (PORT-MAP §3), so ZimPane has no
    // resize path at all and there is no width to clamp.
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('wiring', () => {
  it('/phish is reachable from every surface that lists commands', () => {
    const names = SLASH_COMMANDS.map(([c]) => c)
    expect(names).toContain('/phish')

    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf8')
    const campaignsSrc = fs.readFileSync(
      path.join(ROOT, 'src', 'ui', 'screens', 'campaigns.tsx'),
      'utf8',
    )
    const commandsSrc = fs.readFileSync(
      path.join(ROOT, 'src', 'ui', 'screens', 'commands.tsx'),
      'utf8',
    )
    const widgetsSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'widgets.tsx'), 'utf8')

    // dispatch has a phish entry
    expect(appSrc).toContain('phish: (a) => cmdPhish(ctx, a),')
    // _cmd_phish is defined
    expect(campaignsSrc).toContain('export function cmdPhish(')
    // help table lists it
    expect(commandsSrc).toContain("['/phish <host>',")
    // palette lists it
    expect(appSrc).toContain("['/phish', 'clone a login page and harvest creds', 'phish']")
    // the compose tree mounts ZimPane
    expect(appSrc).toContain('<W.ZimPane')
    // ZimPane itself exists
    expect(widgetsSrc).toContain('export const ZimPane')
  })
})

// ---------------------------------------------------------------------------
// Dispatch — the port of the Python live-UI test
// ---------------------------------------------------------------------------

interface DispatchLog {
  said: ReactNode[]
  lines: Array<{ m: string; warn?: boolean }>
  paneCalls: string[]
  paneEvents: unknown[]
}

/** An AppCtx stub that exercises the REAL cmdPhish dispatch: refusals print,
 * the launch runs the real phish module with fetch/tunnel disabled (exactly
 * the Python test's fake_start), and everything else fails loudly if touched.
 * `mods()` returns the namespaced Mods shape ({ phish: module }) — cmdPhish
 * reaches the module as `m.phish.validateTarget(...)`. */
function phishCtx(cfg: Config, scope: Scope, log: DispatchLog): { ctx: AppCtx; busyRef: { current: boolean } } {
  const realStart = phish.start
  const phishModule = {
    ...phish,
    start: (
      c: unknown,
      target: string,
      onEvent: phish.LogFn | null,
      _opts?: { tunnel?: boolean },
    ) =>
      realStart(c as phish.PhishConfig, target, onEvent, {
        fetch: false,
        tunnel: false,
      }),
  }
  const busyRef = { current: false }
  const ctx = {
    cfg,
    mods: () => ({ phish: phishModule }) as unknown as Mods,
    agent: () => ({ scope }) as unknown as AgentLike,
    pal: () => getPalette('green'),
    say: (node: ReactNode) => {
      log.said.push(node)
    },
    sysLine: (m: string, warn?: boolean) => {
      log.lines.push({ m, warn })
    },
    updateBar: () => {},
    setBusyBoth: (v: boolean) => {
      busyRef.current = v
    },
    busyRef,
    phishQRef: { current: [] as Array<Record<string, unknown>> },
    zimPane: () => ({
      showCampaign: (host: string) => {
        log.paneCalls.push(host)
      },
      note: (ev: unknown) => {
        log.paneEvents.push(ev)
      },
      hide: () => {
        log.paneCalls.push('hide')
      },
      closePane: () => {},
      minimize: () => {},
      restore: () => {},
      toggleMinimized: () => {},
      showHunt: () => {},
      noteHunt: () => {},
      applyPalette: () => {},
    }),
  }
  return { ctx: ctx as unknown as AppCtx, busyRef }
}

describe('/phish dispatch', () => {
  it('refuses bad input, blocks denied hosts, launches and tears down a campaign', async () => {
    const cfg = cfgFor(TMP, 'ui-state')
    const scope = new Scope()
    const log: DispatchLog = { said: [], lines: [], paneCalls: [], paneEvents: [] }
    const { ctx, busyRef } = phishCtx(cfg, scope, log)

    // bare /phish does not start a campaign
    cmdPhish(ctx, [])
    expect(phish.active()).toBeNull()
    expect(busyRef.current).toBe(false)
    expect(log.said.length).toBe(1) // the usage block

    // a bad host is refused
    cmdPhish(ctx, 'not a host'.split(' '))
    expect(phish.active()).toBeNull()
    expect(busyRef.current).toBe(false)

    // stop with nothing running stays idle
    cmdPhish(ctx, ['stop'])
    expect(busyRef.current).toBe(false)

    // Deny-list must refuse before a campaign is created.
    scope.denyPath = path.join(TMP, 'out-of-scope.yaml')
    scope.deny = HostSet.fromMapping({ domains: ['blocked.example'] })
    cmdPhish(ctx, ['blocked.example'])
    expect(phish.active()).toBeNull()
    expect(busyRef.current).toBe(false)
    const phishDir = path.join(cfg.stateDir, 'phish')
    const dirs = fs.existsSync(phishDir) ? fs.readdirSync(phishDir) : []
    expect(dirs.some((d) => d.startsWith('blocked.example-')), `${dirs}`).toBe(false)

    // A valid host launches the campaign (fetch/tunnel stubbed in phishCtx).
    cmdPhish(ctx, ['lab.example'])
    for (let i = 0; i < 100 && (phish.active() === null || busyRef.current); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const camp = phish.active()
    expect(camp !== null && camp.alive).toBe(true)
    if (camp !== null) {
      expect(fs.statSync(camp.directory).isDirectory()).toBe(true)
      expect(log.paneCalls).toContain('lab.example') // the pane was told to show
    }

    // status leaves the campaign running
    cmdPhish(ctx, ['status'])
    expect(phish.active()).not.toBeNull()

    // stop tears the campaign down
    cmdPhish(ctx, ['stop'])
    expect(phish.active()).toBeNull()
    expect(log.paneEvents).toContainEqual({ kind: 'stopped' })
  })

  it.skip('ui: drive the mounted AndyApp through /phish (needs an Ink app harness)', () => {
    // The Python suite drove ZimZillaApp through Textual's run_test pilot:
    // menu, refusal, happy path, pane visibility. Ink has no equivalent test
    // harness here (ink-testing-library is not a dependency), and mounting
    // AndyApp builds a real Agent + Anthropic client. The dispatch-level port
    // of these checks lives in the cmdPhish test above — the same seam
    // AndyApp's handleCommand drives — and the pane visibility behavior in the
    // zim pane render test.
  })
})
