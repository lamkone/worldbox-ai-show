# 21-drama.ps1 - cerebro conversacional de respaldo de las dos IAs de WorldBox.
#
# Este fichero es el PLAN B: se usa cuando el cerebro LLM (23-drama-llm.mjs) no
# contesta. Aun así tiene que sonar a una persona contestando, no a una frase
# aleatoria pegada. Para eso trabaja con tres cosas:
#
#   1. CIFRAS REALES. Lee el estado de la partida que el motor deja en el script
#      scope (Marcador = bajas causadas / pérdidas, Historial = última foto de
#      unidades) y las mete en la frase. Nunca inventa números: si un dato no
#      existe, la plantilla que lo necesitaba se descarta (Expand-Plantilla
#      devuelve $null y se prueba otra).
#   2. ARCO. La ronda decide el tono: ronda 1 chulería, media pique, última
#      desesperación o triunfo. Antes $Ronda y $Turno se recibían y se tiraban.
#   3. RESPUESTA AL RIVAL. Si hay UltimoRival, saca de ahí el TEMA (de qué está
#      hablando) y la CIFRA que ha soltado, y contesta a eso. Antes cogía una
#      palabra al azar y salía "Dices «mastodonte»…", que era un non-sequitur.
#
# Además evita repetir estructuras: lleva una ventana de las últimas frases
# ($script:Recientes) y descarta plantillas que empiecen igual.
#
# Se carga con dot-sourcing desde 19-wb-match.ps1 (`. $PSScriptRoot\21-drama.ps1`),
# así que comparte el ámbito del motor y ve $ReinoRojo / $ReinoAzul.

# último texto que cada IA recibió del rival (para responder con contexto)
$script:UltimoMensajeRival = @{ rojo = ''; azul = '' }
# último texto que cada IA dijo (para no repetirse)
$script:UltimoTexto = @{ rojo = ''; azul = '' }
# ventana deslizante de huellas ya usadas (normalizadas) para no repetir ideas.
# Guarda la huella de CADA trozo (contestación, cuerpo, remate) por separado, no
# solo la de la frase montada: si no, el mismo cuerpo se cuela una y otra vez
# dentro de contestaciones distintas y el chat suena a disco rayado.
$script:Huellas = @{
  rojo = [System.Collections.ArrayList]::new()
  azul = [System.Collections.ArrayList]::new()
}
$script:HuellasMax = 10
# último emoji de cada agente, para no repetir el mismo dos veces seguidas
$script:UltimoEmoji = @{ rojo = ''; azul = '' }
# últimas frases publicadas por CUALQUIER agente: los dos comparten chat, así que
# no puede salir la misma contestación dos veces seguidas en bocas distintas
$script:GlobalRecientes = [System.Collections.ArrayList]::new()
$script:GlobalMax = 8

# Los nombres de reino los pone el motor ($ReinoRojo/$ReinoAzul son el id del
# reino). Se conserva el valor TAL CUAL para no cambiarle el tipo al motor; si
# no existe (pruebas sueltas) usamos un nombre genérico en vez de reventar.
$script:ReinoR = if (Get-Variable -Name 'ReinoRojo' -ErrorAction SilentlyContinue) { $ReinoRojo } else { 'Reino del Rojo' }
$script:ReinoA = if (Get-Variable -Name 'ReinoAzul' -ErrorAction SilentlyContinue) { $ReinoAzul } else { 'Reino del Azul' }

$script:Personas = @{
  rojo = [pscustomobject]@{
    nombre = 'ROJO'; reino = $script:ReinoR
    bombas = @('czar_bomba', 'atomic_bomb', 'napalm_bomb')
    acciones = 2
    estilo = 'macarra'
    apertura = 'Aquí manda uno y no eres tú, así que espabila.'
    victoria = 'Se acabó: gané yo y no ha habido sorpresa ninguna.'
    insulto = @('flipao', 'fantasma', 'vendehumos', 'cuentista', 'farolero',
      'postureo de saldo', 'mucho humo', 'payaso', 'pesao', 'cuñao')
    # remates cortos: se pegan al final para dar voz propia sin alargar la frase
    remate = @(
      'Y me estoy divirtiendo.'
      'Chúpate esa.'
      'Toma ya.'
      'En tu cara.'
      'Y no pienso disculparme.'
    )
    emojis = [pscustomobject]@{
      panico     = @('😱', '🫠', '😰', '🥴')
      nervios    = @('😬', '😤', '😳', '🙃')
      rabia      = @('🤬', '😡', '💢', '🔥')
      dolor      = @('💀', '😖', '💥', '😱')
      pique      = @('🙄', '😒', '🤨', '🍿')
      chuleria   = @('😏', '😎', '🍿', '🤣')
      euforia    = @('😂', '💥', '🔥', '🤣')
      triunfo    = @('🏆', '👑', '💪', '😂')
      resignacion = @('😮‍💨', '😐', '🫠', '💀')
    }
  }
  azul = [pscustomobject]@{
    nombre = 'AZUL'; reino = $script:ReinoA
    bombas = @('atomic_bomb', 'czar_bomba', 'napalm_bomb')
    acciones = 3
    estilo = 'cuñao'
    apertura = 'Vamos a ver, tronco: tú no estás a mi nivel.'
    victoria = 'Gané yo. Fuente: el mapa.'
    insulto = @('cuentista', 'humo', 'postureo', 'relato', 'teatrillo',
      'vendehúmos', 'figura', 'genio', 'artista', 'campeón')
    remate = @(
      'Y ya está.'
      'Cuéntame más.'
      'No me hagas reír.'
      'Qué detalle.'
      'Me quedo sin palabras.'
    )
    emojis = [pscustomobject]@{
      panico     = @('😱', '🫠', '😰', '🥴')
      nervios    = @('😬', '😤', '😳', '🙃')
      rabia      = @('🤬', '😡', '💢', '🔥')
      dolor      = @('💀', '😖', '💥', '😱')
      pique      = @('🙄', '😒', '🤨', '🍿')
      chuleria   = @('😏', '😎', '🍿', '🤨')
      euforia    = @('😂', '💥', '🔥', '🤣')
      triunfo    = @('🏆', '👑', '😏', '😂')
      resignacion = @('😮‍💨', '😐', '🫠', '💀')
    }
  }
}

