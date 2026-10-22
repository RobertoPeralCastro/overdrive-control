import { pieceKind, type Turn } from './track';

/**
 * Turns a learned lap into a drawable loop. Units are straight-piece lengths (560 mm).
 *
 * Every straight is the same length and every curve turns 90°, so a real track sits on a
 * grid and closes exactly. Curve directions come from the wheel distances the cars report,
 * which can be missing or wrong; so we look for the left/right choice that closes the loop
 * exactly while changing as few measured curves as possible (and, among those, the one that
 * doesn't run over itself). Only when no choice closes (e.g. a piece was missed) we fall back
 * to the measured directions, bend the curves to close the turn and spread the gap.
 */

export const PIECE_MM = 560;
const CURVE_RADIUS = 0.5;
const SAMPLES_PER_CURVE = 8;

export interface Point {
  x: number;
  y: number;
}

export interface TrackLayout {
  /** Points along each piece, from its start to its end, in driving order. */
  pieces: Point[][];
  /** Length of each piece in mm (to place cars along it). */
  lengthsMm: number[];
  minX: number;
  minY: number;
  width: number;
  height: number;
}

function pieceLength(id: number): number {
  if (id === 33) return 0.75;
  if (id === 34) return 0.25;
  return 1;
}

/** Directions on the grid, counter-clockwise from +x (a left turn adds 1). */
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;
/** Above this many curves the search gets too slow for a phone; measured directions are used. */
const MAX_SEARCH_CURVES = 18;

/**
 * Drives the lap on the grid in quarter-piece steps (a straight is 4, a curve moves 2 ahead
 * and 2 to the side). `steps[i]` is the straight length in quarters, or 0 for a curve.
 * Returns whether it ends where it started facing the same way and, if asked, how many pieces
 * land on a spot another piece already took (crossings, `cross[i]`, may be driven twice).
 */
function drive(steps: number[], cross: boolean[], bends: number[], countOverlaps: boolean): { closed: boolean; overlaps: number } {
  let x = 0;
  let y = 0;
  let d = 0;
  const seen = countOverlaps ? new Set<string>() : undefined;
  let overlaps = 0;
  for (let i = 0; i < steps.length; i++) {
    const [fx, fy] = DIRS[d];
    let nx: number;
    let ny: number;
    if (steps[i]) {
      nx = x + fx * steps[i];
      ny = y + fy * steps[i];
    } else {
      d = (d + bends[i] + 4) % 4;
      const [sx, sy] = DIRS[d];
      nx = x + (fx + sx) * 2;
      ny = y + (fy + sy) * 2;
    }
    if (seen && !cross[i]) {
      const key = `${x + nx},${y + ny}`; // twice the middle of the piece, kept whole
      if (seen.has(key)) overlaps++;
      seen.add(key);
    }
    x = nx;
    y = ny;
  }
  return { closed: x === 0 && y === 0 && d === 0, overlaps };
}

/** Left (1) / right (-1) for each curve, 0 for the rest: the choice that closes the loop best. */
export function solveBends(lap: number[], turns: (Turn | undefined)[]): { bends: number[]; closed: boolean } {
  const isCurve = lap.map((id) => pieceKind(id) === 'curva');
  const steps = lap.map((id, i) => (isCurve[i] ? 0 : pieceLength(id) * 4));
  const cross = lap.map((id) => pieceKind(id) === 'cruce');
  const measured = lap.map((_, i) => (isCurve[i] ? (turns[i] === 'R' ? -1 : 1) : 0));
  const curves = lap.flatMap((_, i) => (isCurve[i] ? [i] : []));
  const n = curves.length;
  if (!n || n > MAX_SEARCH_CURVES) return { bends: measured, closed: n > 0 && drive(steps, cross, measured, false).closed };

  // What each curve was measured as: 1 left, -1 right, 0 no reading.
  const read = curves.map((i) => (turns[i] === 'L' ? 1 : turns[i] === 'R' ? -1 : 0));
  let best: { bends: number[]; score: number } | undefined;
  const bends = measured.slice();
  // A closed loop turns once around: four more turns one way than the other. So only the
  // choices with (n + 4) / 2 or (n - 4) / 2 left turns can close (Gosper's hack walks them).
  for (const lefts of new Set([(n + 4) / 2, (n - 4) / 2])) {
    if (!Number.isInteger(lefts) || lefts < 0 || lefts > n) continue;
    const end = 1 << n;
    for (let mask = (1 << lefts) - 1; mask < end; ) {
      let changed = 0;
      for (let k = 0; k < n; k++) {
        const b = mask & (1 << k) ? 1 : -1;
        bends[curves[k]] = b;
        if (read[k] && read[k] !== b) changed++;
      }
      // Trust the cars first, then a loop that doesn't cross itself, then (no data at all) left turns.
      if ((!best || changed * 1000 <= best.score) && drive(steps, cross, bends, false).closed) {
        const score = changed * 1000 + drive(steps, cross, bends, true).overlaps * 10 + (n - lefts) * 0.01;
        if (!best || score < best.score) best = { bends: bends.slice(), score };
      }
      if (mask === 0) break;
      const c = mask & -mask;
      const r = mask + c;
      mask = (((r ^ mask) >>> 2) / c) | r;
    }
  }
  return best ? { bends: best.bends, closed: true } : { bends: measured, closed: false };
}

