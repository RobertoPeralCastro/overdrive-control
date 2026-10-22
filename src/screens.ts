import { AI_LEVELS, type AiLevel, type AiMove } from './ai';
import { avatarFor, pickAvatar } from './avatars';
import { LEVELS, completedLevels, isUnlocked, type Level } from './campaign';
import type { Battle } from './battle';
import { carPlace, placeText, type Car } from './car';
import { COLORS } from './cockpit';
import { h, icon } from './dom';
import type { Gamepads } from './gamepad';
import { lang, manualUrl, setLang, t, type Lang } from './i18n';
import { MapView, fieldSource } from './mapview';
import { MODEL_NAMES } from './protocol';
import type { Driver, Race } from './race';
import { showToast } from './shell';
import { engineSound, sound } from './sound';
import { fmtSpeed, fmtTime, recordOf } from './stats';
import { describeTrack } from './track';
import { deleteTrack, renameTrack, savedTracks, trackLabel } from './tracks';
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
  /** Opens "Configurar mando" for pad `index`. */
  configurePad(index: number): void;
  /** Uses a track saved from an earlier scan. */
  useTrack(id: string): void;
  /** The saved track in use, if any. */
  trackId(): string | undefined;
  playLevel(level: Level): void;
}

// ---- Main menu ----------------------------------------------------------------------------

export class HomeScreen {
  readonly el: HTMLElement;
  private hero: HTMLElement;
  private campaignTile: HTMLButtonElement;
  private garageTile: HTMLButtonElement;
  private padsTile: HTMLButtonElement;
  private raceBtn: HTMLButtonElement;

  constructor(private d: ScreenDeps) {
    this.hero = h('div', { class: 'hero-car' });
    this.raceBtn = h('button', { class: 'btn btn-primary menu-race', onclick: () => d.next() }, [h('span', {}, t('Carrera', 'Quick')), h('small', {}, t('rápida', 'race'))]);
    this.campaignTile = h('button', { class: 'menu-tile is-campaign', onclick: () => d.campaign() });
    this.garageTile = h('button', { class: 'menu-tile is-garage', onclick: () => d.garage() });
    this.padsTile = h('button', { class: 'menu-tile is-pads', onclick: () => this.openPads() });
    this.el = h('section', { class: 'home' }, [
      h('div', { class: 'home-logo' }, [h('span', { class: 'home-logo-a' }, 'OVERDRIVE'), h('span', { class: 'home-logo-b' }, 'RACING')]),
      this.hero,
      h('nav', { class: 'home-menu' }, [
        this.raceBtn,
        this.campaignTile,
        h('button', { class: 'menu-tile is-multi', onclick: () => d.invite() }, [h('span', { class: 'menu-icon' }, '📱'), h('strong', {}, t('Multijugador', 'Multiplayer')), h('small', {}, t('cada uno con su móvil', 'each on their own phone'))]),
        this.garageTile,
        this.padsTile,
      ]),
      langSwitch(d),
    ]);
  }

