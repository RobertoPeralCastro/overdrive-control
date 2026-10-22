import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiDriver } from '../src/ai';
import { Battle, MAX_ARMOR } from '../src/battle';
import { Car } from '../src/car';
import { Field } from '../src/field';
import { LightEffect, Msg, MsgId, parseMessage } from '../src/protocol';
import { Race } from '../src/race';
import { RaceRecorder } from '../src/stats';
import { CampaignRun, LEVELS, isUnlocked } from '../src/campaign';
import { TrackLearner, describeTrack, turnFromWheels } from '../src/track';
import { layoutTrack, solveBends } from '../src/trackmap';
import type { Transport } from '../src/transport';

class FakeTransport implements Transport {
  static count = 0;
  id = `fake-${++FakeTransport.count}`;
  deviceName = 'Drive';
  modelId = 9;
  written: number[][] = [];
  onMessage: (d: DataView) => void = () => {};
  onDisconnect = () => {};
  onModelId = () => {};
  async connect() {}
  async disconnect() {}
  async write(b: Uint8Array) {
    this.written.push([...b]);
    if (b[1] === MsgId.C2V_VERSION_REQ) this.onMessage(new DataView(new Uint8Array([3, MsgId.V2C_VERSION_RESP, 0x61, 0x30]).buffer));
  }
}

const idle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function connectedCar() {
  const t = new FakeTransport();
  const car = new Car(t);
  await car.connect();
  t.written = [];
  return { car, t };
}

const LAP = [33, 36, 17, 18, 39, 20, 23, 40, 34];
const pieces = (lap: { pieces: number[] } | undefined) => lap?.pieces;

describe('TrackLearner', () => {
  it('learns a lap between two passes over the start line', () => {
    const l = new TrackLearner();
    const seen = [36, 17, ...LAP, 33].map((id) => l.push(id));
    expect(seen.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ pieces: LAP, at: 0 });
  });

  it('ignores repeated reports of the same piece', () => {
    const l = new TrackLearner();
    for (const id of [33, 33, 36, 36, 17, 18, 34]) l.push(id);
    expect(pieces(l.push(33))).toEqual([33, 36, 17, 18, 34]);
  });

  it('without a start piece, waits for two identical laps', () => {
    const l = new TrackLearner();
    const loop = [36, 17, 18, 39, 20];
    const seen = [...loop, ...loop].map((id) => l.push(id));
    expect(seen.slice(0, -1).every((x) => x === undefined)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ pieces: loop, at: 4 });
  });

  it('remembers which way each curve bends', () => {
    const l = new TrackLearner();
    for (const id of [33, 36, 17]) l.push(id);
    l.markTurn('R');
    l.push(18);
    l.markTurn('L');
    expect(l.push(34)).toBeUndefined();
    expect(l.push(33)).toEqual({ pieces: [33, 36, 17, 18, 34], turns: [undefined, undefined, 'R', 'L', undefined], at: 0 });
  });

  it('reads curve direction from the wheels', () => {
    expect(turnFromWheels(50, 40)).toBe('R');
    expect(turnFromWheels(40, 50)).toBe('L');
    expect(turnFromWheels(56, 57)).toBe('S');
  });

  it('describes the track', () => {
    expect(describeTrack(LAP)).toBe('9 piezas (3 rectas, 4 curvas)');
  });
});

describe('protocol: transition with wheel distances', () => {
  it('parses left and right wheel distances', () => {
    const p = new Uint8Array(18);
    p[0] = 17;
    p[1] = MsgId.V2C_LOC_TRANS;
    p[2] = 3;
    p[3] = 2;
    p[16] = 40;
    p[17] = 52;
    expect(parseMessage(new DataView(p.buffer))).toMatchObject({ type: 'transition', pieceIdx: 3, leftWheelCm: 40, rightWheelCm: 52 });
  });
});

