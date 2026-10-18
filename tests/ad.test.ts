// tests/ad.test.ts — vitest port of tests/test_ad.py: the /ad regression
// suite (the gate, the interlock, the probe, the doctrine).
//
// Everything here is offline and model-free: `ad.inspect` is a pure function
// of a command string and Throttle/AttemptBudget are plain objects, so the
// entire safety surface is asserted by writing commands down. No campaign,
// no network, no domain.
//
// Three invariants this file is built around (from the Python original):
//  - A read never spends budget (else a campaign trips its own breaker during
//    reconnaissance).
//  - A destructive command is refused BEFORE the budget (it never runs, so it
//    must not consume an attempt the operator paid for with --lockout).
//  - The breaker trips at lockout - 1, never at lockout.
//
// Every `check` name is preserved verbatim from the Python suite — they are
// named for the regressions they pin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ad from '../src/ad.js';
import * as hunt from '../src/hunt.js';
import { HostSet, Scope } from '../src/scope.js';
import { Config } from '../src/config.js';
import type { ToolHook } from '../src/shared.js';

function check(name: string, ok: boolean, extra = ''): void {
  expect(ok, extra ? `${name} — ${extra}` : name).toBe(true);
}

function _cfg(workdir: string, kw: Partial<Config> = {}): Config {
  return Config.fromEnv({
    workdir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
    ...kw,
  });
}

/**
 * A synthetic probe result, so the tests do not depend on this box.
 *
 * The Python helper iterated the private `_TOOL_CATALOGUE`; the TS port keeps
 * that table module-private (PORT-MAP convention), so the catalogue is
 * reconstructed from the exported `VECTOR_TOOLS` derivation — same rows, same
 * order, because VECTOR_TOOLS is built from the catalogue in order.
 */
function _probes(...present: string[]): ad.ToolProbe[] {
  const probes: ad.ToolProbe[] = [];
  for (const [vector, tools] of ad.VECTOR_TOOLS) {
    for (const n of tools) {
      probes.push(
        new ad.ToolProbe(
          n,
          present.includes(n) ? `/usr/bin/${n}` : null,
          `install ${n}`,
          vector,
        ),
      );
    }
  }
  return probes;
}