function Get-RandomDe {
  param($Lista)
  if (-not $Lista -or $Lista.Count -eq 0) { return '' }
  return $Lista[(Get-Random -Maximum $Lista.Count)]
}

# Lee una variable del ámbito del motor sin romperse si no existe.
# Get-Variable sin -Scope recorre la cadena de scopes: así funciona igual si
# 21-drama.ps1 se carga solo (pruebas) o dot-sourced desde el motor.
function Get-DramaDato {
  param([string]$Nombre)
  # -Scope Script primero: así una variable local del que llama (p.ej. $rondas
  # dentro de Get-DramaEstado) no nos tapa la del motor, que es $Rondas.
  $v = Get-Variable -Name $Nombre -Scope Script -ErrorAction SilentlyContinue
  if ($null -eq $v) { $v = Get-Variable -Name $Nombre -ErrorAction SilentlyContinue }
  if ($null -eq $v) { return $null }
  return $v.Value
}

# De qué está hablando el rival, en sustantivo escueto ("ejército", "mapa",
# "números") para que la contestación enganche con su mensaje.
# Palabras que no sirven como "tema" al sacar la palabra más larga del rival.
$script:StopTema = @('donde', 'cuando', 'porque', 'aunque', 'tambien', 'tampoco', 'desde',
  'hasta', 'entre', 'sobre', 'bajo', 'tras', 'ante', 'contra', 'segun', 'sino', 'solo',
  'aun', 'pero', 'pues', 'quien', 'cual', 'cuyo', 'este', 'esta', 'estos', 'estas', 'ese',
  'esa', 'esos', 'esas', 'aquel', 'aquella', 'mismo', 'misma', 'ahora', 'antes', 'despues',
  'luego', 'entonces', 'alla', 'aqui', 'alli', 'bien', 'hace', 'tener', 'tiene', 'tienes',
  'vamos', 'vais', 'estan', 'estoy', 'estais', 'somos', 'sois', 'eran', 'fueron', 'sido',
  'siendo', 'tengo', 'tenemos', 'tienen', 'voy', 'vas', 'van', 'visto', 'decir', 'dicho',
  'hacer', 'hecho', 'puede', 'puedo', 'puedes', 'pueden', 'quiero', 'quieres', 'quiere',
  'quieren', 'sabe', 'sabes', 'saben', 'mucho', 'poco', 'nada', 'todo', 'toda', 'todos',
  'todas', 'otro', 'otra', 'otros', 'otras', 'nunca', 'siempre', 'ademas', 'incluso',
  'mientras', 'claro', 'venga', 'menudo', 'menuda', 'dices', 'dice', 'dijo', 'diras',
  'acaba', 'llevas', 'lleva', 'sigues', 'sigue', 'hablas', 'habla', 'parece', 'queda',
  'quedan', 'tienes', 'estaba', 'estabas', 'estamos', 'estais', 'verdad', 'acaso')

$script:TemasRival = @(  @('baja', 'cadáveres'),
  @('unidad', 'tropas'),
  @('ejercit', 'ejército'),
  @('mapa', 'mapa'),
  @('ciudad', 'ciudades'),
  @('bomba', 'bombas'),
  @('fuego', 'fuego'),
  @('humo', 'humo'),
  @('ceniza', 'cenizas'),
  @('guarnición', 'guarnición'),
  @('guarnicion', 'guarnición'),
  @('granero', 'granero'),
  @('mercado', 'mercado'),
  @('capital', 'capital'),
  @('sueño', 'sueños'),
  @('payaso', 'payasadas'),
  # registro nuevo (2026): de esto sí se pica la gente
  @('postureo', 'postureo'),
  @('relato', 'relato'),
  @('farol', 'faroles'),
  @('milonga', 'milongas'),
  @('cuento', 'cuentos'),
  @('humo', 'mucho humo')
)

# Temas ya usados, para no quedarnos dando vueltas a la misma palabra: la
# réplica se cita a sí misma y el turno siguiente vuelve a sacar el mismo tema.
$script:TemasUsados = New-Object System.Collections.ArrayList

function Add-TemaUsado {
  param([string]$Tema)
  if (-not $Tema) { return }
  if ($script:TemasUsados -contains $Tema) { return }
  [void]$script:TemasUsados.Add($Tema)
  if ($script:TemasUsados.Count -gt 12) { $script:TemasUsados.RemoveAt(0) }
}

function Get-TemaRival {
  param([string]$Texto)
  if (-not $Texto) { return '' }
  $bajo = $Texto.ToLowerInvariant()
  foreach ($par in $script:TemasRival) {
    if (-not $bajo.Contains($par[0])) { continue }
    if ($script:TemasUsados -contains $par[1]) { continue }
    Add-TemaUsado $par[1]
    return $par[1]
  }
  # Nada de "coger la palabra más larga": salían temas absurdos ("hablas de
  # muchísimo", "hablas de también"). Si no hay tema de la lista, se tira de
  # cita literal (Get-EcoRival), que siempre es gramatical y siempre engancha.
  return ''
}

# Trozos que no se pueden citar tal cual porque empiezan por conector.
$script:ConectoresInicio = @('que', 'y', 'o', 'u', 'pero', 'si', 'como', 'cuando', 'porque',
  'mientras', 'aunque', 'sino', 'pues', 'entonces', 'ademas', 'luego', 'tambien', 'tampoco')