describe('track map', () => {
  it('an oval with 4 left curves closes on itself', () => {
    const lap = [33, 36, 57, 17, 18, 39, 40, 46, 48, 20, 23, 51, 34];
    const l = layoutTrack(lap, []);
    const first = l.pieces[0][0];
    const last = l.pieces.at(-1)!.at(-1)!;
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-9);
    // Two straights of 4 pieces and 2 half-circles of radius 0.5: about 4 wide and 1 tall.
    expect(l.width).toBeCloseTo(5, 0);
    expect(l.height).toBeCloseTo(1, 0);
  });

  it('fixes a curve measured the wrong way, so the oval still closes on the grid', () => {
    const lap = [33, 36, 57, 17, 18, 39, 40, 46, 48, 20, 23, 51, 34];
    const turns: ('L' | 'R' | 'S' | undefined)[] = lap.map(() => 'S');
    [3, 4, 9, 10].forEach((i) => (turns[i] = 'L'));
    turns[9] = 'R'; // one bad reading
    const { bends, closed } = solveBends(lap, turns);
    expect(closed).toBe(true);
    expect([3, 4, 9, 10].map((i) => bends[i])).toEqual([1, 1, 1, 1]);
    const l = layoutTrack(lap, turns);
    expect(l.width).toBeCloseTo(5, 5);
    expect(l.height).toBeCloseTo(1, 5);
  });

  it('every curve is 90°: a track with a bend each way lands exactly on the grid', () => {
    // An L-shaped loop: five left curves and one right (the inside corner).
    const S = 36;
    const C = 17;
    const lap = [S, C, C, C, C, C, S, C];
    // Every curve read as left, the inside corner too: only one choice closes the loop.
    const turns: ('L' | 'R' | 'S' | undefined)[] = lap.map((id) => (id === C ? 'L' : 'S'));
    const { closed, bends } = solveBends(lap, turns);
    expect(closed).toBe(true);
    expect(bends).toEqual([0, 1, 1, -1, 1, 1, 0, 1]);
    // With no readings at all it finds the same loop.
    expect(solveBends(lap, []).bends).toEqual([0, 1, 1, -1, 1, 1, 0, 1]);
    const l = layoutTrack(lap, turns);
    // Corners of grid pieces: every curve end sits on a multiple of half a piece.
    for (const p of l.pieces.map((ps) => ps.at(-1)!)) {
      expect(Math.abs(p.x * 2 - Math.round(p.x * 2))).toBeLessThan(1e-9);
      expect(Math.abs(p.y * 2 - Math.round(p.y * 2))).toBeLessThan(1e-9);
    }
  });

  it('right curves bend the other way', () => {
    const lap = [33, 17, 18, 36, 20, 23, 34];
    const left = layoutTrack(lap, []);
    const right = layoutTrack(lap, ['S', 'R', 'R', 'S', 'R', 'R', 'S']);
    // Same shape mirrored: the second piece ends on opposite sides.
    expect(Math.sign(left.pieces[1].at(-1)!.y)).toBe(-Math.sign(right.pieces[1].at(-1)!.y));
  });
});

async function arena() {
  let now = 0;
  const field = new Field(() => now);
  const battle = new Battle(field);
  const a = await connectedCar();
  const b = await connectedCar();
  battle.add(a.car);
  battle.add(b.car);
  // Car A learns the lap, then B sits 2 pieces ahead of it.
  for (const id of [...LAP, 33]) field.observe(a.car, id);
  field.observe(b.car, 17);
  field.observe(b.car, 18);
  field.observe(a.car, 36);
  return { field, battle, a, b, clock: (ms: number) => (now += ms), seen: () => [a, b].forEach(({ car }) => field.observe(car, field.runner(car)!.piece!)) };
}

