import { MAX_SPEED } from './car';
import type { Drivable } from './cockpit';
import type { WeaponId } from './battle';

/**
 * Gamepads over USB or Bluetooth (both show up through the browser's Gamepad API; the
 * browser only reveals a pad after one of its buttons is pressed). Several pads can play
 * at once, each driving its own car.
 *
 * Every action can be mapped to buttons or stick directions, and the mapping is saved per
 * pad model. The default (Xbox/PlayStation layout):
 * RT = throttle, LT or B = brake, LB/RB, D-pad or left stick = lane change, Y = U-turn,
 * A = laser, X = missile, L3 = pulse, R3 = shield, Start = start race, Select = stop all.
 */

export interface PadHooks {
  /** The car pad `index` drives, if any. */
  carFor(index: number): Drivable | undefined;
  fire(car: Drivable, weapon: WeaponId): void;
  start(): void;
  stopAll(): void;
  notify(msg: string): void;
  /** Any button of pad `index` was just pressed (to tell which pad is which). */
  pressed?(index: number): void;
}

export interface PadInfo {
  index: number;
  name: string;
  /** Model id, the key its mapping is saved under. */
  id: string;
}

/** A button, or one direction of a stick axis (dir -1 = left/up, 1 = right/down). */
export type PadInput = { kind: 'button'; index: number } | { kind: 'axis'; index: number; dir: 1 | -1 };

export type PadAction = 'throttle' | 'brake' | 'left' | 'right' | 'faster' | 'slower' | 'uturn' | 'blaster' | 'missile' | 'pulse' | 'shield' | 'start' | 'stop';

export type PadMap = Record<PadAction, PadInput[]>;

export const PAD_ACTIONS: { id: PadAction; name: string; hint?: string }[] = [
  { id: 'throttle', name: 'Acelerar', hint: 'Con recorrido: gatillo o stick. Cuanto más lo aprietas, más rápido.' },
  { id: 'brake', name: 'Frenar' },
  { id: 'left', name: 'Carril izquierdo' },
  { id: 'right', name: 'Carril derecho' },
  { id: 'faster', name: 'Más velocidad (crucero)' },
  { id: 'slower', name: 'Menos velocidad (crucero)' },
  { id: 'uturn', name: 'Media vuelta' },
  { id: 'blaster', name: 'Láser' },
  { id: 'missile', name: 'Misil' },
  { id: 'pulse', name: 'Pulso' },
  { id: 'shield', name: 'Escudo' },
  { id: 'start', name: 'Empezar carrera' },
  { id: 'stop', name: 'Frenar todos' },
];

const b = (index: number): PadInput => ({ kind: 'button', index });
const ax = (index: number, dir: 1 | -1): PadInput => ({ kind: 'axis', index, dir });

export const DEFAULT_MAP: PadMap = {
  throttle: [b(7)],
  brake: [b(6), b(1)],
  left: [b(4), b(14), ax(0, -1)],
  right: [b(5), b(15), ax(0, 1)],
  faster: [b(12)],
  slower: [b(13)],
  uturn: [b(3)],
  blaster: [b(0)],
  missile: [b(2)],
  pulse: [b(10)],
  shield: [b(11)],
  start: [b(9)],
  stop: [b(8)],
};

const STORE = 'overdrive.padmaps';
/** Below this a stick counts as centred (sticks rarely rest exactly at 0). */
const DEADZONE = 0.15;
/** A press: half a trigger, or a stick pushed most of the way. */
const PRESS = 0.5;

function loadAll(): Record<string, Partial<PadMap>> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}');
  } catch {
    return {};
  }
}

/** The mapping for a pad model: saved changes over the defaults. */
export function padMap(id: string): PadMap {
  return { ...DEFAULT_MAP, ...(loadAll()[id] ?? {}) };
}

export function savePadMap(id: string, map: PadMap | undefined): void {
  const all = loadAll();
  if (map) all[id] = map;
  else delete all[id];
  try {
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* storage blocked: the change lasts until the page closes */
  }
}

/** How much `input` is pressed, 0..1 (triggers and sticks give the values in between). */
export function inputValue(pad: Gamepad, input: PadInput): number {
  if (input.kind === 'button') return pad.buttons[input.index]?.value ?? (pad.buttons[input.index]?.pressed ? 1 : 0);
  const v = (pad.axes[input.index] ?? 0) * input.dir;
  return v <= DEADZONE ? 0 : Math.min(1, (v - DEADZONE) / (1 - DEADZONE));
}

export function actionValue(pad: Gamepad, inputs: PadInput[]): number {
  return inputs.reduce((m, i) => Math.max(m, inputValue(pad, i)), 0);
}