# Cita LITERAL de un trozo de lo que acaba de decir el rival. Es la forma más
# robusta de contestar: al ser sus propias palabras, la frase siempre tiene
# sentido y siempre se nota que le está respondiendo a ÉL.
function Get-EcoRival {
  param([string]$Texto)
  if (-not $Texto) { return '' }
  # si el rival ya está citando/contestando una cita, citarlo a él monta un bucle
  # ("«Me quedo con lo de» dices"). En ese caso no se cita: que tire el tema.
  if ($Texto -match '(lo de|eso de|dices|dir[aá]s|te he o[íi]do|me quedo con|repite|ap[uú]ntate|citando|como dec[íi]as)') { return '' }
  # fuera lo que ya venía entre comillas: si no, citamos su cita.
  $t = ($Texto -replace '«[^»]*»', ' ' -replace '"[^"]*"', ' ' -replace '\s+', ' ').Trim()
  $cand = @()
  foreach ($z in [regex]::Split($t, '[,;:.!?…]+')) {
    $z = ($z -replace '[¿¡"“”«»]', '').Trim()
    if (-not $z) { continue }
    $pal = @($z -split '\s+' | Where-Object { $_ })
    if ($pal.Count -lt 2 -or $pal.Count -gt 9) { continue }
    # un trozo que empieza por conector ("que mientras hablas avanzo") citado tal
    # cual queda cojo: «que mientras hablas avanzo» dices. Fuera.
    $prim = $pal[0].ToLowerInvariant()
    if ($script:ConectoresInicio -contains $prim) { continue }
    $cand += $z
  }
  if ($cand.Count -eq 0) { return '' }
  $e = (Get-RandomDe $cand) -replace '[.,;:!?…¿¡"“”«»]', ''
  $e = $e.Trim()
  if ($e.Length -gt 55) { $e = $e.Substring(0, 55).Trim() }
  # que la cita no acabe a mitad de sintagma: «Mucho texto para decir» dices.
  # Se quitan las palabras finales que dejan la cita colgando.
  $colgando = 'de|del|a|al|para|por|con|sin|que|y|o|u|en|el|la|los|las|un|una|su|mi|tu|como|m[aá]s|muy|decir|hacer|ser|estar|tener|ir|ver|dar|poner'
  $pal = @($e -split '\s+' | Where-Object { $_ })
  while ($pal.Count -gt 2 -and $pal[$pal.Count - 1].ToLowerInvariant() -match "^($colgando)$") {
    $pal = @($pal[0..($pal.Count - 2)])
  }
  $e = ($pal -join ' ').Trim()
  if ($pal.Count -lt 2) { return '' }
  return $e
}

# La primera cifra que suelta el rival, para devolvérsela.
function Get-CifraRival {
  param([string]$Texto)
  if (-not $Texto) { return '' }
  $m = [regex]::Match($Texto, '\d{1,6}')
  if ($m.Success) { return $m.Value }
  return ''
}

# Sustituye los huecos {TOKEN}. Devuelve $null si algún hueco se queda sin valor
# (o con cadena vacía), para que el llamador pruebe otra plantilla en vez de
# publicar "{BAJAS}" o " dices. Yo digo…".
function Expand-Plantilla {
  param([string]$Plantilla, [hashtable]$Datos)
  if (-not $Plantilla) { return $null }
  $t = $Plantilla
  foreach ($k in $Datos.Keys) {
    $v = $Datos[$k]
    if ($null -eq $v) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$v)) { continue }
    $t = $t.Replace('{' + $k + '}', [string]$v)
  }
  if ($t -match '\{[A-Za-z_]+\}') { return $null }
  # contracciones: los huecos pueden acabar en vocal y dejar "de el resultado",
  # "a el marcador". Se arregla aquí, una sola vez, para todas las plantillas.
  $t = $t.Replace(' de el ', ' del ').Replace(' a el ', ' al ')
  if ($t.StartsWith('de el ')) { $t = 'del ' + $t.Substring(6) }
  if ($t.StartsWith('a el ')) { $t = 'al ' + $t.Substring(5) }
  return $t
}

# Cuenta frases para no publicar parrafadas en el chat.
function Get-NumFrases {
  param([string]$Texto)
  if (-not $Texto) { return 0 }
  return ([regex]::Matches($Texto, '[.!?…]')).Count
}

# Normaliza una frase para comparar estructuras (primeras palabras, sin acentos).
function Get-Huella {
  param([string]$Texto)
  if (-not $Texto) { return '' }
  $t = $Texto.ToLowerInvariant()
  $t = $t -replace '[^\p{L}\p{N}\s]', ' '
  $partes = @($t -split '\s+' | Where-Object { $_ -ne '' } | Select-Object -First 4)
  return ($partes -join ' ')
}

# ¿Se parece a algo que ya dijo? Compara la huella de las primeras palabras.
function Test-Repetida {
  param([string]$Agente, [string]$Texto)
  $h = Get-Huella $Texto
  if (-not $h) { return $false }
  foreach ($r in $script:Huellas[$Agente]) {
    if ($r -eq $h) { return $true }
  }
  return $false
}

# Apunta la huella de un trozo ya usado para no volver a elegirlo.
function Add-Huella {
  param([string]$Agente, [string]$Texto)
  $h = Get-Huella $Texto
  if (-not $h) { return }
  [void]$script:Huellas[$Agente].Add($h)
  while ($script:Huellas[$Agente].Count -gt $script:HuellasMax) {
    $script:Huellas[$Agente].RemoveAt(0)
  }
}

