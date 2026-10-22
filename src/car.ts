import { t } from './i18n';
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
/** Widest sideways move in one go (from one edge lane to the middle and a bit). */
const MAX_SHIFT = 70;
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
  chargedBattery?: boolean;
  pieceId?: number;
  offset?: number;
  color: string;
  error?: string;
}

/** Where a connected car is, from what it reports: on the charger, on the track or off it. */
export type CarPlace = 'charger' | 'track' | 'off' | 'unknown';

export function carPlace(s: CarState): CarPlace {
  if (s.status !== 'ready') return 'unknown';
  if (s.onCharger) return 'charger';
  if (s.onTrack === true) return 'track';
  if (s.onTrack === false) return 'off';
  return 'unknown';
}

/** A short label for the car's place, with its battery. */
export function placeText(s: CarState): string {
  const pct = s.battery !== undefined ? ` · ${s.battery}%` : '';
  switch (carPlace(s)) {
    case 'charger':
      return s.chargedBattery ? t(`🔌 Cargado${pct}`, `🔌 Charged${pct}`) : t(`🔌 Cargando${pct}`, `🔌 Charging${pct}`);
    case 'track':
      return t(`🛣️ En la pista${pct}`, `🛣️ On the track${pct}`);
    case 'off':
      return t(`⚠️ Fuera de la pista${pct}`, `⚠️ Off the track${pct}`);
    default:
      return s.status === 'ready' ? t(`Listo${pct}`, `Ready${pct}`) : '';
  }
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

  /** Whether we know which car this is (from its advertisement, or because the player said so). */
  get known(): boolean {
    return !!savedName(this.id) || (this.transport.modelId !== undefined && !!MODEL_NAMES[this.transport.modelId]);
  }

  /** The player's name for this car, remembered for this car from now on. */
  rename(name: string): void {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    savedNames({ [this.id]: clean });
    this.update({ name: clean });
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
    this.update({ status: 'disconnected', error: t('Se perdió la conexión', 'Connection lost') });
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
    this.shiftLane(-LANE_WIDTH);
  }

  laneRight(): void {
    this.shiftLane(LANE_WIDTH);
  }

  uTurn(): void {
    if (this.state.targetSpeed < MIN_LANE_SPEED) this.setSpeed(MIN_LANE_SPEED);
    this.send(Msg.turn(TurnType.UTURN));
  }

  /** Blinks fast for a few seconds so the player can spot which car this is. */
  identify(): void {
    this.flashLights(this.state.color, 3000, LightEffect.FLASH, 80);
  }

  setColor(color: string): void {
    this.update({ color });
    this.send(Msg.engineColor(...hexToRgb(color)));
  }

  /**
   * Lane changes are relative: tell the car it is at the center (offset 0), then ask it
   * to move `delta` mm sideways (negative = left). `hard` swerves fast, for shoving.
   */
  shiftLane(delta: number, hard = false): void {
    if (this.state.targetSpeed < MIN_LANE_SPEED) this.setSpeed(MIN_LANE_SPEED);
    const d = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, delta));
    this.send(Msg.setOffsetFromCenter(0));
    this.send(hard ? Msg.changeLane(1000, 15000, d, 1, this.laneTag) : Msg.changeLane(600, 8000, d, 1, this.laneTag));
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
      case 'transition':
        if (!this.state.onTrack) this.update({ onTrack: true });
        break;
      case 'status':
        this.update({ onTrack: msg.onTrack, onCharger: msg.onCharger, lowBattery: msg.lowBattery, chargedBattery: msg.chargedBattery });
        break;
      case 'delocalized':
        this.update({ onTrack: false, speed: 0 });
        break;
    }
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  private update(patch: Partial<CarState>): void {
    Object.assign(this.state, patch);
    this.dispatchEvent(new Event('change'));
  }
}

const NAMES_KEY = 'overdrive.carnames';

/** Names of the cars this browser has seen, by device id (the browser keeps a car's id). */
function loadNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function savedName(id: string): string | undefined {
  return loadNames()[id];
}

function savedNames(patch: Record<string, string>): void {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify({ ...loadNames(), ...patch }));
  } catch {
    /* storage blocked: the name lasts until the page closes */
  }
}

function carName(tr: Transport): string {
  const saved = savedName(tr.id);
  if (saved) return saved;
  if (tr.modelId !== undefined && MODEL_NAMES[tr.modelId]) return MODEL_NAMES[tr.modelId];
  // Cars advertise a name like "Drive" followed by garbage bytes on some phones.
  const clean = tr.deviceName.replace(/[^\x20-\x7e]/g, '').trim();
  return clean || t('Coche', 'Car');
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
