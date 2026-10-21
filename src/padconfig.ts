import { h } from './dom';
import { PAD_ACTIONS, actionValue, inputLabel, inputValue, movedInput, sameInput, type Gamepads, type PadAction, type PadInput, type PadMap } from './gamepad';

/**
 * "Configurar mando": which button or stick does each action, tested live. Changes are saved
 * for the pad model, so they apply every time that pad is connected (also on a guest phone).
 */

interface Capture {
  action: PadAction;
  /** Add the input to the ones the action has, instead of replacing them. */
  add: boolean;
  rest: { buttons: { pressed: boolean }[]; axes: number[] };
  until: number;
}

export class PadConfigScreen {
  readonly el: HTMLElement;
  private index = 0;
  private padPicker = h('div', { class: 'padcfg-pads' });
  private title = h('p', { class: 'padcfg-title' });
  private gas = h('div', { class: 'padcfg-gas-fill' });
  private gasNum = h('span', { class: 'padcfg-gas-num' });
  private rows = h('div', { class: 'padcfg-rows' });
  private overlay = h('div', { class: 'padcfg-capture', hidden: '' });
  private chips = new Map<PadAction, HTMLElement>();
  private capture?: Capture;
  private frame = 0;
  private isOpen = false;

  constructor(private pads: Gamepads, done: () => void) {
    this.el = h('section', { class: 'screen padcfg' }, [
      h('header', { class: 'screen-head' }, [h('p', {}, 'Elige qué botón o stick hace cada cosa y pruébalo aquí mismo: lo que pulses se ilumina. Se guarda para este modelo de mando.')]),
      this.padPicker,
      this.title,
      h('div', { class: 'padcfg-gas' }, [h('span', {}, 'Acelerador'), h('div', { class: 'padcfg-gas-bar' }, this.gas), this.gasNum]),
      this.rows,
      h('footer', { class: 'screen-foot' }, [
        h('button', { class: 'btn btn-ghost', onclick: () => this.reset() }, 'Restablecer'),
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => done() }, 'Listo'),
      ]),
      this.overlay,
    ]);
  }

  /** Opens the screen on pad `index` (its buttons stop driving while it is configured). */
  open(index?: number): void {
    const list = this.pads.list();
    if (index !== undefined) this.index = index;
    if (!list.some((p) => p.index === this.index) && list.length) this.index = list[0].index;
    this.isOpen = true;
    this.pads.pause(this.index, true);
    this.render();
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (!this.el.isConnected) return;
      this.live();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    cancelAnimationFrame(this.frame);
    this.capture = undefined;
    this.overlay.hidden = true;
    this.pads.pause(this.index, false);
  }

  private get info() {
    return this.pads.list().find((p) => p.index === this.index);
  }

  private render(): void {
    const list = this.pads.list();
    this.padPicker.replaceChildren(
      ...(list.length > 1
        ? list.map((p) =>
            h('button', { class: `btn btn-sm ${p.index === this.index ? 'btn-primary' : 'btn-ghost'}`, onclick: () => this.switchTo(p.index) }, `🎮 Mando ${p.index + 1}`),
          )
        : []),
    );
    const info = this.info;
    this.title.textContent = info ? `🎮 Mando ${info.index + 1} · ${info.name}` : 'No hay ningún mando conectado: conéctalo y pulsa un botón.';
    this.rows.replaceChildren();
    this.chips.clear();
    if (!info) return;
    const map = this.pads.map(info.id);
    const standard = this.pads.pad(info.index)?.mapping === 'standard';
    for (const a of PAD_ACTIONS) {
      const chips = h(
        'div',
        { class: 'padcfg-chips' },
        map[a.id].length
          ? map[a.id].map((input) =>
              h('span', { class: 'padcfg-chip', 'data-input': JSON.stringify(input) }, [
                inputLabel(input, standard),
                h('button', { class: 'padcfg-x', 'aria-label': `Quitar ${inputLabel(input, standard)} de ${a.name}`, onclick: () => this.remove(a.id, input) }, '×'),
              ]),
            )
          : [h('span', { class: 'padcfg-none' }, 'sin asignar')],
      );
      this.chips.set(a.id, chips);
      this.rows.append(
        h('div', { class: 'padcfg-row', 'data-action': a.id }, [
          h('div', { class: 'padcfg-name' }, [h('strong', {}, a.name), a.hint ? h('small', {}, a.hint) : null]),
          chips,
          h('div', { class: 'padcfg-btns' }, [
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => this.listen(a.id, false) }, 'Cambiar'),
            h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': `Añadir otro botón a ${a.name}`, onclick: () => this.listen(a.id, true) }, '+'),
          ]),
        ]),
      );
    }
  }

  private switchTo(index: number): void {
    this.pads.pause(this.index, false);
    this.capture = undefined;
    this.overlay.hidden = true;
    this.index = index;
    this.pads.pause(index, true);
    this.render();
  }

  /** Waits for the next button or stick move on this pad and assigns it to `action`. */
  private listen(action: PadAction, add: boolean): void {
    const pad = this.pads.pad(this.index);
    if (!pad) return;
    this.capture = {
      action,
      add,
      rest: { buttons: pad.buttons.map((b) => ({ pressed: b.pressed })), axes: [...pad.axes] },
      until: performance.now() + 10_000,
    };
    const name = PAD_ACTIONS.find((a) => a.id === action)!.name;
    this.overlay.replaceChildren(
      h('div', { class: 'padcfg-capture-box' }, [
        h('p', {}, [`Pulsa el botón o mueve el stick para`, h('strong', {}, ` «${name}»`)]),
        h('small', {}, action === 'throttle' ? 'Para acelerar con el stick, empújalo hacia donde quieras acelerar (por ejemplo, hacia arriba).' : 'Tienes 10 segundos.'),
        h('button', { class: 'btn btn-ghost', onclick: () => this.stopListening() }, 'Cancelar'),
      ]),
    );
    this.overlay.hidden = false;
  }

  private stopListening(): void {
    this.capture = undefined;
    this.overlay.hidden = true;
  }

  private assign(action: PadAction, input: PadInput, add: boolean): void {
    const info = this.info;
    if (!info) return;
    const map: PadMap = structuredClone(this.pads.map(info.id));
    // One input does one thing: take it away from any other action.
    for (const a of PAD_ACTIONS) map[a.id] = map[a.id].filter((i) => !sameInput(i, input));
    map[action] = add ? [...map[action], input] : [input];
    this.pads.setMap(info.id, map);
    this.render();
  }

  private remove(action: PadAction, input: PadInput): void {
    const info = this.info;
    if (!info) return;
    const map: PadMap = structuredClone(this.pads.map(info.id));
    map[action] = map[action].filter((i) => !sameInput(i, input));
    this.pads.setMap(info.id, map);
    this.render();
  }

  private reset(): void {
    const info = this.info;
    if (!info) return;
    this.pads.setMap(info.id, undefined);
    this.render();
  }

  /** Every frame: light up what is being pressed, fill the throttle bar, catch a capture. */
  private live(): void {
    const info = this.info;
    const pad = info && this.pads.pad(info.index);
    if (!pad) return;
    const c = this.capture;
    if (c) {
      const input = movedInput(pad, c.rest);
      if (input) {
        this.stopListening();
        this.assign(c.action, input, c.add);
      } else if (performance.now() > c.until) this.stopListening();
      return;
    }
    const map = this.pads.map(info.id);
    const gas = actionValue(pad, map.throttle);
    this.gas.style.width = `${Math.round(gas * 100)}%`;
    this.gasNum.textContent = `${Math.round(gas * 100)} %`;
    for (const [action, chips] of this.chips) {
      chips.closest('.padcfg-row')?.classList.toggle('is-on', actionValue(pad, map[action]) > 0.5);
      chips.querySelectorAll<HTMLElement>('.padcfg-chip').forEach((chip) => chip.classList.toggle('is-on', inputValue(pad, JSON.parse(chip.dataset.input!)) > 0.05));
    }
  }
}
