import { h } from './dom';
import { t } from './i18n';
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
    else if (r.phase === 'grid') text = t('Colocándose en la línea de salida…', 'Lining up on the grid…');
    else if (r.phase === 'countdown') text = t('Preparados…', 'Get ready…');
    else if (mine?.place) text = mine.place === 1 ? t('🏆 ¡Has ganado!', '🏆 You won!') : t(`Llegas ${mine.place}.º`, `You finish ${enOrdinal(mine.place)}`);
    else if (r.phase === 'running') {
      const lap = Math.min((mine?.laps ?? 0) + 1, r.totalLaps);
      text = t(`Vuelta ${lap}/${r.totalLaps} · ${me + 1}.º de ${r.standings.length}`, `Lap ${lap}/${r.totalLaps} · ${enOrdinal(me + 1)} of ${r.standings.length}`);
    } else text = r.winner ? t(`🏆 Gana ${r.winner}`, `🏆 ${r.winner} wins`) : t('Carrera terminada', 'Race over');
    const lights = h('div', { class: 'mini-lights', 'aria-hidden': 'true' }, Array.from({ length: LIGHTS }, (_, i) => h('span', { class: `bulb ${i < r.lights ? 'is-lit' : ''}` })));
    lights.hidden = r.phase !== 'countdown';
    this.el.replaceChildren(lights, h('span', { class: 'guest-race-text' }, text), h('button', { class: 'btn btn-ghost btn-sm', onclick: this.openStandings }, t('Clasificación', 'Standings')));
  }
}

/** English ordinal suffix: 1 → 'st', 2 → 'nd', 3 → 'rd', 11 → 'th'… */
export function enSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

/** English ordinal: 1st, 2nd, 3rd, 4th… */
export const enOrdinal = (n: number): string => `${n}${enSuffix(n)}`;
