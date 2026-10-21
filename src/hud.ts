import { MAX_ARMOR, MAX_ENERGY, WEAPONS, type WeaponId } from './battle';
import { MAX_SPEED, carPlace } from './car';
import { vibrate, type CockpitModel } from './cockpit';
import { h } from './dom';
import { MapView } from './mapview';
import { LIGHTS } from './race';
import type { RaceSummary } from './remote';
import { t } from './i18n';
import { enOrdinal, enSuffix } from './racestrip';
import { goLandscape } from './shell';
import { toKmh } from './stats';
import { TiltSteer } from './tilt';

/**
 * Full-screen racing HUD, laid out like a mobile racing game: position and lap top-left,
 * minimap top-right, big countdown in the middle, brake under the left thumb, gas under the
 * right one, speed and a steering wheel (that turns with the phone) at the bottom, weapons
 * as round buttons next to the right thumb. Used on the host and on guest phones.
 */

export interface HudModel extends CockpitModel {
  race(): RaceSummary | undefined;
  /** Campaign goal and progress, if a level is being played. */
  goal(): string | undefined;
  openStandings(): void;
  /** The pause button: stop the race (host) or brake (guest). */
  exit(): void;
}

const WEAPON_ICONS: Record<WeaponId, string> = { blaster: '⚡', missile: '🚀', pulse: '💥', shield: '🛡️' };
const TILT_PREF = 'overdrive.tilt.on';

export class RaceHud {
  readonly el: HTMLElement;
  private pos: HTMLElement;
  private posOf: HTMLElement;
  private lap: HTMLElement;
  private armor: HTMLElement;
  private energy: HTMLElement;
  private target: HTMLElement;
  private goalEl: HTMLElement;
  private count: HTMLElement;
  private countText: HTMLElement;
  private bulbs: HTMLElement[];
  private speed: HTMLElement;
  private speedSub: HTMLElement;
  private wheel: HTMLElement;
  private gasFill: HTMLElement;
  private gas: HTMLElement;
  private weapons = new Map<WeaponId, HTMLButtonElement>();
  private fx: HTMLElement;
  private tiltBtn: HTMLButtonElement;
  private map: MapView;
  private tilt?: TiltSteer;
  private lastPhase?: string;
  private goTimer?: ReturnType<typeof setTimeout>;
  private lastArmor = MAX_ARMOR;
  private dragging = false;

  constructor(readonly model: HudModel) {
    const car = model.car;
    const tap = (fn: () => void, buzz = 12) => ({
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        if (!car.ready) return;
        fn();
        vibrate(buzz);
      },
    });

    this.pos = h('span', { class: 'hud-pos-n' }, '–');
    this.posOf = h('span', { class: 'hud-pos-of' });
    this.lap = h('div', { class: 'hud-lap' });
    this.armor = h('span');
    this.energy = h('span');
    this.target = h('div', { class: 'hud-target' });
    this.goalEl = h('div', { class: 'hud-goal' });
    this.bulbs = Array.from({ length: LIGHTS }, () => h('span', { class: 'hud-bulb' }));
    this.countText = h('div', { class: 'hud-count-text' });
    this.count = h('div', { class: 'hud-count' }, [h('div', { class: 'hud-bulbs' }, this.bulbs), this.countText]);
    this.speed = h('span', { class: 'hud-speed-n' }, '0');
    this.speedSub = h('span', { class: 'hud-speed-sub' });
    this.wheel = h('div', { class: 'hud-wheel', 'aria-hidden': 'true' });
    this.wheel.innerHTML = `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="32" cy="32" r="6" fill="currentColor"/><path d="M8 30 H26 M38 30 H56 M32 38 V58" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M27 6 h10" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/></svg>`;
    this.gasFill = h('div', { class: 'hud-gas-fill' });
    this.gas = h('div', { class: 'hud-gas', role: 'slider', 'aria-label': t('Acelerador', 'Throttle'), 'aria-valuemin': '0', 'aria-valuemax': String(MAX_SPEED), tabindex: '0' }, [
      this.gasFill,
      h('span', { class: 'hud-pedal-label' }, 'GAS'),
    ]);
    this.bindGas();
    this.fx = h('div', { class: 'hud-fx' });
    this.map = new MapView(() => model.map());
    this.tiltBtn = h('button', { class: 'hud-mini', onclick: () => void this.toggleTilt() });

    const weapons = h('div', { class: 'hud-weapons' },
      WEAPONS.map((w) => {
        const b = h('button', { class: `hud-weapon is-${w.id}`, 'aria-label': t(`${w.name}, ${w.energy} de energía`, `${w.name}, ${w.energy} energy`), ...tap(() => model.fire(w.id), 0) }, [
          h('span', { class: 'hud-weapon-icon' }, WEAPON_ICONS[w.id]),
          h('span', { class: 'hud-weapon-name' }, w.name),
        ]);
        this.weapons.set(w.id, b);
        return b;
      }),
    );

