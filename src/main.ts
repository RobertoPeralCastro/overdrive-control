import './styles.css';
import { Car, MAX_SPEED } from './car';
import { SimTransport } from './sim';
import { bluetoothAvailable, pickCar, type Transport } from './transport';
import { Gamepads } from './gamepad';
import { h, icon } from './dom';
import { Battle, MAX_ARMOR, MAX_ENERGY, WEAPONS, type FireDetail, type WeaponId } from './battle';
import { Field } from './field';
import { Race, type Entry } from './race';
import { RaceView } from './raceview';
import { MapView } from './mapview';
import { sound } from './sound';
import { describeTrack } from './track';

const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ffffff'];
const demo = new URLSearchParams(location.search).has('demo');

const WEAPON_KEYS: Record<WeaponId, string> = { blaster: 'Q', missile: 'E', pulse: 'R', shield: 'F' };

const cars: Car[] = [];
const field = new Field();
const battle = new Battle(field);
const race = new Race(battle);
let selected: Car | undefined;
/** The race screen is showing instead of a car's cockpit. */
let raceScreen = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const app = document.getElementById('app')!;
const garage = h('nav', { class: 'garage', 'aria-label': 'Coches conectados' });
const stage = h('main', { class: 'stage' });
const toast = h('div', { class: 'toast', role: 'status' });

app.append(
  h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), 'Overdrive', h('em', {}, ' control')]),
    h('div', { class: 'top-actions' }, [
      h('button', { class: 'btn btn-ghost', onclick: addCar, title: 'Buscar y conectar un coche' }, [icon('plus'), h('span', {}, 'Coche')]),
      h('button', { class: 'btn btn-stop', onclick: stopAll, title: 'Frenar todos los coches (Esc)' }, 'STOP'),
    ]),
  ]),
  garage,
  stage,
  toast,
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

  const car = new Car(transport);
  cars.push(car);
  battle.add(car);
  car.addEventListener('change', () => onCarChange(car));
  select(car);
  try {
    await car.connect();
    vibrate(30);
    updateWakeLock();
  } catch (e) {
    showToast(`No se pudo conectar: ${errText(e)}`);
  }
}

function removeCar(car: Car): void {
  void car.disconnect();
  cars.splice(cars.indexOf(car), 1);
  battle.remove(car);
  if (selected === car) selected = cars[0];
  render();
  updateWakeLock();
}

function stopAll(): void {
  if (race.phase === 'countdown' || race.phase === 'running') race.abort();
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

// ---- Battle ---------------------------------------------------------------------

function fire(car: Car, id: WeaponId): void {
  sound.unlock();
  const r = battle.fire(car, id);
  if (!r.ok) {
    if (r.reason === 'Sin energía') sound.empty();
    if (r.reason !== 'Recargando') showToast(r.reason);
    return;
  }
  vibrate(id === 'blaster' ? 15 : 40);
}

function scanTrack(car: Car): void {
  if (!car.ready) return;
  field.scan(car);
  showToast(`${car.state.name} está escaneando la pista: dará una vuelta y frenará`);
}

function startRace(): void {
  sound.unlock();
  const why = race.blocker(cars);
  if (why) return showToast(why);
  race.start(cars);
  showRace();
}

const WEAPON_SOUNDS: Record<WeaponId, () => void> = { blaster: sound.laser, missile: sound.missile, pulse: sound.pulse, shield: sound.shield };

field.addEventListener('track', () => showToast(`Pista escaneada: ${describeTrack(field.lap!)}`));
field.addEventListener('scanfail', () => showToast('No se pudo escanear la pista. Comprueba que el coche está sobre ella.'));
battle.addEventListener('change', () => {
  cockpit?.updateBattle();
  raceView?.update();
});
battle.addEventListener('fire', (e) => {
  const { shooter, weapon, hits } = (e as CustomEvent<FireDetail>).detail;
  WEAPON_SOUNDS[weapon.id]();
  // Let the shot be heard before the impact.
  setTimeout(() => {
    if (hits.some((hit) => hit.knockedOut)) sound.knockout();
    else if (hits.some((hit) => !hit.blocked)) sound.hit();
    else if (hits.length) sound.blocked();
  }, weapon.id === 'missile' ? 350 : 120);
  if (!hits.length) return;
  const text = hits
    .map((hit) => `${hit.target.state.name}${hit.knockedOut ? ' ¡fuera de combate!' : hit.blocked ? ' (bloqueado por escudo)' : ''}`)
    .join(', ');
  showToast(`${weapon.name} de ${shooter.state.name} → ${text}`);
  if (hits.some((hit) => hit.target === selected && !hit.blocked)) vibrate([80, 40, 80]);
});
battle.start();

race.addEventListener('change', () => {
  raceView?.update();
  cockpit?.updateBattle();
});
race.addEventListener('light', () => sound.light());
race.addEventListener('go', () => {
  sound.go();
  vibrate(200);
});
race.addEventListener('lap', (e) => {
  const entry = (e as CustomEvent<Entry>).detail;
  if (entry.laps === race.totalLaps - 1) {
    sound.finalLap();
    showToast(`¡Última vuelta para ${entry.car.state.name}!`);
  } else sound.lap();
});
race.addEventListener('finish', (e) => {
  const entry = (e as CustomEvent<Entry>).detail;
  if (entry.place === 1) {
    sound.win();
    showToast(`🏆 ¡${entry.car.state.name} gana la carrera!`);
  } else {
    sound.finish();
    showToast(`${entry.car.state.name} llega en ${entry.place}.ª posición`);
  }
});

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
  fire,
  start: () => race.phase === 'setup' || race.phase === 'finished' ? startRace() : undefined,
  stopAll,
  notify: (msg) => {
    showToast(msg);
    raceView?.update();
    cockpit?.update();
  },
});

