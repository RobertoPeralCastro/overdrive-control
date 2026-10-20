import { LightEffect, MODEL_NAMES, Msg, TurnType, V4_SPEED_MIN_VERSION, parseMessage, type VehicleMessage } from './protocol';
import { sleep, type Transport } from './transport';

export const MAX_SPEED = 1500;
export const SPEED_STEP = 150;
const DRIVE_ACCEL = 25000;
const BRAKE_ACCEL = 30000;
/** Lane changes only happen while moving; nudge the car up to this first. */
const MIN_LANE_SPEED = 300;
/** Roughly one lane width in mm. */
const LANE_WIDTH = 44;
const BATTERY_POLL_MS = 30_000;

export type CarStatus = 'connecting' | 'ready' | 'reconnecting' | 'disconnected';

export interface CarState {
  status: CarStatus;
  name: string;
  targetSpeed: number;
  speed: number;
  battery?: number;
  version?: number;
  onTrack?: boolean;
  onCharger?: boolean;
  lowBattery?: boolean;
  pieceId?: number;
  offset?: number;
  color: string;
  error?: string;
}

const PALETTE = ['#ff3b30', '#0a84ff', '#30d158', '#ffd60a', '#bf5af2', '#ff9f0a'];
let carCount = 0;

/**
 * One connected car. Serializes writes (Web Bluetooth rejects overlapping GATT operations)
 * and coalesces speed commands so dragging the throttle never builds a backlog.
 */