    this.el = h('section', { class: 'hud', style: `--car:${model.state().color}` }, [
      this.fx,
      h('div', { class: 'hud-tl' }, [
        h('div', { class: 'hud-pos' }, [this.pos, this.posOf]),
        this.lap,
        h('div', { class: 'hud-bars' }, [h('div', { class: 'hud-bar is-armor' }, this.armor), h('div', { class: 'hud-bar is-energy' }, this.energy)]),
        this.target,
      ]),
      this.goalEl,
      h('button', { class: 'hud-pause', onclick: () => model.exit(), 'aria-label': t('Parar la carrera', 'Stop the race') }, '⏸'),
      h('button', { class: 'hud-map', onclick: () => model.openStandings(), 'aria-label': t('Ver clasificación', 'See standings') }, this.map.el),
      this.count,
      h('div', { class: 'hud-brake', 'aria-label': t('Freno', 'Brake'), role: 'button', ...tap(() => car.brake(), 50) }, [h('span', { class: 'hud-pedal-label' }, t('FRENO', 'BRAKE'))]),
      h('div', { class: 'hud-center' }, [
        h('button', { class: 'hud-lane is-left', 'aria-label': t('Carril izquierdo', 'Left lane'), ...tap(() => car.laneLeft()) }, '◀'),
        h('div', { class: 'hud-speed' }, [this.wheel, h('div', { class: 'hud-speed-read' }, [this.speed, h('span', { class: 'hud-speed-unit' }, 'km/h'), this.speedSub])]),
        h('button', { class: 'hud-lane is-right', 'aria-label': t('Carril derecho', 'Right lane'), ...tap(() => car.laneRight()) }, '▶'),
        h('div', { class: 'hud-tilt-actions' }, [
          h('button', { class: 'hud-mini', onclick: () => this.tilt?.recenter() }, t('Centrar', 'Center')),
          h('button', {
            class: 'hud-mini',
            onclick: () => {
              TiltSteer.inverted = !TiltSteer.inverted;
              this.tilt?.recenter();
              model.toast(TiltSteer.inverted ? t('Giro invertido', 'Steering inverted') : t('Giro normal', 'Steering normal'));
            },
          }, t('Invertir', 'Invert')),
          this.tiltBtn,
        ]),
      ]),
      weapons,
      this.gas,
      h('div', { class: 'rotate-hint hud-rotate' }, [
        h('div', { class: 'rotate-phone', 'aria-hidden': 'true' }),
        h('p', {}, t('Gira el móvil y sujétalo en horizontal, como un volante.', 'Turn your phone sideways and hold it like a steering wheel.')),
        h('div', { class: 'tilt-actions' }, [
          h('button', { class: 'btn btn-primary', onclick: () => void goLandscape() }, t('Poner en horizontal', 'Go landscape')),
          h('button', { class: 'btn btn-ghost', onclick: () => this.el.classList.add('is-portrait-ok') }, t('Seguir en vertical', 'Stay in portrait')),
        ]),
      ]),
    ]);

