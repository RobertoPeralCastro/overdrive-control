import { t } from './i18n';
import { describeTrack, type Turn } from './track';

/**
 * Tracks scanned on this device, so a track doesn't have to be scanned every time.
 * Each scan is saved; scanning the same layout again updates it instead of adding another.
 */

export interface SavedTrack {
  id: string;
  name: string;
  pieces: number[];
  /** Which way each curve bends ('L'/'R'), null where unknown. */
  turns: (Turn | null)[];
  savedAt: number;
}

const KEY = 'overdrive.tracks';

export function savedTracks(): SavedTrack[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? (list as SavedTrack[]).sort((a, b) => b.savedAt - a.savedAt) : [];
  } catch {
    return [];
  }
}

function store(list: SavedTrack[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the track still works until the page closes */
  }
}

/** Saves a scanned lap (or updates the saved one with the same pieces). Returns its id. */
export function saveTrack(pieces: number[], turns: (Turn | undefined)[]): string {
  const list = savedTracks();
  const same = list.find((s) => s.pieces.join() === pieces.join());
  const clean = pieces.map((_, i) => turns[i] ?? null);
  if (same) {
    // Keep what was known before where this scan didn't read a curve.
    same.turns = clean.map((v, i) => v ?? same.turns[i] ?? null);
    same.savedAt = Date.now();
    store(list);
    return same.id;
  }
  const n = list.length + 1;
  const track: SavedTrack = {
    id: `t${Date.now().toString(36)}`,
    name: t(`Pista ${n}`, `Track ${n}`),
    pieces: pieces.slice(),
    turns: clean,
    savedAt: Date.now(),
  };
  store([track, ...list]);
  return track.id;
}

/** Curves learned while racing on a saved track. */
export function updateTurns(id: string, turns: (Turn | undefined)[]): void {
  const list = savedTracks();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.turns = s.pieces.map((_, i) => turns[i] ?? s.turns[i] ?? null);
  store(list);
}

export function renameTrack(id: string, name: string): void {
  const list = savedTracks();
  const s = list.find((x) => x.id === id);
  if (!s || !name.trim()) return;
  s.name = name.trim().slice(0, 30);
  store(list);
}

export function deleteTrack(id: string): void {
  store(savedTracks().filter((s) => s.id !== id));
}

/** "Pista 2 · 13 piezas (7 rectas, 4 curvas)". */
export function trackLabel(s: SavedTrack): string {
  return `${s.name} · ${describeTrack(s.pieces)}`;
}
