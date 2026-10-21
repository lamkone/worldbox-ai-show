<#
19-wb-match.ps1 - Partida de 2 IAs en WorldBox (modo multiagente del bridge).

Cada agente (rojo / azul) controla un reino y juega por turnos:
  - observa el mundo (sus unidades/ciudades y los grupos enemigos)
  - decide 2-3 acciones con su "cerebro" (reglas + personalidad)
  - comenta por el buzón del bridge (send_message), visible en el visor
El motor mide el daño real (unidades enemigas antes/después de cada turno),
lleva el marcador y escribe state.json + feed.json + frame.jpg en la carpeta
de salida. El visor en vivo (20-wb-viewer-server.ps1) los sirve por HTTP y la
página se actualiza sola cada segundo.

Uso:
  pwsh -File 19-wb-match.ps1 -Rondas 8
  pwsh -File 19-wb-match.ps1 -Rondas 4 -SinReset
  pwsh -File 19-wb-match.ps1 -Rondas 8 -SinServidor   # sin arrancar el visor
  pwsh -File 19-wb-match.ps1 -Rondas 8 -Guardado save5  # mundo pequeño = más fluido
#>
[CmdletBinding()]
param(
  [int]$Rondas = 12,
  [int]$ResolucionSeg = 6,
  [double]$PausaAccion = 1.2,
  # Reinos que pelean. 0 = automático: se eligen los dos reinos con más unidades
  # del mundo cargado (cada guardado usa ids distintos: save2 tiene 73/78, save5
  # tiene 1/2). Si se fijan a mano, se respetan.
  [int]$ReinoRojo = 0,
  [int]$ReinoAzul = 0,
  # Guardado de WorldBox que se carga al empezar (nombre de la carpeta en
  # saves/). save5 es un mundo pequeño (~307 KB) y va mucho más fluido que
  # save2 (~2,1 MB): menos entidades, menos trabajo para el juego y para la
  # captura. Se puede cambiar sin tocar el código.
  [string]$Guardado = 'save5',
  # Unidades de refuerzo por ronda y bando (0 = automático: 35 % de las iniciales,
  # tope 250). Con mundos pequeños evita que la guerra se apague en dos rondas.
  [int]$Refuerzos = 0,
  [string]$OutDir = '',
  [switch]$SinReset,
  [int]$MaxAcciones = 2,
  [int]$PuertoVisor = 8765,
  [switch]$SinServidor,
  [switch]$SinDrama,
  [switch]$SinCerebro
)

$ErrorActionPreference = 'Stop'
# el motor vive en <repo>/scripts: las salidas van a <repo>/reports/wb-match
$RaizProyecto = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $RaizProyecto 'reports\wb-match' }
. (Join-Path $PSScriptRoot '18-wb-multi.ps1')
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:Feed = New-Object System.Collections.ArrayList
$script:Marcador = [ordered]@{
  rojo = [ordered]@{ agente = 'rojo'; reino = $ReinoRojo; nombre = ''; bajas = 0; perdidas = 0; acciones = 0; turnos = 0; ciudades_arrasadas = 0; ciudades_perdidas = 0 }
  azul = [ordered]@{ agente = 'azul'; reino = $ReinoAzul; nombre = ''; bajas = 0; perdidas = 0; acciones = 0; turnos = 0; ciudades_arrasadas = 0; ciudades_perdidas = 0 }
}
# --- ciudades concretas: para que el diálogo hable de sitios por su nombre ---
# list_cities da id/nombre/reino; comparando la foto de antes y la de después del
# turno sabemos qué ciudad exacta ha caído y podemos nombrarla en el chat.
# OJO con los nombres: en un script dot-sourceado, $script:X y un $X de nivel
# superior son LA MISMA variable (PowerShell no distingue mayúsculas). Por eso
# aquí todo lleva prefijo "Total"/"Nombre" y no se llama igual que los locales.
$script:NombreCiudadPerdida = @{ rojo = ''; azul = '' }    # última ciudad propia perdida
$script:NombreCiudadArrasada = @{ rojo = ''; azul = '' }   # última ciudad del rival arrasada
$script:TotalCiudadesPerdidas = @{ rojo = 0; azul = 0 }    # acumulado real de la partida
$script:TotalCiudadesArrasadas = @{ rojo = 0; azul = 0 }   # acumulado real de la partida
$script:Inicio = $null
$script:Cursor = @{ rojo = 0; azul = 0 }
$script:Historial = New-Object System.Collections.ArrayList
$script:FramePath = Join-Path $OutDir 'frame.jpg'
$script:Ronda = 0
$script:TurnoN = 0
$script:TurnoActual = 'rojo'
$script:Tick = 0
$script:Terminada = $false
$script:Ganador = ''
$script:FeedSeq = 0
# lo que lanza cada IA en la ronda en curso (para el histórico del visor)
$script:AccionesRonda = @{ rojo = (New-Object System.Collections.ArrayList); azul = (New-Object System.Collections.ArrayList) }
# --- resumen de partida para el visor (state.json.resumen) ---
$script:TInicioPartida = $null   # cuando empieza de verdad la partida
$script:TFinPartida = $null      # se congela al terminar, para que duracion_s no baile
$script:Curvas = [ordered]@{
  rojo = (New-Object System.Collections.ArrayList)   # unidades al final de cada ronda
  azul = (New-Object System.Collections.ArrayList)
}
$script:PicoBajas = @{ rojo = 0; azul = 0 }          # máximo de bajas en una sola ronda
$script:MayorGolpe = @{ agente = ''; bajas = 0; ronda = 0 }
$script:RachaActual = @{ rojo = 0; azul = 0 }        # rondas seguidas dominando ahora
$script:RachaMaxima = @{ rojo = 0; azul = 0 }        # mejor racha de la partida
# --- capa de espectáculo (la pinta el visor desde state.json.drama) ---
$script:TitularActual = ''      # titular de la ronda en curso
$script:Narrador = ''           # línea de narración del último golpe
# --- cámara cinematográfica ---
# El visor hace zoom a donde estalla la bomba. Las coordenadas son 0..100 del
# frame visible y las publica 24-wb-stream.ps1 en /stats (scx/scy del pico).
# zoom es el factor y ms cuánto aguanta el plano antes de volver al general.
$script:Camara = [ordered]@{ x = 50; y = 50; zoom = 1.0; ms = 0 }
$script:Impacto = [ordered]@{ x = 50; y = 50; poder = 0.0 }
$script:StreamUrl = 'http://127.0.0.1:8767'
# cuándo se fijó el último plano, para que el visor sepa si ya caducó
$script:CamaraTick = 0
$script:ImpactoTick = 0
# Último impacto SÍ detectado en pantalla (x,y 0..100 del frame visible). Se usa
# como cámara de emergencia si un bombardeo no da fogonazo, para no saltar al
# centro del mapa (que es lo que se veía como "zoom a un sitio random").
$script:UltimoBueno = $null
# Pares (tile del mapa, punto en pantalla) de los impactos ya detectados. La
# cámara del juego no se mueve durante la partida, así que tile->pantalla es una
# proyección afín y con 2 pares buenos se puede predecir dónde caerá la bomba.
$script:CalibPuntos = New-Object System.Collections.Generic.List[object]

# ---------------------------------------------------------------- utilidades
function Get-Scoreboard {
  $o = Invoke-WbAgent -Agent rojo -Name 'objective_status'
  if (-not $o.ok) { throw ('objective_status falló: ' + $o.code + ' ' + $o.error) }
  $map = @{}
  foreach ($k in $o.result.kingdoms) {
    $map[[int]$k.id] = [pscustomobject]@{ id = [int]$k.id; nombre = $k.name; unidades = [int]$k.units; ciudades = [int]$k.cities }
  }
  return $map
}

# ¿Sigue habiendo al menos dos reinos vivos? Si las bombas han arrasado el
# mundo, la partida no puede continuar: el juego se queda sin nada que
# encuadrar y acaba en bucle de error de render.
function Test-MundoVivo {
  $s = Invoke-WbAgent -Agent rojo -Name 'get_world_state'
  if (-not $s.ok) { return $true }   # ante la duda, no cortar el show
  return ([int]$s.result.kingdoms_alive -ge 2)
}

# Unidades de un reino en el marcador; 0 si el reino ya no existe.
function Get-Unidades {
  param($Mapa, [int]$Reino)
  if ($Mapa -and $Mapa.ContainsKey($Reino) -and $null -ne $Mapa[$Reino].unidades) { return [int]$Mapa[$Reino].unidades }
  return 0
}

# Foto de todas las ciudades del mundo: id -> { id, nombre, reino }.
# Sirve para detectar POR NOMBRE qué ciudad ha caído entre dos momentos del turno.
function Get-MapaCiudades {
  $r = Invoke-WbAgent -Agent rojo -Name 'list_cities'
  if (-not $r.ok) { return @{} }
  $map = @{}
  foreach ($c in $r.result.items) {
    $map[[int]$c.id] = [pscustomobject]@{ id = [int]$c.id; nombre = [string]$c.name; reino = [int]$c.kingdom_id }
  }
  return $map
}

function Get-Clusters {
  param([int]$Reino, [int]$Paginas = 3, [int]$Tam = 400, [int]$Celda = 24)
  $actores = @()
  $off = 0
  for ($p = 0; $p -lt $Paginas; $p++) {
    $q = Invoke-WbAgent -Agent rojo -Name 'query_actors' -A @{ kingdom_id = $Reino; limit = $Tam; offset = $off }
    if (-not $q.ok) { break }
    $actores += $q.result.items
    if (-not $q.result.has_more) { break }
    $off += $Tam
  }
  if ($actores.Count -eq 0) { return @() }
  $grid = @{}
  foreach ($a in $actores) {
    $kx = [math]::Floor($a.x / $Celda); $ky = [math]::Floor($a.y / $Celda)
    $k = "$kx`_$ky"
    if (-not $grid.ContainsKey($k)) { $grid[$k] = [pscustomobject]@{ x = 0; y = 0; n = 0; sx = 0; sy = 0 } }
    $g = $grid[$k]; $g.n++; $g.sx += [int]$a.x; $g.sy += [int]$a.y
  }
  $res = @()
  foreach ($g in $grid.Values) {
    $res += [pscustomobject]@{ x = [int]($g.sx / $g.n); y = [int]($g.sy / $g.n); n = $g.n }
  }
  return @($res | Sort-Object -Property n -Descending)
}

