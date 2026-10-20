import type { Car } from './car';
import { LightEffect } from './protocol';
import { TrackLearner, type Lap } from './track';

/**
 * Virtual weapons, like the official Overdrive app: the cars have no real guns, so hits are
 * worked out here from each car's position on the learned track, and the car that gets hit
 * blinks red and slows down. Running out of armor stops the car for a few seconds.
 */

export type WeaponId = 'blaster' | 'missile' | 'pulse' | 'shield';

export interface Weapon {
  id: WeaponId;
  name: string;
  /** Energy it costs. */
  energy: number;
  cooldownMs: number;
  /** How many pieces ahead it reaches (0 = same piece only). */
  range: number;
  /** Pulse hits everyone in range, ahead and behind. Others hit the closest car ahead. */
  area?: boolean;
  damage: number;
  /** The hit car's speed drops to this fraction of its cruise speed for slowMs. */
  slow: number;
  slowMs: number;
}

export const WEAPONS: Weapon[] = [
  { id: 'blaster', name: 'Láser', energy: 8, cooldownMs: 350, range: 1, damage: 8, slow: 0.75, slowMs: 500 },
  { id: 'missile', name: 'Misil', energy: 35, cooldownMs: 3000, range: 3, damage: 30, slow: 0.3, slowMs: 1500 },
  { id: 'pulse', name: 'Pulso', energy: 50, cooldownMs: 8000, range: 1, area: true, damage: 10, slow: 0.2, slowMs: 2500 },
  { id: 'shield', name: 'Escudo', energy: 30, cooldownMs: 8000, range: 0, damage: 0, slow: 1, slowMs: 0 },
];

export const MAX_ARMOR = 100;
export const MAX_ENERGY = 100;
const ENERGY_PER_SEC = 12;
const SHIELD_MS = 3000;
const KNOCKOUT_MS = 3000;
/** A car that has not reported its position for this long is not on the track. */
const STALE_MS = 3000;
const SCAN_SPEED = 450;
const SCAN_TIMEOUT_MS = 60_000;
const HIT_COLOR = '#ff0000';
const SHIELD_COLOR = '#64d2ff';

export interface Fighter {
  car: Car;
  armor: number;
  energy: number;
  kills: number;
  readyAt: Record<WeaponId, number>;
  shieldUntil: number;
  /** Knocked out (armor 0) until this time. */
  downUntil: number;
  piece?: number;
  seenAt: number;
  /** Index in the learned lap and driving direction along it. */
  idx?: number;
  dir: 1 | -1;
  learner: TrackLearner;
}

export interface Hit {
  target: Car;
  blocked: boolean;
  knockedOut: boolean;
}

export type FireResult = { ok: true; hits: Hit[] } | { ok: false; reason: string };

export interface Target {
  car: Car;
  pieces: number;
}

export class Battle extends EventTarget {
  /** Learned lap, in the driving order of the car that learned it. */
  lap?: number[];
  scanning?: Car;
  private fighters = new Map<Car, Fighter>();
  private lastTick: number;
  private timer?: ReturnType<typeof setInterval>;
  private scanTimer?: ReturnType<typeof setTimeout>;

