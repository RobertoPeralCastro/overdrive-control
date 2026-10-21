import { MAX_SPEED } from './car';
import type { Drivable } from './cockpit';
import type { WeaponId } from './battle';

/**
 * Gamepads over USB or Bluetooth (both show up through the browser's Gamepad API; the
 * browser only reveals a pad after one of its buttons is pressed). Several pads can play
 * at once, each driving its own car.
 *
 * Standard mapping (Xbox/PlayStation layout):
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
}

const STICK = 0.6;

interface PadState {
  buttons: boolean[];
  trigger: number;
  stickX: number;
}

export class Gamepads extends EventTarget {
  private state = new Map<number, PadState>();
  private running = false;

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
    return navigator.getGamepads().flatMap((p) => (p ? [{ index: p.index, name: padName(p) }] : []));
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
    pads.forEach((p) => this.read(p));
    requestAnimationFrame(() => this.poll());
  }

  private read(pad: Gamepad): void {
    const prev = this.state.get(pad.index) ?? { buttons: [], trigger: 0, stickX: 0 };
    const pressed = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !prev.buttons[i];
    const trigger = pad.buttons[7]?.value ?? 0;
    const stickX = pad.axes[0] ?? 0;
    const car = this.hooks.carFor(pad.index);

    if (pressed.some((_, i) => edge(i))) this.hooks.pressed?.(pad.index);
    if (edge(9)) this.hooks.start();
    if (edge(8)) this.hooks.stopAll();
    if (car?.ready) {
      // Only drive the speed from the trigger while it is in use, so the on-screen throttle still works.
      if (trigger > 0.05 || prev.trigger > 0.05) {
        if (Math.abs(trigger - prev.trigger) > 0.02) car.setSpeed(trigger * MAX_SPEED);
      }
      if (edge(6) || edge(1)) car.brake();
      if (edge(4) || edge(14) || (stickX < -STICK && prev.stickX >= -STICK)) car.laneLeft();
      if (edge(5) || edge(15) || (stickX > STICK && prev.stickX <= STICK)) car.laneRight();
      if (edge(12)) car.accelerate();
      if (edge(13)) car.decelerate();
      if (edge(3)) car.uTurn();
      if (edge(0)) this.hooks.fire(car, 'blaster');
      if (edge(2)) this.hooks.fire(car, 'missile');
      if (edge(10)) this.hooks.fire(car, 'pulse');
      if (edge(11)) this.hooks.fire(car, 'shield');
    }
    // Remember the last trigger value actually sent, so a slow squeeze still adds up past the threshold.
    const sent = Math.abs(trigger - prev.trigger) > 0.02 || trigger <= 0.05 ? trigger : prev.trigger;
    this.state.set(pad.index, { buttons: pressed, trigger: sent, stickX });
  }
}

function padName(p: Gamepad): string {
  return p.id.split('(')[0].trim() || `Mando ${p.index + 1}`;
}
