<#
22-director.ps1 - La capa de dirección del show.

El motor (19-wb-match.ps1) sabe pelear; este fichero sabe CONTARLO. Aquí viven:

  * el cerebro dramático (23-drama-llm.mjs): se le piden las réplicas a un LLM de
    verdad y, si no contesta, se cae sin hacer ruido al generador procedural de
    21-drama.ps1 (el show nunca se queda mudo);
  * la moral y la tensión: dos números que resumen cómo va la velada y que el
    visor pinta como barras;
  * los titulares de ronda y el veredicto final;
  * la línea temporal completa (out/show.json) para poder repetir la partida
    sin WorldBox.

Se dot-sourcea desde el motor después de 21-drama.ps1:

    . (Join-Path $PSScriptRoot '22-director.ps1')

Todo lo que sale de aquí es opcional para el motor: si el cerebro está apagado,
las funciones devuelven $null y el motor usa su fallback.
#>

# ---------------------------------------------------------------- estado
$script:CerebroUrl = if ($env:DRAMA_URL) { $env:DRAMA_URL } else { 'http://127.0.0.1:8766' }
$script:CerebroPuerto = 8766
$script:CerebroVivo = $null          # $null = sin comprobar, $true/$false = última comprobación
$script:CerebroComprobadoEn = [datetime]::MinValue
$script:CerebroFichero = Join-Path $PSScriptRoot '23-drama-llm.mjs'
$script:CerebroProceso = $null
$script:CerebroLlamadas = 0
$script:CerebroFallos = 0
$script:DirectorioOn = $true         # -SinDrama lo apaga

# moral y tensión: el pulso del show
$script:Moral = @{ rojo = 70.0; azul = 70.0 }
$script:Tension = 25.0
$script:Beat = 'espera'

# línea temporal para la repetición
$script:ShowEventos = New-Object System.Collections.ArrayList
$script:ShowRondas = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- cerebro

<#
Arranca el cerebro si no está ya escuchando. Devuelve $true si hay cerebro.

Es best-effort a propósito: si Node no está, si el vault de DSH no existe o si
el modelo está saturado, el show sigue con el drama procedural. Nunca lanza.
#>
function Start-Cerebro {
  param([switch]$Force)
  if (-not $script:DirectorioOn) { return $false }
  if (-not $Force -and (Test-Cerebro)) { return $true }
  if (-not (Test-Path -LiteralPath $script:CerebroFichero)) { return $false }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Write-Output 'director: no hay node en el PATH; drama procedural.'; return $false }
  try {
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $node.Source
    $psi.Arguments = '"' + $script:CerebroFichero + '" --port ' + $script:CerebroPuerto
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $PSScriptRoot
    $script:CerebroProceso = [Diagnostics.Process]::Start($psi)
    # drenar los flujos para que el hijo no se bloquee escribiendo
    $null = $script:CerebroProceso.BeginOutputReadLine()
    $null = $script:CerebroProceso.BeginErrorReadLine()
  } catch {
    Write-Output ('director: no pude arrancar el cerebro (' + $_.Exception.Message + '); drama procedural.')
    return $false
  }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Cerebro -Force) { return $true }
    if ($script:CerebroProceso -and $script:CerebroProceso.HasExited) { break }
  }
  Write-Output 'director: el cerebro no respondió a tiempo; drama procedural.'
  return $false
}

function Stop-Cerebro {
  if ($script:CerebroProceso -and -not $script:CerebroProceso.HasExited) {
    try { $script:CerebroProceso.Kill($true) } catch { }
  }
  $script:CerebroProceso = $null
}

<# ¿Está el cerebro escuchando? Cachea el resultado 5 s para no preguntar en bucle. #>
function Test-Cerebro {
  param([switch]$Force)
  if (-not $script:DirectorioOn) { return $false }
  $ahora = Get-Date
  if (-not $Force -and $script:CerebroVivo -ne $null -and ($ahora - $script:CerebroComprobadoEn).TotalSeconds -lt 5) {
    return [bool]$script:CerebroVivo
  }
  $vivo = $false
  try {
    $r = Invoke-RestMethod -Uri ($script:CerebroUrl + '/health') -TimeoutSec 3 -Method Get -ErrorAction Stop
    $vivo = [bool]$r.ok
  } catch {
    $vivo = $false
  }
  $script:CerebroVivo = $vivo
  $script:CerebroComprobadoEn = $ahora
  return $vivo
}

