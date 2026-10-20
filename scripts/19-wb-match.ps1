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
#>
[CmdletBinding()]
param(
  [int]$Rondas = 8,
  [int]$ResolucionSeg = 4,
  [int]$ReinoRojo = 73,
  [int]$ReinoAzul = 78,
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
  rojo = [ordered]@{ agente = 'rojo'; reino = $ReinoRojo; nombre = ''; bajas = 0; perdidas = 0; acciones = 0; turnos = 0; ciudades_arrasadas = 0 }
  azul = [ordered]@{ agente = 'azul'; reino = $ReinoAzul; nombre = ''; bajas = 0; perdidas = 0; acciones = 0; turnos = 0; ciudades_arrasadas = 0 }
}
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

function Send-Chat {
  param([string]$Agente, [string]$A, [string]$Texto, [string]$Tono = 'chulo',
    [string]$Tipo = 'chat', [double]$Intensidad = 0.5, [string]$Emocion = '', [int]$RespuestaA = 0)
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
    Add-Feed -Agente $Agente -Tipo $Tipo -Texto $Texto -Extra $extra
    Add-ShowEvent -Tipo $Tipo -Agente $Agente -Texto $Texto -Extra @{
      tono = $Tono; intensidad = $Intensidad; emocion = $(if ($Emocion) { $Emocion } else { $null })
    } | Out-Null
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
    return @([pscustomobject]@{ accion = 'chat'; to = '*'; texto = 'No encuentro al enemigo. Qué mapa más raro.' })
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
  # cada tanto, en vez de frase, la IA lanza una emoción suelta (emoji solo)
  if ((Get-Random -Maximum 100) -lt 20) {
    $emoji = Get-EmojiDrama -Agente $Agente -Contexto $ctx -ConModelo:([bool]($script:Tension -gt 45))
    if (-not $emoji) { $emoji = if ($Agente -eq 'rojo') { '😤' } else { '🙄' } }
    $plan += [pscustomobject]@{ accion = 'emoji'; to = '*'; texto = $emoji; tono = 'emoji'
      intensidad = [math]::Round([math]::Max(0.35, [math]::Min(1.0, $script:Tension / 100 + 0.25)), 2)
      emocion = 'emoción' }
  } else {
    $rep = Get-Replica -Agente $Agente -Tipo $tipoBeat -Contexto $ctx -UltimoRival $ultimoRival -Ratio $ratio
    $plan += [pscustomobject]@{ accion = 'chat'; to = '*'; texto = $rep.texto; tono = $rep.tono
      intensidad = [math]::Round([math]::Max(0.15, [math]::Min(1.0, [math]::Abs($ratio - 1.0) + 0.3)), 2)
      fuente = $rep.fuente }
  }
  return $plan
}

# ---------------------------------------------------------------- visor
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
Ensure-Servidor
# El cerebro dramático es opcional: si no arranca, el show sigue con el
# generador procedural de 21-drama.ps1 (mismo ritmo, menos imaginación).
if ($script:DirectorioOn) {
  if (Start-Cerebro) { Write-Output 'director: cerebro dramático en marcha (diálogo improvisado).' }
  else { Write-Output 'director: sin cerebro; drama procedural.' }
}

if (-not $SinReset) {
  Write-Output 'Cargando el guardado save2…'
  $null = Invoke-WbAgent -Agent rojo -Name 'load_world' -A @{ path = 'save2' } -TimeoutSec 120
  $listo = $false
  for ($i = 1; $i -le 200; $i++) {
    Start-Sleep -Milliseconds 700
    $s = Invoke-WbAgent -Agent rojo -Name 'get_world_state'
    if ($s.ok -and $s.result.width -eq 576 -and $s.result.kingdoms_alive -ge 2 -and $s.result.population_alive -ge 1000) { $listo = $true; break }
  }
  if (-not $listo) { throw 'el mundo no terminó de cargar (width/kingdoms/population)' }
  $script:Tick = [int]$s.result.tick
  Write-Output ('Mundo listo en ' + [math]::Round($i * 0.7, 1) + ' s (población ' + $s.result.population_alive + ', reinos ' + $s.result.kingdoms_alive + ')')
  Start-Sleep -Seconds 2
}
$null = Invoke-WbAgent -Agent rojo -Name 'set_speed' -A @{ speed = 3 }
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
  if ($script:Inicio.ContainsKey($ReinoRojo) -and $script:Inicio.ContainsKey($ReinoAzul) -and $script:Inicio[$ReinoRojo].unidades -gt 0) { break }
  Start-Sleep -Milliseconds 800
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
$null = Send-Chat -Agente 'rojo' -A '*' -Texto $apR.texto -Tono 'chulo' -Intensidad 0.8
$ctxIniA = Get-ContextoDrama -Agente 'azul' -Obs $null
$apA = Get-Replica -Agente 'azul' -Tipo 'apertura' -Contexto $ctxIniA -UltimoRival $apR.texto
$null = Send-Chat -Agente 'azul' -A '*' -Texto $apA.texto -Tono 'chulo' -Intensidad 0.8

$null = Save-Frame
$null = Write-Estado
Write-Output ('visor: http://localhost:' + $PuertoVisor + '/')