export class Car extends EventTarget {
  readonly state: CarState;
  private queue: Uint8Array[] = [];
  private pendingSpeed?: Uint8Array;
  private flushing = false;
  private laneTag = 0;
  private batteryTimer?: ReturnType<typeof setInterval>;
  /** Temporary speed ceiling from weapon hits; the cruise speed stays in state.targetSpeed. */
  private speedCap?: number;
  private capTimer?: ReturnType<typeof setTimeout>;
  private lightTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly transport: Transport) {
    super();
    this.state = {
      status: 'connecting',
      name: carName(transport),
      targetSpeed: 0,
      speed: 0,
      color: PALETTE[carCount++ % PALETTE.length],
    };
    transport.onMessage = (d) => {
      const msg = parseMessage(d);
      if (msg) this.handle(msg);
    };
    transport.onModelId = () => this.update({ name: carName(transport) });
    transport.onDisconnect = () => void this.reconnect();
  }

  get id(): string {
    return this.transport.id;
  }

  get ready(): boolean {
    return this.state.status === 'ready';
  }

  async connect(): Promise<void> {
    this.update({ status: 'connecting', error: undefined });
    try {
      await this.transport.connect();
      await this.handshake();
      this.update({ status: 'ready' });
    } catch (e) {
      this.update({ status: 'disconnected', error: errorText(e) });
      throw e;
    }
  }

  /** Same sequence as OpenOverdrive: SDK mode 3x (cars ignore it right after power-on), then queries. */
  private async handshake(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.transport.write(Msg.sdkMode(true));
      await sleep(150);
    }
    await this.transport.write(Msg.versionRequest());
    // The speed packet format depends on the firmware version, so give it a moment to answer.
    for (let i = 0; i < 10 && this.state.version === undefined; i++) await sleep(60);
    await this.transport.write(Msg.batteryRequest());
    await this.transport.write(Msg.engineColor(...hexToRgb(this.state.color)));
    clearInterval(this.batteryTimer);
    this.batteryTimer = setInterval(() => this.send(Msg.batteryRequest()), BATTERY_POLL_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.state.status === 'disconnected') return;
    this.update({ status: 'reconnecting', speed: 0, targetSpeed: 0 });
    this.queue = [];
    this.pendingSpeed = undefined;
    for (let i = 0; i < 3; i++) {
      await sleep(1000 * (i + 1));
      try {
        await this.transport.connect();
        await this.handshake();
        this.update({ status: 'ready', error: undefined });
        return;
      } catch {
        /* try again */
      }
    }
    clearInterval(this.batteryTimer);
    this.update({ status: 'disconnected', error: 'Se perdió la conexión' });
  }

  async disconnect(): Promise<void> {
    clearInterval(this.batteryTimer);
    clearTimeout(this.capTimer);
    clearTimeout(this.lightTimer);
    this.update({ status: 'disconnected' });
    try {
      await this.transport.write(Msg.setSpeed(0, BRAKE_ACCEL, this.v4));
      await this.transport.write(Msg.disconnect());
    } catch {
      /* already gone */
    }
    await this.transport.disconnect();
  }

  // ---- Driving -------------------------------------------------------------

  setSpeed(speed: number): void {
    this.update({ targetSpeed: Math.round(Math.max(0, Math.min(MAX_SPEED, speed))) });
    this.queueSpeed();
  }

  /** Caps the speed for a while (weapon hits). The cruise speed comes back when it ends. */
  limitSpeed(max: number, ms: number): void {
    clearTimeout(this.capTimer);
    this.speedCap = Math.max(0, Math.round(max));
    this.queueSpeed();
    this.capTimer = setTimeout(() => {
      this.speedCap = undefined;
      if (this.ready) this.queueSpeed();
    }, ms);
  }

  /** Blinks the engine light in `color`, then goes back to the car's own color. */
  flashLights(color: string, ms: number, effect: number = LightEffect.FLASH, cyclesPer10s = 40): void {
    clearTimeout(this.lightTimer);
    this.send(Msg.engineColor(...hexToRgb(color), effect, cyclesPer10s));
    this.lightTimer = setTimeout(() => {
      if (this.ready) this.send(Msg.engineColor(...hexToRgb(this.state.color)));
    }, ms);
  }

  accelerate(step = SPEED_STEP): void {
    this.setSpeed(this.state.targetSpeed + step);
  }

  decelerate(step = SPEED_STEP): void {
    this.setSpeed(this.state.targetSpeed - step);
  }

  brake(): void {
    this.setSpeed(0);
  }

  laneLeft(): void {
    this.changeLane(-LANE_WIDTH);
  }

  laneRight(): void {
    this.changeLane(LANE_WIDTH);
  }

  uTurn(): void {
    if (this.state.targetSpeed < MIN_LANE_SPEED) this.setSpeed(MIN_LANE_SPEED);
    this.send(Msg.turn(TurnType.UTURN));
  }

  setColor(color: string): void {
    this.update({ color });
    this.send(Msg.engineColor(...hexToRgb(color)));
  }

  /**
   * Lane changes are relative: tell the car it is at the center (offset 0),
   * then ask it to move one lane width to either side.
   */
  private changeLane(delta: number): void {
    if (this.state.targetSpeed < MIN_LANE_SPEED) this.setSpeed(MIN_LANE_SPEED);
    this.send(Msg.setOffsetFromCenter(0));
    this.send(Msg.changeLane(600, 8000, delta, 1, this.laneTag));
    this.laneTag = (this.laneTag + 1) & 0xff;
  }

  // ---- Plumbing ------------------------------------------------------------

  private queueSpeed(): void {
    const target = this.state.targetSpeed;
    const s = Math.min(target, this.speedCap ?? MAX_SPEED);
    this.pendingSpeed = Msg.setSpeed(s, s === 0 || s < target ? BRAKE_ACCEL : DRIVE_ACCEL, this.v4);
    void this.flush();
  }

  private get v4(): boolean {
    return (this.state.version ?? 0) >= V4_SPEED_MIN_VERSION;
  }

  private send(bytes: Uint8Array): void {
    this.queue.push(bytes);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.ready && (this.pendingSpeed || this.queue.length)) {
        // Speed goes first so a lane change right after accelerating sees the car moving.
        const next = this.pendingSpeed ?? this.queue.shift()!;
        if (next === this.pendingSpeed) this.pendingSpeed = undefined;
        try {
          await this.transport.write(next);
        } catch (e) {
          this.update({ error: errorText(e) });
        }
        await sleep(20);
      }
    } finally {
      this.flushing = false;
    }
  }

  private handle(msg: VehicleMessage): void {
    switch (msg.type) {
      case 'battery':
        this.update({ battery: msg.percent });
        break;
      case 'version':
        this.update({ version: msg.version });
        break;
      case 'position':
        this.update({ speed: msg.speed, pieceId: msg.pieceId, offset: msg.offset, onTrack: true });
        break;
      case 'status':
        this.update({ onTrack: msg.onTrack, onCharger: msg.onCharger, lowBattery: msg.lowBattery });
        break;
    }
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  private update(patch: Partial<CarState>): void {
    Object.assign(this.state, patch);
    this.dispatchEvent(new Event('change'));
  }
}

function carName(t: Transport): string {
  if (t.modelId !== undefined && MODEL_NAMES[t.modelId]) return MODEL_NAMES[t.modelId];
  // Cars advertise a name like "Drive" followed by garbage bytes on some phones.
  const clean = t.deviceName.replace(/[^\x20-\x7e]/g, '').trim();
  return clean || 'Coche';
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
