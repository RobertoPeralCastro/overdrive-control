import type { WeaponId } from './battle';
import type { CarState } from './car';
import type { CockpitModel, CombatView, Drivable } from './cockpit';
import type { MapCar } from './mapview';
import type { Channel } from './net';
import type { Phase } from './race';
import type { SoundName } from './sound';
import type { Turn } from './track';
import { sleep, type Transport } from './transport';

/**
 * Multiplayer over two (or more) phones. The host phone runs the whole game. A guest phone
 * connects its own car by Bluetooth and acts as a bridge: it forwards what the car says to the
 * host and writes to the car whatever the host sends, so on the host that car is just one more
 * Car. The host sends each guest a snapshot of what to show ~10 times a second, and the guest
 * sends back what the player does.
 */

// ---- Messages ---------------------------------------------------------------------

export type Action =
  | { a: 'speed'; v: number }
  | { a: 'accel' | 'decel'; v?: number }
  | { a: 'brake' | 'left' | 'right' | 'uturn' | 'scan' }
  | { a: 'color'; v: string }
  | { a: 'fire'; v: WeaponId };

export type GuestEvent = { k: 'sfx'; n: SoundName } | { k: 'toast'; m: string } | { k: 'buzz'; p: number[] };

export interface RaceSummary {
  phase: Phase;
  lights: number;
  totalLaps: number;
  weapons: boolean;
  standings: { name: string; color: string; laps: number; place?: number; best?: number; me: boolean }[];
  winner?: string;
}

export interface Snapshot {
  car: CarState;
  combat?: CombatView;
  target: { text: string; hot: boolean };
  track: { text: string; canScan: boolean; rescan: boolean };
  map: { lap?: number[]; turns: (Turn | undefined)[]; scanning?: string; cars: MapCar[] };
  race: RaceSummary;
  events: GuestEvent[];
}

type ToHost =
  | { t: 'car'; deviceName: string; modelId?: number }
  | { t: 'ble'; d: number[] }
  | { t: 'gone' }
  | ({ t: 'act' } & Action);

type ToGuest = { t: 'w'; d: number[] } | { t: 'snap'; s: Snapshot } | { t: 'drop' };

// ---- Host side --------------------------------------------------------------------

/** How long the host waits for a guest's car to come back before giving up a reconnect. */
const RELINK_MS = 8000;
let remoteCount = 0;

/** The guest's car, as the host sees it: bytes go over the phone link instead of Bluetooth. */
export class RemoteTransport implements Transport {
  readonly id = `remote-${++remoteCount}`;
  deviceName: string;
  modelId?: number;
  onMessage: (data: DataView) => void = () => {};
  onDisconnect: () => void = () => {};
  onModelId: (id: number) => void = () => {};
  linked = true;
  private waiters: (() => void)[] = [];

  constructor(
    private link: GuestLink,
    info: { deviceName: string; modelId?: number },
  ) {
    this.deviceName = info.deviceName;
    this.modelId = info.modelId;
  }

  async connect(): Promise<void> {
    if (this.linked) return;
    if (this.link.closed) throw new Error('El móvil invitado se ha desconectado');
    const back = new Promise<void>((resolve) => this.waiters.push(resolve));
    await Promise.race([back, sleep(RELINK_MS).then(() => Promise.reject(new Error('El coche del invitado no responde')))]);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.linked) throw new Error('Sin conexión con el móvil invitado');
    this.link.send({ t: 'w', d: [...bytes] });
  }

  async disconnect(): Promise<void> {
    this.link.send({ t: 'drop' });
  }

  /** The guest's car is connected (again). */
  relink(info: { deviceName: string; modelId?: number }): void {
    this.linked = true;
    if (info.modelId !== undefined && info.modelId !== this.modelId) {
      this.modelId = info.modelId;
      this.onModelId(info.modelId);
    }
    this.waiters.splice(0).forEach((w) => w());
  }

  unlink(): void {
    if (!this.linked) return;
    this.linked = false;
    this.onDisconnect();
  }
}

export interface HostHooks {
  /** A guest connected its car: add it to the game and return the Car. */
  addCar(transport: RemoteTransport): import('./car').Car;
  act(car: import('./car').Car, action: Action): void;
  left(link: GuestLink): void;
}

/** One guest phone, on the host. */
export class GuestLink {
  car?: import('./car').Car;
  closed = false;
  private transport?: RemoteTransport;
  private events: GuestEvent[] = [];

  constructor(
    private ch: Channel,
    private hooks: HostHooks,
  ) {
    ch.onMessage = (m) => this.receive(m as ToHost);
    ch.onClose = () => {
      if (this.closed) return;
      this.closed = true;
      this.transport?.unlink();
      hooks.left(this);
    };
  }

  send(msg: ToGuest): void {
    if (!this.closed) this.ch.send(msg);
  }

  /** Queues something for the guest to play or show with the next snapshot. */
  push(e: GuestEvent): void {
    this.events.push(e);
    if (this.events.length > 50) this.events.shift();
  }

  sendSnapshot(build: (events: GuestEvent[]) => Snapshot): void {
    if (!this.car || this.closed) return;
    this.send({ t: 'snap', s: build(this.events.splice(0)) });
  }

  close(): void {
    this.ch.close();
  }

