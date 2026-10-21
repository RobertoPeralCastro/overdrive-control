import { describe, expect, it } from 'vitest';
import { Msg, MsgId, TurnType, batteryPercent, parseMessage } from '../src/protocol';
import { Car, carPlace, placeText } from '../src/car';
import type { Transport } from '../src/transport';

const bytes = (u: Uint8Array) => [...u];
const view = (arr: number[]) => new DataView(new Uint8Array(arr).buffer);

describe('encoding (byte-compatible with OpenOverdrive / drive-sdk)', () => {
  it('sdk mode', () => {
    expect(bytes(Msg.sdkMode(true))).toEqual([3, 0x90, 1, 1]);
    expect(bytes(Msg.sdkMode(false))).toEqual([3, 0x90, 0, 1]);
  });

  it('set speed (legacy and v4)', () => {
    expect(bytes(Msg.setSpeed(600, 25000))).toEqual([6, 0x24, 0x58, 0x02, 0xa8, 0x61, 1]);
    expect(bytes(Msg.setSpeed(600, 25000, true))).toEqual([7, 0x24, 0x58, 0x02, 0xa8, 0x61, 1, 1]);
  });

  it('offset and lane change', () => {
    expect(bytes(Msg.setOffsetFromCenter(0))).toEqual([5, 0x2c, 0, 0, 0, 0]);
    expect(bytes(Msg.changeLane(600, 8000, -44, 1, 3))).toEqual([11, 0x25, 0x58, 0x02, 0x40, 0x1f, 0x00, 0x00, 0x30, 0xc2, 1, 3]);
  });

  it('u-turn and simple messages', () => {
    expect(bytes(Msg.turn(TurnType.UTURN))).toEqual([3, 0x32, 3, 0]);
    expect(bytes(Msg.batteryRequest())).toEqual([1, 0x1a]);
    expect(bytes(Msg.disconnect())).toEqual([1, 0x0d]);
  });

  it('engine color uses 3 light entries scaled to 0..14', () => {
    const p = bytes(Msg.engineColor(255, 0, 128));
    expect(p.length).toBe(18);
    expect(p.slice(0, 3)).toEqual([17, 0x33, 3]);
    expect(p.slice(3, 8)).toEqual([0, 0, 14, 14, 0]); // red
    expect(p.slice(8, 13)).toEqual([3, 0, 0, 0, 0]); // green
    expect(p.slice(13, 18)).toEqual([2, 0, 7, 7, 0]); // blue
  });
});

describe('parsing', () => {
  it('battery in millivolts and percent', () => {
    expect(parseMessage(view([3, MsgId.V2C_BATTERY_RESP, 0x68, 0x10]))).toEqual({ type: 'battery', raw: 4200, percent: 100 });
    expect(batteryPercent(3750)).toBe(50);
    expect(batteryPercent(73)).toBe(73);
  });

  it('position update', () => {
    const buf = new DataView(new ArrayBuffer(10));
    buf.setUint8(0, 9);
    buf.setUint8(1, MsgId.V2C_LOC_POS);
    buf.setUint8(2, 12);
    buf.setUint8(3, 36);
    buf.setFloat32(4, -23.5, true);
    buf.setUint16(8, 700, true);
    expect(parseMessage(buf)).toEqual({ type: 'position', locationId: 12, pieceId: 36, offset: -23.5, speed: 700 });
  });

  it('status flags', () => {
    expect(parseMessage(view([5, MsgId.V2C_STATUS, 1, 0, 0, 1]))).toEqual({
      type: 'status',
      onTrack: true,
      onCharger: false,
      lowBattery: false,
      chargedBattery: true,
    });
  });

  it('delocalized (off the track)', () => {
    expect(parseMessage(view([1, MsgId.V2C_DELOCALIZED]))).toEqual({ type: 'delocalized' });
  });

  it('rejects truncated and unknown packets', () => {
    expect(parseMessage(view([9, MsgId.V2C_LOC_POS, 1, 2]))).toBeNull();
    expect(parseMessage(view([1]))).toBeNull();
    expect(parseMessage(view([1, 0x77]))).toBeNull();
  });
});

