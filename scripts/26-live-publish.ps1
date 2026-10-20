#Requires -Version 7.0
<#
  Publica el modo EN VIVO de WorldBox AI Show.

  - Arranca la pasarela (25-live-gateway.mjs) si no está escuchando.
  - Arranca un túnel rápido de Cloudflare contra 127.0.0.1:8770.
  - Extrae la URL https://*.trycloudflare.com del log y la escribe en
    worldbox-ai-show/live.json.
  - -Publicar: hace commit de live.json y lo empuja a main con el token,
    sin dejarlo en .git/config ni en la salida.
  - -Parar: mata el cloudflared del directo y deja live.json con en_vivo=false.

  Ejemplos:
    pwsh -File scripts\26-live-publish.ps1
    pwsh -File scripts\26-live-publish.ps1 -Publicar
    pwsh -File scripts\26-live-publish.ps1 -Parar
#>
[CmdletBinding()]
param(
  [switch]$Publicar,
  [switch]$Parar,
  [int]$Puerto = 8770,
  [int]$EsperaMax = 60,
  [string]$Repo = '',
  [string]$TokenFile = 'C:\Users\nebula\.dsh\github-token-worldbox.txt'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Join-Path $raiz 'worldbox-ai-show' }
$Repo = [System.IO.Path]::GetFullPath($Repo)
$reports = Join-Path $raiz 'reports'
$liveJson = Join-Path $Repo 'live.json'
$gwScript = Join-Path $PSScriptRoot '25-live-gateway.mjs'
$cloudflared = Join-Path $raiz 'bin\cloudflared.exe'
$pidFile = Join-Path $reports 'live-publish.json'
$cfOut = Join-Path $reports 'live-cloudflared.out.log'
$cfErr = Join-Path $reports 'live-cloudflared.err.log'
$gwOut = Join-Path $reports 'live-gateway.out.log'
$gwErr = Join-Path $reports 'live-gateway.err.log'
$urlRegex = 'https://[a-z0-9-]+\.trycloudflare\.com'

New-Item -ItemType Directory -Force -Path $reports | Out-Null

function Escribir-LiveJson {
  param([bool]$EnVivo, [string]$Url)
  $obj = [ordered]@{
    en_vivo     = $EnVivo
    url         = $Url
    actualizado = (Get-Date).ToString('o')
  }
  $obj | ConvertTo-Json | Set-Content -LiteralPath $liveJson -Encoding utf8
}

function Test-Puerto {
  param([int]$P)
  $c = [System.Net.Sockets.TcpClient]::new()
  try {
    $t = $c.ConnectAsync('127.0.0.1', $P)
    if (-not $t.Wait(450)) { return $false }
    return $c.Connected
  } catch {
    return $false
  } finally {
    $c.Dispose()
  }
}

function Get-CloudflaredPids {
  param([int]$P)
  $lista = New-Object System.Collections.Generic.List[int]
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction Stop
    foreach ($pr in $procs) {
      if ($pr.CommandLine -and $pr.CommandLine.Contains("127.0.0.1:$P")) {
        $lista.Add([int]$pr.ProcessId)
      }
    }
  } catch {
    # Sin CIM seguimos con el PID guardado.
  }
  if (Test-Path -LiteralPath $pidFile) {
    try {
      $j = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
      if ($j.cloudflared_pid) {
        $pr = Get-Process -Id ([int]$j.cloudflared_pid) -ErrorAction SilentlyContinue
        if ($pr -and $pr.ProcessName -eq 'cloudflared') { $lista.Add([int]$j.cloudflared_pid) }
      }
    } catch { }
  }
  return @($lista | Sort-Object -Unique)
}

function Leer-Log {
  param([string[]]$Rutas, [int]$Lineas = 25)
  $trozos = @()
  foreach ($r in $Rutas) {
    if (Test-Path -LiteralPath $r) {
      $trozos += (Get-Content -LiteralPath $r -Tail $Lineas -ErrorAction SilentlyContinue)
    }
  }
  return ($trozos -join "`n")
}

function Parar-Directo {
  $pids = @(Get-CloudflaredPids -P $Puerto)
  if ($pids.Count -eq 0) {
    Write-Host 'No hay ningún cloudflared del directo en marcha.'
  } else {
    foreach ($procId in $pids) {
      try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "cloudflared detenido (PID $procId)."
      } catch {
        Write-Warning "No pude detener cloudflared PID $procId : $($_.Exception.Message)"
      }
    }
  }
  if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Escribir-LiveJson -EnVivo $false -Url ''
  Write-Host "live.json -> en_vivo=false ($liveJson)"
}