// ---- Rendering --------------------------------------------------------------

let cockpit: Cockpit | undefined;
let raceView: RaceView | undefined;

function dropCockpit(): void {
  cockpit?.destroy();
  cockpit = undefined;
}

function render(): void {
  renderGarage();
  if (raceScreen && cars.length) {
    dropCockpit();
    if (!raceView) {
      raceView = new RaceView({ race, battle, pads, cars: () => cars, scan: scanTrack, start: startRace, toast: showToast });
    }
    if (!raceView.el.isConnected) stage.replaceChildren(raceView.el);
    raceView.update();
    return;
  }
  if (raceView?.el.isConnected) dropCockpit();
  if (!selected) {
    dropCockpit();
    stage.replaceChildren(emptyState());
    return;
  }
  if (cockpit?.car !== selected) {
    dropCockpit();
    cockpit = new Cockpit(selected);
    stage.replaceChildren(cockpit.el);
  }
  cockpit.update();
}

function onCarChange(car: Car): void {
  renderGarage();
  if (cockpit?.car === car) cockpit.update();
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
          title: `${s.name} (tecla ${i + 1})`,
        },
        [
          h('span', { class: 'chip-dot' }),
          h('span', { class: 'chip-name' }, s.name),
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
      demo ? null : h('a', { class: 'btn btn-ghost', href: '?demo' }, 'Probar demo sin coche'),
    ]),
  ]);
}

class Cockpit {
  readonly el: HTMLElement;
  private gaugeArc: SVGPathElement;
  private gaugeTarget: SVGLineElement;
  private speedNum: HTMLElement;
  private targetNum: HTMLElement;
  private battery: HTMLElement;
  private status: HTMLElement;
  private throttleFill: HTMLElement;
  private throttle: HTMLElement;
  private overlay: HTMLElement;
  private swatches: HTMLElement;
  private armorFill: HTMLElement;
  private energyFill: HTMLElement;
  private targetLine: HTMLElement;
  private weaponButtons = new Map<WeaponId, HTMLButtonElement>();
  private trackText: HTMLElement;
  private scanButton: HTMLButtonElement;
  /** Shown instead of the touch controls while a gamepad drives this car. */
  private padPanel: HTMLElement;
  private padText: HTMLElement;
  private touchToggle: HTMLButtonElement;
  private map: MapView;
  /** The player asked for the touch controls even though a pad is driving. */
  private keepTouch = false;
  private dragging = false;

  constructor(readonly car: Car) {
    const svg = gaugeSvg();
    this.gaugeArc = svg.querySelector('.gauge-value')!;
    this.gaugeTarget = svg.querySelector('.gauge-target')!;
    this.speedNum = h('div', { class: 'speed-num' }, '0');
    this.targetNum = h('div', { class: 'speed-target' });
    this.battery = h('div', { class: 'telemetry-item' });
    this.status = h('div', { class: 'telemetry-item' });
    this.throttleFill = h('div', { class: 'throttle-fill' });
    this.throttle = h(
      'div',
      { class: 'throttle', role: 'slider', tabindex: '0', 'aria-label': 'Acelerador', 'aria-valuemin': '0', 'aria-valuemax': String(MAX_SPEED) },
      [this.throttleFill, h('div', { class: 'throttle-label' }, 'ACELERADOR')],
    );
    this.bindThrottle();

    this.overlay = h('div', { class: 'overlay' });
    this.swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color de luces' },
      COLORS.map((c) => h('button', { class: 'swatch', role: 'radio', style: `--c:${c}`, 'data-color': c, 'aria-label': `Color ${c}`, onclick: () => car.setColor(c) })),
    );

