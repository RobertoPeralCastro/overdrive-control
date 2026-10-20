import qrcode from 'qrcode-generator';
import { Battle, WEAPONS, type FireDetail, type WeaponId } from './battle';
import { Car } from './car';
import { Cockpit, REPEAT_KEYS, keyAction, targetText, vibrate, type CockpitModel, type CombatView } from './cockpit';
import { h, icon } from './dom';
import { Field } from './field';
import { Gamepads } from './gamepad';
import { fieldCars, fieldSource } from './mapview';
import { joinUrl, normalizeCode, openRoom, type Channel, type Room } from './net';
import { Race, type Entry } from './race';
import { RaceView } from './raceview';
import { GuestLink, type Action, type GuestEvent, type RaceSummary, type RemoteTransport, type Snapshot } from './remote';
import { errText, keepAwake, showToast, toastElement } from './shell';
import { SimTransport } from './sim';
import { sound, type SoundName } from './sound';
import { describeTrack } from './track';
import { bluetoothAvailable, pickCar, type Transport } from './transport';

/**
 * The host phone: connects cars, runs weapons, races and the AI, and can invite other phones
 * whose players drive their own cars (see remote.ts).
 */

const demo = new URLSearchParams(location.search).has('demo');
/** Guests get a fresh snapshot this often. */
const SNAPSHOT_MS = 100;

const cars: Car[] = [];
const field = new Field();
const battle = new Battle(field);
const race = new Race(battle);
const links: GuestLink[] = [];
let room: Room | undefined;
let selected: Car | undefined;
/** The race screen is showing instead of a car's cockpit. */
let raceScreen = false;

const app = document.getElementById('app')!;
const garage = h('nav', { class: 'garage', 'aria-label': 'Coches conectados' });
const stage = h('main', { class: 'stage' });
const invite = h('dialog', { class: 'sheet', 'aria-label': 'Jugar con otro móvil' });

app.append(
  h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), 'Overdrive', h('em', {}, ' control')]),
    h('div', { class: 'top-actions' }, [
      h('button', { class: 'btn btn-ghost', onclick: openInvite, title: 'Jugar con otro móvil', 'aria-label': 'Jugar con otro móvil' }, '📱'),
      h('button', { class: 'btn btn-ghost', onclick: addCar, title: 'Buscar y conectar un coche', 'aria-label': 'Conectar un coche' }, [icon('plus'), h('span', { class: 'btn-label' }, 'Coche')]),
      h('button', { class: 'btn btn-stop', onclick: stopAll, title: 'Frenar todos los coches (Esc)' }, 'STOP'),
    ]),
  ]),
  garage,
  stage,
  toastElement(),
  invite,
);

// ---- Cars -----------------------------------------------------------------

async function addCar(): Promise<void> {
  let transport: Transport;
  if (demo || !bluetoothAvailable()) {
    if (!demo) return showToast('Este navegador no tiene Bluetooth. Usa Chrome o Edge.');
    transport = new SimTransport();
  } else {
    try {
      transport = await pickCar();
    } catch (e) {
      console.error('requestDevice failed', e);
      // Chrome uses NotFoundError both for "picker closed" and "no adapter", so look at the message.
      if (/cancel/i.test(errText(e))) return;
      if (/adapter/i.test(errText(e))) return showToast('Chrome no encuentra el Bluetooth del equipo. Revisa que esté encendido.');
      showToast(errText(e));
      return;
    }
  }

  const existing = cars.find((c) => c.id === transport.id);
  if (existing) {
    select(existing);
    if (existing.state.status === 'disconnected') void existing.connect().catch(() => {});
    return;
  }
  const car = register(transport);
  select(car);
  try {
    await car.connect();
    vibrate(30);
  } catch (e) {
    showToast(`No se pudo conectar: ${errText(e)}`);
  }
}

function register(transport: Transport): Car {
  const car = new Car(transport);
  cars.push(car);
  battle.add(car);
  car.addEventListener('change', () => onCarChange(car));
  void keepAwake(true);
  return car;
}

function removeCar(car: Car): void {
  if (!cars.includes(car)) return;
  void car.disconnect();
  cars.splice(cars.indexOf(car), 1);
  battle.remove(car);
  if (selected === car) selected = cars[0];
  if (!cars.length) raceScreen = false;
  render();
  void keepAwake(cars.some((c) => c.state.status !== 'disconnected'));
}