function Publicar-Live {
  if (-not (Test-Path -LiteralPath $TokenFile)) {
    throw "No existe el fichero de token: $TokenFile"
  }
  $tok = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($tok)) { throw "El token de GitHub está vacío." }
  if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
    throw "No es un repositorio git: $Repo"
  }

  & git -C $Repo add -- live.json
  if ($LASTEXITCODE -ne 0) { throw "git add falló." }

  & git -C $Repo diff --cached --quiet -- live.json
  $hayCambios = ($LASTEXITCODE -ne 0)
  if ($hayCambios) {
    & git -C $Repo -c user.name='WorldBox Live' -c user.email='live@worldbox.local' commit -m 'live: actualizar URL del directo' -- live.json
    if ($LASTEXITCODE -ne 0) { throw "git commit falló." }
    Write-Host 'Commit de live.json creado.'
  } else {
    Write-Host 'live.json no ha cambiado; no hace falta commit.'
  }

  $pushUrl = "https://x-access-token:$tok@github.com/lamkone/worldbox-ai-show.git"
  $salida = & git -C $Repo -c credential.helper= -c http.extraheader= push $pushUrl "HEAD:refs/heads/main" 2>&1 | Out-String
  $codigo = $LASTEXITCODE
  $salida = $salida -replace [regex]::Escape($tok), '***'
  if ($salida.Trim()) { Write-Host $salida.Trim() }
  if ($codigo -ne 0) { throw "git push falló (código $codigo)." }
  Write-Host 'live.json publicado en main.'
}

# ---------------------------------------------------------------------------

if ($Parar) {
  Parar-Directo
  return
}

if (-not (Test-Path -LiteralPath $gwScript)) { throw "No existe la pasarela: $gwScript" }
if (-not (Test-Path -LiteralPath $cloudflared)) { throw "No existe cloudflared: $cloudflared" }
if (-not (Test-Path -LiteralPath $Repo)) { throw "No existe el repo: $Repo" }

# Si había un túnel anterior de este mismo puerto, lo retiramos.
$viejos = @(Get-CloudflaredPids -P $Puerto)
foreach ($procId in $viejos) {
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Write-Host "cloudflared anterior detenido (PID $procId)."
  } catch { }
}
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }

# 1) Pasarela.
$gwPid = $null
if (-not (Test-Puerto -P $Puerto)) {
  Write-Host "Arrancando pasarela en 127.0.0.1:$Puerto ..."
  $node = (Get-Command node -ErrorAction Stop).Source
  if (Test-Path -LiteralPath $gwOut) { Remove-Item -LiteralPath $gwOut -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $gwErr) { Remove-Item -LiteralPath $gwErr -Force -ErrorAction SilentlyContinue }
  $gw = Start-Process -FilePath $node -ArgumentList @($gwScript, '--port', "$Puerto") `
    -WorkingDirectory $raiz -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $gwOut -RedirectStandardError $gwErr
  $gwPid = $gw.Id
  $limite = (Get-Date).AddSeconds(15)
  while (-not (Test-Puerto -P $Puerto) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Puerto -P $Puerto)) {
    $cola = Leer-Log -Rutas @($gwErr, $gwOut)
    throw "La pasarela no arrancó en $Puerto.`n$cola"
  }
  Write-Host "Pasarela arrancada (PID $gwPid)."
} else {
  Write-Host "Pasarela ya escuchando en 127.0.0.1:$Puerto."
}

try {
  $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Puerto/api/chat?since=0" -TimeoutSec 6
} catch {
  throw "El puerto $Puerto responde pero /api/chat no: $($_.Exception.Message)"
}

# 2) Túnel de Cloudflare.
if (Test-Path -LiteralPath $cfOut) { Remove-Item -LiteralPath $cfOut -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath $cfErr) { Remove-Item -LiteralPath $cfErr -Force -ErrorAction SilentlyContinue }

Write-Host 'Abriendo túnel de Cloudflare ...'
$cf = Start-Process -FilePath $cloudflared `
  -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Puerto", '--no-autoupdate') `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr

$url = $null
$limite = (Get-Date).AddSeconds($EsperaMax)
while ((Get-Date) -lt $limite) {
  Start-Sleep -Milliseconds 500
  $texto = ''
  foreach ($f in @($cfOut, $cfErr)) {
    if (Test-Path -LiteralPath $f) {
      try { $texto += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) + "`n" } catch { }
    }
  }
  $m = [regex]::Match($texto, $urlRegex)
  if ($m.Success) { $url = $m.Value; break }
  if ($cf.HasExited) { break }
}

if (-not $url) {
  if (-not $cf.HasExited) { Stop-Process -Id $cf.Id -Force -ErrorAction SilentlyContinue }
  $cola = Leer-Log -Rutas @($cfErr, $cfOut) -Lineas 30
  throw "No encontré la URL trycloudflare en $EsperaMax s.`n$cola"
}

# 3) live.json + estado del proceso.
Escribir-LiveJson -EnVivo $true -Url $url
$estado = [ordered]@{
  cloudflared_pid = $cf.Id
  gateway_pid     = $gwPid
  url             = $url
  puerto          = $Puerto
  iniciado        = (Get-Date).ToString('o')
}
$estado | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8

Write-Host ''
Write-Host "EN VIVO: $url" -ForegroundColor Green
Write-Host "live.json: $liveJson"
Write-Host "Log del túnel: $cfErr"

# 4) Publicación opcional.
if ($Publicar) {
  Publicar-Live
} else {
  Write-Host ''
  Write-Host 'Para publicar la URL en GitHub Pages:'
  Write-Host "  pwsh -File `"$PSCommandPath`" -Publicar"
}
