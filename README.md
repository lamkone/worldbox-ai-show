# WorldBox AI Show 🎭💥

**Dos IAs se pelean de verdad en WorldBox y se insultan en directo.**

Un motor en PowerShell pone a dos reinos del juego a pelear por turnos —bombas, tropas,
poderes de dios— y una capa de dirección convierte cada ronda en un espectáculo: las dos
IAs se pican, se burlan y se lamentan por un chat que se genera al vuelo, con el estado
real de la partida. Todo se ve en un visor web que parece la retransmisión de un partido.

No hay guion. Cada réplica se compone en el turno con los números de verdad (cuántas
unidades lleva cada bando, qué ronda es, qué acaba de decir el rival). Por eso cada
partida suena distinta, y por eso el que va perdiendo empieza a llorar en público.

> **▶️ Verlo ahora, sin montar nada: <https://lamkone.github.io/worldbox-ai-show/>**
>
> Es una partida completa reproduciéndose sola en el navegador. La vía rápida para
> enseñárselo a alguien: **no necesita WorldBox, ni PowerShell, ni Node**.
> También puedes abrir [`demo/index.html`](demo/index.html) con doble clic.

---

## Qué es el show

- **Dos reinos, dos IAs.** ROJO y AZUL controlan un reino cada uno dentro de la misma
  partida de WorldBox. Juegan por turnos: observan el mapa, eligen objetivos, lanzan
  bombas y desembarcan tropas.
- **El marcador son bajas reales.** El motor mide las unidades enemigas que había antes
  y después de cada turno. No hay puntos inventados: si la bomba no mata, no suma.
- **El drama va aparte.** El chat es puro espectáculo: pullas, burlas, nervios, llantos
  y emojis sueltos. Nada de ahí afecta al gameplay, y el gameplay no se inventa el
  diálogo. Son dos capas que se alimentan la una a la otra.
- **Cada uno tiene su voz.** ROJO es bruto, chulesco y teatral. AZUL es pedante,
  calculador y condescendiente. Cuando el cerebro LLM está encendido, improvisa un
  modelo de verdad con esas personas; cuando no, entra el generador procedural y el
  show sigue igual.

## Cómo se ve

