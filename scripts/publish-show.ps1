#Requires -Version 7.0
<#
  publish-show.ps1 - Un solo comando para llevar el show de la maquina a GitHub.

  Hace, en orden:
    1) sync-repo.ps1        copia los scripts canonicos a worldbox-ai-show\scripts
    2) build-live-page.ps1  genera worldbox-ai-show\live\index.html desde el visor
    3) copia el visor nuevo a reports\wb-match (para verlo en local en 8765)
       y el show.json de la ultima partida a demo\ (repeticion real)
    4) [opcional -ConDirecto] abre el tunel y escribe live.json
    5) commit + push a main con el token (Pages despliega solo con el push)
    6) [opcional -Verificar] espera a que GitHub Pages sirva la pagina nueva

  Ejemplos:
    pwsh -File scripts\publish-show.ps1                          # publica sin tocar el directo
    pwsh -File scripts\publish-show.ps1 -ConDirecto -Verificar   # ademas abre tunel y comprueba Pages
    pwsh -File scripts\publish-show.ps1 -Mensaje 'show: visor v3' -NoPush   # solo prepara
#>
[CmdletBinding()]
param(
  [string]$Mensaje = 'show: actualizar visor y repeticion',
  [switch]$NoPush,
  [switch]$ConDirecto,
  [switch]$Verificar,
  [int]$EsperaPagesSeg = 150,
  [string]$Repo = '',
  [string]$TokenFile = 'C:\Users\nebula\.dsh\github-token-worldbox.txt'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = Join-Path $raiz 'worldbox-ai-show' }
$Repo = [System.IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) { throw "No es un repositorio git: $Repo" }

function Paso { param([string]$T) Write-Host ''; Write-Host ("== " + $T) -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
Paso '1/6  Sincronizar scripts al repo'
& (Join-Path $PSScriptRoot 'sync-repo.ps1')

Paso '2/6  Construir la pagina /live/'
& (Join-Path $PSScriptRoot 'build-live-page.ps1') -Destino (Join-Path $Repo 'live')

Paso '3/6  Copiar el visor nuevo al servidor local (8765)'
$servido = Join-Path $raiz 'reports\wb-match'
New-Item -ItemType Directory -Force -Path $servido | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'viewer-live.html') -Destination (Join-Path $servido 'viewer.html') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'viewer-fx.js') -Destination (Join-Path $servido 'viewer-fx.js') -Force
foreach ($extra in @('viewer-voice.js', 'show-music.js', 'show-audio-ui.js')) {
  $srcExtra = Join-Path $PSScriptRoot $extra
  if (Test-Path -LiteralPath $srcExtra) { Copy-Item -LiteralPath $srcExtra -Destination (Join-Path $servido $extra) -Force }
}
Write-Host '  visor local actualizado en reports\wb-match'

# La repeticion publica reproduce la ultima partida real: su show.json viaja con el demo.
$showReal = Join-Path $servido 'show.json'
$demoDir = Join-Path $Repo 'demo'
if ((Test-Path -LiteralPath $showReal) -and (Test-Path -LiteralPath $demoDir)) {
  Copy-Item -LiteralPath $showReal -Destination (Join-Path $demoDir 'show.json') -Force
  Write-Host ('  repeticion: show.json real copiado a demo\ ({0:N0} B)' -f (Get-Item -LiteralPath $showReal).Length)
} else {
  Write-Host '  repeticion: sin show.json real; el demo usara su dataset embebido'
}