function Add-Reciente {
  param([string]$Agente, [string]$Texto)
  if (-not $Texto) { return }
  $script:UltimoTexto[$Agente] = $Texto
}

# Foto real de la partida desde el punto de vista del agente.
function Get-DramaEstado {
  param([string]$Agente, [double]$Ratio, [int]$Ronda)

  $rival = if ($Agente -eq 'rojo') { 'azul' } else { 'rojo' }
  $bajas = 0; $perdidas = 0; $mias = 0; $suyas = 0
  $totalRondas = 0

  $marcador = Get-DramaDato 'Marcador'
  try {
    if ($marcador -and $marcador[$Agente]) {
      $bajas = [int]$marcador[$Agente].bajas
      $perdidas = [int]$marcador[$Agente].perdidas
    }
  } catch { }

  $hist = Get-DramaDato 'Historial'
  try {
    if ($hist -and $hist.Count -gt 0) {
      $ult = $hist[$hist.Count - 1]
      if ($Agente -eq 'rojo') { $mias = [int]$ult['rojo_unidades']; $suyas = [int]$ult['azul_unidades'] }
      else { $mias = [int]$ult['azul_unidades']; $suyas = [int]$ult['rojo_unidades'] }
    }
  } catch { }

  $r = Get-DramaDato 'Rondas'
  if ($r) { $totalRondas = [int]$r }

  # si el motor no nos da ratio (lo pasa como [int] y puede quedar en 0), la
  # calculamos con las unidades reales de la última foto
  $ratioReal = $Ratio
  if ($ratioReal -le 0 -and $suyas -gt 0) { $ratioReal = $mias / $suyas }

  return [pscustomobject]@{
    agente   = $Agente
    rival    = $rival
    bajas    = $bajas
    perdidas = $perdidas
    mias     = $mias
    suyas    = $suyas
    ratio    = $ratioReal
    ronda    = $Ronda
    rondas   = $totalRondas
  }
}

# El arco: qué banda toca según la ronda y el marcador.
function Get-DramaBanda {
  param($Estado)
  $rondas = $Estado.rondas
  $esUltima = ($rondas -gt 0 -and $Estado.ronda -ge $rondas)
  if ($esUltima) {
    if ($Estado.ratio -lt 1.0) { return 'finalPerdiendo' }
    return 'finalGanando'
  }
  if ($Estado.ronda -le 1) { return 'apertura' }
  if ($Estado.ratio -lt 0.55) { return 'perdiendo' }
  if ($Estado.ratio -gt 1.9) { return 'ganando' }
  return 'igualado'
}

# ---------------------------------------------------------------- tema y veto

# Humor meta/filosófico, el chiste del llanto, el registro de tebeo antiguo y el
# registro de manual. El dueño señaló los dos últimos como el problema central:
# «parece una mezcla entre niño chico "mentira podrida" y friki "tus datos
# hipotesis"». El respaldo procedural tampoco puede generarlos.
$script:ProhibidoRe = '(no estoy llorando|no lloro|no he llorado|en el ojo|es el polvo|es una alergia|' +
  'b[uú]squeda aleatoria|lo estudi|lo he estudiado|filos[oó]fic|en t[eé]rminos generales|sun tzu|' +
  'conceptualmente|dial[eé]ctic|paradoja|disquisici|humor meta|meta-humor|algoritmo|estad[ií]stic|' +
  'matem[aá]tic|cuenta como plan|como un plan|es un plan|tampoco ten[ií]a plan|narrativa|libreto|' +
  'gui[oó]n|teor[ií]a de|definici[oó]n|definir|concepto de|' +
  # registro de tebeo antiguo
  'mentira podrida|mastuerzo|zoquete|berzas|badulaque|mequetrefe|p[aá]nfilo|botarate|gazn[aá]piro|' +
  'canalla|villano|bellaco|chaval|caramba|rec[oó]rcholis|por tutatis|\bja\s*,\s*ja|\bjaja|\bpuf\b|\bbah\b|\bejem\b|' +
  # registro de manual
  'hip[oó]tesis|\bdatos?\b|tendencia|correlaci[oó]n|variable|probabilidad|metodolog|inferencia|' +
  'sesgo|percentil|muestreo|emp[ií]ric|axioma|silogismo|teorema|postulado|' +
  # la frase concreta del dueño
  'cordillera|' +
  # ordinarieces: macarra sí, grosero no
  'meando|\bmeo\b|mear|mierda|joder|jodid\w*|jodiendo|cagar|cagando|hostia|ostia|polla|\bcoño\b|cojones|capullo|gilipollas|subnormal|imb[eé]cil|idiota|est[uú]pido|cabr[oó]n\w*|pendejo|hijoputa|put[ao]\w*|maric[oó]n\w*|zorra|guarra)'

function Test-Prohibido {
  param([string]$Texto)
  if (-not $Texto) { return $false }
  return ($Texto -match $script:ProhibidoRe)
}

# TEMA DE DISPUTA de la ronda: el mismo para los dos agentes (solo depende de
# ronda/rondas), para que discutan DE LO MISMO. Misma fórmula que el cerebro LLM.
$script:TemasDisputa = @('bajas', 'arma', 'turno', 'marcador')

function Get-TemaRonda {
  param($Estado)
  if (-not $Estado) { return @{ clave = 'ninguno'; texto = '' } }
  $ronda = [int]$Estado.ronda
  $rondas = [int]$Estado.rondas
  if ($rondas -gt 0 -and $ronda -ge $rondas) {
    return @{ clave = 'final'; texto = 'el resultado final' }
  }
  # MISMA fórmula que el cerebro LLM: (ronda*3 + rondas) % 4
  $clave = $script:TemasDisputa[(($ronda * 3) + $rondas) % $script:TemasDisputa.Count]
  $texto = switch ($clave) {
    'bajas' {
      if ($Estado.bajas -gt 0) { "las $($Estado.bajas) bajas que llevas encima" } else { 'las bajas' }
    }
    'arma' { 'tus trucos' }
    'turno' { 'lo que pasa en el mapa' }
    'marcador' {
      if ($Estado.mias -gt 0 -and $Estado.suyas -gt 0) { "el $($Estado.mias) a $($Estado.suyas)" } else { 'el marcador' }
    }
    default { 'el marcador' }
  }
  return @{ clave = $clave; texto = $texto }
}

