import { Cockpit, REPEAT_KEYS, keyAction, vibrate } from './cockpit';
import { h, icon } from './dom';
import { Gamepads } from './gamepad';
import { MapView } from './mapview';
import { joinRoom, normalizeCode } from './net';
import { RaceStrip } from './racestrip';
import { awardsList } from './screens';
import { GuestSession, guestModel, type GuestEvent, type RaceSummary } from './remote';
import { errText, keepAwake, showToast, toastElement } from './shell';
import { SimTransport } from './sim';
import { TiltSteer } from './tilt';
import { sound, type SoundName } from './sound';
import { bluetoothAvailable, pickCar, sleep, type Transport } from './transport';

/**
 * A guest phone: joins a host's game (from the QR link ?join=CODE), connects its own car and
 * drives it. The host runs the race; this phone bridges its car and shows what the host sends.
 */

type Stage = 'joining' | 'joined' | 'driving' | 'closed' | 'error';

export function startGuest(rawCode: string, demo: boolean): void {
  const code = normalizeCode(rawCode);
  let stage: Stage = 'joining';
  let error = '';
  let session: GuestSession | undefined;
  let transport: Transport | undefined;
  let cockpit: Cockpit | undefined;
  let standingsOpen = false;

  const app = document.getElementById('app')!;
  const main = h('main', { class: 'stage stage-stack' });
  const strip = new RaceStrip(() => openSheet(), 'Esperando a que el anfitrión empiece la carrera');
  const sheet = h('dialog', { class: 'sheet', 'aria-label': 'Clasificación' });
  const map = new MapView(() => (cockpit ? cockpit.model.map() : { turns: [], cars: () => [] }));

  app.append(
    h('header', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), 'Overdrive', h('em', {}, ' invitado')]),
      h('div', { class: 'top-actions' }, [
        h('span', { class: 'room-tag', title: 'Código de la partida' }, `📱 ${code.toUpperCase()}`),
        h('button', { class: 'btn btn-stop', onclick: () => session?.control.brake(), title: 'Frenar mi coche (Esc)' }, 'STOP'),
      ]),
    ]),
    main,
    toastElement(),
    sheet,
  );

  async function join(): Promise<void> {
    stage = 'joining';
    render();
    try {
      const ch = await joinRoom(code);
      session = new GuestSession(ch);
      session.addEventListener('snap', onSnapshot);
      session.addEventListener('event', (e) => play((e as CustomEvent<GuestEvent>).detail));
      session.addEventListener('drop', () => {
        void transport?.disconnect();
        transport = undefined;
        stage = 'closed';
        error = 'El anfitrión ha quitado tu coche de la partida.';
        render();
      });
      session.addEventListener('close', () => {
        if (stage === 'closed') return;
        stage = 'closed';
        error = 'Se perdió la conexión con el anfitrión.';
        render();
      });
      stage = transport ? 'driving' : 'joined';
      if (transport) session.attachCar(transport);
    } catch (e) {
      stage = 'error';
      error = errText(e);
    }
    render();
  }

  async function connectCar(): Promise<void> {
    sound.unlock();
    // This tap is our chance to get the motion sensor for tilt steering during the race.
    TiltSteer.prime();
    let t: Transport;
    // Groundshock, Nuke or Guardian: not the models the host's demo starts with.
    if (demo) t = new SimTransport([8, 11, 12][Math.floor(Math.random() * 3)]);
    else {
      try {
        t = await pickCar();
      } catch (e) {
        if (!/cancel/i.test(errText(e))) showToast(errText(e));
        return;
      }
    }
    try {
      await t.connect();
    } catch (e) {
      showToast(`No se pudo conectar el coche: ${errText(e)}`);
      return;
    }
    transport = t;
    session!.attachCar(t);
    // When the car drops, tell the host (attachCar did) and try to get it back.
    const told = t.onDisconnect;
    t.onDisconnect = () => {
      told();
      void reconnectCar();
    };
    stage = 'driving';
    void keepAwake(true);
    render();
  }

  async function reconnectCar(): Promise<void> {
    const t = transport;
    if (!t || !session) return;
    for (let i = 0; i < 3; i++) {
      await sleep(1000 * (i + 1));
      try {
        await t.connect();
        session.announceCar();
        return;
      } catch {
        /* try again */
      }
    }
    showToast('No se pudo reconectar tu coche');
  }

  function leave(): void {
    session?.leave();
    location.href = location.pathname + (demo ? '?demo' : '');
  }

  function play(e: GuestEvent): void {
    if (e.k === 'toast') showToast(e.m);
    else if (e.k === 'buzz') vibrate(e.p);
    else if (e.k === 'sfx' && typeof sound[e.n as SoundName] === 'function') sound[e.n as SoundName]();
  }

  function onSnapshot(): void {
    if (stage !== 'driving') return;
    // While racing, only the controls (and tilt steering on a phone).
    const phase = session?.snap?.race.phase;
    cockpit?.setRaceMode(phase === 'countdown' || phase === 'running');
    cockpit?.update();
    renderStrip();
    if (standingsOpen) renderSheet();
  }

  function render(): void {
    if (stage !== 'driving') {
      cockpit?.destroy();
      cockpit = undefined;
    }
    if (stage === 'joining') {
      main.replaceChildren(card([h('div', { class: 'spinner' }), h('p', {}, `Uniéndote a la partida ${code.toUpperCase()}…`)]));
    } else if (stage === 'error' || stage === 'closed') {
      main.replaceChildren(
        card([
          h('p', { class: 'warn' }, error),
          h('div', { class: 'empty-actions' }, [
            h('button', { class: 'btn btn-primary', onclick: () => void join() }, 'Volver a unirme'),
            h('a', { class: 'btn btn-ghost', href: location.pathname + (demo ? '?demo' : '') }, 'Ir a la app normal'),
          ]),
        ]),
      );
    } else if (stage === 'joined') {
      const supported = demo || bluetoothAvailable();
      main.replaceChildren(
        card([
          h('h1', {}, '¡Dentro de la partida!'),
          h('p', {}, supported ? 'Enciende tu coche, ponlo en la pista y conéctalo. Lo conducirás desde este móvil.' : 'Este navegador no tiene Bluetooth. Usa Chrome o Edge (en iPhone, Bluefy).'),
          supported ? h('button', { class: 'btn btn-primary btn-lg', onclick: () => void connectCar() }, [icon('bluetooth'), demo ? 'Añadir coche simulado' : 'Conectar mi coche']) : null,
        ]),
      );
    } else if (stage === 'driving' && session && !cockpit) {
      cockpit = new Cockpit(guestModel(session, { padName, reconnect: () => void reconnectCar(), leave, toast: showToast }));
      main.replaceChildren(strip.el, cockpit.el);
      cockpit.update();
      renderStrip();
    }
  }

  function renderStrip(): void {
    strip.update(session?.snap?.race);
  }

  function openSheet(): void {
    standingsOpen = true;
    sheet.showModal();
    renderSheet();
  }
  sheet.addEventListener('close', () => (standingsOpen = false));

  function renderSheet(): void {
    const r = session?.snap?.race;
    if (!r) return;
    map.update();
    sheet.replaceChildren(
      h('div', { class: 'sheet-head' }, [h('h2', {}, raceTitle(r)), h('button', { class: 'btn btn-ghost btn-sm', onclick: () => sheet.close(), 'aria-label': 'Cerrar' }, '✕')]),
      ...(r.awards?.length ? [awardsList(r.awards)] : []),
      h('div', { class: 'sheet-map' }, map.el),
      h(
        'ol',
        { class: 'standings' },
        r.standings.map((s, i) =>
          h('li', { class: s.me ? 'is-me' : '', style: `--car:${s.color}` }, [
            h('span', { class: 'race-pos' }, s.place ? (['🥇', '🥈', '🥉'][s.place - 1] ?? `${s.place}.º`) : `${i + 1}.º`),
            h('span', { class: 'chip-dot' }),
            h('span', { class: 'race-name' }, s.name),
            h('span', { class: 'race-laps' }, s.place ? 'Meta' : r.phase === 'running' ? `${Math.min(s.laps + 1, r.totalLaps)}/${r.totalLaps}` : ''),
            h('span', { class: 'race-time' }, s.best ? `mejor ${(s.best / 1000).toFixed(2)} s` : ''),
          ]),
        ),
      ),
    );
  }

  // ---- Gamepad and keyboard drive this phone's car ----------------------------------
  const pads = new Gamepads({
    carFor: () => (session?.control.ready ? session.control : undefined),
    fire: (_car, id) => session?.act({ a: 'fire', v: id }),
    start: () => showToast('La carrera la empieza el anfitrión'),
    stopAll: () => session?.control.brake(),
    notify: (msg) => {
      showToast(msg);
      cockpit?.update();
    },
  });

  function padName(): string | undefined {
    const pad = pads.list()[0];
    return pad && `Mando ${pad.index + 1} (${pad.name})`;
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat && !REPEAT_KEYS.includes(e.code)) return;
    if (e.target instanceof HTMLInputElement || !session) return;
    if (e.code === 'Escape') return session.control.brake();
    const action = keyAction(e.code, session.control, (id) => session!.act({ a: 'fire', v: id }));
    if (action && session.control.ready) {
      e.preventDefault();
      action();
    }
  });

  void join();
}

function card(children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'empty' }, children);
}

function raceTitle(r: RaceSummary): string {
  if (r.phase === 'running') return `Carrera · ${r.totalLaps} ${r.totalLaps === 1 ? 'vuelta' : 'vueltas'}`;
  if (r.phase === 'finished') return 'Carrera terminada';
  if (r.phase === 'countdown') return 'Preparados…';
  return 'Carrera';
}
