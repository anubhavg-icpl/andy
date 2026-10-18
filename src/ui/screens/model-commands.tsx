/**
 * model-commands.tsx — /model, /models and the provider-source command family
 * (split from app.tsx once it passed ~3k lines).
 *
 * What this module is: everything that reads, fetches or switches the model
 * catalog: /model, /models, /andy-source, /andy-logfare, /andy-tokenjuice,
 * /andy-tokenharbour, /andy-openrouter, /andy-unorouter, /andy-aihubmix, /andy-zai,
 * /andy-antseed, the *-api-setup and *-models commands, and the LDXHub catalog
 * browser. Invariants: a fetched catalog is read once per render (the fetch is
 * the slow part); an explicit model switch pays one network round-trip to
 * check membership against the LIVE list rather than refusing a served model
 * against a stale fallback; keys are never echoed — the confirmation names the
 * file and the last four characters.
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type {
  AppCtx,
  CatalogModel,
  ConfigLike,
  ProviderModule,
  SourceLike,
} from '../app.js';
import { catalogClause, fmtG, upstreamStyle } from '../app.js';

/** Column the model id is padded to in `/models`, before its blurb. Wide
 * enough for a TokenHarbour id with room to spare, and narrower than most
 * OpenRouter ids — which is the point of the over-long branch in showModels:
 * those wrap rather than truncate, because the id is what the operator retypes. */
const MODEL_COL = 34;

/** The /model list, free models first. Only the hosted gateways have a free
 * tier and only their catalogs can tell free from paid — for every other
 * source the catalog is null and this is the declared order unchanged, so the
 * sort never reorders a list it has no prices for. */
function modelDisplayOrder(
  ctx: AppCtx,
  models: string[],
  catalog: CatalogModel[] | null,
): string[] {
  if (!catalog || !catalog.length) return [...models];
  const free = new Set(catalog.filter((x) => x.free).map((x) => x.id));
  if (!free.size) return [...models];
  // Stable: free models keep catalog order, then the rest keep theirs. The
  // current model is pinned to the top so it is never scrolled off.
  const current = ctx.cfg.model;
  const head = models.filter((x) => x === current);
  const frees = models.filter((x) => free.has(x) && x !== current);
  const rest = models.filter((x) => !free.has(x) && x !== current);
  return [...head, ...frees, ...rest];
}

/** The upstream count clause for a UnoRouter model, or ''. A plain string
 * because the note renders in one dim style; the count is the load-bearing
 * half and survives being printed without its colour. */
function unoUpstreamClause(
  name: string,
  unoCatalog: CatalogModel[] | null,
): string {
  if (!unoCatalog) return '';
  for (const m of unoCatalog) {
    if (m.id === name) {
      const note = m.upstreamNote ?? '';
      return note ? `  ·  ${note}` : '';
    }
  }
  return '';
}

/** The price/context note beside a model in /model. TokenHarbour's catalog is
 * authoritative for its own models — the gateway's own price, not this
 * harness's estimate — so it wins when present; then AntSeed, then
 * UnoRouter's free tier (its paid entries publish credit ratios, not rates, so
 * they fall through to the estimate table). Logfare's catalog has no prices
 * but knows whether the model is up, so a degraded pick is called out rather
 * than a surprise three turns in. */
function modelNote(
  ctx: AppCtx,
  name: string,
  catalog: CatalogModel[] | null,
  lfCatalog: CatalogModel[] | null,
  asCatalog: CatalogModel[] | null,
  unoCatalog: CatalogModel[] | null,
): string {
  const m = ctx.mods();
  if (!m) return '';
  // Z.ai's Coding Plan is subscription-billed. Falling through to the generic
  // estimate table would invent a per-token price the plan does not charge.
  if (m.sources.activeKey(ctx.cfg.baseUrl) === 'zai') return 'Coding Plan · no per-token charge';
  let live = m.tokenharbour.priceFor?.(name, catalog) ?? null;
  if (live === null) live = m.antseed.priceFor?.(name, asCatalog) ?? null;
  if (live === null) live = m.unorouter.priceFor?.(name, unoCatalog) ?? null;
  if (live !== null) {
    const [pin, pout] = live;
    const note =
      pin === 0.0 && pout === 0.0 ? 'free' : `$${fmtG(pin)}/$${fmtG(pout)} per Mtok`;
    return note + unoUpstreamClause(name, unoCatalog);
  }
  const [pin, pout] = m.config.priceFor(name);
  let note = `$${pin.toFixed(2)}/${pout.toFixed(2)} per Mtok`;
  const health = lfCatalog ? (m.logfare.healthFor?.(name) ?? null) : null;
  if (health && !health.healthy) {
    note += health.status ? `  ·  ${health.status}` : '  ·  degraded';
  }
  return note;
}

/** Re-render the completion popup against the live catalog. `/model <TAB>`
 * offers whatever sources.modelsFor reports, which for a fetched source is
 * the live list. Nothing is cached in the popup, so there is nothing to
 * invalidate — but the popup may be open with the old list showing, and this
 * repaints it so the two agree. */
function refreshModelChoices(ctx: AppCtx) {
  ctx.refreshCompletions(ctx.inputRef.current);
}

/** Repaint everything that names the model or the endpoint. Takes a label and
 * a detail string rather than a Source: the local proxies have a port and a
 * dataclass to describe them, TokenHarbour is a remote host with neither, and
 * this only ever needed the two words. */
function refreshAfterSourceChange(ctx: AppCtx, label: string, detail: string) {
  const p = ctx.pal();
  // Same refresh /model does — HeaderBar + StatusBar carry the model.
  ctx.updateHeader({ model: ctx.cfg.model });
  ctx.updateBar({ model: ctx.cfg.model });
  ctx.sysLine(`source switched to ${label} (${detail})`, true);
  ctx.say(
    <Text>
      <Text color={p.dim}>{'  ↳ '}</Text>
      <Text color={p.primary}>{`model ${ctx.cfg.model}`}</Text>
      <Text color={p.dim}>{'   ·   '}</Text>
      <Text color={p.dim}>{ctx.cfg.baseUrl}</Text>
      <Text color={p.dim}>{'   ·   saved for next launch\n'}</Text>
    </Text>,
  );
  refreshModelChoices(ctx);
}