    this.el.classList.toggle('is-touch', TiltSteer.available());
    if (TiltSteer.available() && tiltWanted()) void this.toggleTilt(true);
    this.update();
  }

  update(): void {
    const m = this.model;
    const s = m.state();
    this.el.style.setProperty('--car', s.color);

    // Position and lap
    const r = m.race();
    const meIdx = r ? r.standings.findIndex((x) => x.me) : -1;
    const mine = r?.standings[meIdx];
    const myPos = mine ? (mine.place ?? meIdx + 1) : undefined;
    this.pos.textContent = myPos ? String(myPos) : '–';
    this.posOf.textContent = r ? t(`º/${r.standings.length}`, `${myPos ? enSuffix(myPos) : ''}/${r.standings.length}`) : '';
    const lapNow = r ? Math.min((mine?.laps ?? 0) + 1, r.totalLaps) : 0;
    this.lap.textContent =
      !r || r.phase === 'grid' || r.phase === 'countdown'
        ? t(`${r?.totalLaps ?? ''} VUELTAS`, `${r?.totalLaps ?? ''} ${r?.totalLaps === 1 ? 'LAP' : 'LAPS'}`)
        : mine?.place
          ? t('META', 'FINISH')
          : t(`VUELTA ${lapNow}/${r.totalLaps}`, `LAP ${lapNow}/${r.totalLaps}`);

    // Countdown and big messages
    const phase = r?.phase;
    if (phase === 'running' && this.lastPhase === 'countdown') {
      this.flash(t('¡YA!', 'GO!'));
    }
    this.lastPhase = phase;
    if (phase === 'grid') this.showCount(t('A LA SALIDA', 'TO THE GRID'), 0);
    else if (phase === 'countdown') this.showCount(t('PREPARADOS', 'GET READY'), r!.lights);
    else if (mine?.place) this.showCount(mine.place === 1 ? t('¡GANAS!', 'YOU WIN!') : t(`${mine.place}º`, enOrdinal(mine.place)), 0, true);
    else if (!this.goTimer) this.count.classList.remove('is-on');

    // Goal
    const goal = m.goal();
    this.goalEl.hidden = !goal;
    this.goalEl.textContent = goal ?? '';

    this.map.update();

    // Speed
    this.speed.textContent = String(toKmh(s.speed));
    this.speedSub.textContent = s.targetSpeed ? t(`crucero ${toKmh(s.targetSpeed)}`, `cruise ${toKmh(s.targetSpeed)}`) : '';
    if (!this.dragging) this.gasFill.style.height = `${(s.targetSpeed / MAX_SPEED) * 100}%`;
    this.gas.setAttribute('aria-valuenow', String(s.targetSpeed));

    // Armor, energy, weapons
    const f = m.combat();
    if (f) {
      this.armor.style.width = `${(f.armor / MAX_ARMOR) * 100}%`;
      this.energy.style.width = `${(f.energy / MAX_ENERGY) * 100}%`;
      if (f.armor < this.lastArmor) this.hit();
      this.lastArmor = f.armor;
      this.el.classList.toggle('is-down', f.downMs > 0);
      this.el.classList.toggle('is-shielded', f.shielded);
      for (const w of WEAPONS) {
        const b = this.weapons.get(w.id)!;
        const cooling = f.cooling[w.id] ?? 0;
        b.style.setProperty('--cd', String(Math.round(cooling * 360)));
        b.classList.toggle('is-off', f.downMs > 0 || f.energy < w.energy || cooling > 0);
      }
      if (f.downMs > 0) this.showCount(t('FUERA DE COMBATE', 'KNOCKED OUT'), 0, true);
    }
    // Off the track or on the charger: the car can't race until it's back on the track.
    const place = carPlace(s);
    this.el.classList.toggle('is-off-track', place === 'off');
    if (place === 'off') this.showCount(t('¡FUERA DE PISTA! Vuelve a ponerlo', 'OFF THE TRACK! Put it back'), 0, true);
    else if (place === 'charger') this.showCount(t('EN EL CARGADOR', 'ON THE CHARGER'), 0, true);

    const tg = m.target();
    this.target.textContent = tg.hot ? `🎯 ${tg.text.replace(/^(Objetivo|Target): /, '')}` : '';

    // Gamepad: no touch controls, bigger map.
    const pad = m.padName();
    this.el.classList.toggle('is-pad', !!pad);
    this.el.classList.toggle('is-blocked', s.status !== 'ready');
    this.updateTilt();
  }

  destroy(): void {
    this.map.destroy();
    this.tilt?.disable();
    clearTimeout(this.goTimer);
  }

  private showCount(text: string, lit: number, small = false): void {
    if (this.goTimer) return;
    this.count.classList.add('is-on');
    this.count.classList.toggle('is-small', small);
    this.count.classList.toggle('has-bulbs', !small && (lit > 0 || text === t('PREPARADOS', 'GET READY')));
    this.countText.textContent = text;
    this.bulbs.forEach((b, i) => b.classList.toggle('is-lit', i < lit));
  }

  private flash(text: string): void {
    clearTimeout(this.goTimer);
    this.goTimer = undefined;
    this.showCount(text, 0);
    this.count.classList.add('is-go');
    this.goTimer = setTimeout(() => {
      this.goTimer = undefined;
      this.count.classList.remove('is-on', 'is-go');
    }, 1300);
  }

  private hit(): void {
    this.fx.classList.remove('is-hit');
    void this.fx.offsetWidth; // restart the animation
    this.fx.classList.add('is-hit');
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
    const on = force ?? !this.tilt.enabled;
    if (on) {
      const ok = await this.tilt.enable();
      if (!ok && force === undefined) this.model.toast(t('No se puede usar el giroscopio en este navegador', "Can't use the gyroscope in this browser"));
    } else this.tilt.disable();
    if (force === undefined) setTiltWanted(this.tilt.enabled);
    this.updateTilt();
  }

  private updateTilt(): void {
    const on = !!this.tilt?.enabled;
    this.el.classList.toggle('is-tilt', on);
    this.tiltBtn.textContent = on ? t('Botones', 'Buttons') : t('Volante', 'Wheel');
    this.tiltBtn.hidden = !TiltSteer.available();
    const deg = Math.max(-45, Math.min(45, this.tilt?.tilt ?? 0));
    this.wheel.style.transform = `rotate(${deg * 2}deg)`;
    this.wheel.classList.toggle('is-hot', Math.abs(deg) >= 18);
  }

  /** The gas pedal: drag up for more speed; it stays where you leave it (cruise control). */
  private bindGas(): void {
    const car = this.model.car;
    const set = (e: PointerEvent) => {
      const r = this.gas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
      this.gasFill.style.height = `${frac * 100}%`;
      if (car.ready) car.setSpeed(Math.round((frac * MAX_SPEED) / 10) * 10);
    };
    this.gas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dragging = true;
      this.gas.setPointerCapture(e.pointerId);
      this.gas.classList.add('is-pressed');
      set(e);
    });
    this.gas.addEventListener('pointermove', (e) => this.dragging && set(e));
    const end = () => {
      this.dragging = false;
      this.gas.classList.remove('is-pressed');
      this.update();
    };
    this.gas.addEventListener('pointerup', end);
    this.gas.addEventListener('pointercancel', end);
    this.gas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') car.accelerate(50);
      else if (e.key === 'ArrowDown') car.decelerate(50);
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