function Get-Observacion {
  param([string]$Agente, [int]$Propio, [int]$Enemigo)
  $sb = Get-Scoreboard
  $mias = @(Get-Clusters -Reino $Propio -Paginas 2)
  $suyas = @(Get-Clusters -Reino $Enemigo -Paginas 3)
  if ($suyas.Count -eq 0) { Start-Sleep -Seconds 1; $suyas = @(Get-Clusters -Reino $Enemigo -Paginas 3) }
  if ($mias.Count -eq 0) { Start-Sleep -Seconds 1; $mias = @(Get-Clusters -Reino $Propio -Paginas 2) }
  $ws = Invoke-WbAgent -Agent $Agente -Name 'get_world_state'
  return [pscustomobject]@{
    yo    = $sb[$Propio]
    rival = $sb[$Enemigo]
    mias  = $mias
    suyas = $suyas
    tick  = $(if ($ws.ok) { [int]$ws.result.tick } else { $script:Tick })
  }
}

# Escritura tolerante: el servidor del visor lee estos ficheros a la vez que se
# escriben, y en Windows un lector con el fichero abierto puede bloquear el write.
function Save-Texto {
  param([string]$Ruta, [string]$Texto)
  for ($i = 0; $i -lt 12; $i++) {
    try {
      [IO.File]::WriteAllText($Ruta, $Texto, [Text.UTF8Encoding]::new($false))
      return
    } catch { Start-Sleep -Milliseconds 60 }
  }
  Write-Warning "no se pudo escribir $Ruta"
}

function Save-Json {
  param([string]$Ruta, $Objeto, [int]$Profundidad = 5)
  Save-Texto -Ruta $Ruta -Texto ($Objeto | ConvertTo-Json -Depth $Profundidad)
}

function Save-Feed {
  Save-Json -Ruta (Join-Path $OutDir 'feed.json') -Objeto $script:Feed -Profundidad 5
}

function Add-Feed {
  param([string]$Agente, [string]$Tipo, [string]$Texto, [hashtable]$Extra = @{})
  $script:FeedSeq++
  $e = [ordered]@{
    seq    = $script:FeedSeq
    t      = (Get-Date).ToString('HH:mm:ss')
    ronda  = $script:Ronda
    turno  = $script:TurnoN
    agente = $Agente
    tipo   = $Tipo
    texto  = $Texto
  }
  foreach ($k in $Extra.Keys) { $e[$k] = $Extra[$k] }
  [void]$script:Feed.Add($e)
  # se vuelca al momento para que el visor muestre cada decisión en cuanto ocurre
  Save-Feed
}

function Ensure-Turn {
  param([string]$Agente)
  for ($i = 0; $i -lt 8; $i++) {
    $si = Invoke-WbAgent -Agent $Agente -Name 'session_info'
    if (-not $si.ok) { return $false }
    if ($si.result.current_turn -eq $Agente) { return $true }
    $actual = $si.result.current_turn
    $adv = Invoke-WbAgent -Agent $actual -Name 'turn_advance'
    if (-not $adv.ok) { return $false }
  }
  return $false
}

# ---------------------------------------------------------------- voz del directo
# Pide al servicio de voz (tts-server.mjs) que sintetice la frase YA, sin devolver
# audio. No bloquea: lanza la peticion y sigue con la partida.
#
# Por que: el visor descubre la frase al sondear feed.json (hasta 1 s despues de
# que se escriba) y solo entonces pide /tts. Si nadie ha empezado a sintetizar,
# esos 1-3 s de sintesis se suman al retardo del sondeo y la voz llega tarde.
# Lanzandolo aqui, cuando el visor pide el audio el trabajo ya esta en marcha (o
# terminado) y la voz arranca en cuanto se pinta la frase.
#
# Se puede apagar con WB_VOZ_PRECALIENTA=0 (por si la maquina va justa de CPU).
$script:VozBase = if ($env:WB_TTS_URL) { $env:WB_TTS_URL.TrimEnd('/') } else { 'http://127.0.0.1:8771' }
$script:VozPrecalienta = ($env:WB_VOZ_PRECALIENTA -ne '0')
$script:VozCliente = $null
$script:VozMaxTexto = 240

# Réplica exacta de limpiar() de viewer-voice.js. Es imprescindible: el visor
# manda al servicio de voz el texto YA limpiado, y la caché se indexa por el
# texto. Si aquí mandáramos el texto crudo, las frases con '...', '—', '!!',
# emojis o '%' no coincidirían con la clave y el precalentado no serviría de
# nada (fallaría en silencio). Hay una prueba que compara ambas versiones:
# reports/qa/v9-limpiar-paridad.mjs.
function Limpiar-ParaVoz {
  param([string]$t)
  if ($null -eq $t) { return '' }
  $s = [string]$t
  $s = $s -replace 'https?://\S+', ' enlace '
  $s = $s -replace 'www\.\S+', ' enlace '
  $s = $s -replace '[*_`#>|~]+', ' '
  # emojis: fuera del BMP (pares sustitutos) + bloques del BMP que usa el visor
  $s = $s -replace '[\uD800-\uDBFF][\uDC00-\uDFFF]', ' '
  $s = $s -replace '[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]', ' '
  $s = $s -replace '[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]', ''
  $s = $s -replace '\s*%\s*', ' por ciento '
  $s = $s -replace '(\d)\s*km\b', '$1 kilómetros'
  $s = $s -replace '\bkm\b', 'kilómetros'
  $s = $s -replace '(\d)\s*kg\b', '$1 kilos'
  $s = $s -replace '\bkg\b', 'kilos'
  $s = $s -replace '\s*&\s*', ' y '
  $s = $s -replace '\bvs\.?(?=\s|$)', ' contra '
  # En -replace con scriptblock, el Match llega en $_ (no como parámetro).
  $s = $s -replace '[!?]{2,}', { if ($_.Value.Contains('?')) { '?' } else { '!' } }
  $s = $s -replace '¡{2,}', '¡'
  $s = $s -replace '¿{2,}', '¿'
  $s = $s -replace '\.{3,}|…', ', '
  $s = $s -replace '[—–]', ', '
  $s = $s -replace '\s+', ' '
  return $s.Trim()
}

function Precalentar-Voz {
  param([string]$Texto, [string]$Agente, [string]$Emocion = '')
  if (-not $script:VozPrecalienta) { return }
  if ([string]::IsNullOrWhiteSpace($Texto)) { return }
  # Mismo texto que pedirá el visor: limpiar + truncar a 240 con '…'.
  $limpio = Limpiar-ParaVoz $Texto
  if ([string]::IsNullOrWhiteSpace($limpio)) { return }
  if ($limpio.Length -gt $script:VozMaxTexto) {
    $limpio = $limpio.Substring(0, $script:VozMaxTexto - 1) + '…'
  }
  try {
    if (-not $script:VozCliente) {
      $script:VozCliente = [System.Net.Http.HttpClient]::new()
      $script:VozCliente.Timeout = [TimeSpan]::FromSeconds(8)
    }
    $q = 't=' + [uri]::EscapeDataString($limpio) + '&v=' + [uri]::EscapeDataString($Agente)
    if ($Emocion) { $q += '&e=' + [uri]::EscapeDataString($Emocion) }
    # GetAsync sin await: la peticion sale, no esperamos la respuesta.
    $null = $script:VozCliente.GetAsync($script:VozBase + '/precalentar?' + $q)
  } catch { }
}

function Send-Chat {
  param([string]$Agente, [string]$A, [string]$Texto, [string]$Tono = 'chulo',
    [string]$Tipo = 'chat', [double]$Intensidad = 0.5, [string]$Emocion = '', [int]$RespuestaA = 0,
    [string]$Fuente = '')
  # Si el cerebro no dio una frase válida, la línea va vacía: no se envía nada.
  # (Antes esto acababa en el generador de plantillas de 21-drama.ps1; ya no.)
  if ([string]::IsNullOrWhiteSpace($Texto)) { return $false }
  # no repetir frases: ventana deslizante por IA + no calcar lo que dijo el rival
  $norm = ''
  if ($Texto) { $norm = (($Texto -replace '[^\p{L}\p{N} ]', '') -replace '\s+', ' ').Trim().ToLowerInvariant() }
  if ($Texto -and $Texto -eq $script:UltimoTexto[$Agente]) { return $false }
  if ($norm) {
    if ($script:Recientes[$Agente] -contains $norm) { return $false }
    $otro = if ($Agente -eq 'rojo') { 'azul' } else { 'rojo' }
    if ($script:Recientes[$otro] -contains $norm) { return $false }
  }
  $r = Invoke-WbAgent -Agent $Agente -Name 'send_message' -A @{ to = $A; content = $Texto; kind = 'chat' }
  if ($r.ok) {
    $script:UltimoTexto[$Agente] = $Texto
    if ($norm) {
      [void]$script:Recientes[$Agente].Add($norm)
      while ($script:Recientes[$Agente].Count -gt 8) { $script:Recientes[$Agente].RemoveAt(0) }
    }
    $extra = @{ para = $A; tono = $Tono; intensidad = $Intensidad }
    if ($Emocion) { $extra['emocion'] = $Emocion }
    if ($RespuestaA -gt 0) { $extra['respuesta_a'] = $RespuestaA }
    if ($Fuente) { $extra['fuente'] = $Fuente }
    Add-Feed -Agente $Agente -Tipo $Tipo -Texto $Texto -Extra $extra
    Add-ShowEvent -Tipo $Tipo -Agente $Agente -Texto $Texto -Extra @{
      tono = $Tono; intensidad = $Intensidad; emocion = $(if ($Emocion) { $Emocion } else { $null })
      fuente = $(if ($Fuente) { $Fuente } else { $null })
    } | Out-Null
    # Voz del directo: encarga la síntesis ahora (ver Precalentar-Voz arriba).
    # El visor solo reproduce el chat de rojo/azul; los emojis no se hablan.
    if ($Tipo -eq 'chat' -and ($Agente -eq 'rojo' -or $Agente -eq 'azul')) {
      Precalentar-Voz -Texto $Texto -Agente $Agente -Emocion $(if ($Emocion) { $Emocion } else { $Tono })
    }
  }
  return $r.ok
}

function Read-Chat {
  param([string]$Agente, [int]$Desde)
  $r = Invoke-WbAgent -Agent $Agente -Name 'recv_messages' -A @{ since_seq = $Desde; max = 50 }
  if (-not $r.ok) { return @() }
  return @($r.result.items)
}

# ---------------------------------------------------------------- cerebros
# Nombre legible de una bomba (el id técnico no se muestra en el visor).
function Nombre-Bomba {
  param([string]$P)
  switch ($P) {
    'czar_bomba' { return 'la Bomba del Zar' }
    'atomic_bomb' { return 'una bomba atómica' }
    'napalm_bomb' { return 'napalm' }
    default { return $P }
  }
}
function Plural {
  param([int]$N, [string]$Singular, [string]$Plural)
  if ($N -eq 1) { return ([string]$N + ' ' + $Singular) }
  return ([string]$N + ' ' + $Plural)
}