export function cmdModel(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  void (async () => {
    const p = ctx.pal();
    // Offer only what the active upstream actually serves — a model the
    // upstream does not know is a 404 at request time, not a switch.
    const active = m.sources.activeKey(ctx.cfg.baseUrl);
    let models = m.sources.modelsFor(ctx.cfg.baseUrl) ?? [...m.config.KNOWN_MODELS];
    // Each fetched catalog is read once, here: the fetch is the slow part and
    // this is a render.
    let thCatalog = active === 'tokenharbour' ? m.tokenharbour.cachedModels() : null;
    let asCatalog = active === 'antseed' ? m.antseed.cachedModels() : null;
    let unoCatalog = active === 'unorouter' ? m.unorouter.cachedModels() : null;
    let ahCatalog = active === 'aihubmix' ? m.aihubmix.cachedModels() : null;
    let zaiCatalog = active === 'zai' ? m.zai.cachedModels() : null;
    let lfCatalog = m.sources.catalogFor?.(ctx.cfg.baseUrl) ?? null;

    if (!args.length) {
      const rows = modelDisplayOrder(
        ctx,
        models,
        thCatalog ?? asCatalog ?? unoCatalog ?? ahCatalog ?? zaiCatalog,
      ).map((mod) => {
        const isCurrent = mod === ctx.cfg.model;
        // AntSeed's list is of *models*, but what is typed is a pinned id
        // (`<peerId>@<model>`): the pin is the string that works — the bare
        // name 502s against the trust floor.
        let shown = mod;
        if (active === 'antseed' && asCatalog) {
          for (const cm of asCatalog) {
            if (cm.id === mod && cm.free) {
              shown = cm.pin?.() ?? mod;
              break;
            }
          }
        }
        return (
          <Box key={mod}>
            <Text bold={isCurrent} color={isCurrent ? p.accent : p.primary}>
              {`  ${isCurrent ? '◉' : '○'} ${shown.padEnd(26)}`}
            </Text>
            <Text color={p.dim}>
              {modelNote(ctx, mod, thCatalog, lfCatalog, asCatalog, unoCatalog) + '\n'}
            </Text>
          </Box>
        );
      });
      // Say how current the list is, not merely that one exists: each of these
      // names the age and its refresh command, read from the module rather
      // than assumed from the list being non-empty — which is what let a
      // three-hour-old catalog be called "live".
      let catalogNote: ReactNode = null;
      if (active === 'antseed') {
        catalogNote = (
          <Text color={p.dim}>
            {`  catalog ${catalogClause(m.antseed.catalogAge(), m.antseed.CACHE_TTL)} — /antseed-models shows the free\nones and the seller to pin; pinning is what makes a free model actually route\n`}
          </Text>
        );
      } else if (active === 'tokenharbour') {
        catalogNote = (
          <Text color={p.dim}>
            {`  catalog ${catalogClause(m.tokenharbour.catalogAge(), m.tokenharbour.CACHE_TTL)} — /tokenharbour-models refetches it\n`}
          </Text>
        );
      } else if (active === 'logfare') {
        catalogNote = (
          <Text color={p.dim}>
            {`  catalog ${catalogClause(m.logfare.catalogAge(), m.logfare.CACHE_TTL)} — /logfare-models refetches it\n`}
          </Text>
        );
      } else if (active === 'unorouter') {
        catalogNote = (
          <Text color={p.dim}>
            {`  catalog ${catalogClause(m.unorouter.catalogAge(), m.unorouter.CACHE_TTL)} — /unorouter-models shows the free\nones; free models are listed first, and a paid one is priced by estimate\n`}
          </Text>
        );
      } else if (active === 'aihubmix') {
        catalogNote = (
          <Text color={p.dim}>
            {`  catalog ${catalogClause(m.aihubmix.catalogAge(), m.aihubmix.CACHE_TTL)} — /aihubmix-models shows the free\nones; free models are listed first. Free means priced 0/0, which is\n  narrower than the -free suffix suggests\n`}
          </Text>
        );
      } else if (active === 'zai') {
        catalogNote = (
          <Text color={p.dim}>
            {`  registry ${catalogClause(m.zai.catalogAge(), m.zai.CACHE_TTL)} — /zai-models refetches it.\nGLM Coding Plan usage is covered by the subscription, not metered per token\n`}
          </Text>
        );
      }
      ctx.say(
        <Box flexDirection="column">
          <Box>
            <Text color={p.dim}>{'  current model: '}</Text>
            <Text bold color={p.accent}>
              {ctx.cfg.model + '\n'}
            </Text>
          </Box>
          {active ? (
            <Box>
              <Text color={p.dim}>{'  source: '}</Text>
              <Text color={p.dim}>{`${ctx.cfg.baseUrl}\n`}</Text>
            </Box>
          ) : null}
          <Text color={p.dim}>{'\n'}</Text>
          {rows}
          <Text color={p.dim}>{'\n  usage: /model <name>\n'}</Text>
          {catalogNote}
        </Box>,
      );
      return;
    }

    const name = args[0] ?? '';
    // Every hosted gateway's list is FETCHED, so a cold cache leaves `models`
    // as the fallback — and the membership check would then refuse a model the
    // gateway genuinely serves, against a list from a different provider. Fetch
    // it here instead: this is an explicit switch, so one network round-trip is
    // the right price for a correct answer. This branch used to be
    // TokenHarbour's alone, which is exactly how the bug got in: the fix was
    // written for the first gateway that needed it and every gateway added
    // afterwards silently inherited the wrong list — measured on OpenRouter,
    // where a live free model was refused and the next turn 402'd. A wrong
    // list is worse than no list. OpenRouter needs no credential for this and
    // TokenHarbour does, so the key is optional rather than required.
    // A pinned id — `<peerId>@<model>` — is accepted by the gateway but is not
    // in the catalog's id list, so it is unwrapped to its model before the
    // membership test. Without this, every free AntSeed model would be refused
    // by the very check that exists to catch typos.
    const checkName =
      active === 'antseed' && name.includes('@') ? (name.split('@', 2)[1] ?? name) : name;
    if (
      active &&
      ['tokenharbour', 'openrouter', 'unorouter', 'antseed', 'logfare', 'aihubmix', 'zai'].includes(
        active,
      ) &&
      !models.includes(checkName)
    ) {
      let fetched: CatalogModel[] | null = null;
      try {
        if (active === 'tokenharbour') {
          if (thCatalog === null) {
            const creds = m.tokenharbour.loadCredentials();
            if (creds) [fetched] = await m.tokenharbour.fetchModels(creds[0]);
          } else fetched = [...thCatalog];
        } else if (active === 'openrouter') {
          const creds = m.openrouter.loadCredentials();
          [fetched] = await m.openrouter.fetchModels(creds ? creds[0] : '');
        } else if (active === 'unorouter') {
          // Keyless like OpenRouter's: the catalog is public. Fetched rather
          // than read from a cold cache so a live model is not refused against
          // a stale list.
          if (unoCatalog === null) {
            const creds = m.unorouter.loadCredentials();
            [fetched] = await m.unorouter.fetchModels(creds ? creds[0] : '');
          } else fetched = [...unoCatalog];
        } else if (active === 'antseed') {
          if (asCatalog === null) [fetched] = await m.antseed.fetchModels();
          else fetched = [...asCatalog];
        } else if (active === 'aihubmix') {
          // Keyless as well: /api/v1/models answers 200 with no Authorization
          // header at all.
          if (ahCatalog === null) {
            const creds = m.aihubmix.loadCredentials();
            [fetched] = await m.aihubmix.fetchModels(creds ? creds[0] : '');
          } else fetched = [...ahCatalog];
        } else if (active === 'zai') {
          if (zaiCatalog === null) {
            const creds = m.zai.loadCredentials();
            [fetched] = await m.zai.fetchModels(creds ? creds[0] : '');
          } else fetched = [...zaiCatalog];
        } else if (active === 'logfare') {
          // The status API is public — this works before anything has
          // authenticated. Its absence was the same bug a third time: the
          // source the operator is most likely to be on.
          if (lfCatalog === null) [fetched] = await m.logfare.fetchModels();
          else lfCatalog = [...lfCatalog];
        }
      } catch {
        fetched = null;
      }
      if (fetched) {
        if (active === 'tokenharbour') thCatalog = fetched;
        else if (active === 'antseed') asCatalog = fetched;
        else if (active === 'unorouter') unoCatalog = fetched;
        else if (active === 'aihubmix') ahCatalog = fetched;
        else if (active === 'zai') zaiCatalog = fetched;
        else if (active === 'logfare') lfCatalog = fetched;
        models = fetched.map((x) => x.id);
      }
    }
    // Only police this on a known source. A custom endpoint (ANDY_NO_PROXY, a
    // direct ANTHROPIC_BASE_URL) has no catalog to check against, and the old
    // behaviour — accept anything — is right there.
    if (active && !models.includes(checkName)) {
      ctx.sysLine(`${name} is not served by ${active} — see /model for the list`, true);
      return;
    }
    ctx.cfg.model = name;
    a.setModel(name);
    ctx.updateHeader({ model: name });
    ctx.updateBar({ model: name });
    // Remember the choice when it is an AntSeed pin. Nothing else in the TUI
    // persists a model, because every other source's model name is a plain
    // string the catalog can hand back — but an AntSeed free model is reached
    // only through `<peerId>@<model>`, and a pin is not in the catalog's id
    // list. Without this the choice dies with the session and the next launch
    // lands back on a paid name and 402s. Only saved when the peer is actually
    // pinned; a bare model name is not a preference.
    if (active === 'antseed' && name.includes('@')) {
      const [peer, model] = name.split('@', 2);
      if (peer && model) m.antseed.savePin?.(model, peer);
    }
    ctx.sysLine(`model switched to ${name}`, true);
  })();
}