describe('Field', () => {
  it('learns the curve directions from wheel distances while scanning', async () => {
    const field = new Field(() => 0);
    const { car } = await connectedCar();
    field.add(car);
    for (const id of [33, 36, 17]) field.observe(car, id);
    field.observeTurn(car, 50, 40);
    for (const id of [18, 39, 20, 23, 40, 34, 33]) field.observe(car, id);
    expect(field.lap).toEqual(LAP);
    expect(field.turns[2]).toBe('R');
    expect(field.turns[3]).toBeUndefined();
  });

  it('scanning drives the car and brakes it once the lap is learned', async () => {
    const field = new Field(() => 0);
    const { car } = await connectedCar();
    field.add(car);
    field.scan(car);
    expect(car.state.targetSpeed).toBe(450);
    for (const id of [...LAP, 33]) field.observe(car, id);
    expect(field.scanning).toBeUndefined();
    expect(car.state.targetSpeed).toBe(0);
  });
});

describe('Battle', () => {
  it('finds the car ahead on the learned lap', async () => {
    const { battle, a, b } = await arena();
    expect(battle.targetFor(a.car)).toEqual({ car: b.car, pieces: 2 });
    expect(battle.targetFor(b.car, 3)).toBeUndefined();
  });

  it('a missile hit costs armor, slows the target and blinks it red', async () => {
    const { battle, a, b } = await arena();
    b.car.setSpeed(1000);
    await idle();
    b.t.written = [];
    const r = battle.fire(a.car, 'missile');
    expect(r).toEqual({ ok: true, hits: [{ target: b.car, blocked: false, knockedOut: false }] });
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR - 30);
    await idle();
    expect(b.t.written).toContainEqual([...Msg.setSpeed(300, 30000, true)]);
    expect(b.t.written).toContainEqual([...Msg.engineColor(255, 0, 0, LightEffect.FLASH, 40)]);
    expect(battle.fighter(a.car)!.energy).toBe(65);
  });

  it('the laser only reaches one piece ahead', async () => {
    const { battle, a } = await arena();
    expect(battle.fire(a.car, 'blaster')).toEqual({ ok: true, hits: [] });
  });

  it('cooldown and energy limit firing; weapons can be switched off', async () => {
    const { battle, a, clock } = await arena();
    expect(battle.fire(a.car, 'missile').ok).toBe(true);
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: false, code: 'cooling', reason: 'Recargando' });
    clock(3000);
    expect(battle.fire(a.car, 'missile').ok).toBe(true);
    clock(3000);
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: false, code: 'empty', reason: 'Sin energía' });
    battle.enabled = false;
    expect(battle.fire(a.car, 'shield')).toEqual({ ok: false, code: 'off', reason: 'Armas desactivadas' });
  });

  it('a shield blocks hits', async () => {
    const { battle, a, b } = await arena();
    battle.fire(b.car, 'shield');
    expect(battle.fire(a.car, 'missile')).toEqual({ ok: true, hits: [{ target: b.car, blocked: true, knockedOut: false }] });
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR);
  });

  it('knocks a car out at 0 armor and brings it back later', async () => {
    const { battle, a, b, clock } = await arena();
    battle.fighter(b.car)!.armor = 20;
    const r = battle.fire(a.car, 'missile');
    expect(r.ok && r.hits[0].knockedOut).toBe(true);
    expect(battle.fighter(a.car)!.kills).toBe(1);
    await idle();
    expect(b.t.written).toContainEqual([...Msg.setSpeed(0, 30000, true)]);
    expect(battle.fire(b.car, 'blaster')).toEqual({ ok: false, code: 'down', reason: 'Estás fuera de combate' });
    clock(3100);
    battle.tick();
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR);
  });

  it('before the lap is known, only cars on the same piece are in range', async () => {
    const field = new Field(() => 0);
    const battle = new Battle(field);
    const a = await connectedCar();
    const b = await connectedCar();
    battle.add(a.car);
    battle.add(b.car);
    field.observe(a.car, 36);
    field.observe(b.car, 17);
    expect(battle.targetFor(a.car)).toBeUndefined();
    field.observe(b.car, 36);
    expect(battle.targetFor(a.car)).toEqual({ car: b.car, pieces: 0 });
  });
});

