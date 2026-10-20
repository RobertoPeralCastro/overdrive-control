import { h } from './dom';
import { LIGHTS } from './race';
import type { RaceSummary } from './remote';

/**
 * Race status shown above a cockpit while racing: start lights, lap and position, and a button
 * to see the full standings. Used on the host and on guest phones.
 */
export class RaceStrip {
  readonly el: HTMLElement;

  /** `idleText`: what to show before the race starts (nothing if omitted). */
  constructor(
    private openStandings: () => void,
    private idleText?: string,
  ) {
    this.el = h('div', { class: 'guest-race' });
  }

  update(r: RaceSummary | undefined): void {
    if (!r || (r.phase === 'setup' && !this.idleText)) {
      this.el.replaceChildren();
      return;
    }
    const me = r.standings.findIndex((s) => s.me);
    const mine = r.standings[me];
    let text: string;
    if (r.phase === 'setup') text = this.idleText!;
    else if (r.phase === 'grid') text = 'Colocándose en la línea de salida…';
    else if (r.phase === 'countdown') text = 'Preparados…';
    else if (mine?.place) text = mine.place === 1 ? '🏆 ¡Has ganado!' : `Llegas ${mine.place}.º`;
    else if (r.phase === 'running') text = `Vuelta ${Math.min((mine?.laps ?? 0) + 1, r.totalLaps)}/${r.totalLaps} · ${me + 1}.º de ${r.standings.length}`;
    else text = r.winner ? `🏆 Gana ${r.winner}` : 'Carrera terminada';
    const lights = h('div', { class: 'mini-lights', 'aria-hidden': 'true' }, Array.from({ length: LIGHTS }, (_, i) => h('span', { class: `bulb ${i < r.lights ? 'is-lit' : ''}` })));
    lights.hidden = r.phase !== 'countdown';
    this.el.replaceChildren(lights, h('span', { class: 'guest-race-text' }, text), h('button', { class: 'btn btn-ghost btn-sm', onclick: this.openStandings }, 'Clasificación'));
  }
}
