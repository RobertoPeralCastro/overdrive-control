import { AI_LEVELS, type AiLevel, type AiMove } from './ai';
import type { Battle } from './battle';
import type { Car } from './car';
import { h } from './dom';
import type { Gamepads } from './gamepad';
import { MapView } from './mapview';
import { LIGHTS, type Driver, type Race } from './race';
import { sound } from './sound';
import { describeTrack } from './track';

export interface RaceViewDeps {
  race: Race;
  battle: Battle;
  pads: Gamepads;
  cars: () => Car[];
  scan: (car: Car) => void;
  start: () => void;
  toast: (msg: string) => void;
}

/** Race screen: track map with live car positions, start lights, drivers, laps and results. */
export class RaceView {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private lapsNum: HTMLElement;
  private weaponsBtn: HTMLButtonElement;
  private soundBtn: HTMLButtonElement;
  private actionBtn: HTMLButtonElement;
  private map: MapView;
  private lights: HTMLElement;
  private banner: HTMLElement;
  private table: HTMLElement;
  private padsLine: HTMLElement;

  constructor(private d: RaceViewDeps) {
    const { race } = d;
    this.title = h('h2', { class: 'race-title' });
    this.lapsNum = h('span', { class: 'laps-num' });
    this.weaponsBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleWeapons() });
    this.soundBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleSound() });
    this.actionBtn = h('button', { class: 'btn btn-primary', onclick: () => this.action() });
    this.lights = h('div', { class: 'lights', 'aria-hidden': 'true' }, Array.from({ length: LIGHTS }, () => h('span', { class: 'bulb' })));
    this.banner = h('div', { class: 'race-banner', role: 'status' });
    this.map = new MapView(d.battle.field, { cars: d.cars, scan: d.scan });
    this.table = h('div', { class: 'race-table', role: 'table', 'aria-label': 'Pilotos' });
    this.padsLine = h('p', { class: 'race-hint' });

    const stepLaps = (delta: number) => {
      if (race.phase === 'countdown' || race.phase === 'running') return;
      race.totalLaps = Math.max(1, Math.min(50, race.totalLaps + delta));
      this.update();
    };

    this.el = h('section', { class: 'race' }, [
      h('div', { class: 'race-head' }, [
        this.title,
        h('div', { class: 'race-controls' }, [
          h('div', { class: 'laps' }, [
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Menos vueltas', onclick: () => stepLaps(-1) }, '−'),
            this.lapsNum,
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Más vueltas', onclick: () => stepLaps(1) }, '+'),
          ]),
          this.weaponsBtn,
          this.soundBtn,
          this.actionBtn,
        ]),
      ]),
      h('div', { class: 'race-body' }, [h('div', { class: 'race-stage' }, [this.map.el, this.lights, this.banner]), h('div', { class: 'race-side' }, [this.table, this.padsLine])]),
    ]);
  }

  update(): void {
    const { race, battle } = this.d;
    const field = battle.field;
    const live = race.phase === 'countdown' || race.phase === 'running';

    this.title.textContent = {
      setup: 'Carrera',
      countdown: 'Preparados…',
      running: `Carrera · ${race.totalLaps} ${race.totalLaps === 1 ? 'vuelta' : 'vueltas'}`,
      finished: 'Carrera terminada',
    }[race.phase];
    this.lapsNum.textContent = `${race.totalLaps} ${race.totalLaps === 1 ? 'vuelta' : 'vueltas'}`;
    this.weaponsBtn.textContent = battle.enabled ? 'Armas: sí' : 'Armas: no';
    this.weaponsBtn.disabled = live;
    this.soundBtn.textContent = sound.muted ? 'Sonido: no' : 'Sonido: sí';
    this.actionBtn.textContent = live ? 'Parar carrera' : race.phase === 'finished' ? 'Otra carrera' : 'Empezar carrera';
    this.actionBtn.classList.toggle('btn-primary', !live);
    this.actionBtn.classList.toggle('btn-stop', live);

    this.lights.classList.toggle('is-on', race.phase === 'countdown');
    this.lights.querySelectorAll('.bulb').forEach((b, i) => b.classList.toggle('is-lit', i < race.lights));

    const winner = race.winner();
    this.banner.className = `race-banner ${winner && race.phase !== 'setup' ? 'is-visible' : ''}`;
    this.banner.textContent = winner ? `🏆 Gana ${winner.car.state.name}` : '';

    this.map.update();
    this.renderTable();

    const pads = this.d.pads.list();
    this.padsLine.textContent = pads.length
      ? `Mandos: ${pads.map((p) => `${p.index + 1}. ${p.name}`).join(' · ')}. Start empieza la carrera.`
      : 'Conecta un mando por USB o Bluetooth y pulsa cualquier botón para que aparezca.';
    this.padsLine.title = field.lap ? describeTrack(field.lap) : '';
  }

  private renderTable(): void {
    const { race, battle } = this.d;
    // Rebuilding would close a driver dropdown while it is being used.
    if (this.table.contains(document.activeElement) && document.activeElement instanceof HTMLSelectElement) return;
    const live = race.phase === 'countdown' || race.phase === 'running';
    const cars = this.d.cars();
    const order = race.entries.size ? [...race.standings().map((e) => e.car), ...cars.filter((c) => !race.entries.has(c))] : cars;
    const pads = this.d.pads.list();

    const rows = order.map((car, i) => {
      const e = race.entries.get(car);
      const f = battle.fighter(car);
      const driver = race.driverOf(car);
      const select = h(
        'select',
        { class: 'driver', 'aria-label': `Piloto de ${car.state.name}`, onchange: (ev: Event) => race.setDriver(car, parseDriver((ev.target as HTMLSelectElement).value)) },
        [
          option('screen', 'Tú (pantalla)', driver),
          ...pads.map((p) => option(`pad:${p.index}`, `Mando ${p.index + 1}`, driver)),
          ...(driver.kind === 'pad' && !pads.some((p) => p.index === driver.index) ? [option(`pad:${driver.index}`, `Mando ${driver.index + 1} (sin conectar)`, driver)] : []),
          ...(Object.keys(AI_LEVELS) as AiLevel[]).map((lv) => option(`ai:${lv}`, AI_LEVELS[lv].name, driver)),
        ],
      );
      select.disabled = live;
      if (driver.kind === 'ai') select.title = AI_LEVELS[driver.level].about;
      const move = race.aiMove(car);
      const best = e?.lapTimes.length ? Math.min(...e.lapTimes) : undefined;
      const pos = e ? (e.place ?? i + 1) : undefined;
      return h('div', { class: `race-row ${e?.place === 1 ? 'is-winner' : ''} ${car.ready ? '' : 'is-off'}`, role: 'row', style: `--car:${car.state.color}` }, [
        h('span', { class: 'race-pos' }, pos ? (e?.place ? medal(e.place) : `${pos}.º`) : ''),
        h('span', { class: 'chip-dot' }),
        h('span', { class: 'race-name' }, car.state.name),
        select,
        h('span', { class: 'race-laps' }, e ? (e.place ? 'Meta' : `${Math.min(e.laps + 1, race.totalLaps)}/${race.totalLaps}`) : ''),
        h('span', { class: `race-time ${move === 'ram' || move === 'shove' ? 'is-rough' : ''}` }, move && MOVE_TEXT[move] ? MOVE_TEXT[move] : best ? `mejor ${fmt(best)}` : ''),
        f && battle.enabled ? h('span', { class: 'race-armor', title: 'Blindaje' }, h('span', { style: `width:${f.armor}%` })) : null,
      ]);
    });
    this.table.replaceChildren(...(rows.length ? rows : [h('p', { class: 'race-hint' }, 'Conecta coches con el botón + Coche.')]));
    if (!live && [...cars].some((c) => race.driverOf(c).kind === 'ai')) {
      this.table.append(
        h('div', { class: 'race-hint' }, (Object.keys(AI_LEVELS) as AiLevel[]).map((lv) => h('p', {}, [h('strong', {}, `${AI_LEVELS[lv].name}: `), AI_LEVELS[lv].about]))),
      );
    }
  }

  private action(): void {
    const { race } = this.d;
    sound.unlock();
    if (race.phase === 'countdown' || race.phase === 'running') race.abort();
    else this.d.start();
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
}

function option(value: string, label: string, current: Driver): HTMLOptionElement {
  const o = h('option', { value }, label);
  o.selected = value === driverValue(current);
  return o;
}

function driverValue(d: Driver): string {
  return d.kind === 'screen' ? 'screen' : d.kind === 'pad' ? `pad:${d.index}` : `ai:${d.level}`;
}

function parseDriver(v: string): Driver {
  const [kind, arg] = v.split(':');
  if (kind === 'pad') return { kind: 'pad', index: Number(arg) };
  if (kind === 'ai') return { kind: 'ai', level: arg as AiLevel };
  return { kind: 'screen' };
}

const MOVE_TEXT: Partial<Record<AiMove, string>> = { ram: '¡Embistiendo!', shove: '¡Empujando!', overtake: 'Adelantando' };

function medal(place: number): string {
  return ['🥇', '🥈', '🥉'][place - 1] ?? `${place}.º`;
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}
