import type { Battle } from './battle';
import { MAX_SPEED, type Car } from './car';
import { pieceKind } from './track';

/**
 * Computer driver for one car during a race. The cars follow the road by themselves, so the
 * AI decides speed, lane and weapons:
 * - holds a cruise speed that wanders a little and overtakes cars on the same piece,
 * - uses weapons when it has a target,
 * - and the rougher levels try to knock rivals off the track for real: pulling alongside
 *   and swerving into them, or lining up behind them and ramming them as they enter a curve.
 */

export type AiLevel = 'easy' | 'normal' | 'hard';

interface LevelSpec {
  name: string;
  /** What it does, for the driver picker. */
  about: string;
  speed: number;
  /** Chance per decision to use a weapon when there is a reason to. */
  aggression: number;
  /** Chance per decision to change lane when stuck behind someone. */
  overtake: number;
  /** Chance per decision to ram a car ahead that is going into a curve. */
  ram: number;
  /** Chance per decision to swerve into a car alongside. */
  shove: number;
}

export const AI_LEVELS: Record<AiLevel, LevelSpec> = {
  easy: {
    name: 'IA fácil',
    about: 'Va tranquila, casi no dispara y nunca empuja.',
    speed: 600,
    aggression: 0.1,
    overtake: 0.1,
    ram: 0,
    shove: 0,
  },
  normal: {
    name: 'IA normal',
    about: 'Ritmo de carrera, dispara a menudo y a veces te embiste por detrás en las curvas.',
    speed: 850,
    aggression: 0.35,
    overtake: 0.3,
    ram: 0.25,
    shove: 0,
  },
  hard: {
    name: 'IA difícil',
    about: 'Rápida y agresiva: te embiste en las curvas y se pone a tu lado para sacarte de la pista.',
    speed: 1100,
    aggression: 0.8,
    overtake: 0.6,
    ram: 0.6,
    shove: 0.5,
  },
};

const DECIDE_MS = 300;
const WANDER_MS = 3000;
const WANDER_MM_S = 160;
const LANE_COOLDOWN_MS = 2500;
/** A ram lasts this long at full speed, then the AI goes back to its cruise speed. */
const RAM_MS = 1500;
const RAM_EXTRA_MM_S = 500;
/** Lined up when the sideways gap to the target is below this. */
const SAME_LANE_MM = 12;
/** A car alongside within this sideways gap can be shoved. */
const SHOVE_RANGE_MM = 70;
/** Swerve past the target's line so the hit actually pushes. */
const SHOVE_OVERSHOOT = 1.6;

export type AiMove = 'cruise' | 'overtake' | 'ram' | 'shove';

export class AiDriver {
  /** Last thing it decided to do (shown on screen, handy for tests). */
  move: AiMove = 'cruise';
  private timer?: ReturnType<typeof setInterval>;
  private cruise: number;
  private wanderAt = 0;
  private laneAt = -Infinity;
  private ramUntil = -Infinity;

  constructor(
    readonly car: Car,
    private battle: Battle,
    readonly level: AiLevel,
    private random: () => number = Math.random,
  ) {
    this.cruise = AI_LEVELS[level].speed;
  }

  start(): void {
    this.decide();
    this.timer ??= setInterval(() => this.decide(), DECIDE_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One decision step. Public so tests can drive it. */
  decide(): void {
    const car = this.car;
    if (!car.ready) return;
    const spec = AI_LEVELS[this.level];
    const field = this.battle.field;
    const now = field.now();

    if (now >= this.wanderAt) {
      this.cruise = Math.round(spec.speed + (this.random() - 0.5) * WANDER_MM_S);
      this.wanderAt = now + WANDER_MS;
    }
    const ramming = now < this.ramUntil;
    if (!ramming) {
      this.move = 'cruise';
      if (Math.abs(car.state.targetSpeed - this.cruise) > 20) car.setSpeed(this.cruise);
    }

    const target = this.battle.targetFor(car);
    const me = field.runner(car);
    const them = target && field.runner(target.car);
    const canSteer = now - this.laneAt > LANE_COOLDOWN_MS;

    if (target && me && them && !ramming && canSteer) {
      const gap = them.offset - me.offset;
      if (target.pieces === 0 && Math.abs(gap) >= SAME_LANE_MM && Math.abs(gap) <= SHOVE_RANGE_MM && this.random() < spec.shove) {
        // Alongside: match its speed and swerve into it.
        this.move = 'shove';
        car.setSpeed(Math.min(MAX_SPEED, them.speed + 60));
        car.shiftLane(gap * SHOVE_OVERSHOOT, true);
        this.laneAt = now;
      } else if (target.pieces <= 1 && this.curveAhead(target.car) && this.random() < spec.ram) {
        // Behind it as it reaches a curve: line up and floor it, so it gets pushed wide.
        this.move = 'ram';
        if (Math.abs(gap) >= SAME_LANE_MM) car.shiftLane(gap, true);
        car.setSpeed(Math.min(MAX_SPEED, Math.max(them.speed, this.cruise) + RAM_EXTRA_MM_S));
        this.ramUntil = now + RAM_MS;
        this.laneAt = now;
      } else if (target.pieces === 0 && this.random() < spec.overtake) {
        this.move = 'overtake';
        if (this.random() < 0.5) car.laneLeft();
        else car.laneRight();
        this.laneAt = now;
      }
    }

    this.useWeapons(target?.pieces, now);
  }

  /** The target is on a curve or about to enter one. */
  private curveAhead(car: Car): boolean {
    const field = this.battle.field;
    const r = field.runner(car);
    if (r?.piece === undefined) return false;
    if (pieceKind(r.piece) === 'curva') return true;
    if (!field.lap || r.idx === undefined) return false;
    const n = field.lap.length;
    return pieceKind(field.lap[(r.idx + r.dir + n) % n]) === 'curva';
  }

  private useWeapons(pieces: number | undefined, now: number): void {
    const me = this.battle.fighter(this.car);
    const spec = AI_LEVELS[this.level];
    if (!me || !this.battle.enabled || this.random() >= spec.aggression) return;
    if (me.armor < 40 && me.shieldUntil < now && me.energy >= 30) {
      this.battle.fire(this.car, 'shield');
    } else if (pieces !== undefined && pieces <= 1 && me.energy >= 80 && this.random() < 0.2) {
      this.battle.fire(this.car, 'pulse');
    } else if (pieces !== undefined && pieces <= 1) {
      this.battle.fire(this.car, 'blaster');
    } else if (pieces !== undefined && pieces <= 3 && me.energy >= 60) {
      this.battle.fire(this.car, 'missile');
    }
  }
}
