import { MAX_ARMOR, MAX_ENERGY, WEAPONS, type WeaponId } from './battle';
import { MAX_SPEED, type CarState } from './car';
import { h, icon } from './dom';
import { MapView, type MapSource } from './mapview';
import { goLandscape } from './shell';
import { TiltSteer } from './tilt';

const TILT_PREF = 'overdrive.tilt.on';

/**
 * Driving screen for one car. It does not know where the car lives: on the host the model
 * reads the local game, on a guest phone it reads the host's updates and sends actions back.
 */

export const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2', '#ffffff'];
export const WEAPON_KEYS: Record<WeaponId, string> = { blaster: 'Q', missile: 'E', pulse: 'R', shield: 'F' };

/** Anything that can be driven: a local car, or a guest's remote control of one. */
export interface Drivable {
  readonly ready: boolean;
  setSpeed(speed: number): void;
  accelerate(step?: number): void;
  decelerate(step?: number): void;
  brake(): void;
  laneLeft(): void;
  laneRight(): void;
  uTurn(): void;
  setColor(color: string): void;
}

export interface CombatView {
  armor: number;
  energy: number;
  /** ms left knocked out (0 = racing). */
  downMs: number;
  shielded: boolean;
  /** Cooldown left for each weapon, 0..1. */
  cooling: Record<WeaponId, number>;
}

export interface CockpitModel {
  car: Drivable;
  state(): CarState;
  combat(): CombatView | undefined;
  /** Line under the meters: target, knocked out, scanning, AI… */
  target(): { text: string; hot: boolean };
  track(): { text: string; canScan: boolean; rescan: boolean };
  /** Name of the gamepad driving this car, if one is. */
  padName(): string | undefined;
  map(): MapSource;
  fire(id: WeaponId): void;
  scan(): void;
  reconnect(): void;
  remove(): void;
  removeLabel: string;
  toast(msg: string): void;
}

export class Cockpit {
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
  private padText: HTMLElement;
  private touchToggle: HTMLButtonElement;
  private map: MapView;
  /** The player asked for the touch controls even though a pad is driving. */
  private keepTouch = false;
  private dragging = false;
  /** Racing: only the controls, and steering by tilting the phone when it can. */
  private race = false;
  private tilt?: TiltSteer;
  private tiltBar: HTMLElement;
  private tiltDot: HTMLElement;
  private tiltBtn: HTMLButtonElement;
  private rotateHint: HTMLElement;

