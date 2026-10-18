/**
 * tests/test_osint.test.ts — regression suite for `/osint` (port of
 * tests/test_osint.py).
 *
 * Two layers, matching the split in src/osint.ts itself:
 *
 *  - the pure logic — registry shape, target validation, slugging, the case
 *    directory, the playbook prompt — exercised directly with no terminal;
 *  - the wiring — that the slash dispatch, the help table, the palette, the
 *    completion popup and the command handlers all actually expose the
 *    command, so a rename in one place cannot silently orphan it in another.
 *
 * Invariants of this file:
 *  - Every check name from the Python suite is preserved as an `it` title —
 *    they are named for the regressions they pin.
 *  - The Textual `run_test` pilot has no Ink equivalent, so the Python
 *    `test_ui` block is ported at the command-handler seam instead: the real
 *    `cmdOsint`/`finaliseOsint` run against the real `osint` module through a
 *    stub AppCtx whose `runTurn` reproduces the one line of the real app
 *    runTurn the pilot was exercising (the osint finalise hook in the
 *    finally block). The app-level busy gate wiring is covered by the source
 *    checks in `wiring` instead.
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as osint from '../src/osint.js';
import * as osintTree from '../src/osint-tree.js';
import { Config } from '../src/config.js';
import { SLASH_COMMANDS } from '../src/ui/complete.js';
import { cmdOsint, finaliseOsint } from '../src/ui/screens/campaigns.js';
import type { AppCtx, Mods, Palette } from '../src/ui/app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Module scope, NOT beforeAll: several describes below build Configs at
// collection time, so TMP must already be a real absolute path when they run
// — an empty-string TMP here once silently redirected every state dir to a
// relative path in the repo root.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-test-osint-'));
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Python `_cfg`: a real Config pointed at a throwaway workdir/state. */
function cfgFor(workdir: string, overrides: Record<string, unknown> = {}): Config {
  const cfg = Config.fromEnv({
    workdir,
    apiKey: 'x',
    baseUrl: 'http://localhost:4001',
    ...overrides,
  } as Partial<Config>);
  return cfg;
}

