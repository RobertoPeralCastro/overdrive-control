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

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

/** Touch phone or tablet. */
export function isTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

/**
 * Full screen and locked in landscape, to hold the phone like a steering wheel. Browsers only
 * allow it from a tap; iPhones can't lock, so the player turns the phone (we show a hint).
 */
export async function goLandscape(): Promise<void> {
  if (!isTouch()) return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await (screen.orientation as LockableOrientation).lock?.('landscape');
  } catch {
    /* not allowed here: the rotate hint covers it */
  }
}

export function leaveLandscape(): void {
  try {
    (screen.orientation as LockableOrientation).unlock?.();
    if (document.fullscreenElement) void document.exitFullscreen();
  } catch {
    /* nothing to undo */
  }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