  constructor(readonly model: CockpitModel) {
    const car = model.car;
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
    this.scanButton = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => model.scan(), title: 'El coche da una vuelta despacio para aprender la pista' }, 'Escanear pista');
    this.map = new MapView(() => model.map());
    this.padText = h('p', { class: 'pad-text' });
    this.touchToggle = h('button', {
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        this.keepTouch = !this.keepTouch;
        this.update();
      },
    });

    this.tiltDot = h('span', { class: 'tilt-dot' });
    this.tiltBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => void this.toggleTilt() });
    this.tiltBar = h('div', { class: 'tilt-bar' }, [
      h('span', { class: 'tilt-label' }, '📱 Inclina para cambiar de carril'),
      h('div', { class: 'tilt-track', 'aria-hidden': 'true' }, [h('span', { class: 'tilt-mark is-left' }), h('span', { class: 'tilt-mark is-right' }), this.tiltDot]),
      h('div', { class: 'tilt-actions' }, [
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.tilt?.recenter() }, 'Centrar'),
        h('button', {
          class: 'btn btn-ghost btn-sm',
          title: 'Si al inclinar a la derecha el coche se va a la izquierda',
          onclick: () => {
            TiltSteer.inverted = !TiltSteer.inverted;
            this.tilt?.recenter();
            model.toast(TiltSteer.inverted ? 'Giro invertido' : 'Giro normal');
          },
        }, 'Invertir'),
        this.tiltBtn,
      ]),
    ]);
    // Racing on a phone: hold it sideways like a steering wheel.
    this.rotateHint = h('div', { class: 'rotate-hint' }, [
      h('div', { class: 'rotate-phone', 'aria-hidden': 'true' }),
      h('p', {}, 'Gira el móvil y sujétalo en horizontal, como un volante: inclínalo para cambiar de carril.'),
      h('div', { class: 'tilt-actions' }, [
        h('button', { class: 'btn btn-primary', onclick: () => void goLandscape() }, 'Poner en horizontal'),
        h('button', { class: 'btn btn-ghost', onclick: () => this.el.classList.add('is-portrait-ok') }, 'Seguir en vertical'),
      ]),
    ]);

    const hold = (fn: () => void, buzz = 15) => ({
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        if (!car.ready) return;
        fn();
        vibrate(buzz);
      },
    });

    this.el = h('section', { class: 'cockpit', style: `--car:${model.state().color}` }, [
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
          const b = h('button', { class: `weapon is-${w.id}`, 'aria-label': `${w.name} (${WEAPON_KEYS[w.id]})`, ...hold(() => model.fire(w.id), 0) }, [
            h('span', { class: 'weapon-name' }, w.name),
            h('span', { class: 'weapon-cost' }, `${w.energy} ⚡`),
          ]);
          this.weaponButtons.set(w.id, b);
          return b;
        }),
      ),
      h('div', { class: 'steer' }, [
        this.tiltBar,
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
      h('div', { class: 'pad-panel' }, [this.padText, h('div', { class: 'pad-map' }, this.map.el)]),
      h('div', { class: 'car-footer' }, [
        this.swatches,
        h('div', { class: 'track-info' }, [this.trackText, this.scanButton, this.touchToggle]),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => model.remove() }, model.removeLabel),
      ]),
      this.rotateHint,
      this.overlay,
    ]);
  }

  update(): void {
    const s = this.model.state();
    this.el.style.setProperty('--car', s.color);

    const actual = Math.min(1, s.speed / MAX_SPEED);
    const target = s.targetSpeed / MAX_SPEED;
    this.gaugeArc.style.strokeDashoffset = String(GAUGE_LEN * (1 - actual));
    this.gaugeTarget.setAttribute('transform', `rotate(${-120 + 240 * target} 100 100)`);
    this.speedNum.textContent = String(Math.round(s.speed));
    this.targetNum.textContent = `objetivo ${s.targetSpeed}`;
    if (!this.dragging) this.throttleFill.style.height = `${target * 100}%`;
    this.throttle.setAttribute('aria-valuenow', String(s.targetSpeed));

    this.battery.replaceChildren(icon(s.onCharger ? 'charging' : 'battery'), s.battery === undefined ? '—' : `${s.battery}%`);
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
                    h('button', { class: 'btn btn-primary', onclick: () => this.model.reconnect() }, 'Reconectar'),
                    h('button', { class: 'btn btn-ghost', onclick: () => this.model.remove() }, 'Quitar'),
                  ])
                : null,
            ]),
          ]
        : []),
    );
  }

  destroy(): void {
    this.map.destroy();
    this.tilt?.disable();
  }

  /**
   * Race mode: only what's needed to drive (throttle, brake, weapons, armor/energy) and, on a
   * phone, steering by tilting it instead of the lane buttons.
   */
  setRaceMode(on: boolean): void {
    if (on === this.race) return;
    this.race = on;
    this.el.classList.toggle('is-race', on);
    // On a phone the lanes are changed by tilting it: no arrow buttons while racing.
    this.el.classList.toggle('is-touch', on && TiltSteer.available());
    if (on && TiltSteer.available() && tiltWanted()) void this.toggleTilt(true);
    if (!on) this.tilt?.disable();
    this.updateTilt();
  }

  private async toggleTilt(force?: boolean): Promise<void> {
    const car = this.model.car;
    if (!this.tilt) {
      this.tilt = new TiltSteer(
        () => car.ready && car.laneLeft(),
        () => car.ready && car.laneRight(),
      );
      this.tilt.addEventListener('change', () => this.updateTilt());
    }
    const turnOn = force ?? !this.tilt.enabled;
    if (turnOn) {
      const ok = await this.tilt.enable();
      if (!ok && force === undefined) this.model.toast('No se puede usar el giroscopio en este navegador');
    } else this.tilt.disable();
    if (force === undefined) setTiltWanted(this.tilt.enabled);
    this.updateTilt();
  }

  private updateTilt(): void {
    const available = this.race && TiltSteer.available();
    const on = available && !!this.tilt?.enabled;
    this.tiltBar.hidden = !available;
    this.el.classList.toggle('is-tilt', on);
    this.tiltBtn.textContent = on ? 'Botones' : 'Activar';
    const t = this.tilt?.tilt ?? 0;
    this.tiltDot.style.left = `${50 + (Math.max(-30, Math.min(30, t)) / 30) * 50}%`;
    this.tiltDot.classList.toggle('is-hot', Math.abs(t) >= 18);
  }

  /** Armor, energy, cooldowns, target and track. Runs ~10 times a second. */
  updateBattle(): void {
    const f = this.model.combat();
    if (f) {
      const down = f.downMs > 0;
      this.armorFill.style.width = `${(f.armor / MAX_ARMOR) * 100}%`;
      this.energyFill.style.width = `${(f.energy / MAX_ENERGY) * 100}%`;
      this.el.classList.toggle('is-down', down);
      this.el.classList.toggle('is-shielded', f.shielded);
      for (const w of WEAPONS) {
        const b = this.weaponButtons.get(w.id)!;
        const cooling = f.cooling[w.id] ?? 0;
        b.style.setProperty('--cd', cooling.toFixed(3));
        b.classList.toggle('is-off', down || f.energy < w.energy || cooling > 0);
      }
    }
    const t = this.model.target();
    this.targetLine.textContent = t.text;
    this.targetLine.classList.toggle('has-target', t.hot);

    const pad = this.model.padName();
    const padMode = !!pad && !this.keepTouch;
    this.el.classList.toggle('is-pad', padMode);
    this.touchToggle.hidden = !pad;
    this.touchToggle.textContent = padMode ? 'Mostrar controles' : 'Ocultar controles';
    if (padMode) {
      this.padText.textContent = `🎮 Conduces con el ${pad}. RT acelera · LT frena · LB/RB carril · A/X/L3/R3 armas`;
      this.map.update();
    }

    const track = this.model.track();
    this.trackText.textContent = track.text;
    this.scanButton.disabled = !track.canScan;
    this.scanButton.textContent = track.rescan ? 'Volver a escanear' : 'Escanear pista';
  }

  /** Vertical slider: drag anywhere on it to set the cruise speed; it stays where you leave it. */
  private bindThrottle(): void {
    const car = this.model.car;
    const setFromPointer = (e: PointerEvent) => {
      const r = this.throttle.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
      this.throttleFill.style.height = `${frac * 100}%`;
      if (car.ready) car.setSpeed(Math.round((frac * MAX_SPEED) / 10) * 10);
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
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') car.accelerate(50);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') car.decelerate(50);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

function tiltWanted(): boolean {
  try {
    return localStorage.getItem(TILT_PREF) !== '0';
  } catch {
    return true;
  }
}

function setTiltWanted(on: boolean): void {
  try {
    localStorage.setItem(TILT_PREF, on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

/** Keyboard driving for whatever car is on screen. */
export function keyAction(code: string, car: Drivable, fire: (id: WeaponId) => void): (() => void) | undefined {
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
    KeyQ: () => fire('blaster'),
    KeyE: () => fire('missile'),
    KeyR: () => fire('pulse'),
    KeyF: () => fire('shield'),
  };
  return actions[code];
}

/** Keys that keep acting while held down. */
export const REPEAT_KEYS = ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'KeyQ'];

export function targetText(t: { name: string; pieces: number } | undefined, others: boolean): string {
  if (t) return `Objetivo: ${t.name} · ${t.pieces === 0 ? 'a tu lado' : `${t.pieces} ${t.pieces === 1 ? 'pieza' : 'piezas'} delante`}`;
  return others ? 'Sin objetivo a tiro' : 'Conecta otro coche para combatir';
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
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

function statusText(s: CarState): string {
  if (s.status === 'connecting') return 'Conectando';
  if (s.status === 'reconnecting') return 'Reconectando';
  if (s.status === 'disconnected') return 'Desconectado';
  if (s.onCharger) return 'En el cargador';
  if (s.onTrack === false) return 'Fuera de la pista';
  return s.speed > 0 ? `En pista · pieza ${s.pieceId ?? '?'}` : 'Listo';
}
