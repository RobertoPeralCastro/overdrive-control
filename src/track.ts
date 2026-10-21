import { t } from './i18n';

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
/** Which way a piece bends in the driving direction. */
export type Turn = 'L' | 'R' | 'S';

export function pieceKind(id: number): PieceKind {
  if (START_IDS.includes(id)) return 'salida';
  if (CURVE_IDS.has(id)) return 'curva';
  if (STRAIGHT_IDS.has(id)) return 'recta';
  if (CROSS_IDS.has(id)) return 'cruce';
  return 'otra';
}

/** The outer wheel rolls further through a curve. Below 2 cm of difference it is a straight. */
export function turnFromWheels(leftCm: number, rightCm: number): Turn {
  if (Math.abs(leftCm - rightCm) < 2) return 'S';
  return leftCm > rightCm ? 'R' : 'L';
}

export interface Lap {
  /** Piece IDs in driving order. */
  pieces: number[];
  /** Bend of each piece, when the car reported it. */
  turns: (Turn | undefined)[];
  /** Index in `pieces` of the piece the car is on right now. */
  at: number;
}

export class TrackLearner {
  private seq: number[] = [];
  private turns: (Turn | undefined)[] = [];

  /** Feed every piece ID the car reports; returns the lap once it has seen a full one. */
  push(pieceId: number): Lap | undefined {
    if (this.seq.at(-1) === pieceId) return undefined;
    this.seq.push(pieceId);
    this.turns.push(undefined);
    if (this.seq.length > MAX_HISTORY) {
      this.seq.shift();
      this.turns.shift();
    }
    return this.lapFromStartLine() ?? this.lapFromRepetition();
  }

  /** How the piece the car is on now bends (reported when the car leaves it). */
  markTurn(turn: Turn): void {
    if (this.turns.length) this.turns[this.turns.length - 1] = turn;
  }

  reset(): void {
    this.seq = [];
    this.turns = [];
  }

  /** Official tracks: a lap is everything between two passes over the start line. */
  private lapFromStartLine(): Lap | undefined {
    for (const id of START_IDS) {
      const last = this.seq.length - 1;
      if (this.seq[last] !== id) continue;
      const prev = this.seq.lastIndexOf(id, last - 1);
      if (prev >= 0 && last - prev >= 3) return { pieces: this.seq.slice(prev, last), turns: this.turns.slice(prev, last), at: 0 };
    }
    return undefined;
  }

  /** No start piece: wait until the last 2 laps are identical. */
  private lapFromRepetition(): Lap | undefined {
    const n = this.seq.length;
    for (let p = 3; p * 2 <= n; p++) {
      let same = true;
      for (let i = n - p; i < n && same; i++) same = this.seq[i] === this.seq[i - p];
      if (same) {
        const turns = this.turns.slice(n - p).map((t, i) => t ?? this.turns[n - 2 * p + i]);
        return { pieces: this.seq.slice(n - p), turns, at: p - 1 };
      }
    }
    return undefined;
  }
}

export function describeTrack(pieces: number[]): string {
  const count = (k: PieceKind) => pieces.filter((id) => pieceKind(id) === k).length;
  const parts = [
    [count('recta'), t('recta', 'straight'), t('rectas', 'straights')],
    [count('curva'), t('curva', 'curve'), t('curvas', 'curves')],
    [count('cruce'), t('cruce', 'crossing'), t('cruces', 'crossings')],
    [count('otra'), t('otra', 'other'), t('otras', 'others')],
  ] as const;
  const detail = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return `${pieces.length} ${t('piezas', 'pieces')}${detail.length ? ` (${detail.join(', ')})` : ''}`;
}