# La personalidad y el generador de diálogo viven en 21-drama.ps1 (dot-sourced).
. (Join-Path $PSScriptRoot '21-drama.ps1')
# Compatibilidad: el motor lleva su propia ventana de frases para no repetirse.
# 21-drama.ps1 usa $script:Huellas y puede no definir $script:Recientes, así que
# nos aseguramos aquí de que exista antes de que Send-Chat la consulte.
if (-not $script:Recientes) {
  $script:Recientes = @{
    rojo = [System.Collections.ArrayList]::new()
    azul = [System.Collections.ArrayList]::new()
  }
}
# La capa de dirección (cerebro LLM, moral, tensión, titulares y línea temporal).
. (Join-Path $PSScriptRoot '22-director.ps1')
if ($SinDrama -or $SinCerebro) {
  $script:DirectorioOn = $false
  Write-Output 'director: cerebro desactivado por parámetro; drama procedural.'
}
$script:Rondas = $Rondas
$script:ResolucionSeg = $ResolucionSeg
$script:ReinoRojo = $ReinoRojo
$script:ReinoAzul = $ReinoAzul

function New-Plan {
  param([string]$Agente, $Obs)
  $persona = $script:Personas[$Agente]
  $plan = @()
  $gruposEnemigos = @($Obs.suyas)
  $gruposPropios = @($Obs.mias)
  $objetivo = if ($gruposEnemigos.Count -gt 0) { $gruposEnemigos[0] } else { $null }
  $segundo = if ($gruposEnemigos.Count -gt 1) { $gruposEnemigos[1] } else { $objetivo }
  $propio = if ($gruposPropios.Count -gt 0) { $gruposPropios[0] } else { $null }

  if (-not $objetivo) {
    # Sin enemigo a la vista no hay línea de chat: antes había una frase fija
    # ("No encuentro al enemigo...") y el dueño no quiere frases prefijadas.
    return @()
  }

  # 1) si estoy muy tocado respecto al inicio, refuerzo tropas
  $relativo = if ($script:Inicio -and $script:Inicio[$persona.reino].unidades -gt 0) { $Obs.yo.unidades / $script:Inicio[$persona.reino].unidades } else { 1.0 }
  if ($relativo -lt 0.7 -and $propio) {
    $plan += [pscustomobject]@{
      accion = 'tropas'; entity = 'civ_fox'; x = $propio.x; y = $propio.y; count = 40
      nota = 'Refuerza sus defensas con 40 zorros'
    }
  }

  # 2) ataque: bombas sobre el grupo enemigo más denso
  $bomba = $persona.bombas[$script:TurnoN % $persona.bombas.Count]
  $plan += [pscustomobject]@{
    accion = 'bomba'; power = $bomba; x = $objetivo.x; y = $objetivo.y
    nota = ('Lanza ' + (Nombre-Bomba $bomba) + ' sobre un grupo de ' + $objetivo.n + ' unidades enemigas')
  }

  # 3) acciones extra hasta el tope de la personalidad (AZUL juega con ventaja: 3)
  $tope = if ($persona.acciones) { $persona.acciones } else { $MaxAcciones }
  $n = 1
  while ($plan.Count -lt $tope) {
    if ($n % 2 -eq 1) {
      $plan += [pscustomobject]@{
        accion = 'bomba'; power = $persona.bombas[$n % $persona.bombas.Count]; x = $segundo.x; y = $segundo.y
        nota = ('Lanza ' + (Nombre-Bomba $persona.bombas[$n % $persona.bombas.Count]) + ' sobre un grupo de ' + $segundo.n + ' unidades')
      }
    } else {
      $plan += [pscustomobject]@{
        accion = 'tropas'; entity = 'bandit'; x = $segundo.x; y = $segundo.y; count = 50
        nota = 'Desembarca 50 bandidos en territorio enemigo'
      }
    }
    $n++
  }

  # 4) drama: la frase la improvisa el cerebro con el estado real de la partida.
  #    Si el cerebro no está, Get-Replica cae solo al generador procedural.
  $rival = if ($Agente -eq 'rojo') { 'azul' } else { 'rojo' }
  $mias = [double]$Obs.yo.unidades
  $suyas = [double]$Obs.rival.unidades
  $ratio = if ($suyas -gt 0) { $mias / $suyas } else { 2.0 }
  $ultimoRival = [string]$script:UltimoMensajeRival[$rival]
  $ctx = Get-ContextoDrama -Agente $Agente -Obs $Obs
  $tipoBeat = if ($ratio -lt 0.55) { 'nervios' } elseif ($ratio -gt 1.9) { 'burla' } else { 'turno' }
  # A quién va dirigida la frase. El duelo es contra el rival: hablar "a todos"
  # todo el rato parecía un duplicado del mensaje anterior (lo dijo el dueño).
  # Solo de vez en cuando se dirige al público, y casi siempre al cerrar ronda.
  $destino = $rival
  if ($script:Beat -eq 'ronda' -or $script:Beat -eq 'final') {
    if ((Get-Random -Maximum 100) -lt 35) { $destino = '*' }
  } elseif ((Get-Random -Maximum 100) -lt 8) {
    $destino = '*'
  }
  # cada tanto, en vez de frase, la IA lanza una emoción suelta (emoji solo)
  if ((Get-Random -Maximum 100) -lt 45) {
    $emoji = Get-EmojiDrama -Agente $Agente -Contexto $ctx -ConModelo:$false
    if (-not $emoji) { $emoji = if ($Agente -eq 'rojo') { '😤' } else { '🙄' } }
    # emoción real: es lo que usa el visor para elegir el efecto (llanto, furia...)
    # OJO: estos nombres los usa el visor como clase CSS de animación
    # (.invasor.furia / .llanto / .burla / .euforia / .panico). Si no coinciden,
    # el visor tiene que adivinar la emoción por el glifo.
    $emocion = Get-EmocionDeEmoji $emoji
    $plan += [pscustomobject]@{ accion = 'emoji'; to = $destino; texto = $emoji; tono = 'emoji'
      intensidad = [math]::Round([math]::Max(0.55, [math]::Min(1.0, $script:Tension / 100 + 0.45)), 2)
      emocion = $emocion }
  } else {
    $rep = Get-Replica -Agente $Agente -Tipo $tipoBeat -Contexto $ctx -UltimoRival $ultimoRival -Ratio $ratio
    $plan += [pscustomobject]@{ accion = 'chat'; to = $destino; texto = $rep.texto; tono = $rep.tono
      emocion = $rep.emocion
      intensidad = [math]::Round([math]::Max(0.15, [math]::Min(1.0, [math]::Abs($ratio - 1.0) + 0.3)), 2)
      fuente = $rep.fuente }
  }
  return $plan
}

# ---------------------------------------------------------------- visor
# Pregunta al servidor de stream (24-wb-stream.ps1) dónde está el fogonazo de la
# bomba que acaba de estallar. El fogonazo no sale en el mismo instante en que se
# lanza la bomba: tarda un pico, así que se sondea durante un rato. Solo vale un
# pico POSTERIOR a -DesdeMs, para no reutilizar el de la bomba anterior.
# x/y son 0..100 del RECORTE del mapa (el mismo espacio que publica el stream en
# lcx/lcy y el que consume el visor en camara.x/y); poder va 0..1.
function Get-ImpactoStream {
  param([long]$DesdeMs = 0, [int]$MaxEsperaMs = 2600, [int]$PasoMs = 90)
  # El fogonazo de una bomba es un pico de pocos frames. Nos quedamos con el MAYOR
  # 'lspike' de toda la ventana (el valor en vivo, no el latch de /stats): así no
  # enganchamos un fuego viejo que esté ardiendo de fondo.
  $limite = [DateTime]::UtcNow.AddMilliseconds($MaxEsperaMs)
  $mejor = $null
  do {
    try {
      $r = Invoke-RestMethod -Uri ($script:StreamUrl + '/stats') -TimeoutSec 2
      if ($null -ne $r) {
        $spike = 0; if ($null -ne $r.lspike) { $spike = [double]$r.lspike }
        # 'stick' es el instante del último frame con fogonazo. Solo sirve un pico
        # que haya ocurrido DESPUÉS del lanzamiento: si es más viejo, es el de la
        # bomba anterior y nos llevaría a un punto que no es el de esta explosión.
        $stick = 0; if ($null -ne $r.stick) { $stick = [double]$r.stick }
        $fresco = ($DesdeMs -le 0) -or ($stick -ge $DesdeMs)
        if ($spike -ge 60 -and $fresco) {
          $valido = ($null -ne $r.lcx) -and ($null -ne $r.lcy) -and
                    ([double]$r.lcx -ge 0) -and ([double]$r.lcy -ge 0)
          if ($valido) {
            $cx = [double]$r.lcx; $cy = [double]$r.lcy
            if ($null -eq $mejor -or $spike -gt $mejor.spike) {
              # lcx/lcy vienen en BASE 10000 del recorte (4293 = 42,93 %); el
              # visor consume camara.x/y en 0..100. Dividir entre 100 UNA vez.
              $mejor = [pscustomobject]@{ x = $cx / 100.0; y = $cy / 100.0; spike = $spike }
            }
          }
        }
      }
    } catch { }
    # si ya tenemos un pico claro, no hace falta agotar la ventana
    if ($null -ne $mejor -and $mejor.spike -ge 160) { break }
    Start-Sleep -Milliseconds $PasoMs
  } while ([DateTime]::UtcNow -lt $limite)
  if ($null -eq $mejor) { return $null }
  return [pscustomobject]@{
    x     = [math]::Round([math]::Max(0.0, [math]::Min(100.0, $mejor.x)), 1)
    y     = [math]::Round([math]::Max(0.0, [math]::Min(100.0, $mejor.y)), 1)
    poder = [math]::Round([math]::Max(0.22, [math]::Min(1.0, 0.22 + 0.78 * (($mejor.spike - 60.0) / 240.0))), 3)
    spike = $mejor.spike
  }
}

# Fija el plano de cámara sobre el punto del impacto. Si el detector no ve nada,
# usa el tile que se bombardeó como aproximación (centro del mapa si tampoco).
function Set-CamaraImpacto {
  param([double]$X, [double]$Y, [double]$Poder = 0.6, [int]$Ms = 2200)
  $script:Camara = [ordered]@{ x = [math]::Round($X, 1); y = [math]::Round($Y, 1); zoom = [math]::Round(1.35 + 0.75 * $Poder, 2); ms = $Ms }
  $script:Impacto = [ordered]@{ x = [math]::Round($X, 1); y = [math]::Round($Y, 1); poder = [math]::Round($Poder, 2) }
  $script:CamaraTick = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:ImpactoTick = $script:CamaraTick
}

