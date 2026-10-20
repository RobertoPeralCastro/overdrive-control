import { h } from './dom';

/** Bits both the host and the guest screens use: toasts, keeping the screen on, errors. */

const toast = h('div', { class: 'toast', role: 'status' });
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toastElement(): HTMLElement {
  return toast;
}

export function showToast(msg: string): void {
  toast.textContent = msg;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500);
}

let wakeLock: WakeLockSentinel | undefined;
let wantAwake = false;

/** Keep the phone screen on while driving. */
export async function keepAwake(on: boolean): Promise<void> {
  wantAwake = on;
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = undefined));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* not allowed right now */
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wantAwake && keepAwake(true));

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
