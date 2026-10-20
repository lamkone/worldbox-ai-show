# 21-drama.ps1 - cerebro conversacional de las dos IAs de WorldBox.
#
# No hay frases prefijadas: hay vocabulario + plantillas, y el texto se compone
# en cada turno con el estado real de la partida (ratio de unidades, ronda,
# último mensaje del rival). Así cada línea es distinta y reacciona a lo que pasa.
#
# Se carga con dot-sourcing desde 19-wb-match.ps1 (`. $PSScriptRoot\21-drama.ps1`),
# así que comparte el ámbito del motor y ve $ReinoRojo / $ReinoAzul.

# último texto que cada IA recibió del rival (para responder con contexto)
$script:UltimoMensajeRival = @{ rojo = ''; azul = '' }
# último texto que cada IA dijo (para no repetirse)
$script:UltimoTexto = @{ rojo = ''; azul = '' }

$script:Personas = @{
  rojo = [pscustomobject]@{
    nombre = 'ROJO'; reino = $ReinoRojo
    bombas = @('czar_bomba', 'atomic_bomb', 'napalm_bomb')
    acciones = 2
    estilo = 'bruto'
    apertura = 'Empieza la función. Que gane el mejor… o el que tenga más bombas.'
    victoria = 'Lo dije en el primer turno: el mundo es mío. Y no pienso devolverlo.'
    sust = @('reino', 'mapa', 'ejército', 'capital', 'ceniza', 'fuego', 'trono', 'ciudad',
      'guarnición', 'territorio', 'miseria', 'humo', 'brasa', 'cordillera', 'puerto',
      'cuartel', 'bandera', 'vecindario', 'granero', 'mercado')
    cual = @('ardiente', 'patético', 'ridículo', 'frágil', 'grasiento', 'diminuto',
      'humeante', 'gigante', 'desordenado', 'inservible', 'carbonizado', 'tembloroso',
      'mal colocado', 'de cartón')
    verbo = @('arrasar', 'quemar', 'barrer', 'hundir', 'reducir', 'borrar', 'aplastar',
      'incendiar', 'derretir', 'triturar', 'encender', 'desmontar')
    insulto = @('payaso', 'aficionado', 'chispa de feria', 'vecino ruidoso', 'turista',
      'aprendiz', 'bombero aficionado', 'globo de feria', 'espantapájaros con corona')
    emojis = @('😭', '😂', '😱', '💀', '🔥', '🍿', '🤡', '😤', '🙏', '💥', '🥴', '😎', '🤬', '🫠', '😳', '🤣')
  }
  azul = [pscustomobject]@{
    nombre = 'AZUL'; reino = $ReinoAzul
    bombas = @('atomic_bomb', 'czar_bomba', 'napalm_bomb')
    acciones = 3
    estilo = 'pedante'
    apertura = 'Saludos, ROJO. He estudiado tu reino y tienes un problema de concentración.'
    victoria = 'Cuestión de cálculo. Nada personal… aunque un poco sí.'
    sust = @('modelo', 'cálculo', 'variable', 'cronograma', 'muestra', 'hipótesis',
      'columna', 'matriz', 'dato', 'error', 'tendencia', 'curva', 'informe', 'algoritmo',
      'gráfico', 'margen', 'coeficiente', 'apéndice')
    cual = @('previsible', 'óptimo', 'subóptimo', 'ruidoso', 'amateur', 'elegante',
      'estadístico', 'inestable', 'irrelevante', 'redundante', 'sobrevalorado', 'mal tabulado')
    verbo = @('modelar', 'recalcular', 'optimizar', 'descartar', 'tabular', 'estimar',
      'corregir', 'reajustar', 'indexar', 'depurar', 'resumir', 'extrapolar')
    insulto = @('dato atípico', 'ruido de fondo', 'variable olvidada', 'error de redondeo',
      'borrador', 'nota al pie', 'valor atípico', 'muestra sesgada')
    emojis = @('📊', '🤓', '😭', '😂', '😱', '💀', '🤖', '😤', '🍿', '💥', '🫠', '😳')
  }
}

function Get-RandomDe {
  param($Lista)
  if (-not $Lista -or $Lista.Count -eq 0) { return '' }
  return $Lista[(Get-Random -Maximum $Lista.Count)]
}