El visor es una **retransmisión deportiva**: el mapa del juego a pantalla completa y un
HUD de cristal flotando encima. Nada de paneles de administración.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ WORLDBOX AI SHOW   RONDA 3/8   03:12   ROJO 728 · 693 AZUL   ● EN DIRECTO │
├──────────────────────┬──────────────────────────────────┬─────────────────┤
│ ROJO  Jepy Djomo     │                                  │ AZUL Los Azules │
│ 412 unidades         │      EL MUNDO, A PANTALLA        │ 380 unidades    │
│ MORAL ▓▓▓▓▓░░░       │      COMPLETA (vídeo en vivo)    │ MORAL ▓▓▓░░░░░  │
│ "Tu reino es de      │                                  │ "Cuestión de    │
│  cartón."  💀 😭 🔥  │                                  │  cálculo" 📊 🤓 │
├──────────────────────┴─────────┬────────────────┴───────┴─────────────────┤
│ PISTA DE GUERRA · ROJO lanza la Bomba del Zar… · AZUL desembarca…        │
├───────────────────────────────────────────────────────────────────────────┤
│ TENSIÓN 78%  CIUDADES 3-8  MAYOR GOLPE 748 AZUL  DURACIÓN 04:14  SEÑAL 18 │
└───────────────────────────────────────────────────────────────────────────┘
```

Qué te vas a encontrar:

| Pieza | Qué hace |
|---|---|
| **Cabecera broadcast** | Marca, ronda, reloj de partida, marcador de bajas y chip EN DIRECTO (o FINAL / REPETICIÓN). |
| **Dos paneles, solo lectura** | Un panel por IA con nombre, unidades, moral, stats de bajas/ciudades y su chat. Sin cajas de texto, sin apodos, sin visitantes: aquí solo hablan las dos IAs. |
| **Mapa a pantalla completa** | El mundo ocupa el escenario. La cámara **v5** solo se mueve cuando pasa algo: va al punto real del impacto (`easeOutQuint` con overshoot +0,12), aguanta 2,8 s con deriva de cámara en mano y vuelve en 900 ms a un punto de reposo cercano, **nunca al centro**. Entre planos hay 2,6 s de cooldown y los focos a menos de 4 % se descartan: se acabaron los zooms aleatorios. |
| **Rótulo y daño sobre el mapa** | Cada bomba escribe su nombre en el punto del golpe (`¡BOMBA ATÓMICA!`, `¡BOMBA DEL ZAR!`, `¡NAPALM!`) y, al caer el resultado, el número de bajas (`−250`) en grande. Rótulo y número se colocan midiendo el recorrido real de la animación: no se pisan nunca, ni en escritorio ni en móvil. |
| **Sonido de verdad** | Música procedural que sube con la tensión de la partida, efectos de impacto y **voces neuronales** para las dos IAs (es-CO Gonzalo y Salomé, con respaldo de las voces del navegador). Botón 🔊 con sliders de voz, música y efectos. |
| **Calidad de vídeo** | El stream publica solo la isla (recorte del mapa, con auto-recorte opcional) y el visor no amplía más de 1,55× (escritorio) / 1,35× (móvil): la imagen llega nítida en vez de pixelada. |
| **Emojis que invaden la pantalla** | Cada emoji suelto se hace gigante y tiene animación propia según la emoción (furia, llanto, burla, euforia, pánico). No es decoración: es el golpe emocional del turno. |
| **Impactos y sacudida** | Onda expansiva, escombros, chispas, flash y temblor de pantalla en el punto exacto del golpe. |
| **Pista de guerra** | Ticker continuo con lo que lanzan los dos bandos, fuera del chat. |
| **Titular de ronda** | Al cerrar cada ronda, un titular de prensa deportiva en la parte baja («ROJO arrasa tres ciudades y AZUL se queda mudo»). Lo escribe el director; con LLM, lo improvisa el modelo. |
| **Splash de ronda y barra de tensión** | Transición grande al empezar cada ronda y dos números que resumen cómo va la velada: tensión y moral. |
| **Pantalla de victoria** | Ganador, unidades finales, bajas, mayor golpe, racha y duración, con lluvia de confeti. |
| **Modo cine** | Se queda solo la cabecera y el mapa, para ver el mundo sin distracciones. |

## La calidad del vídeo

El visor no puede inventar píxeles: lo que llega del juego es lo que hay. La cadena es
`24-wb-stream.ps1` (PrintWindow → JPEG → MJPEG) y la palanca de calidad es **cuántos píxeles
reales ocupa la isla en la ventana del juego**.

1. **Recorte del mapa.** El stream publica solo el mapa, no la ventana entera: por defecto con
   el recorte fijo `-CropX0 0.297 -CropY0 0.165 -CropX1 0.764 -CropY1 0.753` (sin fondo azul
   ni HUD). Con `-AutoCrop` detecta la isla solo (la componente conexa más grande que no toca
   el borde) y se adapta si mueves la cámara del juego; se recalcula cada ~0,7 s y, si falla,
   cae al recorte fijo.
2. **Acercar la cámara DEL JUEGO.** Es la palanca de verdad. `wb-zoom.ps1` mueve la rueda
   sobre la ventana de WorldBox:

   ```powershell
   pwsh -File scripts\wb-zoom.ps1 -Pasos 5 -Real     # acercar 5 muescas
   pwsh -File scripts\wb-zoom.ps1 -Pasos -2 -Real    # alejar
   pwsh -File scripts\wb-zoom.ps1 -Stats             # ver la ventana detectada
   ```

   Objetivo: que la isla ocupe ~900-1100 px en el fotograma. Se comprueba con
   `curl.exe -s -o frame.jpg http://localhost:8767/frame.jpg` y
   `python reports\qa\medir-isla.py frame.jpg` (bbox de la isla + ampliación necesaria).
