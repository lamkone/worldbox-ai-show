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

.PARAMETER MotorAzul
    (v9.7) Motor con el que se sintetiza SOLO el AZUL en este pack: edge (defecto
    del servidor) o chatterbox. No cambia el directo. El pack con Chatterbox
    clonando a Ximena: -MotorAzul chatterbox -VozAzul es-ES-XimenaNeural.
    Si se omite, se lee de $env:PACK_MOTOR_AZUL (asi publish-show.ps1 puede
    regenerar el pack con Chatterbox sin editarse).

.PARAMETER VozAzul
    (v9.7) Voz del AZUL solo en este pack (id de edge, p.ej. es-ES-XimenaNeural).
    Si se omite, la del servidor (es-MX-DaliaNeural), o $env:PACK_VOZ_AZUL.

.PARAMETER Forzar
    Vuelve a sintetizar aunque el MP3 ya exista.

.EXAMPLE
    pwsh -File scripts\build-voice-pack.ps1
    pwsh -File scripts\build-voice-pack.ps1 -Forzar -Tipos 'chat','titular'
    pwsh -File scripts\build-voice-pack.ps1 -Forzar -MotorAzul chatterbox -VozAzul es-ES-XimenaNeural
    # Con publish-show.ps1 (que llama sin flags), mismo efecto por entorno:
    $env:PACK_MOTOR_AZUL='chatterbox'; $env:PACK_VOZ_AZUL='es-ES-XimenaNeural'
    pwsh -File scripts\publish-show.ps1 -Mensaje 'show: ...' -Verificar
#>
[CmdletBinding()]
param(
    [string]$ShowJson = (Join-Path $PSScriptRoot '..\reports\wb-match\show.json'),
    [string]$OutDir   = (Join-Path $PSScriptRoot '..\worldbox-ai-show\demo\voz'),
    [string]$Servicio = 'http://127.0.0.1:8771',
    [string[]]$Tipos   = @('chat'),
    [string]$MotorAzul = '',
    [string]$VozAzul   = '',
    [switch]$Forzar
)

$ErrorActionPreference = 'Stop'
$Servicio = $Servicio.TrimEnd('/')

# v9.7: override de motor/voz SOLO para este pack (el directo sigue en edge).
# Si no llegan por parametro, se leen del entorno: asi publish-show.ps1 (que llama
# sin flags) puede regenerar el pack con Chatterbox sin editarse.
if (-not $MotorAzul -and $env:PACK_MOTOR_AZUL) { $MotorAzul = [string]$env:PACK_MOTOR_AZUL }
if (-not $VozAzul   -and $env:PACK_VOZ_AZUL)   { $VozAzul   = [string]$env:PACK_VOZ_AZUL }
$MotorAzul = ([string]$MotorAzul).Trim().ToLower()
$VozAzul   = ([string]$VozAzul).Trim()
if ($MotorAzul -and (@('kokoro', 'edge', 'chatterbox') -notcontains $MotorAzul)) {
    throw "MotorAzul no valido: '$MotorAzul' (kokoro | edge | chatterbox)"
}
# Chatterbox tarda 8-15 s por linea y la primera paga la carga del modelo (~20-40 s):
# el timeout de 40 s de una peticion normal se queda corto.
$timeoutSeg = if ($MotorAzul -eq 'chatterbox') { 240 } else { 40 }

