import { AI_LEVELS, type AiLevel, type AiMove } from './ai';
import { avatarFor, pickAvatar } from './avatars';
import { LEVELS, completedLevels, isUnlocked, type Level } from './campaign';
import type { Battle } from './battle';
import { carPlace, placeText, type Car } from './car';
import { COLORS } from './cockpit';
import { h, icon } from './dom';
import type { Gamepads } from './gamepad';
import { MapView, fieldSource } from './mapview';
import type { Driver, Race } from './race';
import { sound } from './sound';
import { fmtSpeed, fmtTime, recordOf } from './stats';
import { describeTrack } from './track';
import { bluetoothAvailable } from './transport';

/**
 * The host's set-up screens:
 *   1. Coches: connect cars, give each one a picture and a driver (you, a pad, the AI, a guest).
 *   2. Pista: scan the track, pick laps/weapons/sound, start the race.
 * The race itself (screen 3) lives in host.ts because it shows the driving controls.
 */

export interface ScreenDeps {
  race: Race;
  battle: Battle;
  pads: Gamepads;
  demo: boolean;
  cars(): Car[];
  isGuestCar(car: Car): boolean;
  addCar(): void;
  removeCar(car: Car): void;
  drive(car: Car): void;
  invite(): void;
  scan(car: Car): void;
  start(): void;
  next(): void;
  back(): void;
  campaign(): void;
  garage(): void;
  /** Blinks the car and shakes the pad that drives it. */
  identify(car: Car): void;
  playLevel(level: Level): void;
}

// ---- Main menu ----------------------------------------------------------------------------

export class HomeScreen {
  readonly el: HTMLElement;
  private hero: HTMLElement;
  private campaignTile: HTMLButtonElement;
  private garageTile: HTMLButtonElement;
  private raceBtn: HTMLButtonElement;

  constructor(private d: ScreenDeps) {
    this.hero = h('div', { class: 'hero-car' });
    this.raceBtn = h('button', { class: 'btn btn-primary menu-race', onclick: () => d.next() }, [h('span', {}, 'Carrera'), h('small', {}, 'rápida')]);
    this.campaignTile = h('button', { class: 'menu-tile is-campaign', onclick: () => d.campaign() });
    this.garageTile = h('button', { class: 'menu-tile is-garage', onclick: () => d.garage() });
    this.el = h('section', { class: 'home' }, [
      h('div', { class: 'home-logo' }, [h('span', { class: 'home-logo-a' }, 'OVERDRIVE'), h('span', { class: 'home-logo-b' }, 'RACING')]),
      this.hero,
      h('nav', { class: 'home-menu' }, [
        this.raceBtn,
        this.campaignTile,
        h('button', { class: 'menu-tile is-multi', onclick: () => d.invite() }, [h('span', { class: 'menu-icon' }, '📱'), h('strong', {}, 'Multijugador'), h('small', {}, 'cada uno con su móvil')]),
        this.garageTile,
      ]),
    ]);
  }

  update(): void {
    const cars = this.d.cars();
    const mine = cars.find((c) => c.ready && this.d.race.driverOf(c).kind === 'screen') ?? cars.find((c) => c.ready) ?? cars[0];
    if (mine) {
      const rec = recordOf(mine);
      this.hero.replaceChildren(
        h('button', { class: 'hero-platform', style: `--car:${mine.state.color}`, onclick: () => this.d.garage(), 'aria-label': 'Ir al garaje' }, [
          h('img', { src: avatarFor(mine.id, mine.state.name, mine.state.color), alt: '' }),
        ]),
        h('div', { class: 'hero-name' }, mine.state.name),
        mine.ready && ['charger', 'off'].includes(carPlace(mine.state))
          ? h('div', { class: `car-place is-${carPlace(mine.state)}` }, placeText(mine.state))
          : h('div', { class: 'hero-stats' }, rec?.races ? `🏆 ${rec.wins} · ${rec.races} carreras · ⚡ ${fmtSpeed(rec.topSpeed)}` : mine.ready ? 'Listo para correr' : 'Conectando…'),
      );
    } else {
      this.hero.replaceChildren(
        h('button', { class: 'hero-platform is-empty', onclick: () => this.d.addCar() }, [h('span', {}, '+')]),
        h('div', { class: 'hero-name' }, this.d.demo ? 'Añade un coche simulado' : 'Conecta tu coche'),
        h('div', { class: 'hero-stats' }, 'Enciéndelo, ponlo en la pista y tócalo aquí'),
      );
    }
    const done = completedLevels().size;
    this.campaignTile.replaceChildren(h('span', { class: 'menu-icon' }, '🏆'), h('strong', {}, 'Campaña'), h('small', {}, `${done}/${LEVELS.length} superados`));
    this.garageTile.replaceChildren(h('span', { class: 'menu-icon' }, '🏎️'), h('strong', {}, 'Garaje'), h('small', {}, `${cars.length} ${cars.length === 1 ? 'coche' : 'coches'}`));
    this.raceBtn.disabled = !cars.some((c) => c.ready);
    this.campaignTile.disabled = !cars.some((c) => c.ready);
  }
}