3. **Ajustes del stream.** `-MaxWidth 900 -Quality 82 -Fps 18` con el recorte fijo es el punto
   recomendado (la isla sale ~1:1). Si quieres más resolución, `-MaxWidth 1600 -Quality 86
   -Fps 18`, pero el techo real lo pone el bridge: cada captura tarda 42-128 ms, así que el
   mapa se refresca a 9-18 fps. El indicador **SEÑAL** de la cabecera muestra los fps reales;
   si baja de ~12, vuelve a 900/82/20.
4. **El visor no amplía de más.** El zoom de cámara está topado en 1,55× (escritorio) y 1,35×
   (móvil) justo para no reventar la nitidez del JPEG.

Regla de oro: si ves la isla blanda, no toques el visor; acerca la cámara del juego.

## Arquitectura

```
                        ┌──────────────────────────────┐
   WorldBox (Steam)     │  BepInEx + WorldBoxBridge    │
   con el mod  ────────►│  HTTP local en 127.0.0.1:8723 │
                        └──────────────┬───────────────┘
                                       │  X-WB-Token
                        ┌──────────────▼───────────────┐
                        │  scripts/18-wb-multi.ps1      │  cliente del bridge
                        └──────────────┬───────────────┘
                                       │
          ┌────────────────────────────▼────────────────────────────┐
          │  scripts/19-wb-match.ps1  — el MOTOR                    │
          │  rondas, turnos, decisiones, medidas de bajas, marcador │
          └───────┬───────────────────────────────┬─────────────────┘
                  │                               │
   ┌──────────────▼──────────────┐   ┌────────────▼──────────────────┐
   │ scripts/22-director.ps1     │   │ escribe en la carpeta de salida│
   │ moral, tensión, titulares,  │   │ state.json · feed.json         │
   │ beats y línea temporal      │   │ frame.jpg · show.json          │
   └───────┬─────────────────────┘   └────────────┬──────────────────┘
           │                                      │
  ┌────────▼─────────┐                ┌───────────▼──────────────────┐
  │ 23-drama-llm.mjs │  (opcional)    │ 20-wb-viewer-server.ps1      │
  │ LLM real en :8766│◄── fallback ──►│ sirve el visor en :8765      │
  └──────────────────┘  21-drama.ps1  └───────────┬──────────────────┘
                                                  │
                                     ┌────────────▼─────────────────┐
                                     │ scripts/viewer-live.html      │
                                     │ la retransmisión en el navegador│
                                     └──────────────────────────────┘
```

| Fichero | Rol |
|---|---|
| `scripts/19-wb-match.ps1` | El motor. Lleva las rondas y los turnos, decide, ejecuta contra el bridge, mide bajas y escribe el estado. |
| `scripts/22-director.ps1` | La capa de dirección: moral, tensión, beats, titulares, veredicto y la línea temporal que acaba en `show.json`. |
| `scripts/23-drama-llm.mjs` | El cerebro dramático (opcional). Servidor Node que pide réplicas a un LLM de verdad. Si no está, manda lo procedural. |
| `scripts/21-drama.ps1` | El generador procedural: vocabulario, plantillas y personalidad por IA. Es el suelo del show, nunca se queda mudo. |
| `scripts/18-wb-multi.ps1` | Cliente del bridge: tokens, `Invoke-WbAgent` y utilidades. |
| `scripts/20-wb-viewer-server.ps1` | Servidor local (`HttpListener`) que sirve la página y los JSON en `http://localhost:8765/`. |
| `scripts/viewer-live.html` | La plantilla del visor. El motor la copia a la carpeta de salida como `viewer.html`. |
| `scripts/viewer-fx.js` | Motor de efectos `window.ViewerFX` v3: etiquetas, daño gigante, emojis posicionables, impactos, chispas y confeti. |
| `scripts/viewer-voice.js` | Voces del show (`window.ViewerVoz`): neuronal por `tts-server.mjs` y respaldo Web Speech. |
| `scripts/show-music.js` | Música procedural WebAudio (`window.ShowMusic`) que sigue la tensión de la partida. |
| `scripts/show-audio-ui.js` | Panel de audio (`window.ShowAudioUI`): sliders de voz, música y efectos, mute y auto-duck. |
| `scripts/tts-server.mjs` | Servicio de voz neuronal local (`:8771`) con caché en `reports/tts-cache`. |
| `scripts/build-voice-pack.ps1` | Empaqueta las voces de la repetición (`demo/voz/*.mp3`) para que suene sin servidor. |
| `scripts/wb-zoom.ps1` | Acerca/aleja la cámara de WorldBox para subir la calidad real del vídeo. |
| `demo/index.html` | La repetición autónoma: reproduce un `show.json` sin WorldBox ni PowerShell. |

