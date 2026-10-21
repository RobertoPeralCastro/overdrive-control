import { t } from './i18n';
import { ANKI_COMPANY_ID, ANKI_READ_CHAR, ANKI_SERVICE, ANKI_WRITE_CHAR } from './protocol';

/** Byte pipe to one car. The Car class holds all driving logic on top of this. */
export interface Transport {
  readonly id: string;
  readonly deviceName: string;
  modelId?: number;
  onMessage: (data: DataView) => void;
  onDisconnect: () => void;
  onModelId: (id: number) => void;
  connect(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
}

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Opens the browser's device picker filtered to Overdrive cars. Must be called from a user gesture. */
export async function pickCar(): Promise<WebBluetoothTransport> {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [ANKI_SERVICE] }],
    optionalManufacturerData: [ANKI_COMPANY_ID],
  });
  return new WebBluetoothTransport(device);
}

export class WebBluetoothTransport implements Transport {
  modelId?: number;
  onMessage: (data: DataView) => void = () => {};
  onDisconnect: () => void = () => {};
  onModelId: (id: number) => void = () => {};

  private writeChar?: BluetoothRemoteGATTCharacteristic;
  private readChar?: BluetoothRemoteGATTCharacteristic;
  private closing = false;

  constructor(private readonly device: BluetoothDevice) {
    device.addEventListener('gattserverdisconnected', () => {
      if (!this.closing) this.onDisconnect();
    });
  }

  get id(): string {
    return this.device.id;
  }

  get deviceName(): string {
    return this.device.name ?? '';
  }

  async connect(): Promise<void> {
    this.closing = false;
    const server = await withRetry(() => this.device.gatt!.connect(), 3);
    const service = await server.getPrimaryService(ANKI_SERVICE);
    this.readChar = await service.getCharacteristic(ANKI_READ_CHAR);
    this.writeChar = await service.getCharacteristic(ANKI_WRITE_CHAR);
    this.readChar.addEventListener('characteristicvaluechanged', this.handleNotify);
    await withRetry(() => this.readChar!.startNotifications(), 3);
    void this.readModelId();
  }

  async write(bytes: Uint8Array): Promise<void> {
    const c = this.writeChar;
    if (!c) throw new Error(t('No conectado', 'Not connected'));
    const data = bytes as Uint8Array<ArrayBuffer>;
    if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(data);
    else await c.writeValueWithResponse(data);
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.readChar?.removeEventListener('characteristicvaluechanged', this.handleNotify);
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }

  private handleNotify = (ev: Event) => {
    const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (value) this.onMessage(value);
  };

  /**
   * The model (Skull, Thermo...) is only in the advertisement's manufacturer data.
   * watchAdvertisements is not available everywhere, so this is best-effort.
   */
  private async readModelId(): Promise<void> {
    if (typeof this.device.watchAdvertisements !== 'function') return;
    const handler = (ev: BluetoothAdvertisingEvent) => {
      const data = ev.manufacturerData.get(ANKI_COMPANY_ID) ?? ev.manufacturerData.values().next().value;
      if (data && data.byteLength >= 2) {
        this.modelId = data.getUint8(1);
        this.onModelId(this.modelId);
        stop();
      }
    };
    const abort = new AbortController();
    const stop = () => {
      this.device.removeEventListener('advertisementreceived', handler as EventListener);
      abort.abort();
    };
    try {
      this.device.addEventListener('advertisementreceived', handler as EventListener);
      await this.device.watchAdvertisements({ signal: abort.signal });
      setTimeout(stop, 10_000);
    } catch {
      stop();
    }
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