// ---- /andy-source: the local-proxy failover -----------------------------------

/** Start the target proxy if needed, then rebuild the client on it. The
 * profile carries the key for this upstream; it is read here, never printed —
 * the transcript only ever sees the label and the port. */
async function switchSource(ctx: AppCtx, src: SourceLike): Promise<void> {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  ctx.setBusyBoth(true);
  ctx.updateBar({ activity: `switching to ${src.label}` });
  ctx.sysLine(`switching to ${src.label} (:${src.port})…`);
  let ok = false;
  let detail = '';
  try {
    [ok, detail] = await m.sources.startProxy(src);
  } finally {
    ctx.setBusyBoth(false);
    ctx.updateBar({ activity: 'idle' });
  }
  if (!ok) {
    ctx.sysLine(`${src.label} proxy is not up: ${detail}`, true);
    ctx.sysLine(`start it with: ${src.service ?? src.key} start`, true);
    return;
  }
  const profile = m.sources.loadProfile(src);
  const token = profile['ANTHROPIC_AUTH_TOKEN'] || null;
  if (!token) {
    ctx.sysLine(
      `${src.label} profile has no ANTHROPIC_AUTH_TOKEN: ${src.profile ?? src.key}`,
      true,
    );
    return;
  }
  ctx.cfg.baseUrl = src.baseUrl;
  ctx.cfg.authToken = token;
  ctx.cfg.apiKey = ''; // empty, so the auth_token stays authoritative
  // The profile's model is *stored* — written by hand at setup and never
  // revisited — so it can name a model the upstream has since retired.
  // `src.model` cannot: it is a constant. Check the stored one against the
  // live catalog now, while this switch is already paying for a round-trip,
  // instead of letting the first turn find out as a 404.
  let chosen = profile['ANTHROPIC_MODEL'] || src.model;
  const [verified, replaced] = await verifyModelFor(ctx, src, chosen);
  chosen = verified;
  if (replaced) {
    ctx.sysLine(`${replaced} is no longer served by ${src.label} — using ${chosen}`, true);
  }
  ctx.cfg.model = chosen;
  a.setModel(chosen);
  // Drop the cached client so the next turn rebuilds against the new host.
  a.resetClient?.();
  m.sources.setCurrent(src.key);
  refreshAfterSourceChange(ctx, src.label, `:${src.port}, ${detail}`);
}

/** (model_to_use, replaced_name_or_null) for a just-started source. Only
 * Logfare publishes a catalog, and only Logfare's local proxy has a profile
 * that can go stale, so this is where the check belongs. A fetch that fails
 * leaves the stored name alone: an unreachable status API is not evidence that
 * a model was retired. */
async function verifyModelFor(
  ctx: AppCtx,
  src: SourceLike,
  name: string,
): Promise<[string, string | null]> {
  const m = ctx.mods();
  if (!m || src.key !== 'logfare') return [name, null];
  const [models] = await m.logfare.fetchModels();
  if (!models || !models.length) return [name, null];
  const served = new Set(models.map((x) => x.id));
  if (served.has(name)) return [name, null];
  // The declared default is the fallback: the one string guaranteed to be
  // both in the table and in the catalog.
  if (served.has(src.model)) return [src.model, name];
  return [name, null];
}

