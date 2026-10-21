#Requires -Version 7.0
<#
  check-sync.ps1 - Comprueba que las TRES caras del show sirven lo mismo.

    1) localhost   reports\wb-match\      (lo sirve 20-wb-viewer-server.ps1 en 8765)
    2) GitHub /live/  worldbox-ai-show\live\
    3) GitHub show /  worldbox-ai-show\demo\   (repeticion; index.html a mano)

  La fuente de verdad es scripts\. Sale con codigo 2 si algo esta desincronizado.

  Uso:
    pwsh -NoProfile -File scripts\check-sync.ps1
    pwsh -NoProfile -File scripts\check-sync.ps1 -Remoto   # ademas mira GitHub Pages
#>
[CmdletBinding()]
param([switch]$Remoto)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Origen = $PSScriptRoot
$Raiz = Split-Path -Parent $Origen
$Local = Join-Path $Raiz 'reports\wb-match'
$Live = Join-Path $Raiz 'worldbox-ai-show\live'
$Demo = Join-Path $Raiz 'worldbox-ai-show\demo'
$RepoScripts = Join-Path $Raiz 'worldbox-ai-show\scripts'

$fallos = 0
$ok = 0
function Bien { param([string]$t) Write-Host ("  OK   " + $t) -ForegroundColor Green; $script:ok++ }
function Mal { param([string]$t) Write-Host ("  MAL  " + $t) -ForegroundColor Red; $script:fallos++ }
function Aviso { param([string]$t) Write-Host ("  ?    " + $t) -ForegroundColor Yellow }

function Sha([string]$ruta) {
  if (-not (Test-Path -LiteralPath $ruta)) { return $null }
  return (Get-FileHash -LiteralPath $ruta -Algorithm SHA256).Hash
}
function Iguales { param([string]$a, [string]$b) (Sha $a) -ne $null -and (Sha $a) -eq (Sha $b) }

Write-Host ''
Write-Host '== 1/5  Modulos compartidos: scripts -> localhost (reports\wb-match)' -ForegroundColor Cyan
# El visor se sirve con otro nombre en local.
$paresLocal = @(
  @{ S = 'viewer-live.html'; D = 'viewer.html' },
  @{ S = 'viewer-fx.js'; D = 'viewer-fx.js' },
  @{ S = 'viewer-voice.js'; D = 'viewer-voice.js' },
  @{ S = 'show-music.js'; D = 'show-music.js' },
  @{ S = 'show-audio-ui.js'; D = 'show-audio-ui.js' }
)
foreach ($p in $paresLocal) {
  $a = Join-Path $Origen $p.S
  $b = Join-Path $Local $p.D
  if (Iguales $a $b) { Bien "$($p.S) -> reports\wb-match\$($p.D)" }
  else { Mal "$($p.S) != reports\wb-match\$($p.D)  (localhost desincronizado)" }
}

Write-Host ''
Write-Host '== 2/5  Modulos compartidos: scripts -> GitHub /live/' -ForegroundColor Cyan
foreach ($f in @('viewer-fx.js', 'viewer-voice.js', 'show-music.js', 'show-audio-ui.js')) {
  $a = Join-Path $Origen $f
  $b = Join-Path $Live $f
  if (Iguales $a $b) { Bien "$f -> live\$f" }
  else { Mal "$f != live\$f  (/live/ desincronizado)" }
}

Write-Host ''
Write-Host '== 3/5  live\index.html == viewer-live.html + bloque inyectado' -ForegroundColor Cyan
$htmlSrc = Join-Path $Origen 'viewer-live.html'
$htmlLive = Join-Path $Live 'index.html'
if ((Test-Path -LiteralPath $htmlSrc) -and (Test-Path -LiteralPath $htmlLive)) {
  $src = [System.IO.File]::ReadAllText($htmlSrc)
  $out = [System.IO.File]::ReadAllText($htmlLive)
  # build-live-page.ps1 inserta "`n" + <script>...build-live-page...</script> tras <body>.
  $re = [regex]::new("(?s)\r?\n<script>\r?\n/\* build-live-page:.*?</script>")
  $limpio = $re.Replace($out, '', 1)
  if ($limpio -eq $src) { Bien 'live/index.html generado del visor actual' }
  else {
    # Da una pista util: puede ser solo fin de linea.
    $a = ($src -replace "`r`n", "`n"); $b = ($limpio -replace "`r`n", "`n")
    if ($a -eq $b) { Bien 'live/index.html generado del visor actual (solo difiere el fin de linea)' }
    else { Mal 'live/index.html NO coincide con el visor canonico (republicar)' }
  }
  if ($out -notmatch '__WB_ENDPOINTS_READY__') { Mal 'live/index.html no tiene el bloque de arranque' }
} else { Mal 'falta viewer-live.html o live/index.html' }

