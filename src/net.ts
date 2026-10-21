/**
 * Phone-to-phone link for multiplayer. Uses WebRTC through PeerJS: its free public server only
 * introduces the two phones, then the data goes straight between them.
 * Everything above this file talks to a plain `Channel`, so tests can use an in-memory pair.
 */

import { t } from './i18n';

export interface Channel {
  send(msg: unknown): void;
  onMessage: (msg: unknown) => void;
  onClose: () => void;
  close(): void;
}

/** Rooms are PeerJS ids with this prefix plus a short code people can type. */
const ID_PREFIX = 'ovd-ctrl-';
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 5;

export function newRoomCode(random: () => number = Math.random): string {
  return Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(random() * CODE_CHARS.length)]).join('');
}

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Link to open the app as a guest of `code` (what the QR holds). */
export function joinUrl(code: string, demo = false): string {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('join', code);
  if (demo) url.searchParams.set('demo', '');
  return url.toString().replace('demo=', 'demo');
}

export interface Room {
  code: string;
  /** Called for each phone that joins. */
  onGuest: (ch: Channel) => void;
  close(): void;
}

type PeerModule = typeof import('peerjs');
let peerModule: Promise<PeerModule> | undefined;
/** PeerJS is only downloaded when someone actually plays multiplayer. */
const loadPeer = () => (peerModule ??= import('peerjs'));

type DataConnection = import('peerjs').DataConnection;

function wrap(conn: DataConnection): Channel {
  const ch: Channel = {
    send: (msg) => {
      if (conn.open) void conn.send(msg);
    },
    onMessage: () => {},
    onClose: () => {},
    close: () => conn.close(),
  };
  conn.on('data', (d) => ch.onMessage(d));
  conn.on('close', () => ch.onClose());
  conn.on('error', () => ch.onClose());
  return ch;
}

/** Opens a room on this phone (the host). */
export async function openRoom(): Promise<Room> {
  const { Peer } = await loadPeer();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = newRoomCode();
    const peer = new Peer(ID_PREFIX + code);
    const ok = await new Promise<boolean>((resolve, reject) => {
      peer.on('open', () => resolve(true));
      peer.on('error', (e) => (e.type === 'unavailable-id' ? resolve(false) : reject(new Error(peerError(e.type)))));
    });
    if (!ok) {
      peer.destroy();
      continue;
    }
    const room: Room = { code, onGuest: () => {}, close: () => peer.destroy() };
    peer.on('connection', (conn) => conn.on('open', () => room.onGuest(wrap(conn))));
    // Stay reachable if the signalling server drops us (phones going to sleep, network changes).
    peer.on('disconnected', () => !peer.destroyed && peer.reconnect());
    return room;
  }
  throw new Error(t('No se pudo crear la sala, inténtalo otra vez', "Couldn't create the room, try again"));
}

/** Joins the room `code` from this phone (a guest). */
export async function joinRoom(code: string): Promise<Channel> {
  const { Peer } = await loadPeer();
  const peer = new Peer();
  await new Promise<void>((resolve, reject) => {
    peer.on('open', () => resolve());
    peer.on('error', (e) => reject(new Error(peerError(e.type))));
  });
  const conn = peer.connect(ID_PREFIX + normalizeCode(code), { reliable: true, serialization: 'json' });
  return new Promise<Channel>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('El anfitrión no responde. Revisa el código.', "The host isn't answering. Check the code."))), 15_000);
    conn.on('open', () => {
      clearTimeout(timer);
      const ch = wrap(conn);
      const close = ch.close;
      ch.close = () => {
        close();
        peer.destroy();
      };
      resolve(ch);
    });
    peer.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(peerError(e.type)));
    });
  });
}

function peerError(type: string): string {
  if (type === 'peer-unavailable') return t('No existe esa partida (¿código mal escrito o el anfitrión la cerró?)', 'That game doesn’t exist (wrong code, or the host closed it?)');
  if (type === 'network' || type === 'server-error' || type === 'socket-error') return t('Sin conexión con el servidor de emparejamiento', 'No connection to the matchmaking server');
  if (type === 'browser-incompatible') return t('Este navegador no permite conexiones entre móviles', 'This browser doesn’t allow phone-to-phone connections');
  return t(`Error de conexión (${type})`, `Connection error (${type})`);
}

/** Two connected channels in memory, for tests. */
export function memoryPair(): [Channel, Channel] {
  const make = (): Channel => ({ send: () => {}, onMessage: () => {}, onClose: () => {}, close: () => {} });
  const a = make();
  const b = make();
  let open = true;
  // JSON round trip so tests catch anything that would not survive the real wire.
  a.send = (m) => open && queueMicrotask(() => b.onMessage(JSON.parse(JSON.stringify(m))));
  b.send = (m) => open && queueMicrotask(() => a.onMessage(JSON.parse(JSON.stringify(m))));
  a.close = b.close = () => {
    if (!open) return;
    open = false;
    a.onClose();
    b.onClose();
  };
  return [a, b];
}