export function cmdAndySource(ctx: AppCtx, key: string | null): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  const found = m.sources.discover();

  if (key === null) {
    // Bare /andy-source: show what is available and which is live.
    const active = m.sources.activeKey(ctx.cfg.baseUrl);
    const rows: ReactNode[] = [];
    for (const [k, src] of Object.entries(found)) {
      const isA = k === active;
      const up = m.sources.proxyHealthy(src.port);
      rows.push(
        <Box key={k}>
          <Text bold={isA} color={isA ? p.accent : p.primary}>
            {`  ${isA ? '◉' : '○'} ${k.padEnd(12)}`}
          </Text>
          <Text color={p.primary}>{`:${src.port}  ${src.label.padEnd(12)} `}</Text>
          <Text color={up ? p.accent : p.amber}>{up ? 'proxy up\n' : 'proxy down\n'}</Text>
        </Box>,
      );
    }
    // TokenHarbour has no port and no local proxy, so it is listed from its
    // credential rather than from discover() — "proxy up" is not a question
    // you can ask a hosted gateway.
    const th = m.tokenharbour.loadCredentials();
    rows.push(
      <Box key="tokenharbour">
        <Text bold={active === 'tokenharbour'} color={active === 'tokenharbour' ? p.accent : p.primary}>
          {`  ${active === 'tokenharbour' ? '◉' : '○'} ${'tokenharbour'.padEnd(12)}`}
        </Text>
        {/* Six spaces where the rows above carry ":4001  ", so the label
            column lines up — "tokenharbour" is exactly the 12-wide key
            column, so without this the two run together. */}
        <Text color={p.primary}>{'      hosted  TokenHarbour  '}</Text>
        {th === null ? (
          <Text color={p.amber}>{'no key — /tokenharbour-api-setup\n'}</Text>
        ) : (
          <Text color={p.accent}>{`key from ${th[2]}\n`}</Text>
        )}
      </Box>,
    );
    // The hosted gateways were missing from this list once — it claims to show
    // the upstreams and which is live, and a source you cannot see is one you
    // cannot switch to.
    const hosted: [string, ProviderModule, string, string][] = [
      ['openrouter', m.openrouter, 'OpenRouter', '/openrouter-api-setup'],
      ['unorouter', m.unorouter, 'UnoRouter', '/unorouter-api-setup'],
      ['aihubmix', m.aihubmix, 'AIHubMix', '/aihubmix-api-setup'],
      ['zai', m.zai, 'Z.ai', '/zai-api-setup'],
    ];
    for (const [kind, mod, label, setup] of hosted) {
      const creds = mod.loadCredentials();
      rows.push(
        <Box key={kind}>
          <Text bold={active === kind} color={active === kind ? p.accent : p.primary}>
            {`  ${active === kind ? '◉' : '○'} ${kind.padEnd(12)}`}
          </Text>
          <Text color={p.primary}>{`      hosted  ${label.padEnd(12)} `}</Text>
          {creds === null ? (
            <Text color={p.amber}>{`no key — ${setup}\n`}</Text>
          ) : (
            <Text color={p.accent}>{`key from ${creds[2]}\n`}</Text>
          )}
        </Box>,
      );
    }
    // AntSeed is local like the LiteLLM proxies but has no discover() entry
    // and no key, so it is listed from its port being reachable — the only
    // question that has an answer here.
    const port = m.antseed.proxyPort?.() ?? 0;
    const up = m.antseed.reachable?.() ?? false;
    rows.push(
      <Box key="antseed">
        <Text bold={active === 'antseed'} color={active === 'antseed' ? p.accent : p.primary}>
          {`  ${active === 'antseed' ? '◉' : '○'} ${'antseed'.padEnd(12)}`}
        </Text>
        <Text color={p.primary}>{`:${port}  AntSeed      `}</Text>
        {up ? (
          <Text color={p.accent}>{'buyer up (free peers, no key)\n'}</Text>
        ) : (
          <Text color={p.amber}>{'no buyer — `antseed buyer start`\n'}</Text>
        )}
      </Box>,
    );
    // LDXHub is not a chat source — there is no Messages endpoint — so it is
    // listed after the switchable ones and never carries the active mark.
    const ldx = m.ldxhub.loadCredentials();
    rows.push(
      <Box key="ldxhub">
        <Text color={p.primary}>{`  ○ ${'ldxhub'.padEnd(12)}`}</Text>
        <Text color={p.primary}>{'      tools   '}</Text>
        <Text color={p.primary}>{`${'LDXHub'.padEnd(12)} `}</Text>
        {ldx === null ? (
          <Text color={p.amber}>
            {'no key — /ldxhub-api-setup (jobs; /ldxhub-models browses free)\n'}
          </Text>
        ) : (
          <Text color={p.accent}>
            {`key from ${ldx[2]} (document tools, not a source)\n`}
          </Text>
        )}
      </Box>,
    );
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  UPSTREAM SOURCES\n\n'}
        </Text>
        {rows}
        <Text color={p.dim}>
          {
            '\n  switch with  /andy-logfare,  /andy-tokenjuice,  /andy-tokenharbour\n                 or  /andy-openrouter,  /andy-unorouter,  /andy-aihubmix,\n                 or  /andy-zai,  /andy-antseed\n'
          }
        </Text>
      </Box>,
    );
    return;
  }

  const src = found[key];
  if (!src) {
    ctx.sysLine(`source '${key}' is not available — profile, config or service missing`, true);
    return;
  }
  if (m.sources.activeKey(ctx.cfg.baseUrl) === key) {
    ctx.sysLine(`already on ${src.label} (:${src.port})`, true);
    return;
  }
  void switchSource(ctx, src);
}

// ---- TokenHarbour ---------------------------------------------------------------

export function cmdTokenharbourKey(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // Written to ~/.andy/tokenharbour/source, mode 600, in the same profile
  // format every other source uses. The key is never echoed back — the
  // confirmation names the file and the last four characters, enough to tell
  // two keys apart and not enough to leak one.
  if (!args.length) {
    const creds = m.tokenharbour.loadCredentials();
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  TOKENHARBOUR API KEY\n\n'}
        </Text>
        {creds === null ? (
          <Text color={p.amber}>{'  no key set.\n\n'}</Text>
        ) : (
          <Box>
            <Text color={p.dim}>{'  source: '}</Text>
            <Text color={p.primary}>{creds[2] + '\n\n'}</Text>
          </Box>
        )}
        <Box>
          <Text color={p.dim}>{'  set it with  '}</Text>
          <Text bold color={p.primary}>
            {'/tokenharbour-api-setup <key>\n'}
          </Text>
        </Box>
        <Box>
          <Text color={p.dim}>{'  get a key at  '}</Text>
          <Text color={p.primary}>{'https://tokenharbor.ai\n'}</Text>
        </Box>
        <Text color={p.dim}>{`  stored in     ${m.tokenharbour.PROFILE ?? '~/.andy/tokenharbour/source'}\n`}</Text>
      </Box>,
    );
    return;
  }
  const key = (args[0] ?? '').trim();
  if (!m.tokenharbour.looksLikeKey(key)) {
    ctx.sysLine(
      'that does not look like an API key — paste just the key, not the whole `export` line',
      true,
    );
    return;
  }
  // Keep whatever model is current, so setting a key does not silently reset
  // the model the operator was on.
  const current = m.tokenharbour.isTokenharbour?.(ctx.cfg.baseUrl) ? ctx.cfg.model : '';
  const savePath = m.tokenharbour.saveKey?.(key, current) ?? '~/.andy/tokenharbour/source';
  m.tokenharbour.clearCache(); // a new key invalidates the old catalog
  ctx.sysLine(`TokenHarbour key saved (…${key.slice(-4)}) to ${savePath}`, true);
  ctx.sysLine('switch to it with /andy-tokenharbour');
}

export function cmdTokenharbourModels(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  void (async () => {
    const creds = m.tokenharbour.loadCredentials();
    if (creds === null) {
      ctx.sysLine('no TokenHarbour key — set one with /tokenharbour-api-setup <key>', true);
      return;
    }
    const [token, , origin] = creds;
    ctx.sysLine(`fetching the TokenHarbour catalog (${origin})…`);
    const [models, err] = await m.tokenharbour.fetchModels(token);
    const p = ctx.pal();
    if (models === null) {
      ctx.sysLine(`TokenHarbour: ${err}`, true);
      return;
    }
    const free = models.filter((x) => x.free);
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  TOKENHARBOUR — FREE MODELS\n\n'}
        </Text>
        {!free.length ? (
          <Box flexDirection="column">
            <Text color={p.amber}>{'  nothing is free right now.\n'}</Text>
            <Text color={p.dim}>{`  ${models.length} models are served, none at zero cost.\n`}</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {free.map((fm) => (
              <Box key={fm.id}>
                <Text bold={fm.id === ctx.cfg.model} color={fm.id === ctx.cfg.model ? p.accent : p.primary}>
                  {`  ${fm.id === ctx.cfg.model ? '◉' : '○'} ${fm.id.padEnd(26)}`}
                </Text>
                <Text color={p.dim}>{fm.blurb + '\n'}</Text>
              </Box>
            ))}
            <Box>
              <Text color={p.dim}>{'\n  pick one with  '}</Text>
              <Text bold color={p.primary}>
                {'/model <name>\n'}
              </Text>
            </Box>
          </Box>
        )}
        <Text color={p.dim}>
          {`  ${models.length} models served in total · see them all with /model\n`}
        </Text>
      </Box>,
    );
    // The transcript is not a picker: offer the free ones as the live list
    // /model reads, so the two commands agree.
    refreshModelChoices(ctx);
  })();
}