function stopAll(): void {
  if (racing()) race.abort();
  cars.forEach((c) => c.ready && c.brake());
  vibrate([40, 40, 40]);
}

function select(car: Car | undefined): void {
  selected = car;
  raceScreen = false;
  render();
}

function showRace(): void {
  raceScreen = true;
  render();
}

const racing = () => race.phase === 'countdown' || race.phase === 'running';
const isGuestCar = (car: Car) => race.driverOf(car).kind === 'guest';

// ---- Sound and messages, here and on every guest phone ---------------------------

function broadcast(e: GuestEvent): void {
  links.forEach((l) => l.push(e));
}

function sfx(name: SoundName): void {
  sound[name]();
  broadcast({ k: 'sfx', n: name });
}

function announce(msg: string): void {
  showToast(msg);
  broadcast({ k: 'toast', m: msg });
}

/** Vibrates whichever phone is driving `car`. */
function buzz(car: Car, pattern: number[]): void {
  const link = links.find((l) => l.car === car);
  if (link) link.push({ k: 'buzz', p: pattern });
  else if (car === selected) vibrate(pattern);
}

// ---- Battle ---------------------------------------------------------------------

/** `local`: fired from this phone, so give feedback here. */
function fire(car: Car, id: WeaponId, local = true): void {
  if (local) sound.unlock();
  const r = battle.fire(car, id);
  if (!r.ok) {
    if (!local) return;
    if (r.reason === 'Sin energía') sound.empty();
    if (r.reason !== 'Recargando') showToast(r.reason);
    return;
  }
  if (local) vibrate(id === 'blaster' ? 15 : 40);
}

function scanTrack(car: Car): void {
  if (!car.ready || racing()) return;
  field.scan(car);
  announce(`${car.state.name} está escaneando la pista: dará una vuelta y frenará`);
}

function startRace(): void {
  sound.unlock();
  const why = race.blocker(cars);
  if (why) return showToast(why);
  race.start(cars);
  showRace();
}

const WEAPON_SOUNDS: Record<WeaponId, SoundName> = { blaster: 'laser', missile: 'missile', pulse: 'pulse', shield: 'shield' };

field.addEventListener('track', () => announce(`Pista escaneada: ${describeTrack(field.lap!)}`));
field.addEventListener('scanfail', () => announce('No se pudo escanear la pista. Comprueba que el coche está sobre ella.'));
battle.addEventListener('change', () => {
  cockpit?.updateBattle();
  raceView?.update();
});
battle.addEventListener('fire', (e) => {
  const { shooter, weapon, hits } = (e as CustomEvent<FireDetail>).detail;
  sfx(WEAPON_SOUNDS[weapon.id]);
  // Let the shot be heard before the impact.
  setTimeout(() => {
    if (hits.some((hit) => hit.knockedOut)) sfx('knockout');
    else if (hits.some((hit) => !hit.blocked)) sfx('hit');
    else if (hits.length) sfx('blocked');
  }, weapon.id === 'missile' ? 350 : 120);
  if (!hits.length) return;
  const text = hits
    .map((hit) => `${hit.target.state.name}${hit.knockedOut ? ' ¡fuera de combate!' : hit.blocked ? ' (bloqueado por escudo)' : ''}`)
    .join(', ');
  announce(`${weapon.name} de ${shooter.state.name} → ${text}`);
  hits.filter((hit) => !hit.blocked).forEach((hit) => buzz(hit.target, [80, 40, 80]));
});
battle.start();

race.addEventListener('change', () => {
  raceView?.update();
  cockpit?.updateBattle();
});
race.addEventListener('light', () => sfx('light'));
race.addEventListener('go', () => {
  sfx('go');
  cars.forEach((c) => buzz(c, [200]));
});
race.addEventListener('lap', (e) => {
  const entry = (e as CustomEvent<Entry>).detail;
  if (entry.laps === race.totalLaps - 1) {
    sfx('finalLap');
    announce(`¡Última vuelta para ${entry.car.state.name}!`);
  } else sfx('lap');
});
race.addEventListener('finish', (e) => {
  const entry = (e as CustomEvent<Entry>).detail;
  if (entry.place === 1) {
    sfx('win');
    announce(`🏆 ¡${entry.car.state.name} gana la carrera!`);
  } else {
    sfx('finish');
    announce(`${entry.car.state.name} llega en ${entry.place}.ª posición`);
  }
});

// ---- What a cockpit shows, for this phone or a guest -------------------------------

