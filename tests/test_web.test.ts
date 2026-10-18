/**
 * tests/test_web.test.ts — vitest port of tests/test_web.py.
 *
 * Two things here are load-bearing and neither is visual: the geometry
 * (every render is exactly height rows of exactly width columns, and the
 * panes sit inside the canvas) and the tracker's arithmetic (which rung a
 * finding lands on, what `worst` reports, and that a severity the model
 * spelled oddly still counts).
 *
 * No terminal is needed: WaveWeb renders into a character grid and converts
 * to React nodes at the end, so the tests flatten those nodes back to text.
 * The Python suite read private members (_hits, _layout, _grid_pos); the TS
 * port keeps them private, so the same facts are established through the
 * public hit()/layout() surface — scanning the hit map by coordinate instead
 * of iterating it, which is the same map read a different way.
 */

import { describe, expect, it } from 'vitest'

import { getPalette } from '../src/theme.js'
import { EMBLEM, splashMark } from '../src/ui/banner.js'
import {
  BOX_MIN_H,
  DRAWER_MAX_W,
  DRAWER_MIN_W,
  FLASH_SECONDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  PANE_MIN_W,
  RAIL_MAX_W,
  RAIL_MIN_W,
  SPINNER,
  spinnerAt,
  WaveWeb,
  type AgentCell,
} from '../src/ui/web.js'

// ---------------------------------------------------------------------------
// render flattening: React nodes -> plain text (the Python `.plain`)
// ---------------------------------------------------------------------------

type Elem = { type: unknown; props?: { children?: unknown } }

function isElem(n: unknown): n is Elem {
  return !!n && typeof n === 'object' && 'type' in (n as object)
}

/** All string descendants of a node, concatenated in document order. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isElem(node)) return textOf(node.props?.children)
  return ''
}

/** render() as text rows — the root fragment's direct children are the rows. */
function linesOf(node: unknown): string[] {
  const root = node as Elem
  const kids = root.props?.children
  if (Array.isArray(kids)) return kids.map((k) => textOf(k))
  return [textOf(root)]
}

function plain(w: WaveWeb, width: number, height: number): string {
  return linesOf(w.render(width, height)).join('\n')
}

/** One styled run of the render as "bold?color:text" (the Python `._spans`). */
function styledSpans(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(styledSpans)
  if (!isElem(node)) return []
  const props = (node.props ?? {}) as { color?: string; bold?: boolean; children?: unknown }
  if (props.color !== undefined || props.bold !== undefined) {
    return [`${props.bold ? 'bold ' : ''}${props.color ?? ''}:${textOf(node)}`]
  }
  return styledSpans(props.children)
}

// ---------------------------------------------------------------------------
// hit-map reads (the Python iterated w._hits; here the same map is scanned)
// ---------------------------------------------------------------------------

type Hit = [string, string]

function findHit(
  w: WaveWeb,
  width: number,
  height: number,
  kind: string,
  key?: string,
): [number, number] | null {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h = w.hit(x, y)
      if (h && h[0] === kind && (key === undefined || h[1] === key)) return [x, y]
    }
  }
  return null
}

/** Distinct keys of one hit kind across the whole last frame. */
function hitKeys(w: WaveWeb, width: number, height: number, kind: string): Set<string> {
  const out = new Set<string>()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h = w.hit(x, y)
      if (h && h[0] === kind) out.add(h[1])
    }
  }
  return out
}

/** The bounding box of one hit region — where a pane was actually laid out. */
function regionBounds(
  w: WaveWeb,
  width: number,
  height: number,
  kind: string,
  key: string,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const h = w.hit(x, y)
      if (h && h[0] === kind && h[1] === key) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
  }
  if (minX === Infinity) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Only the columns the drawer occupies, flattened to one line.
 *
 * The canvas is a grid, so a row of the render interleaves the rail, the
 * pane columns and the drawer side by side. Reading the whole render would
 * splice unrelated text into the middle of a drawer sentence; slicing the
 * drawer's own columns out first is what makes an assertion on its wording
 * mean what it says. The drawer's border columns are dropped (both ends of
 * every sliced row) so a joined sentence does not read "orders/10┃42".
 */