    this.armorFill = h('span', { class: 'meter-fill' });
    this.energyFill = h('span', { class: 'meter-fill' });
    this.targetLine = h('div', { class: 'target-line' });
    this.trackText = h('span', { class: 'track-text' });
    this.scanButton = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => scanTrack(car), title: 'El coche da una vuelta despacio para aprender la pista' }, 'Escanear pista');
    this.map = new MapView(field, { cars: () => cars, scan: scanTrack, me: car });
    this.padText = h('p', { class: 'pad-text' });
    this.touchToggle = h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        this.keepTouch = !this.keepTouch;
        this.update();
      },
    });
    this.padPanel = h('div', { class: 'pad-panel' }, [this.padText, h('div', { class: 'pad-map' }, this.map.el)]);

    const hold = (fn: () => void, buzz = 15) => ({
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        if (!car.ready) return;
        fn();
        vibrate(buzz);
      },
    });

    this.el = h('section', { class: 'cockpit', style: `--car:${car.state.color}` }, [
      h('div', { class: 'dash' }, [
        h('div', { class: 'gauge' }, [svg, h('div', { class: 'gauge-readout' }, [this.speedNum, h('div', { class: 'speed-unit' }, 'mm/s'), this.targetNum])]),
        h('div', { class: 'telemetry' }, [this.status, this.battery]),
        h('div', { class: 'combat' }, [
          h('div', { class: 'meter is-armor', 'aria-label': 'Blindaje' }, [h('span', { class: 'meter-label' }, 'Blindaje'), h('span', { class: 'meter-bar' }, this.armorFill)]),
          h('div', { class: 'meter is-energy', 'aria-label': 'Energía' }, [h('span', { class: 'meter-label' }, 'Energía'), h('span', { class: 'meter-bar' }, this.energyFill)]),
          this.targetLine,
        ]),
      ]),
      h('div', { class: 'arms' },
        WEAPONS.map((w) => {
          const b = h('button', { class: `weapon is-${w.id}`, 'aria-label': `${w.name} (${WEAPON_KEYS[w.id]})`, ...hold(() => fire(car, w.id), 0) }, [
            h('span', { class: 'weapon-name' }, w.name),
            h('span', { class: 'weapon-cost' }, `${w.energy} ⚡`),
          ]);
          this.weaponButtons.set(w.id, b);
          return b;
        }),
      ),
      h('div', { class: 'steer' }, [
        h('button', { class: 'btn-pad lane', 'aria-label': 'Carril izquierdo (A)', ...hold(() => car.laneLeft()) }, [icon('left'), h('span', {}, 'Carril')]),
        h('button', { class: 'btn-pad lane', 'aria-label': 'Carril derecho (D)', ...hold(() => car.laneRight()) }, [icon('right'), h('span', {}, 'Carril')]),
        h('button', { class: 'btn-pad uturn', 'aria-label': 'Media vuelta (U)', ...hold(() => car.uTurn()) }, [icon('uturn'), h('span', {}, 'Media vuelta')]),
      ]),
      h('div', { class: 'pedals' }, [
        this.throttle,
        h('div', { class: 'pedal-buttons' }, [
          h('button', { class: 'btn-pad small', 'aria-label': 'Más velocidad (W)', ...hold(() => car.accelerate()) }, icon('up')),
          h('button', { class: 'btn-pad small', 'aria-label': 'Menos velocidad (S)', ...hold(() => car.decelerate()) }, icon('down')),
        ]),
      ]),
      h('button', { class: 'btn-pad brake', 'aria-label': 'Frenar (Espacio)', ...hold(() => car.brake(), 60) }, 'FRENO'),
      this.padPanel,
      h('div', { class: 'car-footer' }, [
        this.swatches,
        h('div', { class: 'track-info' }, [this.trackText, this.scanButton, this.touchToggle]),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => removeCar(car) }, 'Desconectar'),
      ]),
      this.overlay,
    ]);
  }

  update(): void {
    const s = this.car.state;
    this.el.style.setProperty('--car', s.color);

    const actual = Math.min(1, s.speed / MAX_SPEED);
    const target = s.targetSpeed / MAX_SPEED;
    this.gaugeArc.style.strokeDashoffset = String(GAUGE_LEN * (1 - actual));
    this.gaugeTarget.setAttribute('transform', `rotate(${-120 + 240 * target} 100 100)`);
    this.speedNum.textContent = String(Math.round(s.speed));
    this.targetNum.textContent = `objetivo ${s.targetSpeed}`;
    if (!this.dragging) this.throttleFill.style.height = `${target * 100}%`;
    this.throttle.setAttribute('aria-valuenow', String(s.targetSpeed));

    this.battery.replaceChildren(
      icon(s.onCharger ? 'charging' : 'battery'),
      s.battery === undefined ? '—' : `${s.battery}%`,
    );
    this.battery.classList.toggle('is-low', !!s.lowBattery || (s.battery ?? 100) < 20);
    this.status.replaceChildren(h('span', { class: `led is-${s.status}` }), statusText(s));

    this.swatches.querySelectorAll<HTMLElement>('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === s.color)));

    this.updateBattle();

    const blocked = s.status !== 'ready';
    this.el.classList.toggle('is-blocked', blocked);
    this.overlay.replaceChildren(
      ...(blocked
        ? [
            h('div', { class: 'overlay-card' }, [
              s.status === 'disconnected' ? null : h('div', { class: 'spinner' }),
              h('p', {}, s.status === 'connecting' ? `Conectando con ${s.name}…` : s.status === 'reconnecting' ? 'Reconectando…' : (s.error ?? 'Desconectado')),
              s.status === 'disconnected'
                ? h('div', { class: 'overlay-actions' }, [
                    h('button', { class: 'btn btn-primary', onclick: () => void this.car.connect().catch((e) => showToast(errText(e))) }, 'Reconectar'),
                    h('button', { class: 'btn btn-ghost', onclick: () => removeCar(this.car) }, 'Quitar'),
                  ])
                : null,
            ]),
          ]
        : []),
    );
  }

  destroy(): void {
    this.map.destroy();
  }

  /** Armor, energy, cooldowns, target and track. Runs ~10 times a second. */
  updateBattle(): void {
    const f = battle.fighter(this.car);
    if (!f) return;
    const now = performance.now();
    const down = f.downUntil > now;
    this.armorFill.style.width = `${(f.armor / MAX_ARMOR) * 100}%`;
    this.energyFill.style.width = `${(f.energy / MAX_ENERGY) * 100}%`;
    this.el.classList.toggle('is-down', down);
    this.el.classList.toggle('is-shielded', f.shieldUntil > now);

    for (const w of WEAPONS) {
      const b = this.weaponButtons.get(w.id)!;
      const cooling = Math.max(0, f.readyAt[w.id] - now) / w.cooldownMs;
      b.style.setProperty('--cd', cooling.toFixed(3));
      b.classList.toggle('is-off', down || f.energy < w.energy || cooling > 0);
    }

    const target = battle.targetFor(this.car);
    let text: string;
    if (down) text = `¡Fuera de combate! ${Math.ceil((f.downUntil - now) / 1000)} s`;
    else if (field.scanning === this.car) text = 'Escaneando pista…';
    else if (race.isAi(this.car)) text = 'Conduce la IA';
    else if (target) text = `Objetivo: ${target.car.state.name} · ${target.pieces === 0 ? 'a tu lado' : `${target.pieces} ${target.pieces === 1 ? 'pieza' : 'piezas'} delante`}`;
    else text = cars.length > 1 ? 'Sin objetivo a tiro' : 'Conecta otro coche para combatir';
    this.targetLine.textContent = `${text}${f.kills ? ` · Derribos: ${f.kills}` : ''}`;
    this.targetLine.classList.toggle('has-target', !!target && !down);

    const pad = padDriving(this.car);
    const padMode = !!pad && !this.keepTouch;
    this.el.classList.toggle('is-pad', padMode);
    this.touchToggle.hidden = !pad;
    this.touchToggle.textContent = padMode ? 'Mostrar controles' : 'Ocultar controles';
    if (padMode) {
      this.padText.textContent = `🎮 Conduces con el ${pad}. RT acelera · LT frena · LB/RB carril · A/X/L3/R3 armas`;
      this.map.update();
    }

    this.trackText.textContent = field.lap ? `Pista: ${describeTrack(field.lap)}` : field.scanning ? 'Escaneando pista…' : 'Pista sin escanear';
    this.scanButton.disabled = !!field.scanning || race.phase === 'countdown' || race.phase === 'running';
    this.scanButton.textContent = field.lap ? 'Volver a escanear' : 'Escanear pista';
  }

  /** Vertical slider: drag anywhere on it to set the cruise speed; it stays where you leave it. */
  private bindThrottle(): void {
    const setFromPointer = (e: PointerEvent) => {
      const r = this.throttle.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
      this.throttleFill.style.height = `${frac * 100}%`;
      if (this.car.ready) this.car.setSpeed(Math.round((frac * MAX_SPEED) / 10) * 10);
    };
    this.throttle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      this.throttle.setPointerCapture(e.pointerId);
      this.throttle.classList.add('is-dragging');
      setFromPointer(e);
    });
    this.throttle.addEventListener('pointermove', (e) => this.dragging && setFromPointer(e));
    const end = () => {
      this.dragging = false;
      this.throttle.classList.remove('is-dragging');
      this.update();
    };
    this.throttle.addEventListener('pointerup', end);
    this.throttle.addEventListener('pointercancel', end);
    this.throttle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.car.accelerate(50);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.car.decelerate(50);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