function Escribir($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# Lee una propiedad que puede no existir sin romper bajo Set-StrictMode
# (publish-show.ps1 activa StrictMode y este script hereda el modo).
function Prop {
    param($obj, [string]$name, $def = '')
    if ($null -ne $obj -and $obj.PSObject.Properties[$name]) { return $obj.$name }
    return $def
}

# Huella corta del TEXTO de la frase. Los seq se repiten entre partidas (1, 2, 3...),
# asi que para saber si el MP3 que ya esta en disco sirve hay que comparar el texto:
# si no, se queda el audio de la partida anterior con el texto nuevo en pantalla.
function HuellaTexto([string]$t) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($t))
        return (([System.BitConverter]::ToString($b)) -replace '-', '').Substring(0, 16).ToLower()
    } finally { $sha.Dispose() }
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
    if ($MotorAzul -or $VozAzul) {
        $txtMotor = if ($MotorAzul) { $MotorAzul } else { '(servidor)' }
        $txtVoz   = if ($VozAzul) { $VozAzul } else { '(servidor)' }
        Escribir ("  PACK override: motorAzul=" + $txtMotor + "  vozAzul=" + $txtVoz + "  (el directo no cambia)") 'Yellow'
    }
} catch {
    throw "El servicio de voz no responde en $Servicio. Arrancalo con: node scripts\tts-server.mjs --port 8771"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$eventos = @($show.eventos | Where-Object { $Tipos -contains $_.tipo -and $_.texto })
Escribir ("Frases a sintetizar: " + $eventos.Count + "  (tipos: " + ($Tipos -join ', ') + ")")

# v9.7: motor/voz EFECTIVOS del AZUL en este pack (override o los del servidor).
$motorAzulEf = if ($MotorAzul) { $MotorAzul } else { [string](Prop (Prop $salud 'motores' $null) 'azul') }
$vozAzulEf   = if ($VozAzul) { $VozAzul } else { [string](Prop (Prop $salud 'perfiles' $null) 'azul') }

$manifiesto = [ordered]@{
    version   = 3
    motor     = [string](Prop $salud 'motorVersion')
    motorAzul = $motorAzulEf
    voces     = [ordered]@{
        rojo    = [string](Prop (Prop $salud 'perfiles' $null) 'rojo')
        azul    = $vozAzulEf
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
$firmaNueva += '|motorAzul=' + $motorAzulEf
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
$seqsVistos = New-Object System.Collections.Generic.HashSet[string]
$i = 0
foreach ($ev in $eventos) {
    $i++
    $seq = [string]$ev.seq
    if (-not $seq) { $seq = [string]$i }
    [void]$seqsVistos.Add($seq)
    $archivo = $seq + '.mp3'
    $ruta = Join-Path $OutDir $archivo
    $agenteEv = [string](Prop $ev 'agente')
    $agente = if ($agenteEv -eq 'rojo' -or $agenteEv -eq 'azul') { $agenteEv } else { 'sistema' }
    # Emoción de la frase: la que eligió el cerebro dramático (campo 'emocion');
    # en partidas viejas solo hay 'tono', que el servicio traduce igual.
    $emoEv = [string](Prop $ev 'emocion')
    if (-not $emoEv) { $emoEv = [string](Prop $ev 'tono') }
    $emocion = if ($emoEv) { $emoEv } else { 'neutral' }

    $texto = [string]$ev.texto
    $huella = HuellaTexto $texto

    if ((-not $forzar) -and (Test-Path -LiteralPath $ruta) -and $manifiesto.eventos.Contains($seq)) {
        # El MP3 anterior solo vale si es la MISMA frase con la MISMA emocion.
        # Los seq se repiten en cada partida: comparando solo la emocion se
        # quedaria el audio de la partida anterior con el texto nuevo.
        if (([string](Prop $manifiesto.eventos[$seq] 'emocion') -eq $emocion) -and ([string](Prop $manifiesto.eventos[$seq] 'hash') -eq $huella)) {
            $saltados++
            $bytesTotal += (Get-Item -LiteralPath $ruta).Length
            continue
        }
    }

    # v9.7: el AZUL del pack puede pedir otro motor/voz sin tocar el servidor.
    $vParam = if ($agente -eq 'azul' -and $VozAzul) { $VozAzul } else { $agente }
    $url = $Servicio + '/tts?v=' + [uri]::EscapeDataString($vParam) + '&t=' + [uri]::EscapeDataString($texto) + '&e=' + [uri]::EscapeDataString($emocion)
    if ($MotorAzul -and $agente -eq 'azul') { $url += '&motor=' + [uri]::EscapeDataString($MotorAzul) }
    try {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Invoke-WebRequest -Uri $url -OutFile $ruta -TimeoutSec $timeoutSeg -UseBasicParsing | Out-Null
        $sw.Stop()
        $len = (Get-Item -LiteralPath $ruta).Length
        if ($len -lt 800) { throw "audio vacio ($len B)" }
        $manifiesto.eventos[$seq] = [ordered]@{ archivo = $archivo; bytes = $len; agente = $agente; emocion = $emocion; hash = $huella; ms = [int]$sw.ElapsedMilliseconds }
        $nuevos++
        $bytesTotal += $len
        Escribir ("  [{0}/{1}] seq={2,-4} {3,-6} {4,-11} {5,7:N0} B {6,5} ms  {7}" -f $i, $eventos.Count, $seq, $agente, $emocion, $len, $sw.ElapsedMilliseconds, $texto.Substring(0, [Math]::Min(48, $texto.Length))) 'DarkGray'
    } catch {
        $fallos++
        # No dejar un MP3 a medias que pudiera colarse como valido en otra pasada.
        if (Test-Path -LiteralPath $ruta) { Remove-Item -LiteralPath $ruta -Force -ErrorAction SilentlyContinue }
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

# Solo los eventos de ESTA partida. El manifiesto arrastraba los de partidas
# anteriores, y como la limpieza de huerfanos usa sus claves, sus MP3 no se
# borraban nunca: el pack crecia sin control (62 eventos para 37 frases).
foreach ($k in @($manifiesto.eventos.Keys)) {
    if (-not $seqsVistos.Contains([string]$k)) {
        Escribir ("  evento de otra partida descartado: seq=" + $k) 'Yellow'
        $manifiesto.eventos.Remove($k)
    }
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