export function cmdAndyTokenharbour(ctx: AppCtx): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  // No local proxy to start and no shipped profile: the key comes from
  // wherever the operator put it — the environment, Andy's own profile, or a
  // ~/claude-source file — and the model defaults to a free one so a fresh
  // switch costs nothing.
  const creds = m.tokenharbour.loadCredentials();
  if (creds === null) {
    ctx.sysLine(
      'no TokenHarbour key found. Set one with /tokenharbour-api-setup <key>, or source a profile first (source ~/claude-source/haiku-5.5)',
      true,
    );
    return;
  }
  const [token, , origin] = creds;
  if (m.sources.activeKey(ctx.cfg.baseUrl) === 'tokenharbour') {
    // Already pointed here — most often because a profile was sourced before
    // launch. Record it anyway: the environment does not survive the next
    // launch, and the whole point of the selection file is that the choice does.
    m.tokenharbour.setCurrent('tokenharbour');
    ctx.sysLine(`already on TokenHarbour (${origin})`, true);
    return;
  }
  const applied = m.tokenharbour.applyTo(ctx.cfg);
  if (applied === null) {
    ctx.sysLine('no TokenHarbour key found', true);
    return;
  }
  const [origin2, model] = applied;
  a.resetClient?.(); // rebuild against the new host
  m.tokenharbour.setCurrent('tokenharbour');
  refreshAfterSourceChange(ctx, 'TokenHarbour', `key from ${origin2}`);
  // A first switch with no model chosen lands on whatever the profile named;
  // with none, offer the free list rather than guessing a paid one.
  if (!model) {
    ctx.sysLine('fetching the free model list…');
    cmdTokenharbourModels(ctx);
  }
  void token;
}

// ---- hosted gateways (OpenRouter / UnoRouter / AIHubMix / Z.ai / AntSeed) --------

/** (module, label) for a hosted gateway key. AntSeed is included although it
 * is not a *hosted* gateway and has no key: it answers the same calls this
 * table exists to parameterise, so listing it here is what lets /andy-antseed
 * share one code path instead of growing a near-copy of it. */
function gateway(
  ctx: AppCtx,
  kind: string,
): [ProviderModule, string] | null {
  const m = ctx.mods();
  if (!m) return null;
  if (kind === 'openrouter') return [m.openrouter, 'OpenRouter'];
  if (kind === 'unorouter') return [m.unorouter, 'UnoRouter'];
  if (kind === 'aihubmix') return [m.aihubmix, 'AIHubMix'];
  if (kind === 'zai') return [m.zai, 'Z.ai'];
  if (kind === 'antseed') return [m.antseed, 'AntSeed'];
  return null;
}

export function cmdGatewayKey(ctx: AppCtx, kind: string, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const found = gateway(ctx, kind);
  if (found === null) {
    ctx.sysLine(`unknown gateway: ${kind}`, true);
    return;
  }
  const [mod, label] = found;
  const p = ctx.pal();
  // Written to ~/.andy/<kind>/source, mode 600, in the same export-var format
  // every other profile uses — so it can be sourced by a shell as well as read
  // by the harness, and there is one credential format in the project. The key
  // is never echoed; the confirmation names the file and the last four chars.
  if (!args.length) {
    const creds = mod.loadCredentials();
    const body: ReactNode = creds === null ? (
      <Text color={p.amber}>{'  no key set.\n\n'}</Text>
    ) : (
      <Box>
        <Text color={p.dim}>{'  source: '}</Text>
        <Text color={p.primary}>{creds[2] + '\n\n'}</Text>
      </Box>
    );
    let extra: ReactNode = null;
    if (kind === 'antseed') {
      // There is no key to set, and offering a key box for a service that
      // authenticates nothing would be a lie the operator only discovers by
      // pasting one into it. Say what is actually needed.
      extra = (
        <Box flexDirection="column">
          <Text color={p.dim}>{'  nothing to set — '}</Text>
          <Text color={p.dim}>
            {'the local buyer proxy takes no credential.\n  start it with '}
          </Text>
          <Text bold color={p.primary}>
            {'antseed buyer start\n'}
          </Text>
          <Text color={p.dim}>{'  then switch with '}</Text>
          <Text bold color={p.primary}>
            {'/andy-antseed\n'}
          </Text>
          <Text color={p.dim}>{`  preference   ${mod.PROFILE ?? '~/.andy/antseed/source'}\n`}</Text>
        </Box>
      );
    } else {
      extra = (
        <Box flexDirection="column">
          <Box>
            <Text color={p.dim}>{'  set it with  '}</Text>
            <Text bold color={p.primary}>
              {`/${kind}-api-setup <key>\n`}
            </Text>
          </Box>
          {/* Most marketplace catalogs are public; Z.ai's Coding Plan registry
              is credential-scoped, so the note follows the source rather than
              claiming one policy for every gateway. */}
          <Box>
            <Text color={p.dim}>{'  note:        '}</Text>
            <Text color={p.dim}>
              {kind === 'zai'
                ? 'the GLM registry and requests both use a Coding Plan API key.\n'
                : 'the model catalog is public — /models works without a key. A key is needed to send.\n'}
            </Text>
          </Box>
          <Text color={p.dim}>{`  stored in     ${mod.PROFILE ?? `~/.andy/${kind}/source`}\n`}</Text>
        </Box>
      );
    }
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {`  ${label.toUpperCase()} API KEY\n\n`}
        </Text>
        {body}
        {extra}
      </Box>,
    );
    return;
  }
  const key = (args[0] ?? '').trim();
  if (!mod.looksLikeKey(key)) {
    ctx.sysLine(
      'that does not look like an API key — paste just the key, not the whole `export` line',
      true,
    );
    return;
  }
  // Keep the current model when it belongs to the same endpoint. A source can
  // substitute its own safe default when the operator was elsewhere — Z.ai
  // does exactly that rather than carrying another provider's model id.
  const activeEndpoint = mod.activeEndpoint?.(ctx.cfg.baseUrl) ?? false;
  const current = activeEndpoint ? ctx.cfg.model : '';
  const savePath = mod.saveKey?.(key, current) ?? `~/.andy/${kind}/source`;
  mod.clearCache(); // a new key invalidates the old catalog
  ctx.sysLine(`${label} key saved (…${key.slice(-4)}) to ${savePath}`, true);
  ctx.sysLine(`switch to it with /andy-${kind}`);
}

