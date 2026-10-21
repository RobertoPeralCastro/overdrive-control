import '@fontsource/russo-one/latin.css';
import '@fontsource-variable/exo-2/wght.css';
import '@fontsource-variable/exo-2/wght-italic.css';
import './styles.css';
import './game.css';
import { countVisit } from './visits';

countVisit();

/** Opening the app from an invite link (?join=CODE) makes this phone a guest; otherwise it is the host. */
const params = new URLSearchParams(location.search);
const join = params.get('join');
if (join) void import('./guest').then((m) => m.startGuest(join, params.has('demo')));
else void import('./host');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
