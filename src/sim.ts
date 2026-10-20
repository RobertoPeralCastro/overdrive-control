import { MsgId, V4_SPEED_MIN_VERSION } from './protocol';
import type { Transport } from './transport';

let simCount = 0;
const SIM_MODELS = [9, 10, 8, 11];

/** Fake car that speaks the protocol, for trying the UI without hardware (?demo). */
export class SimTransport implements Transport {
  readonly id: string;
  readonly deviceName = 'Drive';
  modelId: number;
  onMessage: (data: DataView) => void = () => {};
  onDisconnect: () => void = () => {};
  onModelId: (id: number) => void = () => {};

  private speed = 0;
  private target = 0;
  private accel = 25000;
  private offset = 0;
  private targetOffset = 0;
  private piece = 0;
  private distance = 0;
  private battery = 4100;
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    this.id = `sim-${++simCount}`;
    this.modelId = SIM_MODELS[(simCount - 1) % SIM_MODELS.length];
  }

  async connect(): Promise<void> {
    await new Promise((r) => setTimeout(r, 400));
    let tick = 0;
    this.timer = setInterval(() => this.step(0.1, ++tick), 100);
    this.emit(MsgId.V2C_STATUS, [1, 0, 0, 0]);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (bytes[1]) {
      case MsgId.C2V_VERSION_REQ:
        this.emit(MsgId.V2C_VERSION_RESP, u16(V4_SPEED_MIN_VERSION));
        break;
      case MsgId.C2V_BATTERY_REQ:
        this.emit(MsgId.V2C_BATTERY_RESP, u16(this.battery));
        break;
      case MsgId.C2V_PING:
        this.emit(MsgId.V2C_PING_RESP, []);
        break;
      case MsgId.C2V_SET_SPEED:
        this.target = v.getInt16(2, true);
        this.accel = v.getInt16(4, true);
        break;
      case MsgId.C2V_SET_OFFSET:
        this.offset = v.getFloat32(2, true);
        this.targetOffset = this.offset;
        break;
      case MsgId.C2V_CHANGE_LANE:
        if (this.speed > 100) this.targetOffset = Math.max(-68, Math.min(68, v.getFloat32(6, true)));
        break;
    }
  }

  async disconnect(): Promise<void> {
    clearInterval(this.timer);
  }

  private step(dt: number, tick: number) {
    const dv = this.accel * dt * 0.05;
    this.speed += Math.max(-dv, Math.min(dv, this.target - this.speed));
    this.offset += Math.max(-6, Math.min(6, this.targetOffset - this.offset));
    this.distance += this.speed * dt;
    this.battery = Math.max(3300, this.battery - this.speed * 0.0002);
    if (this.distance > 560) {
      this.distance = 0;
      this.piece = (this.piece + 1) % 12;
      this.emit(MsgId.V2C_LOC_TRANS, [this.piece, (this.piece + 11) % 12]);
    }
    if (tick % 3 === 0 && this.speed > 10) {
      const p = new DataView(new ArrayBuffer(8));
      p.setUint8(0, this.piece * 3);
      p.setUint8(1, [17, 18, 20, 23, 36, 39, 40][this.piece % 7]);
      p.setFloat32(2, this.offset, true);
      p.setUint16(6, Math.round(this.speed), true);
      this.emit(MsgId.V2C_LOC_POS, [...new Uint8Array(p.buffer)]);
    }
  }

  private emit(id: number, payload: number[]) {
    const buf = new Uint8Array([payload.length + 1, id, ...payload]);
    this.onMessage(new DataView(buf.buffer));
  }
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
