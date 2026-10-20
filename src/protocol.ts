/**
 * Anki Overdrive BLE protocol.
 * Ported from OpenOverdrive (core-protocol/VehicleProtocol.kt) and the original Anki drive-sdk.
 * Every packet is: [size][msgId][payload...] where size = 1 + payload length. Little-endian.
 */

export const ANKI_SERVICE = 'be15beef-6186-407e-8381-0bd89c4d8df4';
export const ANKI_READ_CHAR = 'be15bee0-6186-407e-8381-0bd89c4d8df4';
export const ANKI_WRITE_CHAR = 'be15bee1-6186-407e-8381-0bd89c4d8df4';
/** Manufacturer ID used in car advertisements (0xEFBE). Byte[1] of the data is the model ID. */
export const ANKI_COMPANY_ID = 61374;

export const MsgId = {
  C2V_DISCONNECT: 0x0d,
  C2V_PING: 0x16,
  V2C_PING_RESP: 0x17,
  C2V_VERSION_REQ: 0x18,
  V2C_VERSION_RESP: 0x19,
  C2V_BATTERY_REQ: 0x1a,
  V2C_BATTERY_RESP: 0x1b,
  C2V_SET_SPEED: 0x24,
  C2V_CHANGE_LANE: 0x25,
  C2V_CANCEL_LANE: 0x26,
  V2C_LOC_POS: 0x27,
  V2C_LOC_TRANS: 0x29,
  C2V_SET_OFFSET: 0x2c,
  C2V_TURN: 0x32,
  C2V_LIGHTS_PATTERN: 0x33,
  V2C_STATUS: 0x3f,
  C2V_SDK_MODE: 0x90,
} as const;

export const TurnType = { LEFT: 1, RIGHT: 2, UTURN: 3, UTURN_JUMP: 4 } as const;
export const TurnTrigger = { IMMEDIATE: 0, INTERSECTION: 1 } as const;

export const LightChannel = { RED: 0, TAIL: 1, BLUE: 2, GREEN: 3, FRONTL: 4, FRONTR: 5 } as const;
export const LightEffect = { STEADY: 0, FADE: 1, THROB: 2, FLASH: 3, RANDOM: 4 } as const;
/** Firmware caps light intensity at 14. */
export const MAX_LIGHT_INTENSITY = 14;

/** Firmware versions at or above this expect the 7-byte (V4) set-speed payload. */
export const V4_SPEED_MIN_VERSION = 12385;

export const MODEL_NAMES: Record<number, string> = {
  1: 'Kourai',
  2: 'Boson',
  3: 'Rho',
  4: 'Katal',
  5: 'Hadion',
  6: 'Spektrix',
  7: 'Corax',
  8: 'GroundShock',
  9: 'Skull',
  10: 'Thermo',
  11: 'Nuke',
  12: 'Guardian',
  14: 'Bigbang',
  15: 'Freewheel',
};

function packet(msgId: number, payloadLen: number, fill?: (v: DataView) => void): Uint8Array {
  const buf = new Uint8Array(2 + payloadLen);
  buf[0] = 1 + payloadLen;
  buf[1] = msgId;
  if (fill) fill(new DataView(buf.buffer, 2));
  return buf;
}

const simple = (id: number) => packet(id, 0);

