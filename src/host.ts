import qrcode from 'qrcode-generator';
import { Battle, WEAPONS, type FireDetail, type WeaponId } from './battle';
import { Car, carPlace, type CarPlace } from './car';
import { Cockpit, REPEAT_KEYS, keyAction, targetText, vibrate, type CockpitModel, type CombatView } from './cockpit';
import { h } from './dom';
import { Field } from './field';
import { Gamepads } from './gamepad';
import { MapView, fieldCars, fieldSource } from './mapview';
import { joinUrl, normalizeCode, openRoom, type Channel, type Room } from './net';
import { LIGHTS, Race, type Entry } from './race';
import { avatarFor } from './avatars';
import { CampaignRun, LEVELS, type Level } from './campaign';
import { RaceHud, type HudModel } from './hud';
import { CampaignScreen, CarsScreen, HomeScreen, TrackScreen, awardsList, standingsList, type ScreenDeps } from './screens';
import { GuestLink, type Action, type GuestEvent, type RaceSummary, type RemoteTransport, type Snapshot } from './remote';
import { browserBanner, errText, goLandscape, keepAwake, leaveLandscape, showToast, toastElement } from './shell';
import { SimTransport } from './sim';
import { RaceRecorder, loadRecords } from './stats';
import { TiltSteer } from './tilt';
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
/** Top speed, time in the lead… per race, and every car's record saved on this phone. */
const recorder = new RaceRecorder(race, battle);
recorder.addEventListener('awards', () => {
  if (recorder.awards.length) announce(recorder.awards.map((a) => `${a.icon} ${a.title}: ${a.car.state.name}`).join(' · '));
  render();
});
const links: GuestLink[] = [];
let room: Room | undefined;

/**
 * Menu → Garaje (cars) / Preparar carrera (track) / Campaña → Carrera (race).
 * "drive" is free driving one car outside a race.
 */
type Screen = 'home' | 'cars' | 'track' | 'campaign' | 'race' | 'drive';
let screen: Screen = 'home';
/** The car being driven freely (screen "drive"). */
let driving: Car | undefined;

const app = document.getElementById('app')!;
const titleText = h('h1', { class: 'screen-title' });
const titlebar = h('div', { class: 'titlebar' }, [h('button', { class: 'back', onclick: () => goBack(), 'aria-label': 'Atrás' }, '‹'), titleText]);
const trophies = h('span', { class: 'trophies', title: 'Victorias en este móvil' });
const stage = h('main', { class: 'stage stage-stack' });
const invite = h('dialog', { class: 'sheet', 'aria-label': 'Jugar con otro móvil' });
const standingsSheet = h('dialog', { class: 'sheet', 'aria-label': 'Clasificación' });

app.append(
  h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), 'Overdrive']),
    h('div', { class: 'top-actions' }, [
      trophies,
      h('button', { class: 'btn btn-ghost', onclick: openInvite, title: 'Jugar con otro móvil', 'aria-label': 'Jugar con otro móvil' }, '📱'),
      h('button', { class: 'btn btn-stop', onclick: stopAll, title: 'Frenar todos los coches (Esc)' }, 'STOP'),
    ]),
  ]),
  ...[browserBanner(demo || bluetoothAvailable())].filter((x): x is HTMLElement => !!x),
  titlebar,
  stage,
  toastElement(),
  invite,
  standingsSheet,
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
    if (existing.state.status === 'disconnected') void existing.connect().catch(() => {});
    return;
  }
  const car = register(transport);
  render();
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
  if (driving === car) {
    driving = undefined;
    if (screen === 'drive') screen = 'cars';
  }
  render();
  void keepAwake(cars.some((c) => c.state.status !== 'disconnected'));
}

function stopAll(): void {
  if (racing()) {
    race.abort();
    finishCampaign();
    campaign = undefined;
  }
  cars.forEach((c) => c.ready && c.brake());
  vibrate([40, 40, 40]);
}

function go(to: Screen): void {
  if (to === 'race' && race.phase === 'setup') to = 'track';
  if (to !== 'race') leaveLandscape();
  screen = to;
  render();
}

/** Free driving outside a race (from the cars screen). */
function drive(car: Car): void {
  // The AI drives its cars during a race: there is nothing to steer.
  if (race.isAi(car)) return showToast(`${car.state.name} lo conduce la IA durante la carrera`);
  driving = car;
  go('drive');
}