  update(): void {
    const cars = this.d.cars();
    const mine = cars.find((c) => c.ready && this.d.race.driverOf(c).kind === 'screen') ?? cars.find((c) => c.ready) ?? cars[0];
    if (mine) {
      const rec = recordOf(mine);
      this.hero.replaceChildren(
        h('button', { class: 'hero-platform', style: `--car:${mine.state.color}`, onclick: () => this.d.garage(), 'aria-label': t('Ir al garaje', 'Go to the garage') }, [
          h('img', { src: avatarFor(mine.id, mine.state.name, mine.state.color), alt: '' }),
        ]),
        h('div', { class: 'hero-name' }, mine.state.name),
        mine.ready && ['charger', 'off'].includes(carPlace(mine.state))
          ? h('div', { class: `car-place is-${carPlace(mine.state)}` }, placeText(mine.state))
          : h('div', { class: 'hero-stats' }, rec?.races ? t(`🏆 ${rec.wins} · ${rec.races} carreras · ⚡ ${fmtSpeed(rec.topSpeed)}`, `🏆 ${rec.wins} · ${rec.races} ${rec.races === 1 ? 'race' : 'races'} · ⚡ ${fmtSpeed(rec.topSpeed)}`) : mine.ready ? t('Listo para correr', 'Ready to race') : t('Conectando…', 'Connecting…')),
      );
    } else {
      this.hero.replaceChildren(
        h('button', { class: 'hero-platform is-empty', onclick: () => this.d.addCar() }, [h('span', {}, '+')]),
        h('div', { class: 'hero-name' }, this.d.demo ? t('Añade un coche simulado', 'Add a simulated car') : t('Conecta tu coche', 'Connect your car')),
        h('div', { class: 'hero-stats' }, t('Enciéndelo, ponlo en la pista y tócalo aquí', 'Switch it on, put it on the track and tap here')),
      );
    }
    const done = completedLevels().size;
    this.campaignTile.replaceChildren(h('span', { class: 'menu-icon' }, '🏆'), h('strong', {}, t('Campaña', 'Campaign')), h('small', {}, t(`${done}/${LEVELS.length} superados`, `${done}/${LEVELS.length} cleared`)));
    this.garageTile.replaceChildren(h('span', { class: 'menu-icon' }, '🏎️'), h('strong', {}, t('Garaje', 'Garage')), h('small', {}, `${cars.length} ${cars.length === 1 ? t('coche', 'car') : t('coches', 'cars')}`));
    const pads = this.d.pads.list();
    this.padsTile.replaceChildren(
      h('span', { class: 'menu-icon' }, '🎮'),
      h('strong', {}, t('Mandos', 'Controllers')),
      h('small', {}, pads.length ? t(`${pads.length} conectado${pads.length === 1 ? '' : 's'} · configurar`, `${pads.length} connected · set up`) : t('pulsa un botón del mando', 'press a button on it')),
    );
    this.raceBtn.disabled = !cars.some((c) => c.ready);
    this.campaignTile.disabled = !cars.some((c) => c.ready);
  }

  /** Straight to "Configurar mando", or how to make the controller show up. */
  private openPads(): void {
    const pads = this.d.pads.list();
    if (pads.length) return this.d.configurePad(pads[0].index);
    showToast(
      t(
        'Conecta el mando por USB o Bluetooth y pulsa cualquier botón: el navegador solo lo muestra después.',
        'Connect the controller over USB or Bluetooth and press any button: the browser only shows it after that.',
      ),
    );
  }
}

// ---- 1. Coches ------------------------------------------------------------------------

/** Suggestions for naming a car: the Overdrive models, plus Supertrucks and Fast & Furious cars. */
const CAR_MODELS = [...new Set([...Object.values(MODEL_NAMES), 'X52', 'X52 Ice', 'Ice Charger', 'Dodge Charger'])].sort();

export class CarsScreen {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private padsLine: HTMLElement;
  private calledTimer?: ReturnType<typeof setTimeout>;
  private called?: { id: string; label: string };
  /** The car whose name is being edited. */
  private renaming?: string;
  private nextBtn: HTMLButtonElement;

