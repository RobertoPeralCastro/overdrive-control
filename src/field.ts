import type { Car } from './car';
import type { VehicleMessage } from './protocol';
import { TrackLearner, pieceKind, turnFromWheels, type Lap, type Turn } from './track';

/**
 * Where every car is on the track. Learns the lap (piece order and which way each curve
 * bends) from the cars' reports, then follows each car along it. Weapons, races, the AI
 * and the track map all read from here.
 */

/** A car that has not reported its position for this long is not on the track. */
const STALE_MS = 3000;
const SCAN_SPEED = 450;
const SCAN_TIMEOUT_MS = 60_000;

export interface Runner {
  car: Car;
  piece?: number;
  speed: number;
  /** Sideways position reported by the car, mm from the road center. */
  offset: number;
  seenAt: number;
  /** When it entered the current piece (to animate it along the map). */
  enteredAt: number;
  /** Index in the learned lap and driving direction along it. */
  idx?: number;
  dir: 1 | -1;
  learner: TrackLearner;
}

export interface MoveDetail {
  car: Car;
  from?: number;
  to: number;
}

export class Field extends EventTarget {
  /** Learned lap, in the driving order of the car that learned it. */
  lap?: number[];
  turns: (Turn | undefined)[] = [];
  scanning?: Car;
  private runners = new Map<Car, Runner>();
  private scanTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly now: () => number = () => performance.now()) {
    super();
  }

  add(car: Car): void {
    if (this.runners.has(car)) return;
    this.runners.set(car, { car, speed: 0, offset: 0, seenAt: -Infinity, enteredAt: 0, dir: 1, learner: new TrackLearner() });
    car.addEventListener('message', (e) => {
      const msg = (e as CustomEvent<VehicleMessage>).detail;
      if (msg.type === 'position') this.observe(car, msg.pieceId, msg.speed, msg.offset);
      else if (msg.type === 'transition' && msg.leftWheelCm !== undefined && msg.rightWheelCm !== undefined) {
        this.observeTurn(car, msg.leftWheelCm, msg.rightWheelCm);
      }
    });
  }

  remove(car: Car): void {
    this.runners.delete(car);
    if (this.scanning === car) this.stopScan();
  }

  runner(car: Car): Runner | undefined {
    return this.runners.get(car);
  }

  get all(): Runner[] {
    return [...this.runners.values()];
  }

  /** Drives `car` around one lap at a gentle speed and brakes once the track is known. */
  scan(car: Car): void {
    this.lap = undefined;
    this.turns = [];
    this.runners.forEach((r) => {
      r.learner.reset();
      r.idx = undefined;
    });
    this.scanning = car;
    car.setSpeed(SCAN_SPEED);
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.stopScan();
      this.dispatchEvent(new CustomEvent('scanfail'));
    }, SCAN_TIMEOUT_MS);
    this.changed();
  }

  /** Every position report of every car. Public so tests can drive it. */
  observe(car: Car, pieceId: number, speed = 0, offset = 0): void {
    const r = this.runners.get(car);
    if (!r) return;
    const t = this.now();
    r.seenAt = t;
    r.speed = speed;
    r.offset = offset;
    if (pieceId === r.piece) return;
    r.piece = pieceId;
    r.enteredAt = t;
    if (!this.lap) {
      const lap = r.learner.push(pieceId);
      if (lap) this.learned(lap, r);
      return;
    }
    const from = r.idx;
    this.locate(r);
    if (r.idx !== undefined && r.idx !== from) {
      this.dispatchEvent(new CustomEvent<MoveDetail>('move', { detail: { car, from, to: r.idx } }));
    }
    this.changed();
  }

  /** Wheel distances for the piece the car is leaving: tells which way that curve bends. */
  observeTurn(car: Car, leftCm: number, rightCm: number): void {
    const r = this.runners.get(car);
    if (!r || r.piece === undefined || pieceKind(r.piece) !== 'curva') return;
    let turn = turnFromWheels(leftCm, rightCm);
    if (turn === 'S') return;
    if (r.dir === -1) turn = turn === 'L' ? 'R' : 'L';
    if (!this.lap) {
      r.learner.markTurn(turn);
    } else if (r.idx !== undefined && this.turns[r.idx] !== turn) {
      this.turns[r.idx] = turn;
      this.dispatchEvent(new CustomEvent('shape'));
    }
  }

  active(car: Car): boolean {
    const r = this.runners.get(car);
    return !!r && car.ready && this.now() - r.seenAt < STALE_MS;
  }

  /** Pieces from `a` forward to `b` along a's driving direction. Infinity if unknown. */
  distance(a: Car, b: Car): number {
    const ra = this.runners.get(a);
    const rb = this.runners.get(b);
    if (ra?.piece === undefined || rb?.piece === undefined) return Infinity;
    if (this.lap && ra.idx !== undefined && rb.idx !== undefined) {
      const n = this.lap.length;
      return ((((rb.idx - ra.idx) * ra.dir) % n) + n) % n;
    }
    // Track not learned yet: only cars on the same kind of piece count, as if side by side.
    return ra.piece === rb.piece ? 0 : Infinity;
  }

  private learned(lap: Lap, from: Runner): void {
    this.lap = lap.pieces;
    this.turns = lap.turns;
    this.runners.forEach((r) => (r.idx = undefined));
    from.idx = lap.at;
    from.dir = 1;
    this.runners.forEach((r) => r !== from && this.locate(r));
    if (this.scanning) {
      this.scanning.brake();
      this.stopScan();
    }
    this.dispatchEvent(new CustomEvent('track', { detail: this.lap }));
    this.changed();
  }

  /** Uses a track scanned before instead of scanning it again. The cars find their place as they drive. */
  useTrack(pieces: number[], turns: (Turn | undefined)[]): void {
    if (this.scanning) {
      this.scanning.brake();
      this.stopScan();
    }
    this.lap = pieces.slice();
    this.turns = turns.slice();
    this.runners.forEach((r) => {
      r.idx = undefined;
      r.dir = 1;
      this.locate(r);
    });
    this.dispatchEvent(new CustomEvent('shape'));
    this.changed();
  }

  /** Moves a car's lap index to the nearest piece with its current ID; that also tells its direction. */
  private locate(r: Runner): void {
    const lap = this.lap!;
    const n = lap.length;
    const options = lap.flatMap((id, i) => (id === r.piece ? [i] : []));
    if (!options.length) {
      r.idx = undefined;
      return;
    }
    if (r.idx === undefined) {
      r.idx = options[0];
      return;
    }
    let best = options[0];
    let bestStep = Infinity;
    let dir = r.dir;
    for (const i of options) {
      const fwd = (i - r.idx + n) % n;
      const back = (r.idx - i + n) % n;
      if (fwd < bestStep) [best, bestStep, dir] = [i, fwd, 1];
      if (back < bestStep) [best, bestStep, dir] = [i, back, -1];
    }
    r.idx = best;
    // A one or two piece jump is normal driving; anything further is a misread, not a U-turn.
    if (bestStep > 0 && bestStep <= 2) r.dir = dir;
  }

  private stopScan(): void {
    clearTimeout(this.scanTimer);
    this.scanning = undefined;
    this.changed();
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}
