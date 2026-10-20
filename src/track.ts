/**
 * Learns the order of the road pieces from the piece IDs a car reports while it drives.
 * Piece IDs identify the piece type (and the start line), not the physical piece, so
 * the same ID can appear several times in one lap.
 */

/** The start/finish piece reports 34 on its short finish section and 33 on the rest. */
const START_IDS = [34, 33];
const CURVE_IDS = new Set([17, 18, 20, 23, 24, 27]);
const STRAIGHT_IDS = new Set([36, 39, 40, 46, 48, 51, 57]);
const CROSS_IDS = new Set([10]);
const MAX_HISTORY = 400;

export type PieceKind = 'salida' | 'recta' | 'curva' | 'cruce' | 'otra';

export function pieceKind(id: number): PieceKind {
  if (START_IDS.includes(id)) return 'salida';
  if (CURVE_IDS.has(id)) return 'curva';
  if (STRAIGHT_IDS.has(id)) return 'recta';
  if (CROSS_IDS.has(id)) return 'cruce';
  return 'otra';
}

export interface Lap {
  /** Piece IDs in driving order. */
  pieces: number[];
  /** Index in `pieces` of the piece the car is on right now. */
  at: number;
}

export class TrackLearner {
  private seq: number[] = [];

  /** Feed every piece ID the car reports; returns the lap once it has seen a full one. */
  push(pieceId: number): Lap | undefined {
    if (this.seq.at(-1) === pieceId) return undefined;
    this.seq.push(pieceId);
    if (this.seq.length > MAX_HISTORY) this.seq.shift();
    return this.lapFromStartLine() ?? this.lapFromRepetition();
  }

  reset(): void {
    this.seq = [];
  }

  /** Official tracks: a lap is everything between two passes over the start line. */
  private lapFromStartLine(): Lap | undefined {
    for (const id of START_IDS) {
      const last = this.seq.length - 1;
      if (this.seq[last] !== id) continue;
      const prev = this.seq.lastIndexOf(id, last - 1);
      if (prev >= 0 && last - prev >= 3) return { pieces: this.seq.slice(prev, last), at: 0 };
    }
    return undefined;
  }

  /** No start piece: wait until the last 2 laps are identical. */
  private lapFromRepetition(): Lap | undefined {
    const n = this.seq.length;
    for (let p = 3; p * 2 <= n; p++) {
      let same = true;
      for (let i = n - p; i < n && same; i++) same = this.seq[i] === this.seq[i - p];
      if (same) return { pieces: this.seq.slice(n - p), at: p - 1 };
    }
    return undefined;
  }
}

export function describeTrack(pieces: number[]): string {
  const count = (k: PieceKind) => pieces.filter((id) => pieceKind(id) === k).length;
  const parts = [
    [count('recta'), 'recta', 'rectas'],
    [count('curva'), 'curva', 'curvas'],
    [count('cruce'), 'cruce', 'cruces'],
    [count('otra'), 'otra', 'otras'],
  ] as const;
  const detail = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return `${pieces.length} piezas${detail.length ? ` (${detail.join(', ')})` : ''}`;
}
