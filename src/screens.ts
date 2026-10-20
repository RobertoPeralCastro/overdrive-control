import { AI_LEVELS, type AiLevel, type AiMove } from './ai';
import { avatarFor, pickAvatar } from './avatars';
import type { Battle } from './battle';
import type { Car } from './car';
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
}

// ---- 1. Coches ------------------------------------------------------------------------

export class CarsScreen {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private padsLine: HTMLElement;
  private nextBtn: HTMLButtonElement;

  constructor(private d: ScreenDeps) {
    this.list = h('div', { class: 'car-cards' });
    this.padsLine = h('p', { class: 'race-hint' });
    this.nextBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.next() }, 'Siguiente: la pista →');
    const supported = d.demo || bluetoothAvailable();
    this.el = h('section', { class: 'screen' }, [
      h('header', { class: 'screen-head' }, [
        h('h1', {}, d.demo ? '1 · Coches (demo)' : '1 · Coches'),
        h('p', {}, 'Conecta los coches, ponle a cada uno su imagen y elige quién lo conduce. «Identificar» hace parpadear el coche para que sepas cuál es.'),
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
    return h('article', { class: `car-card is-${s.status}`, style: `--car:${s.color}` }, [
      avatar,
      h('div', { class: 'car-card-main' }, [
        h('div', { class: 'car-card-title' }, [
          h('span', { class: 'chip-dot' }),
          h('strong', {}, `${guest ? '📱 ' : ''}${s.name}`),
          h('span', { class: 'car-card-meta' }, [
            s.status === 'ready' ? (s.battery !== undefined ? `${s.battery}%` : '') : s.status === 'disconnected' ? 'desconectado' : 'conectando…',
          ]),
        ]),
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
          btn('Identificar', () => car.ready && car.identify(), !car.ready),
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
  private scanCar?: Car;

  constructor(private d: ScreenDeps) {
    const field = d.battle.field;
    this.map = new MapView(() => fieldSource(field, { cars: d.cars }));
    this.info = h('p', { class: 'track-summary' });
    this.scanRow = h('div', { class: 'scan-row' });
    this.lapsNum = h('span', { class: 'laps-num' });
    this.weaponsBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleWeapons() });
    this.soundBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleSound() });
    this.startBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.start() }, '🏁 Iniciar carrera');
    const step = (delta: number) => {
      d.race.totalLaps = Math.max(1, Math.min(50, d.race.totalLaps + delta));
      this.update();
    };
    this.el = h('section', { class: 'screen' }, [
      h('header', { class: 'screen-head' }, [h('h1', {}, '2 · Pista'), h('p', {}, 'Escanea la pista: un coche da una vuelta despacio y la app aprende su forma.')]),
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
      h('footer', { class: 'screen-foot' }, [h('button', { class: 'btn btn-ghost', onclick: () => d.back() }, '← Coches'), this.startBtn]),
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

// ---- Shared bits --------------------------------------------------------------------------

/** This car's all-time record on this phone, in one line. */
function recordLine(car: Car): HTMLElement | null {
  const r = recordOf(car);
  if (!r?.races) return h('p', { class: 'car-record' }, 'Sin carreras todavía');
  const bits = [
    `🏆 ${r.wins} ${r.wins === 1 ? 'victoria' : 'victorias'}`,
    `${r.races} ${r.races === 1 ? 'carrera' : 'carreras'}`,
    r.podiums ? `🥉 ${r.podiums} podios` : '',
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
