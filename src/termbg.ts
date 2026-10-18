/**
 * termbg.ts — ask the terminal what colour its background is (OSC 11).
 * (port of zimzilla/termbg.py)
 *
 * What this module is: the raw-mode tty query primitive every OSC query in
 * this package goes through. A terminal emulator paints its padding — the
 * gutter between the window edge and the text grid — in its own background
 * colour; a TUI can only paint inside the grid, so an app that hardcodes a
 * background differing from the terminal's gets a frame of the wrong colour
 * around the whole interface. Terminals expose that colour over OSC 11, so
 * the honest fix is to ask.
 *
 * Invariants:
 *  - Everything here is best-effort. A terminal that does not answer, answers
 *    garbage, or is not a tty at all must cost nothing but the timeout — the
 *    caller falls back to the palette's own background.
 *  - Raw mode is undone on every path out, including the failing ones, and
 *    the input buffer is drained, or whatever takes the tty over next (Ink)
 *    reads the reply as keystrokes. Both live here once.
 */

// How long to wait for a reply, in SECONDS. Long enough for a real terminal,
// short enough that one which ignores OSC 11 does not visibly stall startup.
const TIMEOUT = 0.25;

// `rgb:RRRR/GGGG/BBBB` (1-4 hex digits per channel) or `#RRGGBB`. Byte-level
// regexes in Python; run against a latin1 decode here, which is lossless for
// the ASCII these replies are made of.
const RGB_RE = /\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/;
const HASH_RE = /\]11;#([0-9a-fA-F]{6})/;

/**
 * Scale one OSC-11 channel to 0-255.
 *
 * The channel width is not fixed: most terminals send four hex digits
 * (16-bit), some send two (8-bit). Both mean full scale, so divide by the
 * largest value that width can hold rather than assuming 16-bit.
 *
 * (Python's module-private `_scale`; exported because termcolors.ts parses
 * the same channel format with it.)
 */
export function scaleChannel(value: string): number {
  return Math.round((parseInt(value, 16) * 255) / (16 ** value.length - 1));
}

/** Pull `#rrggbb` out of an OSC 11 reply, or undefined if there isn't one. */
export function parseBackground(reply: Buffer): string | undefined {
  const text = reply.toString('latin1');
  const m = RGB_RE.exec(text);
  if (m) {
    const [r, g, b] = [m[1]!, m[2]!, m[3]!].map(scaleChannel);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const h = HASH_RE.exec(text);
  if (h) return `#${h[1]!.toLowerCase()}`;
  return undefined;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * Whether a colour is dark enough to keep this palette readable.
 *
 * The palettes are neon-on-black by design, so adopting a light terminal
 * background would leave bright green text on white. A light reply is refused
 * and the caller keeps the palette's own black.
 *
 * Rec. 601 luma, scaled to integers: the float form lands on 127.999… for the
 * exact midpoint (#808080) and so decides mid-grey by rounding error. Integer
 * arithmetic makes the boundary land where it reads — 128 is not dark.
 */
export function isDark(hexColor: string): boolean {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  return 299 * r + 587 * g + 114 * b < 128_000;
}

/**
 * Write *payload* to the terminal and return whatever it writes back.
 * Timeout is in SECONDS.
 *
 * One raw-mode session: switch the tty to raw, write the escape sequence,
 * read until every query in the payload has been answered or the timeout
 * expires, then restore the terminal.
 *
 * Returns an empty Buffer when there is no tty, when the terminal does not
 * answer, or when the query fails for any other reason — a terminal that
 * does not implement an OSC is not an error, it is an answer of "no".
 */
export async function query(payload: Buffer, timeout: number = TIMEOUT): Promise<Buffer> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Buffer.alloc(0);

  let savedRaw: boolean | undefined;
  try {
    savedRaw = stdin.isRaw;
    stdin.setRawMode(true);
  } catch {
    return Buffer.alloc(0); // any failure means "cannot query"
  }

  // One terminator per query asked. A single-query payload therefore behaves
  // exactly as before; a multi-query one reads until the last reply lands
  // rather than stopping at the first, which is what makes the batched
  // colour query in termcolors.ts one round-trip instead of seventeen.
  const wanted = Math.max(1, countBytes(payload, 0x3f)); // '?'
  const deadline = Date.now() + timeout * 1000;

  const parts: Buffer[] = [];
  let terminators = 0;

  const read = await new Promise<Buffer>((resolve) => {
    let settled = false;
    const finish = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      parts.push(chunk);
      // Python counts complete ST (\x1b\) or BEL (\x07) terminators over the
      // whole reply so far — a chunk boundary can split an ESC \ pair.
      terminators = countTerminators(Buffer.concat(parts));
      if (terminators >= wanted) {
        // Anything past the terminator is not ours. Linger briefly, consuming
        // whatever else arrived, or Ink reads it as keystrokes once it takes
        // the tty over.
        const drainUntil = Math.min(Date.now() + 12, deadline);
        const drain = () => {
          if (Date.now() >= drainUntil) {
            finish(Buffer.concat(parts));
            return;
          }
          setTimeout(drain, 3);
        };
        setTimeout(drain, 3);
      } else if (Date.now() >= deadline) {
        finish(Buffer.concat(parts));
      }
    };
    const timer = setTimeout(() => finish(Buffer.concat(parts)), timeout * 1000);

    stdin.on('data', onData);
    stdin.resume();
    process.stdout.write(payload);
  });

  // Restore before anything else can read the terminal: Ink takes the tty
  // over immediately after this and must not inherit raw mode.
  try {
    stdin.setRawMode(savedRaw ?? false);
  } catch {
    /* a failed restore is not an error either */
  }

  return read;
}

function countBytes(buf: Buffer, byte: number): number {
  let n = 0;
  for (const b of buf) if (b === byte) n++;
  return n;
}

/** Count OSC string terminators: ST (ESC \) or BEL. */
function countTerminators(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x07) n++;
    else if (buf[i] === 0x1b && buf[i + 1] === 0x5c) n++;
  }
  return n;
}

/**
 * The terminal's background as `#rrggbb`, or undefined.
 *
 * Undefined when stdin is not a tty (a pipe, a test harness, a cron job), when
 * the terminal does not answer within the timeout, when the reply is
 * unparseable, or when the colour is too light to use — see isDark().
 */
export async function detectBackground(): Promise<string | undefined> {
  const bg = parseBackground(await query(Buffer.from('\x1b]11;?\x1b\\', 'latin1')));
  return bg && isDark(bg) ? bg : undefined;
}
