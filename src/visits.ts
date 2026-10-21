/**
 * Anonymous visit counter: how many devices have opened the app, and how many times it has been
 * opened. Only a "+1" goes to the free Abacus counter service; nothing about the person is sent.
 * Not counted on localhost, so testing doesn't inflate the numbers.
 */

export const COUNTER_NS = 'robertoperalcastro-overdrive';
export const COUNTER_API = 'https://abacus.jasoncameron.dev';

const SEEN_KEY = 'overdrive.counted';
const SESSION_KEY = 'overdrive.session';

function hit(key: string): void {
  void fetch(`${COUNTER_API}/hit/${COUNTER_NS}/${key}`, { keepalive: true }).catch(() => {
    /* offline or blocked: no matter */
  });
}

export function countVisit(): void {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  try {
    // One per opening of the app (a reload in the same tab doesn't count again).
    if (!sessionStorage.getItem(SESSION_KEY)) {
      sessionStorage.setItem(SESSION_KEY, '1');
      hit('aperturas');
    }
    // One per device, the first time ever.
    if (!localStorage.getItem(SEEN_KEY)) {
      localStorage.setItem(SEEN_KEY, '1');
      hit('dispositivos');
    }
  } catch {
    /* storage blocked (private mode): count the opening only */
    hit('aperturas');
  }
}
