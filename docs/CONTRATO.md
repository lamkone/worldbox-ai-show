# Contrato de datos del show

El motor (`scripts/19-wb-match.ps1`) escribe tres ficheros en `reports/wb-match/`
y el visor (`scripts/viewer-live.html`, servido por `20-wb-viewer-server.ps1`)
los lee en bucle. Este documento es la única fuente de verdad: si cambias un
campo, cámbialo aquí primero.

Regla de oro: **todo es aditivo**. Un campo nuevo nunca rompe a un lector viejo;
un lector nuevo debe aguantar que el campo aún no exista.

---

## `state.json` — la foto del partido (se reescribe en cada turno)

```jsonc
{
  "ronda": 3,                  // ronda en curso (0 antes de empezar)
  "rondas": 8,                 // total de rondas pactadas
  "turno": "rojo",             // a quién le toca ahora
  "terminada": false,
  "ganador": "",               // "ROJO" | "AZUL" | "EMPATE" | ""
  "tick": 145233,              // tick del mundo en WorldBox
  "actualizado": "18:44:12",   // HH:mm:ss local
  "fase": "combate",           // "espera" | "apertura" | "combate" | "ronda" | "final"
  "inicio_ms": 1792515726750,  // epoch ms del arranque (para el reloj del visor)
  "ahora_ms": 1792515900123,

  "marcador": {                // acumulado de la partida
    "rojo": { "agente": "rojo", "reino": 73, "nombre": "Jepy Djomo",
              "bajas": 728, "perdidas": 693, "acciones": 14, "turnos": 8,
              "ciudades_arrasadas": 2 },
    "azul": { }
  },

  "scoreboard": {              // lectura directa del juego AHORA
    "rojo": { "id": 73, "nombre": "Jepy Djomo", "unidades": 412, "ciudades": 9 },
    "azul": { }
  },

  "drama": {                   // NUEVO: lo que alimenta la capa de espectáculo
    "moral":   { "rojo": 62, "azul": 88 },     // 0-100, sube al pegar, baja al recibir
    "tension": 74,                              // 0-100, cuánto se está calentando
    "titular": "ROJO arrasa tres ciudades y AZUL se queda mudo",
    "beat":    "ronda",                         // "apertura"|"combate"|"ronda"|"final"
    "narrador": "El público no da crédito a lo que acaba de ver."
  },

  "historial": [               // una fila por ronda terminada
    { "ronda": 1, "dominio": "rojo",
      "rojo_unidades": 1201, "azul_unidades": 1188,
      "rojo_bajas": 96,  "azul_bajas": 41,
      "rojo_ciudades": 11, "azul_ciudades": 10,
      "rojo_acciones": "czar · 50 bandidos",
      "azul_acciones":  "napalm · 40 zorros",
      "titular": "ROJO abre la ronda con un golpe de 96 bajas",
      "golpe": { "agente": "rojo", "bajas": 96 } }
  ],

  "resumen": {                 // agregados de toda la partida (para la victoria)
    "duracion_s": 184,
    "total_bajas":    { "rojo": 728, "azul": 693 },
    "total_perdidas": { "rojo": 693, "azul": 728 },
    "mayor_golpe":    { "agente": "rojo", "bajas": 312, "ronda": 4 },
    "racha":          { "agente": "rojo", "rondas": 3 },
    "curvas":         { "rojo": [1201, 1150, 980], "azul": [1188, 1090, 940] },
    "pico_bajas":     { "rojo": 312, "azul": 180 }
  }
}
```

## `feed.json` — el hilo de lo que va pasando (array, se reescribe por entrada)

Cada entrada lleva siempre `seq` (monótono creciente dentro de la partida),
`t` (HH:mm:ss), `ronda`, `turno`, `agente` (`rojo` | `azul` | `sistema`),
`tipo` y `texto`.

| `tipo`      | quién     | qué es                                                        | extras |
|-------------|-----------|---------------------------------------------------------------|--------|
| `chat`      | rojo/azul | **puro drama**: lo que se dicen. Nada de gameplay aquí.        | `para`, `tono`, `intensidad` (0-1), `respuesta_a` (seq) |
| `emoji`     | rojo/azul | emoji **suelto**, sin texto: una emoción lanzada al público    | `emocion`, `intensidad` |
| `bomba`     | rojo/azul | lanza un poder sobre un grupo enemigo                          | `power` |
| `tropas`    | rojo/azul | desembarca unidades                                            | `entity`, `count` |
| `resultado` | rojo/azul | cierre de turno: bajas, pérdidas, enemigo restante             | |
| `ronda`     | sistema   | titular/cierre de ronda                                        | |
| `titular`   | sistema   | titular de prensa de la ronda (beat de espectáculo)            | |
| `info`      | sistema   | arranque, avisos                                               | |
| `error`     | sistema   | fallo de bridge (nunca debería verse en el show)               | |

`tono` ∈ `chulo` | `llanto` | `burla` | `nervios` | `golpe` | `emoji`.
El visor usa `tono` e `intensidad` para decidir tamaño, animación y si el emoji
invade la pantalla.

## `show.json` — la partida entera, para repetirla (NUEVO)

Lo escribe el motor al terminar (y lo actualiza al cerrar cada ronda). Es lo que
consume la página de repetición (`worldbox-ai-show/demo/`), que no necesita ni
WorldBox ni PowerShell: solo este JSON.

```jsonc
{
  "version": 2,
  "meta": {
    "fecha": "2026-10-20 19:40",
    "rondas": 8,
    "resolucion_s": 4,
    "reinos": { "rojo": { "id": 73, "nombre": "Jepy Djomo" },
                "azul": { "id": 78, "nombre": "Los Azules" } },
    "inicio_ms": 1792515726750,
    "fin_ms": 1792515910123,
    "duracion_s": 184,
    "ganador": "ROJO"
  },
  "estado_inicial": { "rojo": { "unidades": 1201, "ciudades": 11 },
                      "azul": { "unidades": 1188, "ciudades": 10 } },
  "rondas": [
    { "ronda": 1, "titular": "…", "dominio": "rojo",
      "rojo": { "unidades": 1150, "bajas": 96, "ciudades": 11, "acciones": ["czar"] },
      "azul": { "unidades": 1090, "bajas": 41, "ciudades": 10, "acciones": ["napalm"] } }
  ],
  "eventos": [                 // el feed entero, con tiempo relativo
    { "seq": 1, "t_ms": 1200, "ronda": 1, "agente": "rojo",
      "tipo": "chat", "texto": "…", "tono": "chulo", "intensidad": 0.7 }
  ],
  "resumen": { }
}
```

## `out/` frente a `reports/wb-match/`

El motor escribe en `-OutDir` (por defecto `C:\DSH\PC_Optimizer\reports\wb-match`).
`state.json`, `feed.json`, `frame.jpg` y `show.json` son la superficie pública.
`informe.md` es para humanos. El visor solo necesita los cuatro primeros.
