// `/crack` regression suite (vitest port of tests/test_crack.py).
// Pins: identification signatures, the estimate arithmetic, the budgeted
// ladder, hashcat argv ordering (a rule/mask must never sit in the hashfile's
// positional slot), exit-code semantics, the scope guard NOT blocking local
// cracking, and the wiring that keeps /crack reachable from every surface.
// Invariants kept from the Python original: offline and model-free; hashcat-
// dependent tests skip with a PASS when hashcat is absent (a missing binary is
// not a regression), and wordlist-dependent plan assertions skip when rockyou
// and john's rules are not installed on this host.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as crack from '../src/crack.js'
import { Config } from '../src/config.js'
import { HostSet, Scope } from '../src/scope.js'
import { getPalette } from '../src/theme.js'
import { SLASH_COMMANDS } from '../src/ui/complete.js'
import { parseCrackArgs, type AppCtx, type Mods } from '../src/ui/app.js'
import { cmdCrack } from '../src/ui/screens/campaigns.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** hashcat's own example hash for mode 13100, whose plaintext is `hashcat`.
 * A real Kerberoast hash that ships with hashcat and has a known plaintext,
 * so the end-to-end test asserts a crack rather than a code path. */
const TGS_EXAMPLE =
  '$krb5tgs$23$*user$realm$test/spn*$b548e10f5694ae018d7ad63c257af7dc$' +
  '35e8e45658860bc31a859b41a08989265f4ef8afd75652ab4d7a30ef151bf6350d879' +
  'ae189a8cb769e01fa573c6315232b37e4bcad9105520640a781e5fd85c09615e78267e' +
  '494f433f067cc6958200a82f70627ce0eebc2ac445729c2a8a0255dc3ede2c4973d2d9' +
  '3ac8c1a56b26444df300cb93045d05ff2326affaa3ae97f5cd866c14b78a459f0933a5' +
  '50e0b6507bf8af27c2391ef69fbdd649dd059a4b9ae2440edd96c82479645ccdb06bae' +
  '0eead3b7f639178a90cf24d9a'
const TGS_PLAINTEXT = 'hashcat'

// ---------------------------------------------------------------------------
// Environment gates. The Python suite skipped (with a PASS) when hashcat was
// missing; the same doctrine applies, plus a gate for the wordlists because
// plan() drops stages whose files are absent (Python did the same — the
// original ran on a host that had them installed).
// ---------------------------------------------------------------------------

function whichSync(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const cand = path.join(dir, name)
    try {
      fs.accessSync(cand, fs.constants.X_OK)
      return cand
    } catch {
      /* keep scanning */
    }
  }
  return null
}

const HASHCAT = whichSync('hashcat') !== null
const WORDLISTS =
  fs.existsSync(crack.ROCKYOU) &&
  fs.existsSync(crack.BEST64) &&
  fs.existsSync(crack.ROCKYOU_30000)

let TMP = ''
function cfgFor(dir: string): crack.CrackConfig {
  // Python: Config.from_env(workdir=…, api_key='x', base_url=localhost:4001)
  const cfg = Config.fromEnv({
    workdir: dir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
  })
  cfg.stateDir = path.join(dir, 'state')
  return cfg
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-crack-'))
})

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

