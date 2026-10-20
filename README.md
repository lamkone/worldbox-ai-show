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

El visor es una página de retransmisión: mapa en vídeo en el centro y dos columnas de
drama a los lados.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WorldBox · ROJO vs AZUL      Ronda 3/8   Marcador 728 · 693   EN DIRECTO │
├────────────────────┬─────────────────────────────────────┬───────────────┤
│  ROJO              │                                     │  AZUL         │
│  Jepy Djomo        │                                     │  Los Azules   │
│  412 unidades      │          EL MUNDO, EN VÍDEO         │  380 unidades │
│  ▓▓▓▓▓▓░░░░  moral │     (capturas del juego en bucle)   │  ▓▓▓▓░░░░░    │
│  puro drama        │                                     │  puro drama   │
│  ┌──────────────┐  │                                     │  ┌──────────┐ │
│  │"Tu reino es  │  │                                     │  │"Cuestión │ │
│  │de cartón."   │  │                                     │  │de cálculo"│ │
│  └──────────────┘  │  ┌────────────────────────────────┐ │  └──────────┘ │
│  💀 😭 🔥          │  │ pista de guerra · los dos bandos│ │  📊 🤓       │
│                    │  │ ROJO lanza la Bomba del Zar…    │ │               │
├────────────────────┴──┴────────────────────────────────┴─┴───────────────┤
│  histórico por ronda: gráfica de unidades + tabla de acciones y bajas     │
└──────────────────────────────────────────────────────────────────────────┘
```

Qué te vas a encontrar:

| Pieza | Qué hace |
|---|---|
| **Marcador** | Bajas causadas por cada bando, siempre a la vista en la cabecera. |
| **Drama en dos columnas** | Un feed por IA, con burbujas que entran animadas: chat, bombas, tropas, resultados de turno. |
| **Emojis que invaden la pantalla** | Cuando una IA suelta un emoji suelto, se hace grande y estalla. No es decoración: es el golpe emocional del turno. |
| **Ticker de guerra** | La «pista de guerra»: lo que lanzan los dos bandos, fuera del chat. Se lee de un vistazo quién está apretando. |
| **Titular de ronda** | Al cerrar cada ronda, un titular de prensa deportiva («ROJO arrasa tres ciudades y AZUL se queda mudo»). Lo escribe el director; con LLM, lo improvisa el modelo. |
| **Barra de tensión y moral** | Dos números que resumen cómo va la velada. La moral sube al pegar y baja al recibir; la tensión sube con los golpes cruzados y baja cuando la partida se desequilibra. |
| **Pantalla de victoria** | Ganador, unidades finales, bajas, mayor golpe, racha y duración, con lluvia de emojis. |
| **Modo cine** | Se queda solo la cabecera y el mapa, para ver el mundo sin distracciones. |

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

[`demo/index.html`](demo/index.html) es un reproductor autónomo: **un solo fichero HTML, sin dependencias,
sin red**. Reproduce una partida a partir de un `show.json` con el formato del
[contrato](docs/CONTRATO.md).

- **Doble clic y ya está** (`file://`). Sin servidor, sin PowerShell, sin juego.
- **Con otra partida:** `demo/index.html?show=ruta/a/tu-show.json`.
- **En GitHub Pages:** el workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
  publica `demo/` en cada push a `main` (o a `master`, por si el repo se publica con el
  nombre de rama antiguo). La primera vez hay que ir a **Settings → Pages → Build and
  deployment → Source: GitHub Actions**; a partir de ahí queda en
  `https://<usuario>.github.io/worldbox-ai-show/` y se puede compartir con un enlace.
- **Controles:** pausa (botón o `Espacio`), velocidad ×1 / ×2 / ×4 (botones o teclas
  `1` / `2` / `4`), saltar ±5 s con `←` / `→`, `R` reiniciar, `Fin` saltar al final y
  `Esc` cerrar la pantalla de victoria. La barra de progreso se puede arrastrar.
  Reproduce con los `t_ms` reales de los eventos, comprimidos.

Dentro lleva una partida de ejemplo embebida (ROJO contra AZUL, con sus pullas, sus
emojis y su ganador), así que funciona aunque no le pases nada.

## Teclas y trucos

| Tecla | Acción |
|---|---|
| `T` | Cambia el tema (oscuro / claro). |
| `L` | Bloquea o desbloquea el layout (los tiradores de las columnas). |
| `C` | Modo cine: solo cabecera y mapa. |
| `F` | Pantalla completa. |
| `R` | Restablece el layout y recarga. |
| `Esc` | Cierra la pantalla de victoria. |

- Los paneles laterales son **redimensionables**: arrastra cualquiera de los dos tiradores
  y cambian los dos a la vez, con un tope para que el mapa siempre mande. El layout se
  guarda en `localStorage`.
- En móvil (por debajo de 1000 px) pasa a una columna con el mapa primero y los feeds con
  scroll propio.
- El mapa se refresca a 9-14 fps en las pruebas, porque cada captura del bridge tarda
  42-128 ms. El resto de la interfaz va a 60 fps. No es un fallo: es el precio de pedir
  capturas al juego.

## Estructura del repo

```
worldbox-ai-show/
├── README.md                  ← estás aquí
├── LICENSE                    ← MIT
├── .gitignore
├── docs/
│   ├── CONTRATO.md            ← contrato de datos (state/feed/show)
│   ├── ARQUITECTURA.md        ← flujo por turno, director, diálogo
│   └── MONTAJE-WORLDBOX.md    ← BepInEx, mod, tokens, guardado, 401
├── demo/
│   └── index.html             ← reproductor autónomo de repeticiones
├── scripts/
│   ├── 18-wb-multi.ps1        ← cliente del bridge (tokens, Invoke-WbAgent)
│   ├── 19-wb-match.ps1        ← el motor
│   ├── 20-wb-viewer-server.ps1← servidor del visor (:8765)
│   ├── 21-drama.ps1           ← drama procedural (fallback)
│   ├── 22-director.ps1        ← moral, tensión, titulares, show.json
│   ├── 23-drama-llm.mjs       ← cerebro LLM opcional (:8766)
│   ├── viewer-live.html       ← plantilla del visor
│   └── agents.example.json    ← plantilla de tokens
└── .github/workflows/pages.yml← publica demo/ en GitHub Pages
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
