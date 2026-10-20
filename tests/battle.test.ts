import { describe, expect, it } from 'vitest';
import { Battle, MAX_ARMOR } from '../src/battle';
import { Car } from '../src/car';
import { LightEffect, Msg, MsgId } from '../src/protocol';
import { TrackLearner, describeTrack } from '../src/track';
import type { Transport } from '../src/transport';

class FakeTransport implements Transport {
  static count = 0;
  id = `fake-${++FakeTransport.count}`;
  deviceName = 'Drive';
  modelId = 9;
  written: number[][] = [];
  onMessage: (d: DataView) => void = () => {};
  onDisconnect = () => {};
  onModelId = () => {};
  async connect() {}
  async disconnect() {}
  async write(b: Uint8Array) {
    this.written.push([...b]);
    if (b[1] === MsgId.C2V_VERSION_REQ) this.onMessage(new DataView(new Uint8Array([3, MsgId.V2C_VERSION_RESP, 0x61, 0x30]).buffer));
  }
}

const idle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function connectedCar() {
  const t = new FakeTransport();
  const car = new Car(t);
  await car.connect();
  t.written = [];
  return { car, t };
}

const LAP = [33, 36, 17, 18, 39, 20, 23, 40, 34];

describe('TrackLearner', () => {
  it('learns a lap between two passes over the start line', () => {
    const l = new TrackLearner();
    const seen = [36, 17, ...LAP, 33].map((id) => l.push(id));
    expect(seen.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(seen.at(-1)).toEqual({ pieces: LAP, at: 0 });
  });

  it('ignores repeated reports of the same piece', () => {
    const l = new TrackLearner();
    for (const id of [33, 33, 36, 36, 17, 18, 34]) l.push(id);
    expect(l.push(33)?.pieces).toEqual([33, 36, 17, 18, 34]);
  });

  it('without a start piece, waits for two identical laps', () => {
    const l = new TrackLearner();
    const loop = [36, 17, 18, 39, 20];
    const seen = [...loop, ...loop].map((id) => l.push(id));
    expect(seen.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(seen.at(-1)).toEqual({ pieces: loop, at: 4 });
  });

  it('describes the track', () => {
    expect(describeTrack(LAP)).toBe('9 piezas (3 rectas, 4 curvas)');
  });
});

describe('Battle', () => {
  async function setup() {
    let now = 0;
    const battle = new Battle(() => now);
    const a = await connectedCar();
    const b = await connectedCar();
    battle.add(a.car);
    battle.add(b.car);
    // Car A learns the lap, then B sits 2 pieces ahead of it.
    for (const id of [...LAP, 33]) battle.observe(a.car, id);
    battle.observe(b.car, 17);
    battle.observe(b.car, 18);
    battle.observe(a.car, 36);
    return { battle, a, b, clock: (ms: number) => (now += ms) };
  }

  it('finds the car ahead on the learned lap', async () => {
    const { battle, a, b } = await setup();
    expect(battle.lap).toEqual(LAP);
    expect(battle.targetFor(a.car)).toEqual({ car: b.car, pieces: 2 });
    // B is ahead, so A is behind it: nothing to shoot within range from B's side except by wrapping the lap.
    expect(battle.targetFor(b.car, 3)).toBeUndefined();
  });

  it('a missile hit costs armor, slows the target and blinks it red', async () => {
    const { battle, a, b } = await setup();
    b.car.setSpeed(1000);
    await idle();
    b.t.written = [];
    const r = battle.fire(a.car, 'missile');
    expect(r).toEqual({ ok: true, hits: [{ target: b.car, blocked: false, knockedOut: false }] });
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR - 30);
    await idle();
    expect(b.t.written).toContainEqual([...Msg.setSpeed(300, 30000, true)]);
    expect(b.t.written).toContainEqual([...Msg.engineColor(255, 0, 0, LightEffect.FLASH, 40)]);
    expect(battle.fighter(a.car)!.energy).toBe(65);
  });

  it('the laser only reaches one piece ahead', async () => {
    const { battle, a } = await setup();
    expect(battle.fire(a.car, 'blaster')).toEqual({ ok: true, hits: [] });
  });

  it('cooldown and energy limit firing', async () => {
    const { battle, a, clock } = await setup();
    expect(battle.fire(a.car, 'missile').ok).toBe(true);
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: false, reason: 'Recargando' });
    clock(3000);
    expect(battle.fire(a.car, 'missile').ok).toBe(true);
    clock(3000);
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: false, reason: 'Sin energía' });
  });

  it('a shield blocks hits', async () => {
    const { battle, a, b } = await setup();
    battle.fire(b.car, 'shield');
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: true, hits: [{ target: b.car, blocked: true, knockedOut: false }] });
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR);
  });

  it('knocks a car out at 0 armor and brings it back later', async () => {
    const { battle, a, b, clock } = await setup();
    battle.fighter(b.car)!.armor = 20;
    const r = battle.fire(a.car, 'missile');
    expect(r.ok && r.hits[0].knockedOut).toBe(true);
    expect(battle.fighter(a.car)!.kills).toBe(1);
    await idle();
    expect(b.t.written).toContainEqual([...Msg.setSpeed(0, 30000, true)]);
    expect(battle.fire(b.car, 'blaster')).toEqual({ ok: false, reason: 'Estás fuera de combate' });
    clock(3100);
    battle.tick();
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR);
  });

  it('before the lap is known, only cars on the same piece are in range', async () => {
    const battle = new Battle(() => 0);
    const a = await connectedCar();
    const b = await connectedCar();
    battle.add(a.car);
    battle.add(b.car);
    battle.observe(a.car, 36);
    battle.observe(b.car, 17);
    expect(battle.targetFor(a.car)).toBeUndefined();
    battle.observe(b.car, 36);
    expect(battle.targetFor(a.car)).toEqual({ car: b.car, pieces: 0 });
  });

  it('scanning drives the car and brakes it once the lap is learned', async () => {
    const battle = new Battle(() => 0);
    const a = await connectedCar();
    battle.add(a.car);
    battle.scan(a.car);
    expect(a.car.state.targetSpeed).toBe(450);
    for (const id of [...LAP, 33]) battle.observe(a.car, id);
    expect(battle.scanning).toBeUndefined();
    expect(a.car.state.targetSpeed).toBe(0);
  });
});

describe('Car speed limit', () => {
  it('caps the speed for a while and then restores the cruise speed', async () => {
    const { car, t } = await connectedCar();
    car.setSpeed(800);
    await idle();
    t.written = [];
    car.limitSpeed(200, 150);
    await idle(50);
    expect(t.written).toEqual([[...Msg.setSpeed(200, 30000, true)]]);
    await idle(200);
    expect(t.written.at(-1)).toEqual([...Msg.setSpeed(800, 25000, true)]);
    expect(car.state.targetSpeed).toBe(800);
  });
});
