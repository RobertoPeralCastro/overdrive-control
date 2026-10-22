import { describe, expect, it } from 'vitest';

/** Just enough Web Audio to see what the engine asks for. */
class Param {
  value = 0;
  target = 0;
  setTargetAtTime(v: number) {
    this.target = v;
  }
}
class Node {
  connect<T>(n: T): T {
    return n;
  }
}
class Osc extends Node {
  type = '';
  frequency = new Param();
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
const oscs: Osc[] = [];
class Gain extends Node {
  gain = new Param();
}
class FakeAudio {
  state = 'running';
  currentTime = 0;
  destination = new Node();
  createOscillator() {
    const o = new Osc();
    oscs.push(o);
    return o;
  }
  createGain() {
    return new Gain();
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { type: '', Q: new Param(), frequency: new Param() });
  }
  resume() {}
}
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudio;

const { Engine, engineSound } = await import('../src/sound');

describe('engine sound', () => {
  it('idles low and revs up with the speed, then stops', () => {
    const e = new Engine();
    e.set(0);
    const [saw] = oscs;
    expect(saw.started).toBe(true);
    const idle = saw.frequency.target;
    e.set(1);
    expect(saw.frequency.target).toBeGreaterThan(idle * 3);
    e.stop();
    expect(oscs.every((o) => o.stopped)).toBe(true);
  });

  it('stays quiet when the engine sound is switched off', () => {
    engineSound.set(false);
    const before = oscs.length;
    const e = new Engine();
    e.set(0.8);
    expect(oscs.length).toBe(before);
    engineSound.set(true);
    e.set(0.8);
    expect(oscs.length).toBeGreaterThan(before);
    e.destroy();
  });
});