const BUTTON_NAMES = ['A / ✕', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Select / Share', 'Start / Options', 'L3 (pulsar stick izq.)', 'R3 (pulsar stick der.)', 'Cruceta ↑', 'Cruceta ↓', 'Cruceta ←', 'Cruceta →', 'Botón central'];
const AXIS_NAMES: [string, string, string][] = [
  ['Stick izq.', '←', '→'],
  ['Stick izq.', '↑', '↓'],
  ['Stick der.', '←', '→'],
  ['Stick der.', '↑', '↓'],
];

/** "RT / R2", "Stick der. ↑", or "Botón 7" / "Eje 1 −" on pads without the standard layout. */
export function inputLabel(input: PadInput, standard = true): string {
  if (input.kind === 'button') return (standard && BUTTON_NAMES[input.index]) || `Botón ${input.index}`;
  const a = standard ? AXIS_NAMES[input.index] : undefined;
  return a ? `${a[0]} ${input.dir < 0 ? a[1] : a[2]}` : `Eje ${input.index} ${input.dir < 0 ? '−' : '+'}`;
}

export const sameInput = (a: PadInput, b: PadInput) => a.kind === b.kind && a.index === b.index && (a.kind === 'button' || a.dir === (b as typeof a).dir);

/**
 * The first input moved on `pad` compared with `rest` (the pad as it was): a button pressed,
 * or a stick pushed most of the way. For "press the button you want".
 */
export function movedInput(pad: Gamepad, rest: Gamepad | { buttons: { pressed: boolean }[]; axes: readonly number[] }): PadInput | undefined {
  const i = pad.buttons.findIndex((btn, k) => btn.pressed && !rest.buttons[k]?.pressed);
  if (i >= 0) return b(i);
  const k = pad.axes.findIndex((v, n) => Math.abs(v) > 0.6 && Math.abs(rest.axes[n] ?? 0) < 0.3);
  return k >= 0 ? ax(k, pad.axes[k] < 0 ? -1 : 1) : undefined;
}

interface PadState {
  on: Partial<Record<PadAction, boolean>>;
  /** Last throttle value sent to the car. */
  throttle: number;
}

export class Gamepads extends EventTarget {
  private state = new Map<number, PadState>();
  private maps = new Map<string, PadMap>();
  private running = false;
  /** Pads being configured: read, but they drive nothing. */
  private paused = new Set<number>();

  constructor(private hooks: PadHooks) {
    super();
    if (!('getGamepads' in navigator)) return;
    window.addEventListener('gamepadconnected', (e) => {
      hooks.notify(`Mando ${e.gamepad.index + 1} conectado: ${padName(e.gamepad)}`);
      this.dispatchEvent(new Event('change'));
      if (!this.running) {
        this.running = true;
        requestAnimationFrame(() => this.poll());
      }
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      hooks.notify(`Mando ${e.gamepad.index + 1} desconectado`);
      this.state.delete(e.gamepad.index);
      this.dispatchEvent(new Event('change'));
    });
  }

  list(): PadInfo[] {
    if (!('getGamepads' in navigator)) return [];
    return navigator.getGamepads().flatMap((p) => (p ? [{ index: p.index, name: padName(p), id: p.id }] : []));
  }

  /** The live pad, for the configuration screen. */
  pad(index: number): Gamepad | undefined {
    return navigator.getGamepads?.()[index] ?? undefined;
  }

  map(id: string): PadMap {
    let m = this.maps.get(id);
    if (!m) this.maps.set(id, (m = padMap(id)));
    return m;
  }

  setMap(id: string, map: PadMap | undefined): void {
    savePadMap(id, map);
    this.maps.delete(id);
  }

  /** While a pad is being configured its buttons drive nothing. */
  pause(index: number, on: boolean): void {
    if (on) this.paused.add(index);
    else this.paused.delete(index);
    this.state.delete(index);
  }

  /** Shakes pad `index`, if it can, so the player knows which one it is. */
  rumble(index: number, ms = 400): void {
    const pad = navigator.getGamepads?.()[index] as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null;
    void pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: 1, weakMagnitude: 1 }).catch(() => {});
  }

  private poll(): void {
    const pads = navigator.getGamepads().filter((p): p is Gamepad => !!p);
    if (!pads.length) {
      this.running = false;
      return;
    }
    pads.forEach((p) => this.paused.has(p.index) || this.read(p));
    requestAnimationFrame(() => this.poll());
  }

  private read(pad: Gamepad): void {
    const map = this.map(pad.id);
    const prev = this.state.get(pad.index) ?? { on: {}, throttle: 0 };
    const on: PadState['on'] = {};
    for (const { id } of PAD_ACTIONS) on[id] = actionValue(pad, map[id]) > PRESS;
    const edge = (a: PadAction) => !!on[a] && !prev.on[a];
    const throttle = actionValue(pad, map.throttle);
    const car = this.hooks.carFor(pad.index);

    if (pad.buttons.some((btn, i) => btn.pressed && !this.wasPressed(pad.index, i))) this.hooks.pressed?.(pad.index);
    if (edge('start')) this.hooks.start();
    if (edge('stop')) this.hooks.stopAll();
    let sent = prev.throttle;
    if (car?.ready) {
      // Only drive the speed from the throttle while it is in use, so the on-screen throttle still works.
      if ((throttle > 0.05 || prev.throttle > 0.05) && Math.abs(throttle - prev.throttle) > 0.02) {
        car.setSpeed(throttle * MAX_SPEED);
        sent = throttle;
      }
      if (edge('brake')) car.brake();
      if (edge('left')) car.laneLeft();
      if (edge('right')) car.laneRight();
      if (edge('faster')) car.accelerate();
      if (edge('slower')) car.decelerate();
      if (edge('uturn')) car.uTurn();
      if (edge('blaster')) this.hooks.fire(car, 'blaster');
      if (edge('missile')) this.hooks.fire(car, 'missile');
      if (edge('pulse')) this.hooks.fire(car, 'pulse');
      if (edge('shield')) this.hooks.fire(car, 'shield');
    }
    // Released all the way: start from zero next time, so a slow squeeze still adds up past the threshold.
    if (throttle <= 0.05) sent = throttle;
    this.state.set(pad.index, { on, throttle: sent });
    this.buttons.set(pad.index, pad.buttons.map((btn) => btn.pressed));
  }

  private buttons = new Map<number, boolean[]>();
  private wasPressed(index: number, button: number): boolean {
    return !!this.buttons.get(index)?.[button];
  }
}

export function padName(p: Gamepad): string {
  return p.id.split('(')[0].trim() || `Mando ${p.index + 1}`;
}
