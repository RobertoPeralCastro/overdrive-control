import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP, actionValue, inputLabel, inputValue, movedInput, type PadInput } from '../src/gamepad';

function pad(buttons: number[] = [], axes: number[] = [0, 0, 0, 0]): Gamepad {
  return {
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: (buttons[i] ?? 0) > 0.5, touched: false, value: buttons[i] ?? 0 })),
    axes,
  } as unknown as Gamepad;
}

describe('gamepad mapping', () => {
  it('reads triggers and stick directions as 0..1, with a dead zone', () => {
    const rt: PadInput = { kind: 'button', index: 7 };
    const stickUp: PadInput = { kind: 'axis', index: 3, dir: -1 };
    const p = pad([0, 0, 0, 0, 0, 0, 0, 0.4], [0, 0, 0, -0.575]);
    expect(inputValue(p, rt)).toBeCloseTo(0.4);
    expect(inputValue(p, stickUp)).toBeCloseTo(0.5);
    expect(inputValue(pad([], [0, 0, 0, -0.1]), stickUp)).toBe(0); // resting stick
    expect(inputValue(pad([], [0, 0, 0, 0.9]), stickUp)).toBe(0); // pushed the other way
    expect(actionValue(p, [rt, stickUp])).toBeCloseTo(0.5);
  });

  it('catches the button pressed or the stick pushed, for "press the one you want"', () => {
    const rest = pad();
    expect(movedInput(pad([0, 0, 1]), rest)).toEqual({ kind: 'button', index: 2 });
    expect(movedInput(pad([], [0, -0.9, 0, 0]), rest)).toEqual({ kind: 'axis', index: 1, dir: -1 });
    expect(movedInput(pad([], [0, 0.3, 0, 0]), rest)).toBeUndefined();
    // A button already held when listening started doesn't count.
    expect(movedInput(pad([1]), pad([1]))).toBeUndefined();
  });

  it('names inputs like the pad does', () => {
    expect(DEFAULT_MAP.throttle.map((i) => inputLabel(i))).toEqual(['RT / R2']);
    expect(inputLabel({ kind: 'axis', index: 3, dir: -1 })).toBe('Stick der. ↑');
    expect(inputLabel({ kind: 'axis', index: 5, dir: 1 }, false)).toBe('Eje 5 +');
  });
});