  private receive(m: ToHost): void {
    switch (m.t) {
      case 'car':
        if (!this.transport) {
          this.transport = new RemoteTransport(this, m);
          this.car = this.hooks.addCar(this.transport);
        } else {
          this.transport.relink(m);
        }
        break;
      case 'ble':
        this.transport?.onMessage(new DataView(new Uint8Array(m.d).buffer));
        break;
      case 'gone':
        this.transport?.unlink();
        break;
      case 'act':
        // The extra `t` field does no harm to the action.
        if (this.car) this.hooks.act(this.car, m);
        break;
    }
  }
}

// ---- Guest side ---------------------------------------------------------------------

/** Speed changes from dragging the throttle are sent at most this often. */
const SPEED_EVERY_MS = 50;

/**
 * The guest phone: bridges its Bluetooth car to the host and keeps the latest snapshot.
 * Events: 'snap' after every snapshot, 'event' (detail GuestEvent), 'drop', 'close'.
 */
export class GuestSession extends EventTarget {
  snap?: Snapshot;
  /** performance.now() when the snapshot arrived, to keep map markers moving between them. */
  snapAt = 0;
  closed = false;
  transport?: Transport;
  private writes: Promise<void> = Promise.resolve();
  private speedTimer?: ReturnType<typeof setTimeout>;
  private pendingSpeed?: number;

  /** Remote control of this phone's car, through the host. */
  readonly control: Drivable;

  constructor(private ch: Channel) {
    super();
    const session = this;
    this.control = {
      get ready() {
        return session.snap?.car.status === 'ready' && !session.closed;
      },
      setSpeed: (v) => this.queueSpeed(v),
      accelerate: (v) => this.act({ a: 'accel', v }),
      decelerate: (v) => this.act({ a: 'decel', v }),
      brake: () => {
        this.pendingSpeed = undefined;
        this.act({ a: 'brake' });
      },
      laneLeft: () => this.act({ a: 'left' }),
      laneRight: () => this.act({ a: 'right' }),
      uTurn: () => this.act({ a: 'uturn' }),
      setColor: (c) => this.act({ a: 'color', v: c }),
    };
    ch.onMessage = (m) => this.receive(m as ToGuest);
    ch.onClose = () => {
      this.closed = true;
      this.dispatchEvent(new Event('close'));
    };
  }

  /** Bridges a connected car to the host. */
  attachCar(t: Transport): void {
    this.transport = t;
    t.onMessage = (data) => this.ch.send({ t: 'ble', d: [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)] } satisfies ToHost);
    t.onDisconnect = () => this.ch.send({ t: 'gone' } satisfies ToHost);
    t.onModelId = () => this.announceCar();
    this.announceCar();
  }

  /** Tells the host the car is (again) connected. */
  announceCar(): void {
    if (!this.transport) return;
    this.ch.send({ t: 'car', deviceName: this.transport.deviceName, modelId: this.transport.modelId } satisfies ToHost);
  }

  act(action: Action): void {
    this.ch.send({ t: 'act', ...action } satisfies ToHost);
  }

  leave(): void {
    this.closed = true;
    void this.transport?.disconnect();
    this.ch.close();
  }

  private queueSpeed(v: number): void {
    this.pendingSpeed = v;
    if (this.speedTimer) return;
    const flush = () => {
      this.speedTimer = undefined;
      if (this.pendingSpeed === undefined) return;
      this.act({ a: 'speed', v: this.pendingSpeed });
      this.pendingSpeed = undefined;
      this.speedTimer = setTimeout(flush, SPEED_EVERY_MS);
    };
    flush();
  }

  private receive(m: ToGuest): void {
    switch (m.t) {
      case 'w': {
        const t = this.transport;
        if (!t) return;
        // Web Bluetooth rejects overlapping writes: keep them in order.
        const bytes = new Uint8Array(m.d);
        this.writes = this.writes.then(() => t.write(bytes)).catch(() => {});
        break;
      }
      case 'snap':
        this.snap = m.s;
        this.snapAt = performance.now();
        m.s.events.forEach((e) => this.dispatchEvent(new CustomEvent<GuestEvent>('event', { detail: e })));
        this.dispatchEvent(new Event('snap'));
        break;
      case 'drop':
        this.dispatchEvent(new Event('drop'));
        break;
    }
  }
}

/** Cockpit model for the guest phone: everything comes from the host's snapshot. */
export function guestModel(
  session: GuestSession,
  local: { padName: () => string | undefined; reconnect: () => void; leave: () => void; toast: (m: string) => void },
): CockpitModel {
  const waiting: CarState = { status: 'connecting', name: 'Tu coche', targetSpeed: 0, speed: 0, color: '#0a84ff' };
  return {
    car: session.control,
    state: () => session.snap?.car ?? waiting,
    combat: () => session.snap?.combat,
    target: () => session.snap?.target ?? { text: 'Esperando al anfitrión…', hot: false },
    track: () => session.snap?.track ?? { text: '', canScan: false, rescan: false },
    padName: local.padName,
    map: () => {
      const m = session.snap?.map;
      return {
        lap: m?.lap,
        turns: m?.turns ?? [],
        scanning: m?.scanning,
        // Keep markers sliding between snapshots, as the host does between position reports.
        cars: () => (m?.cars ?? []).map((c) => ({ ...c, inPieceMs: c.inPieceMs + (c.live ? performance.now() - session.snapAt : 0) })),
        scan: m && !m.lap && !m.scanning ? { label: 'Escanear con mi coche', run: () => session.act({ a: 'scan' }) } : undefined,
      };
    },
    fire: (v) => session.act({ a: 'fire', v }),
    scan: () => session.act({ a: 'scan' }),
    reconnect: local.reconnect,
    remove: local.leave,
    removeLabel: 'Salir',
    toast: local.toast,
  };
}
