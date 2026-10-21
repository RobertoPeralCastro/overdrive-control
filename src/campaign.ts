import type { AiLevel } from './ai';
import type { Battle, FireDetail } from './battle';
import type { Car } from './car';
import { t } from './i18n';
import type { Entry, Race } from './race';
import type { RaceRecorder } from './stats';

/**
 * Campaign: 10 levels against the AI, each with its own challenge. Levels unlock one after the
 * other and progress is saved on this phone.
 */

export type Goal =
  | { kind: 'win' }
  | { kind: 'top'; place: number }
  | { kind: 'lead'; seconds: number }
  | { kind: 'missiles'; count: number }
  | { kind: 'knockouts'; count: number }
  | { kind: 'pushOff' }
  | { kind: 'survive' }
  | { kind: 'fastLap' };

export interface Level {
  id: number;
  name: string;
  brief: string;
  laps: number;
  weapons: boolean;
  /** One AI car per entry; needs that many extra cars connected. */
  rivals: AiLevel[];
  goal: Goal;
}

export const LEVELS: Level[] = [
  { id: 1, name: t('Primera carrera', 'First race'), brief: t('Gana a la IA fácil en 2 vueltas. Sin armas.', 'Beat the easy AI over 2 laps. No weapons.'), laps: 2, weapons: false, rivals: ['easy'], goal: { kind: 'win' } },
  { id: 2, name: t('Líder', 'Leader'), brief: t('Ve en cabeza al menos 20 segundos en 3 vueltas.', 'Lead for at least 20 seconds over 3 laps.'), laps: 3, weapons: false, rivals: ['normal'], goal: { kind: 'lead', seconds: 20 } },
  { id: 3, name: t('Puntería', 'Sharpshooter'), brief: t('Da 3 misilazos al rival en 4 vueltas.', 'Hit the rival with 3 missiles over 4 laps.'), laps: 4, weapons: true, rivals: ['easy'], goal: { kind: 'missiles', count: 3 } },
  { id: 4, name: t('Superviviente', 'Survivor'), brief: t('Completa 5 vueltas sin que te destruyan el coche.', 'Complete 5 laps without getting your car destroyed.'), laps: 5, weapons: true, rivals: ['normal'], goal: { kind: 'survive' } },
  { id: 5, name: t('A empujones', 'Push and shove'), brief: t('Saca al rival de la pista. Sin armas: solo carrocería.', 'Push the rival off the track. No weapons: bodywork only.'), laps: 3, weapons: false, rivals: ['easy'], goal: { kind: 'pushOff' } },
  { id: 6, name: t('Duelo', 'Duel'), brief: t('Gana a la IA normal en 3 vueltas, con armas.', 'Beat the normal AI over 3 laps, with weapons.'), laps: 3, weapons: true, rivals: ['normal'], goal: { kind: 'win' } },
  { id: 7, name: t('Cazador', 'Hunter'), brief: t('Deja fuera de combate al rival 2 veces en 4 vueltas.', 'Knock out the rival twice over 4 laps.'), laps: 4, weapons: true, rivals: ['normal'], goal: { kind: 'knockouts', count: 2 } },
  { id: 8, name: t('Contrarreloj', 'Time attack'), brief: t('Haz la vuelta más rápida de la carrera contra la IA difícil.', 'Set the fastest lap of the race against the hard AI.'), laps: 4, weapons: false, rivals: ['hard'], goal: { kind: 'fastLap' } },
  { id: 9, name: t('Dos contra uno', 'Two on one'), brief: t('Termina por delante de al menos una de las dos IA.', 'Finish ahead of at least one of the two AIs.'), laps: 4, weapons: true, rivals: ['normal', 'hard'], goal: { kind: 'top', place: 2 } },
  { id: 10, name: t('Campeón', 'Champion'), brief: t('Gana a dos IA difíciles en 5 vueltas, con armas.', 'Beat two hard AIs over 5 laps, with weapons.'), laps: 5, weapons: true, rivals: ['hard', 'hard'], goal: { kind: 'win' } },
];

// ---- Progress ------------------------------------------------------------------------------

const KEY = 'overdrive.campaign';

export function completedLevels(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[]);
  } catch {
    return new Set();
  }
}

function saveCompleted(done: Set<number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    /* storage blocked */
  }
}

/** A level is open when it is the first or the one before it is done. */
export function isUnlocked(id: number, done = completedLevels()): boolean {
  return id === 1 || done.has(id - 1);
}

// ---- One attempt -----------------------------------------------------------------------------

/** A car that stops reporting for this long while it was moving has left the track. */
const OFF_TRACK_MS = 1500;
const WATCH_MS = 250;

export type Outcome = 'playing' | 'won' | 'lost';

/**
 * Follows one attempt at a level: counts towards the goal while racing and decides whether it
 * was passed. Events: 'change' (progress), 'done' (outcome decided).
 */
export class CampaignRun extends EventTarget {
  outcome: Outcome = 'playing';
  missiles = 0;
  knockouts = 0;
  pushedOff = false;
  destroyed = false;
  private timer?: ReturnType<typeof setInterval>;
  private movingSince = new Map<Car, number>();
  private readonly onFire = (e: Event) => this.fired((e as CustomEvent<FireDetail>).detail);
  private readonly onFinish = (e: Event) => this.finished((e as CustomEvent<Entry>).detail);
  private readonly onOver = () => this.decide();