# ¿La réplica engancha con lo que acaba de decir el rival? Compara raíces de 5
# letras para que "prometo"/"prometes" cuenten como lo mismo.
function Get-Raices {
  param([string]$Texto)
  if (-not $Texto) { return @() }
  $stop = @('para', 'como', 'esto', 'otro', 'otra', 'todo', 'toda', 'nada', 'poco', 'mucho',
    'cada', 'cuando', 'donde', 'porque', 'aunque', 'tambien', 'tampoco', 'desde', 'hasta',
    'entre', 'sobre', 'bajo', 'tras', 'ante', 'contra', 'segun', 'sino', 'solo', 'aun',
    'pero', 'pues', 'que', 'quien', 'cual', 'cuyo', 'este', 'esta', 'estos', 'estas',
    'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'eso', 'mismo', 'misma', 'ahora',
    'antes', 'despues', 'luego', 'entonces', 'asi', 'alla', 'aqui', 'alli', 'bien', 'mal',
    'hace', 'tener', 'tiene', 'tienes', 'vamos', 'vais', 'estan', 'estoy', 'estais', 'ser',
    'somos', 'sois', 'era', 'eran', 'fue', 'fueron', 'sido', 'siendo', 'tengo', 'tenemos',
    'tienen', 'voy', 'vas', 'van', 'ver', 'visto', 'decir', 'dicho', 'hacer', 'hecho',
    'puede', 'puedo', 'puedes', 'pueden', 'quiero', 'quieres', 'quiere', 'quieren',
    'sabe', 'sabes', 'saben')
  $out = @()
  foreach ($m in [regex]::Matches($Texto.ToLower(), '[\p{L}\p{N}]+')) {
    $w = $m.Value
    if ($w.Length -lt 4) { continue }
    if ($stop -contains $w) { continue }
    $out += $w.Substring(0, [Math]::Min(5, $w.Length))
  }
  return @($out | Sort-Object -Unique)
}

# Marcas explícitas de estar contestándole (por si no comparte ninguna palabra).
$script:ReferenciaRe = '(dices|dir[aá]s|dijiste|dice|dijo|eso|esas palabras|lo que dices|' +
  't[uú] mismo|tu frase|presumes|presume|presumir|llamas|llam[aá]s|hablas|habl[aá]s|contestas)'

function Test-EnganchaRival {
  param([string]$Texto, [string]$Rival)
  if (-not $Rival) { return $true }
  $rivalRaices = Get-Raices $Rival
  if ($rivalRaices.Count -eq 0) { return $true }
  foreach ($r in (Get-Raices $Texto)) {
    if ($rivalRaices -contains $r) { return $true }
  }
  return $false
}

# Diccionario de huecos: SOLO se define un token si su dato es real y tiene
# sentido en esa banda. Así ninguna plantilla puede decir una mentira aritmética
# (p.ej. "te saco 315 a 847" cuando en realidad vas perdiendo).
function Get-DramaDatos {
  param($Estado, [string]$Tema = '', [string]$CifraRival = '', [int]$PerdidasForzadas = 0, [string]$TemaRonda = '')

  $datos = @{}
  if ($Estado.bajas -gt 0) { $datos['BAJAS'] = $Estado.bajas }
  $perdidas = if ($PerdidasForzadas -gt 0) { $PerdidasForzadas } else { $Estado.perdidas }
  if ($perdidas -gt 0) { $datos['PERDIDAS'] = $perdidas }
  $saldo = $Estado.bajas - $perdidas
  if ($saldo -gt 0) { $datos['SALDO'] = $saldo }
  if ($Estado.mias -gt 0) { $datos['MIAS'] = $Estado.mias }
  if ($Estado.suyas -gt 0) { $datos['SUYAS'] = $Estado.suyas }
  $ventaja = $Estado.mias - $Estado.suyas
  if ($ventaja -gt 0) { $datos['VENTAJA'] = $ventaja }
  if ($Estado.ronda -gt 0) { $datos['RONDA'] = $Estado.ronda }
  if ($Tema) { $datos['TEMA'] = $Tema }
  if ($TemaRonda) { $datos['TEMA_RONDA'] = $TemaRonda }
  if ($CifraRival) { $datos['CIFRA_RIVAL'] = $CifraRival }
  return $datos
}

