<#
.SYNOPSIS
    Genera el PACK DE VOCES de la repeticion: sintetiza a MP3 las frases del
    show con las voces neuronales (scripts/tts-server.mjs) para que la pagina
    publicada en GitHub Pages suene natural sin necesitar servidor.

.DESCRIPTION
    Lee el show.json de la partida (por defecto reports\wb-match\show.json),
    sintetiza cada frase de los tipos indicados y deja en la carpeta destino:
        <seq>.mp3          una frase por evento
        voz.json           manifiesto {version, motor, firma, eventos:{seq:{archivo,bytes,agente,emocion}}}
    La firma guarda motor+voces+emociones+post-proceso: si cambia algo, se regenera solo.

    Desde el motor de voz v9 cada frase lleva su EMOCIÓN (burla | enfadado | triste |
    confuso | neutral), la misma que el cerebro dramático eligió para el directo. Se
    manda como &e= al servicio de voz, así la repetición publicada suena igual que el
    directo y no toda en tono neutro.
    El visor/demo cargan voz.json con ViewerVoz.usarPack(base, manifiesto) y
    reproducen el MP3 del evento cuando existe; si falta, caen a la sintesis
    neuronal y luego a las voces del navegador.

.PARAMETER ShowJson
    show.json de la partida (por defecto reports\wb-match\show.json).

.PARAMETER OutDir
    Carpeta destino (por defecto worldbox-ai-show\demo\voz).