const GAUGE_LEN = 2 * Math.PI * 80 * (240 / 360);

function gaugeSvg(): SVGSVGElement {
  // 240° arc from -120° to +120° (0° = straight up).
  const p = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  };
  const arc = `M ${p(-120, 80)} A 80 80 0 1 1 ${p(120, 80)}`;
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const deg = -120 + i * 24;
    return `<line x1="${p(deg, 92).split(' ')[0]}" y1="${p(deg, 92).split(' ')[1]}" x2="${p(deg, 97).split(' ')[0]}" y2="${p(deg, 97).split(' ')[1]}" class="gauge-tick"/>`;
  }).join('');
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 200 175" class="gauge-svg" aria-hidden="true">
    ${ticks}
    <path d="${arc}" class="gauge-track"/>
    <path d="${arc}" class="gauge-value" style="stroke-dasharray:${GAUGE_LEN};stroke-dashoffset:${GAUGE_LEN}"/>
    <line x1="100" y1="8" x2="100" y2="28" class="gauge-target" transform="rotate(-120 100 100)"/>
  </svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

function statusText(s: Car['state']): string {
  if (s.status === 'connecting') return 'Conectando';
  if (s.status === 'reconnecting') return 'Reconectando';
  if (s.status === 'disconnected') return 'Desconectado';
  if (s.onCharger) return 'En el cargador';
  if (s.onTrack === false) return 'Fuera de la pista';
  return s.speed > 0 ? `En pista · pieza ${s.pieceId ?? '?'}` : 'Listo';
}