function combatOf(car: Car): CombatView | undefined {
  const f = battle.fighter(car);
  if (!f) return undefined;
  const now = field.now();
  return {
    armor: f.armor,
    energy: f.energy,
    downMs: Math.max(0, f.downUntil - now),
    shielded: f.shieldUntil > now,
    cooling: Object.fromEntries(WEAPONS.map((w) => [w.id, Math.max(0, f.readyAt[w.id] - now) / w.cooldownMs])) as CombatView['cooling'],
  };
}

function targetOf(car: Car): { text: string; hot: boolean } {
  const f = battle.fighter(car);
  const down = f && f.downUntil > field.now();
  const target = battle.targetFor(car);
  let text: string;
  if (down) text = `¡Fuera de combate! ${Math.ceil((f.downUntil - field.now()) / 1000)} s`;
  else if (field.scanning === car) text = 'Escaneando pista…';
  else if (race.isAi(car)) text = 'Conduce la IA';
  else text = targetText(target && { name: target.car.state.name, pieces: target.pieces }, cars.length > 1);
  return { text: `${text}${f?.kills ? ` · Derribos: ${f.kills}` : ''}`, hot: !!target && !down };
}

function trackOf(car: Car): { text: string; canScan: boolean; rescan: boolean } {
  return {
    text: field.lap ? `Pista: ${describeTrack(field.lap)}` : field.scanning ? 'Escaneando pista…' : 'Pista sin escanear',
    canScan: car.ready && !field.scanning && !racing(),
    rescan: !!field.lap,
  };
}

function hostModel(car: Car): CockpitModel {
  return {
    car,
    state: () => car.state,
    combat: () => combatOf(car),
    target: () => targetOf(car),
    track: () => trackOf(car),
    padName: () => padDriving(car),
    map: () => fieldSource(field, { cars: () => cars, scan: scanTrack, me: car }),
    fire: (id) => fire(car, id),
    scan: () => scanTrack(car),
    reconnect: () => void car.connect().catch((e) => showToast(errText(e))),
    remove: () => removeCar(car),
    removeLabel: 'Desconectar',
    toast: showToast,
  };
}

function raceSummary(me: Car): RaceSummary {
  const entries = race.entries.size ? race.standings() : cars.map((car) => ({ car, laps: 0, lapTimes: [] as number[], place: undefined }));
  return {
    phase: race.phase,
    lights: race.lights,
    totalLaps: race.totalLaps,
    weapons: battle.enabled,
    standings: entries.map((e) => ({
      name: e.car.state.name,
      color: e.car.state.color,
      laps: e.laps,
      place: e.place,
      best: e.lapTimes.length ? Math.min(...e.lapTimes) : undefined,
      me: e.car === me,
    })),
    winner: race.winner()?.car.state.name,
  };
}

function snapshotFor(car: Car, events: GuestEvent[]): Snapshot {
  return {
    car: { ...car.state },
    combat: combatOf(car),
    target: targetOf(car),
    track: trackOf(car),
    map: { lap: field.lap, turns: field.turns, scanning: field.scanning?.state.name, cars: fieldCars(field, car) },
    race: raceSummary(car),
    events,
  };
}

// ---- Guest phones -------------------------------------------------------------------

function onGuest(ch: Channel): void {
  const link = new GuestLink(ch, {
    addCar: (t: RemoteTransport) => {
      const car = register(t);
      race.setDriver(car, { kind: 'guest' });
      void car
        .connect()
        .then(() => announce(`📱 ${car.state.name} se ha unido desde otro móvil`))
        .catch((e) => showToast(`No se pudo conectar el coche del invitado: ${errText(e)}`));
      render();
      // The link only learns its car when this returns.
      queueMicrotask(renderInvite);
      return car;
    },
    act: guestAct,
    left: (l) => {
      links.splice(links.indexOf(l), 1);
      if (l.car) {
        announce(`📱 ${l.car.state.name} ha salido de la partida`);
        removeCar(l.car);
      }
      renderInvite();
    },
  });
  links.push(link);
  renderInvite();
}