export const Msg = {
  sdkMode(on: boolean, flags = 0x01): Uint8Array {
    return packet(MsgId.C2V_SDK_MODE, 2, (v) => {
      v.setUint8(0, on ? 1 : 0);
      v.setUint8(1, flags);
    });
  },

  setSpeed(speedMmps: number, accelMmps2: number, v4 = false, respectLimit = 1): Uint8Array {
    return packet(MsgId.C2V_SET_SPEED, v4 ? 6 : 5, (v) => {
      v.setInt16(0, speedMmps, true);
      v.setInt16(2, accelMmps2, true);
      v.setUint8(4, respectLimit);
      if (v4) v.setUint8(5, 0x01);
    });
  },

  setOffsetFromCenter(offsetMm: number): Uint8Array {
    return packet(MsgId.C2V_SET_OFFSET, 4, (v) => v.setFloat32(0, offsetMm, true));
  },

  changeLane(hSpeedMmps: number, hAccelMmps2: number, offsetMm: number, hopIntent = 0, tag = 0): Uint8Array {
    return packet(MsgId.C2V_CHANGE_LANE, 10, (v) => {
      v.setInt16(0, hSpeedMmps, true);
      v.setInt16(2, hAccelMmps2, true);
      v.setFloat32(4, offsetMm, true);
      v.setUint8(8, hopIntent);
      v.setUint8(9, tag & 0xff);
    });
  },

  turn(type: number, trigger: number = TurnTrigger.IMMEDIATE): Uint8Array {
    return packet(MsgId.C2V_TURN, 2, (v) => {
      v.setUint8(0, type);
      v.setUint8(1, trigger);
    });
  },

  /** Steady engine color. r/g/b are 0..255 and get scaled to the firmware's 0..14 range. */
  engineColor(r: number, g: number, b: number, effect: number = LightEffect.STEADY, cyclesPer10s = 0): Uint8Array {
    const entries: [number, number][] = [
      [LightChannel.RED, r],
      [LightChannel.GREEN, g],
      [LightChannel.BLUE, b],
    ];
    return packet(MsgId.C2V_LIGHTS_PATTERN, 1 + entries.length * 5, (v) => {
      v.setUint8(0, entries.length);
      entries.forEach(([channel, value], i) => {
        const o = 1 + i * 5;
        const level = Math.round((Math.max(0, Math.min(255, value)) / 255) * MAX_LIGHT_INTENSITY);
        v.setUint8(o, channel);
        v.setUint8(o + 1, effect);
        // Non-steady effects (flash, throb) swing from off to `level` cyclesPer10s times every 10 s.
        v.setUint8(o + 2, effect === LightEffect.STEADY ? level : 0);
        v.setUint8(o + 3, level);
        v.setUint8(o + 4, cyclesPer10s);
      });
    });
  },

  batteryRequest: () => simple(MsgId.C2V_BATTERY_REQ),
  versionRequest: () => simple(MsgId.C2V_VERSION_REQ),
  ping: () => simple(MsgId.C2V_PING),
  disconnect: () => simple(MsgId.C2V_DISCONNECT),
  cancelLane: () => simple(MsgId.C2V_CANCEL_LANE),
};

export type VehicleMessage =
  | { type: 'battery'; raw: number; percent: number }
  | { type: 'version'; version: number }
  | { type: 'ping' }
  | { type: 'position'; locationId: number; pieceId: number; offset: number; speed: number }
  | { type: 'transition'; pieceIdx: number; prevPieceIdx: number; offset?: number }
  | { type: 'status'; onTrack: boolean; onCharger: boolean; lowBattery: boolean; chargedBattery: boolean };

/** Some firmware reports millivolts (≈3300..4200), others a plain percentage. */
export function batteryPercent(raw: number): number {
  if (raw >= 2500 && raw <= 5000) return Math.round((Math.max(0, Math.min(900, raw - 3300)) * 100) / 900);
  return Math.max(0, Math.min(100, raw & 0xff));
}

export function parseMessage(data: DataView): VehicleMessage | null {
  if (data.byteLength < 2) return null;
  const size = data.getUint8(0);
  if (size + 1 > data.byteLength) return null;
  const id = data.getUint8(1);
  const remaining = size - 1;
  const at = 2;

  switch (id) {
    case MsgId.V2C_BATTERY_RESP: {
      if (remaining < 2) return null;
      const raw = data.getUint16(at, true);
      return { type: 'battery', raw, percent: batteryPercent(raw) };
    }
    case MsgId.V2C_VERSION_RESP:
      if (remaining < 2) return null;
      return { type: 'version', version: data.getUint16(at, true) };
    case MsgId.V2C_PING_RESP:
      return { type: 'ping' };
    case MsgId.V2C_LOC_POS:
      if (remaining < 8) return null;
      return {
        type: 'position',
        locationId: data.getUint8(at),
        pieceId: data.getUint8(at + 1),
        offset: data.getFloat32(at + 2, true),
        speed: data.getUint16(at + 6, true),
      };
    case MsgId.V2C_LOC_TRANS:
      if (remaining < 2) return null;
      return {
        type: 'transition',
        pieceIdx: data.getInt8(at),
        prevPieceIdx: data.getInt8(at + 1),
        offset: remaining >= 6 ? data.getFloat32(at + 2, true) : undefined,
      };
    case MsgId.V2C_STATUS:
      if (remaining < 4) return null;
      return {
        type: 'status',
        onTrack: (data.getUint8(at) & 1) !== 0,
        onCharger: (data.getUint8(at + 1) & 1) !== 0,
        lowBattery: (data.getUint8(at + 2) & 1) !== 0,
        chargedBattery: (data.getUint8(at + 3) & 1) !== 0,
      };
    default:
      return null;
  }
}