describe('Race', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drives a car one full lap forward from wherever it is. */
  function lap(field: Field, car: Car) {
    const n = field.lap!.length;
    const from = field.runner(car)!.idx!;
    for (let i = 1; i <= n; i++) field.observe(car, field.lap![(from + i) % n]);
  }

  async function grid() {
    vi.useRealTimers();
    const env = await arena();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const race = new Race(env.battle, () => 0);
    race.totalLaps = 2;
    return { ...env, race };
  }

  it('lights up 5 red lights, then goes', async () => {
    const { race, a, b } = await grid();
    const lights: number[] = [];
    race.addEventListener('light', (e) => lights.push((e as CustomEvent<number>).detail));
    race.start([a.car, b.car], { grid: false });
    expect(race.phase).toBe('countdown');
    vi.advanceTimersByTime(4500);
    expect(lights).toEqual([1, 2, 3, 4, 5]);
    expect(race.phase).toBe('countdown');
    vi.advanceTimersByTime(1000);
    expect(race.phase).toBe('running');
    expect(race.lights).toBe(0);
  });

  it('counts laps over the line and declares the winner', async () => {
    const { race, field, a, b } = await grid();
    const finished: string[] = [];
    race.addEventListener('finish', (e) => finished.push((e as CustomEvent).detail.car.id));
    race.start([a.car, b.car], { grid: false });
    vi.advanceTimersByTime(6000);
    lap(field, b.car);
    expect(race.entries.get(b.car)!.laps).toBe(1);
    expect(race.standings()[0].car).toBe(b.car);
    lap(field, a.car);
    lap(field, a.car);
    expect(race.winner()?.car).toBe(a.car);
    expect(a.car.state.targetSpeed).toBe(0);
    lap(field, b.car);
    expect(finished).toEqual([a.car.id, b.car.id]);
    expect(race.phase).toBe('finished');
    expect(race.standings().map((e) => e.place)).toEqual([1, 2]);
  });

  it('lines the cars up at the start line before the lights', async () => {
    const { race, field, a, b } = await grid();
    race.start([a.car, b.car]);
    expect(race.phase).toBe('grid');
    expect(a.car.state.targetSpeed).toBe(350);
    expect(race.isLocked(a.car)).toBe(true);
    // A crosses the line (last piece -> first piece) and waits there.
    const n = field.lap!.length;
    field.observe(a.car, field.lap![n - 1]);
    field.observe(a.car, field.lap![0]);
    expect(race.parked.has(a.car)).toBe(true);
    expect(a.car.state.targetSpeed).toBe(0);
    expect(race.phase).toBe('grid');
    // B too: everyone is lined up, so the countdown starts.
    for (let i = 4; i < n; i++) field.observe(b.car, field.lap![i]);
    field.observe(b.car, field.lap![0]);
    expect(race.phase).toBe('countdown');
    vi.advanceTimersByTime(6600);
    expect(race.phase).toBe('running');
  });

  it('starts the countdown anyway if a car never reaches the line', async () => {
    const { race, a, b } = await grid();
    race.start([a.car, b.car]);
    vi.advanceTimersByTime(45_000);
    expect(race.phase).toBe('countdown');
    expect(b.car.state.targetSpeed).toBe(0);
  });

  it('records top speed, time in the lead and hands out awards', async () => {
    const env = await grid();
    const { race, field, a, b } = env;
    const rec = new RaceRecorder(race, env.battle);
    race.start([a.car, b.car], { grid: false });
    vi.advanceTimersByTime(6000);
    // B is ahead (2 pieces) and faster for a while.
    field.observe(b.car, field.runner(b.car)!.piece!, 1300);
    field.observe(a.car, field.runner(a.car)!.piece!, 700);
    env.clock(1000);
    rec.sample();
    expect(rec.live.get(b.car)).toMatchObject({ topSpeed: 1300 });
    expect(rec.live.get(b.car)!.leadMs).toBeGreaterThan(0);
    expect(rec.live.get(a.car)!.leadMs).toBe(0);
    lap(field, b.car);
    env.clock(4000);
    lap(field, b.car);
    env.clock(2000);
    lap(field, a.car);
    env.clock(5000);
    lap(field, a.car);
    expect(race.phase).toBe('finished');
    const titles = rec.awards.map((x) => `${x.title}:${x.car.id}`);
    expect(titles).toContain(`Ganador:${b.car.id}`);
    expect(titles).toContain(`Más rápido:${b.car.id}`);
    expect(titles.some((t) => t.startsWith('Vuelta rápida'))).toBe(true);
  });

  it('campaign: three missile hits pass the level and unlock the next one', async () => {
    const env = await grid();
    const { race, a, b } = env;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    const rec = new RaceRecorder(race, env.battle);
    const level = LEVELS.find((l) => l.goal.kind === 'missiles')!;
    env.battle.enabled = true;
    const run = new CampaignRun(level, a.car, [b.car], race, env.battle, rec);
    race.start([a.car, b.car], { grid: false });
    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 3; i++) {
      expect(env.battle.fire(a.car, 'missile').ok).toBe(true);
      env.clock(3500);
      env.seen();
      env.battle.fighter(a.car)!.energy = 100;
      env.battle.fighter(b.car)!.armor = 100;
    }
    expect(run.missiles).toBe(3);
    expect(run.outcome).toBe('won');
    expect(isUnlocked(level.id + 1)).toBe(true);
    run.dispose();
    vi.unstubAllGlobals();
  });

  it('campaign: being knocked out fails the survive level at once', async () => {
    const env = await grid();
    const { race, a, b } = env;
    const rec = new RaceRecorder(race, env.battle);
    const level = LEVELS.find((l) => l.goal.kind === 'survive')!;
    const run = new CampaignRun(level, a.car, [b.car], race, env.battle, rec);
    race.start([a.car, b.car], { grid: false });
    vi.advanceTimersByTime(6000);
    env.battle.fighter(a.car)!.downUntil = env.field.now() + 3000;
    run.watch();
    expect(run.outcome).toBe('lost');
    run.dispose();
  });

  it('campaign: winning the race passes a "win" level', async () => {
    const env = await grid();
    const { race, field, a, b } = env;
    const rec = new RaceRecorder(race, env.battle);
    const run = new CampaignRun(LEVELS[0], a.car, [b.car], race, env.battle, rec);
    race.totalLaps = 1;
    race.start([a.car, b.car], { grid: false });
    vi.advanceTimersByTime(6000);
    lap(field, a.car);
    expect(run.outcome).toBe('won');
    run.dispose();
  });

  it('does not start without a scanned track', async () => {
    vi.useRealTimers();
    const field = new Field(() => 0);
    const battle = new Battle(field);
    const { car } = await connectedCar();
    battle.add(car);
    const race = new Race(battle);
    expect(race.blocker([car])).toBe('Primero escanea la pista');
  });

  it('does not start while a car is off the track or charging', async () => {
    const { race, a, b } = await grid();
    const say = (t: FakeTransport, bytes: number[]) => t.onMessage(new DataView(new Uint8Array(bytes).buffer));
    expect(race.blocker([a.car, b.car])).toBeUndefined();
    say(a.t, [1, 0x2b]); // delocalized: lifted or crashed off
    expect(race.blocker([a.car, b.car])).toBe(`${a.car.state.name} está fuera de la pista: ponlo sobre ella`);
    say(b.t, [5, 0x3f, 0, 1, 0, 0]); // on the charger
    expect(race.blocker([a.car, b.car])).toMatch(/en el cargador/);
    say(b.t, [5, 0x3f, 1, 0, 0, 0]);
    say(a.t, [5, 0x3f, 1, 0, 0, 0]); // both back on the track
    expect(race.blocker([a.car, b.car])).toBeUndefined();
    race.start([a.car, b.car]);
    expect(race.live).toBe(true);
  });

  it('a pad drives only one car', async () => {
    const { race, a, b } = await grid();
    race.setDriver(a.car, { kind: 'pad', index: 0 });
    race.setDriver(b.car, { kind: 'pad', index: 0 });
    expect(race.carForPad(0)).toBe(b.car);
    expect(race.driverOf(a.car)).toEqual({ kind: 'screen' });
  });

  it('AI cars drive on their own once the lights go out', async () => {
    const { race, a, b } = await grid();
    race.setDriver(b.car, { kind: 'ai', level: 'hard' });
    race.start([a.car, b.car], { grid: false });
    expect(race.isAi(b.car)).toBe(true);
    vi.advanceTimersByTime(6000);
    expect(b.car.state.targetSpeed).toBeGreaterThan(900);
    expect(a.car.state.targetSpeed).toBe(0);
    race.abort();
    expect(b.car.state.targetSpeed).toBe(0);
  });
});

