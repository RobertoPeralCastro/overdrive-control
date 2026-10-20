type Child = Node | string | null | undefined;
type Attrs = Record<string, string | ((e: any) => void)>;

/** Tiny element builder: attributes starting with "on" become event listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: Child | Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c !== null && c !== undefined) el.append(c);
  }
  return el;
}

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  uturn: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  battery: '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2"/>',
  charging: '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2M12 8.5l-2.5 3.5h3L10 15.5"/>',
};

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}
