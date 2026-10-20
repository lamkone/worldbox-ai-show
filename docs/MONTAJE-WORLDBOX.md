# Montaje del lado WorldBox

Guía para dejar WorldBox listo para el show: BepInEx, el mod WorldBoxBridge, los tokens
de los dos agentes y el guardado con dos reinos. Al final está el diagnóstico del error
que más tiempo hace perder: el **401**.

Si ya tienes WorldBox con el bridge funcionando, salta directamente a
[Poner los tokens en el repo](#6-poner-los-tokens-en-el-repo).

> Índice: [README](../README.md) · [Arquitectura](ARQUITECTURA.md) ·
> [Contrato de datos](CONTRATO.md).

---

## 0. Lo que necesitas

| Cosa | Detalle |
|---|---|
| WorldBox | De Steam. La ruta típica es `C:\Program Files (x86)\Steam\steamapps\common\worldbox`. |
| BepInEx 5 | Build x64 para Unity Mono (la que se probó: **5.4.23.2**, Unity 2022.3.60). |
| Mod WorldBoxBridge | `WorldBoxBridge.dll`. **No está en este repo**: pídeselo a quien te pasó el proyecto o compílalo desde su fuente. |
| Un guardado | Con al menos dos reinos vivos. El del proyecto es `save2`. |

No hace falta ser administrador para jugar al show, pero copiar BepInEx dentro de
`Program Files` puede pedir permisos de administrador.

## 1. Instalar BepInEx

1. Descarga BepInEx 5 x64 (el paquete con `winhttp.dll`, `doorstop_config.ini` y la
   carpeta `BepInEx`).
2. Extrae el contenido **en la carpeta del juego**, junto a `worldbox.exe`. Debe quedar:

   ```
   worldbox\
   ├── worldbox.exe
   ├── winhttp.dll
   ├── doorstop_config.ini
   ├── .doorstop_version
   ├── BepInEx\
   │   ├── core\
   │   ├── plugins\
   │   └── config\
   ├── Mods\
   ├── MonoBleedingEdge\
   └── worldbox_Data\
   ```

3. Arranca el juego una vez y ciérralo. Si BepInEx está bien, habrá creado
   `BepInEx\LogOutput.log` y la carpeta `BepInEx\plugins`. En ese log debe verse la
   versión de BepInEx y el arranque del chainloader.

Si el juego no arranca o no aparece el log, el problema es de BepInEx, no del show:
revisa que sea la build **x64** y que `winhttp.dll` esté junto al `.exe`.

## 2. Instalar el mod WorldBoxBridge

1. Copia `WorldBoxBridge.dll` a `BepInEx\plugins\`:

   ```
   C:\Program Files (x86)\Steam\steamapps\common\worldbox\BepInEx\plugins\WorldBoxBridge.dll
   ```

2. Arranca el juego y espera. El mod crea su configuración en
   `BepInEx\config\WorldBoxBridge.cfg`:

   ```ini
   [Bridge]
   enabled = true
   host = 127.0.0.1
   port = 8723
   token = <secreto compartido>

   [Game]
   suppress_startup_window = true
   ```

   - `port` es el puerto del bridge. El proyecto asume **8723**.
   - `suppress_startup_window = true` salta la ventana de bienvenida del juego, que
     pausa la simulación hasta que alguien la cierra. Sin eso, el motor se queda mirando
     un mundo congelado.
   - `token` es el secreto del **modo legacy** (un solo token). En modo multiagente se
     ignoran los tokens de aquí y manda el fichero del paso 3.

3. Comprueba que el bridge escucha. Con el juego abierto:

   ```powershell
   Invoke-RestMethod -Uri http://127.0.0.1:8723/cmd -Method Post `
     -ContentType 'application/json' `
     -Body '{"name":"health","args":{}}'
   ```

   Debe contestar un objeto con el estado del bridge. Si da «no se puede conectar»:
   juego cerrado, `enabled = false`, puerto cambiado o el DLL no está en `plugins\`.

## 3. Activar el modo multiagente

El bridge trae infraestructura multiagente de serie. Se activa **solo con crear un
fichero** en la config del mod:

```
C:\Program Files (x86)\Steam\steamapps\common\worldbox\BepInEx\config\WorldBoxBridge.agents.json
```

Con este contenido (cambia los dos tokens por secretos tuyos, largos y distintos):

```json
{
  "scenario": "pvp",
  "partial_intel": true,
  "turn_based": true,
  "agents": [
    {
      "id": "rojo",
      "token": "PON_AQUI_UN_SECRETO_LARGO_PARA_ROJO",
      "role": "god",
      "kingdom_claim": "id:73",
      "objectives": [
        { "id": "conquista", "label": "Destruir el reino de AZUL (78)", "kind": "wipe_kingdom", "target": "78" },
        { "id": "supervivencia", "label": "Sobrevivir con mi reino intacto", "kind": "survive", "target": "73" }
      ]
    },
    {
      "id": "azul",
      "token": "PON_AQUI_OTRO_SECRETO_LARGO_PARA_AZUL",
      "role": "god",
      "kingdom_claim": "id:78",
      "objectives": [
        { "id": "conquista", "label": "Destruir el reino de ROJO (73)", "kind": "wipe_kingdom", "target": "73" },
        { "id": "supervivencia", "label": "Sobrevivir con mi reino intacto", "kind": "survive", "target": "78" }
      ]
    }
  ],
  "turn_order": ["rojo", "azul"]
}
```

| Campo | Obligatorio | Qué hace |
|---|---|---|
| `scenario` | no | `sandbox` (por defecto), `pvp`, `coop`, `hierarchical`. El show usa `pvp`. |
| `partial_intel` | no | Si es `true`, cada agente ve información parcial. Por defecto ya es `true` en `pvp`. |
| `turn_based` | no | Activa el gate de turnos. |
| `agents` | **sí** | Array no vacío. |
| `agents[].id` | **sí** | `rojo` y `azul`; el motor usa exactamente esos ids. |
| `agents[].token` | **sí** | Secreto de ese agente. Es el que va en `X-WB-Token`. |
| `agents[].role` | no | `god` por defecto (todos los permisos: es lo que necesita el motor para lanzar poderes). |
| `agents[].kingdom_claim` | no | `id:<número>` (o `auto:<ordinal>`) del reino que reclama. Ojo: es **declarativo** — el mod lo guarda y lo enseña en `session_info`, pero no limita a qué reinos puedes tocar. El motor no depende de él para jugar. |
| `agents[].objectives` | no | Objetivos declarativos (`wipe_kingdom`, `survive`, `maximize_pop`, `freeform`…). El motor no los usa para jugar, pero quedan en `objective_status`. |
| `turn_order` | no | Orden de turnos. Debe referenciar ids existentes. |

**Reinicia el juego** después de crear o editar el fichero: se lee al arrancar.

Comprobación: el `health` del paso 2 tiene que decir ahora `"multi_agent": true` y
`"agent_count": 2`. Y con el token de un agente puedes preguntar quién eres:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8723/cmd -Method Post `
  -Headers @{ 'X-WB-Token' = 'TOKEN_DEL_AGENTE_ROJO' } `
  -ContentType 'application/json' `
  -Body '{"name":"whoami","args":{}}'
```

Debe devolver `rojo` (y sus permisos). Si el `health` sigue en modo legacy, mira el
`BepInEx\LogOutput.log`: si el JSON está mal, el mod escribe
`[session] FAILED to load ... Falling back to legacy single-token mode. Fix the file and restart the game.`
No rompe el juego; simplemente ignora tu configuración.

> **Truco si el JSON te da guerra:** valida que sea JSON puro (sin comentarios, sin comas
> finales) y guárdalo en UTF-8 **sin BOM**. Un BOM al principio es suficiente para que el
> parser se caiga y el mod vuelva al modo legacy.

## 4. Los dos tokens

Hay dos sitios donde viven los tokens y hay que mantenerlos **iguales**:

| Sitio | Para qué |
|---|---|
| `BepInEx\config\WorldBoxBridge.agents.json` (en la carpeta del juego) | el bridge comprueba el token que llega en cada petición |
| `scripts\agents.local.json` (en el repo) | el motor manda ese token en cada llamada |

Los tokens son secretos: el repo ignora `agents.local.json` en el `.gitignore`. No los
pegues en un issue ni en una captura.

## 5. El guardado y los dos reinos

El motor necesita un mundo con **al menos dos reinos vivos** y ganas de pelear. Por
defecto:

1. Llama a `load_world` con `path = 'save2'` (el guardado que usaba el proyecto).
2. Espera a que el mundo esté listo comprobando tres cosas: ancho **576**, al menos
   **2 reinos vivos** y **≥1000** unidades vivas. Si tu guardado es de otro tamaño, esa
   comprobación hay que ajustarla (está en `scripts/19-wb-match.ps1`, en el bucle que
   sigue al `load_world`).
3. Juega con los reinos **73** (ROJO) y **78** (AZUL).

Para saber qué IDs tiene tu mundo:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8723/cmd -Method Post `
  -Headers @{ 'X-WB-Token' = 'TOKEN_DEL_AGENTE_ROJO' } `
  -ContentType 'application/json' `
  -Body '{"name":"objective_status","args":{}}' |
  ConvertTo-Json -Depth 8
```

La respuesta trae `kingdoms[]` con `id`, `name`, `units` y `cities`. De ahí salen los dos
números que necesitas:

- Si tus reinos no son 73 y 78, pásalos al motor:
  `-ReinoRojo <id> -ReinoAzul <id>`, y actualiza los `kingdom_claim` del
  `WorldBoxBridge.agents.json` para que cada agente reclame el suyo.
- Si tu guardado no se llama `save2`, cambia la cadena en la llamada a `load_world` del
  motor, o arranca con `-SinReset` para jugar sobre el mundo que ya tengas abierto.

**Preparar dos reinos.** Vale cualquier mundo con dos reinos, pero para un show que se
entienda:

- Que los dos tengan un tamaño parecido. El motor ya compensa con acciones por turno
  (ROJO 2, AZUL 3), pero un reino con el triple de unidades no tiene partido.
- Que estén cerca o con territorio disputado: si están en esquinas opuestas, los clusters
  enemigos quedan lejos y las bombas caen sobre el vacío.
- Que haya población suficiente (>1000 unidades vivas): con un mundo casi vacío el
  marcador se queda a cero y no hay drama que contar.
- Que el mundo esté **pausado o en velocidad baja** mientras arranca el motor; él ya pone
  `set_speed 3` y `resume` cuando está listo.

## 6. Poner los tokens en el repo

En la raíz del repo:

```powershell
Copy-Item scripts\agents.example.json scripts\agents.local.json
```

Y edita `scripts/agents.local.json` con **los mismos tokens** que pusiste en
`WorldBoxBridge.agents.json`:

```json
{
  "rojo": "EL_TOKEN_DE_ROJO",
  "azul": "EL_TOKEN_DE_AZUL"
}
```

Alternativa sin fichero: variables de entorno (tienen prioridad sobre el JSON).

```powershell
$env:WB_TOKEN_ROJO = 'EL_TOKEN_DE_ROJO'
$env:WB_TOKEN_AZUL = 'EL_TOKEN_DE_AZUL'
```

Si falta el token, el motor no arranca y suelta:
`Falta el token del agente 'rojo': crea scripts\agents.local.json o define la variable de entorno WB_TOKEN_ROJO.`

## 7. Arrancar el show

Con WorldBox abierto y el bridge respondiendo:

```powershell
pwsh -File scripts/19-wb-match.ps1 -Rondas 8 -ResolucionSeg 4
```

El motor recarga `save2`, espera a que el mundo esté listo, arranca el visor si no había
uno y empieza a jugar. Abre <http://localhost:8765/>.

Si ya tienes el mundo cargado y no quieres recargarlo: añade `-SinReset`.

## Si el bridge devuelve 401

Un **401** del bridge significa «falta el token o no vale»: el mod contesta
`UNAUTHORIZED` / `Missing or invalid credential...`. El show no puede jugar sin
autenticarse. Repasa esto **en orden**:

1. **¿El token es el mismo en los dos sitios?** Compara carácter a carácter el de
   `scripts\agents.local.json` con el de `BepInEx\config\WorldBoxBridge.agents.json`.
   Un espacio al final, un salto de línea pegado al copiar o una mayúscula cambiada dan
   401.
2. **¿Has reiniciado el juego después de editar `WorldBoxBridge.agents.json`?** Ese
   fichero se lee al arrancar. Si lo has cambiado con el juego abierto, el bridge sigue
   con los tokens viejos.
3. **¿El bridge está en modo multiagente?** Pregunta el `health`: debe decir
   `"multi_agent": true` y `"agent_count": 2`. Si dice `false`, el fichero no se cargó:
   ruta equivocada, JSON inválido, BOM o el juego no se reinició. Mira el log de BepInEx:
   el mod deja un `FAILED to load ... Falling back to legacy single-token mode`.
4. **¿Estás usando el token del modo legacy?** Si el bridge ha caído a modo legacy, el
   único token válido es el `[Bridge] token` de `WorldBoxBridge.cfg`, y los agentes
   `rojo`/`azul` no existen. Arregla el punto 3: no hay forma de que el show funcione en
   legacy.
5. **¿La cabecera es la correcta?** El token va en `X-WB-Token` (o como
   `Authorization: Bearer <token>`). Un `Content-Type` mal puesto no da 401, pero un
   header con otro nombre sí.
6. **¿Hay espacios o saltos en el JSON?** Abre `WorldBoxBridge.agents.json` en un editor
   que enseñe caracteres invisibles. Los tokens no deben llevar espacios.
7. **¿El puerto es el correcto?** El motor habla con `127.0.0.1:8723`. Si has cambiado
   `[Bridge] port`, o cambias el cliente o vuelves a 8723.

Para aislar el problema, prueba cada token a mano con `whoami` (sección 3): si uno de los
dos funciona y el otro no, el problema es ese token concreto, no el montaje.

> **Ojo, no confundir:** el cerebro LLM también puede devolver 401, pero esos son de las
> cuentas de workbuddy, no del bridge. No afectan al juego: si el cerebro falla, el motor
> cae al drama procedural y el show sigue. Los 401 que importan son los del puerto 8723.

## Otros errores típicos

| Síntoma | Causa probable |
|---|---|
| «el mundo no terminó de cargar (width/kingdoms/population)» | El guardado no es `save2`, no tiene dos reinos vivos o no llega a 1000 unidades. También pasa si la ventana de bienvenida del juego está abierta (mira `suppress_startup_window`). |
| «Falta el token del agente…» | No existe `scripts\agents.local.json` ni las variables `WB_TOKEN_*`. |
| El mundo se queda congelado | `suppress_startup_window = false` y la ventana de bienvenida pausando el juego, o el juego en pausa. |
| El visor no abre / «no pude abrir el puerto 8765» | Otro visor ya corriendo o el puerto ocupado. Prueba `-PuertoVisor 8770` (el 8766 es del cerebro LLM). |
| Las frases son siempre las mismas | No hay cerebro LLM; el repertorio procedural es finito. Arranca `23-drama-llm.mjs` o revisa su `/health`. |
| «no hay node en el PATH; drama procedural» | Node no instalado o no está en el PATH. El show funciona igual. |

## Checklist final

Antes de dar el montaje por bueno:

- [ ] `BepInEx\plugins\WorldBoxBridge.dll` existe y el juego arranca.
- [ ] `BepInEx\config\WorldBoxBridge.agents.json` existe, es JSON válido y UTF-8 sin BOM.
- [ ] `health` devuelve `multi_agent: true` y `agent_count: 2`.
- [ ] `whoami` con el token de ROJO devuelve `rojo`; con el de AZUL, `azul`.
- [ ] `scripts\agents.local.json` tiene los dos tokens iguales (o están las variables
      `WB_TOKEN_ROJO` / `WB_TOKEN_AZUL`).
- [ ] `objective_status` enseña dos reinos con unidades y ciudades.
- [ ] `-ReinoRojo` / `-ReinoAzul` coinciden con esos ids (por defecto 73 y 78).
- [ ] El motor arranca sin errores y el visor abre en <http://localhost:8765/>.
