import './styles.css';
import { Car, MAX_SPEED } from './car';
import { SimTransport } from './sim';
import { bluetoothAvailable, pickCar, type Transport } from './transport';
import { setupGamepad } from './gamepad';
import { h, icon } from './dom';

const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ffffff'];
const demo = new URLSearchParams(location.search).has('demo');

const cars: Car[] = [];
let selected: Car | undefined;
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
  if (selected === car) selected = cars[0];
  render();
  updateWakeLock();
}

function stopAll(): void {
  cars.forEach((c) => c.ready && c.brake());
  vibrate([40, 40, 40]);
}

function select(car: Car | undefined): void {
  selected = car;
  render();
}

// ---- Rendering --------------------------------------------------------------

let cockpit: Cockpit | undefined;

function render(): void {
  renderGarage();
  if (!selected) {
    cockpit = undefined;
    stage.replaceChildren(emptyState());
    return;
  }
  if (cockpit?.car !== selected) {
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
    ...cars.map((car, i) => {
      const s = car.state;
      return h(
        'button',
        {
          class: `chip ${car === selected ? 'is-active' : ''} is-${s.status}`,
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
      ]),
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
      h('div', { class: 'car-footer' }, [
        this.swatches,
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
  if (e.repeat && !['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) return;
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Escape') return stopAll();
  const n = Number(e.key);
  if (n >= 1 && n <= cars.length) return select(cars[n - 1]);
  const car = selected;
  if (!car?.ready) return;
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
  };
  const action = actions[e.code];
  if (action) {
    e.preventDefault();
    action();
  }
});

setupGamepad(() => (selected?.ready ? selected : undefined), (msg) => showToast(msg));

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
