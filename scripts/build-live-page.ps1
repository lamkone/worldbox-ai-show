#Requires -Version 7.0
<#
  build-live-page.ps1 - Genera la pagina publica del modo EN VIVO (/live/).

  La base SIEMPRE es el visor canonico del PC (scripts\viewer-live.html +
  scripts\viewer-fx.js). Lo unico que cambia en la copia publicada es como se
  resuelven los endpoints: en el PC el visor habla con localhost:8765/8767, pero
  en GitHub Pages tiene que descubrir la URL del tunel leyendo ../live.json.

  Se inyecta un unico bloque de arranque ANTES que cualquier script del visor:

    window.__WB_AVISO__           HTML del aviso cuando no hay directo
    window.__WB_ENDPOINTS_READY__ promesa -> { base, streamBase }

  El visor v3 espera esa promesa (si existe) antes de lanzar los sondeos:
    * servido desde *.trycloudflare.com  -> mismo origen
    * cualquier otro origen (Pages)      -> ../live.json -> url del tunel
    * sin directo                        -> base:'' (estado SIN_SENAL + aviso)

  Uso:
    pwsh -File scripts\build-live-page.ps1              # escribe worldbox-ai-show\live
    pwsh -File scripts\build-live-page.ps1 -Destino C:\tmp\live   # otra carpeta
    pwsh -File scripts\build-live-page.ps1 -Check       # solo comprueba el origen

  Despues: sync-repo.ps1, commit y push (o 26-live-publish.ps1 -Publicar).