// ---- Input --------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.repeat && !['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'KeyQ'].includes(e.code)) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Escape') return stopAll();
  if (e.key === '0' && cars.length) return showRace();
  const n = Number(e.key);
  if (n >= 1 && n <= cars.length) return select(cars[n - 1]);
  const car = selected;
  if (!car?.ready || race.isAi(car)) return;
  const actions: Record<string, () => void> = {
    KeyW: () => car.accelerate(),
    ArrowUp: () => car.accelerate(),
    KeyS: () => car.decelerate(),
    ArrowDown: () => car.decelerate(),
    KeyA: () => car.laneLeft(),
    ArrowLeft: () => car.laneLeft(),
    KeyD: () => car.laneRight(),
    ArrowRight: () => car.laneRight(),
    Space: () => car.brake(),
    KeyU: () => car.uTurn(),
    KeyQ: () => fire(car, 'blaster'),
    KeyE: () => fire(car, 'missile'),
    KeyR: () => fire(car, 'pulse'),
    KeyF: () => fire(car, 'shield'),
  };
  const action = actions[e.code];
  if (action) {
    e.preventDefault();
    action();
  }
});

// ---- Misc ------------------------------------------------------------------------

function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500);
}

function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

/** Keep the phone screen on while driving. */
let wakeLock: WakeLockSentinel | undefined;
async function updateWakeLock(): Promise<void> {
  const want = cars.some((c) => c.state.status !== 'disconnected');
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = undefined));
    } else if (!want && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* not allowed right now */
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && updateWakeLock());

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

render();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
