# Arquitectura del show

Este documento explica cómo está montado el show por dentro: qué hace cada pieza, cómo
fluye un turno y dónde acaba cada dato. El formato exacto de los ficheros que se
comparten entre motor y visor está en **[CONTRATO.md](CONTRATO.md)**; aquí se cuenta el
porqué y el recorrido.

Si lo que buscas es montarlo, empieza por el **[README](../README.md)** y por
**[MONTAJE-WORLDBOX.md](MONTAJE-WORLDBOX.md)**.

---

## Las piezas y quién manda en qué

| Pieza | Sabe de | No sabe de |
|---|---|---|
| `scripts/19-wb-match.ps1` (motor) | rondas, turnos, objetivos, medidas, marcador | cómo contar el drama con gracia |
| `scripts/22-director.ps1` (director) | moral, tensión, beats, titulares, veredicto, `show.json` | pelear, mover unidades |
| `scripts/23-drama-llm.mjs` (cerebro) | generar frases con un LLM real | estado del juego (se lo cuenta el director) |
| `scripts/21-drama.ps1` (procedural) | componer frases con vocabulario y plantillas | cuándo usarlo (lo decide el director) |
| `scripts/18-wb-multi.ps1` (cliente) | tokens y llamadas HTTP al bridge | cualquier lógica del show |
| `scripts/20-wb-viewer-server.ps1` | servir ficheros por HTTP | generarlos |
| `scripts/viewer-live.html` | pintar el estado y el feed | calcular nada del juego |
| `demo/index.html` | reproducir un `show.json` | conectarse a nada |

La regla de oro: **el motor manda en el juego, el director manda en el relato, y el visor
solo pinta**. Ninguna capa necesita a la de arriba para funcionar: si el cerebro LLM no
está, el director usa el procedural; si el visor no está, el motor sigue jugando y
escribiendo ficheros.

## De dónde salen los datos: el bridge

WorldBox no expone nada por sí solo. El mod **WorldBoxBridge** abre una API HTTP local en
`http://127.0.0.1:8723/cmd`, con autenticación por token de agente en la cabecera
`X-WB-Token`. El cliente (`18-wb-multi.ps1`) manda siempre el mismo sobre:

```json
{ "name": "invoke_power", "args": { "power_id": "czar_bomba", "x": 320, "y": 240 } }
```

y recibe `{ ok, result, tick }` o `{ ok: false, code, error }`. Los comandos que usa el
motor:

| Comando | Para qué |
|---|---|
| `session_info` | ver de quién es el turno y qué reino tiene reclamado cada agente |
| `turn_advance` | pasar el turno (el motor lo fuerza antes de cada jugada) |
| `objective_status` | marcador: unidades y ciudades de cada reino |
| `query_actors` | posiciones de unidades, paginadas; el motor las agrupa en clusters |
| `invoke_power` | lanzar un poder de dios (bombas) sobre una coordenada |
| `spawn` | crear criaturas (bandidos, zorros) sobre una coordenada |
| `send_message` / `recv_messages` | el buzón del chat entre agentes |
| `screenshot` | captura del mundo en JPEG base64 |
| `load_world`, `set_speed`, `resume`, `pause` | control del mundo |

Detalle que cuesta una tarde si no lo sabes: `spawn` usa `entity_id` (no `asset_id`), y
en PowerShell hay que llamar al parámetro `-A` y no `$Args` (es variable automática y se
come el hashtable).

## Un turno, paso a paso

Cada ronda tiene dos turnos: uno de ROJO y otro de AZUL. Un turno es esto:

1. **Forzar el turno** (`Ensure-Turn`). Pregunta `session_info`; si el turno no es del
   agente, lo avanza con `turn_advance`. Hace falta porque un agente con rol `god` puede
   actuar fuera de turno: el gate del mod no le bloquea, así que el orden real lo impone
   el motor.
2. **Foto de partida** (`Get-Scoreboard`): `objective_status` devuelve unidades y
   ciudades de los dos reinos. Es el «antes».