// Python `Path` helpers on top of plain string paths.
const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
/** Non-recursive glob via readdir — enough for the `<kind>-<slug>-*` shapes. */
const globIn = (dir: string, pattern: RegExp): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => pattern.test(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('registry', () => {
  // Every kind the operator named is present, and the display order is the
  // order they asked for — a missing entry here is a missing menu row.
  const want = ['email', 'phone', 'facebook', 'tiktok', 'instagram', 'discord', 'github'];

  it('registry: all seven kinds exist', () => {
    expect(new Set(Object.keys(osint.OSINT_KINDS))).toEqual(new Set(want));
  });

  it("registry: KIND_ORDER lists them in the operator's order", () => {
    expect(osint.KIND_ORDER).toEqual(want);
  });

  // The built kinds, listed deliberately. If a third is flipped on later,
  // this test should be updated on purpose rather than passing by accident —
  // it is the reminder that a new playbook needs its own coverage.
  it('registry: all but phone are the built kinds', () => {
    const built = Object.entries(osint.OSINT_KINDS)
      .filter(([, k]) => k.built)
      .map(([n]) => n)
      .sort();
    expect(built).toEqual(['discord', 'email', 'facebook', 'github', 'instagram', 'tiktok']);
  });

  // The stubs must NOT carry a playbook — otherwise a stub would look
  // runnable to build_prompt and the "not built" guard would be the only
  // thing standing between the operator and an empty briefing.
  for (const [name, kind] of Object.entries(osint.OSINT_KINDS)) {
    if (!kind.built) {
      it(`registry: stub '${name}' has no playbook`, () => {
        expect(kind.playbook).toBe('');
      });
    }
  }

  // Names are unique keys with non-empty blurbs, so the menu renders.
  for (const [name, kind] of Object.entries(osint.OSINT_KINDS)) {
    it(`registry: '${name}' is well-formed`, () => {
      expect(kind.name).toBe(name);
      expect(kind.blurb.length > 0).toBe(true);
      expect(kind.targetLabel.length > 0).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  const email = osint.OSINT_KINDS['email']!;

  describe('email', () => {
    for (const addr of ['a@b.co', 'first.last@example.com', 'user+tag@gmail.com',
      'x@sub.domain.example.org']) {
      it(`validate: accepts ${addr}`, () => {
        const [ok, err] = osint.validate(email, addr);
        expect(ok, err).toBe(true);
      });
    }

    for (const addr of ['', 'nope', 'a@b', 'a b@c.com', 'a@b..com', '@example.com',
      'a@.com']) {
      it(`validate: rejects '${addr}'`, () => {
        const [ok] = osint.validate(email, addr);
        expect(ok).toBe(false);
      });
    }

    // A missing target is reported against the kind's own label, so the
    // operator reads "no email address given", not a generic message.
    it("validate: empty target names the kind's label", () => {
      const [ok, err] = osint.validate(email, '   ');
      expect(ok).toBe(false);
      expect(err.includes('email address')).toBe(true);
    });
  });

  describe('github', () => {
    const gh = osint.OSINT_KINDS['github']!;

    for (const handle of ['torvalds', 'Mr-Destroyer', 'a', 'x'.repeat(39),
      'user123', 'user-name-123']) {
      it(`validate: accepts github '${handle}'`, () => {
        const [ok, err] = osint.validate(gh, handle);
        expect(ok, err).toBe(true);
      });
    }

    // A pasted profile URL is the common way this gets typed, so it is
    // accepted and unwrapped rather than refused.
    for (const pasted of ['https://github.com/torvalds', 'http://github.com/torvalds',
      'github.com/torvalds', 'https://github.com/torvalds/']) {
      it(`validate: accepts the URL form ${pasted}`, () => {
        const [ok, err] = osint.validate(gh, pasted);
        expect(ok, err).toBe(true);
      });
    }

    for (const handle of ['', '-leading', 'trailing-', 'has space', 'x'.repeat(40),
      'user@example.com', 'two--hyphens', 'under_score',
      // A URL with a path is a repo, not an account.
      'https://github.com/torvalds/linux']) {
      it(`validate: rejects github '${handle}'`, () => {
        const [ok] = osint.validate(gh, handle);
        expect(ok).toBe(false);
      });
    }

    it('validate: github names its own label in the error', () => {
      const [ok, err] = osint.validate(gh, '   ');
      expect(ok).toBe(false);
      expect(err.includes('GitHub username')).toBe(true);
    });
  });

  describe('discord', () => {
    // Two legitimate target forms: a snowflake id and a username. Both must
    // pass, because the operator has no way to know which one they were given
    // and either is a real identifier.
    const dc = osint.OSINT_KINDS['discord']!;

    for (const handle of ['someuser', 'user.name', 'user_name', 'ab', 'x'.repeat(32),
      '80351110224678912', '613425648685547541',
      // A legacy discriminator dates the account, so it is kept.
      'olduser#1234']) {
      it(`validate: accepts discord '${handle}'`, () => {
        const [ok, err] = osint.validate(dc, handle);
        expect(ok, err).toBe(true);
      });
    }

    // A pasted profile URL carries the *numeric id* on Discord (unlike GitHub,
    // where it carries the handle), so it unwraps to an id.
    for (const pasted of ['https://discord.com/users/80351110224678912',
      'http://discord.com/users/80351110224678912',
      'discord.com/users/80351110224678912',
      'https://discord.com/users/80351110224678912/']) {
      it(`validate: accepts the URL form ${pasted}`, () => {
        const [ok, err] = osint.validate(dc, pasted);
        expect(ok, err).toBe(true);
      });
    }

    // A mention is another way an id arrives in a paste.
    for (const mention of ['<@80351110224678912>', '<@!80351110224678912>']) {
      it(`validate: accepts the mention form ${mention}`, () => {
        const [ok, err] = osint.validate(dc, mention);
        expect(ok, err).toBe(true);
      });
    }

    for (const handle of ['', 'a', 'x'.repeat(33), 'Has Space', 'user#12', 'user#12345',
      'not a handle!', 'a@b.com']) {
      it(`validate: rejects discord '${handle}'`, () => {
        const [ok] = osint.validate(dc, handle);
        expect(ok).toBe(false);
      });
    }

    it('validate: discord names its own label in the error', () => {
      const [ok, err] = osint.validate(dc, '   ');
      expect(ok).toBe(false);
      expect(err.includes('Discord')).toBe(true);
    });

    // A bare number is ambiguous and *both* readings are legitimate: Discord
    // usernames may be all digits (2-32 chars), and an id is 17-20 digits. So
    // a short number is accepted as a username, and a 17-20 digit one is
    // accepted as either. The distinction is the playbook's job, not
    // validation's — refusing a digits-only username would refuse a real one.
    it('validate: a digits-only username is accepted', () => {
      const [ok, err] = osint.validate(dc, '12345');
      expect(ok, err).toBe(true);
    });
    it('validate: a snowflake is accepted', () => {
      const [ok, err] = osint.validate(dc, '80351110224678912');
      expect(ok, err).toBe(true);
    });
  });

  describe('facebook', () => {
    // Four legitimate shapes: a numeric id, a vanity username, a `pfbid`
    // opaque id, and any of those as a pasted URL. All four must pass, because
    // the operator has no way to know which one they were handed.
    const fb = osint.OSINT_KINDS['facebook']!;

    for (const value of ['100012345678901', '4', '54971236771', 'nasa',
      'mark.zuckerberg', 'NASA', 'pfbid0AbCdefghijklmnopqrstuvwxyz']) {
      it(`validate: accepts facebook '${value}'`, () => {
        const [ok, err] = osint.validate(fb, value);
        expect(ok, err).toBe(true);
      });
    }

    // Every host Facebook serves the same profile from, and the two URL shapes
    // that carry a name *and* an id — where the id is what must survive.
    for (const pasted of ['https://www.facebook.com/nasa',
      'http://www.facebook.com/nasa',
      'https://web.facebook.com/nasa',
      'https://m.facebook.com/nasa',
      'https://mbasic.facebook.com/nasa',
      'https://business.facebook.com/nasa',
      'facebook.com/nasa',
      'https://www.facebook.com/nasa/',
      'https://www.facebook.com/profile.php?id=4',
      'https://www.facebook.com/people/Mark-Zuckerberg/4/']) {
      it(`validate: accepts the URL form ${pasted}`, () => {
        const [ok, err] = osint.validate(fb, pasted);
        expect(ok, err).toBe(true);
      });
    }

    // A URL with tracking cruft still reduces to the identity.
    it('validate: accepts a facebook URL with tracking cruft', () => {
      const [ok, err] = osint.validate(fb, 'https://web.facebook.com/nasa?__cft__[0]=abc#frag');
      expect(ok, err).toBe(true);
    });
    // A pasted subpage recovers the account rather than being refused.
    it('validate: a facebook subpage reduces to its account', () => {
      const [ok, err] = osint.validate(fb, 'https://www.facebook.com/nasa/photos');
      expect(ok, err).toBe(true);
    });

    // Site furniture is not a profile, and must not become one silently.
    for (const junk of ['', '   ', 'login', 'groups', 'marketplace', 'not a handle!',
      'has space', 'a@b.com']) {
      it(`validate: rejects facebook '${junk}'`, () => {
        const [ok] = osint.validate(fb, junk);
        expect(ok).toBe(false);
      });
    }

    it('validate: facebook names its own label in the error', () => {
      const [ok, err] = osint.validate(fb, '   ');
      expect(ok).toBe(false);
      expect(err.includes('Facebook')).toBe(true);
    });
  });

  describe('tiktok', () => {
    const tk = osint.OSINT_KINDS['tiktok']!;

    for (const value of ['charlidamelio', '@charlidamelio', 'user.name_1', 'ab',
      'x'.repeat(24)]) {
      it(`validate: accepts tiktok '${value}'`, () => {
        const [ok, err] = osint.validate(tk, value);
        expect(ok, err).toBe(true);
      });
    }

    // The URL forms an operator actually pastes, including the query strings
    // and the dead `m.` host, all of which were measured to serve the same
    // profile as the bare handle.
    for (const pasted of ['https://www.tiktok.com/@charlidamelio',
      'https://www.tiktok.com/@charlidamelio?lang=en',
      'https://www.tiktok.com/@charlidamelio?is_from_webapp=1&sender_device=pc',
      'https://www.tiktok.com/@charlidamelio/',
      'https://m.tiktok.com/@charlidamelio',
      'tiktok.com/@charlidamelio']) {
      it(`validate: accepts the URL form ${pasted}`, () => {
        const [ok, err] = osint.validate(tk, pasted);
        expect(ok, err).toBe(true);
      });
    }

    for (const junk of ['', '   ', 'a', 'x'.repeat(25), 'has space', 'not a handle!',
      'a@b.com']) {
      it(`validate: rejects tiktok '${junk}'`, () => {
        const [ok] = osint.validate(tk, junk);
        expect(ok).toBe(false);
      });
    }

    it('validate: tiktok names its own label in the error', () => {
      const [ok, err] = osint.validate(tk, '   ');
      expect(ok).toBe(false);
      expect(err.includes('TikTok')).toBe(true);
    });
  });

  describe('instagram', () => {
    // A handle, or the numeric IGID the crawler record yields.
    const ig = osint.OSINT_KINDS['instagram']!;

    for (const value of ['nasa', '@nasa', 'user.name_1', 'a', 'x'.repeat(30),
      '528817151', '17841401474538262']) {
      it(`validate: accepts instagram '${value}'`, () => {
        const [ok, err] = osint.validate(ig, value);
        expect(ok, err).toBe(true);
      });
    }

    for (const pasted of ['https://www.instagram.com/nasa',
      'https://www.instagram.com/nasa/',
      'instagram.com/nasa',
      'www.instagram.com/nasa?hl=en',
      'm.instagram.com/nasa']) {
      it(`validate: accepts the URL form ${pasted}`, () => {
        const [ok, err] = osint.validate(ig, pasted);
        expect(ok, err).toBe(true);
      });
    }

    // A pasted *post* URL reduces to its author, who is the account.
    it('validate: an instagram post URL reduces to its author', () => {
      const [ok, err] = osint.validate(ig, 'https://www.instagram.com/nasa/p/CxYzAbCdEf/');
      expect(ok, err).toBe(true);
    });

    for (const junk of ['', '   ', 'x'.repeat(31), 'has space', 'not a handle!', 'a@b.com']) {
      it(`validate: rejects instagram '${junk}'`, () => {
        const [ok] = osint.validate(ig, junk);
        expect(ok).toBe(false);
      });
    }

    // Site furniture must not silently become a handle — `/p/...` is a post,
    // `/explore/...` is a feed, and neither is an account.
    for (const furniture of ['https://www.instagram.com/p/CxYzAbCdEf/',
      'https://www.instagram.com/explore/tags/nasa/',
      'https://www.instagram.com/reel/CxYzAbCdEf/']) {
      it(`validate: rejects instagram furniture ${furniture}`, () => {
        const [ok] = osint.validate(ig, furniture);
        expect(ok).toBe(false);
      });
    }

    it('validate: instagram names its own label in the error', () => {
      const [ok, err] = osint.validate(ig, '   ');
      expect(ok).toBe(false);
      expect(err.includes('Instagram')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('normalise', () => {
  // Domain lowercased, local part's case preserved — the local part is
  // technically case-sensitive and lowercasing it would change the address.
  it('normalise: lowercases the domain only', () => {
    expect(osint.normaliseEmail('  Bob.Smith@GMail.COM ')).toBe('Bob.Smith@gmail.com');
  });
  it('normalise: leaves a non-address untouched', () => {
    expect(osint.normaliseEmail('  just-a-handle ')).toBe('just-a-handle');
  });
  // lastIndexOf, not split: a quoted local part may itself contain '@'.
  it("normalise: splits on the last '@'", () => {
    expect(osint.normaliseEmail('"a@b"@Example.com')).toBe('"a@b"@example.com');
  });

  // The github normaliser unwraps a pasted profile URL, case preserved (a
  // handle's case is cosmetic, so it is left as typed).
  const gh = osint.OSINT_KINDS['github']!;
  it('normalise: a bare github handle is unchanged', () => {
    expect(osint.normaliseGithub('torvalds')).toBe('torvalds');
  });
  it('normalise: strips a github profile URL', () => {
    expect(osint.normaliseGithub('https://github.com/torvalds')).toBe('torvalds');
  });
  it('normalise: strips a trailing slash and surrounding space', () => {
    expect(osint.normaliseGithub('  github.com/Torvalds/  ')).toBe('Torvalds');
  });
  // A URL with a path is a repo, and is deliberately NOT unwrapped — it must
  // then fail validation rather than silently recon the wrong thing.
  it('normalise: a repo URL is left to fail validation', () => {
    expect(osint.normaliseGithub('https://github.com/torvalds/linux'))
      .toBe('torvalds/linux');
  });

  // The discord normaliser unwraps a pasted profile URL, which on Discord
  // carries the numeric id rather than a handle.
  it('normalise: a bare discord handle is unchanged', () => {
    expect(osint.normaliseDiscord('someuser')).toBe('someuser');
  });
  it('normalise: strips a discord profile URL to its id', () => {
    expect(osint.normaliseDiscord('https://discord.com/users/80351110224678912'))
      .toBe('80351110224678912');
  });
  it('normalise: strips a discordapp URL too', () => {
    expect(osint.normaliseDiscord('https://discordapp.com/users/80351110224678912'))
      .toBe('80351110224678912');
  });
  it('normalise: strips a trailing slash and surrounding space', () => {
    expect(osint.normaliseDiscord('  discord.com/users/80351110224678912/  '))
      .toBe('80351110224678912');
  });
  // A mention (`<@id>` / `<@!id>`) is another way an id arrives in a paste.
  it('normalise: unwraps a user mention', () => {
    expect(osint.normaliseDiscord('<@80351110224678912>')).toBe('80351110224678912');
    expect(osint.normaliseDiscord('<@!80351110224678912>')).toBe('80351110224678912');
  });
  // The legacy discriminator is part of the identity and is NOT stripped —
  // it dates the account, which is a finding.
  it('normalise: keeps a legacy discriminator', () => {
    expect(osint.normaliseDiscord('  OldUser#1234  ')).toBe('OldUser#1234');
  });

  // The shared dispatch picks the right one per kind, so the UI label, the
  // evidence path and the playbook cannot disagree.
  it('normalise: dispatches by kind', () => {
    expect(osint.normalise(gh, 'https://github.com/torvalds')).toBe('torvalds');
    expect(osint.normalise(osint.OSINT_KINDS['email']!, ' Bob@GMail.COM ')).toBe('Bob@gmail.com');
    expect(osint.normalise(osint.OSINT_KINDS['phone']!, '  +1555  ')).toBe('+1555');
    expect(osint.normalise(osint.OSINT_KINDS['discord']!,
      'https://discord.com/users/80351110224678912')).toBe('80351110224678912');
    expect(osint.normalise(osint.OSINT_KINDS['facebook']!,
      'https://www.facebook.com/nasa')).toBe('nasa');
    expect(osint.normalise(osint.OSINT_KINDS['tiktok']!,
      'https://www.tiktok.com/@charlidamelio?lang=en')).toBe('charlidamelio');
    expect(osint.normalise(osint.OSINT_KINDS['instagram']!,
      'https://www.instagram.com/nasa/')).toBe('nasa');
  });

  // The facebook normaliser picks the *durable* identifier out of a URL: the
  // numeric id survives a rename, the display name does not.
  it('normalise: facebook takes the id from /people/<name>/<id>/', () => {
    expect(osint.normaliseFacebook('https://www.facebook.com/people/Mark-Zuckerberg/4/'))
      .toBe('4');
  });
  it('normalise: facebook takes the id from profile.php?id=', () => {
    expect(osint.normaliseFacebook('https://www.facebook.com/profile.php?id=4')).toBe('4');
  });
  it('normalise: facebook drops tracking query and fragment', () => {
    expect(osint.normaliseFacebook('https://web.facebook.com/nasa?__cft__[0]=abc#frag'))
      .toBe('nasa');
  });
  it('normalise: facebook recovers the account from a subpage', () => {
    expect(osint.normaliseFacebook('https://www.facebook.com/nasa/photos')).toBe('nasa');
  });
  it('normalise: facebook leaves a bare id alone', () => {
    expect(osint.normaliseFacebook('  100012345678901  ')).toBe('100012345678901');
  });

  // The tiktok normaliser unwraps every host and strips the query strings,
  // including the dead `m.` host, which is unwrapped so a stale paste still
  // becomes a handle that works on `www.`.
  it('normalise: strips a tiktok profile URL', () => {
    expect(osint.normaliseTiktok('https://www.tiktok.com/@charlidamelio')).toBe('charlidamelio');
  });
  it('normalise: strips a tiktok query string', () => {
    expect(osint.normaliseTiktok('https://www.tiktok.com/@charlidamelio?is_from_webapp=1'))
      .toBe('charlidamelio');
  });
  it('normalise: strips the dead m. tiktok host', () => {
    expect(osint.normaliseTiktok('https://m.tiktok.com/@charlidamelio')).toBe('charlidamelio');
  });
  it('normalise: strips a leading @ from a tiktok handle', () => {
    expect(osint.normaliseTiktok('@charlidamelio')).toBe('charlidamelio');
  });

  // The instagram normaliser unwraps the host, the `@`, and the query, and
  // reduces a post URL to its author.
  it('normalise: strips an instagram profile URL', () => {
    expect(osint.normaliseInstagram('https://www.instagram.com/nasa/')).toBe('nasa');
  });
  it('normalise: strips an instagram query string', () => {
    expect(osint.normaliseInstagram('www.instagram.com/nasa?hl=en')).toBe('nasa');
  });
  it('normalise: strips a leading @ from an instagram handle', () => {
    expect(osint.normaliseInstagram('@nasa')).toBe('nasa');
  });
  it('normalise: reduces an instagram post URL to its author', () => {
    expect(osint.normaliseInstagram('https://www.instagram.com/nasa/p/CxYzAbCdEf/'))
      .toBe('nasa');
  });
});

// ---------------------------------------------------------------------------
// Slug and case directory
// ---------------------------------------------------------------------------

describe('case dir', () => {
  const email = osint.OSINT_KINDS['email']!;
  const cfg = cfgFor(TMP);
  cfg.stateDir = path.join(TMP, 'state');

  it('slug: keeps safe characters, drops the rest', () => {
    expect(osint.caseSlug('Bob.Smith+news@Gmail.com')).toBe('bob.smith-news-gmail.com');
  });

  // A target that is all symbols must not produce an empty path segment.
  it('slug: never empty', () => {
    expect(osint.caseSlug('!!!')).toBe('target');
  });

  const d = osint.caseDir(cfg, email, 'Bob@Example.com');
  it('case_dir: is created', () => expect(isDir(d)).toBe(true));
  it('case_dir: lives under state_dir/osint', () => {
    expect(path.dirname(d)).toBe(path.join(cfg.stateDir, 'osint'));
  });
  it('case_dir: named <kind>-<slug>-<stamp>', () => {
    expect(path.basename(d).startsWith('email-bob-example.com-')).toBe(true);
  });

  // The timestamp is second-resolution; two calls in the same second collide
  // by design (same case), so assert the shape rather than uniqueness. The
  // stamp is the last TWO dash-separated segments (the slug itself contains
  // dashes, so taking only the last segment would return only the clock half).
  it('case_dir: stamp is YYYYMMDD-HHMMSS', () => {
    const stamp = path.basename(d).split('-').slice(-2).join('-');
    expect(stamp.length).toBe(15);
    expect(stamp[8]).toBe('-');
    expect(stamp.replace(/-/g, '')).toMatch(/^\d+$/);
  });

  // A github case is slugged from the NORMALISED handle, so a pasted URL
  // does not produce a path segment like "github.com-torvalds".
  const gh = osint.OSINT_KINDS['github']!;
  const gd = osint.caseDir(cfg, gh, 'https://github.com/torvalds');
  it('case_dir: github slugs the bare handle, not the URL', () => {
    expect(path.basename(gd).startsWith('github-torvalds-')).toBe(true);
  });
  it('case_dir: no URL fragments in the path', () => {
    expect(path.basename(gd).includes('github.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finalising a case — archive the report, delete the rest
// ---------------------------------------------------------------------------

describe('finalise', () => {
  const email = osint.OSINT_KINDS['email']!;
  const cfg = cfgFor(TMP);
  cfg.stateDir = path.join(TMP, 'fin-state');

  // ---- a completed run: report archived, case dir gone -------------------
  const case1 = osint.caseDir(cfg, email, 'done@example.com');
  fs.writeFileSync(path.join(case1, 'report.md'), '# Email OSINT — done@example.com\n');
  // Bulky evidence that must NOT survive the cleanup.
  fs.mkdirSync(path.join(case1, 'clone'));
  fs.writeFileSync(path.join(case1, 'clone', 'big.git'), 'x'.repeat(5000));

  const [report, cleaned] = osint.finaliseCase(cfg, case1);
  it('finalise: returns the archived report path', () => {
    expect(report).not.toBeNull();
  });
  it('finalise: the report is archived under reports/', () => {
    expect(path.dirname(report!)).toBe(path.join(cfg.stateDir, 'reports'));
  });
  it('finalise: the archived report keeps the case name', () => {
    expect(path.basename(report!)).toBe(`${path.basename(case1)}.md`);
  });
  it('finalise: the report content survived the move', () => {
    expect(fs.readFileSync(report!, 'utf8').includes('done@example.com')).toBe(true);
  });
  it('finalise: the case directory was deleted', () => {
    expect(fs.existsSync(case1)).toBe(false);
  });
  it('finalise: reports that cleaned is True', () => {
    expect(cleaned).toBe(true);
  });

  // ---- a failed run: no report, so nothing is deleted --------------------
  // The whole point: a run that produced no report must keep its evidence,
  // never be tidied away on the assumption it finished.
  const case2 = osint.caseDir(cfg, email, 'failed@example.com');
  fs.writeFileSync(path.join(case2, 'profile.json'), '{}');
  const [report2, cleaned2] = osint.finaliseCase(cfg, case2);
  it('finalise: no report yields no path', () => {
    expect(report2).toBeNull();
  });
  it('finalise: no report leaves the case dir in place', () => {
    expect(fs.existsSync(case2)).toBe(true);
  });
  it('finalise: no report reports cleaned False', () => {
    expect(cleaned2).toBe(false);
  });
  it('finalise: no report keeps the collected evidence', () => {
    expect(isFile(path.join(case2, 'profile.json'))).toBe(true);
  });

  // ---- a report under a different name or in a subdir is still found -----
  // The agent does not always follow the filename to the letter; a report it
  // did write must still be archived rather than deleted as evidence.
  const case3 = osint.caseDir(cfg, email, 'nested@example.com');
  fs.mkdirSync(path.join(case3, 'out'));
  fs.writeFileSync(path.join(case3, 'out', 'Report.md'), '# nested\n');
  const [report3, cleaned3] = osint.finaliseCase(cfg, case3);
  it('finalise: finds a report in a subdirectory', () => {
    expect(report3).not.toBeNull();
  });
  it('finalise: nested case dir still deleted', () => {
    expect(fs.existsSync(case3)).toBe(false);
  });
  it('finalise: nested run cleaned True', () => {
    expect(cleaned3).toBe(true);
  });

  // A non-report .md must not be mistaken for the report.
  const case4 = osint.caseDir(cfg, email, 'notes@example.com');
  fs.writeFileSync(path.join(case4, 'notes.md'), 'scratch\n');
  const [report4] = osint.finaliseCase(cfg, case4);
  it('finalise: a stray .md is not treated as the report', () => {
    expect(report4).toBeNull();
  });
  it('finalise: a stray .md leaves the case dir alone', () => {
    expect(fs.existsSync(case4)).toBe(true);
  });

  // A report.md that belongs to a CLONED repo is not this run's report. The
  // run's own report must win, and the clone's must not be archived as it —
  // mistaking them would archive the wrong file and delete the real evidence.
  const case5 = osint.caseDir(cfg, email, 'cloned@example.com');
  fs.writeFileSync(path.join(case5, 'report.md'), "# the run's report\n");
  const repo5 = path.join(case5, 'clone', 'some.git');
  fs.mkdirSync(repo5, { recursive: true });
  fs.writeFileSync(path.join(repo5, 'report.md'), "# the repo's own report\n");
  const [report5] = osint.finaliseCase(cfg, case5);
  it("finalise: the run's report wins over a clone's", () => {
    expect(report5).not.toBeNull();
    expect(fs.readFileSync(report5!, 'utf8').includes("the run's report")).toBe(true);
  });

  // With NO top-level report, a clone's report.md must not be promoted: the
  // case dir is kept so the operator can see the run never produced one.
  const case6 = osint.caseDir(cfg, email, 'cloneonly@example.com');
  const repo6 = path.join(case6, 'clone', 'only.git');
  fs.mkdirSync(repo6, { recursive: true });
  fs.writeFileSync(path.join(repo6, 'report.md'), "# not the run's\n");
  const [report6] = osint.finaliseCase(cfg, case6);
  it("finalise: a clone's report is never promoted", () => {
    expect(report6).toBeNull();
  });
  it('finalise: a clone-only case dir is kept', () => {
    expect(fs.existsSync(case6)).toBe(true);
  });

  // reports_dir is the documented location and agrees with what finalise used.
  it('finalise: reports_dir matches the archive parent', () => {
    expect(osint.reportsDir(cfg)).toBe(path.join(cfg.stateDir, 'reports'));
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe('prompt', () => {
  const email = osint.OSINT_KINDS['email']!;
  const caseDirPath = path.join(TMP, 'case');
  const p = osint.buildPrompt(email, 'Bob@Example.com', caseDirPath);

  // The target must be normalised in the prompt, and the case dir must be an
  // absolute path the agent can write to from its first tool call.
  it('prompt: carries the normalised target', () => {
    expect(p.includes('Bob@example.com')).toBe(true);
  });
  it('prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });

  // The placeholders must be fully substituted — a stray brace would reach
  // the model as literal text.
  it('prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });

  // The authorised-use condition is stated in every prompt, not just the UI.
  it('prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });

  // Spot-check that the phases the operator asked for actually survive into
  // the briefing, so an edit that drops one is caught here.
  for (const needle of ['Validation', 'Gravatar', 'Breach', 'Account discovery',
    'Identity correlation', 'Domain intelligence', 'Paste']) {
    it(`prompt: covers the ${needle.split(' ')[0]} phase`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }
  it('prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  // The report format is shared with the github playbook, so both kinds must
  // carry the same five-line finding block, coverage table and closing
  // section. A drift between the two is what this catches.
  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  // An unbuilt kind still yields a string rather than raising.
  const stub = osint.OSINT_KINDS['phone']!;
  const s = osint.buildPrompt(stub, '+15551234567', caseDirPath);
  it('prompt: an unbuilt kind degrades gracefully', () => {
    expect(s.includes('phone')).toBe(true);
    expect(s.includes('+15551234567')).toBe(true);
  });
});

describe('prompt github', () => {
  const gh = osint.OSINT_KINDS['github']!;
  const caseDirPath = path.join(TMP, 'ghcase');
  const p = osint.buildPrompt(gh, 'torvalds', caseDirPath);

  it('github prompt: carries the handle', () => {
    expect(p.includes('torvalds')).toBe(true);
  });
  it('github prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });
  it('github prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });
  it('github prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });

  // A pasted URL must be normalised out of the briefing, so the agent and
  // the report title both see a bare handle.
  const pUrl = osint.buildPrompt(gh, 'https://github.com/torvalds', caseDirPath);
  it('github prompt: normalises a pasted profile URL', () => {
    expect(pUrl.includes('github — GitHub username: torvalds')).toBe(true);
    expect(pUrl.includes('github.com/torvalds')).toBe(false);
  });

  // The phases the operator asked for — email discovery above all, since
  // that is the stated purpose of the command.
  for (const needle of ['Account profiling', 'Email discovery', 'commit',
    '.patch', '.mailmap', 'GPG', 'Repository inventory', 'Secrets', 'Social graph',
    'Timeline']) {
    it(`github prompt: covers '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  it('github prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('github prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  // The one restraint that matters: a leaked secret is described, never
  // reproduced into the report.
  it("github prompt: says not to reproduce secrets", () => {
    expect(p.includes('without reproducing the secret')).toBe(true);
  });

  // Same shared report format as the email playbook — this is the assertion
  // that keeps the two kinds' reports structurally identical.
  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`github prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  // The speed work: the run must lead with the unmetered git path and batch
  // its API calls rather than spending one round-trip per fact. These pin the
  // instructions that make the difference, so an edit cannot quietly undo it.
  it('github prompt: checks the rate limit up front', () => {
    expect(p.includes('rate_limit')).toBe(true);
  });
  it('github prompt: promotes the clone over the API', () => {
    expect(p.includes('not metered') || p.includes('not\n    metered')
      || p.includes('unmetered')).toBe(true);
  });
  it('github prompt: tells the agent to batch per phase', () => {
    expect(p.includes('ONE script') || p.includes('One script')).toBe(true);
  });
  it('github prompt: says the API budget is 60/hour', () => {
    expect(p.includes('60 requests')).toBe(true);
  });
});

describe('prompt discord', () => {
  const dc = osint.OSINT_KINDS['discord']!;
  const caseDirPath = path.join(TMP, 'dccase');
  const p = osint.buildPrompt(dc, 'someuser', caseDirPath);

  it('discord prompt: carries the handle', () => {
    expect(p.includes('someuser')).toBe(true);
  });
  it('discord prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });
  it('discord prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });
  it('discord prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });
  it('discord prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('discord prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  // Same shared report format as the other two playbooks — this is the
  // assertion that keeps every kind's report structurally identical, and so
  // parseable by the same tree reader.
  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`discord prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  // A pasted URL must be normalised to the bare id, so the agent and the
  // report title both see the identifier rather than a URL.
  const pUrl = osint.buildPrompt(dc, 'https://discord.com/users/80351110224678912',
    caseDirPath);
  it('discord prompt: normalises a pasted profile URL', () => {
    expect(pUrl.includes('80351110224678912')).toBe(true);
    expect(pUrl.includes('discord.com/users/8')).toBe(false);
  });

  // ---- the measured facts -------------------------------------------
  // Discord is the most closed kind, and the playbook's value is that it says
  // so. These pin the facts established by probing the live API, so that an
  // edit cannot quietly reintroduce an endpoint that returns 401 and cost a
  // whole run rediscovering it.
  it('discord prompt: warns there is no unauthenticated user endpoint', () => {
    expect(p.includes('401')).toBe(true);
    expect(p.toLowerCase().includes('no unauthenticated user endpoint')).toBe(true);
  });
  it('discord prompt: names the rate-limited username probe', () => {
    expect(p.includes('username-attempt-unauthed')).toBe(true);
  });
  it('discord prompt: warns the rate limit escalates', () => {
    expect(p.includes('retry_after')).toBe(true);
    expect(p.includes('climbs')).toBe(true);
  });
  it('discord prompt: says the probe is one call, not a loop', () => {
    expect(p.includes('Never put it in a loop')).toBe(true);
  });
  it('discord prompt: warns the widget is anonymised', () => {
    expect(p.includes('anonymised')).toBe(true);
    expect(p.includes('"0","1","2"')).toBe(true);
  });
  it('discord prompt: says the profile page is a JS shell', () => {
    expect(p.includes('JavaScript shell')).toBe(true);
  });

  // The free, local, exact derivation — the anchor fact of the run.
  it('discord prompt: gives the snowflake epoch arithmetic', () => {
    expect(p.includes('(id >> 22) + 1420070400000')).toBe(true);
  });
  it('discord prompt: gives the default-avatar derivation', () => {
    expect(p.includes('embed/avatars/')).toBe(true);
    expect(p.includes('(id >> 22) % 6')).toBe(true);
  });

  // The pivot, which is where the run actually earns its keep.
  for (const needle of ['sherlock', 'maigret', 'cross-platform', 'reverse-image']) {
    it(`discord prompt: covers '${needle}'`, () => {
      expect(p.toLowerCase().includes(needle)).toBe(true);
    });
  }

  // The restraint that matters, same as github's: a leaked token is
  // described, never reproduced.
  it('discord prompt: says not to reproduce leaked tokens', () => {
    expect(p.includes('without\n     reproducing the token itself')
      || p.includes('reproducing the token itself')).toBe(true);
  });

  // The token tier is offered honestly — used if the operator supplied one,
  // never scraped, and reported as a gap when absent.
  it('discord prompt: mentions the token tier', () => {
    expect(p.includes('DISCORD_TOKEN')).toBe(true);
  });
  it('discord prompt: forbids a scraped token', () => {
    expect(p.includes('never a scraped')).toBe(true);
  });

  // The report must end by saying what was NOT reachable. For this kind that
  // is one of the most useful sections, so it is pinned.
  it('discord prompt: requires a limits section', () => {
    expect(p.includes('LIMITS')).toBe(true);
    expect(p.includes('a token would have added')).toBe(true);
  });
});

describe('prompt facebook', () => {
  const fb = osint.OSINT_KINDS['facebook']!;
  const caseDirPath = path.join(TMP, 'fbcase');
  const p = osint.buildPrompt(fb, 'nasa', caseDirPath);

  it('facebook prompt: carries the target', () => {
    expect(p.includes('nasa')).toBe(true);
  });
  it('facebook prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });
  it('facebook prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });
  it('facebook prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });
  it('facebook prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('facebook prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`facebook prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  // A pasted URL must reduce to the identifier the agent and the report
  // title both use.
  const pUrl = osint.buildPrompt(fb, 'https://www.facebook.com/nasa', caseDirPath);
  it('facebook prompt: normalises a pasted profile URL', () => {
    expect(pUrl.includes('nasa')).toBe(true);
    expect(pUrl.includes('facebook.com/nasa')).toBe(false);
  });

  // ---- the measured facts -------------------------------------------
  // Facebook is the most closed surface, and the playbook's whole value is
  // that it says so. These pin the walls established by probing the live
  // site, so an edit cannot quietly reintroduce a dead endpoint.
  it('facebook prompt: says the web surface is an error, not a login wall', () => {
    expect(p.includes('400')).toBe(true);
    expect(p.replace(/\n/g, ' ').includes('not** a profile and **not** a login')).toBe(true);
  });
  it('facebook prompt: warns the crawler trick is dead', () => {
    expect(p.replace(/\n/g, ' ').includes('crawler User-Agent trick is dead')).toBe(true);
  });
  it('facebook prompt: names both Graph walls and their distinct codes', () => {
    expect(p.includes('code":104')).toBe(true);
    expect(p.includes('code":200')).toBe(true);
    expect(p.includes('403')).toBe(true);
  });
  it('facebook prompt: names the avatar endpoint as the one live source', () => {
    expect(p.includes('graph.facebook.com')).toBe(true);
    expect(p.includes('/picture')).toBe(true);
  });
  it('facebook prompt: says the avatar endpoint is an existence oracle', () => {
    expect(p.toLowerCase().includes('existence oracle')).toBe(true);
  });
  it('facebook prompt: gives the default-avatar hash to test against', () => {
    expect(p.includes('3e8f62364b0f574a7d18a6c8b26730f1')).toBe(true);
  });
  it('facebook prompt: names the Internet Archive as the richest source', () => {
    expect(p.includes('Internet Archive')).toBe(true);
    expect(p.toLowerCase().includes('wayback')).toBe(true);
  });
  it('facebook prompt: warns off the refuted avatar-filename pivot', () => {
    expect(p.includes('middle and last fields both return 400')).toBe(true);
    expect(p.includes("not the page's own")).toBe(true);
  });

  // A leaked credential is described, never copied into the report — the
  // same restraint every other kind's playbook carries.
  it('facebook prompt: says to describe not reproduce a secret', () => {
    expect(p.includes('never reproduce it')).toBe(true);
    expect(p.includes('do not write\n     the value')).toBe(true);
  });

  it('facebook prompt: requires a limits section', () => {
    expect(p.includes('LIMITS')).toBe(true);
    expect(p.includes('without a token')).toBe(true);
  });
});

describe('prompt tiktok', () => {
  const tk = osint.OSINT_KINDS['tiktok']!;
  const caseDirPath = path.join(TMP, 'tkcase');
  const p = osint.buildPrompt(tk, 'charlidamelio', caseDirPath);

  it('tiktok prompt: carries the handle', () => {
    expect(p.includes('charlidamelio')).toBe(true);
  });
  it('tiktok prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });
  it('tiktok prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });
  it('tiktok prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });
  it('tiktok prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('tiktok prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`tiktok prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  const pUrl = osint.buildPrompt(tk, 'https://www.tiktok.com/@charlidamelio?lang=en',
    caseDirPath);
  it('tiktok prompt: normalises a pasted profile URL', () => {
    expect(pUrl.includes('charlidamelio')).toBe(true);
    expect(pUrl.includes('?lang=en')).toBe(false);
  });

  // ---- the measured facts -------------------------------------------
  it('tiktok prompt: names the rehydration blob as the payload', () => {
    expect(p.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__')).toBe(true);
  });
  it('tiktok prompt: warns there are no og: tags in the raw HTML', () => {
    expect(p.includes('og:')).toBe(true);
    expect(p.includes('JavaScript')).toBe(true);
  });
  it('tiktok prompt: names oembed as the rate-limited wall', () => {
    expect(p.toLowerCase().includes('oembed')).toBe(true);
    expect(p.includes('429')).toBe(true);
    expect(p.includes('ratelimit triggered')).toBe(true);
  });
  it('tiktok prompt: says the oembed limiter is independent of the HTML one', () => {
    expect(p.toLowerCase().includes('independent')).toBe(true);
  });
  it('tiktok prompt: says the HTTP status carries no existence signal', () => {
    expect(p.includes('200')).toBe(true);
    expect(p.includes('userInfo')).toBe(true);
    expect(p.includes('10221')).toBe(true);
  });
  it('tiktok prompt: warns statusMsg lies', () => {
    expect(p.includes('user banned')).toBe(true);
  });
  it('tiktok prompt: says the mobile surface is gone', () => {
    expect(p.includes('404')).toBe(true);
    expect(p.includes('m.tiktok.com')).toBe(true);
  });
  it('tiktok prompt: says the internal API returns an empty body', () => {
    expect(p.includes('zero-byte') || p.toLowerCase().includes('empty body')).toBe(true);
  });
  it('tiktok prompt: says to use statsV2 not stats', () => {
    expect(p.includes('statsV2')).toBe(true);
  });
  it('tiktok prompt: says the snowflake decode does not work', () => {
    expect(p.toLowerCase().includes('snowflake')).toBe(true);
    expect(p.toLowerCase().includes('does not work')).toBe(true);
  });
  it('tiktok prompt: says createTime is plain Unix seconds', () => {
    expect(p.includes('createTime')).toBe(true);
    expect(p.toLowerCase().includes('seconds')).toBe(true);
  });
  it('tiktok prompt: says secUid is opaque', () => {
    expect(p.includes('secUid')).toBe(true);
    expect(p.toLowerCase().includes('opaque')).toBe(true);
  });

  it('tiktok prompt: requires a limits section', () => {
    expect(p.includes('LIMITS')).toBe(true);
  });
});

describe('prompt instagram', () => {
  const ig = osint.OSINT_KINDS['instagram']!;
  const caseDirPath = path.join(TMP, 'igcase');
  const p = osint.buildPrompt(ig, 'nasa', caseDirPath);

  it('instagram prompt: carries the handle', () => {
    expect(p.includes('nasa')).toBe(true);
  });
  it('instagram prompt: carries the case dir', () => {
    expect(p.includes(caseDirPath)).toBe(true);
  });
  it('instagram prompt: no unsubstituted placeholders', () => {
    expect(p.includes('{target}')).toBe(false);
    expect(p.includes('{case_dir}')).toBe(false);
  });
  it('instagram prompt: states the authorised-use condition', () => {
    expect(p.includes('Authorised investigation only')).toBe(true);
  });
  it('instagram prompt: asks for report.md', () => {
    expect(p.includes('report.md')).toBe(true);
  });
  it('instagram prompt: defines the confidence levels', () => {
    expect(p.includes('CONFIRMED')).toBe(true);
    expect(p.includes('PROBABLE')).toBe(true);
    expect(p.includes('UNVERIFIED')).toBe(true);
  });

  for (const needle of ['**What**', '**Where**', '**Confidence**', '**Means**',
    '**Verify**', '| Phase | Ran? | Result |', '## Headline', 'Gaps and next steps']) {
    it(`instagram prompt: report format has '${needle}'`, () => {
      expect(p.includes(needle)).toBe(true);
    });
  }

  const pUrl = osint.buildPrompt(ig, 'https://www.instagram.com/nasa/', caseDirPath);
  it('instagram prompt: normalises a pasted profile URL', () => {
    expect(pUrl.includes('nasa')).toBe(true);
    expect(pUrl.includes('instagram.com/nasa')).toBe(false);
  });

  // ---- the measured facts -------------------------------------------
  // Instagram is the kind where the *obvious* route fails in a way that looks
  // like success, so the walls are the most important part of the playbook.
  it('instagram prompt: says ?__a=1 is a zero-byte 201', () => {
    expect(p.includes('__a=1')).toBe(true);
    expect(p.includes('201')).toBe(true);
    expect(p.includes('zero-byte')).toBe(true);
  });
  it('instagram prompt: says every JSON API endpoint needs a login', () => {
    expect(p.includes('401')).toBe(true);
    expect(p.includes('require_login')).toBe(true);
  });
  it('instagram prompt: names the enumeration oracles as 429', () => {
    expect(p.includes('429')).toBe(true);
    expect(p.includes('web_create_ajax')).toBe(true);
  });
  it('instagram prompt: says the profile HTML is identical real vs fake', () => {
    expect(p.includes('byte-identical')).toBe(true);
    expect(p.includes('634')).toBe(true);
  });
  it('instagram prompt: says the profile URL carries no existence signal', () => {
    expect(p.includes('tells you nothing')).toBe(true);
    expect(p.includes('byte-identical')).toBe(true);
  });
  it('instagram prompt: names the crawler surface as the one live route', () => {
    expect(p.includes('Googlebot')).toBe(true);
    expect(p.includes('RelayPreloader')).toBe(true);
  });
  it('instagram prompt: gives the exact Googlebot UA string', () => {
    expect(p.includes('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'))
      .toBe(true);
  });
  it('instagram prompt: warns the gate is the exact string, not the word', () => {
    expect(p.includes('bare `Googlebot/2.1`') || p.includes('bare Googlebot')).toBe(true);
  });
  it('instagram prompt: names the record key to parse', () => {
    expect(p.includes('xig_user_by_igid_v2')).toBe(true);
  });
  it('instagram prompt: names the record fields', () => {
    expect(p.includes('follower_count')).toBe(true);
    expect(p.includes('biography')).toBe(true);
    expect(p.includes('is_private')).toBe(true);
  });
  it('instagram prompt: says the crawler size difference is the oracle', () => {
    expect(p.includes('1.3 MB')).toBe(true);
    expect(p.includes('634 KB')).toBe(true);
  });
  it('instagram prompt: says the IGID prefix is a fixed namespace', () => {
    expect(p.includes('178414')).toBe(true);
    expect(p.includes('namespace')).toBe(true);
  });
  it('instagram prompt: says there is no creation timestamp', () => {
    expect(p.toLowerCase().includes('no creation timestamp')
      || p.includes('creation timestamp')).toBe(true);
  });
  it('instagram prompt: warns off the snowflake decode', () => {
    expect(p.toLowerCase().includes('snowflake')).toBe(true);
  });
  it('instagram prompt: warns third-party viewers are unreliable', () => {
    expect(p.toLowerCase().includes('third-party')).toBe(true);
    expect(p.toLowerCase().includes('hijacked')).toBe(true);
  });
  it('instagram prompt: says the Facebook picture pivot does not resolve', () => {
    expect(p.includes('graph.facebook.com')).toBe(true);
    expect(p.toLowerCase().includes('silhouette')).toBe(true);
  });

  it('instagram prompt: requires a limits section', () => {
    expect(p.includes('LIMITS')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wiring — the command must be reachable from every surface
// ---------------------------------------------------------------------------

describe('wiring', () => {
  // Read from the sources rather than importing a copy, so a rename cannot
  // drift past this. The Python single file ui/app.py is split across
  // app.tsx (dispatch + palette), screens/campaigns.tsx (the handlers) and
  // screens/commands.tsx (the help table) in the port; each check reads the
  // file that now owns that surface.
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.tsx'), 'utf8');
  const campaignsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'screens', 'campaigns.tsx'), 'utf8');
  const commandsSrc = fs.readFileSync(
    path.join(ROOT, 'src', 'ui', 'screens', 'commands.tsx'), 'utf8');

  it('wiring: /osint is in the completion menu', () => {
    const names = SLASH_COMMANDS.map(([c]) => c);
    expect(names.includes('/osint')).toBe(true);
  });

  it('wiring: dispatch has an osint entry', () => {
    expect(appSrc.includes('osint: (a) => cmdOsint(')).toBe(true);
  });
  it('wiring: cmdOsint is defined', () => {
    expect(campaignsSrc.includes('export function cmdOsint(')).toBe(true);
  });
  it('wiring: help table lists it', () => {
    expect(commandsSrc.includes("'/osint [kind] <target>'")).toBe(true);
  });
  it('wiring: palette lists it', () => {
    expect(appSrc.includes("['/osint', 'open-source recon on a target', 'osint']")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The command handlers (Python test_ui, ported at the handler seam — see the
// file contract block for why there is no Ink run_test pilot)
// ---------------------------------------------------------------------------

describe('ui', () => {
  const cfg = cfgFor(TMP, { bootRain: false });
  // A state_dir of its own, not the one the case-dir tests use: the case-dir
  // stamp is second-resolution, so two tests creating a directory for the
  // same target within the same second land on the SAME path (mkdir with
  // recursive reuses it). Sharing would make any count- or delta-based
  // assertion here depend on how fast the suite runs.
  cfg.stateDir = path.join(TMP, 'ui-state');

  const palette: Palette = {
    name: 'green',
    bg: '#000000',
    primary: '#00ff41',
    dim: '#0b6e2a',
    accent: '#00ffaa',
    red: '#ff3333',
    amber: '#ffb000',
    glow: '#00ff41',
  };

  /** The say/sysLine/turn capture — Python spied ChatPane.write_block. */
  const says: unknown[] = [];
  const lines: string[] = [];
  const turns: Array<{ text: string; opts?: Parameters<AppCtx['runTurn']>[1] }> = [];
  const turnPromises: Promise<void>[] = [];
  // The model stub for the in-flight turn — Python's held_stream /
  // reporting_stream, swapped per scenario.
  let turnBehaviour: ((caseDir: string) => Promise<void>) | null = null;

  const ctx = {
    cfg,
    mods: () => ({ osint, osintTree } as unknown as Mods),
    pal: () => palette,
    say: (node: unknown) => {
      says.push(node);
    },
    sysLine: (message: string) => {
      lines.push(message);
    },
    busyRef: { current: false },
    setBusyBoth: (v: boolean) => {
      ctx.busyRef.current = v;
    },
    // Reproduces the one seam of the real app runTurn the Python test_ui was
    // exercising through the pilot: the osint case is finalised after the
    // turn, in the turn's finally, whatever happened inside it
    // (src/ui/app.tsx runTurn → finaliseOsint(ctx, opts.osintCase)).
    runTurn: (text: string, opts?: Parameters<AppCtx['runTurn']>[1]) => {
      const pr = (async () => {
        ctx.setBusyBoth(true);
        try {
          if (opts?.osintCase && turnBehaviour) {
            await turnBehaviour(opts.osintCase);
          }
        } finally {
          if (opts?.osintCase) finaliseOsint(ctx as unknown as AppCtx, opts.osintCase);
          ctx.setBusyBoth(false);
        }
      })();
      turns.push({ text, opts });
      turnPromises.push(pr);
      return pr;
    },
  } as unknown as AppCtx;

  const turnCount = (): number => turns.length;
  const osintRoot = (): string => path.join(cfg.stateDir, 'osint');

  it('ui: bare /osint does not start a turn', () => {
    cmdOsint(ctx, []);
    expect(turnCount()).toBe(0);
  });

  it('ui: unknown kind is refused', () => {
    cmdOsint(ctx, ['nosuchkind', 'foo']);
    expect(turnCount()).toBe(0);
  });

  it('ui: a stub kind does not start a turn', () => {
    cmdOsint(ctx, ['phone', '+15551234567']);
    expect(turnCount()).toBe(0);
  });

  it('ui: a bad email is refused', () => {
    cmdOsint(ctx, ['email', 'not-an-address']);
    expect(turnCount()).toBe(0);
  });
  // No case dir for the *refused* target — checked by its own glob, not
  // by the parent existing, which an earlier block shares.
  it('ui: a refused run creates no case dir', () => {
    expect(globIn(osintRoot(), /^email-not-an-address-/)).toEqual([]);
  });

  it('ui: a bad github handle is refused', () => {
    cmdOsint(ctx, ['github', 'not', 'a', 'handle']);
    expect(turnCount()).toBe(0);
  });
  it('ui: a refused github run creates no case dir', () => {
    expect(globIn(osintRoot(), /^github-not/)).toEqual([]);
  });

  // ---- the happy path launches a turn --------------------------------
  // Python's held_stream: the stub produces no report and the turn is held
  // on a gate (the asyncio.Event) so `busy` is observed genuinely in flight
  // rather than raced against an instant completion.
  let openEmailGate: (() => void) | null = null;

  it('ui: a valid email launches the recon turn', () => {
    const gate = new Promise<void>((resolve) => {
      openEmailGate = resolve;
    });
    turnBehaviour = () => gate;
    cmdOsint(ctx, ['email', 'target@example.com']);
    expect(turnCount()).toBe(1);
    expect(ctx.busyRef.current).toBe(true);
    const last = turns[0]!;
    expect(last.text!.includes('target@example.com')).toBe(true);
    expect(last.opts?.osintCase).toBeDefined();
    // The whole point of the run is report.md — it is declared a deliverable.
    expect(last.opts?.deliverable?.path.endsWith('report.md')).toBe(true);
  });

  it('ui: the case directory was created', () => {
    const made = globIn(osintRoot(), /^email-target-example\.com-/);
    expect(made.length).toBe(1);
  });

  it('ui: the turn completes and the harness idles', async () => {
    openEmailGate!();
    await turnPromises[turnPromises.length - 1]!;
    expect(ctx.busyRef.current).toBe(false);
  });

  // The stub produced no report, so the case dir must be KEPT — a run
  // that did not finish writing is never tidied away.
  it('ui: a run with no report keeps its case dir', () => {
    const made = globIn(osintRoot(), /^email-target-example\.com-/);
    expect(made.length).toBe(1);
    expect(isDir(made[0]!)).toBe(true);
  });

  // ---- github, launched from a pasted profile URL -------------------
  // The URL must be unwrapped before it reaches the case directory, so
  // the evidence path is named after the handle and not the host. The
  // glob is enough on its own: this block has its own state_dir, so any
  // match here is one this run created.
  //
  // This run's stub writes a report into the case dir before finishing,
  // so the finalise path is exercised end to end: report archived,
  // case dir cleared. The turn is held on a gate (Python's asyncio.Event
  // gate.clear()/set()) so the in-flight checks — busy true, the case
  // dir name — are observed while it is genuinely running.
  let openGithubGate: (() => void) | null = null;
  let gmade: string[] = [];

  it('ui: a github URL launches the recon turn', () => {
    const gate = new Promise<void>((resolve) => {
      openGithubGate = resolve;
    });
    turnBehaviour = async (caseDir) => {
      await gate;
      fs.writeFileSync(path.join(caseDir, 'report.md'), '# GitHub OSINT — torvalds\n');
      fs.mkdirSync(path.join(caseDir, 'clone'), { recursive: true });
    };
    cmdOsint(ctx, ['github', 'https://github.com/torvalds']);
    expect(ctx.busyRef.current).toBe(true);
  });

  it('ui: the github case dir is named after the handle', () => {
    gmade = globIn(osintRoot(), /^github-torvalds-/);
    expect(gmade.length).toBe(1);
  });

  it('ui: the github turn completes', async () => {
    openGithubGate!();
    await turnPromises[turnPromises.length - 1]!;
    expect(ctx.busyRef.current).toBe(false);
  });

  // The report was archived and the bulky case dir removed.
  it('ui: the case dir is cleared after a reported run', () => {
    expect(fs.existsSync(gmade[0]!)).toBe(false);
  });
  it('ui: the report is archived under reports/', () => {
    const archived = globIn(path.join(cfg.stateDir, 'reports'), /^github-torvalds-.*\.md$/);
    expect(archived.length).toBe(1);
  });
});