  constructor(
    readonly level: Level,
    readonly player: Car,
    readonly rivals: Car[],
    private race: Race,
    private battle: Battle,
    private recorder: RaceRecorder,
  ) {
    super();
    battle.addEventListener('fire', this.onFire);
    race.addEventListener('finish', this.onFinish);
    race.addEventListener('over', this.onOver);
    this.timer = setInterval(() => this.watch(), WATCH_MS);
  }

  /** Short line with the goal and how it is going, for the race screen. */
  progress(): string {
    const g = this.level.goal;
    const lead = Math.floor((this.recorder.live.get(this.player)?.leadMs ?? 0) / 1000);
    switch (g.kind) {
      case 'win':
        return t('Objetivo: gana la carrera', 'Goal: win the race');
      case 'top':
        return t(`Objetivo: termina entre los ${g.place} primeros`, `Goal: finish in the top ${g.place}`);
      case 'lead':
        return t(`Objetivo: ${g.seconds} s en cabeza · llevas ${Math.min(lead, g.seconds)} s`, `Goal: ${g.seconds} s in the lead · ${Math.min(lead, g.seconds)} s so far`);
      case 'missiles':
        return t(`Objetivo: misilazos ${Math.min(this.missiles, g.count)}/${g.count}`, `Goal: missile hits ${Math.min(this.missiles, g.count)}/${g.count}`);
      case 'knockouts':
        return t(`Objetivo: derribos ${Math.min(this.knockouts, g.count)}/${g.count}`, `Goal: knockouts ${Math.min(this.knockouts, g.count)}/${g.count}`);
      case 'pushOff':
        return this.pushedOff ? t('¡Rival fuera de la pista!', 'Rival off the track!') : t('Objetivo: saca al rival de la pista', 'Goal: push the rival off the track');
      case 'survive':
        return this.destroyed ? t('Te han destruido', 'You were destroyed') : t('Objetivo: termina sin que te destruyan', 'Goal: finish without being destroyed');
      case 'fastLap':
        return t('Objetivo: la vuelta más rápida', 'Goal: the fastest lap');
    }
  }

  /** Public so tests can drive it. */
  watch(): void {
    if (this.outcome !== 'playing' || this.race.phase !== 'running') return;
    const field = this.battle.field;
    const now = field.now();
    const me = this.battle.fighter(this.player);
    if (this.level.goal.kind === 'survive' && me && me.downUntil > now) {
      this.destroyed = true;
      return this.end('lost');
    }
    if (this.level.goal.kind === 'pushOff') {
      for (const car of this.rivals) {
        const f = this.battle.fighter(car);
        const r = field.runner(car);
        // Knocked-out cars stop on purpose; that doesn't count.
        if (!r || (f && f.downUntil > now)) continue;
        const moving = car.state.targetSpeed > 0;
        if (!moving) this.movingSince.delete(car);
        else if (!this.movingSince.has(car)) this.movingSince.set(car, now);
        const wasMoving = (this.movingSince.get(car) ?? now) < now - OFF_TRACK_MS;
        const silent = now - r.seenAt > OFF_TRACK_MS;
        if (wasMoving && (car.state.onTrack === false || silent)) {
          this.pushedOff = true;
          return this.end('won');
        }
      }
    }
    if (this.level.goal.kind === 'lead' && (this.recorder.live.get(this.player)?.leadMs ?? 0) >= this.level.goal.seconds * 1000) {
      return this.end('won');
    }
    this.changed();
  }

  /** Stops following the race (when it is aborted or the player leaves). */
  dispose(): void {
    clearInterval(this.timer);
    this.battle.removeEventListener('fire', this.onFire);
    this.race.removeEventListener('finish', this.onFinish);
    this.race.removeEventListener('over', this.onOver);
  }

  private fired({ shooter, weapon, hits }: FireDetail): void {
    if (shooter !== this.player || this.outcome !== 'playing') return;
    for (const h of hits) {
      if (h.blocked || !this.rivals.includes(h.target)) continue;
      if (weapon.id === 'missile') this.missiles++;
      if (h.knockedOut) this.knockouts++;
    }
    const g = this.level.goal;
    if ((g.kind === 'missiles' && this.missiles >= g.count) || (g.kind === 'knockouts' && this.knockouts >= g.count)) this.end('won');
    else this.changed();
  }

  private finished(entry: Entry): void {
    // The attempt is decided as soon as the player crosses the line.
    if (entry.car === this.player) this.decide();
  }

  private decide(): void {
    if (this.outcome !== 'playing') return;
    const g = this.level.goal;
    const mine = this.race.entries.get(this.player);
    const place = mine?.place;
    let won = false;
    if (g.kind === 'win') won = place === 1;
    else if (g.kind === 'top') won = !!place && place <= g.place;
    else if (g.kind === 'survive') won = !!place && !this.destroyed;
    else if (g.kind === 'fastLap') {
      const best = (e?: Entry) => (e?.lapTimes.length ? Math.min(...e.lapTimes) : Infinity);
      const myBest = best(mine);
      won = Number.isFinite(myBest) && [...this.race.entries.values()].every((e) => e.car === this.player || best(e) > myBest);
    }
    // Goals counted during the race that were not reached by the end are lost.
    this.end(won ? 'won' : 'lost');
  }

  private end(outcome: Exclude<Outcome, 'playing'>): void {
    if (this.outcome !== 'playing') return;
    this.outcome = outcome;
    clearInterval(this.timer);
    if (outcome === 'won') {
      const done = completedLevels();
      done.add(this.level.id);
      saveCompleted(done);
    }
    this.dispatchEvent(new Event('done'));
    this.changed();
  }

  private changed(): void {
    this.dispatchEvent(new Event('change'));
  }
}