Write-Host ''
Write-Host '== 4/5  Repositorio: scripts\ -> worldbox-ai-show\scripts\' -ForegroundColor Cyan
$whitelist = @(
  '18-wb-multi.ps1', '19-wb-match.ps1', '20-wb-viewer-server.ps1', '21-drama.ps1',
  '22-director.ps1', '23-drama-llm.mjs', '24-wb-stream.ps1', '25-live-gateway.mjs',
  '26-live-publish.ps1', 'build-live-page.ps1', 'publish-show.ps1', 'check-sync.ps1',
  'viewer-live.html', 'viewer-fx.js', 'viewer-voice.js', 'show-music.js',
  'show-audio-ui.js', 'tts-server.mjs', 'voz-engine.py', 'build-voice-pack.ps1',
  'sync-repo.ps1'
)
$desinc = @()
foreach ($f in $whitelist) {
  $a = Join-Path $Origen $f
  $b = Join-Path $RepoScripts $f
  if (-not (Test-Path -LiteralPath $a)) { continue }
  if (-not (Iguales $a $b)) { $desinc += $f }
}
if ($desinc.Count -eq 0) { Bien "los $($whitelist.Count) ficheros del repo estan al dia" }
else { Mal ("pendientes de sync-repo: " + ($desinc -join ', ')) }

Write-Host ''
Write-Host '== 5/5  Pagina show (demo\)' -ForegroundColor Cyan
$demoHtml = Join-Path $Demo 'index.html'
if (Test-Path -LiteralPath $demoHtml) {
  $d = [System.IO.File]::ReadAllText($demoHtml)
  if ($d -match 'emocion:\s*emocionDeEvento\(ev\)') { Bien 'demo/index.html pasa la emocion a la voz' }
  else { Mal 'demo/index.html NO pasa la emocion a la voz (voces planas)' }
  if ($d -match '\.\./live/viewer-voice\.js') { Bien 'demo/index.html carga ../live/viewer-voice.js' }
  else { Aviso 'demo/index.html no carga el modulo de voz de ../live/' }
  if ($d -match '\.\./live/viewer-fx\.js') { Bien 'demo/index.html carga ../live/viewer-fx.js' }
  else { Aviso 'demo/index.html no carga el modulo de FX de ../live/' }
} else { Mal 'no existe demo/index.html' }

$vozJson = Join-Path $Demo 'voz\voz.json'
$health = $null
try { $health = Invoke-RestMethod 'http://127.0.0.1:8771/health' -TimeoutSec 3 } catch { }
if (Test-Path -LiteralPath $vozJson) {
  try {
    $vj = Get-Content -LiteralPath $vozJson -Raw -Encoding utf8 | ConvertFrom-Json
    $motorPack = [string]$vj.motor
    $motorVivo = ''
    if ($null -ne $health) { try { $motorVivo = [string]$health.motorVersion } catch { } }
    if ($motorVivo) {
      if ($motorPack -eq $motorVivo) { Bien ("pack de voces al dia (motor {0})" -f $motorPack) }
      else { Mal ("pack de voces {0} != motor vivo {1} (regenerar)" -f $motorPack, $motorVivo) }
    } else {
      Aviso ("pack de voces motor={0} (servicio 8771 apagado: no se puede comparar)" -f $motorPack)
    }
  } catch { Aviso 'demo\voz\voz.json ilegible' }
} else { Mal 'no existe demo\voz\voz.json (la repeticion iria con voces del navegador)' }

if ($Remoto) {
  Write-Host ''
  Write-Host '== extra  GitHub Pages publicado' -ForegroundColor Cyan
  $base = 'https://lamkone.github.io/worldbox-ai-show'
  $tmp = Join-Path $env:TEMP ('checksync-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $mapa = [ordered]@{
      '/live/viewer-voice.js' = (Join-Path $Live 'viewer-voice.js')
      '/live/viewer-fx.js'    = (Join-Path $Live 'viewer-fx.js')
      '/live/show-music.js'   = (Join-Path $Live 'show-music.js')
      '/live/show-audio-ui.js' = (Join-Path $Live 'show-audio-ui.js')
      '/'                     = $demoHtml
    }
    foreach ($k in $mapa.Keys) {
      $f = Join-Path $tmp (($k -replace '[\\/]', '_') + '.bin')
      try {
        Invoke-WebRequest -Uri ($base + $k) -OutFile $f -UseBasicParsing -TimeoutSec 25 | Out-Null
        if (Iguales $f $mapa[$k]) { Bien "publicado $k == local" }
        else { Mal "publicado $k != local (Pages atrasado o sin publicar)" }
      } catch { Mal "no se pudo leer $k : $($_.Exception.Message)" }
    }
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($fallos -eq 0) {
  Write-Host ("TODO SINCRONIZADO  ({0} comprobaciones OK)" -f $ok) -ForegroundColor Green
} else {
  Write-Host ("{0} OK  ·  {1} FALLOS  -> ejecuta scripts\publish-show.ps1 -Verificar" -f $ok, $fallos) -ForegroundColor Red
  exit 2
}