function guestAct(car: Car, a: Action): void {
  if (race.isAi(car)) return;
  switch (a.a) {
    case 'speed':
      car.setSpeed(Number(a.v) || 0);
      break;
    case 'accel':
      car.accelerate(typeof a.v === 'number' ? a.v : undefined);
      break;
    case 'decel':
      car.decelerate(typeof a.v === 'number' ? a.v : undefined);
      break;
    case 'brake':
      car.brake();
      break;
    case 'left':
      car.laneLeft();
      break;
    case 'right':
      car.laneRight();
      break;
    case 'uturn':
      car.uTurn();
      break;
    case 'color':
      if (/^#[0-9a-f]{6}$/i.test(a.v)) car.setColor(a.v);
      break;
    case 'fire':
      if (WEAPONS.some((w) => w.id === a.v)) fire(car, a.v, false);
      break;
    case 'scan':
      scanTrack(car);
      break;
  }
}

setInterval(() => links.forEach((l) => l.car && l.sendSnapshot((events) => snapshotFor(l.car!, events))), SNAPSHOT_MS);

let opening = false;
let inviteError: string | undefined;

async function openInvite(): Promise<void> {
  sound.unlock();
  if (!invite.open) invite.showModal();
  renderInvite();
  if (room || opening) return;
  opening = true;
  inviteError = undefined;
  renderInvite();
  try {
    room = await openRoom();
    room.onGuest = onGuest;
  } catch (e) {
    inviteError = errText(e);
  }
  opening = false;
  renderInvite();
}

function renderInvite(): void {
  if (!invite.open) return;
  const url = room && joinUrl(room.code, demo);
  const guests = links.map((l) => h('li', {}, `📱 ${l.car ? `${l.car.state.name} · ${l.car.ready ? 'listo' : 'conectando…'}` : 'Conectado, falta su coche'}`));
  const codeInput = h('input', { class: 'code-input', type: 'text', inputmode: 'text', autocomplete: 'off', placeholder: 'código', maxlength: '8', 'aria-label': 'Código de partida' });
  const join = () => {
    const code = normalizeCode(codeInput.value);
    if (code.length >= 4) location.href = joinUrl(code, demo);
  };
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());

  invite.replaceChildren(
    h('div', { class: 'sheet-head' }, [
      h('h2', {}, 'Jugar con otro móvil'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => invite.close(), 'aria-label': 'Cerrar' }, '✕'),
    ]),
    inviteError
      ? h('div', { class: 'sheet-body' }, [h('p', { class: 'warn' }, inviteError), h('button', { class: 'btn btn-primary', onclick: openInvite }, 'Reintentar')])
      : !room
        ? h('div', { class: 'sheet-body' }, [h('div', { class: 'spinner' }), h('p', {}, 'Creando la partida…')])
        : h('div', { class: 'sheet-body' }, [
            h('p', {}, 'En el otro móvil, escanea este código con la cámara. Se abrirá la app lista para conectar su coche.'),
            qrBox(url!),
            h('p', { class: 'room-code' }, ['Código: ', h('strong', {}, room.code.toUpperCase())]),
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => shareLink(url!) }, 'Compartir enlace'),
            h('ul', { class: 'guest-list' }, guests.length ? guests : [h('li', { class: 'muted' }, 'Aún no se ha unido nadie')]),
            h('p', { class: 'race-hint' }, 'Cada jugador conecta su propio coche desde su móvil. La carrera se maneja desde aquí, en 🏁 Carrera.'),
          ]),
    h('div', { class: 'sheet-join' }, [h('p', {}, '¿Te han invitado a ti? Escribe su código:'), h('div', { class: 'join-row' }, [codeInput, h('button', { class: 'btn btn-primary', onclick: join }, 'Unirse')])]),
  );
}

function qrBox(url: string): HTMLElement {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const box = h('div', { class: 'qr', role: 'img', 'aria-label': 'Código QR para unirse' });
  box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return box;
}

async function shareLink(url: string): Promise<void> {
  try {
    if (navigator.share) await navigator.share({ title: 'Overdrive: únete a mi carrera', url });
    else {
      await navigator.clipboard.writeText(url);
      showToast('Enlace copiado');
    }
  } catch {
    /* share sheet closed */
  }
}

// ---- Gamepads -------------------------------------------------------------------------

/** A pad drives the car assigned to it; a pad without a car of its own drives the car on screen. */
function padCar(index: number): Car | undefined {
  return race.carForPad(index) ?? (selected && race.driverOf(selected).kind === 'screen' ? selected : undefined);
}

/** Name of the pad driving `car`, if one is. */
function padDriving(car: Car): string | undefined {
  const pad = pads.list().find((p) => padCar(p.index) === car);
  return pad && `Mando ${pad.index + 1} (${pad.name})`;
}