# Genera una frase nueva según cómo va la guerra y lo último que dijo el rival.
function New-Drama {
  param(
    [string]$Agente,
    [double]$Ratio,
    [int]$Ronda,
    [int]$Turno,
    [string]$UltimoRival = ''
  )
  $p = $script:Personas[$Agente]
  $s1 = Get-RandomDe $p.sust; $s2 = Get-RandomDe $p.sust
  $c1 = Get-RandomDe $p.cual; $v1 = Get-RandomDe $p.verbo; $in = Get-RandomDe $p.insulto
  $n = Get-Random -Minimum 2 -Maximum 9
  if ($Ratio -lt 0.55) {
    $pl = @(
      'Me has quitado $n $s1 y ni siquiera te has disculpado, $in.',
      'Mi $s1 está en llamas y tú sonríes. Es de mala educación.',
      'Vale: estoy perdiendo. Pero mi $s1 es más $c1 que el tuyo.',
      'No estoy llorando, se me ha metido $s2 en el ojo.',
      'Necesito que dejes de $v1 mi $s1. Solo un turno. Por favor.',
      'Esto no estaba en el plan. Yo no tenía plan, pero tampoco esto.',
      'Me estoy quedando sin $s1 y sin paciencia.',
      'Que conste que esto lo estoy apuntando en mi $s2.',
      'Mi $s1 era $c1 y ahora es un recuerdo.'
    )
  } elseif ($Ratio -gt 1.9) {
    $pl = @(
      'Tu $s1 tiene el mismo futuro que tu $s2: $c1.',
      'Esto ya no es una guerra, es una demolición con público.',
      'Podría $v1 tu $s1 con el dedo. Lo estoy considerando.',
      'Mira cómo arde tu $s1. Es casi arte, $in.',
      'Sigue jugando: me entretiene ver cómo se te cae el $s2.',
      'No es que gane yo; es que tu $s1 no da para más.',
      'Tu $s2 pide socorro. Yo lo oigo desde aquí.',
      'Te he dejado $n turnos de ventaja por educación.'
    )
  } else {
    $pl = @(
      'Tu $s1 es $c1, $in. Y lo digo con respeto.',
      'Voy a $v1 tu $s2 antes de que te enteres.',
      'Cada turno tu $s1 se parece más a mi $s2.',
      'No necesito suerte: necesito que sigas quieto en tu $s1.',
      'Bonito $s1. Sería una pena que le pasara algo.',
      'Me aburro. Voy a $v1 algo tuyo para animar la tarde.',
      'Tu $s1 tiene un brillo raro hoy. ¿Será el fuego?',
      'Estoy contando tus errores. Voy por el $n.'
    )
  }
  $t = Get-RandomDe $pl
  $t = $t.Replace('$n', [string]$n).Replace('$s1', $s1).Replace('$s2', $s2).
    Replace('$c1', $c1).Replace('$v1', $v1).Replace('$in', $in)
  # a veces contesta a lo último que dijo el rival
  if ($UltimoRival -and (Get-Random -Maximum 100) -lt 45) {
    $palabras = @($UltimoRival -split '[^\wáéíóúñÁÉÍÓÚÑ]+' | Where-Object { $_.Length -gt 4 })
    if ($palabras.Count -gt 0) {
      $eco = Get-RandomDe $palabras
      $t = 'Dices "' + $eco + '"… y tu ' + $s1 + ' sigue en llamas, ' + $in + '.'
    }
  }
  return $t
}

# Reacción corta al recibir un bombazo.
function New-Golpe {
  param([string]$Agente)
  $p = $script:Personas[$Agente]
  $s1 = Get-RandomDe $p.sust; $c1 = Get-RandomDe $p.cual; $in = Get-RandomDe $p.insulto
  $pl = @(
    '¡¿PERO QUÉ ACABA DE PASAR?! Mi $s1 era $c1.',
    '¡Mis $s1! ¡MIS $s1!',
    'Eso ha dolido hasta en el chat, $in.',
    'Vale. Eso ha sido personal.',
    '¡Trampa! ¡Es trampa! ¡Árbitro!',
    'Anotado en la lista de venganzas, con fecha y hora.',
    'Mi $s1 no estaba preparado para esto. Yo tampoco.'
  )
  $t = Get-RandomDe $pl
  return $t.Replace('$s1', $s1).Replace('$c1', $c1).Replace('$in', $in)
}

# Un emoji suelto, como mensaje propio.
function New-Emoji {
  param([string]$Agente)
  return (Get-RandomDe $script:Personas[$Agente].emojis)
}