export function cmdAndyGateway(ctx: AppCtx, kind: string): void {
  const m = ctx.mods();
  const a = ctx.agent();
  if (!m || !a) return;
  const found = gateway(ctx, kind);
  if (found === null) {
    ctx.sysLine(`unknown gateway: ${kind}`, true);
    return;
  }
  const [mod, label] = found;
  const creds = mod.loadCredentials();
  if (creds === null) {
    ctx.sysLine(
      `no ${label} key found. Set one with /${kind}-api-setup <key>, or source a profile first`,
      true,
    );
    return;
  }
  if (m.sources.activeKey(ctx.cfg.baseUrl) === kind) {
    // Already pointed here — record it anyway: the environment does not
    // survive the next launch, and the selection file is the point.
    mod.setCurrent(kind);
    ctx.sysLine(`already on ${label} (${creds[2]})`, true);
    return;
  }
  const applied = mod.applyTo(ctx.cfg);
  if (applied === null) {
    ctx.sysLine(`no ${label} key found`, true);
    return;
  }
  const [origin, model] = applied;
  a.resetClient?.(); // rebuild against the new host
  mod.setCurrent(kind);
  refreshAfterSourceChange(ctx, label, `key from ${origin}`);
  // A first switch with no model chosen: offer the free list rather than
  // guessing a paid one.
  if (!model) {
    ctx.sysLine(kind === 'zai' ? 'fetching the GLM registry…' : 'fetching the free model list…');
    cmdModels(ctx, [kind]);
  }
}

// ---- LDXHub ------------------------------------------------------------------------

export function cmdLdxhubKey(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  // Unlike every other *-api-setup command there is nothing to switch to
  // afterwards: LDXHub has no Messages endpoint, so it can never become this
  // session's upstream. The key unlocks the document tools; the model/engine
  // catalogs are public and already listable via /ldxhub-models.
  if (!args.length) {
    const creds = m.ldxhub.loadCredentials();
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  LDXHUB API KEY\n\n'}
        </Text>
        {creds === null ? (
          <Text color={p.amber}>{'  no key set.\n\n'}</Text>
        ) : (
          <Box>
            <Text color={p.dim}>{'  source: '}</Text>
            <Text color={p.primary}>{creds[2] + '\n\n'}</Text>
          </Box>
        )}
        <Box>
          <Text color={p.dim}>{'  set it with  '}</Text>
          <Text bold color={p.primary}>
            {'/ldxhub-api-setup <key>\n'}
          </Text>
        </Box>
        <Box>
          <Text color={p.dim}>{'  note:        '}</Text>
          <Text color={p.dim}>
            {
              'the model/engine catalogs are public — /ldxhub-models works without a key.\n               A key is needed to run a document job (the ldxhub_* tools).\n'
            }
          </Text>
        </Box>
        <Text color={p.dim}>{`  stored in     ${m.ldxhub.PROFILE ?? '~/.andy/ldxhub/source'}\n`}</Text>
      </Box>,
    );
    return;
  }
  const key = (args[0] ?? '').trim();
  if (!m.ldxhub.looksLikeKey(key)) {
    ctx.sysLine(
      'that does not look like an API key — paste just the key, not the whole `export` line',
      true,
    );
    return;
  }
  const savePath = m.ldxhub.saveKey(key);
  m.ldxhub.clearCache(); // a new key invalidates the old catalog
  ctx.sysLine(`LDXHub key saved (...${key.slice(-4)}) to ${savePath}`, true);
  ctx.sysLine('the ldxhub_* tools are available now — /ldxhub-models to pin a per-service default');
}