/** Whether one of `list` will be driven on this screen in the next race. */
function myRacerFor(list: Car[]): Car | undefined {
  return list.find((c) => c.ready && race.driverOf(c).kind === 'screen');
}

/** The racing car this phone drives (on screen first, else with one of its pads), if any. */
function myRacer(): Car | undefined {
  const mine = (kind: string) => cars.find((c) => race.entries.has(c) && race.driverOf(c).kind === kind && c.ready);
  return mine('screen') ?? mine('pad');
}

/** The car whose controls are on screen right now. */
function shownCar(): Car | undefined {
  if (screen === 'drive') return driving;
  if (screen === 'race') return myRacer();
  return undefined;
}

const racing = () => race.live;
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
  else if (car === shownCar()) vibrate(pattern);
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
  // A free race: no level being played.
  finishCampaign();
  campaign = undefined;
  sound.unlock();
  // This tap is our chance to get the motion sensor for tilt steering once the race starts,
  // and to go full screen in landscape: the phone is held like a steering wheel.
  TiltSteer.prime();
  const why = race.blocker(cars);
  if (why) return showToast(why);
  if (myRacerFor(cars)) void goLandscape();
  race.start(cars);
  announce('Los coches van a la línea de salida…');
  go('race');
}

const WEAPON_SOUNDS: Record<WeaponId, SoundName> = { blaster: 'laser', missile: 'missile', pulse: 'pulse', shield: 'shield' };

