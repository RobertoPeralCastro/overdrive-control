# Overdrive Control

App web (PWA) para conducir coches **Anki Overdrive** por Bluetooth, sin la app oficial.
El protocolo está portado de [OpenOverdrive](https://github.com/dschwen/OpenOverdrive) (app Android, Kotlin).

## Qué hace

- Interfaz de **juego de carreras**: menú principal (Carrera rápida, Campaña, Multijugador, Garaje),
  garaje con carrusel de coches, pantalla de carrera a pantalla completa y podio con premios al final.
- Flujo en 3 pasos: **Garaje** (conectar, foto o dibujo de cada coche, color, piloto, «Identificar»
  que lo hace parpadear) → **Preparar carrera** (escanear, vueltas, armas) → **Carrera**.
- En carrera: pedal de **freno** a la izquierda, **gas** a la derecha (control de crucero: la velocidad se queda
  donde lo dejas), botones de armas con recarga, velocidad en km/h a escala 1:50 con volante, posición, vuelta,
  blindaje, energía y minimapa. Con mando, el circuito en grande.
- Reconexión automática si se pierde la señal. Botón **STOP** que frena todos los coches.
- Mantiene la pantalla encendida mientras conduces y vibra al pulsar o al recibir un impacto.
- Al empezar, los coches van solos a la línea de salida y luego arranca el semáforo.
- En el móvil se juega en **horizontal como un volante**: inclinar el móvil cambia de carril.
- **Campaña** de 10 pruebas contra la IA y **estadísticas** guardadas por coche (victorias,
  velocidad máxima, tiempo en cabeza, vuelta rápida…). Todo explicado en `public/manual.html`.

### Controles

| Acción            | Pantalla            | Teclado          | Mando (Xbox/PS)          |
|-------------------|---------------------|------------------|--------------------------|
| Velocidad         | Pedal GAS           | W / S, ↑ / ↓     | RT (gatillo), cruceta ▲▼ |
| Frenar            | Pedal FRENO         | Espacio          | LT o B                   |
| Carril izq./der.  | Inclinar / ◀ ▶      | A / D, ← / →     | LB / RB, cruceta, stick  |
| Media vuelta      | Prueba libre        | U                | Y                        |
| Láser / Misil     | Botones de armas    | Q / E            | A / X                    |
| Pulso / Escudo    | Botones de armas    | R / F            | L3 / R3                  |
| Empezar carrera   | ¡A correr!          | —                | Start                    |
| Frenar todos      | STOP / ⏸            | Esc              | Select / Back            |

### Mandos USB y Bluetooth

Cualquier mando que el navegador reconozca (Xbox, PlayStation, 8BitDo…) funciona por cable o por
Bluetooth. El navegador solo lo muestra después de **pulsar un botón** del mando. Se pueden usar varios a la vez:
en el **Garaje** elige "Mando 1", "Mando 2"… como piloto de cada coche. Un mando sin coche asignado
conduce el coche que tengas seleccionado.

Mientras un mando conduce tu coche, la pantalla de carrera oculta los controles táctiles y muestra en su
lugar el circuito en grande con todos los coches.

### Dos o más jugadores

Hay dos formas de jugar varios a la vez:

- **Un móvil y varios mandos.** Un solo móvil conecta todos los coches. En el **Garaje** asigna "Mando 1",
  "Mando 2"… a cada coche (también puedes poner coches con IA).
- **Varios móviles.** Cada jugador conduce su coche desde su propio móvil:
  1. En el móvil anfitrión pulsa **Multijugador** (o **📱** arriba) → aparece un **código QR** y un código de 5 letras.
  2. En el otro móvil, escanea el QR con la cámara (o abre la app, pulsa 📱 y escribe el código).
  3. Ese móvil conecta **su** coche por Bluetooth y ya lo conduce, con pantalla, teclado o mando.
  4. El anfitrión empieza la carrera desde **Preparar carrera**: semáforo, vueltas, armas e IA valen para todos,
     y cada móvil ve la pantalla de carrera de su coche: semáforo, pedales, armas, posición y minimapa, con sonidos.

  La conexión es directa entre móviles (WebRTC). Solo para encontrarse usan el servidor público y gratuito de
  [PeerJS](https://peerjs.com), así que hace falta internet (wifi o datos) en ambos. Cada coche solo puede estar
  conectado a un móvil a la vez.

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
Cada arma tiene su efecto de sonido.

### Carrera

**Preparar carrera** dibuja la pista escaneada; en carrera, el minimapa muestra los coches moviéndose en directo.
Hacia dónde gira cada curva se sabe por la distancia que recorre cada rueda; si falta ese dato, la curva se
dibuja hacia la izquierda.

1. Elige el número de vueltas, si hay armas o no, y el piloto de cada coche: tú en pantalla, un mando o la IA.
2. **¡A correr!**: los coches van a la línea de salida y luego el semáforo de 5 luces rojas con pitidos; al apagarse,
   ¡YA! Antes los coches no se mueven, aunque ya tengas el gas puesto.
3. La app cuenta las vueltas al cruzar la meta, muestra tu posición en directo y, al final, el podio con premios
   (ganador, más rápido, más tiempo en cabeza, vuelta rápida…). Cada coche frena al terminar.

| Nivel de IA | Qué hace                                                                                       |
|-------------|------------------------------------------------------------------------------------------------|
| IA fácil    | Va tranquila (≈600 mm/s), casi no dispara y nunca empuja.                                       |
| IA normal   | Ritmo de carrera (≈850 mm/s), dispara a menudo y a veces te embiste por detrás en las curvas.   |
| IA difícil  | Rápida (≈1100 mm/s) y agresiva: te embiste en las curvas y se pone a tu lado para sacarte.      |

Los empujones son reales: la IA se alinea con tu carril y acelera a fondo cuando entras en una curva, o se pone
a tu altura y da un volantazo hacia ti. **Pueden sacar coches de la pista**, así que ojo si la pista está en una mesa.

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
  track.ts      Aprende el orden de las piezas y el giro de las curvas (escaneo)
  field.ts      Posición de cada coche en la pista aprendida
  trackmap.ts   Geometría del mapa de la pista
  battle.ts     Armas virtuales: blindaje, energía, objetivos e impactos
  race.ts       Carrera: semáforo, vueltas, clasificación y ganador
  ai.ts         Pilotos de IA (3 niveles, con empujones)
  sound.ts      Efectos de sonido sintetizados con Web Audio
  gamepad.ts    Varios mandos USB/Bluetooth a la vez
  campaign.ts   Los 10 niveles de la campaña y su seguimiento
  stats.ts      Estadísticas por coche y premios de fin de carrera
  tilt.ts       Volante con el giroscopio
  avatars.ts    Imagen de cada coche
  screens.ts    Menú principal, garaje, preparar carrera y campaña
  hud.ts        Pantalla de carrera a pantalla completa (anfitrión e invitado)
  mapview.ts    Mapa de la pista con los coches en directo
  cockpit.ts    Pantalla de prueba libre (la misma en el anfitrión y en el invitado)
  game.css      Estética de juego de carreras
  net.ts        Conexión entre móviles (PeerJS/WebRTC)
  remote.ts     Multijugador: puente Bluetooth del invitado y estado que le envía el anfitrión
  host.ts       App del móvil anfitrión (TypeScript sin framework)
  guest.ts      App del móvil invitado (?join=CÓDIGO)
  main.ts       Elige anfitrión o invitado según la URL
tests/          Tests del protocolo, Car, pista, armas, carrera, IA y multijugador
```

`Car` serializa las escrituras GATT (Web Bluetooth no admite operaciones solapadas) y fusiona los
comandos de velocidad, así que arrastrar el acelerador nunca acumula retraso.

No está afiliada a Anki ni a Digital Dream Labs.