// ---- 1. Coches ------------------------------------------------------------------------

export class CarsScreen {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private padsLine: HTMLElement;
  private calledTimer?: ReturnType<typeof setTimeout>;
  private called?: { id: string; label: string };
  private nextBtn: HTMLButtonElement;

  constructor(private d: ScreenDeps) {
    this.list = h('div', { class: 'car-cards' });
    this.padsLine = h('p', { class: 'race-hint' });
    this.nextBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.next() }, 'Preparar carrera ›');
    const supported = d.demo || bluetoothAvailable();
    this.el = h('section', { class: 'screen' }, [
      h('header', { class: 'screen-head' }, [
        h('p', {}, `${d.demo ? 'Modo demo · ' : ''}Desliza para ver tus coches. Toca la imagen para cambiarla, elige quién conduce y usa «Identificar» para que el coche parpadee.`),
        supported
          ? null
          : h('p', { class: 'warn' }, [
              'Este navegador no tiene Bluetooth. Abre la app en ',
              h('strong', {}, 'Chrome o Edge'),
              ' (en iPhone, el navegador ',
              h('strong', {}, 'Bluefy'),
              '), o ',
              h('a', { href: '?demo' }, 'prueba la demo sin coches'),
              '.',
            ]),
      ]),
      this.list,
      h('div', { class: 'screen-actions' }, [
        h('button', { class: 'btn btn-ghost', onclick: () => d.addCar() }, [icon('bluetooth'), d.demo ? 'Añadir coche simulado' : 'Conectar coche']),
        h('button', { class: 'btn btn-ghost', onclick: () => d.invite() }, '📱 Invitar a otro móvil'),
        h('a', { class: 'btn btn-ghost', href: 'manual.html', target: '_blank', rel: 'noopener' }, '📖 Ayuda'),
      ]),
      this.padsLine,
      h('footer', { class: 'screen-foot' }, this.nextBtn),
    ]);
  }

  update(): void {
    // Rebuilding would close a driver dropdown while it is being used.
    if (this.list.contains(document.activeElement) && document.activeElement instanceof HTMLSelectElement) return;
    const cars = this.d.cars();
    this.list.replaceChildren(
      ...(cars.length
        ? cars.map((car) => this.card(car))
        : [h('div', { class: 'empty-card' }, [h('p', {}, 'Todavía no hay coches. Enciéndelos, ponlos en la pista y pulsa «Conectar coche».')])]),
    );
    const pads = this.d.pads.list();
    this.padsLine.textContent = pads.length
      ? `Mandos: ${pads.map((p) => `${p.index + 1}. ${p.name}`).join(' · ')}`
      : 'Mandos USB o Bluetooth: conéctalo y pulsa cualquier botón para que aparezca aquí.';
    this.nextBtn.disabled = !cars.some((c) => c.ready);
  }

  /** Brings `car`'s card into view and lights it up with `label` (e.g. the pad that drives it). */
  highlight(car: Car, label: string): void {
    // Kept here, not only on the element: the cards are rebuilt whenever a car changes.
    this.called = { id: car.id, label };
    clearTimeout(this.calledTimer);
    this.calledTimer = setTimeout(() => {
      this.called = undefined;
      this.update();
    }, 2500);
    this.update();
    this.list.querySelector(`[data-car="${CSS.escape(car.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  private card(car: Car): HTMLElement {
    const s = car.state;
    const { race } = this.d;
    const avatar = h('button', { class: 'avatar', title: 'Cambiar la imagen', 'aria-label': `Cambiar la imagen de ${s.name}` }, [
      h('img', { src: avatarFor(car.id, s.name, s.color), alt: '' }),
    ]);
    avatar.addEventListener('click', async () => {
      if (await pickAvatar(car.id)) this.update();
    });
    const guest = this.d.isGuestCar(car);
    const select = driverSelect(race, car, this.d.pads, race.live);
    const called = this.called?.id === car.id ? this.called.label : undefined;
    return h('article', { class: `car-card is-${s.status}${called ? ' is-called' : ''}`, style: `--car:${s.color}`, 'data-car': car.id, ...(called ? { 'data-called': called } : {}) }, [
      avatar,
      h('div', { class: 'car-card-main' }, [
        h('div', { class: 'car-card-title' }, [
          h('span', { class: 'chip-dot' }),
          h('strong', {}, `${guest ? '📱 ' : ''}${s.name}`),
          h('span', { class: 'car-card-meta' }, s.status === 'ready' ? '' : s.status === 'disconnected' ? 'desconectado' : 'conectando…'),
        ]),
        s.status === 'ready' ? h('div', { class: `car-place is-${carPlace(s)}` }, placeText(s)) : null,
        recordLine(car),
        select,
        h('div', { class: 'card-swatches', role: 'radiogroup', 'aria-label': 'Color' },
          COLORS.map((c) => {
            const b = h('button', { class: 'swatch', role: 'radio', style: `--c:${c}`, 'aria-label': `Color ${c}`, 'aria-checked': String(c === s.color), onclick: () => car.setColor(c) });
            b.disabled = !car.ready || guest;
            return b;
          }),
        ),
        h('div', { class: 'car-card-actions' }, [
          btn('Identificar', () => car.ready && this.d.identify(car), !car.ready),
          btn('Conducir', () => this.d.drive(car), !car.ready || guest),
          btn(guest ? 'Expulsar' : 'Quitar', () => this.d.removeCar(car), false),
        ]),
      ]),
    ]);
  }
}

// ---- 2. Pista ---------------------------------------------------------------------------

export class TrackScreen {
  readonly el: HTMLElement;
  private map: MapView;
  private info: HTMLElement;
  private scanRow: HTMLElement;
  private lapsNum: HTMLElement;
  private weaponsBtn: HTMLButtonElement;
  private soundBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private campaignBtn: HTMLButtonElement;
  private whyEl = h('p', { class: 'start-why', role: 'status', hidden: '' });
  private scanCar?: Car;

  constructor(private d: ScreenDeps) {
    const field = d.battle.field;
    this.map = new MapView(() => fieldSource(field, { cars: d.cars }));
    this.info = h('p', { class: 'track-summary' });
    this.scanRow = h('div', { class: 'scan-row' });
    this.lapsNum = h('span', { class: 'laps-num' });
    this.weaponsBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleWeapons() });
    this.soundBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleSound() });
    this.startBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.start() }, '¡A correr! ›');
    this.campaignBtn = h('button', { class: 'btn btn-ghost btn-lg', onclick: () => d.campaign() }, 'Campaña');
    const step = (delta: number) => {
      d.race.totalLaps = Math.max(1, Math.min(50, d.race.totalLaps + delta));
      this.update();
    };
    this.el = h('section', { class: 'screen setup' }, [
      h('header', { class: 'screen-head' }, [h('p', {}, 'Escanea la pista: un coche da una vuelta despacio y la app aprende su forma.')]),
      h('div', { class: 'track-stage' }, this.map.el),
      this.info,
      this.scanRow,
      h('div', { class: 'race-settings' }, [
        h('div', { class: 'laps' }, [
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Menos vueltas', onclick: () => step(-1) }, '−'),
          this.lapsNum,
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Más vueltas', onclick: () => step(1) }, '+'),
        ]),
        this.weaponsBtn,
        this.soundBtn,
      ]),
      this.whyEl,
      h('footer', { class: 'screen-foot' }, [this.campaignBtn, this.startBtn]),
    ]);
  }

  update(): void {
    const { race, battle } = this.d;
    const field = battle.field;
    this.map.update();
    const ready = this.d.cars().filter((c) => c.ready);
    if (!this.scanCar || !ready.includes(this.scanCar)) this.scanCar = ready[0];

    this.info.textContent = field.lap
      ? `Pista escaneada: ${describeTrack(field.lap)}`
      : field.scanning
        ? `${field.scanning.state.name} está dando la vuelta de escaneo…`
        : 'Pista sin escanear.';

    if (!this.scanRow.contains(document.activeElement)) {
      const pick = h('select', { class: 'driver', 'aria-label': 'Coche que escanea', onchange: (e: Event) => (this.scanCar = ready.find((c) => c.id === (e.target as HTMLSelectElement).value)) },
        ready.map((c) => {
          const o = h('option', { value: c.id }, c.state.name);
          o.selected = c === this.scanCar;
          return o;
        }),
      );
      const scanBtn = h('button', { class: `btn ${field.lap ? 'btn-ghost' : 'btn-primary'}`, onclick: () => this.scanCar && this.d.scan(this.scanCar) }, field.lap ? 'Volver a escanear' : 'Escanear pista');
      scanBtn.disabled = !this.scanCar || !!field.scanning || race.live;
      this.scanRow.replaceChildren(h('span', {}, 'Escanear con'), pick, scanBtn);
    }

    this.lapsNum.textContent = `${race.totalLaps} ${race.totalLaps === 1 ? 'vuelta' : 'vueltas'}`;
    this.weaponsBtn.textContent = battle.enabled ? 'Armas: sí' : 'Armas: no';
    this.soundBtn.textContent = sound.muted ? 'Sonido: no' : 'Sonido: sí';
    const why = race.blocker(this.d.cars());
    this.startBtn.disabled = !!why || !!field.scanning;
    this.startBtn.title = why ?? '';
    // On a phone a disabled button says nothing: show why next to it.
    this.whyEl.hidden = !why || race.live;
    this.whyEl.textContent = why ? `⚠️ ${why}` : '';
    this.campaignBtn.disabled = !!why || !!field.scanning;
  }

  private toggleWeapons(): void {
    this.d.battle.enabled = !this.d.battle.enabled;
    this.update();
  }

  private toggleSound(): void {
    sound.setMuted(!sound.muted);
    sound.unlock();
    this.update();
  }

  destroy(): void {
    this.map.destroy();
  }
}

// ---- Campaign ------------------------------------------------------------------------------

export class CampaignScreen {
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor(private d: ScreenDeps) {
    this.list = h('ol', { class: 'levels' });
    this.el = h('section', { class: 'screen' }, [
      h('header', { class: 'screen-head' }, [
        h('p', {}, 'Diez pruebas contra la IA. Supera una para abrir la siguiente. Tu coche es el que conduces tú (pantalla o mando); los demás coches conectados hacen de rivales.'),
      ]),
      this.list,
    ]);
  }

  update(): void {
    const done = completedLevels();
    const free = this.d.cars().filter((c) => c.ready && !this.d.isGuestCar(c)).length;
    this.list.replaceChildren(
      ...LEVELS.map((lv) => {
        const open = isUnlocked(lv.id, done);
        const needs = lv.rivals.length + 1;
        const play = h('button', { class: `btn ${done.has(lv.id) ? 'btn-ghost' : 'btn-primary'} btn-sm`, onclick: () => this.d.playLevel(lv) }, done.has(lv.id) ? 'Repetir' : 'Jugar');
        play.disabled = !open || free < needs;
        return h('li', { class: `level ${done.has(lv.id) ? 'is-done' : open ? 'is-open' : 'is-locked'}` }, [
          h('span', { class: 'level-n' }, done.has(lv.id) ? '✓' : open ? String(lv.id) : '🔒'),
          h('div', { class: 'level-body' }, [
            h('strong', {}, lv.name),
            h('p', {}, lv.brief),
            h('p', { class: 'level-meta' }, [
              `${lv.laps} ${lv.laps === 1 ? 'vuelta' : 'vueltas'} · ${lv.weapons ? 'con armas' : 'sin armas'} · rivales: ${lv.rivals.map((r) => AI_LEVELS[r].name.replace('IA ', '')).join(', ')}`,
              free < needs ? ` · necesitas ${needs} coches conectados` : '',
            ]),
          ]),
          play,
        ]);
      }),
    );
  }
}

// ---- Shared bits --------------------------------------------------------------------------

/** This car's all-time record on this phone, in one line. */
function recordLine(car: Car): HTMLElement | null {
  const r = recordOf(car);
  if (!r?.races) return h('p', { class: 'car-record' }, 'Sin carreras todavía');
  const bits = [
    `🏆 ${r.wins} ${r.wins === 1 ? 'victoria' : 'victorias'}`,
    `${r.races} ${r.races === 1 ? 'carrera' : 'carreras'}`,
    r.podiums ? `🥉 ${r.podiums} ${r.podiums === 1 ? 'podio' : 'podios'}` : '',
    r.topSpeed ? `⚡ ${fmtSpeed(r.topSpeed)}` : '',
    r.bestLapMs ? `⏱️ ${fmtTime(r.bestLapMs)}` : '',
    r.leadMs ? `👑 ${fmtTime(r.leadMs)} en cabeza` : '',
    r.kills ? `💥 ${r.kills}` : '',
  ].filter(Boolean);
  return h('p', { class: 'car-record' }, bits.join(' · '));
}

/** Awards at the end of a race (host results and guest standings). */
export function awardsList(awards: { icon: string; title: string; name: string; value: string }[]): HTMLElement {
  return h(
    'ul',
    { class: 'awards' },
    awards.map((a) =>
      h('li', {}, [h('span', { class: 'award-icon' }, a.icon), h('span', { class: 'award-title' }, a.title), h('strong', {}, a.name), h('span', { class: 'award-value' }, a.value)]),
    ),
  );
}

/** Race positions with picture, laps and best lap (spectator view, results, standings sheet). */
export function standingsList(race: Race, battle: Battle, cars: Car[]): HTMLElement {
  const order = race.entries.size ? race.standings().map((e) => e.car) : cars;
  return h(
    'ol',
    { class: 'standings' },
    order.map((car, i) => {
      const e = race.entries.get(car);
      const f = battle.fighter(car);
      const move = race.aiMove(car);
      const best = e?.lapTimes.length ? Math.min(...e.lapTimes) : undefined;
      return h('li', { class: e?.place === 1 ? 'is-winner' : '', style: `--car:${car.state.color}` }, [
        h('span', { class: 'race-pos' }, e?.place ? medal(e.place) : `${i + 1}.º`),
        h('img', { class: 'mini-avatar', src: avatarFor(car.id, car.state.name, car.state.color), alt: '' }),
        h('span', { class: 'race-name' }, car.state.name),
        h('span', { class: 'race-laps' }, e ? (e.place ? 'Meta' : race.phase === 'running' ? `${Math.min(e.laps + 1, race.totalLaps)}/${race.totalLaps}` : '') : ''),
        h('span', { class: `race-time ${move === 'ram' || move === 'shove' ? 'is-rough' : ''}` }, move && MOVE_TEXT[move] ? MOVE_TEXT[move] : best ? `mejor ${(best / 1000).toFixed(2)} s` : ''),
        f && battle.enabled && race.phase === 'running' ? h('span', { class: 'race-armor', title: 'Blindaje' }, h('span', { style: `width:${f.armor}%` })) : null,
      ]);
    }),
  );
}

function driverSelect(race: Race, car: Car, pads: Gamepads, locked: boolean): HTMLSelectElement {
  const driver = race.driverOf(car);
  const list = pads.list();
  const opts =
    driver.kind === 'guest'
      ? [option('guest', '📱 Lo conduce su móvil', driver)]
      : [
          option('screen', '👆 Tú, en esta pantalla', driver),
          ...list.map((p) => option(`pad:${p.index}`, `🎮 Mando ${p.index + 1}`, driver)),
          ...(driver.kind === 'pad' && !list.some((p) => p.index === driver.index) ? [option(`pad:${driver.index}`, `🎮 Mando ${driver.index + 1} (sin conectar)`, driver)] : []),
          ...(Object.keys(AI_LEVELS) as AiLevel[]).map((lv) => option(`ai:${lv}`, `🤖 ${AI_LEVELS[lv].name}`, driver)),
        ];
  const select = h('select', { class: 'driver', 'aria-label': `Piloto de ${car.state.name}`, onchange: (e: Event) => race.setDriver(car, parseDriver((e.target as HTMLSelectElement).value)) }, opts);
  select.disabled = locked || driver.kind === 'guest';
  if (driver.kind === 'ai') select.title = AI_LEVELS[driver.level].about;
  return select;
}

function btn(label: string, onclick: () => void, disabled: boolean): HTMLButtonElement {
  const b = h('button', { class: 'btn btn-ghost btn-sm', onclick }, label);
  b.disabled = disabled;
  return b;
}

function option(value: string, label: string, current: Driver): HTMLOptionElement {
  const o = h('option', { value }, label);
  o.selected = value === driverValue(current);
  return o;
}

function driverValue(d: Driver): string {
  if (d.kind === 'pad') return `pad:${d.index}`;
  if (d.kind === 'ai') return `ai:${d.level}`;
  return d.kind;
}

function parseDriver(v: string): Driver {
  const [kind, arg] = v.split(':');
  if (kind === 'pad') return { kind: 'pad', index: Number(arg) };
  if (kind === 'ai') return { kind: 'ai', level: arg as AiLevel };
  return { kind: 'screen' };
}

const MOVE_TEXT: Partial<Record<AiMove, string>> = { ram: '¡Embistiendo!', shove: '¡Empujando!', overtake: 'Adelantando' };

export function medal(place: number): string {
  return ['🥇', '🥈', '🥉'][place - 1] ?? `${place}.º`;
}