field.addEventListener('track', () => announce(`Pista escaneada: ${describeTrack(field.lap!)}`));
field.addEventListener('scanfail', () => announce('No se pudo escanear la pista. Comprueba que el coche está sobre ella.'));
battle.addEventListener('change', () => {
  cockpit?.updateBattle();
  updateStrip();
  if (screen === 'race' && !cockpit) renderRace();
  if (standingsSheet.open) renderStandings();
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

race.addEventListener('change', () => render());
race.addEventListener('parked', (e) => {
  sfx('lap');
  announce(`${(e as CustomEvent<Car>).detail.state.name} está en la línea de salida`);
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
    awards: race.phase === 'finished' ? recorder.awards.map((a) => ({ icon: a.icon, title: a.title, name: a.car.state.name, value: a.value })) : undefined,
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
  if (race.isAi(car) || race.isLocked(car)) return;
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
            h('p', { class: 'race-hint' }, [
              'Cada jugador conecta su propio coche desde su móvil. La carrera se empieza desde aquí, en Preparar carrera.',
              h('a', { href: 'manual.html#multijugador', target: '_blank', rel: 'noopener' }, 'Ayuda'),
            ]),
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
  const own = race.carForPad(index);
  if (own) return race.isLocked(own) ? undefined : own;
  const car = shownCar();
  if (!car || race.isAi(car) || race.isLocked(car)) return undefined;
  // Not the car another pad or a guest phone drives.
  const kind = race.driverOf(car).kind;
  return kind === 'pad' || kind === 'guest' ? undefined : car;
}

/** Name of the pad driving `car`, if one is. */
function padDriving(car: Car): string | undefined {
  const pad = pads.list().find((p) => padCar(p.index) === car || race.carForPad(p.index) === car);
  return pad && `Mando ${pad.index + 1} (${pad.name})`;
}

const pads = new Gamepads({
  carFor: padCar,
  fire: (car, id) => fire(car as Car, id),
  start: () => (screen === 'track' && !race.blocker(cars) ? startRace() : undefined),
  stopAll,
  notify: (msg) => {
    showToast(msg);
    render();
  },
  pressed: (index) => screen === 'cars' && whichPad(index),
});

/** In the garage, a button on a pad blinks its car, shakes the pad and lights up the car's card. */
const padCalledAt = new Map<number, number>();
function whichPad(index: number): void {
  const now = performance.now();
  if (now - (padCalledAt.get(index) ?? -Infinity) < 1500) return;
  padCalledAt.set(index, now);
  pads.rumble(index);
  const car = race.carForPad(index);
  if (!car) return showToast(`🎮 Mando ${index + 1} sin coche: elígelo como piloto en la tarjeta de un coche`);
  if (car.ready) car.identify();
  carsScreen.highlight(car, `🎮 Mando ${index + 1}`);
  showToast(`🎮 Mando ${index + 1} conduce a ${car.state.name}`);
}

/** «Identificar»: the car blinks, and the pad that drives it shakes. */
function identify(car: Car): void {
  car.identify();
  const d = race.driverOf(car);
  if (d.kind === 'pad') pads.rumble(d.index, 800);
}

// ---- Screens ----------------------------------------------------------------------------

const deps: ScreenDeps = {
  race,
  battle,
  pads,
  demo,
  cars: () => cars,
  isGuestCar,
  addCar: () => void addCar(),
  removeCar,
  drive,
  invite: () => void openInvite(),
  scan: scanTrack,
  start: startRace,
  next: () => go('track'),
  back: () => goBack(),
  campaign: () => go('campaign'),
  garage: () => go('cars'),
  identify,
  playLevel,
};
const homeScreen = new HomeScreen(deps);
const carsScreen = new CarsScreen(deps);
const trackScreen = new TrackScreen(deps);
const campaignScreen = new CampaignScreen(deps);

// ---- Campaign -----------------------------------------------------------------------------

/** The level being played, and what to put back afterwards. */
let campaign: CampaignRun | undefined;
let campaignRestore: (() => void) | undefined;

function playLevel(level: Level): void {
  sound.unlock();
  TiltSteer.prime();
  if (!field.lap) {
    showToast('Antes de la campaña, escanea la pista');
    return go('track');
  }
  const local = cars.filter((c) => c.ready && !isGuestCar(c));
  const player = local.find((c) => ['screen', 'pad'].includes(race.driverOf(c).kind));
  if (!player) return showToast('En el garaje, elige un coche que conduzcas tú (pantalla o mando)');
  const rivals = local.filter((c) => c !== player).slice(0, level.rivals.length);
  if (rivals.length < level.rivals.length) return showToast(`Este nivel necesita ${level.rivals.length + 1} coches conectados`);
  const why = race.blocker(cars);
  if (why) return showToast(why);

  // Set the race up for this level, remembering the player's own settings.
  const before = { laps: race.totalLaps, weapons: battle.enabled, drivers: rivals.map((c) => race.driverOf(c)) };
  campaignRestore = () => {
    race.totalLaps = before.laps;
    battle.enabled = before.weapons;
    rivals.forEach((c, i) => race.setDriver(c, before.drivers[i]));
  };
  race.totalLaps = level.laps;
  battle.enabled = level.weapons;
  rivals.forEach((c, i) => race.setDriver(c, { kind: 'ai', level: level.rivals[i] }));

  campaign?.dispose();
  campaign = new CampaignRun(level, player, rivals, race, battle, recorder);
  campaign.addEventListener('change', () => hud?.update());
  campaign.addEventListener('done', () => {
    const run = campaign!;
    if (race.live) race.end();
    if (run.outcome === 'won') {
      sfx('win');
      announce(`✅ ¡Nivel ${run.level.id} superado!`);
    } else {
      sfx('knockout');
      announce('❌ No lo has conseguido. ¡Inténtalo otra vez!');
    }
    finishCampaign();
    render();
  });
  if (race.driverOf(player).kind === 'screen') void goLandscape();
  race.start([player, ...rivals]);
  announce(`Nivel ${level.id} · ${level.name}: ${level.brief}`);
  go('race');
}

/** Stops following the level and puts the player's settings back (keeps the result on screen). */
function finishCampaign(): void {
  campaign?.dispose();
  campaignRestore?.();
  campaignRestore = undefined;
}

function goalText(): string | undefined {
  return campaign && campaign.outcome === 'playing' ? `Nivel ${campaign.level.id} · ${campaign.progress()}` : undefined;
}

// ---- Rendering ----------------------------------------------------------------------------

let cockpit: Cockpit | undefined;
let cockpitCar: Car | undefined;
/** The racing HUD of this phone's car. */
let hud: RaceHud | undefined;
let hudCar: Car | undefined;
/** Race screen without own controls: the circuit and the standings. */
let raceMap: MapView | undefined;

function updateStrip(): void {
  hud?.update();
}

function dropCockpit(): void {
  cockpit?.destroy();
  cockpit = undefined;
  cockpitCar = undefined;
}

function dropHud(): void {
  hud?.destroy();
  hud = undefined;
  hudCar = undefined;
}

function dropRaceMap(): void {
  raceMap?.destroy();
  raceMap = undefined;
}

function show(...els: HTMLElement[]): void {
  if (els.some((el, i) => stage.children[i] !== el) || stage.children.length !== els.length) stage.replaceChildren(...els);
}

const TITLES: Record<Screen, string> = {
  home: '',
  cars: 'Garaje',
  track: 'Preparar carrera',
  campaign: 'Campaña',
  drive: 'Prueba libre',
  race: 'Carrera',
};

function goBack(): void {
  if (screen === 'drive') return go('cars');
  if (screen === 'race' && race.live) return stopAll();
  go('home');
}

function render(): void {
  if (screen === 'race' && race.phase === 'setup') screen = 'track';
  if (screen === 'drive' && !driving) screen = 'cars';
  if (screen !== 'drive') dropCockpit();
  if (screen !== 'race') {
    dropRaceMap();
    dropHud();
  }
  renderTitle();

  if (screen === 'home') {
    homeScreen.update();
    show(homeScreen.el);
  } else if (screen === 'cars') {
    carsScreen.update();
    show(carsScreen.el);
  } else if (screen === 'track') {
    trackScreen.update();
    show(trackScreen.el);
  } else if (screen === 'campaign') {
    campaignScreen.update();
    show(campaignScreen.el);
  } else if (screen === 'drive') {
    showCockpit(driving!);
  } else {
    renderRace();
  }
}

function renderTitle(): void {
  const wins = Object.values(loadRecords()).reduce((n, r) => n + r.wins, 0);
  trophies.textContent = `🏆 ${wins}`;
  titlebar.hidden = screen === 'home';
  titleText.textContent = screen === 'race' && race.phase === 'finished' ? 'Resultados' : TITLES[screen];
}

function showCockpit(car: Car): void {
  dropRaceMap();
  if (cockpitCar !== car || !cockpit) {
    dropCockpit();
    cockpit = new Cockpit(hostModel(car));
    cockpitCar = car;
  }
  cockpit.setRaceMode(false);
  show(cockpit.el);
  cockpit.update();
}

function hostHud(car: Car): HudModel {
  return {
    ...hostModel(car),
    race: () => raceSummary(car),
    goal: goalText,
    openStandings,
    exit: stopAll,
  };
}

/** Screen 3: this phone's car gets the full-screen HUD; otherwise the circuit; then the podium. */
function renderRace(): void {
  const mine = myRacer();
  if (race.live && mine && !race.entries.get(mine)?.place) {
    dropRaceMap();
    if (hudCar !== mine || !hud) {
      dropHud();
      hud = new RaceHud(hostHud(mine));
      hudCar = mine;
    }
    show(hud.el);
    hud.update();
    return;
  }
  dropHud();
  if (race.phase === 'finished') return renderResults();

  raceMap ??= new MapView(() => fieldSource(field, { cars: () => cars, me: mine }));
  raceMap.update();
  const head = h('header', { class: 'screen-head' });
  if (race.phase === 'grid') head.append(h('h1', {}, 'A la salida'), h('p', {}, `Los coches van a la línea de salida (${race.parked.size}/${race.entries.size}).`));
  else head.append(h('h1', {}, race.phase === 'countdown' ? 'Preparados…' : `Carrera · ${race.totalLaps} ${race.totalLaps === 1 ? 'vuelta' : 'vueltas'}`));
  const lights =
    race.phase === 'countdown'
      ? h('div', { class: 'lights is-on', 'aria-hidden': 'true' }, Array.from({ length: LIGHTS }, (_, i) => h('span', { class: `bulb ${i < race.lights ? 'is-lit' : ''}` })))
      : null;
  stage.replaceChildren(
    h('section', { class: 'screen screen-spectate' }, [
      head,
      h('div', { class: 'track-stage' }, lights ? [raceMap.el, lights] : [raceMap.el]),
      standingsList(race, battle, cars),
      h('footer', { class: 'screen-foot' }, h('button', { class: 'btn btn-stop', onclick: stopAll }, 'Parar carrera')),
    ]),
  );
}

/** The podium, awards and what next. */
function renderResults(): void {
  dropRaceMap();
  const awards = recorder.awards.map((a) => ({ icon: a.icon, title: a.title, name: a.car.state.name, value: a.value }));
  const run = campaign && campaign.outcome !== 'playing' ? campaign : undefined;
  const winner = race.winner();
  const title = run
    ? run.outcome === 'won'
      ? `¡Nivel ${run.level.id} superado!`
      : `Nivel ${run.level.id}: inténtalo otra vez`
    : winner
      ? `¡Gana ${winner.car.state.name}!`
      : 'Carrera terminada';
  const next = run && LEVELS.find((l) => l.id === run.level.id + 1);
  const actions = run
    ? [
        h('button', { class: 'btn btn-ghost', onclick: () => go('campaign') }, 'Campaña'),
        run.outcome === 'won' && next
          ? h('button', { class: 'btn btn-primary btn-lg', onclick: () => playLevel(next) }, `Nivel ${next.id} ›`)
          : h('button', { class: 'btn btn-primary btn-lg', onclick: () => playLevel(run.level) }, 'Reintentar'),
      ]
    : [
        h('button', { class: 'btn btn-ghost', onclick: () => go('home') }, 'Menú'),
        h('button', { class: 'btn btn-primary btn-lg', onclick: startRace }, 'Revancha'),
      ];
  showOnce(
    h('section', { class: `screen results ${run ? (run.outcome === 'won' ? 'is-won' : 'is-lost') : ''}` }, [
      h('header', { class: 'results-head' }, [h('h1', {}, title), run ? h('p', {}, `${run.level.name} · ${run.level.brief}`) : null]),
      podium(),
      awards.length ? awardsList(awards) : null,
      h('footer', { class: 'screen-foot' }, actions),
    ].filter((x): x is HTMLElement => !!x)),
  );
}

/** Puts a rebuilt screen on stage only if it shows something new, so its entry animation plays once. */
function showOnce(el: HTMLElement): void {
  if (stage.children.length === 1 && stage.firstElementChild!.outerHTML === el.outerHTML) return;
  stage.replaceChildren(el);
}

function podium(): HTMLElement {
  const order = race.standings();
  const step = (place: number) => {
    const e = order[place - 1];
    if (!e) return h('div', { class: `podium-step is-p${place} is-empty` });
    const best = e.lapTimes.length ? Math.min(...e.lapTimes) : undefined;
    return h('div', { class: `podium-step is-p${place}`, style: `--car:${e.car.state.color}` }, [
      h('img', { class: 'podium-avatar', src: avatarFor(e.car.id, e.car.state.name, e.car.state.color), alt: '' }),
      h('strong', { class: 'podium-name' }, e.car.state.name),
      h('span', { class: 'podium-time' }, best ? `mejor ${(best / 1000).toFixed(2)} s` : e.place ? '' : 'sin terminar'),
      h('div', { class: 'podium-block' }, h('span', {}, String(place))),
    ]);
  };
  return h('div', { class: 'podium' }, [step(2), step(1), step(3)]);
}

function openStandings(): void {
  if (!standingsSheet.open) standingsSheet.showModal();
  renderStandings();
}

function renderStandings(): void {
  standingsSheet.replaceChildren(
    h('div', { class: 'sheet-head' }, [h('h2', {}, 'Clasificación'), h('button', { class: 'btn btn-ghost btn-sm', onclick: () => standingsSheet.close(), 'aria-label': 'Cerrar' }, '✕')]),
    standingsList(race, battle, cars),
  );
}

/** Where each car was last time, to tell the players when one leaves the track or goes to charge. */
const places = new WeakMap<Car, CarPlace>();

function notePlace(car: Car): void {
  const now = carPlace(car.state);
  const before = places.get(car) ?? 'unknown';
  places.set(car, now);
  if (now === before || now === 'unknown') return;
  const name = car.state.name;
  if (now === 'off') {
    announce(`⚠️ ${name} se ha salido de la pista`);
    buzz(car, [200, 100, 200]);
  } else if (now === 'charger') announce(`🔌 ${name} está en el cargador`);
  else if (before === 'off' || before === 'charger') announce(`✅ ${name} vuelve a estar en la pista`);
}

function onCarChange(car: Car): void {
  notePlace(car);
  if (cockpitCar === car) cockpit?.update();
  if (hudCar === car) hud?.update();
  if (isGuestCar(car)) renderInvite();
  if (screen === 'home') homeScreen.update();
  else if (screen === 'cars') carsScreen.update();
  else if (screen === 'track') trackScreen.update();
}

field.addEventListener('change', () => screen === 'track' && trackScreen.update());

// ---- Keyboard --------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat && !REPEAT_KEYS.includes(e.code)) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || invite.open) return;
  if (e.code === 'Escape') return stopAll();
  const car = shownCar();
  if (!car?.ready || race.isAi(car) || race.isLocked(car) || isGuestCar(car)) return;
  const action = keyAction(e.code, car, (id) => fire(car, id));
  if (action) {
    e.preventDefault();
    action();
  }
});

render();
