import type { Car } from './car';
import { h } from './dom';
import type { Field } from './field';
import { describeTrack } from './track';
import { layoutTrack, pointOnPiece, trackPath, type TrackLayout } from './trackmap';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface MapViewOpts {
  cars: () => Car[];
  /** Offer a scan button while the track is unknown. */
  scan?: (car: Car) => void;
  /** Draw this car's marker bigger (the one being driven on this screen). */
  me?: Car;
}

/** The learned track with every car moving along it, animated between position reports. */
export class MapView {
  readonly el: HTMLElement;
  private svg?: SVGSVGElement;
  private layout?: TrackLayout;
  private layoutKey = '';
  private markers = new Map<Car, SVGGElement>();
  private frame = 0;

  constructor(
    private field: Field,
    private opts: MapViewOpts,
  ) {
    this.el = h('div', { class: 'race-map' });
    const step = () => {
      if (this.el.isConnected) this.drawCars();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  update(): void {
    const field = this.field;
    if (!field.lap) {
      this.svg = undefined;
      this.layoutKey = '';
      this.markers.clear();
      const ready = this.opts.cars().find((c) => c.ready);
      this.el.replaceChildren(
        h('div', { class: 'map-empty' }, [
          h('p', {}, field.scanning ? `${field.scanning.state.name} está escaneando la pista…` : 'Escanea la pista para verla aquí.'),
          ready && !field.scanning && this.opts.scan
            ? h('button', { class: 'btn btn-primary', onclick: () => this.opts.scan!(ready) }, `Escanear con ${ready.state.name}`)
            : null,
        ]),
      );
      return;
    }
    const key = `${field.lap.join(',')}|${field.turns.join(',')}`;
    if (key === this.layoutKey && this.svg) return;
    this.layoutKey = key;
    this.layout = layoutTrack(field.lap, field.turns);
    const l = this.layout;
    const pad = 0.5;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${l.minX - pad} ${l.minY - pad} ${l.width + pad * 2} ${l.height + pad * 2}`);
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Pista: ${describeTrack(field.lap)}`);
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
    const field = this.field;
    const group = this.svg?.querySelector('.map-cars');
    if (!group || !this.layout || !field.lap) return;
    const now = field.now();
    const seen = new Set<Car>();
    for (const r of field.all) {
      // Stopped cars stop reporting, so keep them where they were last seen.
      if (r.idx === undefined || !r.car.ready) continue;
      seen.add(r.car);
      let g = this.markers.get(r.car);
      if (!g) {
        g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', `map-car ${r.car === this.opts.me ? 'is-me' : ''}`);
        g.innerHTML = '<circle r="0.13"/><text y="-0.2"></text>';
        group.append(g);
        this.markers.set(r.car, g);
      }
      g.querySelector('circle')!.setAttribute('fill', r.car.state.color);
      g.querySelector('text')!.textContent = r.car.state.name;
      const len = this.layout.lengthsMm[r.idx] ?? 560;
      // Freeze the marker at its last report once the car stops reporting.
      const until = field.active(r.car) ? now : r.seenAt;
      const t = Math.min(0.95, (r.speed * Math.max(0, until - r.enteredAt)) / 1000 / len);
      const p = pointOnPiece(this.layout, r.idx, r.dir === 1 ? t : 1 - t);
      g.setAttribute('transform', `translate(${p.x.toFixed(3)} ${p.y.toFixed(3)})`);
    }
    for (const [car, g] of this.markers) {
      if (!seen.has(car)) {
        g.remove();
        this.markers.delete(car);
      }
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
  }
}
