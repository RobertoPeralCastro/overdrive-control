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

/** Browsers built into other apps (LinkedIn, Facebook, Instagram…), which have no Web Bluetooth. */
function inAppBrowser(): string | undefined {
  const ua = navigator.userAgent;
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/Twitter/i.test(ua)) return 'X';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/; wv\)/.test(ua)) return 'otra app';
  return undefined;
}

/**
 * A banner for browsers that can't reach the cars, saying where to open the app instead. On
 * Android it opens Chrome straight away (links from LinkedIn and the like land in their own browser).
 */
export function browserBanner(hasBluetooth: boolean): HTMLElement | null {
  if (hasBluetooth) return null;
  const app = inAppBrowser();
  const android = /Android/i.test(navigator.userAgent);
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const here = location.host + location.pathname + location.search;
  const chrome = `intent://${here}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;
  const demo = location.pathname + '?demo';
  const text = app
    ? `Estás en el navegador de ${app}, que no puede conectar con los coches por Bluetooth.`
    : 'Este navegador no puede conectar con los coches por Bluetooth.';
  const how = android
    ? 'Ábrela en Chrome:'
    : ios
      ? 'En iPhone, copia el enlace y ábrelo en el navegador gratuito Bluefy.'
      : 'Ábrela en Chrome o Edge.';
  return h('div', { class: 'browser-banner', role: 'alert' }, [
    h('p', {}, [h('strong', {}, text), ' ', how]),
    h('div', { class: 'browser-banner-actions' }, [
      android ? h('a', { class: 'btn btn-primary btn-sm', href: chrome }, 'Abrir en Chrome') : null,
      ios ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => void navigator.clipboard?.writeText(location.href).then(() => showToast('Enlace copiado')) }, 'Copiar enlace') : null,
      h('a', { class: 'btn btn-ghost btn-sm', href: demo }, 'Probar la demo'),
    ]),
  ]);
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
