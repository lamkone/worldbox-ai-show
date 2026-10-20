<#
20-wb-viewer-server.ps1 - Servidor local mínimo para el visor en vivo de WorldBox.

Sirve desde http://localhost:8765/ :
  /               viewer.html (plantilla con JS que se conecta sola)
  /state.json     marcador, ronda, turno, histórico (lo escribe 19-wb-match.ps1)
  /feed.json      comentarios y acciones (lo escribe 19-wb-match.ps1)
  /frame.jpg      captura del mundo; con ?live=1 la pide al bridge al momento
  /health         "ok"

Uso:
  pwsh -File 20-wb-viewer-server.ps1            # puerto 8765
  pwsh -File 20-wb-viewer-server.ps1 -Port 9000 -Dir C:\ruta\salida

Se puede dejar corriendo en segundo plano: el visor se actualiza solo cuando
hay partida en marcha y sigue mostrando el último estado cuando acaba.
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [string]$Dir = '',
  [int]$AnchoCaptura = 900
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '18-wb-multi.ps1')
# por defecto sirve <repo>/reports/wb-match (el motor vive en <repo>/scripts)
if (-not $Dir) { $Dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'reports\wb-match' }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$script:UltimaCaptura = [datetime]::MinValue
$script:Frame = Join-Path $Dir 'frame.jpg'

function Send-Respuesta {
  param($Res, [int]$Codigo, [byte[]]$Bytes, [string]$Tipo)
  try {
    $Res.StatusCode = $Codigo
    $Res.ContentType = $Tipo
    $Res.Headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    # permite que la pagina abierta como fichero (file://) lea del servidor
    $Res.Headers['Access-Control-Allow-Origin'] = '*'
    $Res.ContentLength64 = $Bytes.Length
    $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
  } catch { }
  finally { try { $Res.OutputStream.Close() } catch { } }
}