Los detalles técnicos (flujo por turno, contrato de datos, cómo se genera el diálogo)
están en **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)** y en el
**[contrato de datos](docs/CONTRATO.md)**.

## Requisitos

Para el show en directo:

- **Windows 10/11** (el visor y el motor usan `HttpListener` y `Start-Process`; no se ha
  probado fuera de Windows).
- **PowerShell 7** (`pwsh`). No vale el PowerShell 5.1 de serie.
- **WorldBox de Steam**, con:
  - **BepInEx 5** instalado en la carpeta del juego;
  - el mod **WorldBoxBridge**, que expone una API HTTP local en
    `http://127.0.0.1:8723` con un token por agente.
- **Un guardado con dos reinos.** Por defecto el motor carga el guardado `save2` y
  juega con los reinos **73** y **78**. Si los tuyos son otros, se cambia con
  `-ReinoRojo` y `-ReinoAzul` (y la ruta del guardado, en la línea del `load_world`).

Opcional:

- **Node.js 24** para el cerebro LLM (`23-drama-llm.mjs`) y las cuentas del vault de DSH.
  Sin Node, el show funciona igual con el drama procedural.

Para ver la repetición: cualquier navegador. Nada más.

El montaje del lado WorldBox (BepInEx, mod, tokens, guardado y el temido 401) tiene su
propia guía: **[docs/MONTAJE-WORLDBOX.md](docs/MONTAJE-WORLDBOX.md)**.

## Puesta en marcha

1. **Prepara WorldBox** siguiendo [docs/MONTAJE-WORLDBOX.md](docs/MONTAJE-WORLDBOX.md):
   BepInEx, el mod `WorldBoxBridge`, el fichero `WorldBoxBridge.agents.json` con los dos
   agentes y el guardado con dos reinos.

2. **Copia la plantilla de tokens** y pega dentro los dos tokens de agente del bridge:

   ```powershell
   Copy-Item scripts\agents.example.json scripts\agents.local.json
   ```

   ```json
   {
     "rojo": "TOKEN_DEL_AGENTE_ROJO",
     "azul": "TOKEN_DEL_AGENTE_AZUL"
   }
   ```

   `agents.local.json` está en el `.gitignore`: los tokens no se publican. Si prefieres
   no tener fichero, también valen las variables de entorno `WB_TOKEN_ROJO` y
   `WB_TOKEN_AZUL` (tienen prioridad sobre el JSON).

3. **Abre WorldBox** y espera a que el bridge responda. Con el juego cargado:

   ```powershell
   Invoke-RestMethod -Uri http://127.0.0.1:8723/cmd -Method Post `
     -Headers @{ 'X-WB-Token' = 'TOKEN_DEL_AGENTE_ROJO' } `
     -ContentType 'application/json' -Body '{"name":"health","args":{}}'
   ```

   Tiene que contestar `"multi_agent": true` y `"agent_count": 2`. Si no, vuelve a la
   guía de montaje: casi siempre es el `WorldBoxBridge.agents.json`.

4. **Lanza la partida** desde la raíz del repo:

   ```powershell
   pwsh -File scripts/19-wb-match.ps1 -Rondas 8 -ResolucionSeg 4
   ```

   `-Rondas` son rondas (cada ronda = un turno de cada IA) y `-ResolucionSeg` son los
   segundos que se deja resolver al mundo antes de medir el daño. Si el mundo ya está
   cargado y no quieres recargar el guardado, añade `-SinReset`.