  constructor(private now: () => number = () => performance.now()) {
    super();
    this.lastTick = now();
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 100);
  }

  add(car: Car): void {
    if (this.fighters.has(car)) return;
    this.fighters.set(car, {
      car,
      armor: MAX_ARMOR,
      energy: MAX_ENERGY,
      kills: 0,
      readyAt: { blaster: 0, missile: 0, pulse: 0, shield: 0 },
      shieldUntil: 0,
      downUntil: 0,
      seenAt: -Infinity,
      dir: 1,
      learner: new TrackLearner(),
    });
    car.addEventListener('message', (e) => {
      const msg = (e as CustomEvent).detail;
      if (msg.type === 'position') this.observe(car, msg.pieceId);
    });
  }

  remove(car: Car): void {
    this.fighters.delete(car);
    if (this.scanning === car) this.stopScan();
  }

  fighter(car: Car): Fighter | undefined {
    return this.fighters.get(car);
  }

  /** Drives `car` around one lap at a gentle speed and brakes once the track is known. */
  scan(car: Car): void {
    this.lap = undefined;
    this.fighters.forEach((f) => {
      f.learner.reset();
      f.idx = undefined;
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

  /** Every piece change of every car. Public so tests can drive it. */
  observe(car: Car, pieceId: number): void {
    const f = this.fighters.get(car);
    if (!f) return;
    f.seenAt = this.now();
    if (pieceId === f.piece) return;
    f.piece = pieceId;
    if (!this.lap) {
      const lap = f.learner.push(pieceId);
      if (lap) this.learned(lap, f);
    } else {
      this.locate(f);
    }
  }

  /** Closest car ahead of `car` within `range` pieces. */
  targetFor(car: Car, range = Math.max(...WEAPONS.map((w) => w.range))): Target | undefined {
    const me = this.fighters.get(car);
    if (!me || !this.active(me)) return undefined;
    let best: Target | undefined;
    for (const f of this.fighters.values()) {
      if (f === me || !this.active(f) || f.downUntil > this.now()) continue;
      const d = this.distance(me, f);
      if (d <= range && (!best || d < best.pieces)) best = { car: f.car, pieces: d };
    }
    return best;
  }

  fire(car: Car, id: WeaponId): FireResult {
    const me = this.fighters.get(car);
    const w = WEAPONS.find((x) => x.id === id)!;
    const t = this.now();
    if (!me || !car.ready) return { ok: false, reason: 'Coche no conectado' };
    if (me.downUntil > t) return { ok: false, reason: 'Estás fuera de combate' };
    if (me.readyAt[id] > t) return { ok: false, reason: 'Recargando' };
    if (me.energy < w.energy) return { ok: false, reason: 'Sin energía' };

    me.energy -= w.energy;
    me.readyAt[id] = t + w.cooldownMs;

    if (id === 'shield') {
      me.shieldUntil = t + SHIELD_MS;
      car.flashLights(SHIELD_COLOR, SHIELD_MS, LightEffect.THROB, 30);
      this.changed();
      return { ok: true, hits: [] };
    }

    const victims = w.area ? this.around(me, w.range) : [this.targetFor(car, w.range)].filter((x) => !!x).map((x) => this.fighters.get(x.car)!);
    const hits = victims.map((v) => this.damage(me, v, w));
    this.dispatchEvent(new CustomEvent('fire', { detail: { shooter: car, weapon: w, hits } }));
    this.changed();
    return { ok: true, hits };
  }

  tick(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.lastTick) / 1000;
    this.lastTick = t;
    for (const f of this.fighters.values()) {
      if (f.downUntil > t) continue;
      if (f.armor === 0) f.armor = MAX_ARMOR;
      f.energy = Math.min(MAX_ENERGY, f.energy + ENERGY_PER_SEC * dt);
    }
    this.changed();
  }

  private damage(shooter: Fighter, target: Fighter, w: Weapon): Hit {
    const t = this.now();
    if (target.shieldUntil > t) return { target: target.car, blocked: true, knockedOut: false };
    target.armor = Math.max(0, target.armor - w.damage);
    if (target.armor === 0) {
      target.downUntil = t + KNOCKOUT_MS;
      shooter.kills++;
      target.car.limitSpeed(0, KNOCKOUT_MS);
      target.car.flashLights(HIT_COLOR, KNOCKOUT_MS, LightEffect.FLASH, 60);
      return { target: target.car, blocked: false, knockedOut: true };
    }
    target.car.limitSpeed(target.car.state.targetSpeed * w.slow, w.slowMs);
    target.car.flashLights(HIT_COLOR, Math.max(400, w.slowMs));
    return { target: target.car, blocked: false, knockedOut: false };
  }

  /** Everyone within `range` pieces, in either direction. */
  private around(me: Fighter, range: number): Fighter[] {
    return [...this.fighters.values()].filter(
      (f) => f !== me && this.active(f) && f.downUntil <= this.now() && Math.min(this.distance(me, f), this.distance(f, me)) <= range,
    );
  }

  /** Pieces from `a` forward to `b` along a's driving direction. Infinity if unknown. */
  private distance(a: Fighter, b: Fighter): number {
    if (a.piece === undefined || b.piece === undefined) return Infinity;
    if (this.lap && a.idx !== undefined && b.idx !== undefined) {
      const n = this.lap.length;
      return ((((b.idx - a.idx) * a.dir) % n) + n) % n;
    }
    // Track not learned yet: only cars on the same kind of piece count, as if side by side.
    return a.piece === b.piece ? 0 : Infinity;
  }

  private active(f: Fighter): boolean {
    return f.car.ready && this.now() - f.seenAt < STALE_MS;
  }

  private learned(lap: Lap, from: Fighter): void {
    this.lap = lap.pieces;
    this.fighters.forEach((f) => (f.idx = undefined));
    from.idx = lap.at;
    from.dir = 1;
    this.fighters.forEach((f) => f !== from && this.locate(f));
    if (this.scanning) {
      this.scanning.brake();
      this.stopScan();
    }
    this.dispatchEvent(new CustomEvent('track', { detail: this.lap }));
    this.changed();
  }

  /** Moves a car's lap index to the nearest piece with its current ID; that also tells its direction. */
  private locate(f: Fighter): void {
    const lap = this.lap!;
    const n = lap.length;
    const options = lap.flatMap((id, i) => (id === f.piece ? [i] : []));
    if (!options.length) {
      f.idx = undefined;
      return;
    }
    if (f.idx === undefined) {
      f.idx = options[0];
      return;
    }
    let best = options[0];
    let bestStep = Infinity;
    let dir = f.dir;
    for (const i of options) {
      const fwd = (i - f.idx + n) % n;
      const back = (f.idx - i + n) % n;
      if (fwd < bestStep) [best, bestStep, dir] = [i, fwd, 1];
      if (back < bestStep) [best, bestStep, dir] = [i, back, -1];
    }
    f.idx = best;
    // A one or two piece jump is normal driving; anything further is a misread, not a U-turn.
    if (bestStep > 0 && bestStep <= 2) f.dir = dir;
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