# Plantillas por banda. Todas las cifras que aparecen son reales y coherentes
# con la banda en la que se usan.
# ---------------------------------------------------------------------------
# BANCO MÍNIMO DE EMERGENCIA
#
# Esto NO es el guion del show: el guion lo escribe el LLM. Esto solo existe por
# si el cerebro no responde. El dueño fue claro: mejor una frase corta y neutra
# que una plantilla rebuscada. Por eso aquí hay pocas líneas, cortas, en el
# registro nuevo (macarra / cuñao) y sin ninguna gracia forzada.
#
# Regla de oro: si una línea no la diría una persona en un grupo de WhatsApp,
# no entra aquí.
# ---------------------------------------------------------------------------
$script:Plantillas = @{
  rojo = @{
    apertura = @(
      'Aquí manda uno y no eres tú.'
      'Tú vienes a hacer bulto, y ya se te nota.'
      'Prepárate, que esto va a durar poco.'
    )
    perdiendo = @(
      'Me estás tocando las narices, y eso no se hace.'
      'Vale, me has pillado. No vuelve a pasar.'
      'Se me está yendo de las manos y no te lo voy a negar.'
    )
    igualado = @(
      'Esto está apretado y me gusta.'
      'Ninguno cede, y así no se aclara nada.'
      'Se decide ahora, y no pienso aflojar.'
    )
    ganando = @(
      'Vas cuesta abajo y yo miro desde arriba.'
      'Esto ya no es una pelea, es un trámite.'
      'Te queda menos de lo que crees.'
    )
    finalGanando = @(
      'Se acabó, y no ha habido sorpresa.'
      'Gané yo, como estaba escrito.'
    )
    finalPerdiendo = @(
      'Me has ganado. Esta vez.'
      'Disfrútalo, que no se va a repetir.'
    )
  }
  azul = @{
    apertura = @(
      'Vamos a ver, tronco: tú no estás a mi nivel.'
      'Mucho bombo y luego nada, como siempre.'
      'Esto va a ser corto y no lo voy a disfrutar.'
    )
    perdiendo = @(
      'Vale, me has pillado. No me lo esperaba.'
      'Sí, sí, muy bien. Ahora me toca a mí.'
      'No confundas esto con ganar, que aún queda.'
    )
    igualado = @(
      'Esto está igualado, y a mí el empate me aburre.'
      'Ninguno está dando su mejor nivel. Tú menos.'
      'Se decide en cualquier momento y no me va a pillar.'
    )
    ganando = @(
      'Lo tuyo no es estrategia, es esperanza.'
      'Te vendes bien, pero el mapa dice otra cosa.'
      'Me estoy aburriendo, y eso es culpa tuya.'
    )
    finalGanando = @(
      'Fin. Y no ha sido ni difícil.'
      'Gané yo. Fuente: el mapa.'
    )
    finalPerdiendo = @(
      'Has ganado tú. Me lo apunto.'
      'Disfrútalo, que no vuelve a pasar.'
    )
  }
}

# Las únicas que llevan número: una de cada cuatro réplicas.
$script:PlantillasCifra = @{
  rojo = @(
    'Llevas {BAJAS} bajas mías encima y aún te queda voz.'
    'Te he dejado {BAJAS} bajas y tú hablas de estrategia.'
    'Con {BAJAS} bajas tuyas, ¿quién te ha dado permiso para hablar?'
    'Me debes {BAJAS} hombres y no pienso olvidarlo.'
  )
  azul = @(
    'Te he causado {BAJAS} bajas y ni me he esforzado.'
    '{BAJAS} bajas tuyas. Yo lo llamo rentabilidad.'
    'Te llevo {BAJAS} bajas de ventaja y aún te crees algo.'
    'Con {BAJAS} bajas a tu cuenta, lo tuyo es constancia.'
  )
}

# Citan literalmente al rival: es la forma más segura de que la réplica
# conteste a algo que él ha dicho de verdad.
$script:ContestacionesEco = @{
  rojo = @(
    '|«{ECO_RIVAL}» dices, y luego no hay nada.'
    '|Mucho «{ECO_RIVAL}» y poca cosa.'
    '|Eso de «{ECO_RIVAL}» te lo has creído tú.'
    '|Repite lo de «{ECO_RIVAL}» cuando ganes algo.'
  )
  azul = @(
    '|«{ECO_RIVAL}», cuéntame más.'
    '|Mucho texto para decir «{ECO_RIVAL}».'
    '|Eso de «{ECO_RIVAL}» es humo, tronco.'
    '|«{ECO_RIVAL}»: fuente, créeme, bro.'
  )
}

# Anclaje al TEMA de la ronda: así el respaldo también discute de algo concreto.
$script:ContestacionesTema = @(
  '|Dale vueltas a {TEMA_RONDA}, que mientras hablas avanzo.'
  '|¿{TEMA_RONDA}? Eso ya lo he oído antes.'
  '|Hablas de {TEMA_RONDA} y se te olvida lo demás.'
)

$script:ContestacionesGenericas = @(
  '|Muy bien dicho. Ahora mira el marcador.'
  '|Sigue hablando, que me entretienes.'
)

# ---------------------------------------------------------------------------
# Mecánica de montaje (imprescindible: la usan New-Drama y New-Golpe)
# ---------------------------------------------------------------------------

# ¿La plantilla vale en este momento? Cada plantilla puede llevar un requisito
# delante separado por '|' para no afirmar cosas falsas en esa banda.
function Test-Requisito {
  param([string]$Req, [string]$Banda, [int]$Ronda)
  if (-not $Req) { return $true }
  switch ($Req) {
    'perdiendo' { return ($Banda -eq 'perdiendo' -or $Banda -eq 'finalPerdiendo') }
    'ganando' { return ($Banda -eq 'ganando' -or $Banda -eq 'finalGanando') }
    'noApertura' { return ($Ronda -ge 2) }
    'apertura' { return ($Ronda -le 1) }
    default { return $true }
  }
}

# Parte 'req|texto' en sus dos mitades.
function Split-Requisito {
  param([string]$Plantilla)
  $i = $Plantilla.IndexOf('|')
  if ($i -lt 0) { return @('', $Plantilla) }
  return @($Plantilla.Substring(0, $i), $Plantilla.Substring($i + 1))
}

# Qué tokens cuentan como "recitar cifras".
$script:CIFRA_TOKEN_RE = '\{(BAJAS|PERDIDAS|SALDO|MIAS|SUYAS|VENTAJA|RONDA|CIFRA_RIVAL)\}'
$script:ContadorProc = @{ rojo = 0; azul = 0 }