  constructor(private d: ScreenDeps) {
    this.list = h('div', { class: 'car-cards' });
    this.padsLine = h('div', { class: 'race-hint pads-line' });
    this.nextBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.next() }, t('Preparar carrera ›', 'Race setup ›'));
    const supported = d.demo || bluetoothAvailable();
    this.el = h('section', { class: 'screen' }, [
      h('header', { class: 'screen-head' }, [
        h('p', {}, t(
          `${d.demo ? 'Modo demo · ' : ''}Desliza para ver tus coches. Toca la imagen para cambiarla, elige quién conduce y usa «Identificar» para que el coche parpadee.`,
          `${d.demo ? 'Demo mode · ' : ''}Swipe to see your cars. Tap the picture to change it, pick who drives and use “Identify” to make the car blink.`,
        )),
        supported
          ? null
          : h('p', { class: 'warn' }, [
              t('Este navegador no tiene Bluetooth. Abre la app en ', 'This browser has no Bluetooth. Open the app in '),
              h('strong', {}, t('Chrome o Edge', 'Chrome or Edge')),
              t(' (en iPhone, el navegador ', ' (on iPhone, the '),
              h('strong', {}, 'Bluefy'),
              t('), o ', ' browser), or '),
              h('a', { href: '?demo' }, t('prueba la demo sin coches', 'try the demo without cars')),
              '.',
            ]),
      ]),
      this.list,
      h('datalist', { id: 'car-models' }, CAR_MODELS.map((name) => h('option', { value: name }))),
      h('div', { class: 'screen-actions' }, [
        h('button', { class: 'btn btn-ghost', onclick: () => d.addCar() }, [icon('bluetooth'), d.demo ? t('Añadir coche simulado', 'Add simulated car') : t('Conectar coche', 'Connect car')]),
        h('button', { class: 'btn btn-ghost', onclick: () => d.invite() }, t('📱 Invitar a otro móvil', '📱 Invite another phone')),
        h('a', { class: 'btn btn-ghost', href: manualUrl(), target: '_blank', rel: 'noopener' }, t('📖 Ayuda', '📖 Help')),
      ]),
      this.padsLine,
      h('footer', { class: 'screen-foot' }, this.nextBtn),
    ]);
  }

  update(): void {
    // Rebuilding would close a driver dropdown, or lose a name being typed, while it is being used.
    const active = document.activeElement;
    if (this.list.contains(active) && (active instanceof HTMLSelectElement || active instanceof HTMLInputElement)) return;
    const cars = this.d.cars();
    this.list.replaceChildren(
      ...(cars.length
        ? cars.map((car) => this.card(car))
        : [h('div', { class: 'empty-card' }, [h('p', {}, t('Todavía no hay coches. Enciéndelos, ponlos en la pista y pulsa «Conectar coche».', 'No cars yet. Switch them on, put them on the track and press “Connect car”.'))])]),
    );
    const pads = this.d.pads.list();
    this.padsLine.replaceChildren(
      ...(pads.length
        ? pads.map((p) => h('button', { class: 'btn btn-ghost btn-sm', title: p.name, onclick: () => this.d.configurePad(p.index) }, t(`🎮 Configurar Mando ${p.index + 1}`, `🎮 Set up Controller ${p.index + 1}`)))
        : [h('span', {}, t('Mandos USB o Bluetooth: conéctalo y pulsa cualquier botón para que aparezca aquí.', 'USB or Bluetooth controllers: plug one in and press any button to make it show up here.'))]),
    );
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

  private startRename(car: Car): void {
    this.renaming = car.id;
    this.update();
    this.list.querySelector<HTMLInputElement>(`[data-car="${CSS.escape(car.id)}"] .car-name-input`)?.focus();
  }

  /**
   * The browser often can't tell which model a car is (Skull, Thermo…): then the card asks.
   * "Identificar" makes the car blink to know which one it is; the name is kept for this car.
   */
  private nameInput(car: Car): HTMLInputElement {
    const input = h('input', {
      class: 'car-name-input',
      list: 'car-models',
      value: car.known ? car.state.name : '',
      placeholder: t('¿Qué coche es?', 'Which car is it?'),
      'aria-label': t('Nombre del coche', 'Car name'),
      title: t('Elige el modelo o escribe un nombre. «Identificar» hace parpadear el coche.', 'Pick the model or type a name. “Identify” makes the car blink.'),
      enterkeyhint: 'done',
    });
    const done = () => {
      if (input.value.trim()) car.rename(input.value);
      this.renaming = undefined;
      // After the blur, so the rebuild isn't held back by this input still having focus.
      setTimeout(() => this.update());
    };
    input.addEventListener('change', done);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
    input.addEventListener('blur', () => this.renaming === car.id && done());
    return input;
  }

  private card(car: Car): HTMLElement {
    const s = car.state;
    const { race } = this.d;
    const avatar = h('button', { class: 'avatar', title: t('Cambiar la imagen', 'Change the picture'), 'aria-label': t(`Cambiar la imagen de ${s.name}`, `Change ${s.name}'s picture`) }, [
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
          !guest && (!car.known || this.renaming === car.id)
            ? this.nameInput(car)
            : h(guest ? 'strong' : 'button', { class: 'car-name', ...(guest ? {} : { title: t('Cambiar el nombre', 'Rename'), onclick: () => this.startRename(car) }) }, `${guest ? '📱 ' : ''}${s.name}`),
          h('span', { class: 'car-card-meta' }, s.status === 'ready' ? '' : s.status === 'disconnected' ? t('desconectado', 'disconnected') : t('conectando…', 'connecting…')),
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
          btn(t('Identificar', 'Identify'), () => car.ready && this.d.identify(car), !car.ready),
          btn(t('Conducir', 'Drive'), () => this.d.drive(car), !car.ready || guest),
          btn(guest ? t('Expulsar', 'Kick') : t('Quitar', 'Remove'), () => this.d.removeCar(car), false),
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
  private engineBtn: HTMLButtonElement;
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
    this.engineBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.toggleEngine() });
    this.startBtn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => d.start() }, t('¡A correr! ›', 'Race! ›'));
    this.campaignBtn = h('button', { class: 'btn btn-ghost btn-lg', onclick: () => d.campaign() }, t('Campaña', 'Campaign'));
    const step = (delta: number) => {
      d.race.totalLaps = Math.max(1, Math.min(50, d.race.totalLaps + delta));
      this.update();
    };
    this.el = h('section', { class: 'screen setup' }, [
      h('header', { class: 'screen-head' }, [h('p', {}, t('Escanea la pista: un coche da una vuelta despacio y la app aprende su forma.', 'Scan the track: one car does a slow lap and the app learns its shape.'))]),
      h('div', { class: 'track-stage' }, this.map.el),
      this.info,
      this.scanRow,
      h('div', { class: 'race-settings' }, [
        h('div', { class: 'laps' }, [
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': t('Menos vueltas', 'Fewer laps'), onclick: () => step(-1) }, '−'),
          this.lapsNum,
          h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': t('Más vueltas', 'More laps'), onclick: () => step(1) }, '+'),
        ]),
        this.weaponsBtn,
        this.soundBtn,
        this.engineBtn,
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

    const using = savedTracks().find((s) => s.id === this.d.trackId());
    this.info.textContent = field.lap
      ? using
        ? `${using.name}: ${describeTrack(field.lap)}`
        : t(`Pista escaneada: ${describeTrack(field.lap)}`, `Track scanned: ${describeTrack(field.lap)}`)
      : field.scanning
        ? t(`${field.scanning.state.name} está dando la vuelta de escaneo…`, `${field.scanning.state.name} is doing the scan lap…`)
        : t('Pista sin escanear.', 'Track not scanned yet.');

    if (!this.scanRow.contains(document.activeElement)) {
      const pick = h('select', { class: 'driver', 'aria-label': t('Coche que escanea', 'Car that scans'), onchange: (e: Event) => (this.scanCar = ready.find((c) => c.id === (e.target as HTMLSelectElement).value)) },
        ready.map((c) => {
          const o = h('option', { value: c.id }, c.state.name);
          o.selected = c === this.scanCar;
          return o;
        }),
      );
      const scanBtn = h('button', { class: `btn ${field.lap ? 'btn-ghost' : 'btn-primary'}`, onclick: () => this.scanCar && this.d.scan(this.scanCar) }, field.lap ? t('Volver a escanear', 'Scan again') : t('Escanear pista', 'Scan track'));
      scanBtn.disabled = !this.scanCar || !!field.scanning || race.live;
      this.scanRow.replaceChildren(h('div', { class: 'scan-line' }, [h('span', {}, t('Escanear con', 'Scan with')), pick, scanBtn]), ...this.savedLine());
    }

    this.lapsNum.textContent = `${race.totalLaps} ${race.totalLaps === 1 ? t('vuelta', 'lap') : t('vueltas', 'laps')}`;
    this.weaponsBtn.textContent = battle.enabled ? t('Armas: sí', 'Weapons: on') : t('Armas: no', 'Weapons: off');
    this.soundBtn.textContent = sound.muted ? t('Sonido: no', 'Sound: off') : t('Sonido: sí', 'Sound: on');
    this.engineBtn.textContent = engineSound.on ? t('Motor: sí', 'Engine: on') : t('Motor: no', 'Engine: off');
    this.engineBtn.disabled = sound.muted;
    const why = race.blocker(this.d.cars());
    this.startBtn.disabled = !!why || !!field.scanning;
    this.startBtn.title = why ?? '';
    // On a phone a disabled button says nothing: show why next to it.
    this.whyEl.hidden = !why || race.live;
    this.whyEl.textContent = why ? `⚠️ ${why}` : '';
    this.campaignBtn.disabled = !!why || !!field.scanning;
  }

  /** Tracks scanned before on this phone: pick one instead of scanning again. */
  private savedLine(): HTMLElement[] {
    const saved = savedTracks();
    if (!saved.length) return [];
    const current = this.d.trackId();
    const busy = this.d.race.live || !!this.d.battle.field.scanning;
    const pick = h(
      'select',
      { class: 'driver', 'aria-label': t('Pistas guardadas', 'Saved tracks'), onchange: (e: Event) => this.d.useTrack((e.target as HTMLSelectElement).value) },
      [
        ...(current ? [] : [h('option', { value: '' }, t(`📂 Pistas guardadas (${saved.length})…`, `📂 Saved tracks (${saved.length})…`))]),
        ...saved.map((s) => {
          const o = h('option', { value: s.id }, trackLabel(s));
          o.selected = s.id === current;
          return o;
        }),
      ],
    );
    pick.disabled = busy;
    const sel = current && saved.find((s) => s.id === current);
    const rename = h('button', { class: 'btn btn-ghost btn-sm', title: t('Cambiar el nombre', 'Rename'), 'aria-label': t('Cambiar el nombre de la pista', 'Rename the track') }, '✏️');
    rename.addEventListener('click', () => {
      if (!sel) return;
      const name = prompt(t('Nombre de la pista', 'Track name'), sel.name);
      if (name) renameTrack(sel.id, name);
      this.update();
    });
    const remove = h('button', { class: 'btn btn-ghost btn-sm', title: t('Borrar la pista guardada', 'Delete the saved track'), 'aria-label': t('Borrar la pista guardada', 'Delete the saved track') }, '🗑️');
    remove.addEventListener('click', () => {
      if (!sel || !confirm(t(`¿Borrar «${sel.name}» de las pistas guardadas?`, `Delete “${sel.name}” from the saved tracks?`))) return;
      deleteTrack(sel.id);
      this.update();
    });
    rename.disabled = remove.disabled = !sel;
    return [h('div', { class: 'scan-line saved-line' }, [pick, rename, remove])];
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

  private toggleEngine(): void {
    engineSound.set(!engineSound.on);
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
        h('p', {}, t(
          'Diez pruebas contra la IA. Supera una para abrir la siguiente. Tu coche es el que conduces tú (pantalla o mando); los demás coches conectados hacen de rivales.',
          'Ten challenges against the AI. Clear one to unlock the next. Your car is the one you drive (screen or controller); the other connected cars are your rivals.',
        )),
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
        const play = h('button', { class: `btn ${done.has(lv.id) ? 'btn-ghost' : 'btn-primary'} btn-sm`, onclick: () => this.d.playLevel(lv) }, done.has(lv.id) ? t('Repetir', 'Replay') : t('Jugar', 'Play'));
        play.disabled = !open || free < needs;
        return h('li', { class: `level ${done.has(lv.id) ? 'is-done' : open ? 'is-open' : 'is-locked'}` }, [
          h('span', { class: 'level-n' }, done.has(lv.id) ? '✓' : open ? String(lv.id) : '🔒'),
          h('div', { class: 'level-body' }, [
            h('strong', {}, lv.name),
            h('p', {}, lv.brief),
            h('p', { class: 'level-meta' }, [
              `${lv.laps} ${lv.laps === 1 ? t('vuelta', 'lap') : t('vueltas', 'laps')} · ${lv.weapons ? t('con armas', 'with weapons') : t('sin armas', 'no weapons')} · ${t('rivales', 'rivals')}: ${lv.rivals.map((r) => AI_LEVELS[r].name.replace(t('IA ', ' AI'), '')).join(', ')}`,
              free < needs ? t(` · necesitas ${needs} coches conectados`, ` · you need ${needs} connected cars`) : '',
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
  if (!r?.races) return h('p', { class: 'car-record' }, t('Sin carreras todavía', 'No races yet'));
  const bits = [
    `🏆 ${r.wins} ${r.wins === 1 ? t('victoria', 'win') : t('victorias', 'wins')}`,
    `${r.races} ${r.races === 1 ? t('carrera', 'race') : t('carreras', 'races')}`,
    r.podiums ? `🥉 ${r.podiums} ${r.podiums === 1 ? t('podio', 'podium') : t('podios', 'podiums')}` : '',
    r.topSpeed ? `⚡ ${fmtSpeed(r.topSpeed)}` : '',
    r.bestLapMs ? `⏱️ ${fmtTime(r.bestLapMs)}` : '',
    r.leadMs ? t(`👑 ${fmtTime(r.leadMs)} en cabeza`, `👑 ${fmtTime(r.leadMs)} in the lead`) : '',
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
        h('span', { class: 'race-pos' }, e?.place ? medal(e.place) : ordinal(i + 1)),
        h('img', { class: 'mini-avatar', src: avatarFor(car.id, car.state.name, car.state.color), alt: '' }),
        h('span', { class: 'race-name' }, car.state.name),
        h('span', { class: 'race-laps' }, e ? (e.place ? t('Meta', 'Finish') : race.phase === 'running' ? `${Math.min(e.laps + 1, race.totalLaps)}/${race.totalLaps}` : '') : ''),
        h('span', { class: `race-time ${move === 'ram' || move === 'shove' ? 'is-rough' : ''}` }, move && MOVE_TEXT[move] ? MOVE_TEXT[move] : best ? t(`mejor ${(best / 1000).toFixed(2)} s`, `best ${(best / 1000).toFixed(2)} s`) : ''),
        f && battle.enabled && race.phase === 'running' ? h('span', { class: 'race-armor', title: t('Blindaje', 'Armor') }, h('span', { style: `width:${f.armor}%` })) : null,
      ]);
    }),
  );
}

function driverSelect(race: Race, car: Car, pads: Gamepads, locked: boolean): HTMLSelectElement {
  const driver = race.driverOf(car);
  const list = pads.list();
  const opts =
    driver.kind === 'guest'
      ? [option('guest', t('📱 Lo conduce su móvil', '📱 Driven from their phone'), driver)]
      : [
          option('screen', t('👆 Tú, en esta pantalla', '👆 You, on this screen'), driver),
          ...list.map((p) => option(`pad:${p.index}`, t(`🎮 Mando ${p.index + 1}`, `🎮 Controller ${p.index + 1}`), driver)),
          ...(driver.kind === 'pad' && !list.some((p) => p.index === driver.index) ? [option(`pad:${driver.index}`, t(`🎮 Mando ${driver.index + 1} (sin conectar)`, `🎮 Controller ${driver.index + 1} (not connected)`), driver)] : []),
          ...(Object.keys(AI_LEVELS) as AiLevel[]).map((lv) => option(`ai:${lv}`, `🤖 ${AI_LEVELS[lv].name}`, driver)),
        ];
  const select = h('select', { class: 'driver', 'aria-label': t(`Piloto de ${car.state.name}`, `${car.state.name}'s driver`), onchange: (e: Event) => race.setDriver(car, parseDriver((e.target as HTMLSelectElement).value)) }, opts);
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

const MOVE_TEXT: Partial<Record<AiMove, string>> = { ram: t('¡Embistiendo!', 'Ramming!'), shove: t('¡Empujando!', 'Shoving!'), overtake: t('Adelantando', 'Overtaking') };

export function medal(place: number): string {
  return ['🥇', '🥈', '🥉'][place - 1] ?? ordinal(place);
}

/** "4.º" / "4th". */
function ordinal(n: number): string {
  if (lang === 'es') return `${n}.º`;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "ES | EN" at the bottom of the main menu. Switching reloads the app. */
function langSwitch(d: ScreenDeps): HTMLElement {
  const choice = (code: Lang, label: string, name: string) =>
    h(
      'button',
      {
        class: code === lang ? 'is-on' : '',
        lang: code,
        title: name,
        'aria-pressed': String(code === lang),
        onclick: () => {
          if (code === lang) return;
          if (d.cars().some((c) => c.ready) && !confirm(t('Cambiar el idioma recarga la app y desconecta los coches. ¿Seguir?', 'Changing the language reloads the app and disconnects the cars. Continue?'))) return;
          setLang(code);
        },
      },
      label,
    );
  return h('div', { class: 'lang-switch', role: 'group', 'aria-label': t('Idioma', 'Language') }, [choice('es', 'ES', 'Español'), choice('en', 'EN', 'English')]);
}