# Pack de voces neuronales de la repeticion: sintetiza las frases del show a MP3
# (voz\<seq>.mp3 + voz\voz.json) para que GitHub Pages suene natural sin servidor.
# Si el servicio de voz no esta arrancado se avisa y se publica sin pack (el demo
# cae a las voces del navegador, pero no se rompe).
$vozDir = Join-Path $demoDir 'voz'
$vozOk = $false
try {
  $saludVoz = Invoke-RestMethod 'http://127.0.0.1:8771/health' -TimeoutSec 3
  $vozViva = $false
  if ($null -ne $saludVoz -and $saludVoz.PSObject.Properties['ok']) { $vozViva = [bool]$saludVoz.ok }
  if ($vozViva) {
    & (Join-Path $PSScriptRoot 'build-voice-pack.ps1') -ShowJson $showReal -OutDir $vozDir -Servicio 'http://127.0.0.1:8771'
    # $LASTEXITCODE solo existe si en este proceso se ha ejecutado algun .exe;
    # leerlo a secas revienta bajo Set-StrictMode.
    $codigoVoz = 0
    if (Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue) { $codigoVoz = [int]$LASTEXITCODE }
    $vozOk = ($codigoVoz -eq 0)
    Write-Host ('  voces: pack generado en demo\voz ({0} MP3)' -f (Get-ChildItem -LiteralPath $vozDir -Filter '*.mp3' -File -ErrorAction SilentlyContinue).Count)
  }
} catch {
  Write-Host ('  AVISO: servicio de voz no disponible; la repeticion usara voces del navegador: ' + $_.Exception.Message) -ForegroundColor Yellow
}
if (-not $vozOk -and -not (Test-Path -LiteralPath (Join-Path $vozDir 'voz.json'))) {
  Write-Host '  voces: sin pack (demo\voz\voz.json no existe)' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
if ($ConDirecto) {
  Paso '4/6  Abrir el directo (tunel + live.json)'
  try {
    & (Join-Path $PSScriptRoot '26-live-publish.ps1')
    # Comprobacion real: que live.json haya quedado EN VIVO con URL de tunel.
    $lj = Join-Path $Repo 'live.json'
    $okTunel = $false
    if (Test-Path -LiteralPath $lj) {
      try {
        $j = Get-Content -LiteralPath $lj -Raw -Encoding UTF8 | ConvertFrom-Json
        $okTunel = [bool]($j.en_vivo -and $j.url -and ($j.url -match 'trycloudflare\.com'))
      } catch { $okTunel = $false }
    }
    if (-not $okTunel) { throw 'live.json no quedo con una URL de tunel valida.' }
  } catch {
    Write-Host ("  AVISO: no se pudo abrir el tunel: " + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host '  Se publica igualmente con el directo APAGADO (en_vivo=false).' -ForegroundColor Yellow
    $apagado = [ordered]@{ en_vivo = $false; url = ''; actualizado = (Get-Date).ToString('o') }
    ($apagado | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $Repo 'live.json') -Encoding UTF8
  }
} else {
  Paso '4/6  Directo: sin cambios (usa -ConDirecto para abrir tunel)'
  # Red de seguridad: nunca dejar en_vivo=true si el tunel de live.json no responde.
  $lj = Join-Path $Repo 'live.json'
  if (Test-Path -LiteralPath $lj) {
    try {
      $j = Get-Content -LiteralPath $lj -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.en_vivo -and $j.url) {
        $vivo = $false
        try {
          $h = Invoke-WebRequest -Uri ($j.url.TrimEnd('/') + '/health') -UseBasicParsing -TimeoutSec 4
          $vivo = ($h.StatusCode -eq 200)
        } catch { $vivo = $false }
        if (-not $vivo) {
          $apagado = [ordered]@{ en_vivo = $false; url = ''; actualizado = (Get-Date).ToString('o') }
          ($apagado | ConvertTo-Json) | Set-Content -LiteralPath $lj -Encoding UTF8
          Write-Host '  live.json decia EN VIVO pero el tunel no responde: marcado en_vivo=false.' -ForegroundColor Yellow
        } else {
          Write-Host '  live.json EN VIVO y el tunel responde: se mantiene.'
        }
      }
    } catch { Write-Host '  AVISO: live.json ilegible; se deja como esta.' -ForegroundColor Yellow }
  }
}

# ---------------------------------------------------------------------------
Paso '5/6  Commit y push'
& git -C $Repo add -A
if ($LASTEXITCODE -ne 0) { throw 'git add fallo.' }

& git -C $Repo diff --cached --quiet
$hayCambios = ($LASTEXITCODE -ne 0)
if (-not $hayCambios) {
  Write-Host '  No hay cambios que publicar.'
} else {
  & git -C $Repo -c user.name='WorldBox Show' -c user.email='show@worldbox.local' commit -m $Mensaje
  if ($LASTEXITCODE -ne 0) { throw 'git commit fallo.' }
  Write-Host ("  commit: {0}" -f $Mensaje)
}

if ($NoPush) {
  Write-Host '  -NoPush: no se empuja nada.'
  return
}

if (-not (Test-Path -LiteralPath $TokenFile)) { throw "No existe el fichero de token: $TokenFile" }
$tok = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($tok)) { throw 'El token de GitHub esta vacio.' }

$pushUrl = "https://x-access-token:$tok@github.com/lamkone/worldbox-ai-show.git"
$salida = & git -C $Repo -c credential.helper= -c http.extraheader= push $pushUrl 'HEAD:refs/heads/main' 2>&1 | Out-String
$codigo = $LASTEXITCODE
$salida = $salida -replace [regex]::Escape($tok), '***'
if ($salida.Trim()) { Write-Host $salida.Trim() }
if ($codigo -ne 0) { throw "git push fallo (codigo $codigo)." }
Write-Host '  push OK -> main'

# ---------------------------------------------------------------------------
if ($Verificar) {
  Paso ("6/6  Verificar GitHub Pages (hasta {0}s)" -f $EsperaPagesSeg)
  $urlLive = 'https://lamkone.github.io/worldbox-ai-show/live/'
  $urlDemo = 'https://lamkone.github.io/worldbox-ai-show/'
  $limite = (Get-Date).AddSeconds($EsperaPagesSeg)
  $okLive = $false
  $okDemo = $false
  while ((Get-Date) -lt $limite) {
    Start-Sleep -Seconds 6
    if (-not $okLive) {
      try {
        $r = Invoke-WebRequest -Uri ($urlLive + '?v=' + [guid]::NewGuid().ToString('N').Substring(0, 8)) -UseBasicParsing -TimeoutSec 20
        if ($r.StatusCode -eq 200 -and $r.Content -match '__WB_ENDPOINTS_READY__') { $okLive = $true }
      } catch { }
    }
    if (-not $okDemo) {
      try {
        $r2 = Invoke-WebRequest -Uri ($urlDemo + '?v=' + [guid]::NewGuid().ToString('N').Substring(0, 8)) -UseBasicParsing -TimeoutSec 20
        if ($r2.StatusCode -eq 200 -and $r2.Content.Length -gt 50000) { $okDemo = $true }
      } catch { }
    }
    if ($okLive -and $okDemo) { break }
    Write-Host '  ...esperando al despliegue'
  }
  Write-Host ("  /live/  {0}" -f $(if ($okLive) { 'OK (sirve la pagina nueva)' } else { 'PENDIENTE (revisa Actions)' }))
  Write-Host ("  demo    {0}" -f $(if ($okDemo) { 'OK' } else { 'PENDIENTE' }))
  if (-not ($okLive -and $okDemo)) { exit 3 }
} else {
  Paso '6/6  Verificacion omitida (usa -Verificar)'
}

Write-Host ''
Write-Host 'Publicado. URLs:' -ForegroundColor Green
Write-Host '  https://lamkone.github.io/worldbox-ai-show/'
Write-Host '  https://lamkone.github.io/worldbox-ai-show/live/'