export function cmdLdxhubModels(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  void (async () => {
    // Not a chat model list: LDXHub has no Messages endpoint, so there is
    // nothing here to put in /model. The catalogs are still worth browsing and
    // pinning — the agent tools each take a model or engine from the matching
    // service, and the pin is what a tool omits when the operator does not
    // name one. Catalogs are public, so a missing key does not block listing.
    const service = (args[0] ?? '').trim().toLowerCase();
    if (service && !(service in m.ldxhub.SERVICES)) {
      ctx.sysLine(
        `unknown LDXHub service: ${service} — try one of ${Object.keys(m.ldxhub.SERVICES).join(', ')}`,
        true,
      );
      return;
    }
    if (args.length >= 2) {
      const entryId = (args[1] ?? '').trim();
      const savePath = m.ldxhub.saveDefault(service, entryId);
      if (savePath === null) {
        ctx.sysLine(
          'no LDXHub key profile to write the default into — set a key with /ldxhub-api-setup',
          true,
        );
        return;
      }
      ctx.sysLine(`${service} default set to ${entryId}`, true);
    }
    ctx.sysLine(`fetching the LDXHub ${service || 'service'} catalog...`);
    const creds = m.ldxhub.loadCredentials();
    const token = creds ? creds[0] : '';
    const defaults = creds ? { ...creds[1] } : {};
    const wanted = service ? [service] : Object.keys(m.ldxhub.SERVICES);
    const rows: [string, { id: string; summary: string }[] | null][] = [];
    let err: string | null = null;
    for (const svc of wanted) {
      const [entries, e] = await m.ldxhub.fetchCatalog(svc, token);
      if (entries === null) {
        err = err ?? `${svc}: ${e}`;
        rows.push([svc, null]);
      } else {
        rows.push([svc, entries]);
      }
    }
    const p = ctx.pal();
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  LDXHUB CATALOGS\n\n'}
        </Text>
        {rows.map(([svc, entries]) => (
          <Box key={svc} flexDirection="column">
            <Text bold color={p.primary}>
              {`  ${svc} `}
            </Text>
            <Text color={p.dim}>{`(${m.ldxhub.SERVICES[svc] ?? '?'})\n`}</Text>
            {entries === null ? (
              <Text color={p.amber}>{'    unavailable\n'}</Text>
            ) : !entries.length ? (
              <Text color={p.dim}>{'    (empty)\n'}</Text>
            ) : (
              <Box flexDirection="column">
                {entries.map((e) => {
                  const pin = (defaults[svc] ?? '').trim();
                  const marked = pin && e.id === pin ? '*' : ' ';
                  return (
                    <Box key={e.id}>
                      <Text color={p.primary}>{`    ${marked} ${e.id.padEnd(28)}`}</Text>
                      <Text color={p.dim}>{e.summary + '\n'}</Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        ))}
        <Box>
          <Text color={p.dim}>{'\n  pin a default:  '}</Text>
          <Text bold color={p.primary}>
            {'/ldxhub-models <service> <id>\n'}
          </Text>
        </Box>
        <Text color={p.dim}>
          {"  * marks the profile default the tools fall back to.\n  a key is only needed to run a job, not to browse — /ldxhub-api-setup\n"}
        </Text>
        {err ? <Text color={p.amber}>{`  note: ${err}\n`}</Text> : null}
      </Box>,
    );
  })();
}

// ---- /models: the free list of an upstream -----------------------------------------

export function cmdModels(ctx: AppCtx, args: string[]): void {
  const m = ctx.mods();
  if (!m) return;
  void (async () => {
    // Defaults to whichever upstream is *active*, because the question it
    // answers is "what can I run right now without paying". An explicit source
    // is accepted for the one case that rule gets wrong: OpenRouter's and
    // UnoRouter's catalogs are public, so their free lists are worth seeing
    // before a key exists — and before the session is pointed there, since
    // pointing at either needs a key.
    let key = (args[0] ?? '').trim().toLowerCase();
    if (!key) {
      key = m.sources.activeKey(ctx.cfg.baseUrl) ?? '';
      if (!key) {
        ctx.sysLine(
          'this endpoint is not a known upstream — /andy-source lists them, or name one: /models openrouter',
          true,
        );
        return;
      }
    }
    const known = new Set([
      'logfare',
      'tokenjuice',
      'tokenharbour',
      'openrouter',
      'unorouter',
      'antseed',
      'aihubmix',
      'zai',
    ]);
    if (!known.has(key)) {
      ctx.sysLine(
        `unknown upstream: ${key} — try one of ${[...known].sort().join(', ')}`,
        true,
      );
      return;
    }
    // A gateway whose catalog is gated needs its key before there is anything
    // to show. OpenRouter / UnoRouter / AIHubMix are deliberately absent from
    // this check: their catalogs are public. TokenHarbour is asked directly
    // rather than through `gateway` (which returns null for it — it predates
    // that table); `gateway("tokenharbour")[0]` was a TypeError in Python.
    if (key === 'tokenharbour' && m.tokenharbour.loadCredentials() === null) {
      ctx.sysLine('no TokenHarbour key — set one with /tokenharbour-api-setup <key>', true);
      return;
    }
    // AntSeed has no key to check, but it does have to be *running*: the buyer
    // proxy only exists while `antseed buyer start` is up, and a fetch against
    // a dead port would surface as a bare connection error rather than the one
    // instruction that fixes it.
    if (key === 'antseed' && !(m.antseed.reachable?.() ?? false)) {
      ctx.sysLine(
        `no AntSeed buyer on localhost:${m.antseed.proxyPort?.() ?? 0} — start one with \`antseed buyer start\``,
        true,
      );
      return;
    }
    ctx.sysLine(`fetching the ${key} catalog…`);
    const [models, err] = await modelsForKind(ctx, key);
    showModels(ctx, key, models, err);
  })();
}

/** (models, error) for a source key — the free, usable ones. */
async function modelsForKind(
  ctx: AppCtx,
  kind: string,
): Promise<[CatalogModel[] | null, string]> {
  const m = ctx.mods();
  if (!m) return [null, `no catalog for ${kind}`];
  if (kind === 'openrouter') {
    // Keyless on purpose: the catalog is public, so this works before
    // /openrouter-api-setup has run. Send the key when there is one, so the
    // listing matches what this session would be charged.
    const creds = m.openrouter.loadCredentials();
    return (m.openrouter.usableFreeModels?.(creds ? creds[0] : '') ??
      Promise.resolve([null, 'no catalog'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'unorouter') {
    // Keyless too: /api/pricing answers 200 with no credential at all.
    const creds = m.unorouter.loadCredentials();
    return (m.unorouter.usableFreeModels?.(creds ? creds[0] : '') ??
      Promise.resolve([null, 'no catalog'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'aihubmix') {
    // Keyless as well: /api/v1/models answers 200 with no Authorization
    // header at all. The key is sent when there is one so the listing matches
    // this account.
    const creds = m.aihubmix.loadCredentials();
    return (m.aihubmix.usableFreeModels?.(creds ? creds[0] : '') ??
      Promise.resolve([null, 'no catalog'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'tokenharbour') {
    const creds = m.tokenharbour.loadCredentials();
    if (creds === null) return [null, 'no key'];
    return (m.tokenharbour.freeModels?.(creds[0]) ??
      Promise.resolve([null, 'no catalog'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'zai') {
    const creds = m.zai.loadCredentials();
    if (creds === null) return [null, 'no Z.ai key — set one with /zai-api-setup <key>'];
    return (m.zai.usableFreeModels?.(creds[0]) ??
      Promise.resolve([null, 'no registry'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'antseed') {
    // `usableFreeModels` rather than `freeModels`: a free model is only
    // usable here if a free peer can be pinned, because the router's trust
    // floor refuses free peers on its own.
    return (m.antseed.usableFreeModels?.() ??
      Promise.resolve([null, 'no catalog'] as [CatalogModel[] | null, string]));
  }
  if (kind === 'logfare') {
    // Logfare's catalog is a health feed — it carries no pricing at all, so
    // there is no free tier to filter to. Reported as an empty list it would
    // read as "nothing is free right now", which is a claim about the upstream
    // that is simply not true; say what actually is the case instead.
    return [
      null,
      'Logfare publishes no pricing — its catalog is a health feed, so there is no free list to show. Use /logfare-models for what it serves.',
    ];
  }
  return [null, `no catalog for ${kind}`];
}

function showModels(
  ctx: AppCtx,
  kind: string,
  models: CatalogModel[] | null,
  err: string,
): void {
  const m = ctx.mods();
  if (!m) return;
  const p = ctx.pal();
  if (models === null) {
    ctx.sysLine(`${kind}: ${err}`, true);
    return;
  }
  const label =
    (
      {
        openrouter: 'OPENROUTER',
        unorouter: 'UNOROUTER',
        aihubmix: 'AIHUBMIX',
        zai: 'Z.AI GLM CODING PLAN',
        tokenharbour: 'TOKENHARBOUR',
        logfare: 'LOGFARE',
        antseed: 'ANTSEED',
      } as Record<string, string>
    )[kind] ?? kind.toUpperCase();
  const rows: ReactNode[] = [];
  if (!models.length) {
    rows.push(
      <Text key="empty" color={p.amber}>
        {kind === 'zai' ? '  no GLM models came back.\n' : '  nothing free is usable right now.\n'}
      </Text>,
    );
    if (kind === 'openrouter' || kind === 'unorouter') {
      rows.push(
        <Text key="tools" color={p.dim}>
          {
            '  (free models that cannot call tools are excluded — they cannot drive this harness)\n'
          }
        </Text>,
      );
    }
    if (kind === 'aihubmix') {
      // A different exclusion, and saying the wrong one would send the
      // operator looking for a tool-calling filter that is not there.
      rows.push(
        <Text key="chat" color={p.dim}>
          {
            '  (only free models that can answer a chat request are listed — image,\n  speech, OCR and embedding models are filtered out; tool support is\n  NOT a filter here, because AIHubMix under-reports it)\n'
          }
        </Text>,
      );
    }
  } else {
    for (const mod of models) {
      const isCurrent = mod.id === ctx.cfg.model;
      // The id is padded to a column but NOT truncated: the id is what the
      // operator retypes into `/model <name>`, so cutting it short would hand
      // them a name that does not exist. An over-long id instead wraps its
      // blurb to the next line, indented under the id. For AntSeed the *pin*
      // is what gets typed, not the bare id — the trust floor refuses free
      // peers, so `glm-4.5-flash` answers 502 while `<peerId>@glm-4.5-flash`
      // answers 200; the column carries the pinnable id and the model name is
      // repeated underneath when the two differ.
      let shown = mod.id;
      if (kind === 'antseed') {
        const pin = mod.pin?.();
        if (pin) shown = pin;
      }
      const tooLong = shown.length > MODEL_COL;
      rows.push(
        <Box key={mod.id} flexDirection="column">
          <Box>
            <Text bold={isCurrent} color={isCurrent ? p.accent : p.primary}>
              {`  ${isCurrent ? '◉' : '○'} ${shown}`}
            </Text>
            {tooLong ? <Text>{'\n    '}</Text> : <Text>{' '.repeat(MODEL_COL - shown.length + 1)}</Text>}
            {/* UnoRouter's upstream count leads, in its own colour. The number
                is what the operator asked for — how many channels stand behind
                this model. The colour is OUR tier, not UnoRouter's status
                (the catalog publishes none), which is why the count is printed
                beside the dot rather than replaced by it. */}
            {kind === 'unorouter' && mod.upstreamNote ? (
              <Text>
                <Text color={upstreamStyle(p, mod.redundancy ?? 'unknown')}>{mod.upstreamNote}</Text>
                <Text color={p.dim}>{' · '}</Text>
              </Text>
            ) : null}
            <Text color={p.dim}>{mod.blurb + '\n'}</Text>
          </Box>
          {kind === 'antseed' && shown !== mod.id ? (
            <Text color={p.dim}>{`      → ${mod.id}\n`}</Text>
          ) : null}
        </Box>,
      );
    }
    rows.push(
      <Box key="pick">
        <Text color={p.dim}>{'\n  pick one with  '}</Text>
        <Text bold color={p.primary}>
          {'/model <name>\n'}
        </Text>
      </Box>,
    );
  }
  const notes: ReactNode[] = [];
  if (kind === 'openrouter') {
    notes.push(
      <Text key="or" color={p.dim}>
        {'  free = :free suffix and a zero price · tools-capable only\n'}
      </Text>,
    );
  }
  if (kind === 'unorouter') {
    notes.push(
      <Text key="un" color={p.dim}>
        {
          "  free = the catalog's own is_free · text output and tools-capable only,\n  so image, embedding and speech models are filtered out\n"
        }
      </Text>,
    );
    // The upstream count is the reason this list is sorted the way it is, so
    // the legend says what the number means AND what the colour does not.
    notes.push(
      <Text key="up" color={p.dim}>
        {
          '\n  upstreams = how many channels can serve this model. One channel means\n  a rate limit there is the end of the request, not a retry elsewhere —\n  which is why the single-channel models at the bottom are the ones that\n  stall. Sorted most-redundant first.\n'
        }
      </Text>,
    );
    notes.push(
      <Box key="col">
        <Text color={p.dim}>{'  the colour is this harness\'s read of that count, '}</Text>
        <Text bold color={p.amber}>
          not UnoRouter's status
        </Text>
        <Text color={p.dim}>{' — it publishes none\n'}</Text>
      </Box>,
    );
  }
  if (kind === 'antseed') {
    notes.push(
      <Text key="as" color={p.dim}>
        {
          '  free = a seller charging 0 in and 0 out · the id shown is pinned\n  to that seller (<peerId>@<model>), because the router\'s trust floor\n  skips free peers on its own\n'
        }
      </Text>,
    );
  }
  if (kind === 'aihubmix') {
    // The two things a reader of this list would otherwise get wrong. Both
    // were measured, and both contradict what the catalog looks like it is
    // saying — the suffix that reads as free, and the tool_call field that
    // reads as "no tools".
    notes.push(
      <Text key="free" color={p.dim}>
        {
          '  free = priced 0 in and 0 out · NOT the -free suffix, which is on some\n  models that charge · chat models only\n'
        }
      </Text>,
    );
    notes.push(
      <Text key="tools" color={p.dim}>
        {
          '  tool support is not a filter: AIHubMix leaves tool_call null on models\n  that do call tools, so filtering on it would hide working ones\n'
        }
      </Text>,
    );
  }
  if (kind === 'zai') {
    notes.push(
      <Text key="plan" color={p.dim}>
        {
          '  included = covered by the GLM Coding Plan subscription · plan usage\n  limits and quotas are controlled by Z.ai, not estimated here\n'
        }
      </Text>,
    );
    notes.push(
      <Text key="context" color={p.dim}>
        {
          '  [1m] is the documented opt-in spelling for the 1M context window;\n  leave it off for the standard context window\n'
        }
      </Text>,
    );
  }
  ctx.say(
    <Box flexDirection="column">
      <Text bold color={p.accent}>
        {`  ${label} — ${kind === 'zai' ? 'MODEL REGISTRY' : 'FREE MODELS'}\n\n`}
      </Text>
      {rows}
      {notes}
    </Box>,
  );
  refreshModelChoices(ctx);
}

export function cmdLogfareModels(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  void (async () => {
    // The status API is public, so this needs no key and works before the
    // operator has authenticated anything.
    ctx.sysLine('fetching the Logfare catalog…');
    const [models, err] = await m.logfare.fetchModels();
    const p = ctx.pal();
    if (models === null) {
      ctx.sysLine(`Logfare: ${err}`, true);
      return;
    }
    ctx.say(
      <Box flexDirection="column">
        <Text bold color={p.accent}>
          {'  LOGFARE — LIVE MODELS\n\n'}
        </Text>
        {!models.length ? (
          <Text color={p.amber}>{'  Logfare is serving no chat models right now.\n'}</Text>
        ) : (
          <Box flexDirection="column">
            {models.map((lm) => (
              <Box key={lm.id}>
                <Text bold={lm.id === ctx.cfg.model} color={lm.id === ctx.cfg.model ? p.accent : p.primary}>
                  {`  ${lm.id === ctx.cfg.model ? '◉' : '○'} ${lm.id.padEnd(26)}`}
                </Text>
                {/* A degraded model is flagged in amber rather than dim: it is
                    the one thing on this screen worth noticing. */}
                <Text color={lm.healthy ? p.dim : p.amber}>{lm.blurb + '\n'}</Text>
              </Box>
            ))}
            <Box>
              <Text color={p.dim}>{'\n  pick one with  '}</Text>
              <Text bold color={p.primary}>
                {'/model <name>\n'}
              </Text>
            </Box>
          </Box>
        )}
        <Text color={p.dim}>
          {`  ${models.length} chat models served · fetched from ${m.logfare.HOST ?? ''}${m.logfare.STATUS_PATH ?? ''}\n`}
        </Text>
      </Box>,
    );
    // The popup and /model both read the cache this fetch just warmed.
    refreshModelChoices(ctx);
  })();
}

/** Used by app.tsx's boot: warm the Logfare catalog once, silently. */
export function warmLogfareCatalog(ctx: AppCtx): void {
  const m = ctx.mods();
  if (!m) return;
  void m.logfare.fetchModels().catch(() => {
    /* deliberately silent: a launch that cannot reach the status API is still
       a working launch; /model falls back to the declared list and says so */
  });
}

export type { ConfigLike };
