import type { Car } from './car';
import { h } from './dom';
import type { Field } from './field';
import { describeTrack, type Turn } from './track';
import { layoutTrack, pointOnPiece, trackPath, type TrackLayout } from './trackmap';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One car as the map needs it. */
export interface MapCar {
  key: string;
  name: string;
  color: string;
  idx: number;
  dir: 1 | -1;
  /** mm/s, to slide the marker along the piece. */
  speed: number;
  /** ms the car has spent on its current piece (stops growing once the car stops reporting). */
  inPieceMs: number;
  /** Still reporting, so the marker keeps sliding forward. */
  live: boolean;
  me?: boolean;
}

/** What a map draws: the host reads it from its Field, a guest phone from the host's updates. */
export interface MapSource {
  lap?: number[];
  turns: (Turn | undefined)[];
  /** Name of the car scanning the track, if one is. */
  scanning?: string;
  cars(): MapCar[];
  /** Offer a button to scan the track while it is unknown. */
  scan?: { label: string; run: () => void };
}

/** The learned track with every car moving along it, animated between position reports. */
export class MapView {
  readonly el: HTMLElement;
  private svg?: SVGSVGElement;
  private layout?: TrackLayout;
  private layoutKey = '';
  private markers = new Map<string, SVGGElement>();
  private frame = 0;

  constructor(private source: () => MapSource) {
    this.el = h('div', { class: 'race-map' });
    const step = () => {
      if (this.el.isConnected) this.drawCars();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  update(): void {
    const src = this.source();
    if (!src.lap) {
      this.svg = undefined;
      this.layoutKey = '';
      this.markers.clear();
      this.el.replaceChildren(
        h('div', { class: 'map-empty' }, [
          h('p', {}, src.scanning ? `${src.scanning} está escaneando la pista…` : 'Escanea la pista para verla aquí.'),
          src.scan && !src.scanning ? h('button', { class: 'btn btn-primary', onclick: src.scan.run }, src.scan.label) : null,
        ]),
      );
      return;
    }
    const key = `${src.lap.join(',')}|${src.turns.join(',')}`;
    if (key === this.layoutKey && this.svg) return;
    this.layoutKey = key;
    this.layout = layoutTrack(src.lap, src.turns);
    const l = this.layout;
    const pad = 0.5;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${l.minX - pad} ${l.minY - pad} ${l.width + pad * 2} ${l.height + pad * 2}`);
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Pista: ${describeTrack(src.lap)}`);
    const d = trackPath(l);
    const [a, b] = l.pieces[0];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = (-(b.y - a.y) / len) * 0.2;
    const ny = ((b.x - a.x) / len) * 0.2;
    svg.innerHTML = `
      <path d="${d}" class="map-edge"/>
      <path d="${d}" class="map-road"/>
      <path d="${d}" class="map-center"/>
      <line x1="${a.x - nx}" y1="${a.y - ny}" x2="${a.x + nx}" y2="${a.y + ny}" class="map-start"/>
      <g class="map-cars"></g>`;
    this.svg = svg;
    this.markers.clear();
    this.el.replaceChildren(svg);
  }

  /** Moves the car markers smoothly along their current piece, from their reported speed. */
  private drawCars(): void {
    const group = this.svg?.querySelector('.map-cars');
    const layout = this.layout;
    if (!group || !layout) return;
    const seen = new Set<string>();
    for (const c of this.source().cars()) {
      if (c.idx >= layout.pieces.length) continue;
      seen.add(c.key);
      let g = this.markers.get(c.key);
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.innerHTML = '<circle r="0.13"/><text y="-0.2"></text>';
        group.append(g);
        this.markers.set(c.key, g);
      }
      g.setAttribute('class', `map-car ${c.me ? 'is-me' : ''}`);
      g.querySelector('circle')!.setAttribute('fill', c.color);
      g.querySelector('text')!.textContent = c.name;
      const len = layout.lengthsMm[c.idx] ?? 560;
      const t = Math.min(0.95, (c.speed * c.inPieceMs) / 1000 / len);
      const p = pointOnPiece(layout, c.idx, c.dir === 1 ? t : 1 - t);
      g.setAttribute('transform', `translate(${p.x.toFixed(3)} ${p.y.toFixed(3)})`);
    }
    for (const [key, g] of this.markers) {
      if (!seen.has(key)) {
        g.remove();
        this.markers.delete(key);
      }
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
  }
}

/** Map cars straight from the host's Field. */
export function fieldCars(field: Field, me?: Car): MapCar[] {
  const now = field.now();
  return field.all.flatMap((r) => {
    // Stopped cars stop reporting, so keep them where they were last seen.
    if (r.idx === undefined || !r.car.ready) return [];
    const live = field.active(r.car);
    const until = live ? now : r.seenAt;
    return [
      {
        key: r.car.id,
        name: r.car.state.name,
        color: r.car.state.color,
        idx: r.idx,
        dir: r.dir,
        speed: r.speed,
        inPieceMs: Math.max(0, until - r.enteredAt),
        live,
        me: r.car === me,
      },
    ];
  });
}

export function fieldSource(field: Field, opts: { cars: () => Car[]; scan?: (car: Car) => void; me?: Car }): MapSource {
  const ready = opts.cars().find((c) => c.ready);
  return {
    lap: field.lap,
    turns: field.turns,
    scanning: field.scanning?.state.name,
    cars: () => fieldCars(field, opts.me),
    scan: ready && opts.scan ? { label: `Escanear con ${ready.state.name}`, run: () => opts.scan!(ready) } : undefined,
  };
}
