import { AiDriver, type AiLevel, type AiMove } from './ai';
import type { Battle } from './battle';
import { carPlace, type Car } from './car';
import type { MoveDetail } from './field';

/**
 * A race: start lights, lap counting, live standings and the winner.
 * Laps are counted each time a car crosses from the last piece of the learned lap
 * to the first one going forward.
 */

/** Who drives a car: this screen, a gamepad on this phone, the AI, or another phone (a guest). */
export type Driver = { kind: 'screen' } | { kind: 'pad'; index: number } | { kind: 'ai'; level: AiLevel } | { kind: 'guest' };
export type Phase = 'setup' | 'grid' | 'countdown' | 'running' | 'finished';

export interface Entry {
  car: Car;
  laps: number;
  lapStartedAt: number;
  lapTimes: number[];
  /** Finishing position, once it has crossed the line on the last lap. */
  place?: number;
  finishedAt?: number;
}

export const LIGHTS = 5;
const LIGHT_MS = 1000;
const HOLD_MIN_MS = 400;
const HOLD_MAX_MS = 1600;
/** Getting to the start line: gentle speed, spread across lanes, and a time limit. */
const GRID_SPEED = 350;
const GRID_LANE_DELAY_MS = 400;
const GRID_TIMEOUT_MS = 45_000;
/** Widest lane offset used to spread the cars on the grid, mm from the centre. */
const GRID_SPREAD_MM = 50;

export class Race extends EventTarget {
  phase: Phase = 'setup';
  totalLaps = 3;
  /** Red lights lit during the countdown (0..5). */
  lights = 0;
  startedAt = 0;
  entries = new Map<Car, Entry>();
  private drivers = new Map<Car, Driver>();
  private ais = new Map<Car, AiDriver>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private finishedCount = 0;
  /** Cars already waiting at the start line. */
  readonly parked = new Set<Car>();

  constructor(
    private battle: Battle,
    private random: () => number = Math.random,
  ) {
    super();
    battle.field.addEventListener('move', (e) => this.onMove((e as CustomEvent<MoveDetail>).detail));
  }

  driverOf(car: Car): Driver {
    return this.drivers.get(car) ?? { kind: 'screen' };
  }

  setDriver(car: Car, driver: Driver): void {
    // One pad drives one car.
    if (driver.kind === 'pad') {
      for (const [c, d] of this.drivers) if (c !== car && d.kind === 'pad' && d.index === driver.index) this.drivers.delete(c);
    }
    this.drivers.set(car, driver);
    this.changed();
  }

  /** The car a gamepad drives, if one was assigned to it. */
  carForPad(index: number): Car | undefined {
    for (const [c, d] of this.drivers) if (d.kind === 'pad' && d.index === index) return c;
    return undefined;
  }

  /** What an AI car is doing right now, while racing. */
  aiMove(car: Car): AiMove | undefined {
    return this.ais.get(car)?.move;
  }

  get live(): boolean {
    return this.phase === 'grid' || this.phase === 'countdown' || this.phase === 'running';
  }

  isAi(car: Car): boolean {
    return this.driverOf(car).kind === 'ai' && this.live;
  }

  /** Nobody drives while the cars line up at the start. */
  isLocked(car: Car): boolean {
    return this.phase === 'grid' && this.entries.has(car);
  }

  /** Why the race cannot start right now, if it can't. */
  blocker(cars: Car[]): string | undefined {
    if (this.live) return 'La carrera ya está en marcha';
    if (!this.battle.field.lap) return 'Primero escanea la pista';
    if (!cars.some((c) => c.ready)) return 'No hay coches conectados';
    const charging = cars.find((c) => c.ready && carPlace(c.state) === 'charger');
    if (charging) return `${charging.state.name} está en el cargador: ponlo en la pista`;
    return undefined;
  }

  /**
   * Starts a race. With `grid` (the default), every car first drives to the start line in its
   * own lane and stops there; the countdown begins once they are all lined up.
   */
  start(cars: Car[], { grid = true } = {}): void {
    if (this.blocker(cars)) return;
    this.clearTimers();
    const racers = cars.filter((c) => c.ready);
    this.entries = new Map(racers.map((car) => [car, { car, laps: 0, lapStartedAt: 0, lapTimes: [] }]));
    this.finishedCount = 0;
    this.parked.clear();
    this.battle.reset();
    this.lights = 0;
    if (grid) this.lineUp(racers);
    else this.countdown();
  }

