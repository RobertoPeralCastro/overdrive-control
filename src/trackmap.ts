import { pieceKind, type Turn } from './track';

/**
 * Turns a learned lap into a drawable loop. Units are straight-piece lengths (560 mm).
 * Curve direction comes from the wheel distances the cars report; curves we have no
 * data for are assumed to bend left. The curve angle is whatever closes the loop
 * (90° for the usual 4 net curves), and any leftover gap is spread along the whole loop.
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

export function layoutTrack(lap: number[], turns: (Turn | undefined)[]): TrackLayout {
  const bends: number[] = lap.map((id, i) => (pieceKind(id) === 'curva' ? (turns[i] === 'R' ? -1 : 1) : 0));
  const net = Math.abs(bends.reduce((a, b) => a + b, 0));
  const angle = (Math.min(90, Math.max(30, net ? 360 / net : 90)) * Math.PI) / 180;

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