describe('identify', () => {
  it('recognises every signature the module claims to know', () => {
    // A format that silently stops being recognised is a format the banner
    // omits and the agent never learns about.
    const cases: Array<[string, number]> = [
      ['$krb5tgs$23$*svc$CORP.LOCAL$spn*$aabb$ccdd', 13100],
      ['$krb5asrep$23$user@CORP.LOCAL:deadbeef$aabbccdd', 18200],
      [
        'user::CORP:1122334455667788:0123456789abcdef0123456789abcdef:0101000000000000',
        5600,
      ],
      ['$1$salt$abcdefghijklmnopqrstuv', 500],
      ['$6$salt$abcdefghijklmnopqrstuv', 1800],
      ['$2a$10$abcdefghijklmnopqrstuv', 3200],
      ['WPA*01*aabbccdd*112233445566*', 22000],
    ]
    for (const [line, want] of cases) {
      const got = crack.identifyText(line)
      expect(got.length > 0 && got[0]!.mode === want, `identify: ${line.slice(0, 28)}`).toBe(true)
    }
  })

  it('resolves bare hex digests by length, 32-hex being NTLM over MD5', () => {
    // Both are 32 chars and NTLM is overwhelmingly the more likely source in
    // an engagement, so the module resolves the ambiguity that way — pinned.
    for (const [digest, want] of [
      ['a'.repeat(32), 1000],
      ['a'.repeat(40), 100],
      ['a'.repeat(64), 1400],
      ['a'.repeat(128), 1700],
    ] as Array<[string, number]>) {
      const got = crack.identifyText(digest)
      expect(
        got.length > 0 && got[0]!.mode === want,
        `identify: ${digest.length}-hex -> ${want}`,
      ).toBe(true)
    }
  })

  it('yields the NTLM inside a pwdump line, not the whole line', () => {
    // `user:rid:lm:nt:::` — the hash to crack is the NTLM tail, so the length
    // test has to look past the colons.
    const pwdump = `Administrator:500:aad3b435b51404eeaad3b435b51404ee:${'b'.repeat(32)}:::`
    const got = crack.identifyText(pwdump)
    expect(got.length > 0 && got[0]!.mode === 1000).toBe(true)
  })

  it('does not recognise junk or comments as hashes', () => {
    // A file of prose must identify as nothing rather than as the first thing
    // that happens to be 32 characters long.
    for (const junk of ['', '# a comment', 'not a hash at all', 'hello world']) {
      expect(crack.identifyText(junk), `identify: ${junk}`).toEqual([])
    }
  })

  it('a mixed file yields every format in it, most prevalent first', async () => {
    const text = [
      TGS_EXAMPLE,
      '$krb5asrep$23$user@CORP:aa$bb',
      'a'.repeat(32),
      'b'.repeat(32),
      'c'.repeat(32),
      '',
      '# comment',
    ].join('\n')
    const got = crack.identifyText(text)
    const modes = new Map(got.map((d) => [d.mode, d.count]))
    expect(new Set(modes.keys())).toEqual(new Set([13100, 18200, 1000]))
    expect(modes.get(1000)).toBe(3)
    expect(modes.get(13100)).toBe(1)
    expect(got[0]!.mode).toBe(1000)
    // The sample is an excerpt, never the whole hash.
    expect(got.every((d) => d.sample.length <= 60)).toBe(true)
    // The name is the human one.
    expect(got.some((d) => d.name === crack.HASH_MODES[13100]![0])).toBe(true)
  })

  it('identify() on a file and a directory merges counts across files', async () => {
    const d = path.join(TMP, 'hashes')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'tgs.txt'), TGS_EXAMPLE + '\n', 'utf8')
    fs.writeFileSync(path.join(d, 'ntlm.txt'), 'a'.repeat(32) + '\n' + 'b'.repeat(32) + '\n', 'utf8')
    const got = await crack.identify(d)
    const modes = new Map(got.map((x) => [x.mode, x.count]))
    expect(modes).toEqual(new Map([[1000, 2], [13100, 1]]))
    const single = await crack.identify(path.join(d, 'tgs.txt'))
    expect(single.map((x) => x.mode)).toEqual([13100])
  })
})

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe('estimate', () => {
  it('is startup + candidates / effective rate, for every stage and mode', () => {
    // An operator reads the duration and decides whether to start a run, so
    // the result is asserted against the module's own tables, not trusted.
    for (const stage of crack.LADDER) {
      for (const mode of [1000, 13100]) {
        const want = crack.HASHCAT_STARTUP + stage.candidates / crack.rateFor(mode, stage)
        const got = crack.estimate(mode, stage)
        expect(
          Math.abs(got - want) < 1e-9,
          `estimate: ${stage.name.slice(0, 24)} @ ${mode}`,
        ).toBe(true)
      }
    }
  })

  it('startup is included and non-zero, even for a one-candidate stage', () => {
    expect(crack.HASHCAT_STARTUP).toBeGreaterThan(0)
    const tiny = new crack.Stage('tiny', 1)
    expect(crack.estimate(1000, tiny)).toBeGreaterThanOrEqual(crack.HASHCAT_STARTUP)
  })

  it('the rule ceiling binds on a fast hash and not on a slow one', () => {
    // The asymmetry is why it is a `min` rather than a flat multiplier.
    const rule = crack.LADDER.find((s) => s.name.includes('best64'))!
    expect(rule.ceiling).toBe(crack.RULE_CEILING)
    expect(crack.rateFor(1000, rule)).toBe(crack.RULE_CEILING)
    expect(crack.rateFor(13100, rule)).toBe(crack.RATES[13100]!)
    expect(crack.rateFor(1000, crack.LADDER[0]!)).toBe(crack.RATES[1000]!)
  })

  it('an unknown mode falls back to the conservative rate', () => {
    expect(crack.rateFor(99999)).toBe(crack.FALLBACK_RATE)
    expect(crack.FALLBACK_RATE).toBeLessThanOrEqual(Math.min(...Object.values(crack.RATES)))
  })

  it('Kerberos is >100x slower than NTLM here', () => {
    // The headline claim, asserted rather than merely written in prose.
    const ratio = crack.rateFor(1000) / crack.rateFor(13100)
    expect(ratio).toBeGreaterThan(100)
  })

  it('rockyou on a Kerberoast is under a minute', () => {
    // The number that makes stage 1 always affordable and stage 2 a decision.
    expect(crack.estimate(13100, crack.LADDER[0]!)).toBeLessThan(60)
  })
})