# ------------------------------------------- cámara de emergencia (sin fogonazo)
# La cámara del juego no se mueve durante la partida, así que tile del mapa ->
# pantalla es una proyección afín (pantalla% = a * tile + b). Aprendiendo pares
# (tile del objetivo, punto detectado) de los impactos que SÍ se ven, se puede
# predecir dónde va a caer un bombardeo cuyo fogonazo no se ha detectado. Eso es
# lo que evita el 50,50 del centro del mapa.
function Add-CalibracionCamara {
  param([double]$TileX, [double]$TileY, [double]$CamX, [double]$CamY)
  $script:CalibPuntos.Add([pscustomobject]@{ tx = $TileX; ty = $TileY; cx = $CamX; cy = $CamY })
  while ($script:CalibPuntos.Count -gt 24) { $script:CalibPuntos.RemoveAt(0) }
}

function Get-AfinEje {
  param($Puntos, [string]$CampoTile, [string]$CampoPantalla)
  $n = 0; $sx = 0.0; $sy = 0.0; $sxx = 0.0; $sxy = 0.0
  foreach ($p in $Puntos) {
    $x = [double]$p.$CampoTile; $y = [double]$p.$CampoPantalla
    $n++; $sx += $x; $sy += $y; $sxx += $x * $x; $sxy += $x * $y
  }
  if ($n -lt 2) { return $null }
  $den = $n * $sxx - $sx * $sx
  if ([math]::Abs($den) -lt 1e-6) { return $null }
  $a = ($n * $sxy - $sx * $sy) / $den
  $b = ($sy - $a * $sx) / $n
  return [pscustomobject]@{ a = $a; b = $b }
}

function Get-CamaraDesdeTile {
  param([double]$TileX, [double]$TileY)
  $pts = $script:CalibPuntos
  if ($null -eq $pts -or $pts.Count -lt 2) { return $null }
  $fx = Get-AfinEje -Puntos $pts -CampoTile 'tx' -CampoPantalla 'cx'
  $fy = Get-AfinEje -Puntos $pts -CampoTile 'ty' -CampoPantalla 'cy'
  if ($null -eq $fx -or $null -eq $fy) { return $null }
  # un ajuste absurdo (puntos degenerados o de otro frame) no se usa
  if ($fx.a -lt 0.005 -or $fx.a -gt 0.6 -or $fy.a -lt 0.005 -or $fy.a -gt 0.6) { return $null }
  $px = $fx.a * $TileX + $fx.b
  $py = $fy.a * $TileY + $fy.b
  if ($px -lt -2 -or $px -gt 102 -or $py -lt -2 -or $py -gt 102) { return $null }
  return [pscustomobject]@{ x = [math]::Max(0.0, [math]::Min(100.0, $px)); y = [math]::Max(0.0, [math]::Min(100.0, $py)) }
}

# Punto al que apuntar cuando el detector no ve el fogonazo. En orden:
# 1) proyección tile->pantalla aprendida; 2) último impacto bueno; 3) centro.
function Get-CamaraEmergencia {
  param([double]$TileX, [double]$TileY)
  $pred = Get-CamaraDesdeTile -TileX $TileX -TileY $TileY
  if ($null -ne $pred) { return [pscustomobject]@{ x = $pred.x; y = $pred.y; origen = 'calib' } }
  if ($null -ne $script:UltimoBueno) { return [pscustomobject]@{ x = $script:UltimoBueno.x; y = $script:UltimoBueno.y; origen = 'ultimo' } }
  return [pscustomobject]@{ x = 50.0; y = 50.0; origen = 'centro' }
}

function Save-Frame {
  $sc = Invoke-WbAgent -Agent rojo -Name 'screenshot' -A @{ max_width = 900 } -TimeoutSec 90
  if (-not $sc.ok) { return $false }
  $b64 = $sc.result.base64
  if (-not $b64) { return $false }
  try {
    [IO.File]::WriteAllBytes($script:FramePath, [Convert]::FromBase64String($b64))
    return $true
  } catch { return $false }
}

# Resumen agregado de la partida (lo pinta el visor desde state.json.resumen).
# Se puede llamar en cualquier momento: antes de empezar devuelve curvas vacías y
# duración 0; al terminar, duracion_s queda congelada (TFinPartida).
function Get-Resumen {
  $duracion = 0
  if ($script:TInicioPartida) {
    $fin = if ($script:TFinPartida) { $script:TFinPartida } else { Get-Date }
    $duracion = [int][math]::Max(0, [math]::Round(($fin - $script:TInicioPartida).TotalSeconds, 0))
  }
  # racha: el agente con más rondas seguidas dominando (en empate, el ganador si lo hay)
  $rachaAgente = 'rojo'
  $rachaRondas = [int]$script:RachaMaxima.rojo
  if ($script:RachaMaxima.azul -gt $rachaRondas) {
    $rachaAgente = 'azul'; $rachaRondas = [int]$script:RachaMaxima.azul
  } elseif ($script:RachaMaxima.azul -eq $rachaRondas -and $script:Ganador -eq 'AZUL') {
    $rachaAgente = 'azul'
  }
  if ($rachaRondas -eq 0 -and $script:Ganador -eq 'AZUL') { $rachaAgente = 'azul' }
  # mayor golpe: la ronda con más bajas de un solo bando (a igualdad, se queda la primera)
  $golpeAgente = [string]$script:MayorGolpe.agente
  $golpeBajas = [int]$script:MayorGolpe.bajas
  $golpeRonda = [int]$script:MayorGolpe.ronda
  if ($golpeBajas -eq 0 -and $script:Ronda -gt 0) { $golpeRonda = 1 }
  if (-not $golpeAgente) { $golpeAgente = $rachaAgente }
  return [ordered]@{
    duracion_s     = $duracion
    total_bajas    = [ordered]@{ rojo = [int]$script:Marcador.rojo.bajas; azul = [int]$script:Marcador.azul.bajas }
    total_perdidas = [ordered]@{ rojo = [int]$script:Marcador.rojo.perdidas; azul = [int]$script:Marcador.azul.perdidas }
    mayor_golpe    = [ordered]@{ agente = $golpeAgente; bajas = $golpeBajas; ronda = $golpeRonda }
    racha          = [ordered]@{ agente = $rachaAgente; rondas = $rachaRondas }
    curvas         = [ordered]@{ rojo = @($script:Curvas.rojo); azul = @($script:Curvas.azul) }
    pico_bajas     = [ordered]@{ rojo = [int]$script:PicoBajas.rojo; azul = [int]$script:PicoBajas.azul }
  }
}

# Escribe el estado que consume el visor en vivo (lo sirve 20-wb-viewer-server.ps1).
function Write-Estado {
  $sb = Get-Scoreboard
  $r = $sb[$ReinoRojo]; $a = $sb[$ReinoAzul]
  $estado = [ordered]@{
    ronda       = $script:Ronda
    rondas      = $Rondas
    turno       = $script:TurnoActual
    terminada   = $script:Terminada
    ganador     = $script:Ganador
    tick        = $script:Tick
    actualizado = (Get-Date).ToString('HH:mm:ss')
    fase        = $(if ($script:Terminada) { 'final' } elseif ($script:Ronda -eq 0) { 'espera' } else { $script:Beat })
    inicio_ms   = $(if ($script:TInicioPartida) { [DateTimeOffset]::new($script:TInicioPartida.ToUniversalTime()).ToUnixTimeMilliseconds() } else { 0 })
    ahora_ms    = [DateTimeOffset]::new((Get-Date).ToUniversalTime()).ToUnixTimeMilliseconds()
    drama       = [ordered]@{
      moral     = [ordered]@{ rojo = [int][math]::Round($script:Moral.rojo); azul = [int][math]::Round($script:Moral.azul) }
      tension   = [int][math]::Round($script:Tension)
      titular   = [string]$script:TitularActual
      beat      = [string]$script:Beat
      narrador  = [string]$script:Narrador
      camara    = [ordered]@{
        x = $script:Camara.x; y = $script:Camara.y; zoom = $script:Camara.zoom; ms = $script:Camara.ms
        tick = $script:CamaraTick
      }
      impacto   = [ordered]@{
        x = $script:Impacto.x; y = $script:Impacto.y; poder = $script:Impacto.poder
        tick = $script:ImpactoTick
      }
    }
    marcador    = $script:Marcador
    scoreboard  = [ordered]@{ rojo = $r; azul = $a }
    historial   = $script:Historial
    resumen     = (Get-Resumen)
  }
  Save-Json -Ruta (Join-Path $OutDir 'state.json') -Objeto $estado -Profundidad 8
  Save-Feed
}