.PARAMETER Servicio
    Base del servicio TTS (por defecto http://127.0.0.1:8771).

.PARAMETER Tipos
    Tipos de evento cuyas frases se sintetizan (por defecto 'chat').

.PARAMETER Forzar
    Vuelve a sintetizar aunque el MP3 ya exista.

.EXAMPLE
    pwsh -File scripts\build-voice-pack.ps1
    pwsh -File scripts\build-voice-pack.ps1 -Forzar -Tipos 'chat','titular'
#>
[CmdletBinding()]
param(
    [string]$ShowJson = (Join-Path $PSScriptRoot '..\reports\wb-match\show.json'),
    [string]$OutDir   = (Join-Path $PSScriptRoot '..\worldbox-ai-show\demo\voz'),
    [string]$Servicio = 'http://127.0.0.1:8771',
    [string[]]$Tipos   = @('chat'),
    [switch]$Forzar
)

$ErrorActionPreference = 'Stop'
$Servicio = $Servicio.TrimEnd('/')

function Escribir($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# Lee una propiedad que puede no existir sin romper bajo Set-StrictMode
# (publish-show.ps1 activa StrictMode y este script hereda el modo).
function Prop {
    param($obj, [string]$name, $def = '')
    if ($null -ne $obj -and $obj.PSObject.Properties[$name]) { return $obj.$name }
    return $def
}

if (-not (Test-Path -LiteralPath $ShowJson)) { throw "No existe el show.json: $ShowJson" }
$show = Get-Content -LiteralPath $ShowJson -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $show.eventos) { throw "El show.json no tiene eventos: $ShowJson" }

# Comprueba el servicio de voz antes de empezar (mejor fallar claro que a medias).
try {
    $salud = Invoke-RestMethod ($Servicio + '/health') -TimeoutSec 5
    $quien = ($salud.perfiles.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
    Escribir ("Servicio de voz OK: " + (Prop $salud 'motor') + "  [" + $quien + "]  post=" + (Prop $salud 'postproceso')) 'Green'
    $emSrv = Prop $salud 'emociones' @()
    if ($emSrv) { Escribir ("  emociones: " + ($emSrv -join ', ')) 'Green' }
} catch {
    throw "El servicio de voz no responde en $Servicio. Arrancalo con: node scripts\tts-server.mjs --port 8771"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$eventos = @($show.eventos | Where-Object { $Tipos -contains $_.tipo -and $_.texto })
Escribir ("Frases a sintetizar: " + $eventos.Count + "  (tipos: " + ($Tipos -join ', ') + ")")

$manifiesto = [ordered]@{
    version   = 3
    motor     = [string](Prop $salud 'motorVersion')
    voces     = [ordered]@{
        rojo    = [string](Prop (Prop $salud 'perfiles' $null) 'rojo')
        azul    = [string](Prop (Prop $salud 'perfiles' $null) 'azul')
        sistema = [string](Prop (Prop $salud 'perfiles' $null) 'sistema')
    }
    generado  = (Get-Date).ToString('o')
    origen    = (Split-Path -Leaf $ShowJson)
    tipos     = @($Tipos)
    eventos   = [ordered]@{}
}
# Firma de la CONFIGURACION de voz: si cambian las voces, el motor, las emociones
# o el post-proceso, los MP3 viejos ya no suenan igual y hay que regenerar el
# pack entero. Asi no hace falta acordarse de pasar -Forzar.
$firmaNueva = 'motor=' + [string](Prop $salud 'motorVersion')
$firmaNueva += '|' + ((@('rojo', 'azul', 'sistema') | ForEach-Object { "$_=" + $manifiesto.voces[$_] }) -join ';')
$firmaNueva += '|emo=' + (@(Prop $salud 'emociones' @()) -join ',')
$firmaNueva += '|post=' + [string](Prop $salud 'postproceso') + '|norm=' + [string](Prop $salud 'normalizacion')
$manifiesto.firma = $firmaNueva
$forzar = [bool]$Forzar
if (Test-Path -LiteralPath (Join-Path $OutDir 'voz.json')) {
    try {
        $viejo = Get-Content -LiteralPath (Join-Path $OutDir 'voz.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        # Si cambiaron las voces, el pack viejo no vale aunque los ficheros existan:
        # los MP3 son por seq y se quedarian con la voz anterior. Se regenera todo.
        $vocesViejas = $viejo.voces
        $cambioVoces = $true
        if ($vocesViejas) {
            $cambioVoces = $false
            foreach ($k in 'rojo', 'azul', 'sistema') {
                if ([string]$vocesViejas.$k -ne [string]$manifiesto.voces[$k]) { $cambioVoces = $true }
            }
        }
        if ($cambioVoces) {
            $forzar = $true
            Escribir '  voces nuevas o pack sin firma de voces: se regenera el pack entero.' 'Yellow'
        } elseif ([string]$viejo.firma -ne $firmaNueva) {
            $forzar = $true
            Escribir '  prosodia/post-proceso/normalizacion cambiaron: se regenera el pack entero.' 'Yellow'
        }
        # Los eventos del pack anterior se arrastran SIEMPRE, incluso cuando hay que
        # regenerarlo: si la sintesis se cae a mitad, el manifiesto no se queda a
        # medias y la limpieza de huerfanos no borra los MP3 que ya eran validos.
        if ($viejo.eventos) {
            foreach ($p in $viejo.eventos.PSObject.Properties) { $manifiesto.eventos[$p.Name] = $p.Value }
        }
    } catch { }
}

$nuevos = 0; $saltados = 0; $fallos = 0; $bytesTotal = 0
$i = 0
foreach ($ev in $eventos) {
    $i++
    $seq = [string]$ev.seq
    if (-not $seq) { $seq = [string]$i }
    $archivo = $seq + '.mp3'
    $ruta = Join-Path $OutDir $archivo
    $agenteEv = [string](Prop $ev 'agente')
    $agente = if ($agenteEv -eq 'rojo' -or $agenteEv -eq 'azul') { $agenteEv } else { 'sistema' }
    # Emoción de la frase: la que eligió el cerebro dramático (campo 'emocion');
    # en partidas viejas solo hay 'tono', que el servicio traduce igual.
    $emoEv = [string](Prop $ev 'emocion')
    if (-not $emoEv) { $emoEv = [string](Prop $ev 'tono') }
    $emocion = if ($emoEv) { $emoEv } else { 'neutral' }

    if ((-not $forzar) -and (Test-Path -LiteralPath $ruta) -and $manifiesto.eventos.Contains($seq)) {
        # Si la emoción cambió respecto al pack anterior, el MP3 ya no vale.
        if ([string](Prop $manifiesto.eventos[$seq] 'emocion') -eq $emocion) {
            $saltados++
            $bytesTotal += (Get-Item -LiteralPath $ruta).Length
            continue
        }
    }

    $texto = [string]$ev.texto
    $url = $Servicio + '/tts?v=' + $agente + '&t=' + [uri]::EscapeDataString($texto) + '&e=' + [uri]::EscapeDataString($emocion)
    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Invoke-WebRequest -Uri $url -OutFile $ruta -TimeoutSec 40 -UseBasicParsing | Out-Null
        $sw.Stop()
        $len = (Get-Item -LiteralPath $ruta).Length
        if ($len -lt 800) { throw "audio vacio ($len B)" }
        $manifiesto.eventos[$seq] = [ordered]@{ archivo = $archivo; bytes = $len; agente = $agente; emocion = $emocion; ms = [int]$sw.ElapsedMilliseconds }
        $nuevos++
        $bytesTotal += $len
        Escribir ("  [{0}/{1}] seq={2,-4} {3,-6} {4,-11} {5,7:N0} B {6,5} ms  {7}" -f $i, $eventos.Count, $seq, $agente, $emocion, $len, $sw.ElapsedMilliseconds, $texto.Substring(0, [Math]::Min(48, $texto.Length))) 'DarkGray'
    } catch {
        $fallos++
        Escribir ("  [{0}/{1}] seq={2} FALLO: {3}" -f $i, $eventos.Count, $seq, $_.Exception.Message) 'Red'
    }
}

# Si la sintesis fallo a medias NO se toca el pack anterior: se deja intacto
# (voz.json + sus MP3) y se sale con error. Asi un corte del servicio de voz
# nunca deja la repeticion con un pack incompleto o mezclando voces viejas.
if ($fallos -gt 0) {
    Escribir ''
    Escribir ("FALLOS: " + $fallos + " de " + $eventos.Count + " frases. NO se toca el pack anterior.") 'Red'
    Escribir '  Comprueba el servicio de voz (http://127.0.0.1:8771/health) y vuelve a lanzarlo.' 'Red'
    exit 1
}

# Limpia MP3 huerfanos de eventos que ya no existen (partidas distintas).
$validos = @($manifiesto.eventos.Keys | ForEach-Object { [string]$_ + '.mp3' })
Get-ChildItem -LiteralPath $OutDir -Filter '*.mp3' -File | Where-Object { $validos -notcontains $_.Name } | ForEach-Object {
    Escribir ("  huerfano borrado: " + $_.Name) 'Yellow'
    Remove-Item -LiteralPath $_.FullName -Force
}

$rutaManifiesto = Join-Path $OutDir 'voz.json'
$json = $manifiesto | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($rutaManifiesto, $json, (New-Object System.Text.UTF8Encoding($false)))

Escribir ''
Escribir ("PACK DE VOCES: " + $manifiesto.eventos.Count + " frases, " + ("{0:N0}" -f $bytesTotal) + " B") 'Cyan'
Escribir ("  nuevos=" + $nuevos + "  ya estaban=" + $saltados + "  fallos=" + $fallos) 'Cyan'
Escribir ("  -> " + (Resolve-Path -LiteralPath $OutDir).Path) 'Cyan'