$marcaRonda = @{ rojo = 0; azul = 0 }
$snapRonda = $script:Inicio
for ($idxRonda = 1; $idxRonda -le $Rondas; $idxRonda++) {
  $script:Ronda = $idxRonda
  $script:AccionesRonda.rojo.Clear()
  $script:AccionesRonda.azul.Clear()
  foreach ($agente in @('rojo', 'azul')) {
    $script:TurnoN++
    $script:TurnoActual = $agente
    $propio = if ($agente -eq 'rojo') { $ReinoRojo } else { $ReinoAzul }
    $enemigo = if ($agente -eq 'rojo') { $ReinoAzul } else { $ReinoRojo }

    if (-not (Ensure-Turn -Agente $agente)) { Write-Output ('AVISO: no pude poner el turno en ' + $agente); continue }

    $antes = Get-Scoreboard
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
            Add-Feed -Agente $agente -Tipo 'bomba' -Texto $p.nota -Extra @{ power = $p.power; x = $p.x; y = $p.y }
            Add-ShowEvent -Tipo 'bomba' -Agente $agente -Texto $p.nota -Extra @{ power = $p.power } | Out-Null
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
          $null = Send-Chat -Agente $agente -A $p.to -Texto $p.texto -Tono $p.tono `
            -Intensidad $(if ($p.PSObject.Properties['intensidad']) { [double]$p.intensidad } else { 0.5 })
        }
        'emoji' {
          $null = Send-Chat -Agente $agente -A $p.to -Texto $p.texto -Tono 'emoji' -Tipo 'emoji' `
            -Intensidad $(if ($p.PSObject.Properties['intensidad']) { [double]$p.intensidad } else { 0.6 }) `
            -Emocion 'golpe'
        }
      }
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
        $null = Send-Chat -Agente $agente -A $rival -Texto $repR.texto -Tono $tonoR `
          -Intensidad ([math]::Round([math]::Min(1.0, [math]::Max(0.2, $script:Tension / 100 + 0.2)), 2)) `
          -RespuestaA $seqRival
        if ($textoRival) { $script:UltimoMensajeRival[$agente] = $textoRival }
      }
    }

    Start-Sleep -Seconds $ResolucionSeg

    $despues = Get-Scoreboard
    $bajas = [math]::Max(0, $antes[$enemigo].unidades - $despues[$enemigo].unidades)
    $perdidas = [math]::Max(0, $antes[$propio].unidades - $despues[$propio].unidades)
    $ciudadesArrasadas = [math]::Max(0, $antes[$enemigo].ciudades - $despues[$enemigo].ciudades)
    $script:Marcador[$agente].bajas += $bajas
    $script:Marcador[$agente].perdidas += $perdidas
    $script:Marcador[$agente].ciudades_arrasadas += $ciudadesArrasadas
    $script:Marcador[$agente].turnos++
    # el pulso del show: la moral sube al pegar y baja al recibir
    $pulso = Update-Drama -Agente $agente -Bajas $bajas -Perdidas $perdidas
    $intens = Get-Intensidad -Bajas $bajas
    if ($bajas -ge 60) { $script:Narrador = 'El público se levanta: ' + $bajas + ' bajas de un solo golpe.' }
    Add-Feed -Agente $agente -Tipo 'resultado' -Texto ('Bajas: ' + $bajas + ' · pérdidas: ' + $perdidas + ' · enemigo: ' + $despues[$enemigo].unidades + 'u/' + $despues[$enemigo].ciudades + 'c') -Extra @{ bajas = $bajas; perdidas = $perdidas; intensidad = $intens }
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
      if ((Get-Random -Maximum 100) -lt 35) {
        $em = Get-EmojiDrama -Agente $victima -Contexto $ctxV -ConModelo:([bool]($intens -gt 0.6))
        $null = Send-Chat -Agente $victima -A '*' -Texto $em -Tono 'emoji' -Tipo 'emoji' -Intensidad ([math]::Max(0.5, $intens)) -Emocion 'dolor'
      } else {
        $repV = Get-Replica -Agente $victima -Tipo 'golpe' -Contexto $ctxV -UltimoRival $ultimaNota
        $null = Send-Chat -Agente $victima -A $agente -Texto $repV.texto -Tono 'golpe' -Intensidad ([math]::Max(0.4, $intens))
      }
    }

    Write-Output ('[r' + $idxRonda + ' ' + $agente + '] bajas=' + $bajas + ' perdidas=' + $perdidas + ' | ROJO ' + $despues[$ReinoRojo].unidades + 'u AZUL ' + $despues[$ReinoAzul].unidades + 'u')

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
  if (-not $ver) { $ver = $script:Personas[$clave].victoria }
  $null = Send-Chat -Agente $clave -A '*' -Texto $ver -Tono 'burla' -Intensidad 1.0
  # el perdedor también tiene su última palabra
  $perdedor = if ($clave -eq 'rojo') { 'azul' } else { 'rojo' }
  $ctxPer = Get-ContextoDrama -Agente $perdedor -Obs $null
  $ctxPer['esFinal'] = $true
  $repPer = Get-Replica -Agente $perdedor -Tipo 'final' -Contexto $ctxPer
  $null = Send-Chat -Agente $perdedor -A '*' -Texto $repPer.texto -Tono 'llanto' -Intensidad 0.9
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