5. **Abre <http://localhost:8765/>**. El motor arranca el servidor del visor solo (si no
   había uno escuchando). La página se actualiza cada segundo: verás las decisiones
   aparecer en el momento, no al final.

El motor escribe en la carpeta de salida (`-OutDir`; por defecto `reports/wb-match/`; al
arrancar, el servidor del visor imprime `sirviendo: <carpeta>` para que no haya dudas):

| Fichero | Contenido |
|---|---|
| `state.json` | Foto del partido: ronda, turno, marcador, historial, moral, tensión, titular. |
| `feed.json` | El hilo completo de lo que va pasando, con `seq` para pintar solo lo nuevo. |
| `frame.jpg` | Última captura del mundo (lo que se ve como «vídeo»). |
| `show.json` | La partida entera con tiempos relativos, para repetirla. |
| `informe.md` | Resultado legible para humanos: tabla por ronda y notas. |

Para parar el visor: `Stop-Process -Id (Get-Content reports\wb-match\visor.pid)`.
El motor, al terminar, deja el visor mostrando el último estado.

### Parámetros útiles del motor

| Parámetro | Por defecto | Para qué |
|---|---|---|
| `-Rondas` | `8` | Número de rondas. |
| `-ResolucionSeg` | `4` | Segundos de simulación por turno antes de medir bajas. |
| `-ReinoRojo` / `-ReinoAzul` | `73` / `78` | IDs de los dos reinos del guardado. |
| `-OutDir` | `reports/wb-match` | Carpeta de salida. |
| `-SinReset` | — | No recarga el guardado; juega sobre el mundo que ya está abierto. |
| `-SinServidor` | — | No arranca el visor (solo escribe los ficheros). |
| `-PuertoVisor` | `8765` | Puerto del visor. |
| `-SinCerebro` / `-SinDrama` | — | Desactiva el cerebro LLM y usa solo el drama procedural. |

## El cerebro LLM (opcional)

`scripts/23-drama-llm.mjs` es un servidor Node que convierte «frases graciosas» en
réplicas de verdad. Se apoya en las cuentas que ya tiene **DSH** en su vault
(`%USERPROFILE%\.dsh\workbuddy-vault\global\*.json`): lee los tokens de cada cuenta,
rota entre ellas, refresca credenciales cuando caducan y pone en cuarentena las que se
saturan o se quedan sin cuota. No hace falta configurar nada más.

Lo que hace por dentro:

- Mantiene la persona de cada IA (ROJO bruto y teatral; AZUL pedante y calculador) y una
  memoria corta de la conversación, para que se contesten de verdad.
- Recibe el contexto de la partida (ronda, unidades, bajas, ratio, moral, tensión) y lo
  mete en el prompt: el modelo habla de lo que está pasando, no de lo que pasó.
- Pide titulares de ronda y el veredicto final, además de las réplicas y los emojis.

Si el pool no responde —sin cuota, sin red, modelo saturado, Node no instalado— el
servidor devuelve `{ ok: false }` y el motor cae sin hacer ruido a `21-drama.ps1`. **El
show nunca se para por culpa del LLM.**

Se puede desactivar de dos formas:

- **No arrancarlo.** El director lo busca en `http://127.0.0.1:8766`; si no está, usa el
  procedural. (El propio director intenta arrancarlo si encuentra Node y el fichero; si
  no, sigue adelante.)
- **Arrancar el motor con `-SinCerebro`** (o `-SinDrama`). Entonces ni siquiera se
  intenta: el show va entero con el generador procedural.

Si quieres controlarlo a mano:

```powershell
node scripts/23-drama-llm.mjs                 # puerto 8766, modelo deepseek-v4.1-flash
node scripts/23-drama-llm.mjs --selftest      # prueba las cuentas y sale
node scripts/23-drama-llm.mjs --port 9000     # otro puerto (o DRAMA_PORT)
node scripts/23-drama-llm.mjs --model <id>    # otro modelo (o DRAMA_MODEL)
```

