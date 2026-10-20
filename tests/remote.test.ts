import { describe, expect, it } from 'vitest';
import { Car } from '../src/car';
import { memoryPair, newRoomCode, normalizeCode } from '../src/net';
import { Msg, MsgId } from '../src/protocol';
import { GuestLink, GuestSession, guestModel, type Action, type Snapshot } from '../src/remote';
import type { Transport } from '../src/transport';

/** The guest's Bluetooth car: answers the version request like a real one. */
class BleCar implements Transport {
  id = 'ble-1';
  deviceName = 'Drive';
  modelId = 10;
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

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const [hostEnd, guestEnd] = memoryPair();
  const ble = new BleCar();
  const actions: Action[] = [];
  let hostCar: Car | undefined;
  let left = false;
  const link = new GuestLink(hostEnd, {
    addCar: (t) => {
      hostCar = new Car(t);
      void hostCar.connect();
      return hostCar;
    },
    act: (car, a) => {
      actions.push(a);
      if (a.a === 'speed') car.setSpeed(a.v);
    },
    left: () => (left = true),
  });
  const session = new GuestSession(guestEnd);
  return { link, session, ble, actions, car: () => hostCar!, left: () => left, close: () => guestEnd.close() };
}

describe('multiplayer bridge', () => {
  it('the host drives the guest car through the guest phone', async () => {
    const env = setup();
    env.session.attachCar(env.ble);
    await wait(1000);
    const car = env.car();
    expect(car.ready).toBe(true);
    // Handshake went through the bridge to the real car, and its answer came back.
    expect(env.ble.written[0]).toEqual([...Msg.sdkMode(true)]);
    expect(car.state.version).toBe(12385);
    expect(car.state.name).toBe('Thermo');

    env.ble.written = [];
    env.session.control.setSpeed(700);
    await wait(100);
    expect(env.actions).toContainEqual(expect.objectContaining({ a: 'speed', v: 700 }));
    expect(env.ble.written).toContainEqual([...Msg.setSpeed(700, 25000, true)]);
    await car.disconnect();
  });

  it('throttle drags are sent at most every 50 ms', async () => {
    const env = setup();
    env.session.attachCar(env.ble);
    await wait(20);
    for (let s = 100; s <= 1000; s += 100) env.session.control.setSpeed(s);
    await wait(150);
    const speeds = env.actions.filter((a) => a.a === 'speed');
    expect(speeds.length).toBeLessThanOrEqual(3);
    expect(speeds.at(-1)).toMatchObject({ v: 1000 });
  });

  it('snapshots reach the guest with their events, and its cockpit reads them', async () => {
    const env = setup();
    env.session.attachCar(env.ble);
    await wait(1000);
    const events: unknown[] = [];
    env.session.addEventListener('event', (e) => events.push((e as CustomEvent).detail));
    env.link.push({ k: 'sfx', n: 'laser' });
    env.link.push({ k: 'toast', m: 'Hola' });
    env.link.sendSnapshot(
      (ev): Snapshot => ({
        car: { ...env.car().state },
        combat: { armor: 70, energy: 40, downMs: 0, shielded: false, cooling: { blaster: 0, missile: 0.5, pulse: 0, shield: 0 } },
        target: { text: 'Objetivo: Skull · 1 pieza delante', hot: true },
        track: { text: 'Pista: 9 piezas', canScan: true, rescan: true },
        map: { lap: [33, 36, 34], turns: [], cars: [] },
        race: { phase: 'setup', lights: 0, totalLaps: 3, weapons: true, standings: [], winner: undefined },
        events: ev,
      }),
    );
    await wait();
    expect(events).toEqual([{ k: 'sfx', n: 'laser' }, { k: 'toast', m: 'Hola' }]);
    const model = guestModel(env.session, { padName: () => undefined, reconnect: () => {}, leave: () => {}, toast: () => {} });
    expect(model.car.ready).toBe(true);
    expect(model.combat()?.armor).toBe(70);
    expect(model.target().hot).toBe(true);
    expect(model.state().name).toBe('Thermo');
    await env.car().disconnect();
  });

  it('the car dropping on the guest phone reaches the host car, and comes back', async () => {
    const env = setup();
    env.session.attachCar(env.ble);
    await wait(1000);
    const car = env.car();
    env.ble.onDisconnect();
    await wait();
    expect(car.state.status).toBe('reconnecting');
    env.session.announceCar();
    await wait(2500);
    expect(car.state.status).toBe('ready');
    await car.disconnect();
  });

  it('the host hears when the guest leaves', async () => {
    const env = setup();
    env.session.attachCar(env.ble);
    await wait();
    env.close();
    expect(env.left()).toBe(true);
    expect(env.link.closed).toBe(true);
  });
});

describe('room codes', () => {
  it('are short, unambiguous and survive sloppy typing', () => {
    const code = newRoomCode(() => 0.5);
    expect(code).toMatch(/^[a-z2-9]{5}$/);
    expect(code).not.toMatch(/[01il]/);
    expect(normalizeCode(' AB-C 12 ')).toBe('abc12');
  });
});
