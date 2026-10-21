import type { Car } from './car';
import type { Field } from './field';
import { t } from './i18n';
import { LightEffect } from './protocol';

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
  { id: 'blaster', name: t('Láser', 'Laser'), energy: 8, cooldownMs: 350, range: 1, damage: 8, slow: 0.75, slowMs: 500 },
  { id: 'missile', name: t('Misil', 'Missile'), energy: 35, cooldownMs: 3000, range: 3, damage: 30, slow: 0.3, slowMs: 1500 },
  { id: 'pulse', name: t('Pulso', 'Pulse'), energy: 50, cooldownMs: 8000, range: 1, area: true, damage: 10, slow: 0.2, slowMs: 2500 },
  { id: 'shield', name: t('Escudo', 'Shield'), energy: 30, cooldownMs: 8000, range: 0, damage: 0, slow: 1, slowMs: 0 },
];

export const MAX_ARMOR = 100;
export const MAX_ENERGY = 100;
const ENERGY_PER_SEC = 12;
const SHIELD_MS = 3000;
const KNOCKOUT_MS = 3000;
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
}

export interface Hit {
  target: Car;
  blocked: boolean;
  knockedOut: boolean;
}

export interface FireDetail {
  shooter: Car;
  weapon: Weapon;
  hits: Hit[];
}

/** Why a shot didn't go: `code` for the program, `reason` (translated) for the player. */
export type FireFail = 'off' | 'disconnected' | 'down' | 'cooling' | 'empty';
export type FireResult = { ok: true; hits: Hit[] } | { ok: false; code: FireFail; reason: string };

export interface Target {
  car: Car;
  pieces: number;
}

export class Battle extends EventTarget {
  enabled = true;
  private fighters = new Map<Car, Fighter>();
  private lastTick: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly field: Field) {
    super();
    this.lastTick = field.now();
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 100);
  }

  add(car: Car): void {
    if (this.fighters.has(car)) return;
    this.field.add(car);
    this.fighters.set(car, {
      car,
      armor: MAX_ARMOR,
      energy: MAX_ENERGY,
      kills: 0,
      readyAt: { blaster: 0, missile: 0, pulse: 0, shield: 0 },
      shieldUntil: 0,
      downUntil: 0,
    });
  }

  remove(car: Car): void {
    this.fighters.delete(car);
    this.field.remove(car);
  }

  fighter(car: Car): Fighter | undefined {
    return this.fighters.get(car);
  }

  /** Back to full armor and energy, no kills (a new race). */
  reset(): void {
    for (const f of this.fighters.values()) {
      Object.assign(f, { armor: MAX_ARMOR, energy: MAX_ENERGY, kills: 0, shieldUntil: 0, downUntil: 0 });
      f.readyAt = { blaster: 0, missile: 0, pulse: 0, shield: 0 };
    }
    this.changed();
  }

  /** Closest car ahead of `car` within `range` pieces. */
  targetFor(car: Car, range = Math.max(...WEAPONS.map((w) => w.range))): Target | undefined {
    if (!this.fighters.has(car) || !this.field.active(car)) return undefined;
    let best: Target | undefined;
    for (const f of this.fighters.values()) {
      if (f.car === car || !this.field.active(f.car) || f.downUntil > this.field.now()) continue;
      const d = this.field.distance(car, f.car);
      if (d <= range && (!best || d < best.pieces)) best = { car: f.car, pieces: d };
    }
    return best;
  }

  fire(car: Car, id: WeaponId): FireResult {
    const me = this.fighters.get(car);
    const w = WEAPONS.find((x) => x.id === id)!;
    const now = this.field.now();
    if (!this.enabled) return { ok: false, code: 'off', reason: t('Armas desactivadas', 'Weapons off') };
    if (!me || !car.ready) return { ok: false, code: 'disconnected', reason: t('Coche no conectado', 'Car not connected') };
    if (me.downUntil > now) return { ok: false, code: 'down', reason: t('Estás fuera de combate', "You're knocked out") };
    if (me.readyAt[id] > now) return { ok: false, code: 'cooling', reason: t('Recargando', 'Reloading') };
    if (me.energy < w.energy) return { ok: false, code: 'empty', reason: t('Sin energía', 'No energy') };

    me.energy -= w.energy;
    me.readyAt[id] = now + w.cooldownMs;

    let hits: Hit[] = [];
    if (id === 'shield') {
      me.shieldUntil = now + SHIELD_MS;
      car.flashLights(SHIELD_COLOR, SHIELD_MS, LightEffect.THROB, 30);
    } else {
      const victims = w.area ? this.around(car, w.range) : [this.targetFor(car, w.range)].flatMap((x) => (x ? [this.fighters.get(x.car)!] : []));
      hits = victims.map((v) => this.damage(me, v, w));
    }
    this.dispatchEvent(new CustomEvent<FireDetail>('fire', { detail: { shooter: car, weapon: w, hits } }));
    this.changed();
    return { ok: true, hits };
  }

  tick(): void {
    const t = this.field.now();
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
    const t = this.field.now();
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
  private around(car: Car, range: number): Fighter[] {
    const now = this.field.now();
    return [...this.fighters.values()].filter(
      (f) =>
        f.car !== car &&
        this.field.active(f.car) &&
        f.downUntil <= now &&
        Math.min(this.field.distance(car, f.car), this.field.distance(f.car, car)) <= range,
    );
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}