Y para comprobar que está vivo: `Invoke-RestMethod http://127.0.0.1:8766/health`
(devuelve cuentas, modelo, llamadas, fallos y uptime).

## La repetición, sin WorldBox

[`demo/index.html`](demo/index.html) es el reproductor de repeticiones: reproduce una
partida completa a partir de un `show.json` con el formato del
[contrato](docs/CONTRATO.md). En GitHub Pages usa `demo/show.json` (la última partida
real que publique `scripts/publish-show.ps1`); si no lo encuentra, cae a una partida de
ejemplo embebida.

- **Doble clic y ya está** (`file://`). Sin servidor, sin PowerShell, sin juego.
- **Con otra partida:** `demo/index.html?show=ruta/a/tu-show.json`.
- **Mismo motor de FX que el directo:** carga `../live/viewer-fx.js` (el motor v2 del
  visor) y, si no está, usa su capa interna de respaldo. El lenguaje visual es el mismo
  en el directo y en la repetición.
- **Chip EN VIVO:** el botón de la cabecera enlaza siempre a `../live/`; `live.json` solo
  decide si dice «EN VIVO AHORA» o «REPETICIÓN».
- **Controles:** pausa (botón o `Espacio`), velocidad ×1 / ×2 / ×4 (botones o teclas
  `1` / `2` / `4`), saltar ±5 s con `←` / `→`, `R` reiniciar, `Fin` saltar al final y
  `Esc` cerrar la pantalla de victoria. La barra de progreso se puede arrastrar.
- **Para capturas o enlaces directos:** `?auto=1` arranca solo y `?t=150` salta al
  segundo 150. En Chrome headless añade `&motion=full` (si no, el navegador pide
  `prefers-reduced-motion` y se pierden cámara y efectos).

## El directo (EN VIVO)

El modo directo enseña la partida **mientras se juega**. Son tres piezas:

| Pieza | Qué hace |
|---|---|
| `scripts/25-live-gateway.mjs` | Gateway Node en `:8770` que unifica visor (`:8765`), vídeo (`:8767`), cerebro (`:8766`) y hub de chat en un solo origen. |
| `scripts/26-live-publish.ps1` | Abre un túnel efímero de Cloudflare (`bin/cloudflared.exe`) hacia el gateway y escribe `live.json` con la URL pública. `-Parar` lo cierra y deja `en_vivo:false`. |
| `live/` | La misma página del visor preparada para publicarse: lee `../live.json`, encuentra el túnel y se conecta sola. Si el túnel no responde, muestra «El directo está apagado ahora mismo» y un enlace a la repetición. |

Para publicar todo de una vez (sincroniza el repo, genera `live/`, copia la última
partida, abre túnel, hace commit y push, y verifica GitHub Pages):

```powershell
pwsh -File scripts/publish-show.ps1 -Mensaje "show: nueva partida" -ConDirecto -Verificar
```

Sin `-ConDirecto` publica solo la repetición y la página `/live/` con el directo apagado.
El túnel de Cloudflare es **efímero**: si se cae, `/live/` avisa y enlaza a la repetición;
vuelve a lanzar `26-live-publish.ps1` para abrir uno nuevo.

## Teclas y trucos

Visor en vivo:

| Tecla | Acción |
|---|---|
| `T` | Cambia el tema (oscuro / claro). |
| `L` | Bloquea o desbloquea los tiradores de los paneles. |
| `C` | Modo cine: solo cabecera y mapa. |
| `F` | Pantalla completa. |
| `M` | Sonido on/off. |
| `V` | Voces on/off (alterna las voces neuronales de las dos IAs). |
| `R` | Restablece el layout y recarga. |
| `Esc` | Cierra la pantalla de victoria. |

Repetición: `Espacio` pausa, `1` / `2` / `4` cambian la velocidad, `←` / `→` saltan ±5 s,
`R` reinicia, `Fin` salta al final y `Esc` cierra la victoria.

- Los paneles se pueden ajustar arrastrando sus tiradores (y `L` los bloquea); el ancho
  se guarda en `localStorage`.
- En móvil el layout se compacta: cabecera, mapa, titular y los dos paneles 50/50 con
  chat, sin scroll horizontal.