const pads = new Gamepads({
  carFor: padCar,
  fire: (car, id) => fire(car as Car, id),
  start: () => (race.phase === 'setup' || race.phase === 'finished' ? startRace() : undefined),
  stopAll,
  notify: (msg) => {
    showToast(msg);
    raceView?.update();
    cockpit?.update();
  },
});

// ---- Rendering --------------------------------------------------------------

let cockpit: Cockpit | undefined;
let cockpitCar: Car | undefined;
let raceView: RaceView | undefined;

function dropCockpit(): void {
  cockpit?.destroy();
  cockpit = undefined;
  cockpitCar = undefined;
}

function render(): void {
  renderGarage();
  if (raceScreen && cars.length) {
    dropCockpit();
    raceView ??= new RaceView({ race, battle, pads, cars: () => cars, scan: scanTrack, start: startRace, toast: showToast });
    if (!raceView.el.isConnected) stage.replaceChildren(raceView.el);
    raceView.update();
    return;
  }
  if (!selected) {
    dropCockpit();
    stage.replaceChildren(emptyState());
    return;
  }
  if (cockpitCar !== selected || !cockpit?.el.isConnected) {
    dropCockpit();
    cockpit = new Cockpit(hostModel(selected));
    cockpitCar = selected;
    stage.replaceChildren(cockpit.el);
  }
  cockpit.update();
}

function onCarChange(car: Car): void {
  renderGarage();
  if (cockpitCar === car) cockpit?.update();
  if (isGuestCar(car)) renderInvite();
}

function renderGarage(): void {
  garage.hidden = cars.length === 0;
  garage.replaceChildren(
    h('button', { class: `chip chip-race ${raceScreen ? 'is-active' : ''}`, onclick: showRace, title: 'Pista, carrera e IA (tecla 0)' }, '🏁 Carrera'),
    ...cars.map((car, i) => {
      const s = car.state;
      return h(
        'button',
        {
          class: `chip ${car === selected && !raceScreen ? 'is-active' : ''} is-${s.status}`,
          style: `--car:${s.color}`,
          onclick: () => select(car),
          title: `${s.name}${isGuestCar(car) ? ' (desde otro móvil)' : ''} (tecla ${i + 1})`,
        },
        [
          h('span', { class: 'chip-dot' }),
          h('span', { class: 'chip-name' }, `${isGuestCar(car) ? '📱 ' : ''}${s.name}`),
          s.battery !== undefined ? h('span', { class: 'chip-batt' }, `${s.battery}%`) : null,
        ],
      );
    }),
  );
}

function emptyState(): HTMLElement {
  const supported = bluetoothAvailable() || demo;
  return h('section', { class: 'empty' }, [
    h('div', { class: 'empty-track' }, [h('span', { class: 'empty-car' })]),
    h('h1', {}, demo ? 'Modo demo' : 'Conecta tu coche'),
    supported
      ? h('p', {}, demo
          ? 'Coches simulados para probar los controles sin Bluetooth.'
          : 'Pon el coche en la pista o en el cargador, enciéndelo y pulsa Conectar. Puedes añadir varios coches.')
      : h('p', { class: 'warn' }, [
          'Este navegador no soporta Web Bluetooth. Abre la app en ',
          h('strong', {}, 'Chrome o Edge'),
          ' (Android, Windows, macOS, Linux o ChromeOS). En iPhone usa el navegador ',
          h('strong', {}, 'Bluefy'),
          '.',
        ]),
    h('div', { class: 'empty-actions' }, [
      supported ? h('button', { class: 'btn btn-primary btn-lg', onclick: addCar }, [icon('bluetooth'), demo ? 'Añadir coche simulado' : 'Conectar coche']) : null,
      h('button', { class: 'btn btn-ghost', onclick: openInvite }, '📱 Jugar con otro móvil'),
      demo ? null : h('a', { class: 'btn btn-ghost', href: '?demo' }, 'Probar demo sin coche'),
    ]),
  ]);
}

// ---- Keyboard --------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat && !REPEAT_KEYS.includes(e.code)) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || invite.open) return;
  if (e.code === 'Escape') return stopAll();
  if (e.key === '0' && cars.length) return showRace();
  const n = Number(e.key);
  if (n >= 1 && n <= cars.length) return select(cars[n - 1]);
  const car = selected;
  if (!car?.ready || race.isAi(car) || isGuestCar(car)) return;
  const action = keyAction(e.code, car, (id) => fire(car, id));
  if (action) {
    e.preventDefault();
    action();
  }
});

render();