describe('human_time', () => {
  it('formats durations a human reads at a glance', () => {
    for (const [secs, want] of [
      [0.5, '<1s'],
      [8, '8s'],
      [600, '10m'],
      [7200, '2.0h'],
      [172800, '2.0d'],
    ] as Array<[number, string]>) {
      expect(crack.humanTime(secs), `human_time: ${secs}`).toBe(want)
    }
  })
})

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe('plan', () => {
  it('covers the whole ladder and holds back only the --deep stage', () => {
    const full = crack.plan(1000, 86400)
    expect(full.length).toBe(crack.LADDER.length)
    const defaults = crack.LADDER.filter((s) => !s.deep)
    expect(defaults.length).toBeGreaterThan(1)
    // The --deep stage is present but not run, and says why.
    expect(full.some((p) => p.stage.deep && !p.run)).toBe(true)
    expect(full.filter((p) => p.stage.deep).every((p) => p.reason.includes('--deep'))).toBe(true)
  })

  // Availability-gated: plan() drops stages whose wordlists are missing, so
  // "every default stage runs" can only be asserted where the files exist —
  // the Python original ran on a host that had them installed.
  it.skipIf(!WORDLISTS)(
    'a generous budget runs every default stage and no more',
    () => {
      const full = crack.plan(1000, 86400)
      expect(full.map((p) => p.run)).toEqual(crack.LADDER.map((s) => !s.deep))
    },
  )

  it('a 1-second budget runs nothing and says so for each stage', () => {
    // Rather than silently producing an empty plan that reads like "there was
    // nothing to do".
    const tiny = crack.plan(13100, 1)
    expect(tiny.some((p) => p.run)).toBe(false)
    expect(tiny.filter((p) => !p.run).every((p) => p.reason.length > 0)).toBe(true)
  })

  it.skipIf(!WORDLISTS)('a budget covering only stage 1 runs only stage 1', () => {
    const s1 = crack.estimate(13100, crack.LADDER[0]!)
    const part = crack.plan(13100, s1 * 2)
    expect(part.map((p) => p.run)).toEqual([true, false, false, false])
  })

  it('the 30.9B-candidate mask fits an hour on NTLM but not on Kerberos', () => {
    // The mode-dependent decision the estimate exists to make. The mask needs
    // no files, so this holds on any host.
    const maskNtlm = crack.plan(1000, 3600).find((p) => p.stage.name.includes('mask'))!
    const maskKrb = crack.plan(13100, 3600).find((p) => p.stage.name.includes('mask'))!
    expect(maskNtlm.run, crack.humanTime(maskNtlm.seconds)).toBe(true)
    expect(maskKrb.run, crack.humanTime(maskKrb.seconds)).toBe(false)
    expect(maskNtlm.stage.candidates).toBe(26 * 26 ** 5 * 100)
    // The drop reason names the shortfall, so the operator knows how much more
    // budget would have bought the stage.
    expect(maskKrb.reason).toContain('exceeds')
  })

  it('--deep adds no stage, it unlocks one', () => {
    const shallow = crack.plan(1000, 86400)
    expect(shallow.some((p) => p.stage.deep && p.run)).toBe(false)
    expect(crack.plan(1000, 86400, { deep: true }).length).toBe(shallow.length)
  })

  it.skipIf(!WORDLISTS)('--deep runs the rockyou-30000 stage', () => {
    expect(crack.plan(1000, 86400, { deep: true }).every((p) => p.run)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Argument construction — where a rule file gets mistaken for a wordlist
// ---------------------------------------------------------------------------

describe('hashcat_argv', () => {
  const pot = '/tmp/p.pot'
  const hf = '/tmp/h.txt'

  it('stage 1: mode, potfile, runtime cap, rockyou after the hashfile', () => {
    const argv = crack.hashcatArgv(hf, 13100, crack.LADDER[0]!, pot, 60)
    expect(argv.includes('-m') && argv.includes('13100')).toBe(true)
    // The potfile is passed explicitly, never hashcat's default.
    expect(argv.includes('--potfile-path') && argv.includes(pot)).toBe(true)
    expect(argv.includes('--runtime') && argv.includes('60')).toBe(true)
    expect(argv).toContain(crack.ROCKYOU)
    expect(argv.indexOf(crack.ROCKYOU)).toBeGreaterThan(argv.indexOf(hf))
  })

  it('stage 2: the rule is passed with -r and is never the positional argument', () => {
    // `-a 0 <hash> <wordlist> -r <rule>`; putting the rule where the wordlist
    // goes parses fine and cracks nothing.
    const argv2 = crack.hashcatArgv(hf, 13100, crack.LADDER[1]!, pot, 60)
    expect(argv2.includes('-r') && argv2.includes(crack.BEST64)).toBe(true)
    expect(argv2).toContain(crack.ROCKYOU)
    expect(argv2.indexOf(crack.BEST64)).toBeLessThan(argv2.indexOf(hf))
  })

  it('stage 3: the mask follows the hashfile, or hashcat reads it as the hashfile', () => {
    // The bug this suite exists for.
    const argv3 = crack.hashcatArgv(hf, 1000, crack.LADDER[2]!, pot, 60)
    expect(argv3.includes('-a') && argv3.includes('3')).toBe(true)
    expect(argv3).toContain('?u?l?l?l?l?l?d?d')
    expect(argv3.indexOf('?u?l?l?l?l?l?d?d')).toBeGreaterThan(argv3.indexOf(hf))
  })

  it('every stage puts nothing positional before the hash and carries a runtime cap', () => {
    for (const stage of crack.LADDER) {
      const a = crack.hashcatArgv(hf, 1000, stage, pot, 30)
      const hi = a.indexOf(hf)
      expect(
        stage.positional.every((p) => a.slice(hi).includes(p)),
        `argv: ${stage.name.slice(0, 20)}`,
      ).toBe(true)
      expect(a).toContain('--runtime')
    }
  })
})

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

describe('validate_path', () => {
  it('resolves existing files and directories, refuses the rest', () => {
    const f = path.join(TMP, 'tgs.txt')
    fs.writeFileSync(f, TGS_EXAMPLE + '\n', 'utf8')

    let [got, err] = crack.validatePath(f)
    expect(got === f && err === '').toBe(true)

    ;[got, err] = crack.validatePath(TMP)
    expect(got === TMP && err === '').toBe(true)

    ;[got, err] = crack.validatePath('')
    expect(got === null && err.length > 0).toBe(true)

    ;[got, err] = crack.validatePath('/nope/not/here.txt')
    expect(got === null && err.length > 0).toBe(true)
  })

  it('refuses an inline hash with an explanation that names the mistake', () => {
    // The error has to say why, not just "no such file".
    const [got, err] = crack.validatePath(TGS_EXAMPLE)
    expect(got === null && err.includes('looks like a hash')).toBe(true)
    expect(err).toContain('file')
  })
})

describe('slug', () => {
  it('a path becomes a safe label; empty still yields one', () => {
    expect(crack.caseSlug('/home/andy/hashes/tgs.txt')).toBe('home-andy-hashes-tgs.txt')
    expect(crack.caseSlug('hunts/ad-corp.local/loot/tgs.txt')).not.toContain('/')
    expect(crack.caseSlug('')).toBe('hashes')
  })
})

// ---------------------------------------------------------------------------
// Case directory and potfile
// ---------------------------------------------------------------------------

describe('case_dir / potfile / finalise', () => {
  it('creates the case under state_dir/crack with a stamp in the name', () => {
    const cfg = cfgFor(TMP)
    const caseDir = crack.caseDir(cfg, '/some/tgs.txt')
    expect(fs.statSync(caseDir).isDirectory()).toBe(true)
    expect(path.dirname(caseDir)).toBe(path.join(cfg.stateDir, 'crack'))
    expect((caseDir.split('-').pop() ?? '').length).toBe(6)
  })

  it('the potfile lives beside the cases, shared across runs', () => {
    const cfg = cfgFor(TMP)
    const pot = crack.potfile(cfg)
    expect(path.dirname(pot)).toBe(path.join(cfg.stateDir, 'crack'))
    expect(crack.potfile(cfg)).toBe(pot)
    expect(path.basename(pot)).toBe('crack.potfile')
  })

  it('finalise archives the report and keeps the case directory', () => {
    const cfg = cfgFor(TMP)
    const caseDir = crack.caseDir(cfg, 'finalise-tgs.txt')
    // No report means no archive — a failed run is not archived empty.
    expect(crack.finaliseCase(cfg, caseDir)).toBeNull()
    fs.writeFileSync(path.join(caseDir, 'report.md'), '# Password cracking — tgs.txt\n', 'utf8')
    const dest = crack.finaliseCase(cfg, caseDir)
    expect(dest !== null && path.dirname(dest) === crack.reportsDir(cfg)).toBe(true)
    expect(dest !== null && fs.readFileSync(dest, 'utf8').includes('Password cracking')).toBe(true)
    // Unlike /osint, the case survives — the hash copy and the potfile are the
    // evidence, and deleting them would make the next run redo work.
    expect(fs.statSync(caseDir).isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The playbook
// ---------------------------------------------------------------------------

describe('playbook', () => {
  it('carries every fact the agent must not have to guess', () => {
    const cfg = cfgFor(TMP)
    const caseDir = crack.caseDir(cfg, 'tgs.txt')
    const detected = crack.identifyText(TGS_EXAMPLE)
    const prompt = crack.buildPrompt(cfg, '/x/tgs.txt', caseDir, detected, 900)

    expect(prompt).toContain(caseDir)
    expect(prompt).toContain(crack.potfile(cfg))
    expect(prompt).toContain('15m') // the budget, human-readable
    expect(prompt.includes('13100') && prompt.includes('Kerberoast')).toBe(true)
    expect(prompt).toContain('NO GPU')
    expect(prompt).toContain('--potfile-path')
    expect(prompt).toContain('--runtime')
    // john's best64 is where the rule lives on this host
    expect(prompt).toContain('/usr/share/john/rules/best64.rule')
    expect(prompt.toLowerCase()).toContain('password policy')
    expect(prompt).toContain('Authorised use only')
    expect(prompt).toContain(path.join(caseDir, 'report.md'))
  })

  it('an unidentified file says so and asks for --identify', () => {
    const cfg = cfgFor(TMP)
    const caseDir = crack.caseDir(cfg, 'u.txt')
    const empty = crack.buildPrompt(cfg, '/x/u.txt', caseDir, [], 900)
    expect(empty.includes('--identify') && empty.includes('none recognised')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The real crack (end-to-end, hashcat-gated)
// ---------------------------------------------------------------------------

describe('the real crack', () => {
  if (!HASHCAT) {
    it('crack: hashcat is not installed, so the real crack is skipped', () => {
      // A missing binary is not a regression in this repo — mirror the Python
      // suite's skip-with-a-PASS so the count stays honest.
      expect(true).toBe(true)
    })
  }

  const itReal = HASHCAT ? it : it.skip
  itReal('cracks hashcat\'s own example through runStage/recovered', async () => {
    const hashfile = path.join(TMP, 'real-tgs.txt')
    fs.writeFileSync(hashfile, TGS_EXAMPLE + '\n', 'utf8')
    const wordlist = path.join(TMP, 'words.txt')
    fs.writeFileSync(wordlist, `wrong\nnope\n${TGS_PLAINTEXT}\nother\n`, 'utf8')
    const pot = path.join(TMP, 'real.potfile')

    // A wordlist stage built from the real class, pointed at the test's
    // dictionary instead of rockyou — the ladder entry is the shape under
    // test, not its specific wordlist.
    const stage = new crack.Stage('test dictionary', 4, ['-a', '0'], [wordlist])

    const [code, out] = await crack.runStage(hashfile, 13100, stage, pot, { runtime: 30 })
    expect(crack.STOPPED.has(code), `exit=${code} ${out.slice(-200)}`).toBe(true)

    const got = await crack.recovered(hashfile, 13100, pot)
    expect(got.length).toBe(1)
    if (got.length > 0) {
      const [h, pw] = got[0]!
      expect(pw).toBe(TGS_PLAINTEXT)
      expect(h).toBe(TGS_EXAMPLE)
    }

    // The potfile is the durable artefact: a second run finds the crack
    // without doing the work again.
    const before = fs.statSync(pot).mtimeMs
    await crack.runStage(hashfile, 13100, stage, pot, { runtime: 30 })
    expect(fs.existsSync(pot) && fs.statSync(pot).mtimeMs >= before).toBe(true)
    expect((await crack.recovered(hashfile, 13100, pot)).length).toBe(1)

    // A hash NOT in the potfile must not be reported as cracked — `--show`
    // filters to the hashes in the given file, which is the whole reason
    // `recovered` asks hashcat rather than reading the potfile.
    const other = path.join(TMP, 'other.txt')
    fs.writeFileSync(
      other,
      '$krb5tgs$23$*x$Y$z*$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(60) + '\n',
      'utf8',
    )
    expect(await crack.recovered(other, 13100, pot)).toEqual([])
  }, 120_000)
})

describe('budget holds', () => {
  if (!HASHCAT) {
    it('budget: hashcat is not installed, so the cap is not tested', () => {
      expect(true).toBe(true)
    })
  }

  const itBudget = HASHCAT ? it : it.skip
  itBudget('the --runtime cap is enforced by hashcat, not by hope', async () => {
    // A hash that will not crack, a huge mask, a 3-second cap: the run must
    // return in roughly the cap rather than working through the keyspace.
    const hashfile = path.join(TMP, 'hard.txt')
    fs.writeFileSync(
      hashfile,
      '$krb5tgs$23$*x$Y$z*$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(60) + '\n',
      'utf8',
    )
    const pot = path.join(TMP, 'budget.potfile')
    const stage = new crack.Stage(
      'big mask',
      26 ** 8,
      ['-a', '3'],
      ['?l?l?l?l?l?l?l?l'],
    )

    const start = Date.now()
    const [code, out] = await crack.runStage(hashfile, 13100, stage, pot, { runtime: 3 })
    const elapsed = (Date.now() - start) / 1000
    expect(elapsed).toBeLessThan(60)
    expect(await crack.recovered(hashfile, 13100, pot)).toEqual([])
    // Stopping is not failing: exit 4 ("aborted by runtime") is the correct
    // outcome of a bounded run. Treating it as an error would make every
    // correctly-capped stage look broken.
    expect(crack.STOPPED.has(code), `exit=${code} ${out.slice(-160)}`).toBe(true)
    expect(code).toBe(crack.EXIT_RUNTIME)
  }, 120_000)
})

describe('exit codes', () => {
  it('pins hashcat\'s own exit_status_code.txt table', () => {
    expect(crack.EXIT_CRACKED).toBe(0)
    expect(crack.EXIT_EXHAUSTED).toBe(1)
    expect(crack.EXIT_RUNTIME).toBe(4)
    expect(crack.STOPPED.has(crack.EXIT_RUNTIME)).toBe(true)
    expect(new Set(crack.STOPPED)).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    // A negative code is a failure, not a stop; an unknown positive one too.
    expect(crack.STOPPED.has(-1)).toBe(false)
    expect(crack.STOPPED.has(-11)).toBe(false)
    expect(crack.STOPPED.has(99)).toBe(false)
  })

  it('the meanings explain themselves', () => {
    expect(crack.exitMeaning(4).toLowerCase()).toContain('runtime')
    expect(crack.exitMeaning(-1)).toContain('failed')
  })

  it('recognises the single-instance conflict, case-insensitively', () => {
    // hashcat allows one instance; the second refuses with this message.
    // Named rather than a bare 255 because the fix is "wait", not "debug".
    const real = "Already an instance '/usr/bin/hashcat' running on pid 138187"
    expect(crack.instanceBusy(real)).toBe(true)
    expect(crack.instanceBusy(real.toUpperCase())).toBe(true)
    expect(crack.instanceBusy('Status...........: Exhausted')).toBe(false)
    expect(crack.instanceBusy('')).toBe(false)
  })
})

describe('rates are real-run figures', () => {
  it('is measured, not benchmarked, and pessimistic on purpose', () => {
    // The salted/iterated crypt family runs in single-digit kH/s here; if
    // someone "corrects" these upward from a benchmark, the estimate for a
    // shadow-file crack becomes fiction.
    for (const mode of [1800, 3200]) {
      expect(crack.rateFor(mode), `rates: mode ${mode}`).toBeLessThan(1e6)
    }
    // NetNTLMv2 is the biggest benchmark-vs-reality gap (11x) — pin it.
    expect(crack.rateFor(5600)).toBeLessThan(5e6)
    // The fallback is no faster than the slowest measured mode, so an unknown
    // mode plans conservatively.
    expect(crack.FALLBACK_RATE).toBeLessThanOrEqual(Math.min(...Object.values(crack.RATES)))
    // Every mode the command claims to identify has a rate, so the banner can
    // always print an estimate for a format it knows.
    const missing = Object.keys(crack.HASH_MODES)
      .map(Number)
      .filter((m) => !(m in crack.RATES))
      .sort((a, b) => a - b)
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The scope guard
// ---------------------------------------------------------------------------

describe('scope does not block cracking', () => {
  it('a deny-listed domain in a *path* passes; a network command still blocks', () => {
    // `/ad` writes its hashes under a directory named for the domain
    // (hunts/ad-corp.local/loot/tgs.txt), so a crack run against that file has
    // a deny-listed string in its argument. hashcat is not a network tool and
    // the guard must not treat it as one — while the other half proves the
    // guard is still working.
    const scope = new Scope()
    scope.deny = HostSet.fromMapping({ domains: ['corp.local'] })
    scope.denyPath = '/dev/null' // presence is what arms the deny-list
    expect(scope.deny.empty).toBe(false)

    const local = [
      'hashcat -m 13100 hunts/ad-corp.local/loot/tgs.txt rockyou.txt',
      'hashcat -m 13100 hashes.txt --potfile-path crack.potfile --show',
      'hashcat --identify hunts/ad-corp.local/loot/tgs.txt',
    ]
    for (const cmd of local) {
      expect(
        scope.checkCommand(cmd),
        `scope: ${cmd.slice(0, 44)} is NOT blocked (${scope
          .checkCommand(cmd)
          .map((v) => v.reason)
          .join(', ')})`,
      ).toEqual([])
    }

    for (const cmd of ['curl http://dc01.corp.local/', 'smbclient -L //dc01.corp.local']) {
      expect(scope.checkCommand(cmd).length, `scope: ${cmd} is still BLOCKED`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('parse_crack_args', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf8')
  // CRACK_DEFAULT_BUDGET is module-private in app.tsx, so the default is
  // cross-checked against the source constant rather than a second literal.
  const srcBudget = /const CRACK_DEFAULT_BUDGET = ([\d.]+)/.exec(appSrc)

  it('a bare path takes the default budget, --deep off', () => {
    const [p, mode, mt, deep, err] = parseCrackArgs(['hashes.txt'])
    expect(p === 'hashes.txt' && err === '').toBe(true)
    expect(deep).toBe(false)
    expect(srcBudget, 'CRACK_DEFAULT_BUDGET found in app.tsx').not.toBeNull()
    expect(mt).toBe(srcBudget ? Number(srcBudget[1]) : NaN)
  })

  it('all three flags together', () => {
    const [p, mode, mt, deep, err] = parseCrackArgs([
      'hashes.txt',
      '--mode',
      '13100',
      '--max-time',
      '300',
      '--deep',
    ])
    expect(p === 'hashes.txt' && mode === 13100 && mt === 300 && deep && err === '').toBe(true)
  })

  it('the --flag=value form works, matching /ad', () => {
    const [, mode, mt, , err] = parseCrackArgs(['h.txt', '--mode=1000', '--max-time=60'])
    expect(mode === 1000 && mt === 60 && err === '').toBe(true)
  })

  it('refuses every malformed form with the value named', () => {
    for (const [bad, why] of [
      [['h.txt', '--mode'], '--mode with no value'],
      [['h.txt', '--max-time'], '--max-time with no value'],
      [['h.txt', '--max-time', 'soon'], 'a non-numeric budget'],
      [['h.txt', '--max-time', '0'], 'a zero budget'],
      [['h.txt', '--max-time', '-5'], 'a negative budget'],
      [['h.txt', '--wat'], 'an unknown flag'],
      [['a.txt', 'b.txt'], 'two paths'],
    ] as Array<[string[], string]>) {
      const [, , , , err] = parseCrackArgs(bad)
      expect(err.length > 0, `parse: ${why} is refused`).toBe(true)
    }
  })

  it('an unknown mode is refused by the command, with the known list', () => {
    // Python's _parse_crack_args validated the mode itself; in the port that
    // check moved to cmdCrack (the parser comment: "The known-mode check
    // happens in the command (it owns crack.HASH_MODES)"). The pinned behavior
    // — a wrong mode number must be refused with the list, because it burns
    // the whole budget on a format that cannot match — is asserted at its new
    // owner rather than weakened away.
    const [, mode, , , err] = parseCrackArgs(['h.txt', '--mode', '999999'])
    expect(err === '' && mode === 999999).toBe(true) // the parser passes it through

    const lines: string[] = []
    const ctx = {
      // cmdCrack reads the palette before the mode check; mods/sysLine are the
      // only other surfaces the refusal path touches.
      pal: () => getPalette('green'),
      mods: () => ({ crack }) as unknown as Mods,
      sysLine: (m: string) => {
        lines.push(m)
      },
    } as unknown as AppCtx
    cmdCrack(ctx, ['h.txt', '--mode', '999999'])
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('999999')
    expect(lines[0]).toContain('13100')
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('wiring', () => {
  it('/crack is reachable from every surface that lists commands', () => {
    // Read from the source rather than importing a copy, so a rename in one
    // place cannot silently orphan the command in another.
    const names = SLASH_COMMANDS.map(([c]) => c)
    expect(names).toContain('/crack')

    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf8')
    const campaignsSrc = fs.readFileSync(
      path.join(ROOT, 'src', 'ui', 'screens', 'campaigns.tsx'),
      'utf8',
    )
    const commandsSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'screens', 'commands.tsx'), 'utf8')

    // dispatch has a crack entry
    expect(appSrc).toContain('crack: (a) => cmdCrack(ctx, a),')
    // _cmd_crack is defined
    expect(campaignsSrc).toContain('export function cmdCrack(')
    // _finalise_crack is defined
    expect(campaignsSrc).toContain('function finaliseCrack(')
    // help table lists it
    expect(commandsSrc).toContain("['/crack <file|dir>',")
    // palette lists it
    expect(appSrc).toContain("['/crack', 'crack hashes offline")
    // crack.py is imported
    expect(appSrc).toContain("sibling<CrackModule>('../crack.js')")
    // the refactor that lets /crack and /osint share one finalise hook
    expect(appSrc).toContain('finalise?: () => void;')
    // _run_turn still honours osint_case
    expect(appSrc).toContain('osintCase?: string;')
  })
})
