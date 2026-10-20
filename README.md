# WorldBox AI Show 🎭💥

Dos IAs se pelean por el mismo mundo de **WorldBox** y **se insultan en directo**.
Un motor en PowerShell las hace jugar por turnos (bombas, tropas, reclamos de
territorio) y un visor web enseña la partida como si fuera un partido: mapa en
vídeo, marcador, gráfica de unidades, pista de guerra compartida y un chat que
es puro drama.

> El diálogo no está escrito de antemano: se **genera en cada turno** con el
> estado real de la partida (cuántas unidades lleva cada bando, qué ronda es,
> qué acaba de decir el rival). Por eso cada partida suena distinta.

## Qué hace

- **Motor por turnos** (`scripts/19-wb-match.ps1`): carga un guardado de WorldBox,
  elige objetivos, lanza bombas y tropas, mide bajas reales y lleva el marcador.
- **Cerebro de diálogo** (`scripts/21-drama.ps1`): vocabulario + plantillas +
  contexto. Cada IA tiene su voz: ROJO es bruto y teatral, AZUL es pedante y
  calculador. Hay llantos, nervios, burlas, respuestas al rival y **emojis sueltos**.
- **Visor en directo** (`scripts/viewer-live.html`): mapa en vídeo (capturas del
  juego), marcador, gráfica de unidades por ronda, histórico con lo que lanzó cada
  IA, **pista de guerra compartida** (las acciones de los dos bandos, fuera del
  chat) y pantalla de victoria con estadísticas y lluvia de emojis.
- **Servidor local** (`scripts/20-wb-viewer-server.ps1`): sirve la página y los
  JSON de estado en `http://localhost:8765/`.

## Requisitos

- Windows con **PowerShell 7** (`pwsh`).
- **WorldBox** de Steam con **BepInEx** y el mod **WorldBoxBridge** (no incluido
  en este repo; el bridge expone una API local en `http://127.0.0.1:8723/cmd`
  con un token por agente).
- Un guardado del juego con dos reinos (por defecto el motor carga `save2`).

## Puesta en marcha

1. Copia `scripts/agents.example.json` a `scripts/agents.local.json` y pega los
   tokens de los dos agentes del bridge (o define `WB_TOKEN_ROJO` / `WB_TOKEN_AZUL`).
2. Arranca WorldBox y espera a que el bridge responda.
3. Lanza una partida:

   ```powershell
   pwsh -File scripts/19-wb-match.ps1 -Rondas 8 -ResolucionSeg 4
   ```

4. Abre <http://localhost:8765/> y mira el show.

El motor escribe `out/state.json`, `out/feed.json`, `out/frame.jpg` e
`out/informe.md`. El visor se alimenta de ahí.

## Cómo funciona por dentro

```
WorldBox  ──(BepInEx + WorldBoxBridge, HTTP local)──►  18-wb-multi.ps1
                                                         │
                          19-wb-match.ps1  ◄─────────────┘
                                 │  escribe state.json / feed.json / frame.jpg
                                 ▼
                     20-wb-viewer-server.ps1  ──HTTP──►  viewer-live.html
```

- `19-wb-match.ps1` lleva el bucle de rondas: cada IA observa, decide 2-3
  acciones, comenta y se mide el daño real comparando el mundo antes y después.
- `21-drama.ps1` es el generador: sustantivos, adjetivos, verbos e insultos por
  personaje, plantillas según el ratio de fuerzas, y un eco del último mensaje
  del rival para que se contesten de verdad.
- El visor pide `/state.json`, `/feed.json` y `/frame.jpg?live=1` y pinta todo sin
  recargar. El render del chat es incremental (solo añade lo nuevo) para que no
  parpadee.

## Detalles que molan

- Los emojis del chat **invaden la pantalla** un instante.
- Cada golpe hace **volar emojis** sobre el mapa.
- El ganador recibe una **lluvia de emojis** en la pantalla de victoria.
- Modo cine (🎬) para ver solo el mapa y atajos de teclado: `T` tema, `L` bloqueo,
  `C` cine, `F` pantalla completa, `R` reiniciar layout, `Esc` cerrar.

## Licencia

MIT. Haz lo que quieras, pero si lo usas para montar un show, avisa: quiero verlo.
