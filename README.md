# Overdrive Control

App web (PWA) para conducir coches **Anki Overdrive** por Bluetooth, sin la app oficial.
El protocolo está portado de [OpenOverdrive](https://github.com/dschwen/OpenOverdrive) (app Android, Kotlin).

## Qué hace

- Conecta uno o varios coches (cada uno con su pestaña y su color de luces).
- Acelerador vertical tipo "control de crucero": arrástralo y la velocidad se queda ahí.
- Freno, cambio de carril izquierda/derecha y media vuelta.
- Velocímetro con velocidad real (la que reporta el coche) y objetivo, batería, estado en pista/cargador.
- Reconexión automática si se pierde la señal. Botón **STOP** que frena todos los coches.
- Mantiene la pantalla encendida mientras conduces y vibra al pulsar.

### Controles

| Acción            | Pantalla            | Teclado          | Mando (Xbox/PS) |
|-------------------|---------------------|------------------|-----------------|
| Velocidad         | Acelerador / ▲ ▼    | W / S, ↑ / ↓     | RT (gatillo)    |
| Frenar            | FRENO               | Espacio          | LT o B          |
| Carril izq./der.  | ‹ Carril / Carril › | A / D, ← / →     | LB / RB, cruceta|
| Media vuelta      | Media vuelta        | U                | Y               |
| Frenar todos      | STOP                | Esc              | —               |
| Cambiar de coche  | Pestañas            | 1–9              | —               |

## Dónde funciona

Usa **Web Bluetooth**, así que necesitas **Chrome o Edge** en Android, Windows, macOS, Linux o ChromeOS.
En iPhone/iPad Safari no lo soporta: usa el navegador gratuito **Bluefy**.

Web Bluetooth solo funciona en páginas **HTTPS** o en `localhost`.

## Uso

```bash
npm install
npm run dev        # http://localhost:5173  (en el PC, ya puedes conectar coches)
npm test           # tests del protocolo
npm run build      # genera dist/
```

- **Modo demo** sin coches: `http://localhost:5173/?demo`
- **En el móvil** hay que servirla por HTTPS. Opciones:
  1. **GitHub Pages** (recomendado): sube el proyecto a un repo de GitHub, en *Settings → Pages* elige
     *GitHub Actions* como origen. El workflow `.github/workflows/pages.yml` la publica en cada push a `main`.
     Abre la URL en Chrome del móvil y usa *Añadir a pantalla de inicio* para tenerla como app.
  2. Cualquier hosting estático con HTTPS (Netlify, Cloudflare Pages…): sube la carpeta `dist/`.
  3. Pruebas rápidas por cable: conecta el Android por USB, en Chrome del PC abre `chrome://inspect`,
     activa *Port forwarding* `5173 → localhost:5173` y abre `http://localhost:5173` en el móvil.

### Consejos

- Enciende el coche y ponlo sobre la pista antes de conectar. Si no aparece en la lista, ponlo un momento en el cargador.
- Los cambios de carril y la media vuelta solo funcionan con el coche en marcha (la app lo acelera a 300 mm/s si está parado).
- El nombre del modelo (Skull, Thermo…) se lee del anuncio Bluetooth cuando el navegador lo permite; si no, aparece como "Drive".

## Arquitectura

```
src/
  protocol.ts   Codificación/decodificación de mensajes (bytes idénticos a OpenOverdrive/drive-sdk)
  transport.ts  Conexión Web Bluetooth (GATT, notificaciones, reintentos)
  sim.ts        Coche simulado para el modo demo
  car.ts        Lógica de un coche: handshake, cola de escritura, velocidad, carriles, reconexión
  gamepad.ts    Soporte de mando
  main.ts       Interfaz (TypeScript sin framework)
tests/          Tests de bytes del protocolo y del comportamiento de Car
```

`Car` serializa las escrituras GATT (Web Bluetooth no admite operaciones solapadas) y fusiona los
comandos de velocidad, así que arrastrar el acelerador nunca acumula retraso.

No está afiliada a Anki ni a Digital Dream Labs.
