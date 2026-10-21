# Sincroniza los scripts del show desde el árbol de trabajo al repo publicable
# (worldbox-ai-show/scripts). No copia secretos: agents.local.json está ignorado
# por git y se queda donde está.
#
#   pwsh -NoProfile -File scripts\sync-repo.ps1          # copia
#   pwsh -NoProfile -File scripts\sync-repo.ps1 -Check   # solo informa
param([switch]$Check)

$ErrorActionPreference = 'Stop'

$Origen = $PSScriptRoot
$Raiz = Split-Path -Parent $Origen
$Destino = Join-Path $Raiz 'worldbox-ai-show\scripts'

# Ficheros que forman el show. Todo lo que el repo necesita para reproducirlo.
$ficheros = @(
  '18-wb-multi.ps1'          # cliente del bridge (tokens desde agents.local.json)
  '19-wb-match.ps1'          # motor de la partida
  '20-wb-viewer-server.ps1'  # servidor estático del visor (8765)
  '21-drama.ps1'             # drama procedural de respaldo
  '22-director.ps1'          # director: moral, tensión, beats, titulares
  '23-drama-llm.mjs'         # cerebro LLM (8766)
  '24-wb-stream.ps1'         # captura nativa de la ventana + MJPEG (8767)
  '25-live-gateway.mjs'      # pasarela del modo EN VIVO (8770)
  '26-live-publish.ps1'      # tunel cloudflared + live.json
  'build-live-page.ps1'      # genera /live/ desde el visor canonico
  'publish-show.ps1'         # sync + build + commit + push + verificacion
  'viewer-live.html'         # visor
  'viewer-fx.js'             # capa de efectos del visor
  'viewer-voice.js'          # voces del show: neuronal (edge-tts) + respaldo navegador
  'show-music.js'            # musica procedural (WebAudio) del show
  'show-audio-ui.js'         # panel de volumen (voz / musica / efectos)
  'tts-server.mjs'           # servicio local de voz neuronal (8771)
  'voz-engine.py'            # motor de voz v9 (Kokoro + edge) que usa tts-server.mjs
  'chatterbox-worker.py'     # worker de Chatterbox (v9.7): motor del pack de la repeticion
  'build-voice-pack.ps1'     # pack de voces pregrabadas de la repeticion (demo\voz)
  'sync-repo.ps1'            # esta herramienta: copia los scripts al repo
  'check-sync.ps1'           # comprueba que las 3 caras del show sirven lo mismo
)

# Carpetas que viajan con los scripts (se copian fichero a fichero).
# voz-refs: las 4 voces de referencia (wav) que clona Chatterbox; sin ellas no se
# puede regenerar el pack de la repeticion en una instalacion limpia.
$carpetas = @('voz-refs')

if (-not (Test-Path $Destino)) { throw "No existe el destino: $Destino" }

$cambios = 0
$faltan = 0
foreach ($f in $ficheros) {
  $src = Join-Path $Origen $f
  $dst = Join-Path $Destino $f
  if (-not (Test-Path $src)) { Write-Warning "falta en origen: $f"; $faltan++; continue }
  $igual = $false
  if (Test-Path $dst) {
    $igual = (Get-FileHash $src -Algorithm SHA256).Hash -eq (Get-FileHash $dst -Algorithm SHA256).Hash
  }
  if ($igual) { Write-Host ("  = {0}" -f $f); continue }
  if ($Check) { Write-Host ("  ~ {0}  (distinto)" -f $f); $cambios++; continue }
  Copy-Item $src $dst -Force
  $sz = (Get-Item $dst).Length
  Write-Host ("  + {0}  ({1} B)" -f $f, $sz)
  $cambios++
}

foreach ($c in $carpetas) {
  $srcDir = Join-Path $Origen $c
  if (-not (Test-Path $srcDir)) { Write-Warning "falta en origen: $c\"; $faltan++; continue }
  $dstDir = Join-Path $Destino $c
  if (-not (Test-Path $dstDir)) { if (-not $Check) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null } }
  foreach ($src in (Get-ChildItem -LiteralPath $srcDir -File)) {
    $dst = Join-Path $dstDir $src.Name
    $igual = $false
    if (Test-Path $dst) {
      $igual = (Get-FileHash $src.FullName -Algorithm SHA256).Hash -eq (Get-FileHash $dst -Algorithm SHA256).Hash
    }
    if ($igual) { Write-Host ("  = {0}/{1}" -f $c, $src.Name); continue }
    if ($Check) { Write-Host ("  ~ {0}/{1}  (distinto)" -f $c, $src.Name); $cambios++; continue }
    Copy-Item $src.FullName $dst -Force
    Write-Host ("  + {0}/{1}  ({2} B)" -f $c, $src.Name, $src.Length)
    $cambios++
  }
}

Write-Host ''
if ($Check) {
  Write-Host ("Pendientes de copiar: {0}   ·   ausentes: {1}" -f $cambios, $faltan)
  if ($cambios -gt 0) { exit 2 }
} else {
  Write-Host ("Copiados: {0}   ·   ausentes: {1}" -f $cambios, $faltan)
}