function Send-Archivo {
  param($Res, [string]$Ruta, [string]$Tipo)
  if (-not (Test-Path -LiteralPath $Ruta)) {
    Send-Respuesta -Res $Res -Codigo 404 -Bytes ([Text.Encoding]::UTF8.GetBytes('404')) -Tipo 'text/plain; charset=utf-8'
    return
  }
  # FileShare.ReadWrite: el motor escribe estos ficheros mientras se sirven.
  # Si aun asi esta bloqueado un instante, reintenta; nunca tumba el servidor.
  $b = $null
  for ($i = 0; $i -lt 10; $i++) {
    try {
      $fs = [IO.FileStream]::new($Ruta, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      $ms = New-Object IO.MemoryStream
      $fs.CopyTo($ms)
      $fs.Dispose()
      $b = $ms.ToArray()
      $ms.Dispose()
      break
    } catch { Start-Sleep -Milliseconds 40 }
  }
  if ($null -eq $b) {
    Send-Respuesta -Res $Res -Codigo 503 -Bytes ([Text.Encoding]::UTF8.GetBytes('503')) -Tipo 'text/plain; charset=utf-8'
    return
  }
  Send-Respuesta -Res $Res -Codigo 200 -Bytes $b -Tipo $Tipo
}

# Pide una captura nueva al bridge y la guarda en frame.jpg.
# En modo video (-Rapida) el minimo entre capturas baja a ~90 ms (~11 fps).
function Update-Captura {
  param([switch]$Rapida, [int]$Ancho = 0)
  $minimo = if ($Rapida) { 0.09 } else { 1.2 }
  if (((Get-Date) - $script:UltimaCaptura).TotalSeconds -lt $minimo) { return }
  $script:UltimaCaptura = Get-Date
  if ($Ancho -le 0) { $Ancho = $AnchoCaptura }
  $Ancho = [math]::Max(400, [math]::Min(1920, $Ancho))
  try {
    $sc = Invoke-WbAgent -Agent rojo -Name 'screenshot' -A @{ max_width = $Ancho } -TimeoutSec 25
    if ($sc.ok -and $sc.result.base64) {
      [IO.File]::WriteAllBytes($script:Frame, [Convert]::FromBase64String($sc.result.base64))
    }
  } catch { }
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.IgnoreWriteExceptions = $true
try {
  $listener.Start()
} catch {
  Write-Output ('ERROR: no pude abrir el puerto ' + $Port + ': ' + $_.Exception.Message)
  Write-Output 'Prueba otro puerto con -Port 8766, o comprueba que no haya otro visor ya corriendo.'
  exit 1
}

$pidFile = Join-Path $Dir 'visor.pid'
Set-Content -Path $pidFile -Value $PID -Encoding ASCII

Write-Output ('visor en vivo: http://localhost:' + $Port + '/')
Write-Output ('sirviendo: ' + $Dir)
Write-Output ('para pararlo: Stop-Process -Id ' + $PID)

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch {
    break
  }
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $ruta = $req.Url.AbsolutePath
    $live = ($req.Url.Query -like '*live=1*')
    if ($req.HttpMethod -eq 'OPTIONS') {
      try {
        $res.StatusCode = 204
        $res.Headers['Access-Control-Allow-Origin'] = '*'
        $res.Headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        $res.Headers['Access-Control-Allow-Headers'] = '*'
        $res.OutputStream.Close()
      } catch { }
      continue
    }
    switch ($ruta) {
      '/' { Send-Archivo -Res $res -Ruta (Join-Path $Dir 'viewer.html') -Tipo 'text/html; charset=utf-8' }
      '/index.html' { Send-Archivo -Res $res -Ruta (Join-Path $Dir 'viewer.html') -Tipo 'text/html; charset=utf-8' }
      '/state.json' { Send-Archivo -Res $res -Ruta (Join-Path $Dir 'state.json') -Tipo 'application/json; charset=utf-8' }
      '/feed.json' { Send-Archivo -Res $res -Ruta (Join-Path $Dir 'feed.json') -Tipo 'application/json; charset=utf-8' }
      '/frame.jpg' {
        $ancho = 0
        if ($req.Url.Query -match 'w=(\d+)') { $ancho = [int]$matches[1] }
        if ($live) { Update-Captura -Rapida -Ancho $ancho }
        Send-Archivo -Res $res -Ruta $script:Frame -Tipo 'image/jpeg'
      }
      '/health' { Send-Respuesta -Res $res -Codigo 200 -Bytes ([Text.Encoding]::UTF8.GetBytes('ok')) -Tipo 'text/plain; charset=utf-8' }
      default {
        # Estáticos del visor: el visor puede partirse en varios ficheros
        # (viewer-fx.js, hojas de estilo, imágenes). Solo se sirven extensiones
        # conocidas y siempre dentro de $Dir (nada de ..\..\).
        $rel = $ruta.TrimStart('/')
        $mimes = @{
          '.js' = 'application/javascript; charset=utf-8'; '.mjs' = 'application/javascript; charset=utf-8'
          '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
          '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
          '.svg' = 'image/svg+xml'; '.webp' = 'image/webp'; '.woff2' = 'font/woff2'
          '.html' = 'text/html; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
        }
        $ext = [IO.Path]::GetExtension($rel).ToLowerInvariant()
        $destino = $null
        if ($rel -and $mimes.ContainsKey($ext) -and $rel -notmatch '(^|[\\/])\.\.([\\/]|$)') {
          $cand = Join-Path $Dir $rel
          try {
            $full = [IO.Path]::GetFullPath($cand)
            $raiz = [IO.Path]::GetFullPath($Dir)
            if ($full.StartsWith($raiz, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
              $destino = $full
            }
          } catch { }
        }
        if ($destino) {
          Send-Archivo -Res $res -Ruta $destino -Tipo $mimes[$ext]
        } else {
          Send-Respuesta -Res $res -Codigo 404 -Bytes ([Text.Encoding]::UTF8.GetBytes('404')) -Tipo 'text/plain; charset=utf-8'
        }
      }
    }
  } catch {
    try { Send-Respuesta -Res $res -Codigo 500 -Bytes ([Text.Encoding]::UTF8.GetBytes('error')) -Tipo 'text/plain; charset=utf-8' } catch { }
  }
}

$listener.Stop()
Write-Output 'visor detenido.'