3. **Observar** (`Get-Observacion`): además del marcador, pide `query_actors` de su reino
   y del rival, y agrupa las unidades en una rejilla de celdas de 24 px. Cada celda es un
   «cluster» con centro y número de unidades. Eso es lo que convierte un reino entero en
   tres o cuatro objetivos manejables.
4. **Decidir** (`New-Plan`): elige el cluster enemigo más denso, el segundo, y si va muy
   tocado respecto al arranque, refuerza. La personalidad fija el número de acciones por
   turno (ROJO 2, AZUL 3: handicap porque su reino empieza más pequeño).
5. **Hablar** (misma `New-Plan`, último punto): pide contexto al director
   (`Get-ContextoDrama`) y una réplica a `Get-Replica`, que intenta el LLM y cae al
   procedural. De vez en cuando, en lugar de frase, suelta un emoji suelto
   (`Get-EmojiDrama`).
6. **Ejecutar**: `invoke_power` y `spawn` contra el bridge, y `send_message` para el chat.
   Cada acción real se apunta en `AccionesRonda` (para el histórico) y en el feed.
7. **Escuchar**: `recv_messages` con un cursor por agente (`since_seq`), solo lo nuevo.
   Si el rival ha dicho algo, el agente contesta una vez (sin bucles de respuesta
   infinita).
8. **Dejar resolver**: `Start-Sleep -Seconds $ResolucionSeg` (4 s por defecto) para que
   el mundo asiente: la bomba cae, la población se actualiza, las unidades se mueven.
9. **Medir**: nueva foto del marcador. Las **bajas** son
   `max(0, unidades_enemigas_antes − unidades_enemigas_después)`; las **pérdidas**, lo
   mismo con el reino propio. Se acumulan en el marcador y se publica una entrada
   `resultado` en el feed.
10. **Publicar**: captura (`frame.jpg`), `turn_advance`, y `state.json` + `feed.json`
    reescritos. El visor ve el turno completo en el siguiente ciclo de sondeo.

### El cierre de ronda

Al terminar los dos turnos:

- Se calcula el **dominio** de la ronda (quién ha causado más bajas en esos dos turnos).
- Se acumulan las **curvas** (unidades al final de cada ronda), el **pico de bajas** y el
  **mayor golpe** de la partida, y se actualizan las **rachas**.
- El director cierra la ronda en su línea temporal: `Add-ShowRonda` con el titular.
- Se escribe una entrada `ronda` en el feed y se actualiza `state.json`.

Al final de la partida gana quien más bajas ha causado en total. El director pide el
veredicto (`Get-Veredicto`) y el motor escribe el `show.json` completo con `Save-Show`.

## Los tres ficheros

Todo lo que se comparte entre capas son tres JSON. Su esquema exacto, campo a campo,
está en **[CONTRATO.md](CONTRATO.md)** — allí es la única fuente de verdad. Resumen de
responsabilidades:

| Fichero | Lo escribe | Lo lee | Para qué |
|---|---|---|---|
| `state.json` | motor (+ director) | visor | la foto del partido: ronda, turno, marcador, historial, `drama` (moral, tensión, titular, beat, narrador) y `resumen`. Se reescribe entero en cada turno. |
| `feed.json` | motor | visor | el hilo de lo que va pasando, en orden (`seq` monótono). Se reescribe entero cada vez que hay una entrada nueva, para que cada decisión aparezca en el momento. |
| `show.json` | director | `demo/index.html` | la partida entera con tiempos relativos (`t_ms`), lista para reproducirla sin WorldBox. Se actualiza al cerrar cada ronda y se cierra al final. |

Dos reglas que valen para los tres:

- **Todo es aditivo.** Un campo nuevo no rompe a un lector viejo; un lector nuevo aguanta
  que el campo todavía no exista. Por eso el visor nunca se cae a mitad de partida porque
  el motor haya añadido algo.
- **La escritura es tolerante.** El servidor del visor lee estos ficheros mientras el
  motor los escribe; en Windows eso puede bloquear un instante. Por eso el motor escribe
  con reintentos (`Save-Texto`, 12 intentos con 60 ms de espera) y el servidor abre con
  `FileShare.ReadWrite` y reintenta también. Ninguno de los dos tumba al otro.