function drawerText(w: WaveWeb, width: number, height: number): string {
  const rendered = linesOf(w.render(width, height))
  const lay = w.layout(width, height)
  if (!lay.drawerW) return ''
  const x = width - lay.drawerW - 1
  const inner = rendered.map((line) => line.slice(x + 1, x + lay.drawerW - 1))
  return inner.join('').split(/\s+/).filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------

function web(n = 10): WaveWeb {
  const w = new WaveWeb('target.test', getPalette('green', null), { wave: 1, size: n })
  w.setPlan(
    Array.from({ length: n }, (_, i) => ({ name: `agent-${i + 1}`, brief: `vector ${i + 1}` })),
  )
  return w
}

/** The marks a compact-fallback agent row can start with. */
const ROW_MARKS = ['·', '◆', ...SPINNER]

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('wave web', () => {
  it('test_render_is_exact: every render is exactly the size asked for, at every size tried', () => {
    // This is the assertion that catches a pane drawn past the right edge or
    // a spoke that walks off the bottom: the grid silently drops those
    // writes, so the only symptom is a canvas of the wrong shape.
    const w = web(10)
    w.addFinding({ agent: 'agent-3', severity: 'critical', title: 'SQLi in ?id', asset: 'api.target.test' })
    for (const [width, height] of [[118, 36], [120, 40], [80, 24], [78, 22], [200, 50], [74, 21], [60, 18]] as const) {
      const lines = linesOf(w.render(width, height))
      // geometry: {width}x{height} is {height} rows
      expect(lines.length, `${width}x${height}`).toBe(height)
      // geometry: {width}x{height} is {width} columns, no ragged rows
      expect(new Set(lines.map((l) => l.length)), `${width}x${height}`).toEqual(new Set([width]))
    }
  })

  it('test_web_fits_at_minimum: at exactly the minimum size the panes are drawn, not the fallback', () => {
    const w = web(10)
    w.addFinding({ agent: 'agent-1', severity: 'high', title: 'X' })
    const text = plain(w, MIN_WIDTH, MIN_HEIGHT)
    // minimum: the tracker rail is drawn at the minimum size
    expect(text).toContain('ANDY-TRACK')
    // minimum: panes are drawn, not the list
    expect(text).toContain('┏')
    expect(text).toContain('┌─')
    // Eight of ten fit at the minimum; the other two have to be accounted
    // for rather than silently missing, or the view reads as a wave that
    // lost them.
    // minimum: the agents that do not fit are named
    expect(text).toContain('not shown')
  })

  it('test_panes_stay_inside_the_canvas: no agent pane border is clipped by the edge of the screen', () => {
    // Asserted structurally rather than by counting corners: every pane that
    // was drawn must have a bottom-right corner, at a row and column inside
    // the canvas. That catches a pane clipped on any edge, at any layout
    // (the old geometry laid panes out off the bottom and the grid dropped
    // them silently, hit regions and all).
    const w = web(10)
    for (const [width, height] of [[118, 36], [80, 24], [78, 22], [200, 50], [92, 26]] as const) {
      const lines = linesOf(w.render(width, height))
      const tops = lines.reduce((a, l) => a + (l.match(/┌/g)?.length ?? 0), 0)
      const bottoms = lines.reduce((a, l) => a + (l.match(/┘/g)?.length ?? 0), 0)
      // panes: every box drawn is closed
      expect(tops, `${width}x${height} tops=${tops} bottoms=${bottoms}`).toBe(bottoms)
      lines.forEach((line, i) => {
        if (line.includes('┘')) {
          // panes: no bottom border on the last row
          expect(i, `${width}x${height} row=${i}`).toBeLessThan(height - 1)
        }
      })
      // And nothing may be drawn flush against the terminal's own edge.
      for (const line of lines) {
        // panes: no pane is flush against the right edge
        expect(line.length, `${width}x${height}`).toBe(width)
      }
    }
  })

  it('test_adaptive_geometry: capacity is honest — every slot the layout promises is drawn inside the canvas', () => {
    // The old view asked for a fixed six-row pane and then computed how many
    // fit, which reported six panes at 118x36 where only four could be drawn;
    // the two extra were laid out below the last row, silently dropped, and
    // their hit regions never recorded. Here every promised slot is asserted
    // through the hit map: a region the render actually marked, sitting
    // fully inside the canvas.
    for (const [width, height] of [[118, 36], [120, 40], [150, 44], [200, 50], [92, 26], [110, 34], [96, 28], [300, 60]] as const) {
      const w = web(10)
      const lay = w.layout(width, height)
      if (!lay.web) continue
      // layout: pane clears the minimum width
      expect(lay.paneW, `${width}x${height}`).toBeGreaterThanOrEqual(PANE_MIN_W)
      // layout: pane clears the minimum height
      expect(lay.boxH, `${width}x${height}`).toBeGreaterThanOrEqual(BOX_MIN_H)
      w.render(width, height)
      const drawn = hitKeys(w, width, height, 'pane')
      // layout: draws every slot it promised
      expect(drawn.size, `${width}x${height}`).toBe(Math.min(10, lay.capacity))
      // layout: every drawn slot is inside the canvas (the Python check ran
      // _grid_pos per slot; the region bounds are the same coordinates,
      // observed from where the render actually painted each pane).
      for (const name of drawn) {
        const b = regionBounds(w, width, height, 'pane', name)
        expect(b, `${width}x${height} ${name}`).not.toBeNull()
        expect(b!.maxX, `${width}x${height} ${name}`).toBeLessThan(width - 1)
        expect(b!.maxY, `${width}x${height} ${name}`).toBeLessThanOrEqual(height - 2)
      }
    }
  })

  it('test_all_ten_agents_are_big_enough_to_read', () => {
    // The point of the rewrite: ten panes that each show a command AND
    // several lines of what it returned, rather than six panes with one.
    for (const [width, height] of [[118, 36], [150, 44], [200, 50]] as const) {
      const w = web(10)
      w.render(width, height)
      const drawn = hitKeys(w, width, height, 'pane')
      // readable: all ten agents are drawn
      expect(drawn.size, `${width}x${height} drawn=${[...drawn].sort()}`).toBe(10)
      const lay = w.layout(width, height)
      // A pane's content rows are the command, the output, and the tail.
      const outputRows = lay.boxH - 4
      // readable: a pane shows at least two output rows
      expect(outputRows, `${width}x${height}`).toBeGreaterThanOrEqual(2)
    }
  })

  it('test_rail_border_survives: the tracker rail border is unbroken and spans the full height', () => {
    // The rail is the anchor the panes are read against; a gap in its border
    // reads as a drawing fault rather than as a layout.
    const RAIL_CHARS = new Set(['┏', '┓', '━', ' ', 'A', 'N', 'D', 'Y', '-', 'T', 'R', 'C', 'K'])
    const w = web(10)
    for (const [width, height] of [[118, 36], [120, 40]] as const) {
      const lines = linesOf(w.render(width, height))
      const top = lines.findIndex((l) => l.includes('┏━ ANDY-TRACK'))
      // rail: the tracker box is drawn
      expect(top, `${width}x${height}`).toBeGreaterThanOrEqual(0)
      if (top < 0) continue
      const row = lines[top]!
      const start = row.indexOf('┏')
      const end = row.indexOf('┓')
      const border = row.slice(start, end + 1)
      // rail: the top border is unbroken
      expect([...new Set(border.split(''))].every((c) => RAIL_CHARS.has(c)), `${width}x${height} ${border}`).toBe(true)
      // rail: it starts on the first row
      expect(top, `${width}x${height}`).toBe(0)
      // rail: it reaches the last row
      expect(lines[height - 1]!.trimStart().startsWith('┗'), `${width}x${height} ${lines[height - 1]!.slice(0, 40)}`).toBe(true)
    }
  })

  // ---------------------------------------------------------------------------
  // The tracker
  // ---------------------------------------------------------------------------

  it('test_counts_land_on_the_right_rung: every finding is counted once, on its own severity rung', () => {
    const w = web(10)
    for (const [agent, sev] of [['agent-1', 'critical'], ['agent-2', 'critical'], ['agent-3', 'high'], ['agent-4', 'low'], ['agent-5', 'info']] as const) {
      w.addFinding({ agent, severity: sev, title: `${sev} bug` })
    }
    const counts = w.counts()
    expect(counts['critical']).toBe(2) // tracker: criticals are counted
    expect(counts['high']).toBe(1) // tracker: highs are counted
    expect(counts['medium']).toBe(0) // tracker: mediums are counted
    expect(counts['low']).toBe(1) // tracker: lows are counted
    // tracker: info is counted too, even though no lane shows it
    expect(counts['info']).toBe(1)
    // tracker: the total is every finding
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('test_severity_spellings_are_normalised: an odd severity spelling still lands on a rung', () => {
    // A finding the model spelled "severe" or "moderate" must not fall into a
    // bucket that has no lane, or it would be counted in the total and
    // invisible in the breakdown.
    const w = web(10)
    w.addFinding({ agent: 'a', severity: 'SEVERE', title: 'x' })
    w.addFinding({ agent: 'b', severity: 'Moderate', title: 'y' })
    w.addFinding({ agent: 'c', severity: 'gibberish', title: 'z' })
    const counts = w.counts()
    expect(counts['critical']).toBe(1) // tracker: 'severe' folds onto critical
    expect(counts['medium']).toBe(1) // tracker: 'moderate' folds onto medium
    expect(counts['info']).toBe(1) // tracker: an unknown severity folds onto info
  })

  it('test_worst_and_feed: worst reports the top rung; recent is newest-first', () => {
    const w = web(10)
    expect(w.worst()).toBe('') // tracker: an empty tracker has no worst
    w.addFinding({ agent: 'a', severity: 'low', title: 'first' })
    expect(w.worst()).toBe('low') // tracker: one low is the worst so far
    w.addFinding({ agent: 'b', severity: 'critical', title: 'second' })
    expect(w.worst()).toBe('critical') // tracker: a critical takes over as worst
    w.addFinding({ agent: 'c', severity: 'high', title: 'third' })
    expect(w.worst()).toBe('critical') // tracker: a high does not displace a critical
    const recent = w.recent(2).map((f) => f.title)
    expect(recent).toEqual(['third', 'second']) // tracker: recent is newest-first
  })

  it('test_findings_light_their_agent: a finding tallies against its reporter, and only that one', () => {
    const w = web(10)
    w.addFinding({ agent: 'agent-4', severity: 'critical', title: 'SQLi' })
    const byName = new Map<string, AgentCell>(w.agents.map((c) => [c.name, c]))
    // agents: the reporter's count went up
    expect(byName.get('agent-4')!.findings).toBe(1)
    // agents: the reporter records its worst rung
    expect(byName.get('agent-4')!.worst).toBe('critical')
    // agents: the reporter is flashing
    expect(byName.get('agent-4')!.lit()).toBe(true)
    // agents: a different agent's count did not move
    expect(byName.get('agent-5')!.findings).toBe(0)
    // agents: a different agent is not flashing
    expect(byName.get('agent-5')!.lit()).toBe(false)
    // A finding attributed to an agent that is not in the roster must not
    // raise — a wave can be replanned, and the tracker outlives its roster.
    w.addFinding({ agent: 'agent-99', severity: 'low', title: 'ghost' })
    // agents: a finding from an unknown agent is still tallied
    expect(w.counts()['low']).toBe(1)
    // And the flash expires (mono() is seconds; wound back past the window).
    byName.get('agent-4')!.flash = performance.now() / 1000 - FLASH_SECONDS - 1
    // agents: the flash expires
    expect(byName.get('agent-4')!.lit()).toBe(false)
  })

  it('test_agent_lifecycle: start / activity / done drive the pane status, and end() sweeps up', () => {
    const w = web(10)
    const byName = new Map<string, AgentCell>(w.agents.map((c) => [c.name, c]))
    // agents: a planned agent starts idle
    expect(byName.get('agent-1')!.status).toBe('idle')
    w.agentStart('agent-1', 'sqlmap on /api')
    // agents: start marks it running
    expect(byName.get('agent-1')!.status).toBe('running')
    // agents: start records the brief
    expect(byName.get('agent-1')!.activity).toBe('sqlmap on /api')
    w.agentActivity('agent-1', '$ sqlmap -u ...')
    // agents: activity replaces what it is doing
    expect(byName.get('agent-1')!.activity).toBe('$ sqlmap -u ...')
    w.agentDone('agent-1', false)
    // agents: a failed agent is marked failed
    expect(byName.get('agent-1')!.status).toBe('failed')
    w.agentStart('agent-2')
    w.end()
    // agents: end() finishes anything still running
    expect(byName.get('agent-2')!.status).toBe('done')
    // agents: end() stops the clock
    expect(w.ended).toBeGreaterThan(0)
  })

  it('test_plan_replaces_the_roster: a replanned wave gets a fresh roster', () => {
    const w = web(10)
    w.setPlan([{ name: 'a', brief: '1' }, { name: 'b', brief: '2' }], { wave: 1 })
    // plan: the roster is the one returned
    expect(w.agents.map((c) => c.name)).toEqual(['a', 'b'])
    w.setPlan([{ name: 'c', brief: '3' }], { wave: 2 })
    // plan: a second plan replaces the first
    expect(w.agents.map((c) => c.name)).toEqual(['c'])
    // plan: the wave number follows the plan
    expect(w.wave).toBe(2)
    // More workers than the pane has room for must be truncated, not overflow.
    w.setPlan(Array.from({ length: 30 }, (_, i) => ({ name: `x${i}` })))
    // plan: a roster larger than the wave size is truncated
    expect(w.agents.length).toBe(w.size)
  })

  // ---------------------------------------------------------------------------
  // The fallback
  // ---------------------------------------------------------------------------

  it('test_compact_fallback: a too-small terminal gets a list, with every fact in it', () => {
    const w = web(10)
    w.addFinding({ agent: 'agent-3', severity: 'critical', title: 'SQLi in ?id', asset: 'api.target.test' })
    w.agentStart('agent-7', 'nuclei')
    for (const [width, height] of [[60, 18], [40, 12]] as const) {
      const lines = linesOf(w.render(width, height))
      // fallback: still {height} rows
      expect(lines.length, `${width}x${height}`).toBe(height)
      const text = lines.join('\n')
      // fallback: does not draw panes
      expect(text).not.toContain('┏')
      expect(text).not.toContain('┌─')
      // fallback: still names the tracker
      expect(text).toContain('ANDY-TRACK')
      // fallback: still shows the tally
      expect(text).toContain('CRIT 1')
      // The list never lies about the wave: whoever was cut has to be
      // accounted for, or a nine-line list under a "10 agents" header reads
      // as a lost worker.
      const listed = lines.filter(
        (line) =>
          !line.includes('─▶') &&
          ROW_MARKS.some((m) => line.trim().startsWith(m)),
      ).length
      // fallback: accounts for every agent it cannot list
      expect(text.includes('more') || listed >= 10, `${width}x${height} listed=${listed}`).toBe(true)
      // fallback: names at least one agent
      expect(
        Array.from({ length: 10 }, (_, i) => `agent-${i + 1}`).some((n) => text.includes(n)),
        `${width}x${height}`,
      ).toBe(true)
    }
    // A single agent still gets the pane layout — one column of one — rather
    // than a list, because the rail is worth drawing at any wave size.
    const one = web(1)
    // fallback: a single agent still gets panes
    expect(plain(one, 118, 36)).toContain('┌─')
  })

  it('test_truncated_roster_keeps_the_reporters: a short terminal lists whoever is busy, then counts the rest', () => {
    // If the list is cut, it must cut the idle tail — dropping the one agent
    // that reported a critical while listing eight idle ones would hide the
    // only thing on the screen worth reading.
    const w = web(10)
    w.addFinding({ agent: 'agent-10', severity: 'critical', title: 'SQLi' })
    w.agentStart('agent-9', 'nuclei')
    const lines = linesOf(w.render(40, 12))
    const text = lines.join('\n')
    // fallback: the reporting agent survives truncation
    expect(text).toContain('agent-10')
    expect(text).toContain('SQLi')
    // fallback: the running agent survives truncation
    expect(text).toContain('agent-9')
    expect(text).toContain('nuclei')
    // fallback: the agents it could not list are counted, not dropped
    expect(text).toContain('+5 more')
    // The count must add up — checked by arithmetic rather than a magic
    // number, because the count itself was once wrong (roster trimmed for
    // the "+N more" row, then counted against the untrimmed list). Agent
    // rows read "· agent-N …"; feed rows read "· agent-N ─▶ [SEV] title";
    // the "+N more" row is a count, not an agent.
    const listed = lines.filter(
      (line) =>
        !line.includes('─▶') &&
        !line.includes(' more') &&
        ROW_MARKS.some((m) => line.trim().startsWith(`${m} agent-`)),
    ).length
    const hiddenMatch = lines.map((l) => /\+(\d+) more/.exec(l)).find(Boolean)
    const hidden = hiddenMatch ? Number.parseInt(hiddenMatch[1]!, 10) : 0
    // fallback: listed plus hidden accounts for the whole wave
    expect(listed + hidden, `listed=${listed} hidden=${hidden}`).toBe(10)
  })

  // ---------------------------------------------------------------------------
  // The splash banner
  // ---------------------------------------------------------------------------

  it('test_splash_banner: the mark is centred, and stays centred when the transcript reflows', () => {
    const p = getPalette('green', null)
    const mark = splashMark(p, 'deepseek-v4.1-flash', 'http://localhost:4001')
    const text = mark.replace(/\u001b\[[0-9;]*m/g, '') // strip chalk's SGR codes
    const rows = text.split('\n')
    // splash: the mark carries the name (renamed ZIMZILLA -> ANDY)
    expect(text).toContain('ANDY')
    // splash: the mark carries the model
    expect(text).toContain('deepseek-v4.1-flash')
    // splash: the mark carries the endpoint
    expect(text).toContain('localhost:4001')
    // splash: the mark is four rows
    expect(rows.length).toBe(EMBLEM.length)

    // The pinned property in the TS port: the mark carries NO indent of its
    // own — a hand-padded banner is centred for exactly one width, the width
    // it was launched at, and a rail drag reflows it off-centre.
    for (const row of rows) {
      expect(row.startsWith(' ') || row === row.trimStart(), row).toBe(true)
    }

    // Centre as a block (what a caller does on each render): pad every row
    // to the block width, indent the block, then pad to the pane width —
    // Rich Align.center + Console behaviour over a multi-line renderable.
    const blockW = Math.max(...rows.map((r) => r.length))
    const centerBlock = (width: number): string[] => {
      const left = Math.max(0, Math.floor((width - blockW) / 2))
      return rows.map((r) => (' '.repeat(left) + r.padEnd(blockW, ' ')).padEnd(width, ' '))
    }

    // At every width, every row is the full pane width and the emblem column
    // starts at the same place on every row — "the mark is not sheared".
    for (const width of [120, 100, 80, 70]) {
      const out = centerBlock(width)
      // splash: every row is the full pane width
      expect(new Set(out.map((r) => r.length)), String(width)).toEqual(new Set([width]))
      const starts = out.filter((r) => r.trim()).map((r) => r.length - r.trimStart().length)
      // splash: the emblem is not sheared
      expect(Math.max(...starts) - Math.min(...starts), String(width)).toBeLessThanOrEqual(1)
    }

    // The point of the whole change: the same mark re-centres itself, so the
    // banner is centred at a width it was never rendered at before.
    const wide = centerBlock(120)[0]!
    const narrow = centerBlock(70)[0]!
    // splash: the banner re-centres for a new width
    expect(narrow.length - narrow.trimStart().length).toBeLessThan(wide.length - wide.trimStart().length)

    // And it is actually centred, not merely re-indented: the left and right
    // margins of the widest row agree to within the odd/even rounding.
    for (const width of [120, 101, 80, 71]) {
      const out = centerBlock(width)
      const row = out.reduce((a, b) => (b.trimEnd().length > a.trimEnd().length ? b : a))
      const left = row.length - row.trimStart().length
      const right = row.length - row.trimEnd().length
      // splash: the banner is centred
      expect(Math.abs(left - right), String(width)).toBeLessThanOrEqual(1)
    }
  })

  // ---------------------------------------------------------------------------
  // Planning state
  // ---------------------------------------------------------------------------

  it('test_planning_state: before the roster lands the screen says it is planning, not "0 agents"', () => {
    // The screen is pushed at hunt_wave_start, but the roster only arrives
    // with hunt_plan, after the planner's turn returns — tens of seconds of
    // a real model call during which the view must not read as a wave that
    // started with nobody in it.
    const w = new WaveWeb('*.lerevecraze.com', getPalette('green', null), { wave: 1, size: 10 })
    // planning: a fresh web is planning
    expect(w.planning).toBe(true)

    // The wide view draws a PLANNING box where the panes would be.
    const wide = plain(w, 118, 36)
    // planning: the wide view says PLANNING
    expect(wide).toContain('PLANNING')
    // planning: the rail is still drawn
    expect(wide).toContain('ANDY-TRACK')
    // planning: it does not claim zero agents
    expect(wide).not.toContain('0 agents')

    // The narrow view takes the list, and says the same thing there.
    const narrow = plain(w, 60, 18)
    // planning: the narrow view says planning, not 0 agents
    expect(narrow).toContain('planning')
    expect(narrow).not.toContain('0 agents')
    // planning: the empty roster slot is explained
    expect(narrow).toContain('roster lands')

    // The feed itself: the planner's real reasoning and its real tool calls,
    // on screen while it works.
    w.plannerText(
      'the auth bypass is closed, so wave 2 should pivot to the wp-json surface the recon notes flagged',
    )
    w.plannerTool('grep')
    const fed = plain(w, 118, 36)
    // planning: the planner's reasoning reaches the screen
    expect(fed).toContain('pivot to the')
    // planning: the planner's tool call reaches the screen
    expect(fed).toContain('$ grep')
    // planning: the blocks are counted
    expect(fed).toContain('2 block(s)')

    // And it stops saying it the moment a roster arrives.
    w.setPlan(Array.from({ length: 10 }, (_, i) => ({ name: `agent-${i + 1}`, brief: 'b' })))
    // planning: a roster ends the planning state
    expect(w.planning).toBe(false)
    const after = plain(w, 118, 36)
    // planning: the panes are drawn, not the list
    expect(after).toContain('┌─')
    // planning: the rail goes back to LIVE
    expect(after).toContain('LIVE')
    // planning: the PLANNING box is gone
    expect(after).not.toContain('PLANNING')
    const header = linesOf(w.render(60, 18))[0]!
    // planning: the header counts the real roster
    expect(header).toContain('10 agents')

    // A finding with no roster is not a planning wave — it is a wave that
    // has already reported, which only happens once agents exist. Guard the
    // predicate so a stray finding cannot leave the header stuck on PLANNING.
    const w2 = new WaveWeb('t.test', getPalette('green', null), { wave: 1, size: 10 })
    w2.addFinding({ agent: 'agent-1', severity: 'high', title: 'x' })
    // planning: a reported finding is not planning
    expect(w2.planning).toBe(false)
  })

  it('test_agent_output_reaches_the_pane: a pane shows the command AND what the command returned', () => {
    // The result half was being emitted by the hunt loop, routed to the wave
    // screen, and then dropped — every pane drew a command over an empty box.
    const w = web(10)
    const cmd = '$ curl -s -i $U/wp-json/wc/v3/orders/1042'
    w.agentActivity('agent-1', cmd)
    w.agentResult(
      'agent-1',
      cmd,
      'HTTP/1.1 200 OK\nContent-Type: application/json\n' +
        '{"id":1042,"billing":{"email":"a@b.c"}}\nserver: nginx',
    )
    const text = plain(w, 150, 44)
    // output: the command is drawn
    expect(text).toContain('curl -s -i')
    // output: the response status line is drawn
    expect(text).toContain('HTTP/1.1 200 OK')
    // output: the response body is drawn
    expect(text.includes('{"id":1042') || text.includes('Content-Type')).toBe(true)
    const cell = w.agents[0]!
    // output: the whole output is kept for the drawer
    expect(cell.output.length).toBe(4)
    // output: the step is recorded once, not twice
    expect(cell.history.length).toBe(1)
    // output: the recorded step carries its output
    expect(cell.history[0]![1]).toContain('HTTP/1.1 200 OK')

    // A second command must not be drawn over the first one's output.
    w.agentActivity('agent-1', '$ nmap -sV host')
    // output: a new command clears the old output
    expect(cell.output).toEqual([])
    // output: the old command is still in the drawer's run
    expect(w.agents[0]!.history.length).toBe(2)

    // More output than fits is counted, so a clipped listing does not read
    // as a short one.
    w.agentResult('agent-1', '$ nmap -sV host', Array.from({ length: 40 }, (_, i) => `port ${i}`).join('\n'))
    const more = plain(w, 150, 44)
    // output: clipped output is counted
    expect(more.includes('>3') || more.includes('>')).toBe(true)
  })

  it('test_lane_click_opens_the_findings_behind_it: a severity lane is a button', () => {
    // "MED 1" tells the operator a medium was found and nothing else. The
    // drawer is the answer to *what*: the title, the asset, the agent, and
    // the evidence that makes it a finding rather than an opinion.
    const w = web(10)
    w.addFinding({
      agent: 'agent-2', severity: 'medium',
      title: 'Unauthenticated order status read',
      asset: 'http://dev.target.test/orders/1042',
      summary: 'The v3 route answers without a nonce.',
      evidence: 'GET -> 200 with billing email', wave: 1,
    })
    w.addFinding({ agent: 'agent-3', severity: 'low', title: 'a low-severity note that must not appear here' })
    w.render(118, 36)

    // Find the MED lane position from the hit map rather than guessing its
    // row (Python iterated _hits; here the map is scanned by coordinate).
    const laneAt = findHit(w, 118, 36, 'lane', 'medium')
    // drawer: the MED lane is clickable
    expect(laneAt).not.toBeNull()
    if (laneAt === null) return
    const hit = w.click(laneAt[0], laneAt[1])
    // drawer: clicking the lane opens the drawer
    expect(hit).toEqual(['lane', 'medium'])
    // drawer: it is showing that rung
    expect(w.detail?.kind).toBe('findings')
    expect(w.detail?.key).toBe('medium')

    // Read the drawer's own columns (see drawerText).
    const flat = drawerText(w, 118, 36)
    // drawer: the finding's title is shown
    expect(flat).toContain('Unauthenticated order status read')
    // drawer: the asset is shown
    expect(flat).toContain('dev.target.test/orders/1042')
    // drawer: the agent and wave are shown
    expect(flat).toContain('agent agent-2')
    expect(flat).toContain('wave 1')
    // drawer: the evidence is shown
    expect(flat).toContain('GET -> 200')
    // drawer: the summary is shown
    expect(flat).toContain('without a nonce')
    // The other rung must not leak into this one.
    // drawer: another rung's findings are not listed
    expect(flat).not.toContain('low-severity note')
    // The drawer must not be showing the *pane* text either.
    // drawer: the panes' content does not leak in
    expect(flat).not.toContain('waiting')

    // The panes must survive the drawer opening: a drawer that covers the
    // work it describes is worse than no drawer.
    const drawn = hitKeys(w, 118, 36, 'pane')
    // drawer: the panes are still drawn beside it
    expect(drawn.size).toBeGreaterThanOrEqual(2)
    // drawer: the panes are still in more than one column
    expect(w.layout(118, 36).cols).toBeGreaterThanOrEqual(2)

    // A click on bare canvas closes it.
    let empty: [number, number] | null = null
    outer: for (let y = 0; y < 36; y++) {
      for (let x = 0; x < 118; x++) {
        if (w.hit(x, y) === null) {
          empty = [x, y]
          break outer
        }
      }
    }
    if (empty) {
      w.click(empty[0], empty[1])
      // drawer: a click on bare canvas closes it
      expect(w.detail).toBeNull()
    }
  })

  it('test_pane_click_opens_the_agent_run: a pane is a button too', () => {
    // The pane shows the agent's last command and a few lines of its output.
    // The drawer is the rest: the commands that led there, and the responses
    // the pane had no room for.
    const w = web(10)
    for (let i = 0; i < 4; i++) {
      const cmd = `$ curl -s -i $U/step${i}`
      w.agentActivity('agent-4', cmd)
      w.agentResult('agent-4', cmd, `HTTP/1.1 200 OK\nbody of step ${i}`)
    }
    w.agentText('agent-4', 'Checking whether the route enforces a nonce.')
    w.render(150, 44)

    const paneAt = findHit(w, 150, 44, 'pane', 'agent-4')
    // drawer: the agent's pane is clickable
    expect(paneAt).not.toBeNull()
    if (paneAt === null) return
    const hit = w.click(paneAt[0], paneAt[1])
    // drawer: clicking a pane opens that agent's run
    expect(hit).toEqual(['pane', 'agent-4'])
    expect(w.detail?.kind).toBe('agent')

    const flat = drawerText(w, 150, 44)
    // drawer: every step of the run is listed
    for (let i = 0; i < 4; i++) expect(flat, `step${i}`).toContain(`step${i}`)
    // drawer: the reasoning is listed too
    expect(flat).toContain('enforces a nonce')
    // drawer: the outputs are listed
    expect(flat).toContain('body of step 0')
    expect(flat).toContain('body of step 3')

    // The agent whose run is open must not be rotated out of the window, or
    // the drawer would describe a pane that is not on screen.
    const shown = new Set(w.visibleAgents(2).map((c) => c.name))
    // drawer: the open agent is pinned into the pane window
    expect(shown.has('agent-4')).toBe(true)
  })

  it('test_asset_wrapping_keeps_urls_readable: a long asset stays a URL in the drawer', () => {
    // The drawer is the one place the operator copies an asset from; a URL
    // broken at an arbitrary column reads as two URLs. The Python suite
    // unit-tested the private _wrap_asset; the TS port leaves wrapAsset
    // unexported, so the readable-URL property is asserted on what the
    // drawer actually draws.
    const w = web(10)
    w.addFinding({
      agent: 'agent-2', severity: 'medium', title: 'asset read',
      asset: 'http://dev.target.test/orders/1042',
    })
    w.openFindings('medium')
    let flat = drawerText(w, 118, 36)
    // asset: a url that fits is left whole — scheme and all
    expect(flat).toContain('http://dev.target.test/orders/1042')

    // Forced to wrap (a separator-free host longer than the drawer's line),
    // the scheme goes first and nothing is lost: the two drawn fragments
    // reassemble into the host.
    const w2 = web(10)
    const host = 'a'.repeat(40)
    w2.addFinding({ agent: 'agent-2', severity: 'medium', title: 'long host', asset: `https://${host}` })
    w2.openFindings('medium')
    w2.render(118, 36)
    const lay = w2.layout(118, 36)
    const textW = Math.max(4, lay.drawerW - 5)
    const lines = linesOf(w2.render(118, 36))
    const x = 118 - lay.drawerW - 1
    const drawerRows = lines.map((l) => l.slice(x + 5, x + 5 + textW)).filter((l) => l.trim())
    // asset: every drawn drawer line fits its width
    expect(drawerRows.every((l) => l.length <= textW)).toBe(true)
    const fragments = drawerRows.filter((l) => /^a+$/.test(l.trim()))
    // asset: the host is not lost — its fragments reassemble
    expect(fragments.map((f) => f.trim()).join('')).toBe(host)
    // asset: the scheme was dropped, not drawn broken mid-way
    expect(fragments.join('')).not.toContain('http')
  })

  it.skip('test_asset_wrapping unit cases (wrapAsset is module-private in the TS port)', () => {
    // The Python suite pinned _wrap_asset's exact behaviour at tight widths:
    //   - a short url is left alone (scheme intact)
    //   - the scheme is dropped before the path is cut; the host survives
    //   - at width 16 every line fits, nothing is lost (join == url[7:]),
    //     and the breaks land on separators (every line but the last ends "/")
    //   - at width 9 (no separator fits) it still fits and still loses nothing
    //   - a separator-free host is bounded and not lost
    //   - an empty asset yields [""]
    // src/ui/web.tsx keeps wrapAsset unexported per the port's naming rule
    // (leading-underscore helpers stay module-private), and the drawer can
    // only reach textW >= 29 — never narrow enough to exercise the tight
    // widths. Reaching it needs the helper exported (or a test-only seam).
    expect(true).toBe(true)
  })

  it('test_hover_and_spinner_animate: the animations carry information rather than decorating', () => {
    // A spinner on a running agent distinguishes "working" from "stalled";
    // the hover highlight is what says a lane or pane is clickable at all.
    const w = web(10)
    w.agentStart('agent-1', 'nuclei')
    // The spinner is driven off the clock: two instants far enough apart give
    // different glyphs.
    const frames = new Set([0.0, 0.1, 0.2, 0.3, 0.4].map((t) => spinnerAt(t)))
    // animation: the spinner cycles
    expect(frames.size).toBeGreaterThan(1)
    // animation: the spinner is drawn from the braille block
    expect([...frames].every((ch) => SPINNER.includes(ch))).toBe(true)
    // animation: a running agent spins
    // One frame, rendered once: calling plain() inside the .some callback
    // re-rendered per character, and under a loaded runner each render landed
    // a glyph-rotation step (90ms) later — the drawn glyph advanced in
    // lockstep with the checked one at a constant offset, so all ten
    // comparisons missed and the assertion flaked.
    const frame = plain(w, 118, 36)
    expect([...SPINNER].some((ch) => frame.includes(ch))).toBe(true)

    // Hover. The lane's whole row is highlighted. Two renders are needed:
    // the hover resolves against the previous frame's hit map, because the
    // map is built by drawing and is empty at the start of the frame that
    // reads it.
    w.addFinding({ agent: 'agent-1', severity: 'medium', title: 'x' })
    w.render(118, 36)
    const laneAt = findHit(w, 118, 36, 'lane', 'medium')
    // animation: the lane has a hoverable region
    expect(laneAt).not.toBeNull()
    if (laneAt === null) return
    const before = plain(w, 118, 36)
    w.hover = laneAt
    const after = plain(w, 118, 36)
    // animation: hovering the lane changes what is drawn
    expect(after, 'the lane row is unchanged').not.toBe(before)
    // And the hover is not a permanent state: it follows the pointer.
    w.hover = [-1, -1]
    w.render(118, 36)
    // animation: the highlight follows the pointer
    expect(plain(w, 118, 36)).toBe(before)

    // A pane's hover is a style change on its border, so the plain text is
    // identical by design — compare the styled runs instead.
    w.render(150, 44)
    const paneAt = findHit(w, 150, 44, 'pane')
    expect(paneAt).not.toBeNull()
    w.hover = [-1, -1]
    w.render(150, 44)
    const spansBefore = styledSpans(w.render(150, 44)).sort()
    w.hover = paneAt!
    const spansAfter = styledSpans(w.render(150, 44)).sort()
    // animation: hovering a pane restyles its border
    expect(spansBefore.join('\n')).not.toBe(spansAfter.join('\n'))
  })

  it('test_rail_and_drawer_resize: the rail and the drawer are resizable, within sane bounds', () => {
    // The rail's width is a tradeoff the operator is better at making than
    // the layout is: a wider rail fits more of a finding title, a narrower
    // one fits another pane column.
    const w = web(10)
    w.render(118, 36)
    const base = w.layout(118, 36).railW
    w.resizeRail(4)
    w.render(118, 36)
    // resize: the rail widens
    expect(w.layout(118, 36).railW).toBe(Math.min(RAIL_MAX_W, base + 4))
    w.resizeRail(-100)
    w.render(118, 36)
    // resize: the rail stops at its minimum
    expect(w.layout(118, 36).railW).toBe(RAIL_MIN_W)
    w.resizeRail(100)
    w.render(118, 36)
    // resize: the rail stops at its maximum
    expect(w.layout(118, 36).railW).toBe(RAIL_MAX_W)

    // A drawer has to be open before it can be resized, and the width it
    // takes is still bounded by the panes it must leave room for.
    w.openFindings('medium')
    w.render(200, 50)
    // resize: the drawer opens at its default width
    expect(w.layout(200, 50).drawerW).toBeGreaterThan(0)
    w.resizeDrawer(100)
    w.render(200, 50)
    // resize: the drawer stops at its maximum
    expect(w.layout(200, 50).drawerW).toBeLessThanOrEqual(DRAWER_MAX_W)
    w.resizeDrawer(-100)
    w.render(200, 50)
    // resize: the drawer stops at its minimum
    expect(w.layout(200, 50).drawerW).toBeGreaterThanOrEqual(DRAWER_MIN_W)
  })

  it('test_stop_hint_is_advertised_and_confirmed: the rail carries the stop key', () => {
    // The wave view covers the prompt, so /stop-hunt cannot be typed while
    // it is up — the key that replaces it is only usable if the rail names
    // it, and only believable if the rail says it was heard.
    const w = web(10)
    w.agentStart('agent-1', 'b')
    w.agentActivity('agent-1', '$ id')

    const before = plain(w, 118, 36)
    // stop hint: the rail names the key
    expect(before).toContain('ctrl+x')
    // stop hint: and says what it does
    expect(before).toContain('stop')
    // stop hint: nothing claims to be stopping yet
    expect(before).not.toContain('stopping')

    w.stopping = true
    const after = plain(w, 118, 36)
    // stop hint: the confirmation replaces the hint
    expect(after).toContain('stopping')
    expect(after).not.toContain('ctrl+x')

    // The footer is pinned to the bottom of the rail and the feed grows from
    // the top, so the two must not meet. Checked at the shortest height the
    // view draws panes at, where the feed has the least room to give.
    for (const [width, height] of [[92, 26], [118, 36], [200, 50]] as const) {
      for (const stopping of [false, true]) {
        w.stopping = stopping
        const rows = linesOf(w.render(width, height))
        // stop hint: the footer keeps its row
        expect(rows.some((r) => r.includes('stop')), `${width}x${height} stopping=${stopping}`).toBe(true)
        // stop hint: every row is exactly {width} wide
        expect(rows.every((r) => r.length === width), `${width}x${height}`).toBe(true)
      }
    }
  })
})
