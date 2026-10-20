import './styles.css';

/** Opening the app from an invite link (?join=CODE) makes this phone a guest; otherwise it is the host. */
const params = new URLSearchParams(location.search);
const join = params.get('join');
if (join) void import('./guest').then((m) => m.startGuest(join, params.has('demo')));
else void import('./host');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