## El director: moral, tensión, beats y titulares

`22-director.ps1` se carga con dot-sourcing desde el motor y comparte su ámbito, así que
ve `$script:Marcador`, `$script:Ronda` o `$script:Terminada` sin que nadie se los pase.
Todo lo que devuelve es opcional: si el cerebro está apagado, las funciones devuelven
`$null` y el motor tira de su plan B.

### Beats

El show se cuenta en beats, no en turnos. El estado (`state.json.fase`) y la entrada del
director distinguen:

| Beat | Qué es |
|---|---|
| `espera` | antes de empezar; cargando el mundo |
| `apertura` | presentación de las dos IAs |
| `combate` | los turnos, el grueso del show |
| `ronda` | cierre de ronda, con su titular |
| `final` | ganador, veredicto y pantalla de victoria |

El beat decide el **tono** de la réplica: no se pide lo mismo en la apertura («preséntate
con una amenaza») que en el cierre de una ronda que se está perdiendo («estás perdiendo y
se te escapa el nervio»).

### Moral y tensión

Dos números, 0-100, que el visor pinta como barras. La moral arranca en 70 y se mueve con
lo que pasa en el turno, en escala logarítmica (5 bajas no son la mitad de 500):

- la moral del que pega sube `6 · log10(1 + bajas)` y la del rival baja
  `4 · log10(1 + bajas)`;
- la del que recibe baja `5 · log10(1 + pérdidas)` y la del rival sube
  `3 · log10(1 + pérdidas)`;
- se queda siempre entre 15 y 100: ni euforia infinita ni depresión total.

La tensión arranca en 25 y sube con el choque (`4 · log10(1 + bajas + pérdidas) + 1.5`).
Baja 2 puntos cuando la moral de los dos bandos se separa más de 25: si ya se sabe quién
gana, deja de haber drama. Los golpes gordos pueden empujarla aparte (`Push-Tension`).

La **intensidad** de un golpe es otra escala logarítmica normalizada contra una
referencia de 250 bajas (`Get-Intensidad`). El visor la usa para el tamaño de los efectos:
no es lo mismo una bomba de 20 bajas que una de 800.

### Titulares y veredicto

- `Get-Titular` pide al cerebro un titular de prensa deportiva para la ronda (máximo 12
  palabras). Si no hay cerebro, devuelve `$null` y el cierre de ronda se queda con el
  texto objetivo que compone el motor («ROJO golpea más fuerte, 412 frente a 180 bajas»).
- `Get-Veredicto` pide la frase final del ganador o del perdedor. Mismo trato: si no hay
  cerebro, no hay frase extra.

### La línea temporal

El director va guardando la partida en dos listas (`Add-ShowEvent`, `Add-ShowRonda`) y al
final las vuelca con `Save-Show` en `show.json` (versión 2 del contrato):

- `eventos[]`: el feed entero, pero con `t_ms` relativo al arranque en lugar de hora de
  reloj. Así la repetición sabe cuándo pasó cada cosa sin depender de la hora local.
- `rondas[]`: una fila por ronda con su titular, su dominio y las acciones de cada bando.
- `meta` y `resumen`: fecha, reinos, duración, ganador y los agregados de la partida.

Ese fichero es lo que hace posible `demo/index.html`: reproducir la partida sin WorldBox.

## Cómo se genera el diálogo

Hay dos motores de frases y el director decide cuál usa en cada llamada. Nunca hay un
guion fijo.

```
Get-Replica ──► Invoke-Cerebro POST /line ──► 23-drama-llm.mjs ──► LLM
     │                    │
     │                    └─ no responde / ok:false ──┐
     ▼                                               ▼
  (texto, tono, fuente)                     New-Drama (21-drama.ps1)
```

### El camino LLM (opcional)

`23-drama-llm.mjs` es un servidor Node independiente. Se apoya en el pool de cuentas del
vault de DSH (`%USERPROFILE%\.dsh\workbuddy-vault\global\*.json`): lee los tokens, rota
entre cuentas con enfriamiento y refresca credenciales cuando caducan. Endpoints:

| Ruta | Cuerpo | Devuelve |
|---|---|---|
| `GET /health` | — | `{ ok, cuentas, sanas, modelo, llamadas, fallos, uptime_s }` |
| `POST /line` | `{ agente, tipo, contexto, ultimoRival, maxTokens }` | `{ ok, texto, ms, cuenta, tipo }` |
| `POST /emoji` | `{ agente, conModelo, contexto }` | `{ ok, emoji }` |
| `POST /headline` | `{ agente, contexto }` | `{ ok, texto }` |
| `POST /verdict` | `{ agente, contexto, ganador }` | `{ ok, texto }` |

El `tipo` de `/line` es el beat: `apertura`, `golpe`, `contra`, `ronda`, `nervios`,
`burla`, `final` o `turno`. Cada uno añade una instrucción distinta al prompt. El modelo
lleva la persona fija de cada IA y una memoria corta (8 mensajes) para poder contestar a
lo que dijo el rival; el contexto de la partida va en el prompt para que hable de números
reales.

Si una cuenta falla, el servidor la pone en cuarentena según el error (401 → refresca
token; 429 → 20 s; 403 o cuota agotada → 30 min; red o 5xx → 8 s) y prueba otra. Si se
agotan los intentos devuelve `{ ok: false }`, y ahí entra el plan B.

### El camino procedural (siempre disponible)

`21-drama.ps1` no tiene frases prefijadas: tiene vocabulario y plantillas.

- Cada personaje tiene sus listas: sustantivos, cualificadores, verbos, insultos y emojis.
  ROJO habla de fuego, tronos y ceniza; AZUL, de modelos, variables y errores de redondeo.
- `New-Drama` elige una plantilla según el **ratio de fuerzas** (va perdiendo por debajo
  de 0,55; va ganando por encima de 1,9; si no, va igualada) y rellena los huecos. Un 45 %
  de las veces «hace eco» de una palabra larga de lo último que dijo el rival, para que se
  contesten de verdad.
- `New-Golpe` da la reacción corta al recibir un bombazo y `New-Emoji` suelta un emoji.

Es determinista en el sentido de que no depende de nadie: si el LLM se cae a mitad de
partida, el show sigue con la misma voz y el mismo ritmo. La fuente de cada frase viaja en
el plan (`fuente = 'llm' | 'procedural'`) para poder depurar.

## La repetición

[`demo/index.html`](../demo/index.html) no sabe nada del motor ni del bridge. Solo entiende el contrato
`show.json`: lee `meta`, `estado_inicial`, `rondas[]`, `eventos[]` y `resumen`, y
reproduce los eventos según su `t_ms` con velocidad ajustable. Por eso funciona igual
abierta con doble clic, servida desde GitHub Pages o con `?show=<url>` apuntando a
cualquier partida.

## Decisiones que conviene entender

- **Las bajas se miden por ventana, no por diferencia acumulada.** Los reinos crecen solos
  (~1-2 % cada 8 s): si comparas el acumulado, una acción que no mate a tiempo se la come
  el crecimiento y el marcador miente. La ventana antes/después de cada turno mide lo que
  de verdad ha hecho esa IA.
- **El contrato es aditivo.** Motor, visor y repetición se despliegan por separado y a
  veces se actualizan a destiempo. Con campos opcionales, un visor viejo sigue pintando
  una partida nueva sin romperse.
- **El motor impone el orden de turnos.** El rol `god` del mod puede actuar fuera de
  turno; el gate solo avisa. Confiar en él sería confiar en que el juego haga de árbitro.
- **El show nunca depende del LLM.** El cerebro es una mejora, no un requisito: el drama
  procedural está siempre ahí y el director cae a él sin hacer ruido.
- **El visor no calcula.** Todo lo que necesita (marcador, drama, resumen) está en
  `state.json` y `feed.json`; si el visor tuviera que deducir la tensión o el titular, dos
  pestañas abiertas podrían contar cosas distintas.
