import { MAX_SPEED, type Car } from './car';

/**
 * Standard-mapping gamepad (Xbox/PlayStation layout):
 * RT = throttle, LT or B = brake, LB/RB or D-pad = lane change, Y = U-turn.
 */
export function setupGamepad(getCar: () => Car | undefined, notify: (msg: string) => void): void {
  if (!('getGamepads' in navigator)) return;
  let running = false;
  let prev: boolean[] = [];
  let lastTrigger = 0;

  window.addEventListener('gamepadconnected', (e) => {
    notify(`Mando conectado: ${e.gamepad.id.split('(')[0].trim()}`);
    if (!running) {
      running = true;
      requestAnimationFrame(poll);
    }
  });

  function poll(): void {
    const pad = navigator.getGamepads().find((p) => p?.mapping === 'standard') ?? navigator.getGamepads().find(Boolean);
    if (!pad) {
      running = false;
      return;
    }
    const car = getCar();
    const pressed = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !prev[i];

    if (car) {
      const rt = pad.buttons[7]?.value ?? 0;
      // Only drive the speed from the trigger while it is in use, so the on-screen throttle still works.
      if (rt > 0.05 || lastTrigger > 0.05) {
        if (Math.abs(rt - lastTrigger) > 0.02) car.setSpeed(rt * MAX_SPEED);
        lastTrigger = rt;
      }
      if (edge(6) || edge(1)) car.brake();
      if (edge(4) || edge(14)) car.laneLeft();
      if (edge(5) || edge(15)) car.laneRight();
      if (edge(12)) car.accelerate();
      if (edge(13)) car.decelerate();
      if (edge(3)) car.uTurn();
    }
    prev = pressed;
    requestAnimationFrame(poll);
  }
}