# Avanza el contador del agente y dice si a esta réplica le toca cifra.
# Exactamente 1 de cada 4, igual que en el cerebro LLM.
function Test-TocaCifraProc {
  param([string]$Agente)
  if (-not $script:ContadorProc.ContainsKey($Agente)) { $script:ContadorProc[$Agente] = 0 }
  $n = [int]$script:ContadorProc[$Agente]
  $script:ContadorProc[$Agente] = $n + 1
  return (($n % 4) -eq 3)
}

# Expande una lista de plantillas descartando las que no aplican ahora.
function Expand-Lista {
  param($Plantillas, [hashtable]$Datos, [string]$Banda, [int]$Ronda)
  $out = @()
  foreach ($pl in $Plantillas) {
    $par = Split-Requisito $pl
    if (-not (Test-Requisito -Req $par[0] -Banda $Banda -Ronda $Ronda)) { continue }
    $t = Expand-Plantilla -Plantilla $par[1] -Datos $Datos
    if (-not $t) { continue }
    # veto: nada de humor meta/filosófico, chiste del llanto ni registro viejo
    if (Test-Prohibido $t) { continue }
    # el mismo número dos veces queda ridículo ("750 dices, yo digo 750")
    $nums = @([regex]::Matches($t, '\d{2,}') | ForEach-Object { $_.Value } | Sort-Object -Unique)
    $todos = @([regex]::Matches($t, '\d{2,}') | ForEach-Object { $_.Value })
    if ($todos.Count -gt $nums.Count) { continue }
    $out += $t
  }
  return $out
}

# La primera letra en mayúscula: hay plantillas que empiezan por {TEMA} y el
# tema viene en minúsculas, así que el chat escupía "mapa y más mapa".
function Set-InicialMayuscula {
  param([string]$Texto)
  if (-not $Texto) { return $Texto }
  # solo si la frase EMPIEZA por letra (o por ¿/¡): "800 dices" se queda igual
  if ($Texto -match '^([¿¡]*)(\p{L})(.*)$') {
    return $Matches[1] + $Matches[2].ToUpperInvariant() + $Matches[3]
  }
  return $Texto
}

# Elige una frase de una lista sin repetir la estructura de las últimas dichas,
# y apunta su huella para que no vuelva a salir en los próximos turnos.
function Select-SinRepetir {
  param([string]$Agente, $Lista)
  if (-not $Lista -or $Lista.Count -eq 0) { return $null }
  $mezcla = @($Lista | Sort-Object { Get-Random })
  $elegida = $null
  foreach ($c in $mezcla) {
    if ($script:GlobalRecientes -contains $c) { continue }
    if (-not (Test-Repetida -Agente $Agente -Texto $c)) { $elegida = $c; break }
  }
  # si el filtro global lo deja seco, al menos respetamos la huella propia
  if (-not $elegida) {
    foreach ($c in $mezcla) {
      if (-not (Test-Repetida -Agente $Agente -Texto $c)) { $elegida = $c; break }
    }
  }
  if (-not $elegida) { $elegida = $mezcla[0] }
  Add-Huella -Agente $Agente -Texto $elegida
  if ($elegida) {
    [void]$script:GlobalRecientes.Add($elegida)
    if ($script:GlobalRecientes.Count -gt $script:GlobalMax) { $script:GlobalRecientes.RemoveAt(0) }
  }
  return $elegida
}

function New-Drama {
  param(
    [string]$Agente,
    [double]$Ratio = 1.0,
    [int]$Ronda = 1,
    [int]$Turno = 1,
    [string]$UltimoRival = ''
  )

  if (-not $script:Personas.ContainsKey($Agente)) { $Agente = 'rojo' }
  $est = Get-DramaEstado -Agente $Agente -Ratio $Ratio -Ronda $Ronda
  $banda = Get-DramaBanda -Estado $est

  $tema = Get-TemaRival $UltimoRival
  $cifraRival = Get-CifraRival $UltimoRival
  $tr = Get-TemaRonda -Estado $est
  # si el rival ha nombrado un tema concreto, ESE manda sobre el tema de la ronda:
  # así la contestación habla de lo que él ha sacado, no de un asunto paralelo.
  if ($tema) { $tr = @{ clave = $tr.clave; texto = $tema } }
  $script:TemaRonda = $tr
  $datos = Get-DramaDatos -Estado $est -Tema $tema -CifraRival $cifraRival -TemaRonda $tr.texto

  # ¿esta réplica lleva cifras o va de personaje? Exactamente 1 de cada 4.
  $tocaCifra = Test-TocaCifraProc -Agente $Agente
  $elegida = $null

  # 1) si toca cifra, va sí o sí: si no, la cuota de "una de cada cuatro" se
  #    queda en el intento.
  if ($tocaCifra) {
    $cif = @(Expand-Lista -Plantillas $script:PlantillasCifra[$Agente] -Datos $datos -Banda $banda -Ronda $est.ronda)
    $elegida = Select-SinRepetir -Agente $Agente -Lista $cif
  }

  # 2) cita literal del rival: el recurso más seguro para que se note que contesta
  if (-not $elegida -and $UltimoRival) {
    $eco = Get-EcoRival $UltimoRival
    if ($eco) {
      $datos['ECO_RIVAL'] = $eco
      $deEco = @(Expand-Lista -Plantillas $script:ContestacionesEco[$Agente] -Datos $datos -Banda $banda -Ronda $est.ronda)
      if ($deEco.Count -gt 0 -and (Get-Random -Maximum 100) -lt 50) {
        $elegida = Select-SinRepetir -Agente $Agente -Lista $deEco
      }
    }
  }

  # 3) anclaje al TEMA DE LA RONDA: así el respaldo discute de algo concreto.
  if (-not $elegida -and $UltimoRival) {
    $deTema = @(Expand-Lista -Plantillas $script:ContestacionesTema -Datos $datos -Banda $banda -Ronda $est.ronda)
    $deTema = @($deTema | Where-Object { Test-EnganchaRival -Texto $_ -Rival $UltimoRival })
    if ($deTema.Count -gt 0 -and (Get-Random -Maximum 100) -lt 60) {
      $elegida = Select-SinRepetir -Agente $Agente -Lista $deTema
    }
  }

  # 4) el cuerpo según el arco
  if (-not $elegida) {
    $cuerpo = @(Expand-Lista -Plantillas $script:Plantillas[$Agente][$banda] -Datos $datos -Banda $banda -Ronda $est.ronda)
    $elegida = Select-SinRepetir -Agente $Agente -Lista $cuerpo
  }

  # 5) genéricas: solo si no ha quedado nada
  if (-not $elegida -and $UltimoRival) {
    $gen = @(Expand-Lista -Plantillas $script:ContestacionesGenericas -Datos $datos -Banda $banda -Ronda $est.ronda)
    $elegida = Select-SinRepetir -Agente $Agente -Lista $gen
  }

  # 6) último recurso: corta y neutra, como pidió el dueño
  if (-not $elegida) { $elegida = 'Tú y yo nos vemos en el mapa.' }

  $elegida = Set-InicialMayuscula $elegida
  # guardia final: Select-SinRepetir puede quedarse sin candidatos y devolver el
  # mismo trozo; una frase clavada dos veces seguidas en el chat canta muchísimo.
  if ($script:UltimoTexto[$Agente] -eq $elegida) { $elegida = 'Tú y yo nos vemos en el mapa.' }
  Add-Reciente -Agente $Agente -Texto $elegida
  return $elegida
}