<#
Una llamada JSON al cerebro. Devuelve el objeto o $null (nunca lanza): el show
no se para porque el modelo esté saturado.
#>
function Invoke-Cerebro {
  param([string]$Ruta, [hashtable]$Cuerpo, [int]$TimeoutSec = 14)
  if (-not $script:DirectorioOn) { return $null }
  if (-not (Test-Cerebro)) { return $null }
  try {
    $json = $Cuerpo | ConvertTo-Json -Depth 6 -Compress
    $r = Invoke-RestMethod -Uri ($script:CerebroUrl + $Ruta) -Method Post `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec $TimeoutSec -ErrorAction Stop
    $script:CerebroLlamadas++
    if ($r -and $r.ok) { return $r }
    $script:CerebroFallos++
    return $null
  } catch {
    $script:CerebroFallos++
    return $null
  }
}

# ---------------------------------------------------------------- contexto

<#
El "briefing" que se le pasa al modelo: números reales de la partida para que
pueda hablar de lo que está pasando de verdad.
#>
function Get-ContextoDrama {
  param(
    [string]$Agente,
    $Obs,
    [int]$BajasTurno = 0,
    [int]$PerdidasTurno = 0,
    [string]$UltimoGolpe = '',
    [string]$GolpeRival = ''
  )
  $rival = if ($Agente -eq 'rojo') { 'azul' } else { 'rojo' }
  $mias = 0; $suyas = 0
  $misBajas = 0; $misPerdidas = 0
  $ratio = 1.0
  if ($Obs) {
    $mias = [int]$Obs.yo.unidades
    $suyas = [int]$Obs.rival.unidades
    if ($suyas -gt 0) { $ratio = [math]::Round($mias / $suyas, 2) }
  }
  if ($script:Marcador) {
    $misBajas = [int]$script:Marcador[$Agente].bajas
    $misPerdidas = [int]$script:Marcador[$Agente].perdidas
  }
  return @{
    ronda            = [int]$script:Ronda
    rondas           = if ($script:Rondas) { [int]$script:Rondas } else { 0 }
    misUnidades      = $mias
    susUnidades      = $suyas
    ratio            = $ratio
    misBajas         = $misBajas
    misPerdidas      = $misPerdidas
    bajasTurno       = $BajasTurno
    perdidasTurno    = $PerdidasTurno
    ultimoGolpe      = $UltimoGolpe
    golpeRival       = $GolpeRival
    ciudadesPerdidas = if ($script:TotalCiudadesPerdidas) { [int]$script:TotalCiudadesPerdidas[$Agente] } else { 0 }
    ciudadesArrasadas = if ($script:TotalCiudadesArrasadas) { [int]$script:TotalCiudadesArrasadas[$Agente] } else { 0 }
    ciudadPerdida = if ($script:NombreCiudadPerdida) { [string]$script:NombreCiudadPerdida[$Agente] } else { '' }
    ciudadArrasada = if ($script:NombreCiudadArrasada) { [string]$script:NombreCiudadArrasada[$Agente] } else { '' }
    moral            = [int][math]::Round($script:Moral[$Agente])
    tension          = [int][math]::Round($script:Tension)
    esFinal          = [bool]$script:Terminada
  }
}

# ---------------------------------------------------------------- diálogo

<#
La réplica de un agente. Intenta el LLM; si no hay, cae al generador procedural
de 21-drama.ps1 con los mismos datos. Devuelve un objeto { texto, tono }.
#>
function Get-Replica {
  param(
    [string]$Agente,
    [string]$Tipo = 'turno',
    $Contexto = $null,
    [string]$UltimoRival = '',
    [int]$Ratio = 1.0
  )
  if ($Contexto -eq $null) {
    $Contexto = Get-ContextoDrama -Agente $Agente -Obs $null
  }
  # tono de respaldo según cómo vaya la cosa
  $tonoFb = if ($Ratio -lt 0.55) { 'llanto' } elseif ($Ratio -gt 1.9) { 'burla' } else { 'chulo' }
  switch ($Tipo) {
    'golpe'  { $tonoFb = 'golpe' }
    'nervios' { $tonoFb = 'nervios' }
    'burla'  { $tonoFb = 'burla' }
    'ronda'  { if ($Ratio -lt 0.6) { $tonoFb = 'nervios' } }
  }

  $r = Invoke-Cerebro -Ruta '/line' -Cuerpo @{
    agente      = $Agente
    tipo        = $Tipo
    contexto    = $Contexto
    ultimoRival = $UltimoRival
    maxTokens   = 120
  }
  if ($r -and $r.texto) {
    return [pscustomobject]@{ texto = [string]$r.texto; tono = $tonoFb; fuente = 'llm' }
  }
  # fallback: el generador de siempre, que ya conoce a los personajes
  $texto = New-Drama -Agente $Agente -Ratio $Ratio -Ronda $script:Ronda -Turno $script:TurnoN -UltimoRival $UltimoRival
  return [pscustomobject]@{ texto = $texto; tono = $tonoFb; fuente = 'procedural' }
}

<# Un emoji suelto, elegido por el modelo cuando puede. Devuelve el carácter. #>
function Get-EmojiDrama {
  param([string]$Agente, $Contexto = $null, [switch]$ConModelo)
  if ($Contexto -eq $null) { $Contexto = Get-ContextoDrama -Agente $Agente -Obs $null }
  $r = Invoke-Cerebro -Ruta '/emoji' -Cuerpo @{
    agente    = $Agente
    conModelo = [bool]$ConModelo
    contexto  = $Contexto
  } -TimeoutSec 12
  if ($r -and $r.emoji) { return [string]$r.emoji }
  return (New-Emoji -Agente $Agente)
}

<# El titular de la ronda, tipo prensa deportiva. $null si no hay cerebro. #>
function Get-Titular {
  param([string]$Agente, $Contexto)
  $r = Invoke-Cerebro -Ruta '/headline' -Cuerpo @{ agente = $Agente; contexto = $Contexto } -TimeoutSec 16
  if ($r -and $r.texto) { return [string]$r.texto }
  return $null
}

<# La frase final del ganador o del perdedor. $null si no hay cerebro. #>
function Get-Veredicto {
  param([string]$Agente, $Contexto, [string]$Ganador)
  $r = Invoke-Cerebro -Ruta '/verdict' -Cuerpo @{
    agente = $Agente; contexto = $Contexto; ganador = $Ganador
  } -TimeoutSec 16
  if ($r -and $r.texto) { return [string]$r.texto }
  return $null
}

# ---------------------------------------------------------------- pulso

<#
Recalcula moral y tensión con lo que acaba de pasar en un turno.

La moral sube al hacer daño y baja al recibirlo, pero no es una cuenta corriente:
cuenta más el último golpe que el acumulado (por eso hay un suelo y un techo
anchos y el delta se amortigua). La tensión sube con la ronda y con los golpes
cruzados, y baja cuando la partida se desequilibra (ya no hay drama).
#>
function Update-Drama {
  param(
    [string]$Agente,
    [int]$Bajas = 0,
    [int]$Perdidas = 0,
    [int]$BajasRival = 0
  )
  $rival = if ($Agente -eq 'rojo') { 'azul' } else { 'rojo' }
  # escala logarítmica: 5 bajas no son la mitad de 500
  $daño = if ($Bajas -gt 0) { [math]::Log10(1 + $Bajas) } else { 0 }
  $sufrido = if ($Perdidas -gt 0) { [math]::Log10(1 + $Perdidas) } else { 0 }
  $script:Moral[$Agente] = [math]::Min(100, [math]::Max(15, $script:Moral[$Agente] + 6.0 * $daño - 5.0 * $sufrido))
  $script:Moral[$rival] = [math]::Min(100, [math]::Max(15, $script:Moral[$rival] - 4.0 * $daño + 3.0 * $sufrido))

  $choque = [math]::Log10(1 + $Bajas + $Perdidas)
  $script:Tension = [math]::Min(100, [math]::Max(0, $script:Tension + 4.0 * $choque + 1.5))

  # el que va ganando se relaja un poco y el que va perdiendo se tensa
  $mr = $script:Moral.rojo; $ma = $script:Moral.azul
  if ([math]::Abs($mr - $ma) -gt 25) { $script:Tension = [math]::Max(0, $script:Tension - 2.0) }
  return [pscustomobject]@{ moral = $script:Moral.Clone(); tension = [math]::Round($script:Tension, 0) }
}

<# Un golpe gordo calienta el ambiente de golpe (se usa al abrir cada ronda). #>
function Push-Tension {
  param([double]$Cuanto = 8)
  $script:Tension = [math]::Min(100, [math]::Max(0, $script:Tension + $Cuanto))
}

<# El nivel de espectáculo de un golpe, 0-1: lo usa el visor para el tamaño del efecto. #>
function Get-Intensidad {
  param([int]$Bajas, [int]$Referencia = 250)
  if ($Bajas -le 0) { return 0.0 }
  $i = [math]::Log10(1 + $Bajas) / [math]::Log10(1 + [math]::Max(10, $Referencia))
  return [math]::Round([math]::Min(1.0, [math]::Max(0.05, $i)), 2)
}

# ---------------------------------------------------------------- línea temporal

<# Guarda un evento en la línea temporal del show (para la repetición). #>
function Add-ShowEvent {
  param(
    [string]$Tipo,
    [string]$Agente = 'sistema',
    [string]$Texto = '',
    [hashtable]$Extra = @{}
  )
  $t0 = if ($script:TInicioPartida) { $script:TInicioPartida } else { Get-Date }
  $ev = [ordered]@{
    seq    = $script:ShowEventos.Count + 1
    t_ms   = [int][math]::Max(0, ((Get-Date) - $t0).TotalMilliseconds)
    ronda  = [int]$script:Ronda
    agente = $Agente
    tipo   = $Tipo
    texto  = $Texto
  }
  foreach ($k in $Extra.Keys) { if ($Extra[$k] -ne $null) { $ev[$k] = $Extra[$k] } }
  [void]$script:ShowEventos.Add($ev)
  return $ev
}

<# Cierra la ronda en la línea temporal (una fila por ronda, con su titular). #>
function Add-ShowRonda {
  param(
    [int]$Ronda,
    [string]$Titular = '',
    [string]$Dominio = 'empate',
    [hashtable]$Rojo = @{},
    [hashtable]$Azul = @{}
  )
  [void]$script:ShowRondas.Add([ordered]@{
    ronda   = $Ronda
    titular = $Titular
    dominio = $Dominio
    rojo    = $Rojo
    azul    = $Azul
  })
}

<#
Escribe out/show.json: la partida entera con tiempos relativos, lista para que
la página de repetición la reproduzca sin WorldBox.
#>
function Save-Show {
  param([string]$Ruta, [hashtable]$Meta = @{})
  $inicio = if ($script:TInicioPartida) { $script:TInicioPartida } else { Get-Date }
  $fin = if ($script:TFinPartida) { $script:TFinPartida } else { Get-Date }
  $duracion = [int][math]::Max(0, [math]::Round(($fin - $inicio).TotalSeconds, 0))

  $reinos = @{}
  if ($script:Inicio) {
    foreach ($par in @(@('rojo', $script:ReinoRojo), @('azul', $script:ReinoAzul))) {
      $lado = $par[0]; $id = $par[1]
      if ($script:Inicio.ContainsKey($id)) {
        $reinos[$lado] = @{ id = [int]$id; nombre = [string]$script:Inicio[$id].nombre }
      }
    }
  }
  $estadoInicial = @{}
  if ($script:Inicio) {
    foreach ($par in @(@('rojo', $script:ReinoRojo), @('azul', $script:ReinoAzul))) {
      $lado = $par[0]; $id = $par[1]
      if ($script:Inicio.ContainsKey($id)) {
        $estadoInicial[$lado] = @{ unidades = [int]$script:Inicio[$id].unidades; ciudades = [int]$script:Inicio[$id].ciudades }
      }
    }
  }

  $doc = [ordered]@{
    version        = 2
    meta           = [ordered]@{
      fecha        = (Get-Date).ToString('yyyy-MM-dd HH:mm')
      rondas       = if ($script:Rondas) { [int]$script:Rondas } else { 0 }
      resolucion_s = if ($script:ResolucionSeg) { [int]$script:ResolucionSeg } else { 0 }
      reinos       = $reinos
      inicio_ms    = [long]([DateTimeOffset]::new($inicio.ToUniversalTime())).ToUnixTimeMilliseconds()
      fin_ms       = [long]([DateTimeOffset]::new($fin.ToUniversalTime())).ToUnixTimeMilliseconds()
      duracion_s   = $duracion
      ganador      = [string]$script:Ganador
    }
    estado_inicial = $estadoInicial
    rondas         = @($script:ShowRondas)
    eventos        = @($script:ShowEventos)
    resumen        = if (Get-Command Get-Resumen -ErrorAction SilentlyContinue) { Get-Resumen } else { @{} }
  }
  foreach ($k in $Meta.Keys) { $doc.meta[$k] = $Meta[$k] }
  $json = $doc | ConvertTo-Json -Depth 10
  for ($i = 0; $i -lt 12; $i++) {
    try {
      [IO.File]::WriteAllText($Ruta, $json, [Text.UTF8Encoding]::new($false))
      return $true
    } catch { Start-Sleep -Milliseconds 60 }
  }
  return $false
}