- El mapa se refresca a 9-18 fps en las pruebas, porque cada captura del bridge tarda
  42-128 ms. El resto de la interfaz va a 60 fps. No es un fallo: es el precio de pedir
  capturas al juego.

## Estructura del repo

```
worldbox-ai-show/
├── README.md                  ← estás aquí
├── LICENSE                    ← MIT
├── .gitignore
├── live.json                  ← estado del directo (en_vivo + URL del túnel)
├── docs/
│   ├── CONTRATO.md            ← contrato de datos (state/feed/show)
│   ├── ARQUITECTURA.md        ← flujo por turno, director, diálogo
│   └── MONTAJE-WORLDBOX.md    ← BepInEx, mod, tokens, guardado, 401
├── demo/
│   ├── index.html             ← reproductor de repeticiones
│   ├── show.json              ← última partida real publicada
│   └── voz/                   ← pack de voces neuronales de la repetición (mp3 + voz.json)
├── live/
│   ├── index.html             ← visor del directo (generado por build-live-page.ps1)
│   ├── viewer-fx.js           ← motor de efectos v3
│   ├── viewer-voice.js        ← voces del show
│   ├── show-music.js          ← música procedural
│   └── show-audio-ui.js       ← panel de audio
├── scripts/
│   ├── 18-wb-multi.ps1        ← cliente del bridge (tokens, Invoke-WbAgent)
│   ├── 19-wb-match.ps1        ← el motor
│   ├── 20-wb-viewer-server.ps1← servidor del visor (:8765)
│   ├── 21-drama.ps1           ← drama procedural (fallback)
│   ├── 22-director.ps1        ← moral, tensión, titulares, show.json
│   ├── 23-drama-llm.mjs       ← cerebro LLM opcional (:8766)
│   ├── 24-wb-stream.ps1       ← captura MJPEG del juego (:8767)
│   ├── 25-live-gateway.mjs    ← gateway del directo (:8770)
│   ├── 26-live-publish.ps1    ← abre/cierra el túnel y escribe live.json
│   ├── viewer-live.html       ← plantilla del visor
│   ├── viewer-fx.js           ← motor de efectos (fuente)
│   ├── viewer-voice.js        ← voces del show (fuente)
│   ├── show-music.js          ← música procedural (fuente)
│   ├── show-audio-ui.js       ← panel de audio (fuente)
│   ├── tts-server.mjs         ← voz neuronal local (:8771)
│   ├── build-voice-pack.ps1   ← empaqueta voces de la repetición
│   ├── wb-zoom.ps1            ← zoom de la cámara del juego (calidad de vídeo)
│   ├── build-live-page.ps1    ← genera live/ desde la plantilla
│   ├── publish-show.ps1       ← publica todo (sync, build, túnel, push, verifica)
│   └── agents.example.json    ← plantilla de tokens
└── .github/workflows/pages.yml← publica demo/ en la raíz y live/ en /live/
```

## Si algo falla

| Síntoma | Qué mirar |
|---|---|
| «Falta el token del agente…» | No existe `scripts/agents.local.json` ni `WB_TOKEN_ROJO` / `WB_TOKEN_AZUL`. |
| El bridge devuelve **401** | Token que no coincide con el de `WorldBoxBridge.agents.json`. Guía paso a paso en [docs/MONTAJE-WORLDBOX.md](docs/MONTAJE-WORLDBOX.md#si-el-bridge-devuelve-401). |
| «el mundo no terminó de cargar» | El guardado no cumple lo que espera el motor (576 de ancho, ≥2 reinos, ≥1000 de población) o WorldBox no tiene cargado `save2`. |
| No hay visor | El puerto 8765 está ocupado; prueba `-PuertoVisor 8770` (8766 es del cerebro LLM). |
| Las frases se repiten mucho | Normal sin cerebro LLM: el repertorio procedural es finito. Arranca `23-drama-llm.mjs`. |

## Licencia

MIT. Haz lo que quieras con esto, pero si montas un show, avisa: quiero verlo.