  private lineUp(racers: Car[]): void {
    const field = this.battle.field;
    this.phase = 'grid';
    const n = racers.length;
    racers.forEach((car, i) => {
      car.setSpeed(GRID_SPEED);
      // Spread them evenly across the lanes so they stop side by side instead of nose to tail.
      const target = n === 1 ? 0 : -GRID_SPREAD_MM + (2 * GRID_SPREAD_MM * i) / (n - 1);
      this.later(GRID_LANE_DELAY_MS, () => {
        const offset = field.runner(car)?.offset ?? 0;
        if (Math.abs(target - offset) > 3) car.shiftLane(target - offset);
      });
    });
    // A car that can't find the line (off the track, no codes) must not hold everyone up.
    this.later(GRID_TIMEOUT_MS, () => this.phase === 'grid' && this.gridDone());
    this.changed();
  }

  private gridDone(): void {
    this.clearTimers();
    this.entries.forEach((e) => this.parked.has(e.car) || (e.car.ready && e.car.brake()));
    this.countdown();
  }

  private countdown(): void {
    const field = this.battle.field;
    const racers = [...this.entries.keys()];
    this.phase = 'countdown';
    this.lights = 0;

    const hold = HOLD_MIN_MS + this.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
    const total = LIGHTS * LIGHT_MS + hold;
    // Cars stay put until the lights go out, even if the throttle is already open.
    racers.forEach((car) => car.limitSpeed(0, total));
    for (let i = 1; i <= LIGHTS; i++) {
      this.later((i - 1) * LIGHT_MS, () => {
        this.lights = i;
        this.dispatchEvent(new CustomEvent('light', { detail: i }));
        this.changed();
      });
    }
    this.later(total, () => this.go(field.now()));
    this.changed();
  }

  /** Ends the race now with the current positions (a campaign challenge already decided). */
  end(): void {
    if (!this.live) return;
    this.clearTimers();
    this.stopAis();
    this.entries.forEach((e) => e.car.ready && e.car.brake());
    this.phase = 'finished';
    this.lights = 0;
    this.dispatchEvent(new CustomEvent('over'));
    this.changed();
  }

  /** Stops the race and every car in it. */
  abort(): void {
    this.clearTimers();
    this.stopAis();
    this.entries.forEach((e) => e.car.ready && e.car.brake());
    this.phase = 'setup';
    this.lights = 0;
    this.changed();
  }

  /** Entries sorted by race position: finished first, then most laps, then furthest along the lap. */
  standings(): Entry[] {
    const field = this.battle.field;
    const progress = (e: Entry) => {
      const idx = field.runner(e.car)?.idx;
      return e.laps + (idx === undefined || !field.lap ? 0 : idx / field.lap.length);
    };
    return [...this.entries.values()].sort((a, b) => {
      if (a.place && b.place) return a.place - b.place;
      if (a.place || b.place) return a.place ? -1 : 1;
      return progress(b) - progress(a);
    });
  }

  winner(): Entry | undefined {
    return [...this.entries.values()].find((e) => e.place === 1);
  }

  private go(now: number): void {
    this.lights = 0;
    this.phase = 'running';
    this.startedAt = now;
    this.entries.forEach((e) => (e.lapStartedAt = now));
    this.dispatchEvent(new CustomEvent('go'));
    for (const e of this.entries.values()) {
      const d = this.driverOf(e.car);
      if (d.kind !== 'ai') continue;
      const ai = new AiDriver(e.car, this.battle, d.level, this.random);
      this.ais.set(e.car, ai);
      ai.start();
    }
    this.changed();
  }

  private onMove({ car, from, to }: MoveDetail): void {
    const e = this.entries.get(car);
    const n = this.battle.field.lap?.length ?? 0;
    if (this.phase === 'grid' && e && !this.parked.has(car) && to === 0 && from !== undefined && from !== 0) {
      // Just crossed the start line: wait here.
      car.brake();
      this.parked.add(car);
      this.dispatchEvent(new CustomEvent('parked', { detail: car }));
      if (this.parked.size >= this.entries.size) this.gridDone();
      else this.changed();
      return;
    }
    if (this.phase !== 'running' || !e || e.place || from === undefined || !n) return;
    // Forward over the line: from one of the last pieces to one of the first.
    const crossed = from > to && to + n - from <= 2;
    if (!crossed) return;
    const now = this.battle.field.now();
    e.laps++;
    e.lapTimes.push(now - e.lapStartedAt);
    e.lapStartedAt = now;
    if (e.laps >= this.totalLaps) {
      e.place = ++this.finishedCount;
      e.finishedAt = now;
      this.ais.get(car)?.stop();
      this.ais.delete(car);
      car.brake();
      this.dispatchEvent(new CustomEvent('finish', { detail: e }));
      if ([...this.entries.values()].every((x) => x.place || !x.car.ready)) {
        this.phase = 'finished';
        this.stopAis();
        this.dispatchEvent(new CustomEvent('over'));
      }
    } else {
      this.dispatchEvent(new CustomEvent('lap', { detail: e }));
    }
    this.changed();
  }

  private stopAis(): void {
    this.ais.forEach((ai) => ai.stop());
    this.ais.clear();
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}
