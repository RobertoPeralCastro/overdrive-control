/**
 * Spanish or English. Every text in the app is written in both, side by side:
 *   t('Garaje', 'Garage')
 * The language comes from the player's choice, or else from the browser (Spanish browsers get
 * Spanish, everyone else English). Changing it reloads the page.
 */

export type Lang = 'es' | 'en';

const KEY = 'overdrive.lang';

function detect(): Lang {
  // Tests and other non-browser runs stay in Spanish.
  if (typeof window === 'undefined') return 'es';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'es' || saved === 'en') return saved;
  } catch {
    /* storage blocked */
  }
  return /^es\b/i.test(navigator.language ?? '') ? 'es' : 'en';
}

export const lang: Lang = detect();

/** The text in the current language. */
export function t(es: string, en: string): string {
  return lang === 'en' ? en : es;
}

/** Saves the choice and reloads, so every screen is rebuilt in the new language. */
export function setLang(next: Lang): void {
  if (next === lang) return;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage blocked: it would only last until the reload, so there's nothing to do */
    return;
  }
  location.reload();
}

/** The user manual in the current language. */
export const manualUrl = (anchor = ''): string => `${lang === 'en' ? 'manual-en.html' : 'manual.html'}${anchor}`;

if (typeof document !== 'undefined') document.documentElement.lang = lang;