describe('AiDriver', () => {
  it('fires a missile at a car a few pieces ahead', async () => {
    const { battle, a, b } = await arena();
    const ai = new AiDriver(a.car, battle, 'hard', () => 0);
    ai.decide();
    expect(battle.fighter(b.car)!.armor).toBe(MAX_ARMOR - 30);
    expect(a.car.state.targetSpeed).toBe(1020);
  });

  it('rams a car from behind as it goes into a curve, lining up first', async () => {
    const { battle, field, a, b } = await arena();
    battle.enabled = false;
    // B on the curve (piece 18), A one piece behind on the previous curve, 30 mm to its left.
    field.observe(b.car, 18, 700, 20);
    field.observe(a.car, 17, 700, -10);
    a.t.written = [];
    const ai = new AiDriver(a.car, battle, 'hard', () => 0);
    ai.decide();
    expect(ai.move).toBe('ram');
    expect(a.car.state.targetSpeed).toBe(1500);
    await idle();
    expect(a.t.written).toContainEqual([...Msg.changeLane(1000, 15000, 30, 1, 0)]);
  });

  it('pulls alongside and swerves into the other car', async () => {
    const { battle, field, a, b } = await arena();
    battle.enabled = false;
    field.observe(b.car, 36, 800, 40);
    field.observe(a.car, 36, 800, 0);
    a.t.written = [];
    const ai = new AiDriver(a.car, battle, 'hard', () => 0);
    ai.decide();
    expect(ai.move).toBe('shove');
    await idle();
    expect(a.t.written).toContainEqual([...Msg.changeLane(1000, 15000, 64, 1, 0)]);
    expect(a.car.state.targetSpeed).toBe(860);
  });

  it('the easy AI never shoves or rams', async () => {
    const { battle, field, a, b } = await arena();
    field.observe(b.car, 18, 700, 20);
    field.observe(a.car, 17, 700, -10);
    const ai = new AiDriver(a.car, battle, 'easy', () => 0);
    ai.decide();
    expect(ai.move).toBe('cruise');
  });
});

describe('Car speed limit', () => {
  it('caps the speed for a while and then restores the cruise speed', async () => {
    const { car, t } = await connectedCar();
    car.setSpeed(800);
    await idle();
    t.written = [];
    car.limitSpeed(200, 150);
    await idle(50);
    expect(t.written).toEqual([[...Msg.setSpeed(200, 30000, true)]]);
    await idle(200);
    expect(t.written.at(-1)).toEqual([...Msg.setSpeed(800, 25000, true)]);
    expect(car.state.targetSpeed).toBe(800);
  });
});