# Reacción corta al recibir un bombazo. Usa las bajas reales del turno cuando el
# motor las conoce; si no, las acumuladas. Banco mínimo, igual que New-Drama.
function New-Golpe {
  param(
    [string]$Agente,
    [int]$Perdidas = 0,
    [string]$UltimoRival = ''
  )
  if (-not $script:Personas.ContainsKey($Agente)) { $Agente = 'rojo' }
  $est = Get-DramaEstado -Agente $Agente -Ratio 1.0 -Ronda 1
  $tema = Get-TemaRival $UltimoRival
  $datos = Get-DramaDatos -Estado $est -Tema $tema -PerdidasForzadas $Perdidas
  $tocaCifra = Test-TocaCifraProc -Agente $Agente

  $banco = @{
    rojo = @(
      'Vale, eso ha sido personal.'
      'Trampa. Que alguien mire las reglas.'
      'Duele, pero sigo en pie.'
      'Bonito golpe. No te va a servir de nada.'
    )
    azul = @(
      'Vale, me has pillado. No me lo esperaba.'
      'Eso ha sido personal, y lo apunto.'
      'Duele, no lo voy a negar.'
      'Buen golpe. Lástima que no te sirva de nada.'
    )
  }
  $cifra = @{
    rojo = 'Me has quitado {PERDIDAS} hombres y aún te contesto.'
    azul = 'Me has costado {PERDIDAS} hombres. Anotado.'
  }

  $candidatas = @()
  if ($tocaCifra) { $candidatas += $cifra[$Agente] }
  $candidatas += $banco[$Agente]
  if ($datos.ContainsKey('TEMA')) { $candidatas += 'Mucho {TEMA} y luego el golpe por la espalda.' }

  $elegidas = @(Expand-Lista -Plantillas $candidatas -Datos $datos -Banda 'perdiendo' -Ronda $est.ronda)
  $elegida = Select-SinRepetir -Agente $Agente -Lista $elegidas
  if (-not $elegida) { $elegida = 'Vale. Eso ha sido personal.' }

  $elegida = Set-InicialMayuscula $elegida
  Add-Reciente -Agente $Agente -Texto $elegida
  return $elegida
}

# La emoción del momento, a partir de la moral real del motor (0-100) y, si no
# está, del resultado acumulado. Así el emoji pega con cómo va la partida.
function Get-EmocionActual {
  param([string]$Agente)
  $moral = Get-DramaDato 'Moral'
  $m = $null
  try { if ($moral -and $null -ne $moral[$Agente]) { $m = [double]$moral[$Agente] } } catch { }
  if ($null -eq $m) {
    $est = Get-DramaEstado -Agente $Agente -Ratio 1.0 -Ronda 1
    if ($est.bajas -gt $est.perdidas * 1.5) { return 'euforia' }
    if ($est.perdidas -gt $est.bajas * 1.5) { return 'panico' }
    return 'pique'
  }
  if ($m -lt 30) { return 'panico' }
  if ($m -lt 45) { return 'rabia' }
  if ($m -lt 60) { return 'pique' }
  if ($m -lt 80) { return 'chuleria' }
  return 'euforia'
}

# Un emoji suelto, como mensaje propio, coherente con la emoción del momento.
function New-Emoji {
  param([string]$Agente, [string]$Emocion = '')
  if (-not $script:Personas.ContainsKey($Agente)) { $Agente = 'rojo' }
  $p = $script:Personas[$Agente]
  $e = if ($Emocion) { $Emocion } else { Get-EmocionActual -Agente $Agente }
  $lista = $null
  try { $lista = $p.emojis.$e } catch { }
  if (-not $lista -or $lista.Count -eq 0) { $lista = @($p.emojis.pique) }
  # no repetir el mismo emoji dos veces seguidas: el chat parecía atascado
  $otros = @($lista | Where-Object { $_ -ne $script:UltimoEmoji[$Agente] })
  if ($otros.Count -gt 0) { $lista = $otros }
  $emoji = Get-RandomDe $lista
  $script:UltimoEmoji[$Agente] = $emoji
  return $emoji
}