export function layoutTrack(lap: number[], turns: (Turn | undefined)[]): TrackLayout {
  const { bends, closed } = solveBends(lap, turns);
  // On the grid every curve is 90°. Without a closed solution, bend them to close the turn at least.
  const net = Math.abs(bends.reduce((a, b) => a + b, 0));
  const angle = ((closed ? 90 : Math.min(90, Math.max(30, net ? 360 / net : 90))) * Math.PI) / 180;

  // Walk the loop: x right, y up (flipped when drawing).
  let x = 0;
  let y = 0;
  let heading = 0;
  const raw: Point[][] = [];
  const lengths: number[] = [];
  for (let i = 0; i < lap.length; i++) {
    const pts: Point[] = [{ x, y }];
    if (bends[i] === 0) {
      const len = pieceLength(lap[i]);
      x += Math.cos(heading) * len;
      y += Math.sin(heading) * len;
      pts.push({ x, y });
      lengths.push(len * PIECE_MM);
    } else {
      const side = bends[i];
      // Center of the turning circle sits to the left (or right) of the heading.
      const cx = x + Math.cos(heading + (side * Math.PI) / 2) * CURVE_RADIUS;
      const cy = y + Math.sin(heading + (side * Math.PI) / 2) * CURVE_RADIUS;
      const start = Math.atan2(y - cy, x - cx);
      for (let s = 1; s <= SAMPLES_PER_CURVE; s++) {
        const a = start + side * angle * (s / SAMPLES_PER_CURVE);
        pts.push({ x: cx + Math.cos(a) * CURVE_RADIUS, y: cy + Math.sin(a) * CURVE_RADIUS });
      }
      ({ x, y } = pts.at(-1)!);
      heading += side * angle;
      lengths.push(CURVE_RADIUS * angle * PIECE_MM);
    }
    raw.push(pts);
  }

  // Close the loop: shift every point by its share of the end-to-start gap.
  const total = lengths.reduce((a, b) => a + b, 0);
  let walked = 0;
  const pieces = raw.map((pts, i) => {
    const out = pts.map((p, k) => {
      const share = (walked + (lengths[i] * k) / (pts.length - 1)) / total;
      return { x: p.x - x * share, y: -(p.y - y * share) };
    });
    walked += lengths[i];
    return out;
  });

  const all = pieces.flat();
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  return {
    pieces,
    lengthsMm: lengths,
    minX,
    minY,
    width: Math.max(...all.map((p) => p.x)) - minX,
    height: Math.max(...all.map((p) => p.y)) - minY,
  };
}

/** Point at fraction `t` (0..1) along piece `idx`. */
export function pointOnPiece(layout: TrackLayout, idx: number, t: number): Point {
  const pts = layout.pieces[idx];
  const f = Math.max(0, Math.min(1, t)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
}

/** SVG path through every piece. */
export function trackPath(layout: TrackLayout): string {
  const pts = layout.pieces.flatMap((p, i) => (i === 0 ? p : p.slice(1)));
  return `M ${pts.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' L ')} Z`;
}
