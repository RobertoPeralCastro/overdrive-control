import { beforeEach, describe, expect, it } from 'vitest';

// A tiny localStorage for Node.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { deleteTrack, renameTrack, saveTrack, savedTracks, updateTurns } = await import('../src/tracks');
const { Field } = await import('../src/field');

const OVAL = [33, 36, 57, 17, 18, 39, 40, 46, 48, 20, 23, 51, 34];

describe('saved tracks', () => {
  beforeEach(() => mem.clear());

  it('keeps every scan, and scanning the same track again updates it', () => {
    const turns = OVAL.map(() => undefined as 'L' | 'R' | undefined);
    turns[3] = 'L';
    const id = saveTrack(OVAL, turns);
    expect(savedTracks()).toHaveLength(1);
    expect(savedTracks()[0].name).toBe('Pista 1');
    // Second scan reads another curve but missed the first one: both are kept.
    const again = OVAL.map(() => undefined as 'L' | 'R' | undefined);
    again[9] = 'L';
    expect(saveTrack(OVAL, again)).toBe(id);
    expect(savedTracks()).toHaveLength(1);
    expect(savedTracks()[0].turns[3]).toBe('L');
    expect(savedTracks()[0].turns[9]).toBe('L');
    // A different layout is another track.
    saveTrack([33, 17, 18, 36, 20, 23, 34], []);
    expect(savedTracks()).toHaveLength(2);
  });

  it('can be renamed, improved while racing and deleted', () => {
    const id = saveTrack(OVAL, []);
    renameTrack(id, '  Salón  ');
    expect(savedTracks()[0].name).toBe('Salón');
    const turns: ('L' | 'R' | undefined)[] = [];
    turns[4] = 'L';
    updateTurns(id, turns);
    expect(savedTracks()[0].turns[4]).toBe('L');
    deleteTrack(id);
    expect(savedTracks()).toHaveLength(0);
  });

  it('a saved track can be used without scanning', () => {
    const field = new Field(() => 0);
    expect(field.lap).toBeUndefined();
    field.useTrack(OVAL, []);
    expect(field.lap).toEqual(OVAL);
  });
});