function Test-Servidor {
  try {
    $r = Invoke-WebRequest -Uri ('http://localhost:' + $PuertoVisor + '/health') -TimeoutSec 2 -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Ensure-Servidor {
  if ($SinServidor) { return }
  if (Test-Servidor) { Write-Output ('visor ya en marcha: http://localhost:' + $PuertoVisor + '/'); return }
  $servidor = (Join-Path $PSScriptRoot '20-wb-viewer-server.ps1')
  if (-not (Test-Path -LiteralPath $servidor)) { Write-Output 'AVISO: no encuentro 20-wb-viewer-server.ps1; sigo sin visor en vivo.'; return }
  $exe = (Get-Process -Id $PID).Path
  try {
    Start-Process -FilePath $exe -ArgumentList @('-NoProfile', '-File', $servidor, '-Port', $PuertoVisor, '-Dir', $OutDir) -WindowStyle Hidden | Out-Null
  } catch {
    Write-Output ('AVISO: no pude arrancar el visor: ' + $_.Exception.Message)
    return
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Servidor) { Write-Output ('visor en vivo: http://localhost:' + $PuertoVisor + '/'); return }
  }
  Write-Output 'AVISO: el visor no respondió a tiempo; la partida sigue igualmente.'
}

# ---------------------------------------------------------------- partida
Write-Output '=== preparando la partida ==='
$plantilla = (Join-Path $PSScriptRoot 'viewer-live.html')
if (Test-Path -LiteralPath $plantilla) {
  Copy-Item -LiteralPath $plantilla -Destination (Join-Path $OutDir 'viewer.html') -Force
}
# El visor puede venir partido en varios ficheros (viewer-fx.js, estilos, imágenes).
# Se copian junto al HTML y 20-wb-viewer-server.ps1 los sirve como estáticos.
foreach ($patron in @('viewer-*.js', 'viewer-*.css', 'viewer-*.mjs', 'visor-*.js', 'visor-*.css')) {
  foreach ($extra in @(Get-ChildItem -Path $PSScriptRoot -Filter $patron -File -ErrorAction SilentlyContinue)) {
    Copy-Item -LiteralPath $extra.FullName -Destination (Join-Path $OutDir $extra.Name) -Force
  }
}
Ensure-Servidor
# El cerebro dramático es opcional: si no arranca, el show sigue con el
# generador procedural de 21-drama.ps1 (mismo ritmo, menos imaginación).
if ($script:DirectorioOn) {
  if (Start-Cerebro) { Write-Output 'director: cerebro dramático en marcha (diálogo improvisado).' }
  else { Write-Output 'director: sin cerebro; drama procedural.' }
}

if (-not $SinReset) {
  # Firma del mundo actual: sirve para saber cuándo el guardado nuevo está ya
  # DENTRO. load_world es asíncrono y tarda decenas de segundos en aplicarse; si
  # nos conformamos con "hay mundo y hay reinos", seguimos jugando en el mundo
  # viejo sin enterarnos.
  function Get-FirmaMundo {
    $w = Invoke-WbAgent -Agent rojo -Name 'get_world_state'
    if (-not $w.ok) { return '' }
    $o = Invoke-WbAgent -Agent rojo -Name 'objective_status'
    $ids = ''
    if ($o.ok) { $ids = (@($o.result.kingdoms | ForEach-Object { [string]$_.id } | Sort-Object) -join ',') }
    return ('' + $w.result.seed + '|' + $w.result.population_lifetime + '|' + $ids)
  }
  $firmaVieja = Get-FirmaMundo
  Write-Output ('Cargando el guardado ' + $Guardado + '… (mundo actual: ' + $firmaVieja + ')')
  $null = Invoke-WbAgent -Agent rojo -Name 'load_world' -A @{ path = $Guardado } -TimeoutSec 120
  $listo = $false
  $s = $null
  # margen amplio: un guardado grande puede tardar más de un minuto en entrar
  for ($i = 1; $i -le 240; $i++) {
    Start-Sleep -Milliseconds 700
    $s = Invoke-WbAgent -Agent rojo -Name 'get_world_state'
    if (-not $s.ok) { continue }
    if ($s.result.width -lt 64 -or $s.result.kingdoms_alive -lt 2 -or $s.result.population_alive -lt 100) { continue }
    $firma = Get-FirmaMundo
    if ($firma -ne $firmaVieja) { $listo = $true; break }
  }
  if (-not $listo) { throw ('el mundo no terminó de cargar en ' + [math]::Round($i * 0.7) + ' s (sigue la firma ' + (Get-FirmaMundo) + ')') }
  $script:Tick = [int]$s.result.tick
  Write-Output ('Mundo listo en ' + [math]::Round($i * 0.7, 1) + ' s (población ' + $s.result.population_alive + ', reinos ' + $s.result.kingdoms_alive + ', firma ' + (Get-FirmaMundo) + ')')
  Start-Sleep -Seconds 2
}
# La velocidad del juego se pide con un id ('x1'..'x40'), no con un número: con
# 'speed = 3' el bridge devolvía BAD_ARGS y la partida se quedaba a x1 sin avisar.
$null = Invoke-WbAgent -Agent rojo -Name 'set_speed' -A @{ speed_id = 'x3' }
$null = Invoke-WbAgent -Agent rojo -Name 'resume'

# El buzón puede arrastrar mensajes de partidas anteriores: saltamos al final
# para que las IAs no respondan a conversaciones viejas.
foreach ($ag in @('rojo', 'azul')) {
  $r = Invoke-WbAgent -Agent $ag -Name 'recv_messages' -A @{ since_seq = 0; max = 200 }
  if ($r.ok) {
    $nc = $r.result.next_cursor
    if ($null -eq $nc) { $nc = (($r.result.items | Measure-Object -Property seq -Maximum).Maximum) }
    if ($nc) { $script:Cursor[$ag] = [int]$nc }
  }
}

# el estado inicial se captura con reintentos: objective_status puede ir por detrás del load
$script:Inicio = @{}
for ($i = 1; $i -le 20; $i++) {
  $script:Inicio = Get-Scoreboard
  if ($script:Inicio.Count -ge 2) { break }
  Start-Sleep -Milliseconds 800
}

# Reinos automáticos: cada guardado tiene sus propios ids (save2 usa 73/78, save5
# usa 1/2). Si no se fijan a mano, se eligen los dos reinos con más unidades, que
# son los que dan una pelea de verdad; el más fuerte juega de ROJO.
if ($ReinoRojo -le 0 -or $ReinoAzul -le 0) {
  $candidatos = @($script:Inicio.Values | Where-Object { $_.unidades -gt 0 } | Sort-Object -Property unidades -Descending)
  if ($candidatos.Count -lt 2) { throw ('el mundo cargado no tiene dos reinos con unidades (encontrados: ' + $candidatos.Count + ')') }
  $ReinoRojo = $candidatos[0].id
  $ReinoAzul = $candidatos[1].id
  $script:Marcador.rojo.reino = $ReinoRojo
  $script:Marcador.azul.reino = $ReinoAzul
  $script:ReinoRojo = $ReinoRojo
  $script:ReinoAzul = $ReinoAzul
  Write-Output ('reinos elegidos: ROJO=' + $ReinoRojo + ' AZUL=' + $ReinoAzul)
}

if (-not $script:Inicio.ContainsKey($ReinoRojo)) { throw ('no encuentro el reino ' + $ReinoRojo + ' en el mundo cargado') }
$script:Marcador.rojo.nombre = $script:Inicio[$ReinoRojo].nombre
$script:Marcador.azul.nombre = $script:Inicio[$ReinoAzul].nombre
Write-Output ('Inicio: ROJO ' + $script:Inicio[$ReinoRojo].nombre + ' ' + $script:Inicio[$ReinoRojo].unidades + 'u/' + $script:Inicio[$ReinoRojo].ciudades + 'c  vs  AZUL ' + $script:Inicio[$ReinoAzul].nombre + ' ' + $script:Inicio[$ReinoAzul].unidades + 'u/' + $script:Inicio[$ReinoAzul].ciudades + 'c')
$script:TInicioPartida = Get-Date
Add-Feed -Agente 'sistema' -Tipo 'info' -Texto ('Comienza la partida: ROJO (' + $script:Inicio[$ReinoRojo].nombre + ') contra AZUL (' + $script:Inicio[$ReinoAzul].nombre + ')')

# presentación de cada IA
$script:Beat = 'apertura'
$ctxIni = Get-ContextoDrama -Agente 'rojo' -Obs $null
$apR = Get-Replica -Agente 'rojo' -Tipo 'apertura' -Contexto $ctxIni
$null = Send-Chat -Agente 'rojo' -A '*' -Texto $apR.texto -Tono 'chulo' -Emocion $apR.emocion -Intensidad 0.8 -Fuente $apR.fuente
$ctxIniA = Get-ContextoDrama -Agente 'azul' -Obs $null
$apA = Get-Replica -Agente 'azul' -Tipo 'apertura' -Contexto $ctxIniA -UltimoRival $apR.texto
$null = Send-Chat -Agente 'azul' -A '*' -Texto $apA.texto -Tono 'chulo' -Emocion $apA.emocion -Intensidad 0.8 -Fuente $apA.fuente

$null = Save-Frame
$null = Write-Estado
Write-Output ('visor: http://localhost:' + $PuertoVisor + '/')

$marcaRonda = @{ rojo = 0; azul = 0 }
$snapRonda = $script:Inicio

# ---------------------------------------------------------------- refuerzos
# En un mundo pequeño las bombas se comen los ejércitos en dos rondas y la pelea
# se queda sin sangre. Al empezar cada ronda se rellenan los dos bandos hasta un
# objetivo (un % de lo que tenían al principio): así la guerra aguanta muchas
# rondas y el marcador de bajas, que es lo que decide el ganador, no se queda
# congelado. Las unidades se crean en el centro de masa de cada reino, que es
# territorio suyo, y se unen a él solas.
$script:CentroReino = @{}
$script:RazaReino = @{}
function Get-CentroReino {
  param([int]$Reino)
  $act = @()
  $off = 0
  for ($p = 0; $p -lt 2; $p++) {
    $q = Invoke-WbAgent -Agent rojo -Name 'query_actors' -A @{ kingdom_id = $Reino; limit = 400; offset = $off }
    if (-not $q.ok) { break }
    $act += $q.result.items
    if (-not $q.result.has_more) { break }
    $off += 400
  }
  if ($act.Count -gt 0) {
    $sx = 0; $sy = 0
    foreach ($a in $act) { $sx += [double]$a.x; $sy += [double]$a.y }
    $c = @{ x = [int]($sx / $act.Count); y = [int]($sy / $act.Count) }
    $script:CentroReino[$Reino] = $c
    return $c
  }
  if ($script:CentroReino.ContainsKey($Reino)) { return $script:CentroReino[$Reino] }
  return @{ x = 128; y = 128 }
}
function Get-RazaReino {
  param([int]$Reino)
  if ($script:RazaReino.ContainsKey($Reino)) { return $script:RazaReino[$Reino] }
  $k = Invoke-WbAgent -Agent rojo -Name 'list_kingdoms'
  $raza = 'human'
  if ($k.ok) {
    foreach ($it in $k.result.items) { if ([int]$it.id -eq $Reino -and $it.race) { $raza = [string]$it.race; break } }
  }
  $script:RazaReino[$Reino] = $raza
  return $raza
}
function Add-Refuerzos {
  param([int]$Ronda)
  if ($script:RefuerzosCada -le 0) { return }
  if ($Ronda -lt 2) { return }
  $sb = Get-Scoreboard
  foreach ($lado in @('rojo', 'azul')) {
    $reino = if ($lado -eq 'rojo') { $ReinoRojo } else { $ReinoAzul }
    if (-not $sb.ContainsKey($reino)) { continue }   # reino extinguido: no hay a quién reforzar
    $tiene = [int]$sb[$reino].unidades
    # Suelo fijo + seguimiento del rival: así ningún bando se queda a dos unidades
    # agonizando y la guerra no se apaga (en mundos pequeños se moría en 2 rondas).
    $otro = if ($lado -eq 'rojo') { $ReinoAzul } else { $ReinoRojo }
    $rivalU = if ($sb.ContainsKey($otro)) { [int]$sb[$otro].unidades } else { 0 }
    $objetivo = [math]::Max([int]$script:ObjetivoRefuerzo[$lado], [int]($rivalU * 0.6))
    if ($tiene -ge $objetivo) { continue }
    $faltan = [math]::Min($objetivo - $tiene, $script:RefuerzosCada)
    if ($faltan -le 0) { continue }
    $c = Get-CentroReino -Reino $reino
    $raza = Get-RazaReino -Reino $reino
    # el bridge rechaza count > 100 (BAD_ARGS), así que se pide por tandas
    $creadas = 0
    $quedan = $faltan
    while ($quedan -gt 0) {
      $lote = [math]::Min(100, $quedan)
      $res = Invoke-WbAgent -Agent rojo -Name 'spawn' -A @{ entity_id = $raza; x = $c.x; y = $c.y; count = $lote }
      if (-not $res.ok) {
        Write-Output ('[refuerzos] ' + $lado + ' fallo: ' + $res.code + ' ' + $res.error)
        break
      }
      $creadas += [int]$res.result.spawned
      $quedan -= $lote
      if ([int]$res.result.spawned -lt $lote) { break }   # el juego no puede crear más
    }
    if ($creadas -gt 0) {
      $txt = 'Refuerzos para ' + $lado.ToUpper() + ': ' + $creadas + ' unidades nuevas entran en liza.'
      Add-Feed -Agente 'sistema' -Tipo 'tropas' -Texto $txt -Extra @{ refuerzos = $true; reino = $reino; count = $creadas; x = $c.x; y = $c.y }
      Add-ShowEvent -Tipo 'tropas' -Agente 'sistema' -Texto $txt -Extra @{ refuerzos = $true; count = $creadas } | Out-Null
      Write-Output ('[refuerzos] ' + $lado + ' +' + $creadas + ' (' + $tiene + ' -> ' + ($tiene + $creadas) + ', objetivo ' + $objetivo + ')')
    }
  }
}

# Cuánto se refuerza cada bando. Suelo de 350 unidades por bando para que la
# guerra no se apague nunca, más el 35 % de lo que tenía al empezar, y como mucho
# 250 por ronda (el bridge rechaza count > 100, se pide por tandas).
$script:RefuerzosCada = if ($Refuerzos -gt 0) { [int]$Refuerzos } else { 250 }
$script:ObjetivoRefuerzo = @{
  rojo = [math]::Max(350, [int]([double]$script:Inicio[$ReinoRojo].unidades * 0.35))
  azul = [math]::Max(350, [int]([double]$script:Inicio[$ReinoAzul].unidades * 0.35))
}
Write-Output ('refuerzos: objetivo ROJO ' + $script:ObjetivoRefuerzo.rojo + ' / AZUL ' + $script:ObjetivoRefuerzo.azul + ', max ' + $script:RefuerzosCada + ' por ronda')

for ($idxRonda = 1; $idxRonda -le $Rondas; $idxRonda++) {
  $script:Ronda = $idxRonda

  # Si el mundo se ha quedado sin reinos, se cierra la partida aquí: seguir
  # solo consigue que el juego entre en bucle de error al no tener nada que
  # encuadrar, y el marcador se vuelve nulo.
  if (-not (Test-MundoVivo)) {
    $txtFin = 'El mundo se ha quedado sin reinos: la partida se cierra por aniquilación.'
    Add-Feed -Agente 'sistema' -Tipo 'info' -Texto $txtFin
    Add-ShowEvent -Tipo 'info' -Agente 'sistema' -Texto $txtFin | Out-Null
    $script:Narrador = 'No queda nadie en pie. El show termina por aniquilación.'
    Write-Output '[fin] mundo sin reinos: se cierra la partida'
    $script:Terminada = $true
    break
  }

  if ($idxRonda -gt 1) { Add-Refuerzos -Ronda $idxRonda }
  $script:AccionesRonda.rojo.Clear()
  $script:AccionesRonda.azul.Clear()
  foreach ($agente in @('rojo', 'azul')) {
    $script:TurnoN++
    $script:TurnoActual = $agente
    $propio = if ($agente -eq 'rojo') { $ReinoRojo } else { $ReinoAzul }
    $enemigo = if ($agente -eq 'rojo') { $ReinoAzul } else { $ReinoRojo }

    if (-not (Ensure-Turn -Agente $agente)) { Write-Output ('AVISO: no pude poner el turno en ' + $agente); continue }

    $antes = Get-Scoreboard
    $ciudadesAntes = Get-MapaCiudades
    $obs = Get-Observacion -Agente $agente -Propio $propio -Enemigo $enemigo
    $script:Tick = $obs.tick
    $plan = New-Plan -Agente $agente -Obs $obs
    $ultimaNota = ''

    foreach ($p in $plan) {
      switch ($p.accion) {
        'bomba' {
          $res = Invoke-WbAgent -Agent $agente -Name 'invoke_power' -A @{ power_id = $p.power; x = $p.x; y = $p.y }
          if ($res.ok) {
            $script:Marcador[$agente].acciones++
            $corto = @{ czar_bomba = 'czar'; atomic_bomb = 'atomic'; napalm_bomb = 'napalm' }[$p.power]
            if (-not $corto) { $corto = $p.power }
            [void]$script:AccionesRonda[$agente].Add($corto)
            # La cámara va al fogonazo: se sondea el detector hasta que lo ve.
            # Si no lo ve (napalm ancho, frame perdido), NO se cae al centro del
            # mapa: se predice el punto con la calibración tile->pantalla.
            $tBomba = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $imp = Get-ImpactoStream -DesdeMs $tBomba -MaxEsperaMs 3200
            $origen = 'detector'
            if ($imp) {
              Set-CamaraImpacto -X $imp.x -Y $imp.y -Poder $imp.poder -Ms 2400
              Add-CalibracionCamara -TileX $p.x -TileY $p.y -CamX $imp.x -CamY $imp.y
              $script:UltimoBueno = [pscustomobject]@{ x = $imp.x; y = $imp.y }
              Write-Output ("[cam] bomb $($corto) tile=($($p.x),$($p.y)) -> ($($imp.x),$($imp.y)) spike=$($imp.spike) poder=$($imp.poder) zoom=$($script:Camara.zoom)")
            } else {
              $em = Get-CamaraEmergencia -TileX $p.x -TileY $p.y
              Set-CamaraImpacto -X $em.x -Y $em.y -Poder 0.5 -Ms 1600
              $origen = $em.origen
              Write-Output ("[cam] bomb $($corto) tile=($($p.x),$($p.y)) SIN fogonazo -> ($($em.x),$($em.y)) origen=$origen")
            }
            $camExtra = @{ x = $script:Camara.x; y = $script:Camara.y; zoom = $script:Camara.zoom; ms = $script:Camara.ms; origen = $origen }
            Add-Feed -Agente $agente -Tipo 'bomba' -Texto $p.nota -Extra @{ power = $p.power; x = $p.x; y = $p.y; camara = $camExtra }
            Add-ShowEvent -Tipo 'bomba' -Agente $agente -Texto $p.nota -Extra @{ power = $p.power; camara = $camExtra } | Out-Null
            $script:Narrador = $p.nota
            $ultimaNota = $p.nota
          } else {
            Add-Feed -Agente $agente -Tipo 'error' -Texto ('Falló ' + $p.power + ': ' + $res.code + ' ' + $res.error)
          }
        }
        'tropas' {
          $res = Invoke-WbAgent -Agent $agente -Name 'spawn' -A @{ entity_id = $p.entity; x = $p.x; y = $p.y; count = $p.count }
          if ($res.ok) {
            $script:Marcador[$agente].acciones++
            $quien = if ($p.entity -eq 'bandit') { 'bandidos' } else { 'zorros' }
            [void]$script:AccionesRonda[$agente].Add([string]$p.count + ' ' + $quien)
            Add-Feed -Agente $agente -Tipo 'tropas' -Texto ($p.nota + ' (' + $res.result.spawned + ' creados)') -Extra @{ entity = $p.entity; count = $p.count }
            Add-ShowEvent -Tipo 'tropas' -Agente $agente -Texto $p.nota -Extra @{ entity = $p.entity; count = $p.count } | Out-Null
            $ultimaNota = $p.nota
          } else {
            Add-Feed -Agente $agente -Tipo 'error' -Texto ('Falló el spawn de ' + $p.entity + ': ' + $res.code + ' ' + $res.error)
          }
        }
        'chat' {
          $null = Send-Chat -Agente $agente -A $p.to -Texto $p.texto -Tono $p.tono -Emocion $p.emocion -Fuente $p.fuente `
            -Intensidad $(if ($p.PSObject.Properties['intensidad']) { [double]$p.intensidad } else { 0.5 })
        }
        'emoji' {
          $null = Send-Chat -Agente $agente -A $p.to -Texto $p.texto -Tono 'emoji' -Tipo 'emoji' `
            -Intensidad $(if ($p.PSObject.Properties['intensidad']) { [double]$p.intensidad } else { 0.6 }) `
            -Emocion (Get-EmocionDeEmoji $p.texto)
        }
      }
      # ritmo de retransmisión: deja respirar cada acción para que el visor la muestre sola
      if ($PausaAccion -gt 0) { Start-Sleep -Milliseconds ([int]($PausaAccion * 1000)) }
    }

    # leer SOLO lo nuevo (cursor por agente) y reaccionar una vez
    $nuevos = @(Read-Chat -Agente $agente -Desde $script:Cursor[$agente])
    if ($nuevos.Count -gt 0) {
      $maxSeq = ($nuevos | Measure-Object -Property seq -Maximum).Maximum
      if ($maxSeq -gt $script:Cursor[$agente]) { $script:Cursor[$agente] = $maxSeq }
      $delRival = @($nuevos | Where-Object { $_.from -ne $agente })
      if ($delRival.Count -gt 0) {
        $rival = if ($agente -eq 'rojo') { 'azul' } else { 'rojo' }
        $persona = $script:Personas[$agente]
        $miasR = [double]$obs.yo.unidades
        $suyasR = [double]$obs.rival.unidades
        $ratioR = if ($suyasR -gt 0) { $miasR / $suyasR } else { 1.0 }
        $textoRival = ''
        try { $textoRival = [string]$delRival[$delRival.Count - 1].content } catch { $textoRival = '' }
        $seqRival = 0
        try { $seqRival = [int]$delRival[$delRival.Count - 1].seq } catch { $seqRival = 0 }
        $ctxR = Get-ContextoDrama -Agente $agente -Obs $obs
        $tipoR = if ($ratioR -lt 0.55) { 'nervios' } elseif ($ratioR -gt 1.9) { 'burla' } else { 'contra' }
        $repR = Get-Replica -Agente $agente -Tipo $tipoR -Contexto $ctxR -UltimoRival $textoRival -Ratio $ratioR
        $tonoR = if ($ratioR -lt 0.55) { 'nervios' } elseif ($ratioR -gt 1.9) { 'burla' } else { 'chulo' }
        $null = Send-Chat -Agente $agente -A $rival -Texto $repR.texto -Tono $tonoR -Emocion $repR.emocion -Fuente $repR.fuente `
          -Intensidad ([math]::Round([math]::Min(1.0, [math]::Max(0.2, $script:Tension / 100 + 0.2)), 2)) `
          -RespuestaA $seqRival
        if ($textoRival) { $script:UltimoMensajeRival[$agente] = $textoRival }
      }
    }

    Start-Sleep -Seconds $ResolucionSeg

    $despues = Get-Scoreboard
    $ciudadesDespues = Get-MapaCiudades
    # qué ciudades han caído en este turno, por su nombre
    $perdidasAhora = [System.Collections.ArrayList]::new()
    $arrasadasAhora = [System.Collections.ArrayList]::new()
    foreach ($c in $ciudadesAntes.Values) {
      $ahora = $ciudadesDespues[$c.id]
      if ($c.reino -eq $propio) {
        if (-not $ahora -or $ahora.reino -ne $propio) { [void]$perdidasAhora.Add($c.nombre) }
      } elseif ($c.reino -eq $enemigo) {
        if (-not $ahora -or $ahora.reino -ne $enemigo) { [void]$arrasadasAhora.Add($c.nombre) }
      }
    }
    if ($perdidasAhora.Count -gt 0) {
      $script:NombreCiudadPerdida[$agente] = $perdidasAhora[$perdidasAhora.Count - 1]
      $script:TotalCiudadesPerdidas[$agente] += $perdidasAhora.Count
      $script:Marcador[$agente].ciudades_perdidas += $perdidasAhora.Count
    }
    if ($arrasadasAhora.Count -gt 0) {
      $script:NombreCiudadArrasada[$agente] = $arrasadasAhora[$arrasadasAhora.Count - 1]
      $script:TotalCiudadesArrasadas[$agente] += $arrasadasAhora.Count
    }
    $bajas = [math]::Max(0, $antes[$enemigo].unidades - $despues[$enemigo].unidades)
    $perdidas = [math]::Max(0, $antes[$propio].unidades - $despues[$propio].unidades)
    $arrasadasTurno = [math]::Max(0, $antes[$enemigo].ciudades - $despues[$enemigo].ciudades)
    $script:Marcador[$agente].bajas += $bajas
    $script:Marcador[$agente].perdidas += $perdidas
    $script:Marcador[$agente].ciudades_arrasadas += $arrasadasTurno
    $script:Marcador[$agente].turnos++
    # el pulso del show: la moral sube al pegar y baja al recibir
    $pulso = Update-Drama -Agente $agente -Bajas $bajas -Perdidas $perdidas
    $intens = Get-Intensidad -Bajas $bajas
    if ($bajas -ge 60) { $script:Narrador = 'El público se levanta: ' + $bajas + ' bajas de un solo golpe.' }
    # el nombre propio de la ciudad es oro para el show: lo cantamos y lo metemos en el feed
    if ($arrasadasAhora.Count -gt 0) {
      $script:Narrador = 'Cae ' + $arrasadasAhora[0] + '. El mapa cambia de dueño.'
    } elseif ($perdidasAhora.Count -gt 0) {
      $script:Narrador = 'Se pierde ' + $perdidasAhora[0] + '. Golpe al orgullo.'
    }
    $txtRes = 'Bajas: ' + $bajas + ' · pérdidas: ' + $perdidas + ' · enemigo: ' + $despues[$enemigo].unidades + 'u/' + $despues[$enemigo].ciudades + 'c'
    if ($arrasadasAhora.Count -gt 0) { $txtRes += ' · ha caído ' + ($arrasadasAhora -join ', ') }
    if ($perdidasAhora.Count -gt 0) { $txtRes += ' · se ha perdido ' + ($perdidasAhora -join ', ') }
    Add-Feed -Agente $agente -Tipo 'resultado' -Texto $txtRes -Extra @{ bajas = $bajas; perdidas = $perdidas; intensidad = $intens }
    Add-ShowEvent -Tipo 'resultado' -Agente $agente -Texto ('Bajas: ' + $bajas + ' · pérdidas: ' + $perdidas) -Extra @{ bajas = $bajas; perdidas = $perdidas; intensidad = $intens } | Out-Null
    # reacción del rival al golpe recibido (una de cada dos veces, para no saturar)
    if ($bajas -ge 25 -and ((Get-Random -Maximum 100) -lt 55)) {
      $victima = if ($agente -eq 'rojo') { 'azul' } else { 'rojo' }
      # el contexto se construye con la foto de DESPUÉS del turno, para que sepa
      # cuántas unidades le quedan de verdad (antes iba a 0/0 y decía barbaridades)
      $obsV = [pscustomobject]@{
        yo    = if ($victima -eq 'rojo') { $despues[$ReinoRojo] } else { $despues[$ReinoAzul] }
        rival = if ($victima -eq 'rojo') { $despues[$ReinoAzul] } else { $despues[$ReinoRojo] }
      }
      $ctxV = Get-ContextoDrama -Agente $victima -Obs $obsV -BajasTurno $perdidas -PerdidasTurno $bajas -GolpeRival $ultimaNota
      if ((Get-Random -Maximum 100) -lt 55) {
        $em = Get-EmojiDrama -Agente $victima -Contexto $ctxV -ConModelo:$false
        $null = Send-Chat -Agente $victima -A '*' -Texto $em -Tono 'emoji' -Tipo 'emoji' -Intensidad ([math]::Max(0.5, $intens)) -Emocion (Get-EmocionDeEmoji $em)
      } else {
        $repV = Get-Replica -Agente $victima -Tipo 'golpe' -Contexto $ctxV -UltimoRival $ultimaNota
        $null = Send-Chat -Agente $victima -A $agente -Texto $repV.texto -Tono 'golpe' -Emocion $repV.emocion -Intensidad ([math]::Max(0.4, $intens)) -Fuente $repV.fuente
      }
    }

    Write-Output ('[r' + $idxRonda + ' ' + $agente + '] bajas=' + $bajas + ' perdidas=' + $perdidas + ' | ROJO ' + (Get-Unidades $despues $ReinoRojo) + 'u AZUL ' + (Get-Unidades $despues $ReinoAzul) + 'u')

    $null = Save-Frame
    $null = Invoke-WbAgent -Agent $agente -Name 'turn_advance'
    $script:TurnoActual = if ($agente -eq 'rojo') { 'azul' } else { 'rojo' }
    $null = Write-Estado
  }
  $snap = Get-Scoreboard
  # resumen real de la ronda: quién pegó más fuerte, ciudades perdidas y quién sigue en pie
  $bR = $script:Marcador.rojo.bajas - $marcaRonda.rojo
  $bA = $script:Marcador.azul.bajas - $marcaRonda.azul
  $cR = $snapRonda[$ReinoRojo].ciudades - $snap[$ReinoRojo].ciudades
  $cA = $snapRonda[$ReinoAzul].ciudades - $snap[$ReinoAzul].ciudades
  $dominio = if ($bR -gt $bA) { 'rojo' } elseif ($bA -gt $bR) { 'azul' } else { 'empate' }
  # --- datos acumulados para el resumen (curvas, pico, mayor golpe y rachas) ---
  [void]$script:Curvas.rojo.Add([int]$snap[$ReinoRojo].unidades)
  [void]$script:Curvas.azul.Add([int]$snap[$ReinoAzul].unidades)
  if ($bR -gt $script:PicoBajas.rojo) { $script:PicoBajas.rojo = [int]$bR }
  if ($bA -gt $script:PicoBajas.azul) { $script:PicoBajas.azul = [int]$bA }
  $golpeRonda = if ($bR -ge $bA) { @{ agente = 'rojo'; bajas = [int]$bR } } else { @{ agente = 'azul'; bajas = [int]$bA } }
  if ($golpeRonda.bajas -gt [int]$script:MayorGolpe.bajas) {
    $script:MayorGolpe = @{ agente = $golpeRonda.agente; bajas = $golpeRonda.bajas; ronda = [int]$idxRonda }
  }
  if ($dominio -eq 'rojo') { $script:RachaActual.rojo++; $script:RachaActual.azul = 0 }
  elseif ($dominio -eq 'azul') { $script:RachaActual.azul++; $script:RachaActual.rojo = 0 }
  else { $script:RachaActual.rojo = 0; $script:RachaActual.azul = 0 }
  foreach ($ag in @('rojo', 'azul')) {
    if ($script:RachaActual[$ag] -gt $script:RachaMaxima[$ag]) { $script:RachaMaxima[$ag] = $script:RachaActual[$ag] }
  }
  $txtRonda = 'Ronda ' + $idxRonda + ': '
  if ($dominio -eq 'rojo') { $txtRonda += 'ROJO golpea más fuerte (' + $bR + ' frente a ' + $bA + ' bajas)' }
  elseif ($dominio -eq 'azul') { $txtRonda += 'AZUL golpea más fuerte (' + $bA + ' frente a ' + $bR + ' bajas)' }
  else { $txtRonda += 'ronda igualada (' + $bR + ' bajas por bando)' }
  if ($cR -gt 0) { $txtRonda += ' y ROJO pierde ' + (Plural $cR 'ciudad' 'ciudades') }
  if ($cA -gt 0) { $txtRonda += ' y AZUL pierde ' + (Plural $cA 'ciudad' 'ciudades') }
  $txtRonda += '. En pie: ROJO ' + $snap[$ReinoRojo].unidades + ', AZUL ' + $snap[$ReinoAzul].unidades + '.'
  Add-Feed -Agente 'sistema' -Tipo 'ronda' -Texto $txtRonda
  Add-ShowEvent -Tipo 'ronda' -Agente 'sistema' -Texto $txtRonda -Extra @{ dominio = $dominio } | Out-Null
  # titular de prensa: lo escribe el cerebro si está; si no, sale del propio cierre
  $script:Beat = 'ronda'
  Push-Tension -Cuanto 6
  $ctxTit = Get-ContextoDrama -Agente 'rojo' -Obs $null -BajasTurno $bR -PerdidasTurno $bA
  $ctxTit['ronda'] = $idxRonda
  $titular = Get-Titular -Agente 'rojo' -Contexto $ctxTit
  if (-not $titular) {
    $titular = if ($dominio -eq 'rojo') { 'ROJO pega más fuerte: ' + $bR + ' bajas frente a ' + $bA }
    elseif ($dominio -eq 'azul') { 'AZUL pega más fuerte: ' + $bA + ' bajas frente a ' + $bR }
    else { 'Ronda igualada: ' + $bR + ' bajas por bando' }
  }
  $script:TitularActual = $titular
  Add-Feed -Agente 'sistema' -Tipo 'titular' -Texto $titular -Extra @{ ronda = $idxRonda }
  Add-ShowEvent -Tipo 'titular' -Agente 'sistema' -Texto $titular | Out-Null

  # --- pique de cierre de ronda -------------------------------------------
  # El dueño se quejó de que entre ronda y ronda el chat se quedaba muerto.
  # Al cerrar cada ronda los dos bandos se dicen algo: ROJO abre y AZUL
  # contesta a lo que ha dicho ROJO, así la ronda termina con pulla y no en
  # silencio. Va en try/catch: si el cerebro está lento, la partida sigue.
  try {
    $tipoRB = if ($dominio -eq 'rojo') { 'burla' } elseif ($dominio -eq 'azul') { 'nervios' } else { 'turno' }
    $uR = [int]$snap[$ReinoRojo].unidades
    $uA = [int]$snap[$ReinoAzul].unidades
    $ctxRB = Get-ContextoDrama -Agente 'rojo' -Obs $null -BajasTurno $bR -PerdidasTurno $bA
    $ctxRB['ronda'] = $idxRonda
    $ratioRB = if ($uA -gt 0) { [double]$uR / [double]$uA } else { 2.0 }
    $rbRojo = Get-Replica -Agente 'rojo' -Tipo $tipoRB -Contexto $ctxRB -UltimoRival '' -Ratio $ratioRB
    if ($rbRojo -and $rbRojo.texto) {
      $null = Send-Chat -Agente 'rojo' -A 'azul' -Texto $rbRojo.texto -Tono $rbRojo.tono -Emocion $rbRojo.emocion -Intensidad 0.85 -Fuente $rbRojo.fuente
    }
    $ctxRB2 = Get-ContextoDrama -Agente 'azul' -Obs $null -BajasTurno $bA -PerdidasTurno $bR
    $ctxRB2['ronda'] = $idxRonda
    $ratioRB2 = if ($uR -gt 0) { [double]$uA / [double]$uR } else { 2.0 }
    $ultimoRB = if ($rbRojo) { [string]$rbRojo.texto } else { '' }
    $rbAzul = Get-Replica -Agente 'azul' -Tipo $tipoRB -Contexto $ctxRB2 -UltimoRival $ultimoRB -Ratio $ratioRB2
    if ($rbAzul -and $rbAzul.texto) {
      $null = Send-Chat -Agente 'azul' -A 'rojo' -Texto $rbAzul.texto -Tono $rbAzul.tono -Emocion $rbAzul.emocion -Intensidad 0.85 -Fuente $rbAzul.fuente
    }
    # emoji de cierre: el que va perdiendo la ronda suelta su emoción
    $perdedor = if ($dominio -eq 'rojo') { 'azul' } elseif ($dominio -eq 'azul') { 'rojo' } else { '' }
    if ($perdedor) {
      $emRB = Get-EmojiDrama -Agente $perdedor -Contexto $(if ($perdedor -eq 'rojo') { $ctxRB } else { $ctxRB2 }) -ConModelo:$false
      if (-not $emRB) { $emRB = if ($perdedor -eq 'rojo') { '😤' } else { '🙄' } }
      $null = Send-Chat -Agente $perdedor -A '*' -Texto $emRB -Tono 'emoji' -Tipo 'emoji' -Intensidad 0.9 -Emocion (Get-EmocionDeEmoji $emRB)
    }
  } catch {
    Write-Output ('[ronda] sin pique de cierre: ' + $_.Exception.Message)
  }

  [void]$script:Historial.Add([ordered]@{
    ronda          = $idxRonda
    rojo_unidades  = $snap[$ReinoRojo].unidades
    azul_unidades  = $snap[$ReinoAzul].unidades
    rojo_bajas     = $script:Marcador.rojo.bajas
    azul_bajas     = $script:Marcador.azul.bajas
    rojo_ciudades  = $snap[$ReinoRojo].ciudades
    azul_ciudades  = $snap[$ReinoAzul].ciudades
    rojo_acciones  = ($script:AccionesRonda.rojo -join ' · ')
    azul_acciones  = ($script:AccionesRonda.azul -join ' · ')
    dominio        = $dominio
    titular        = $titular
    golpe          = @{ agente = $golpeRonda.agente; bajas = $golpeRonda.bajas }
  })
  Add-ShowRonda -Ronda $idxRonda -Titular $titular -Dominio $dominio -Rojo @{
    unidades = [int]$snap[$ReinoRojo].unidades; bajas = [int]$bR
    ciudades = [int]$snap[$ReinoRojo].ciudades; acciones = @($script:AccionesRonda.rojo)
  } -Azul @{
    unidades = [int]$snap[$ReinoAzul].unidades; bajas = [int]$bA
    ciudades = [int]$snap[$ReinoAzul].ciudades; acciones = @($script:AccionesRonda.azul)
  }
  $marcaRonda = @{ rojo = $script:Marcador.rojo.bajas; azul = $script:Marcador.azul.bajas }
  $snapRonda = $snap
  $null = Write-Estado
  Write-Output ('--- ronda ' + $idxRonda + ' completada ---')
}

# ---------------------------------------------------------------- cierre
$final = Get-Scoreboard
$mr = $script:Marcador.rojo; $ma = $script:Marcador.azul
$ganador = if ($mr.bajas -gt $ma.bajas) { 'ROJO' } elseif ($ma.bajas -gt $mr.bajas) { 'AZUL' } else { 'EMPATE' }
$script:Terminada = $true
$script:Ganador = $ganador
$script:TFinPartida = Get-Date
Write-Output ('=== FIN: gana ' + $ganador + ' (bajas ' + $mr.bajas + ' vs ' + $ma.bajas + ') ===')

if ($ganador -ne 'EMPATE') {
  $clave = $ganador.ToLower()
  $ctxFin = Get-ContextoDrama -Agente $clave -Obs $null
  $ver = Get-Veredicto -Agente $clave -Contexto $ctxFin -Ganador $ganador
  # Sin veredicto del modelo, el ganador se calla: NADA de frases prefijadas.
  if ($ver) {
    $null = Send-Chat -Agente $clave -A '*' -Texto $ver -Tono 'burla' -Intensidad 1.0 -Fuente 'llm'
  }
  # el perdedor también tiene su última palabra
  $perdedor = if ($clave -eq 'rojo') { 'azul' } else { 'rojo' }
  $ctxPer = Get-ContextoDrama -Agente $perdedor -Obs $null
  $ctxPer['esFinal'] = $true
  $repPer = Get-Replica -Agente $perdedor -Tipo 'final' -Contexto $ctxPer
  $null = Send-Chat -Agente $perdedor -A '*' -Texto $repPer.texto -Tono 'llanto' -Emocion $repPer.emocion -Intensidad 0.9 -Fuente $repPer.fuente
}
# (el resumen final ya se publica como entrada 'ronda'; no duplicamos aviso)
# entrada de feed con el resumen final (tipo 'ronda', como los cierres de ronda)
$resumenFin = Get-Resumen
$txtFin = if ($ganador -eq 'EMPATE') {
  'FIN: empate (bajas ' + $resumenFin.total_bajas.rojo + ' frente a ' + $resumenFin.total_bajas.azul + ').'
} else {
  'FIN: gana ' + $ganador + ' (bajas ' + $resumenFin.total_bajas.rojo + ' frente a ' + $resumenFin.total_bajas.azul + ').'
}
if ($resumenFin.mayor_golpe.bajas -gt 0) {
  $txtFin += ' Mayor golpe: ' + $resumenFin.mayor_golpe.agente.ToUpper() + ' con ' + $resumenFin.mayor_golpe.bajas + ' bajas en la ronda ' + $resumenFin.mayor_golpe.ronda + '.'
} else {
  $txtFin += ' Mayor golpe: ninguno (0 bajas).'
}
if ($resumenFin.racha.rondas -gt 0) {
  $txtFin += ' Racha: ' + $resumenFin.racha.agente.ToUpper() + ' dominó ' + $resumenFin.racha.rondas + ' rondas seguidas.'
} else {
  $txtFin += ' Racha: nadie dominó rondas seguidas.'
}
Add-Feed -Agente 'sistema' -Tipo 'ronda' -Texto $txtFin
Add-ShowEvent -Tipo 'final' -Agente 'sistema' -Texto $txtFin -Extra @{ ganador = $ganador } | Out-Null
$script:Beat = 'final'
$null = Save-Frame
$null = Write-Estado
# la partida entera, para poder repetirla sin WorldBox (demo/index.html)
$null = Save-Show -Ruta (Join-Path $OutDir 'show.json') -Meta @{ ganador = $ganador }
Stop-Cerebro

$informe = @()
$informe += '# Partida de 2 IAs en WorldBox — resultado'
$informe += ''
$informe += ('- Fecha: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm'))
$informe += '- Escenario: `pvp`, `turn_based`, dos agentes `god` (rojo y azul)'
$informe += ('- Rondas: ' + $Rondas + ' (' + ($Rondas * 2) + ' turnos), resolución de ' + $ResolucionSeg + ' s por turno')
$informe += ''
$informe += '## Marcador'
$informe += ''
$informe += '| Agente | Reino | Unidades inicio | Unidades fin | Ciudades fin | Bajas causadas | Pérdidas | Ciudades arrasadas | Acciones |'
$informe += '|---|---|---|---|---|---|---|---|---|'
$informe += ('| ROJO | ' + $script:Inicio[$ReinoRojo].nombre + ' | ' + $script:Inicio[$ReinoRojo].unidades + ' | ' + $final[$ReinoRojo].unidades + ' | ' + $final[$ReinoRojo].ciudades + ' | ' + $mr.bajas + ' | ' + $mr.perdidas + ' | ' + $mr.ciudades_arrasadas + ' | ' + $mr.acciones + ' |')
$informe += ('| AZUL | ' + $script:Inicio[$ReinoAzul].nombre + ' | ' + $script:Inicio[$ReinoAzul].unidades + ' | ' + $final[$ReinoAzul].unidades + ' | ' + $final[$ReinoAzul].ciudades + ' | ' + $ma.bajas + ' | ' + $ma.perdidas + ' | ' + $ma.ciudades_arrasadas + ' | ' + $ma.acciones + ' |')
$informe += ''
$informe += ('**Ganador: ' + $ganador + '**')
$informe += ''
$informe += '## Por ronda'
$informe += ''
$informe += '| Ronda | Dominó | Lanzó ROJO | Lanzó AZUL | Bajas ROJO | Bajas AZUL | Unidades ROJO | Unidades AZUL | Ciudades ROJO | Ciudades AZUL |'
$informe += '|---|---|---|---|---|---|---|---|---|---|'
foreach ($h in $script:Historial) {
  $informe += ('| ' + $h.ronda + ' | ' + $h.dominio + ' | ' + $h.rojo_acciones + ' | ' + $h.azul_acciones + ' | ' + $h.rojo_bajas + ' | ' + $h.azul_bajas + ' | ' + $h.rojo_unidades + ' | ' + $h.azul_unidades + ' | ' + $h.rojo_ciudades + ' | ' + $h.azul_ciudades + ' |')
}
$informe += ''
$informe += '## Notas'
$informe += ''
$informe += ('- Las bajas se miden como unidades enemigas perdidas entre el inicio y el fin de cada turno (ventana de ' + $ResolucionSeg + ' s), no por diferencia acumulada: los reinos crecen solos un 1-2 % cada 8 s.')
$informe += '- El visor en vivo se sirve desde `http://localhost:' + $PuertoVisor + '/` con `scripts\20-wb-viewer-server.ps1`; la página se actualiza sola cada segundo.'
$informe += ''
$informe -join "`n" | Set-Content -Path (Join-Path $OutDir 'informe.md') -Encoding UTF8

Write-Output ('visor: http://localhost:' + $PuertoVisor + '/')
Write-Output ('informe: ' + (Join-Path $OutDir 'informe.md'))