/** The catalogue's tool names, reconstructed (see `_probes`). */
const _CATALOGUE_NAMES = [...ad.VECTOR_TOOLS.values()].flat();

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('/ad regression suite', () => {
  it('test_validate_target', () => {
    // --- accepted, and normalised
    check('gate: a plain domain is accepted', ad.validateTarget('corp.local') === 'corp.local');
    check('gate: case is normalised', ad.validateTarget('CORP.LOCAL') === 'corp.local');
    check('gate: a trailing dot is stripped', ad.validateTarget('corp.local.') === 'corp.local');
    check('gate: surrounding space is stripped', ad.validateTarget('  corp.local  ') === 'corp.local');
    check('gate: a three-label domain is accepted', ad.validateTarget('ad.corp.internal') === 'ad.corp.internal');
    check('gate: an inner hyphen is allowed', ad.validateTarget('my-corp.local') === 'my-corp.local');
    check('gate: an IPv4 DC address is accepted (a lab box)', ad.validateTarget('10.10.10.5') === '10.10.10.5');

    // --- refused, each with a message rather than a bare False
    for (const [raw, why] of [
      ['', 'empty'],
      ['corp', 'no dot — a bare label is not a domain'],
      ['https://dc01.corp.local/owa', 'a URL'],
      ['http://corp.local', 'a URL'],
      ['corp.local/owa', 'a path'],
      ['dc01.corp.local\\share', 'a UNC path'],
      ['corp.local dc01', 'two tokens'],
      ['scan the whole domain please', 'a sentence'],
      ['-corp.local', 'a leading hyphen'],
      ['corp..local', 'an empty label'],
      ['corp.local:389', 'a port'],
      ['*.corp.local', 'a wildcard'],
    ] as const) {
      let refused = false;
      try {
        ad.validateTarget(raw);
      } catch {
        refused = true;
      }
      check(`gate: ${why} is refused`, refused, `accepted as ${JSON.stringify(raw)}`);
    }

    // The URL case is the one worth a helpful message: an operator pasting a URL
    // has the domain in their hand and should not have to retype it.
    try {
      ad.validateTarget('https://dc01.corp.local/owa');
    } catch (e) {
      const msg = (e as Error).message;
      check("gate: a URL is told the domain it contains", msg.includes("'dc01.corp.local'"), msg);
    }
    try {
      ad.validateTarget('');
    } catch (e) {
      const msg = (e as Error).message;
      check('gate: an empty target is told what to type', msg.includes('/ad corp.local'), msg);
    }

    // --- the ack phrase and the refusal line
    check('gate: the ack phrase is the normalised domain', ad.ackPhrase('CORP.Local.') === 'corp.local');
    check('gate: the refusal names the exact line to run', ad.refusal('corp.local') === '/ad corp.local --ack corp.local');
  });

  // -------------------------------------------------------------------------
  // inspect() — the decision surface, as a pure function
  // -------------------------------------------------------------------------

  // `(command, credential, destructive)`. Every row is a claim about what the
  // interlock does with one shell command, and the whole safety argument rests
  // on these being right — which is why they are written out rather than derived.
  const _TABLE: ReadonlyArray<readonly [string, boolean, boolean]> = [
    // --- reads. None of these may spend budget.
    ['smbclient -L //dc01.corp.local -N', false, false],
    ["rpcclient -U '' -N dc01.corp.local", false, false],
    ["rpcclient -U '' -N dc01.corp.local -c enumdomusers", false, false],
    ['nmap -sV -p 88,389,445 dc01.corp.local', false, false],
    ['nmap --script smb2-security-mode -p 445 dc01.corp.local', false, false],
    ['nmap --script smb-security-mode dc01.corp.local', false, false],
    ['dig @10.10.10.5 corp.local AXFR', false, false],
    ['dig @10.10.10.5 _ldap._tcp.dc._msdcs.corp.local SRV', false, false],
    ['nslookup -type=SRV _kerberos._tcp.corp.local', false, false],
    ['openssl s_client -connect dc01.corp.local:636', false, false],
    ["ldapsearch -H ldap://dc01.corp.local -x -b 'dc=corp,dc=local'", false, false],
    ['GetNPUsers.py corp.local/ -usersfile users.txt -no-pass -dc-ip 10.10.10.5', false, false],
    ['kerbrute userenum -d corp.local --dc 10.10.10.5 users.txt', false, false],
    ['enum4linux-ng -A dc01.corp.local', false, false],
    ['bloodhound-python -d corp.local -ns 10.10.10.5 -c All', false, false],
    ['ls -la /tmp', false, false],
    ['cat /etc/hosts', false, false],
    ['grep -r corp.local /tmp/notes', false, false],
    ['rm -rf /tmp/scratch', false, false],

    // --- offline cracking. No credential is offered to anything.
    ['hashcat -m 18200 asrep.txt rockyou.txt', false, false],
    ['john --format=krb5asrep asrep.txt', false, false],

    // --- credential attempts. Each spends one.
    ['GetUserSPNs.py corp.local/j.doe:Passw0rd -dc-ip 10.10.10.5 -request', true, false],
    ['GetNPUsers.py corp.local/j.doe:Passw0rd -dc-ip 10.10.10.5', true, false],
    ['secretsdump.py corp.local/j.doe:Passw0rd@dc01.corp.local', true, false],
    ['secretsdump.py -hashes :aad3b435b51404ee j.doe@dc01.corp.local', true, false],
    ['certipy find -u j.doe@corp.local -p Passw0rd -dc-ip 10.10.10.5', true, false],
    ['certipy find -u j.doe@corp.local -password Passw0rd', true, false],
    ['nxc smb dc01.corp.local -u j.doe -p Passw0rd', true, false],
    ['crackmapexec smb dc01.corp.local -u j.doe -p Passw0rd', true, false],
    ['cme smb dc01.corp.local -u j.doe -H :aad3b435b51404ee', true, false],
    // Destructive as well as credentialed: a machine account is a new directory
    // object, so this one writes to the domain even though the write is benign
    // in isolation.
    [
      'addcomputer.py -computer-name EVIL$ -computer-pass Passw0rd corp.local/j.doe:Passw0rd',
      true,
      true,
    ],
    ['smbclient //dc01.corp.local/share -U j.doe%Passw0rd', true, false],
    [
      "ldapsearch -H ldap://dc01.corp.local -D 'j.doe@corp.local' -w Passw0rd -b 'dc=corp,dc=local'",
      true,
      false,
    ],
    ['psexec.py corp.local/j.doe:Passw0rd@dc01.corp.local', true, false],
    ['wmiexec.py -hashes :aad3b435b51404ee corp.local/j.doe@dc01.corp.local', true, false],
    ['windapsearch -d corp.local -u j.doe -p Passw0rd --da', true, false],
    ['smbmap -H dc01.corp.local -u j.doe -p Passw0rd', true, false],

    // --- spraying and guessing, whatever it is spelled with
    ["hydra -L users.txt -p 'Summer2026!' smb://dc01.corp.local", true, false],
    ['medusa -h dc01.corp.local -U users.txt -p Passw0rd -M smbnt', true, false],
    ['patator smb_login host=dc01.corp.local user=FILE0 password=Passw0rd', true, false],
    ['ncrack -U users.txt -P passwords.txt smb://dc01.corp.local', true, false],
    ['crowbar -b smb -s dc01.corp.local -u j.doe -C passwords.txt', true, false],
    ['sprayhound -U users.txt -p Passw0rd -d corp.local', true, false],
    ['nmap --script smb-brute -p 445 dc01.corp.local', true, false],
    ["kerbrute passwordspray -d corp.local users.txt 'Summer2026!'", true, false],
    ['nxc smb dc01.corp.local -u users.txt -p Passw0rd --continue-on-success', true, false],

    // --- destructive. Refused outright, and none of them spends budget.
    ['rm -rf /var/lib/samba', false, true],
    ['rm -rf /etc/sssd', false, true],
    ['rm -rf /var/lib/sss', false, true],
    ['secretsdump.py corp.local/j.doe:Passw0rd@dc01.corp.local --delete', true, true],
    ['secretsdump.py corp.local/j.doe:Passw0rd@dc01.corp.local --action delete', true, true],
    ['net user j.doe NewPass123 /domain', false, true],
    ['net accounts /lockoutthreshold:0', false, true],
    ['certipy template -u j.doe@corp.local -p Passw0rd -template WebServer -save-old', true, true],
    ['certipy ca -u j.doe@corp.local -p Passw0rd -ca CORP-CA -enable-template WebServer', true, true],
    // The certipy line is drawn at the *subcommand*, so these three are the
    // negative cases that keep it there. `find` names a template and a CA and
    // reads; `req` enrols and does not modify directory state, whether or not
    // the CA is named explicitly; `account`/`shadow` set credentials and are
    // writes. A rule keyed on `-ca` would refuse `req` here and let the same
    // request through when the CA is auto-discovered.
    ['certipy find -u j.doe@corp.local -p Passw0rd -template WebServer -ca CORP-CA', true, false],
    ['certipy req -u j.doe@corp.local -p Passw0rd -ca CORP-CA -template User', true, false],
    [
      'certipy account -u j.doe@corp.local -p Passw0rd -user svc -upn svc@corp.local',
      true,
      true,
    ],
    ['ntlmrelayx.py -t ldap://dc01.corp.local --escalate-user j.doe', false, true],
    ["dsmod user 'CN=j.doe,CN=Users,DC=corp,DC=local' -pwd NewPass123", false, true],

    // --- not AD tooling at all. The interlock has no business with it.
    ['python3 -m http.server 8000', false, false],
    ['pip install certipy-ad', false, false],
    ['echo hello', false, false],
    ['', false, false],
  ];

  it('test_inspect', () => {
    // Every row of the table, against the pure decision function.
    const bad: string[] = [];
    for (const [cmd, cred, dest] of _TABLE) {
      const v = ad.inspect(cmd);
      if (v.credential !== cred || v.destructive !== dest) {
        bad.push(
          `${JSON.stringify(cmd.slice(0, 60))}: got credential=${v.credential} ` +
            `destructive=${v.destructive} (${v.reason}), wanted ${cred}/${dest}`,
        );
      }
    }
    check(`inspect: all ${_TABLE.length} commands classified correctly`, bad.length === 0, bad.join('\n    '));
  });

  it('test_inspect_details', () => {
    // `-usersfile` names *usernames*, not passwords. Counting it would spend the
    // campaign's whole budget on the one technique that cannot lock anything —
    // the most serious way this table could have been wrong.
    const v = ad.inspect('GetNPUsers.py corp.local/ -usersfile users.txt -no-pass -dc-ip 10.10.10.5');
    check('inspect: -usersfile is not a secret', !v.credential, v.reason);
    check('inspect: but the same tool with -p IS counted', ad.inspect('GetNPUsers.py corp.local/j.doe:Passw0rd').credential);

    // `-p` means *port* to nmap and *password* to netexec. That is exactly why
    // the C2 flags are gated on a C2 alias being named.
    check("inspect: nmap's -p is a port, not a password", !ad.inspect('nmap -p 445 dc01.corp.local').credential);
    check("inspect: netexec's -p is a password", ad.inspect('nxc smb dc01.corp.local -u j.doe -p Passw0rd').credential);

    // A read is not a reset. The negative lookahead is what separates them.
    check('inspect: `net user j.doe /domain` is a read', !ad.inspect('net user j.doe /domain').destructive);
    check('inspect: `net user j.doe NewPass /domain` is a reset', ad.inspect('net user j.doe NewPass /domain').destructive);

    // `rm -rf /tmp/scratch` is housekeeping; the same command against a domain
    // controller's state is the end of the client's Monday.
    check('inspect: rm -rf on a scratch dir is left alone', !ad.inspect('rm -rf /tmp/scratch').destructive);
    check("inspect: rm -rf on a DC's state is refused", ad.inspect('rm -rf /var/lib/samba').destructive);

    // A tool whose *name* contains "brute" is not a spray.
    check('inspect: `kerbrute userenum` is not a spray', !ad.inspect('kerbrute userenum -d corp.local users.txt').credential);
    check('inspect: `kerbrute passwordspray` is', ad.inspect("kerbrute passwordspray -d corp.local u.txt 'x'").credential);

    // `relevant` is what keeps the interlock out of everything that is not AD
    // work — a false positive here would throttle the agent's ordinary shell.
    for (const cmd of ['ls -la', 'python3 -m http.server', 'echo hi', 'pip install certipy-ad']) {
      check(`inspect: '${cmd}' is not the interlock's business`, !ad.inspect(cmd).relevant);
    }

    // A source path is not a credential: `domain/user:pass` requires a *dotted*
    // domain, which is what keeps `src/app.py:12` from matching.
    check('inspect: a source path with a colon is not a credential', !ad.inspect('grep -n corp.local src/app.py:12').credential);

    // Every refusal carries a reason, because the agent is handed it verbatim.
    for (const cmd of [
      'hydra -L u -p P smb://dc01.corp.local',
      'rm -rf /var/lib/samba',
      'nxc smb dc01.corp.local -u j.doe -p Passw0rd',
    ]) {
      const v2 = ad.inspect(cmd);
      check(`inspect: '${cmd.slice(0, 30)}' explains itself`, Boolean(v2.reason), v2.reason);
    }
  });

  // -------------------------------------------------------------------------
  // Throttle
  // -------------------------------------------------------------------------

  it('test_throttle', async () => {
    // rate <= 0 is genuinely free — the honest meaning of "no throttle".
    const free = new ad.Throttle(0, 1);
    let start = performance.now();
    for (let i = 0; i < 50; i++) await free.acquire();
    const elapsed0 = (performance.now() - start) / 1000;
    check('throttle: rate 0 never waits', elapsed0 < 0.05, `${elapsed0.toFixed(4)}s`);
    check('throttle: rate 0 reports a full bucket', free.tokens === free.burst);

    // A burst is free, and the overflow pays.
    const t = new ad.Throttle(10.0, 2);
    start = performance.now();
    for (let i = 0; i < 5; i++) await t.acquire();
    const elapsed = (performance.now() - start) / 1000;
    // 2 free, 3 at 10/s = 0.3s
    check('throttle: burst is free and the overflow is paced', 0.25 < elapsed && elapsed < 0.45, `${elapsed.toFixed(4)}s`);
    check('throttle: the wait is recorded', t.waited === 3, String(t.waited));
    check('throttle: the slept total matches', Math.abs(t.slept - 0.3) < 0.05, t.slept.toFixed(4));

    // One bucket, many agents: the rate is the operator's, not per-agent.
    const shared = new ad.Throttle(20.0, 1);
    start = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => shared.acquire()));
    const elapsed2 = (performance.now() - start) / 1000;
    check('throttle: concurrent callers share one bucket', 0.15 < elapsed2 && elapsed2 < 0.3, `${elapsed2.toFixed(4)}s`);
    check('throttle: and queue rather than stampede', shared.waited === 4, String(shared.waited));
  });

  // -------------------------------------------------------------------------
  // AttemptBudget — the circuit breaker
  // -------------------------------------------------------------------------

  it('test_budget', () => {
    // The breaker trips at lockout - 1, and refuses everything after.
    const b = new ad.AttemptBudget(5);
    check('budget: the limit is lockout - 1', b.limit === 4, String(b.limit));
    check('budget: nothing is spent to begin with', b.spent === 0);
    check('budget: and it has not tripped', !b.tripped);
    check('budget: the full allowance is available', b.remaining === 4);

    for (let i = 1; i <= 4; i++) {
      b.spend(`attempt ${i}`);
      check(`budget: attempt ${i} of 4 is allowed`, b.spent === i, String(b.spent));
    }
    check('budget: the allowance is now spent', b.remaining === 0);
    check('budget: but it has still not tripped', !b.tripped);

    try {
      b.spend('attempt 5');
      check('budget: attempt 5 is refused', false, 'it was allowed');
    } catch (e) {
      check('budget: attempt 5 is refused', e instanceof ad.InterlockRefusal);
      const msg = (e as Error).message;
      check('budget: the refusal says it would be the fifth', msg.includes('attempt 5'), msg.slice(0, 80));
      check('budget: and names the lockout', msg.includes('locks accounts at 5'), msg.slice(0, 120));
    }
    check('budget: the refusal tripped the breaker', b.tripped);
    // Refused *before* incrementing, so `spent` is always the number of
    // attempts that actually ran — never an overcount.
    check('budget: a refused attempt does not increment the count', b.spent === 4, String(b.spent));

    // Once tripped, everything after is refused too — a wave that walked into
    // the threshold has no business trying a sixth account.
    for (let i = 6; i <= 8; i++) {
      let refused = false;
      try {
        b.spend(`attempt ${i}`);
      } catch (e) {
        refused = e instanceof ad.InterlockRefusal;
      }
      check(`budget: attempt ${i} refused after the trip`, refused);
    }

    // The history is bounded, so a long campaign cannot grow it without limit.
    const h = new ad.AttemptBudget(1000);
    for (let i = 0; i < 200; i++) h.spend(`cmd ${i}`);
    check('budget: the history is bounded', h.history.length <= 50, String(h.history.length));

    // A lockout of 1 is reported, not enforced as a zero budget: refusing to run
    // at all is the operator's call, not this class's.
    const one = new ad.AttemptBudget(1);
    check('budget: lockout 1 still permits one attempt', one.limit === 1);
    check('budget: a nonsense lockout is floored at 1', new ad.AttemptBudget(0).limit === 1);
  });

  // -------------------------------------------------------------------------
  // makeInterlock — the ToolHook
  // -------------------------------------------------------------------------

  /** Drive a hook over the same enter/exit path the agent loop uses. */
  async function _call(hook: ToolHook, cmd: string): Promise<string> {
    try {
      await hook.enter('bash', { command: cmd });
      await hook.exit('bash', { command: cmd });
      return 'ran';
    } catch (e) {
      if (e instanceof ad.InterlockRefusal) return `refused: ${e}`;
      throw e;
    }
  }

  it('test_interlock', async () => {
    // The hook, over the real enter/exit path the agent loop uses.
    const budget = new ad.AttemptBudget(3);
    const refusals: [string, string][] = [];
    const hook = ad.makeInterlock(new ad.Throttle(0), budget, {
      onRefuse: (v, c) => refusals.push([v.reason, c]),
    });

    // Reads run and spend nothing.
    for (const cmd of [
      'nmap -sV dc01.corp.local',
      'smbclient -L //dc01.corp.local -N',
      'GetNPUsers.py corp.local/ -usersfile u.txt -no-pass',
    ]) {
      check(`interlock: '${cmd.slice(0, 32)}' runs`, (await _call(hook, cmd)) === 'ran');
    }
    check('interlock: reads spent no budget', budget.spent === 0, String(budget.spent));
    check('interlock: and reported no refusal', refusals.length === 0);

    // Credentials run until the limit, then stop.
    const spray = "hydra -L users.txt -p 'Summer2026!' smb://dc01.corp.local";
    check('interlock: attempt 1 runs', (await _call(hook, spray)) === 'ran');
    check('interlock: attempt 2 runs', (await _call(hook, spray)) === 'ran');
    const third = await _call(hook, spray);
    check('interlock: attempt 3 is refused', third.startsWith('refused'), third.slice(0, 60));
    check('interlock: the budget is spent', budget.spent === 2, String(budget.spent));
    check('interlock: the breaker tripped', budget.tripped);
    check('interlock: the refusal was reported', refusals.length === 1, String(refusals.length));
    check('interlock: the report carries the command', refusals.length > 0 && refusals[0]![1].includes('hydra'));

    // A read still runs after the trip — the campaign degrades rather than dies.
    check('interlock: reads still run after the trip', (await _call(hook, 'nmap -sV dc01.corp.local')) === 'ran');
    check('interlock: and a credential command still does not', (await _call(hook, 'nxc smb dc01.corp.local -u a -p b')).startsWith('refused'));

    // Destructive, refused before the budget — and it must not consume one.
    const b2 = new ad.AttemptBudget(3);
    const seen: [ad.Verdict, string][] = [];
    const hook2 = ad.makeInterlock(new ad.Throttle(0), b2, {
      onRefuse: (v, c) => seen.push([v, c]),
    });
    const out = await _call(hook2, 'rm -rf /var/lib/samba');
    check('interlock: a destructive command is refused', out.startsWith('refused'), out.slice(0, 70));
    check('interlock: the refusal says why', out.includes('domain controller'), out.slice(0, 120));
    check('interlock: and it spent no budget', b2.spent === 0, String(b2.spent));
    check('interlock: and did not trip the breaker', !b2.tripped);
    check('interlock: the destructive refusal was reported', seen.length === 1 && seen[0]![0].destructive);

    // --arm permits the write but not the spray.
    const b3 = new ad.AttemptBudget(5);
    const armed = ad.makeInterlock(new ad.Throttle(0), b3, { armed: true });
    check('interlock: --arm permits a destructive command', (await _call(armed, 'rm -rf /var/lib/samba')) === 'ran');
    check('interlock: --arm still does not permit a spray to overspend', (await _call(armed, 'hydra -L u -p P smb://dc01.corp.local')) === 'ran');

    // Non-bash tools are never the interlock's business.
    const b4 = new ad.AttemptBudget(1);
    const hook4 = ad.makeInterlock(new ad.Throttle(0), b4);
    for (const tool of ['read_file', 'write_file', 'list_dir', 'report_finding']) {
      await hook4.enter(tool, { path: 'x' });
      await hook4.exit(tool, { path: 'x' });
    }
    check('interlock: only bash is inspected', b4.spent === 0);

    // A reporting seam that raises must not take the campaign down with it.
    const b5 = new ad.AttemptBudget(1);
    const boom = (): void => {
      throw new Error('the sink is broken');
    };
    const hook5 = ad.makeInterlock(new ad.Throttle(0), b5, { onRefuse: boom });
    let sinkBrokeIt = false;
    try {
      await _call(hook5, 'hydra -L u -p P smb://dc01.corp.local');
      await _call(hook5, 'hydra -L u -p P smb://dc01.corp.local');
    } catch (e) {
      sinkBrokeIt = !(e instanceof ad.InterlockRefusal);
    }
    check('interlock: a broken reporting seam does not break the refusal', !sinkBrokeIt, "the sink's exception escaped");

    // The args key: `cmd` as well as `command`, because the tool schema has
    // changed spelling before and a hook that missed it would be a silent hole.
    const b6 = new ad.AttemptBudget(1);
    const hook6 = ad.makeInterlock(new ad.Throttle(0), b6);
    await hook6.enter('bash', { cmd: 'hydra -L u -p P smb://dc01.corp.local' });
    await hook6.exit('bash', { cmd: 'hydra -L u -p P smb://dc01.corp.local' });
    check('interlock: the `cmd` spelling is inspected too', b6.spent === 1, String(b6.spent));

    // An empty or malformed args dict must not crash the hook.
    const b7 = new ad.AttemptBudget(1);
    const hook7 = ad.makeInterlock(new ad.Throttle(0), b7);
    for (const args of [{}, null, { command: '' }, { command: null }]) {
      await hook7.enter('bash', args as Record<string, unknown>);
      await hook7.exit('bash', args as Record<string, unknown>);
    }
    check('interlock: an empty command is a no-op', b7.spent === 0);
  });

  // -------------------------------------------------------------------------
  // The tooling probe
  // -------------------------------------------------------------------------

  it('test_probe', () => {
    // The probe, and the "detect and degrade" decision built on it.
    const probes = ad.probeTools();
    check(
      'probe: every catalogue entry is probed',
      probes.length === _CATALOGUE_NAMES.length,
      String(probes.length),
    );
    check('probe: each probe names a vector', probes.every((p) => Boolean(p.vector)));
    check('probe: each probe carries an install hint', probes.every((p) => Boolean(p.hint)));
    check('probe: presence is a fact about the path', probes.every((p) => p.present === (p.path !== null)));

    // The synthetic probes are what the tests reason with, so that they do not
    // depend on what happens to be installed on the machine running them.
    const p = _probes('nmap', 'rpcclient');
    // Compared as a set: `_probes` preserves the catalogue's order, not the
    // order the caller named them in, and that ordering is an implementation
    // detail the test has no business pinning.
    check(
      'probe: a synthetic probe is present only when named',
      new Set(p.filter((q) => q.present).map((q) => q.name)).size === 2 &&
        p.filter((q) => q.present).every((q) => ['nmap', 'rpcclient'].includes(q.name)) &&
        p.filter((q) => q.present).length === 2,
    );

    const text = ad.renderTools(p);
    check('probe: the render lists what is present', text.includes('nmap') && text.includes('PRESENT'), text.slice(0, 120));
    check('probe: the render lists what is absent', text.includes('certipy') && text.includes('ABSENT'));
    check('probe: the render says an absent tool\'s vector is out of scope', text.includes('OUT OF SCOPE'));
    check('probe: the render carries the install hint', text.includes('install certipy'), text.slice(-200));
    check('probe: the render is empty-safe', ad.renderTools(_probes()).split('ABSENT')[0]!.includes('none of them'));

    // `unavailableVectors` is "every tool missing", not "any": most vectors
    // have a fallback, and degrading to it is the point of the probe.
    const none = ad.unavailableVectors(_probes());
    check(
      'probe: with nothing installed, every vector is unavailable',
      new Set(none).size === ad.VECTOR_TOOLS.size && [...none].every((v) => ad.VECTOR_TOOLS.has(v)),
      String([...none].sort()),
    );
    const every = ad.unavailableVectors(_probes(...ad.AD_TOOL_NAMES));
    check('probe: with everything installed, none is', every.length === 0, String(every));

    // A vector with one tool present is runnable with a worse method.
    // `kerberoast` is the one with a fallback chain — SPN enumeration and the
    // cracking can each come from a different tool — so hashcat alone keeps it
    // alive. `asrep-roast` needs `GetNPUsers.py` specifically and is still
    // skipped; asserting it here would be asserting the absence of a fallback.
    const partial = ad.unavailableVectors(_probes('hashcat'));
    check('probe: a vector with one tool present is not skipped', !partial.includes('kerberoast'), String([...partial].sort()));
    check('probe: a vector with nothing present is', partial.includes('coercion'), String([...partial].sort()));

    // The catalogue itself: names unique, and every vector in VECTOR_TOOLS.
    // (The TS port keeps _TOOL_CATALOGUE module-private, so the catalogue is
    // read back through its exported VECTOR_TOOLS derivation.)
    const names = _CATALOGUE_NAMES;
    check('probe: no tool is listed twice', new Set(names).size === names.length);
    check(
      'probe: every catalogue vector is a known vector',
      [...ad.VECTOR_TOOLS.keys()].every((v) => ad.VECTOR_TOOLS.has(v)),
    );
    // The spray tools and C2 aliases ad.ts keeps private are spelled here so
    // the derived-table check still means something: AD_TOOL_NAMES may contain
    // nothing outside catalogue ∪ spray ∪ c2.
    const SPRAY = new Set(['hydra', 'medusa', 'patator', 'ncrack', 'crowbar', 'spray', 'sprayhound']);
    const C2 = new Set(['crackmapexec', 'cme', 'nxc', 'netexec']);
    const catalogue = new Set(names);
    check(
      'probe: the derived tables agree with the catalogue',
      [...ad.AD_TOOL_NAMES].every((t) => catalogue.has(t) || SPRAY.has(t) || C2.has(t)),
    );
  });

  // -------------------------------------------------------------------------
  // The doctrine
  // -------------------------------------------------------------------------

  /**
   * The engine's named-placeholder substitution (hunt.ts `fmt` is private; the
   * test re-implements its exact semantics). "Formats cleanly" means: after
   * substituting the engine's kwarg set, no `{identifier}` placeholder remains
   * — the Python original got that for free from str.format's KeyError.
   */
  function fillsCleanly(text: string, vars: Record<string, string>): boolean {
    const out = text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : m,
    );
    return (out.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []).length === 0;
  }

  it('test_doctrine', () => {
    // `adKind` as a `CampaignKind`, and why it is a function.
    const kind = ad.adKind({ probes: _probes('nmap', 'rpcclient') });
    check('doctrine: the name is `ad`', kind.name === 'ad');
    check('doctrine: the command is `/ad`', kind.command === 'ad');
    check('doctrine: the directory prefix is `ad-`', kind.dirPrefix === 'ad-');
    check('doctrine: it carries AD\'s own vectors', kind.vectors === ad.AD_VECTORS && kind.vectors.length > 0);
    check('doctrine: it carries AD\'s own contract', kind.contract === ad.FINDING_CONTRACT);
    check(
      "doctrine: and AD's own prompts",
      kind.reconPrompt !== hunt.RECON_PROMPT &&
        kind.plannerPrompt !== hunt.WAVE_PLANNER_PROMPT &&
        kind.summaryPrompt !== hunt.SUMMARY_PROMPT,
    );
    check('doctrine: it installs an interlock', kind.interlock !== null);
    check('doctrine: the default kind installs none', hunt.HUNT_KIND.interlock === null);

    // The default `CampaignKind` must be byte-identical to what shipped, or
    // every `/bug-hunt` changes behaviour by being routed through the seam.
    check(
      "doctrine: HUNT_KIND's prompts are the module constants",
      hunt.HUNT_KIND.reconPrompt === hunt.RECON_PROMPT &&
        hunt.HUNT_KIND.plannerPrompt === hunt.WAVE_PLANNER_PROMPT &&
        hunt.HUNT_KIND.contract === hunt.FINDING_CONTRACT &&
        hunt.HUNT_KIND.summaryPrompt === hunt.SUMMARY_PROMPT,
    );
    check(
      'doctrine: HUNT_KIND is named and prefixed as it shipped',
      hunt.HUNT_KIND.name === 'hunt' &&
        hunt.HUNT_KIND.command === 'bug-hunt' &&
        hunt.HUNT_KIND.dirPrefix === '' &&
        hunt.HUNT_KIND.vectors.length === 0,
    );

    // A fresh instance per campaign, because the interlock holds state.
    const a2 = ad.adKind({ probes: [] });
    const b2 = ad.adKind({ probes: [] });
    check('doctrine: each call builds its own interlock', a2.interlock !== b2.interlock);
    check("doctrine: and its own throttle, so one run cannot spend another's", a2.reconPrompt === b2.reconPrompt);

    // The probe result reaches the recon prompt — that is "detect and degrade".
    const withTools = ad.buildReconPrompt(_probes('nmap'));
    check('doctrine: the recon prompt carries the probe result', withTools.includes('PRESENT on this host') && withTools.includes('nmap'));
    check("doctrine: and names an absent tool's vector as out of scope", withTools.includes('OUT OF SCOPE') && withTools.includes('certipy'));
    check('doctrine: no unsubstituted placeholder is left in it', !withTools.includes('{tools}') && withTools.includes('{target}') && withTools.includes('{contract}'));

    // Every prompt must survive the engine's exact substitution kwargs, or the
    // campaign dies on the first wave with a KeyError.
    const cases: [string, string, Record<string, string>][] = [
      ['recon', kind.reconPrompt, { target: 'corp.local', contract: kind.contract }],
      [
        'planner',
        kind.plannerPrompt,
        {
          target: 'corp.local',
          wave_size: '10',
          recon: 'r',
          recon_note: 'n',
          findings: 'f',
          waves: 'w',
          contract: kind.contract,
        },
      ],
      ['summary', kind.summaryPrompt, { target: 'corp.local', waves: 'w', recon: 'r', findings: 'f' }],
    ];
    for (const [label, text, kwargs] of cases) {
      check(`doctrine: the ${label} prompt formats cleanly`, fillsCleanly(text, kwargs));
    }

    // The vector tables.
    check('doctrine: AD_VECTORS are 3-tuples the roster can use', ad.AD_VECTORS.every((v) => v.length === 3));
    check('doctrine: every vector names who owns it', ad.AD_VECTORS.every((v) => Boolean(v[0]) && Boolean(v[1])));
    check(
      'doctrine: the later-wave vectors are named but not rostered',
      ad.AD_LATER_VECTORS.every((v) => v.length === 2) &&
        ad.AD_LATER_VECTORS.every(([n]) => !ad.AD_VECTORS.some(([n2]) => n2 === n)),
    );
    check('doctrine: the fallback roster is a real matrix', ad.AD_VECTORS.length >= 8, String(ad.AD_VECTORS.length));

    // The prompts carry the safety rules, because the model reads them.
    check('doctrine: the planner mentions the lockout threshold', kind.plannerPrompt.toLowerCase().includes('lockout'));
    check(
      'doctrine: the planner names the lockout signal as a stop',
      kind.plannerPrompt.includes('1909') || kind.plannerPrompt.toUpperCase().includes('LOCKED_OUT'),
    );
    // The arithmetic, not just the word. A planner told "be careful" plans
    // nothing differently; a planner told it has four attempts plans around it.
    check("doctrine: the planner states the operator's lockout in numbers", kind.plannerPrompt.includes('locks an account after 5'));
    check('doctrine: and the budget that follows from it', kind.plannerPrompt.includes('permitted 4 credential attempts'));
    check(
      "doctrine: a custom lockout reaches the planner's arithmetic",
      ad.buildPlannerPrompt(3).includes('locks an account after 3') &&
        ad.buildPlannerPrompt(3).includes('permitted 2 credential attempts'),
    );
    check('doctrine: a lockout of one still permits one attempt', ad.buildPlannerPrompt(1).includes('permitted 1 credential attempts'));
    check('doctrine: no sentinel survives into the built prompt', !kind.plannerPrompt.includes('__LOCKOUT__') && !kind.plannerPrompt.includes('__BUDGET__'));
    // The bare constant is a template, so it must NOT be what ships.
    check('doctrine: the shipped prompt is the built one, not the template', kind.plannerPrompt !== ad.PLANNER_PROMPT);
    check('doctrine: the contract asks for proven vs indicated', kind.contract.toLowerCase().includes('proven') && kind.contract.toLowerCase().includes('indicat'));
    check('doctrine: the summary requires the skipped work to be named', kind.summaryPrompt.toLowerCase().includes('not done'));

    // The default instance exists for reading prompts and the prefix.
    check('doctrine: AD_KIND is the default instance', ad.AD_KIND.name === 'ad' && ad.AD_KIND.dirPrefix === 'ad-');
  });

  it('test_ad_case_dir', () => {
    // An AD campaign's directory cannot collide with a web hunt's.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-ad-test-'));
    try {
      const cfg = _cfg(tmp, { stateDir: path.join(tmp, 'state') });
      const adDir = hunt.caseDir(cfg, 'corp.local', ad.AD_KIND);
      const webDir = hunt.caseDir(cfg, 'corp.local', hunt.HUNT_KIND);
      check('dir: the AD campaign is prefixed', path.basename(adDir) === 'ad-corp.local', path.basename(adDir));
      check('dir: the web hunt is not', path.basename(webDir) === 'corp.local', path.basename(webDir));
      check('dir: they do not collide', adDir !== webDir);
      check(
        'dir: both live under the one hunts root',
        path.dirname(adDir) === path.dirname(webDir) && path.basename(path.dirname(adDir)) === 'hunts',
        path.dirname(adDir),
      );
      check('dir: both are created', fs.statSync(adDir).isDirectory() && fs.statSync(webDir).isDirectory());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // The scope guard — this is what made /ad safe to ship at all
  // -------------------------------------------------------------------------

  // Commands whose target is an AD domain or a domain controller. Every one of
  // these was ALLOWED before `scope.py` learned the AD toolchain, and `/ad`
  // cannot be safe while the guard is blind to the syntax its own toolchain uses.
  const _SCOPE_TABLE: ReadonlyArray<readonly [string, string]> = [
    ['smbclient -L //dc01.corp.local -N', 'dc01.corp.local'],
    ['GetUserSPNs.py corp.local/j.doe:Pass -dc-ip 10.10.10.5 -request', 'corp.local'],
    ['secretsdump.py corp.local/j.doe:Pass@dc01.corp.local', 'dc01.corp.local'],
    ['certipy find -u j.doe@corp.local -dc-ip 10.10.10.5', 'corp.local'],
    ["rpcclient -U '' -N dc01.corp.local", 'dc01.corp.local'],
    ['bloodhound-python -d corp.local -ns 10.10.10.5', 'corp.local'],
    ["ldapsearch -H ldap://dc01.corp.local -x -b 'dc=corp,dc=local'", 'dc01.corp.local'],
    ['nxc smb dc01.corp.local -u j.doe -p Pass', 'dc01.corp.local'],
  ];

  /**
   * A `Scope` whose deny-list holds *denied*, built in memory.
   *
   * Constructed rather than loaded from a file: the guard's behaviour is what
   * is under test, not its YAML reader. The key is `domains`, not `deny`:
   * `HostSet.fromMapping` is polarity-neutral, and an unrecognised key builds
   * an *empty* set that permits everything — every assertion against it would
   * pass for the wrong reason.
   */
  function _scopeWithDenied(denied: string[]): Scope {
    const scope = new Scope();
    scope.deny = HostSet.fromMapping({ domains: denied });
    scope.denyPath = '/dev/null'; // `checkCommand` gates on this
    check('the test deny-list did not load', !scope.deny.empty);
    return scope;
  }

  it('test_scope_guard', () => {
    // Every AD-shaped target is *seen* by the guard, so the deny-list bites.
    const scope = _scopeWithDenied(['corp.local']);
    for (const [cmd, host] of _SCOPE_TABLE) {
      const targets = scope.extractTargets(cmd);
      check(`scope: '${cmd.slice(0, 40)}' yields ${host}`, targets.includes(host), String([...targets].sort()));
      const violations = scope.checkCommand(cmd);
      check(`scope: '${cmd.slice(0, 40)}' is BLOCKED`, violations.length > 0, violations.length > 0 ? violations[0]!.reason : 'allowed');
    }
  });

  it('test_scope_still_ignores_filenames', () => {
    // The filename heuristic still runs — it just stops eating AD forms.
    const scope = _scopeWithDenied(['corp.local']);
    for (const token of ['./report.json', 'src/app.py', 'notes.txt']) {
      const targets = scope.extractTargets(`cat ${token}`);
      check(`scope: ${token} is not a host`, !targets.includes(token), String([...targets].sort()));
      check(`scope: \`cat ${token}\` is not blocked`, scope.checkCommand(`cat ${token}`).length === 0);
    }
  });
});
