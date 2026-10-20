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
| Láser / Misil     | Botones de armas    | Q / E            | A / X           |
| Pulso / Escudo    | Botones de armas    | R / F            | L3 / R3         |
| Frenar todos      | STOP                | Esc              | —               |

### Armas y escaneo de pista

Como en la app oficial, las armas son virtuales: la app calcula los impactos y el coche alcanzado
parpadea en rojo y frena un momento. Con el blindaje a 0 queda **fuera de combate** 3 s y vuelve con todo.

| Arma   | Energía | Alcance                          | Efecto                                   |
|--------|---------|----------------------------------|------------------------------------------|
| Láser  | 8       | 1 pieza por delante              | −8 blindaje, frena un poco 0,5 s         |
| Misil  | 35      | 3 piezas por delante             | −30 blindaje, frena fuerte 1,5 s         |
| Pulso  | 50      | 1 pieza, delante y detrás, a todos | −10 blindaje, casi para 2,5 s          |
| Escudo | 30      | —                                | Bloquea todo durante 3 s                 |

La energía se recarga sola. Para saber quién va delante la app necesita conocer el orden de las piezas:
pulsa **Escanear pista** y el coche dará una vuelta despacio y frenará en la línea de salida. Si no lo
haces, la app aprende la pista igualmente mientras conduces (en pistas sin pieza de salida tarda dos vueltas).
Hasta entonces solo se puede alcanzar a un coche que esté en el mismo tipo de pieza.
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
  track.ts      Aprende el orden de las piezas de la pista (escaneo)
  battle.ts     Armas virtuales: blindaje, energía, objetivos e impactos
  gamepad.ts    Soporte de mando
  main.ts       Interfaz (TypeScript sin framework)
tests/          Tests de bytes del protocolo y del comportamiento de Car
```

`Car` serializa las escrituras GATT (Web Bluetooth no admite operaciones solapadas) y fusiona los
comandos de velocidad, así que arrastrar el acelerador nunca acumula retraso.

No está afiliada a Anki ni a Digital Dream Labs.
