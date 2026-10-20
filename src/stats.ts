import type { Battle, FireDetail } from './battle';
import type { Car } from './car';
import type { Race } from './race';

/**
 * Race statistics. During a race: top speed, time in the lead, best lap, shots, hits and
 * knock-outs for every car. When it ends: awards for the race, and each car's all-time record
 * (races, wins, podiums, bests) saved on this phone.
 */

const KEY = 'overdrive.stats';
const SAMPLE_MS = 200;

export interface CarRecord {
  name: string;
  races: number;
  wins: number;
  podiums: number;
  /** Best ever, mm/s and ms. */
  topSpeed: number;
  bestLapMs?: number;
  leadMs: number;
  kills: number;
}

export interface RaceLive {
  topSpeed: number;
  leadMs: number;
  shots: number;
  hits: number;
  kills: number;
  knockedOut: number;
}

export interface Award {
  icon: string;
  title: string;
  car: Car;
  value: string;
}

/** Saved records, keyed by car. Guest cars are keyed by name (their id changes every visit). */
export function loadRecords(): Record<string, CarRecord> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, CarRecord>;
  } catch {
    return {};
  }
}

function saveRecords(all: Record<string, CarRecord>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked */
  }
}

export function clearRecords(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

export function recordKey(car: Car): string {
  return car.id.startsWith('remote-') ? `guest:${car.state.name}` : car.id;
}

export function recordOf(car: Car): CarRecord | undefined {
  return loadRecords()[recordKey(car)];
}

/**
 * Speed as a real car of this size would feel it: Overdrive cars are about 1:50, so
 * 1 m/s on the track reads as 180 km/h. Games show km/h; mm/s means nothing to a player.
 */
export const SCALE = 50;
export const toKmh = (mmS: number) => Math.round((mmS / 1000) * 3.6 * SCALE);
export const fmtSpeed = (mmS: number) => `${toKmh(mmS)} km/h`;
export const fmtTime = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export class RaceRecorder extends EventTarget {
  live = new Map<Car, RaceLive>();
  awards: Award[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private last = 0;

  constructor(
    private race: Race,
    private battle: Battle,
  ) {
    super();
    race.addEventListener('go', () => this.begin());
    race.addEventListener('over', () => this.finish());
    battle.addEventListener('fire', (e) => this.onFire((e as CustomEvent<FireDetail>).detail));
  }

  private begin(): void {
    this.awards = [];
    this.live = new Map([...this.race.entries.keys()].map((car) => [car, { topSpeed: 0, leadMs: 0, shots: 0, hits: 0, kills: 0, knockedOut: 0 }]));
    this.last = this.battle.field.now();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  /** Called on a timer; public so tests can drive it. */
  sample(): void {
    if (this.race.phase !== 'running') return;
    const field = this.battle.field;
    const now = field.now();
    const dt = now - this.last;
    this.last = now;
    for (const [car, s] of this.live) {
      const r = field.runner(car);
      // Only real reports: a stopped car stops sending them.
      if (r && field.active(car)) s.topSpeed = Math.max(s.topSpeed, r.speed);
    }
    const leader = this.race.standings().find((e) => !e.place);
    const ls = leader && this.live.get(leader.car);
    if (ls) ls.leadMs += dt;
  }

  private onFire({ shooter, weapon, hits }: FireDetail): void {
    if (this.race.phase !== 'running' || weapon.id === 'shield') return;
    const s = this.live.get(shooter);
    if (!s) return;
    s.shots++;
    for (const h of hits) {
      if (h.blocked) continue;
      s.hits++;
      if (h.knockedOut) {
        s.kills++;
        const t = this.live.get(h.target);
        if (t) t.knockedOut++;
      }
    }
  }

  private finish(): void {
    clearInterval(this.timer);
    const entries = [...this.race.entries.values()];
    const best = (pick: (car: Car) => number | undefined, lower = false) => {
      let top: { car: Car; v: number } | undefined;
      for (const e of entries) {
        const v = pick(e.car);
        if (v === undefined || v <= 0) continue;
        if (!top || (lower ? v < top.v : v > top.v)) top = { car: e.car, v };
      }
      return top;
    };
    const awards: Award[] = [];
    const winner = this.race.winner();
    if (winner) awards.push({ icon: '🏆', title: 'Ganador', car: winner.car, value: winner.lapTimes.length ? fmtTime(winner.lapTimes.reduce((a, b) => a + b, 0)) : '' });
    const fast = best((c) => this.live.get(c)?.topSpeed);
    if (fast) awards.push({ icon: '⚡', title: 'Más rápido', car: fast.car, value: fmtSpeed(fast.v) });
    const lead = best((c) => this.live.get(c)?.leadMs);
    if (lead) awards.push({ icon: '👑', title: 'Más tiempo en cabeza', car: lead.car, value: fmtTime(lead.v) });
    const lap = best((c) => {
      const t = this.race.entries.get(c)?.lapTimes;
      return t?.length ? Math.min(...t) : undefined;
    }, true);
    if (lap) awards.push({ icon: '⏱️', title: 'Vuelta rápida', car: lap.car, value: fmtTime(lap.v) });
    const kills = best((c) => this.live.get(c)?.kills);
    if (kills) awards.push({ icon: '💥', title: 'Más derribos', car: kills.car, value: `${kills.v}` });
    const aim = best((c) => {
      const s = this.live.get(c);
      return s && s.shots >= 3 ? s.hits / s.shots : undefined;
    });
    if (aim) awards.push({ icon: '🎯', title: 'Mejor puntería', car: aim.car, value: `${Math.round(aim.v * 100)} %` });
    this.awards = awards;

    // All-time records on this phone.
    const all = loadRecords();
    for (const e of entries) {
      const key = recordKey(e.car);
      const s = this.live.get(e.car);
      const rec = all[key] ?? { name: e.car.state.name, races: 0, wins: 0, podiums: 0, topSpeed: 0, leadMs: 0, kills: 0 };
      rec.name = e.car.state.name;
      rec.races++;
      if (e.place === 1) rec.wins++;
      if (e.place && e.place <= 3) rec.podiums++;
      rec.topSpeed = Math.max(rec.topSpeed, s?.topSpeed ?? 0);
      rec.leadMs += s?.leadMs ?? 0;
      rec.kills += s?.kills ?? 0;
      const lapBest = e.lapTimes.length ? Math.min(...e.lapTimes) : undefined;
      if (lapBest && (!rec.bestLapMs || lapBest < rec.bestLapMs)) rec.bestLapMs = lapBest;
      all[key] = rec;
    }
    saveRecords(all);
    this.dispatchEvent(new Event('awards'));
  }
}