#>
[CmdletBinding()]
param(
  [string]$Origen = $PSScriptRoot,
  [string]$Destino = '',
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $Origen
if ([string]::IsNullOrWhiteSpace($Destino)) { $Destino = Join-Path $raiz 'worldbox-ai-show\live' }
$Destino = [System.IO.Path]::GetFullPath($Destino)

$htmlSrc = Join-Path $Origen 'viewer-live.html'
$fxSrc = Join-Path $Origen 'viewer-fx.js'
$vozSrc = Join-Path $Origen 'viewer-voice.js'
$musSrc = Join-Path $Origen 'show-music.js'
$uiSrc = Join-Path $Origen 'show-audio-ui.js'

foreach ($f in @($htmlSrc, $fxSrc)) {
  if (-not (Test-Path -LiteralPath $f)) { throw "Falta el fichero de origen: $f" }
}
if (-not (Test-Path -LiteralPath $Destino)) { New-Item -ItemType Directory -Force -Path $Destino | Out-Null }

# ---------------------------------------------------------------------------
# 1) Bloque de arranque que se inyecta en el HTML.
#    Ojo con el escapado: es JS dentro de HTML dentro de PowerShell (here-string
#    de comillas simples: no se expande nada, se escribe tal cual).
# ---------------------------------------------------------------------------
$arranque = @'
<script>
/* build-live-page: resuelve el backend del directo ANTES de arrancar el visor.
   Generado automaticamente desde scripts/viewer-live.html; no editar a mano. */
window.__WB_AVISO__ = '<b>El directo está apagado ahora mismo.</b> Puedes <a href="../">ver la última repetición</a> mientras vuelve.';
window.__WB_ENDPOINTS_READY__ = (async function () {
  var host = (location.hostname || '').toLowerCase();
  // servido por el propio tunel: todo en el mismo origen
  if (/\.trycloudflare\.com$/.test(host)) {
    return { base: location.origin, streamBase: location.origin };
  }
  // GitHub Pages (o cualquier origen estatico): el tunel esta en ../live.json
  try {
    var r = await fetch('../live.json?ts=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      var j = await r.json();
      if (j && j.en_vivo && j.url) {
        var u = String(j.url).replace(/\/+$/, '');
        // El tunel de Cloudflare es efimero: si live.json se quedo viejo, la URL
        // ya no existe. Comprobamos /health (el gateway manda CORS abierto) para
        // no quedarnos en CONECTANDO eterno: si no responde, modo sin senal.
        try {
          var ctl = new AbortController();
          var t = setTimeout(function () { ctl.abort(); }, 3500);
          var h = await fetch(u + '/health?ts=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
          clearTimeout(t);
          if (h.ok) return { base: u, streamBase: u };
        } catch (e2) { /* tunel caido */ }
      }
    }
  } catch (e) { /* sin live.json o sin red: se queda sin senal */ }
  return { base: '', streamBase: '' };
})();
</script>
'@

# ---------------------------------------------------------------------------
# 2) Leer el visor canonico y validar que se puede transformar.
# ---------------------------------------------------------------------------
$html = Get-Content -LiteralPath $htmlSrc -Raw -Encoding utf8
if ($html -notmatch '(?is)<body[^>]*>') { throw "viewer-live.html no tiene <body>: $htmlSrc" }
if ($html -notmatch 'viewer-fx\.js') { throw "viewer-live.html no referencia viewer-fx.js: el FX no llegaria a /live/" }

if ($Check) {
  $n = ([regex]::Matches($html, 'show-v2')).Count
  Write-Host ("origen OK: {0} ({1} B)  ·  referencias a show-v2: {2}" -f (Split-Path -Leaf $htmlSrc), $html.Length, $n)
  Write-Host ("destino: {0}" -f $Destino)
  return
}

# ---------------------------------------------------------------------------
# 3) Inyectar el bloque justo despues de <body ...> para que exista antes de
#    cualquier script del visor. Si no hubiera body (no deberia), antes de </head>.
# ---------------------------------------------------------------------------
if ($html -match '(?is)<body[^>]*>') {
  $mb = [regex]::Match($html, '(?is)<body[^>]*>')
  $corte = $mb.Index + $mb.Length
  $html = $html.Substring(0, $corte) + "`n" + $arranque + $html.Substring($corte)
} else {
  $mh = [regex]::Match($html, '(?is)</head>')
  if ($mh.Success) {
    $html = $html.Substring(0, $mh.Index) + $arranque + "`n" + $html.Substring($mh.Index)
  } else {
    throw 'No encuentro ni <body> ni </head> en viewer-live.html.'
  }
}

# ---------------------------------------------------------------------------
# 4) Escribir la pagina, el motor de FX y el modulo de voz junto a ella (rutas relativas).
# ---------------------------------------------------------------------------
$htmlOut = Join-Path $Destino 'index.html'
$fxOut = Join-Path $Destino 'viewer-fx.js'
$vozOut = Join-Path $Destino 'viewer-voice.js'

# UTF-8 sin BOM: el HTML del visor ya declara <meta charset="utf-8">.
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($htmlOut, $html, $utf8)
Copy-Item -LiteralPath $fxSrc -Destination $fxOut -Force

$szHtml = (Get-Item -LiteralPath $htmlOut).Length
$szFx = (Get-Item -LiteralPath $fxOut).Length
Write-Host ("live/index.html    {0,8:N0} B" -f $szHtml)
Write-Host ("live/viewer-fx.js  {0,8:N0} B" -f $szFx)
if (Test-Path -LiteralPath $vozSrc) {
  Copy-Item -LiteralPath $vozSrc -Destination $vozOut -Force
  Write-Host ("live/viewer-voice.js {0,6:N0} B" -f (Get-Item -LiteralPath $vozOut).Length)
} elseif ($html -match 'viewer-voice\.js') {
  Write-Warning 'viewer-live.html referencia viewer-voice.js pero scripts\viewer-voice.js no existe: /live/ se quedaria sin voz.'
} else {
  Write-Host 'live/viewer-voice.js  (no hay modulo de voz todavia)'
}

# Modulos de audio (musica procedural + panel de volumen). Opcionales: si el visor
# aun no los referencia se copian igual, para que la publicacion no dependa de ello.
foreach ($par in @(@{ Src = $musSrc; Nom = 'show-music.js' }, @{ Src = $uiSrc; Nom = 'show-audio-ui.js' })) {
  if (Test-Path -LiteralPath $par.Src) {
    $dst = Join-Path $Destino $par.Nom
    Copy-Item -LiteralPath $par.Src -Destination $dst -Force
    Write-Host ("live/{0} {1,8:N0} B" -f $par.Nom, (Get-Item -LiteralPath $dst).Length)
  } elseif ($html -match [regex]::Escape($par.Nom)) {
    Write-Warning ("viewer-live.html referencia {0} pero scripts\{0} no existe." -f $par.Nom)
  }
}

# ---------------------------------------------------------------------------
# 5) Verificacion rapida del resultado: el bloque tiene que estar antes de los
#    scripts del visor y la pagina tiene que seguir siendo autonoma.
# ---------------------------------------------------------------------------
$out = Get-Content -LiteralPath $htmlOut -Raw -Encoding utf8
$posArranque = $out.IndexOf('__WB_ENDPOINTS_READY__')
$posFx = $out.IndexOf('viewer-fx.js')
$posMain = $out.IndexOf('resolverBase')   # puede no existir en la v3: no es error
if ($posArranque -lt 0) { throw 'El bloque de arranque no llego al HTML final.' }
if ($posFx -lt 0) { throw 'La pagina final no referencia viewer-fx.js.' }
if ($posMain -ge 0 -and $posMain -lt $posArranque) { Write-Warning 'Hay un resolverBase antes del bloque de arranque: revisa el orden.' }
$m = [regex]::Match($out, '__WB_ENDPOINTS_READY__')
Write-Host ("inyectado en la linea {0}" -f ($out.Substring(0, $m.Index).Split("`n").Count))
Write-Host 'OK: pagina publica generada.'