class FakeTransport implements Transport {
  id = 'fake';
  deviceName = 'Drive\u0001\u0002';
  modelId = 9;
  written: number[][] = [];
  onMessage: (d: DataView) => void = () => {};
  onDisconnect = () => {};
  onModelId = () => {};
  constructor(private version = 12385) {}
  async connect() {}
  async disconnect() {}
  async write(b: Uint8Array) {
    this.written.push([...b]);
    if (b[1] === MsgId.C2V_VERSION_REQ) this.onMessage(view([3, MsgId.V2C_VERSION_RESP, this.version & 0xff, this.version >> 8]));
  }
}

const idle = () => new Promise((r) => setTimeout(r, 200));

describe('Car', () => {
  it('handshakes with SDK mode 3x and learns name + firmware version', async () => {
    const t = new FakeTransport();
    const car = new Car(t);
    await car.connect();
    expect(t.written.slice(0, 3)).toEqual([[3, 0x90, 1, 1], [3, 0x90, 1, 1], [3, 0x90, 1, 1]]);
    expect(car.state.name).toBe('Skull');
    expect(car.state.version).toBe(12385);
    await car.disconnect();
  });

  it('coalesces rapid speed changes and uses v4 packets on new firmware', async () => {
    const t = new FakeTransport();
    const car = new Car(t);
    await car.connect();
    t.written = [];
    for (let s = 100; s <= 1000; s += 100) car.setSpeed(s);
    await idle();
    const speeds = t.written.filter((p) => p[1] === MsgId.C2V_SET_SPEED);
    expect(speeds.length).toBeLessThan(4);
    expect(speeds.at(-1)).toEqual(bytes(Msg.setSpeed(1000, 25000, true)));
    await car.disconnect();
  });

  it('lane change speeds the car up first, then sends relative offset', async () => {
    const t = new FakeTransport(0x2000);
    const car = new Car(t);
    await car.connect();
    t.written = [];
    car.laneRight();
    await idle();
    expect(t.written.map((p) => p[1])).toEqual([MsgId.C2V_SET_SPEED, MsgId.C2V_SET_OFFSET, MsgId.C2V_CHANGE_LANE]);
    expect(t.written[0]).toEqual(bytes(Msg.setSpeed(300, 25000, false)));
    expect(t.written[2]).toEqual(bytes(Msg.changeLane(600, 8000, 44, 1, 0)));
    await car.disconnect();
  });

  it('brake sends speed 0 with hard deceleration', async () => {
    const t = new FakeTransport();
    const car = new Car(t);
    await car.connect();
    car.setSpeed(800);
    await idle();
    t.written = [];
    car.brake();
    await idle();
    expect(t.written).toEqual([bytes(Msg.setSpeed(0, 30000, true))]);
    await car.disconnect();
  });

  it('knows when it is charging, on the track or off it', async () => {
    const t = new FakeTransport();
    const car = new Car(t);
    await car.connect();
    expect(carPlace(car.state)).toBe('unknown');
    t.onMessage(view([5, MsgId.V2C_STATUS, 0, 1, 0, 0]));
    expect(carPlace(car.state)).toBe('charger');
    expect(placeText(car.state)).toMatch(/Cargando/);
    t.onMessage(view([5, MsgId.V2C_STATUS, 1, 0, 0, 0]));
    expect(carPlace(car.state)).toBe('track');
    t.onMessage(view([1, MsgId.V2C_DELOCALIZED]));
    expect(carPlace(car.state)).toBe('off');
    // Driving again over the codes puts it back on the track.
    t.onMessage(view([3, MsgId.V2C_LOC_TRANS, 4, 3]));
    expect(carPlace(car.state)).toBe('track');
    await car.disconnect();
  });
});
