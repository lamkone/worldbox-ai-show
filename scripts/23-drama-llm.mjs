#!/usr/bin/env node
/**
 * 23-drama-llm.mjs — el cerebro dramático del show.
 *
 * Dos IAs (ROJO y AZUL) se insultan en directo mientras sus ejércitos se matan
 * en WorldBox. En vez de frases prefijas, cada réplica la improvisa un modelo de
 * verdad: se llama al pool de cuentas que ya tiene DSH (workbuddy-vault), con el
 * mismo wire que usa el plugin dsh-connect-workbuddy (cabeceras CLI, triple de
 * conversación y SSE).
 *
 * La gracia no está en pedirle "una frase corta" al modelo (eso devuelve
 * ocurrencias sueltas), sino en DARLE UN BRIEFING CERRADO:
 *
 *   1. analizar()   convierte el contexto de la partida en un objeto con fase,
 *                   emoción, quién gana y las cifras reales ya en 1ª persona
 *                   ("te he causado 847 bajas"), para que el modelo no tenga que
 *                   deducir de quién son los números ni pueda inventárselos.
 *   2. tarea()      elige un ACTO DE HABLA concreto (pregunta retórica, amenaza,
 *                   corrección del rival...) y lo rota, para que no todas las
 *                   réplicas tengan la misma forma.
 *   3. arco()       fija el tono según la ronda: chulería → pique → crisis →
 *                   final. El show tiene que notarse que avanza.
 *   4. validar()    comprueba la respuesta: una sola frase, sin acotaciones, con
 *                   al menos una cifra real, que no repita la apertura de su
 *                   frase anterior y que no contradiga el resultado. Si falla,
 *                   se le pide UNA corrección diciéndole exactamente qué ha
 *                   incumplido.
 *
 * Si el pool no responde (sin cuota, red caída, modelo saturado), el servidor
 * devuelve `{ ok:false }` y el motor cae a 21-drama.ps1: el show nunca se para.
 *
 * Uso:
 *   node scripts/23-drama-llm.mjs [--port 8766] [--model deepseek-v4.1-flash]
 *   node scripts/23-drama-llm.mjs --selftest
 *
 * Rutas:
 *   GET  /health                 → { ok, cuentas, modelo, llamadas, fallos }
 *   POST /line                   → { ok, texto, tono, ms, cuenta, diagnostico }
 *   POST /emoji                  → { ok, emoji, emocion }
 *   POST /headline               → { ok, texto }
 *   POST /verdict                → { ok, texto }
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const BASE = 'https://www.workbuddy.ai'
const UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const VAULT = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'workbuddy-vault', 'global')
const REFRESH_PATH = '/v2/plugin/auth/token/refresh'
const CHAT_PATH = '/v2/chat/completions'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const PORT = Number(argOf('--port', process.env.DRAMA_PORT ?? 8766))
const MODEL = argOf('--model', process.env.DRAMA_MODEL ?? 'deepseek-v4.1-flash')
const SELFTEST = args.includes('--selftest')
const TIMEOUT_MS = Number(argOf('--timeout', 20000))

/**
 * Registro de fallos del cerebro: cada vez que una réplica no se puede improvisar
 * se apunta aquí (JSON por línea) para poder diagnosticar por qué. Es la prueba
 * de que NO se tira de frases prefijadas: si falla, la línea se queda en silencio.
 */
const REGISTRO_FALLOS = new URL('../reports/drama-fallos.log', import.meta.url)
function anotarFallo(obj) {
  try { fs.appendFileSync(REGISTRO_FALLOS, JSON.stringify(obj) + '\n') } catch { /* sin registro */ }
}

// ---------------------------------------------------------------- credenciales

/** Lee el pool de cuentas del vault de DSH. */
function leerCuentas() {
  const out = []
  let ficheros = []
  try {
    ficheros = fs.readdirSync(VAULT).filter(f => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of ficheros) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(VAULT, f), 'utf8'))
      const a = j.auth ?? {}
      if (!a.accessToken) continue
      out.push({
        id: f.replace(/\.json$/, ''),
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        uid: j.account?.uid ?? '',
        nickname: j.account?.nickname ?? '',
        domain: a.domain ?? 'www.workbuddy.ai',
        cooldownHasta: 0,
        fallos: 0,
      })
    } catch {
      /* fichero corrupto: se ignora */
    }
  }
  return out
}

const cuentas = leerCuentas()

/** La cuenta sana que lleva más tiempo sin usarse (round-robin con enfriamiento). */
function elegirCuenta() {
  const ahora = Date.now()
  const sanas = cuentas.filter(c => c.cooldownHasta <= ahora)
  if (sanas.length === 0) return null
  sanas.sort((a, b) => (a.ultimoUso ?? 0) - (b.ultimoUso ?? 0))
  return sanas[0]
}

// ---------------------------------------------------------------- wire upstream

function cabeceras(c, extra = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BASE,
    Referer: `${BASE}/`,
    'User-Agent': UA,
    'Content-Type': 'application/json',
    ...(c.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': c.uid }),
    'X-No-Enterprise-Id': '1',
    'X-Domain': c.domain,
    'X-Product': 'SaaS',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    Authorization: `Bearer ${c.accessToken}`,
    ...extra,
  }
}

/** Refresca el access token de una cuenta con su refresh token. */
async function refrescar(c) {
  if (!c.refreshToken) return false
  try {
    const r = await fetch(`${BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: BASE,
        Referer: `${BASE}/`,
        'User-Agent': UA,
        'X-Refresh-Token': c.refreshToken,
        'X-Auth-Refresh-Source': 'workbuddy',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return false
    const j = await r.json()
    const token = j?.data?.accessToken ?? j?.accessToken ?? j?.data?.token
    if (!token) return false
    c.accessToken = token
    return true
  } catch {
    return false
  }
}

/**
 * Una llamada de chat. Devuelve el texto completo y los ms hasta el primer token.
 * Lanza con `.status` y `.motivo` cuando el upstream contesta error.
 */
async function chat(c, mensajes, { maxTokens = 160, temperatura = 1.0 } = {}) {
  const cuerpo = JSON.stringify({
    model: MODEL,
    stream: true,
    temperature: temperatura,
    max_tokens: maxTokens,
    messages: mensajes,
  })
  const t0 = Date.now()
  let r
  try {
    r = await fetch(`${BASE}${CHAT_PATH}`, {
      method: 'POST',
      headers: cabeceras(c),
      body: cuerpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const err = new Error(`transporte: ${e}`)
    err.status = 0
    throw err
  }
  if (!r.ok) {
    const texto = (await r.text().catch(() => '')).slice(0, 400)
    const err = new Error(`HTTP ${r.status}: ${texto}`)
    err.status = r.status
    err.cuerpo = texto
    throw err
  }
  // SSE: cada línea `data: {...}` trae un delta; `[DONE]` cierra.
  const lector = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let texto = ''
  let ttft = null
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lineas = buf.split('\n')
    buf = lineas.pop() ?? ''
    for (const linea of lineas) {
      const s = linea.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (payload === '[DONE]') continue
      let j
      try {
        j = JSON.parse(payload)
      } catch {
        continue
      }
      const d = j.choices?.[0]?.delta
      const trozo = d?.content
      if (typeof trozo === 'string' && trozo !== '') {
        texto += trozo
        if (ttft === null) ttft = Date.now() - t0
      }
    }
  }
  return { texto, ttft, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- personas

/**
 * Las reglas duras van en el system para que valgan en TODAS las llamadas
 * (réplica, emoji, titular, veredicto). Lo que cambia por turno va en la
 * instrucción de usuario.
 */
const REGLAS_DURAS = `REGLAS BÁSICAS:
- Escribes SOLO lo que dices en voz alta: ni narración, ni acotaciones, ni tu nombre delante.
- Nunca explicas la situación: la usas.
- Cero groserías gruesas.`

/**
 * Las dos voces del show.
 *
 * OJO: aquí NO hay listas de palabras ni frases de ejemplo. El dueño pilló que el
 * modelo repetía siempre los mismos insultos ("flipao", "cuentista", "fantasma",
 * "postureo") y venían de estas listas del prompt: el modelo las copiaba. La voz
 * se describe con carácter y sintaxis; las palabras las elige el modelo en cada
 * réplica, que es justo lo que se pide (improvisar).
 */
const PERSONAS = {
  rojo: {
    nombre: 'ROJO',
    reino: 'los Rojos',
    caracter: 'macarra de barrio: chulo, bocazas, cero cultura',
    forma: 'frase corta y seca, chulería de barrio, cero palabras cultas',
    system: `Eres ROJO, rey de los Rojos, en un show de peleas de WorldBox contra AZUL. Macarra de barrio: chulo, bocazas, cero cultura. Hablas como se pica la gente en un grupo de WhatsApp, en español de España de 2026. Frase corta y seca, chulería de barrio, cero palabras cultas. Nada de tebeo. No uses siempre los mismos insultos: cada frase, la tuya.

${REGLAS_DURAS}`,
  },
  azul: {
    nombre: 'AZUL',
    reino: 'los Azules',
    caracter: 'cuñao listillo moderno: condescendiente y sarcástico',
    forma: 'ironía seca y condescendencia de cuñao, cero vocabulario académico',
    system: `Eres AZUL, rey de los Azules, en un show de peleas de WorldBox contra ROJO. Cuñao listillo moderno: condescendiente, sarcástico, se cree más listo que nadie. Escribes como el que corrige a todo el mundo en Twitter, en español de España de 2026. Ironía seca, frase corta. NO eres un profesor. No repitas las mismas muletillas: cada frase, la tuya.

${REGLAS_DURAS}`,
  },
}

/** Ya no se inyectan frases de ejemplo: el modelo copiaba el vocabulario. */
const EJEMPLOS = { rojo: [], azul: [] }

/** Lo que NO vale. Se enseñan siempre: son la prohibición explícita. */
const ANTIEJEMPLOS = [
  'Nuevo plan: nada de planes. Que eso también cuenta como plan, ¿no?',
  'Eso se llama "búsqueda aleatoria". Lo estudié. Tú lo estás viviendo.',
  '¡No estoy llorando! ¡Se me ha metido una cordillera en el ojo!',
  'Tus datos no sustentan tu hipótesis, querido mastuerzo.',
  'Ja, ja... qué gracioso, puf, bah.',
]

/**
 * Calibración de tono. Ya no rota: dos frases neutras por personaje y punto.
 * El modelo copia lo que ve, así que cuanto menos material, menos se pega.
 */
function ejemplosDe(agente) {
  return EJEMPLOS[agente] ?? EJEMPLOS.rojo
}

// ---------------------------------------------------------------- análisis del contexto

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Cifras en letras, para detectar si una réplica cita un número escrito con palabras. */
const CIFRA_EN_LETRAS =
  /\b(cero|un[oa]?s?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|cientos|mil|mill[oó]n|millones|billon)\b/i

const tieneCifra = t => /\d/.test(t) || CIFRA_EN_LETRAS.test(t)

/** Palabras con las que el modelo suele arrancar; sirven para prohibir repeticiones. */
function aperturaDe(texto) {
  const palabras = String(texto ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return palabras.slice(0, 2).join(' ')
}

/**
 * Muletillas con las que el modelo arranca casi siempre ("Oye, …", "Mira, …",
 * "Enhorabuena por …", "Falso: …"). Prohibir sólo la apertura exacta no basta:
 * cambia la palabra y repite la fórmula. Esto caza la fórmula.
 */
const MULETILLAS = [
  'oye', 'mira', 'escucha', 'vaya', 'bueno', 'vale', 'cierto', 'total', 'resumen',
  'balance', 'cuenta', 'falso', 'claro', 'hombre', 'anda', 'venga', 'pues',
  'verdad', 'ojo', 'atento', 'conste', 'dime', 'anda', 'hombre',
]

function muletillaDe(texto) {
  const m = String(texto ?? '').trim().match(/^([\p{L}]+)\s*[,:]/u)
  if (!m) return ''
  const w = m[1].toLowerCase()
  return MULETILLAS.some(x => w === x || w.startsWith(x)) ? w : ''
}

/** Último emoji que usó cada agente, para no repetirlo en la réplica siguiente. */
const ultimoEmoji = { rojo: '', azul: '' }

/**
 * Recorta la muletilla de arranque. El modelo, aunque se le prohíba, arranca
 * casi siempre con "Oye, …" / "Mira, …" / "Escucha, …" / "Falso: …" / "Balance: …":
 * cambia la palabra pero repite la fórmula, y eso es justo lo que el dueño
 * llamaba "frases que empiezan todas igual". Se quita SIEMPRE, así la frase
 * empieza por el contenido y la variedad no depende de que el modelo obedezca.
 */
function desmuletillar(texto) {
  const t = String(texto ?? '').trim()
  const m = t.match(/^([\p{L}]+)\s*[,:]\s*/u)
  if (!m) return t
  const w = m[1].toLowerCase()
  if (!MULETILLAS.some(x => w === x || w.startsWith(x))) return t
  const resto = t.slice(m[0].length)
  if (!resto) return t
  // ojo: la frase puede empezar por "¿", "¡", comillas…; hay que subir la
  // primera LETRA, no el primer carácter, o queda "¿cuarenta bajas…"
  return resto.replace(/^([^\p{L}]?)(\p{L})/u, (_, pre, ch) => pre + ch.toUpperCase())
}

/**
 * Convierte el contexto crudo del motor en un briefing utilizable.
 *
 * El motor manda (ver 22-director.ps1 / Get-ContextoDrama):
 *   ronda, rondas, misUnidades, susUnidades, ratio, misBajas, misPerdidas,
 *   bajasTurno, perdidasTurno, ultimoGolpe, golpeRival, moral, tension, esFinal
 *
 * Ojo: en el cierre de partida el director llama con Obs = $null, así que
 * misUnidades/susUnidades llegan a 0 y ratio a 1. En ese caso el ganador se
 * deduce de las bajas acumuladas, que sí son reales.
 */
function analizar(ctx = {}) {
  const ronda = num(ctx.ronda)
  const rondas = num(ctx.rondas)
  const misU = num(ctx.misUnidades) ?? 0
  const susU = num(ctx.susUnidades) ?? 0
  const misB = num(ctx.misBajas) ?? 0
  const misP = num(ctx.misPerdidas) ?? 0
  const bajasT = num(ctx.bajasTurno) ?? 0
  const perdidasT = num(ctx.perdidasTurno) ?? 0
  const moral = num(ctx.moral)
  const tension = num(ctx.tension)
  const esFinal = !!ctx.esFinal

  let ratio = num(ctx.ratio)
  if (!(ratio !== null && ratio > 0)) ratio = susU > 0 ? misU / susU : null

  const sinUnidades = !(misU > 0) && !(susU > 0)

  // ¿va ganando? Primero por unidades; si no hay observación, por bajas.
  let gana = null
  if (ratio !== null) {
    if (ratio >= 1.25) gana = true
    else if (ratio <= 0.8) gana = false
  }
  if (gana === null && sinUnidades && misB + misP > 0) {
    if (misB > misP * 1.2) gana = true
    else if (misP > misB * 1.2) gana = false
  }

  // fase del arco dramático
  let fase
  if (esFinal) fase = 'final'
  else if (ronda !== null && ronda <= 1) fase = 'apertura'
  else if (rondas > 0 && ronda !== null && ronda >= rondas - 1) fase = 'final'
  else if (rondas > 0 && ronda !== null && ronda >= Math.ceil(rondas * 0.6)) fase = 'crisis'
  else fase = 'pique'

  return {
    ronda, rondas, fase, esFinal,
    misU, susU, misB, misP, bajasT, perdidasT,
    ratio, gana, moral, tension,
    ultimoGolpe: String(ctx.ultimoGolpe ?? '').trim(),
    golpeRival: String(ctx.golpeRival ?? '').trim(),
    ciudadesPerdidas: num(ctx.ciudadesPerdidas) ?? 0,
    ciudadesArrasadas: num(ctx.ciudadesArrasadas) ?? 0,
    // nombres concretos (los rellena 22-director.ps1; '' si no hubo ciudad este turno)
    ciudadPerdida: String(ctx.ciudadPerdida ?? '').trim(),
    ciudadArrasada: String(ctx.ciudadArrasada ?? '').trim(),
    // cifras que el modelo PUEDE citar; cualquier otra es un invento. Sin esto
    // el validador no tenía contra qué contrastar y daba por falsas cifras
    // reales (420 bajas de la partida marcadas como inventadas).
    permitidos: [misU, susU, misB, misP, bajasT, perdidasT, ronda, rondas]
      .filter(v => Number.isFinite(v) && v > 0)
      .map(v => Math.round(v)),
  }
}

/**
 * Emoción dominante del momento. Manda el tipo de beat, pero el marcador la
 * modula: un "golpe" con 0.3 de ratio es pánico, no dignidad herida.
 */
function emocionDe(an, tipo = '') {
  const t = String(tipo ?? '').toLowerCase()
  const perdiendoMucho = an.gana === false && an.ratio !== null && an.ratio < 0.5

  if (an.fase === 'final' && (an.esFinal || t === 'final')) {
    if (an.gana === true) return 'triunfo'
    if (an.gana === false) return 'resignacion'
    return 'pique'
  }
  if (t === 'apertura') return 'chuleria'
  if (an.fase === 'apertura' && t !== 'golpe' && t !== 'nervios') return 'chuleria'
  if (t === 'nervios') return perdiendoMucho ? 'panico' : 'nervios'
  if (t === 'burla') return an.gana === true ? 'euforia' : 'chuleria'
  if (t === 'golpe') return perdiendoMucho ? 'panico' : 'dolor'
  if (t === 'contra') {
    if (perdiendoMucho) return 'rabia'
    if (an.gana === true) return 'chuleria'
    return 'pique'
  }
  // turno / ronda / desconocido
  if (an.gana === false) return an.fase === 'crisis' || perdiendoMucho ? 'panico' : 'rabia'
  if (an.gana === true) return an.ratio !== null && an.ratio > 3 ? 'euforia' : 'chuleria'
  return 'pique'
}

/**
 * Voz de cada registro. El motor (22-director.ps1, Get-Replica) etiqueta cada
 * réplica con un tono calculado a partir del ratio, SIN mirar el texto: por eso
 * salían líneas marcadas "llanto" que presumían. Aquí se replica la misma regla
 * y se le da al modelo la voz concreta que tiene que sonar, con ejemplos de
 * sintaxis, para que la etiqueta y el texto digan lo mismo.
 */
const VOZ = {
  llanto:
    'Estás a punto de romperte. Frases cortas y atropelladas, te contradices, buscas excusas malísimas, repites palabras. PROHIBIDO presumir o decir que dominas. PROHIBIDO negar que lloras o hablar de algo metido en el ojo: si estás mal, que se note en cómo hablas, no en una excusa de tebeo.',
  panico:
    'Pánico puro. Te tiembla todo, repites palabras, pides tregua y la retiras, amenazas que no te crees ni tú. PROHIBIDO cualquier chulería.',
  nervios:
    'Se te escapa el miedo por las grietas. Intentas sonar tranquilo y fallas a mitad de frase, te contradices. Nada de sentencias seguras.',
  rabia:
    'Rabia seca y orgullo herido. Escupes la frase, acusas de trampa, amenazas en corto. Dolor, no lástima, y cero autocompasión.',
  pique:
    'Pique de barrio. Pulla corta, directa, con mala leche. Ni lloras ni te creces: le tocas las narices y punto.',
  chuleria:
    'Chulería de barrio y a lo grande. Fanfarroneas, prometes palizas, te ríes de él. Seguro de ti mismo y sin complejos.',
  euforia:
    'Euforia de ganador. Te lo pasas bomba, humillas con alegría, te ríes de lo poco que le queda.',
  burla:
    'Burla fría y seca. Desprecio tranquilo, condescendencia de cuñao, te aburre tanta ventaja.',
}

/** El registro que el motor pondría a esta réplica (misma regla que 22-director). */
function registroDe(tipo, an) {
  const t = String(tipo ?? 'turno').toLowerCase()
  if (t === 'golpe') return an.gana === false ? 'rabia' : 'pique'
  if (t === 'nervios') return an.ratio !== null && an.ratio < 0.3 ? 'panico' : 'nervios'
  if (t === 'burla') return 'burla'
  if (an.esFinal) {
    if (an.gana === false) return 'llanto'
    if (an.gana === true) return 'euforia'
    return 'pique'
  }
  const r = an.ratio
  if (r !== null) {
    if (r < 0.35) return 'panico'
    if (r < 0.6) return 'llanto'
    if (r > 2.2) return 'euforia'
    if (r > 1.35) return 'chuleria'
  }
  if (an.gana === false) return 'rabia'
  return 'pique'
}

/** El arco: qué se nota en la voz según la ronda y el marcador. */
function arcoDe(an) {
  const g = an.gana
  switch (an.fase) {
    case 'apertura':
      return 'Es la presentación: chulería pura y amenaza de barrio. Todavía no ha pasado nada, así que presumes y avisas.'
    case 'final':
      if (g === true) return 'Es el cierre y has ganado: sentencia triunfal, regodeo, última palabra. Sin piedad y sin prisa.'
      if (g === false) return 'Es el cierre y has perdido: amargura y dignidad rota. Puedes buscar una excusa, pero NO digas que has ganado.'
      return 'Es el cierre y está igualadísimo: última pulla, todo o nada.'
    case 'crisis':
      if (g === false) return 'Vas en apuros serios y se te nota: hablas atropellado, buscas excusas, prometes venganzas y amenazas a la desesperada.'
      if (g === true) return 'Vas ganando y te creces: burla fría, desprecio elegante, te aburre tanta ventaja.'
      return 'Tramo final igualado: ya no hay tiempo de bromas, cada golpe puede decidir.'
    default:
      if (g === false) return 'Empiezas a ir por detrás: orgullo herido y mosqueo, pero todavía sin llorar.'
      if (g === true) return 'Vas por delante y te lo empiezas a creer: chulería con datos.'
      return 'Pique de media partida: ya hay heridos y cada frase es una amenaza concreta.'
  }
}

/**
 * Las cifras reales, ya conjugadas en primera persona y en frases completas.
 * Van en frases (no en "valor: etiqueta") porque el modelo se lía menos: así
 * sabe de quién es cada número sin tener que deducirlo.
 */
function cifrasDe(an) {
  const out = []
  const push = (v, frase) => {
    if (Number.isFinite(v) && v > 0 && !out.some(o => o.v === v)) out.push({ v, frase })
  }
  push(an.misB, `Le has causado ${an.misB} bajas en total.`)
  push(an.misP, `Has perdido ${an.misP} unidades en total.`)
  push(an.bajasT, `Este turno le has hecho ${an.bajasT} bajas.`)
  push(an.perdidasT, `Este turno has perdido ${an.perdidasT} unidades.`)
  push(an.misU, `Te quedan ${an.misU} unidades.`)
  push(an.susU, `A él le quedan ${an.susU} unidades.`)
  push(an.ciudadesArrasadas, `Le has arrasado ${an.ciudadesArrasadas} ciudad(es).`)
  push(an.ciudadesPerdidas, `Has perdido ${an.ciudadesPerdidas} ciudad(es).`)
  return out
}

/**
 * Escala cualitativa de un ejército: da drama SIN soltar cifras.
 * Es clave: si el prompt enseña los números, el modelo los recita aunque le
 * prohíbas citarlos. Cuando la réplica no va de números se le da la escala en
 * palabras y se queda sin dígitos que copiar.
 */
function escala(n) {
  if (!Number.isFinite(n) || n <= 0) return 'nada'
  if (n < 60) return 'cuatro gatos'
  if (n < 200) return 'una tropa menguante'
  if (n < 600) return 'un ejército decente'
  if (n < 1500) return 'un ejército grande'
  return 'una marea de gente'
}

/**
 * Contexto de partida → frase de situación para el prompt.
 * Se mantiene el nombre y la firma originales (la usaban /emoji y /selftest).
 * `conCifras:false` cuenta lo mismo en palabras, sin ningún dígito: es lo que se
 * usa en las réplicas que NO van de números (3 de cada 4), para que no haya nada
 * que recitar.
 */
function situacion(ctx = {}, an = null, { conCifras = true } = {}) {
  const a = an ?? analizar(ctx)
  const p = []

  if (conCifras && a.ronda != null) p.push(`Ronda ${a.ronda}${a.rondas ? ` de ${a.rondas}` : ''}.`)
  p.push(`Fase del show: ${a.fase}.`)

  if (conCifras) {
    if (a.misU > 0 || a.susU > 0) {
      p.push(`Te quedan ${a.misU} unidades; el rival tiene ${a.susU}.`)
    }
    if (a.misB > 0 || a.misP > 0) {
      p.push(`Le has causado ${a.misB} bajas en total y tú has perdido ${a.misP}.`)
    }
    if (a.bajasT > 0) p.push(`Este turno le has hecho ${a.bajasT} bajas.`)
    if (a.perdidasT > 0) p.push(`Este turno has perdido ${a.perdidasT} unidades.`)
  } else {
    // sin dígitos: escala y quién va por delante, nada más
    if (a.misU > 0 || a.susU > 0) {
      p.push(`Tu ejército es ${escala(a.misU)}; el suyo, ${escala(a.susU)}.`)
    }
    if (a.misB > 0 || a.misP > 0) {
      p.push(
        a.misB > a.misP
          ? 'Le has hecho más daño del que has recibido.'
          : a.misP > a.misB
            ? 'Te ha hecho más daño del que le has hecho.'
            : 'El daño está empatado.',
      )
    }
    if (a.bajasT > 0 && a.perdidasT > 0) {
      p.push(
        a.bajasT > a.perdidasT
          ? 'En este turno has ganado el intercambio.'
          : a.perdidasT > a.bajasT
            ? 'En este turno has salido perdiendo el intercambio.'
            : 'En este turno el intercambio ha sido parejo.',
      )
    } else if (a.bajasT > 0) {
      p.push('En este turno le has dado un buen mordisco.')
    } else if (a.perdidasT > 0) {
      p.push('En este turno te han dado un buen mordisco.')
    }
  }

  if (a.ultimoGolpe) p.push(`Acabas de ${a.ultimoGolpe}.`)
  if (a.golpeRival) p.push(`El rival acaba de ${a.golpeRival}.`)
  if (a.ciudadesArrasadas > 0) {
    p.push(
      conCifras
        ? `Has arrasado ${a.ciudadesArrasadas} ciudad(es) suya(s).`
        : 'Le has arrasado ciudades suyas.',
    )
  }
  if (a.ciudadesPerdidas > 0) {
    p.push(conCifras ? `Has perdido ${a.ciudadesPerdidas} ciudad(es).` : 'Has perdido ciudades.')
  }

  if (a.gana === false) p.push('VAS PERDIENDO.')
  else if (a.gana === true) p.push('VAS GANANDO.')
  else p.push('La partida está igualada.')

  return p.join(' ')
}

// ---------------------------------------------------------------- variedad

/**
 * Actos de habla. Se rotan por agente para que dos réplicas seguidas no tengan
 * la misma forma (que es lo que hace que el chat suene a plantilla).
 * OJO: aquí NO se piden cifras. Antes ponía "suelta ya una cifra", "con nombre
 * y cifra", "clávale el marcador"… y el resultado era un balance contable en
 * cada línea. Los números se piden aparte y solo de vez en cuando.
 */
const TAREAS = {
  apertura: [
    'Dile quién manda aquí y que se vaya preparando, sin rodeos.',
    'Menosprecia su reino en una frase y avísale de lo que le viene encima.',
    'Presume de lo tuyo y déjale claro que él no está a tu altura.',
    'Suelta una amenaza concreta con nombre de lo que le vas a hacer.',
    'Dale la bienvenida al show con condescendencia, como si te diera pena.',
  ],
  turno: [
    'Cógele una palabra de su última frase y devuélvesela retorcida.',
    'Dile que lo que acaba de hacer no impresiona a nadie.',
    'Acúsale de una cosa concreta y exígele que lo explique.',
    'Hazle una pregunta seca que le deje sin respuesta.',
    'Dile a la cara que va de algo que no es.',
    'Menosprecia lo que acaba de hacer con dos palabras bien puestas.',
  ],
  contra: [
    'Devuélvele la pulla dándole la vuelta a su propia frase.',
    'Cógele la palabra que acaba de usar y úsala en su contra.',
    'Dale la razón con retintín y remátalo en la misma frase.',
    'Contéstale con otra pregunta que le deje peor.',
    'Dile que eso ya lo dijo otro y que a ti no te impresiona.',
  ],
  golpe: [
    'Reacciona al daño con rabia seca y una amenaza concreta.',
    'Nombra exactamente lo que te ha roto y avisa de que se lo cobras.',
    'Finge entereza mientras se te escapa el nervio por una grieta.',
    'Acúsale de tramposo y pide que alguien revise las reglas.',
    'Dile que eso no cambia nada mientras se te nota que sí.',
  ],
  nervios: [
    'Deja ver el miedo con una excusa mala y una amenaza que no te crees.',
    'Empieza seguro y contradícete a mitad de frase.',
    'Intenta parecer tranquilo y falla: que se note el pánico.',
    'Pide una tregua y retírala en la misma frase.',
  ],
  burla: [
    'Desprecia lo poco que le queda, sin ganas y sin prisa.',
    'Dile que te aburre ganar y descríbele lo que le espera.',
    'Ofrécele una piedad falsísima con un detalle humillante.',
    'Hazle un retrato seco de su reino en ruinas.',
  ],
  final: [
    'Última frase: cierra el show con una sentencia y la última palabra.',
    'Despídete del rival con una imagen que no se le olvide.',
    'Resume la velada en una sola frase lapidaria.',
    'Dale el pésame con retintín.',
  ],
  ronda: [
    'Comenta el cierre de ronda con chulería o mosqueo, según te vaya.',
    'Haz una crónica seca de lo que acaba de pasar en el mapa.',
  ],
}

/**
 * Cómo arrancar la frase. Se rota para que no empiecen todas igual.
 * OJO: aquí había "empieza con una onomatopeya", "con una comparación absurda",
 * "con una mentira escandalosa"… y eso era justo lo que producía el registro de
 * tebeo que el dueño rechaza. Ahora son formas de arranque de una discusión real.
 */
const RECURSOS = [
  'Empieza con un insulto de una sola palabra y sigue.',
  'Empieza con una pregunta seca.',
  'Empieza negando lo que acaba de decir él.',
  'Empieza repitiéndole una palabra suya con retintín.',
  'Empieza con "Mucho … y luego nada".',
  'Empieza con una frase tajante de tres palabras como mucho.',
  'Empieza nombrando lo que él acaba de hacer, como si te diera risa.',
  'Empieza dirigiéndote a tu propio ejército, no a él.',
  'Empieza con un "¿En serio?" y remata.',
  'Empieza dándole la razón, y luego clávale el puñal.',
]

/**
 * Frases-modelo del patrón que hay que erradicar: "X contra mis Y",
 * "tus N bajas tuyas", "mis N unidades". Se detectan en el texto generado para
 * no encadenar dos réplicas con la misma estructura.
 */
const ESTRUCTURA_PATRONES = [
  { id: 'contra', re: /\d[\d.,]*\s*(contra|frente a|versus)\s*(mis|tus|míos|tuyos)/i },
  { id: 'bajas', re: /\d[\d.,]*\s*bajas\s*(tuyas|mías|suyas)/i },
  { id: 'unidades', re: /\d[\d.,]*\s*(unidades|tropas|hombres|tipos|tíos|bichos|soldados)/i },
  { id: 'marcador', re: /(mis|tus)\s+\d[\d.,]*\s*(contra|frente a)/i },
  { id: 'recuento', re: /\d[\d.,]*\s*(y|frente a|por)\s*(solo\s+)?\d[\d.,]*/i },
]

/** Firma de estructura de una réplica, para no repetir el molde dos veces seguidas. */
function estructuraDe(texto) {
  const t = String(texto ?? '')
  for (const p of ESTRUCTURA_PATRONES) if (p.re.test(t)) return p.id
  if (/^\s*[¿]/.test(t)) return 'pregunta'
  if (/^\s*[¡]/.test(t)) return 'exclamacion'
  const palabras = t.split(/\s+/).filter(Boolean).length
  if (palabras <= 4) return 'corta'
  return 'otra'
}

const contador = { rojo: 0, azul: 0 }

/**
 * ¿Esta réplica puede citar cifras? La MISMA decisión la usan el prompt y el
 * validador, así no pueden contradecirse.
 * Exactamente 1 de cada 4 (n % 4 === 3): ni una más. La tentación era abrir la
 * mano "solo cuando haya un golpe", pero hay golpes casi todos los turnos y el
 * chat volvía a ser un balance contable, que es justo lo que había que quitar.
 */
function tocaCifraEn(an, agente) {
  if (cifrasDe(an).length === 0) return false
  return (contador[agente] ?? 0) % 4 === 3
}

function rotar(lista, semilla) {
  if (!lista || lista.length === 0) return ''
  const i = Math.abs(Math.floor(semilla)) % lista.length
  return lista[i]
}

function tarea(tipo, agente, an) {
  const lista = TAREAS[String(tipo ?? '').toLowerCase()] ?? TAREAS.turno
  const n = contador[agente] ?? 0
  return rotar(lista, n + (an.ronda ?? 0))
}

/**
 * Los recursos se rotan con un contador GLOBAL, no por agente: con el contador
 * por agente los dos coincidían en el mismo turno y salían dos frases seguidas
 * con la misma forma ("¿Habéis oído, tropa?" / "Escuchadme bien, tropa:").
 */
let recursoIdx = 0
function recurso() {
  return rotar(RECURSOS, recursoIdx++)
}

// ---------------------------------------------------------------- memoria

/** Memoria de conversación por agente: así puede responder y recordar. */
const memoria = { rojo: [], azul: [] }
const MAX_MEMORIA = 6
/** Frases ya dichas (para no repetirlas) y aperturas (para no empezar igual). */
const dichas = { rojo: [], azul: [] }
/** Muletilla que el modelo copia del prompt: "tu corte" / "tu capital". */
const CORTE_RE = /tu corte|tu capital/i
const aperturas = { rojo: [], azul: [] }
const MAX_DICHAS = 6

/**
 * Comparaciones que el modelo repite en cuanto le das una: en una tanda salieron
 * "mercadillo", "boda" y "cola del pan" en seis de veinte frases. Se recuerdan
 * las últimas y se prohíben, para que cada réplica busque su propia imagen.
 */
const MOTIVOS = [
  'mercadillo', 'boda', 'cola del pan', 'cuchara', 'alfombra', 'orinal', 'parchís',
  'gallina', 'tenedor', 'estornudo', 'circo', 'feria', 'taberna', 'queso', 'chorizo',
  'escoba', 'sopa', 'sardina', 'burro', 'cabra', 'gallinero', 'matadero', 'carnicería',
  'pescadería', 'funeral', 'entierro', 'verbena', 'romería', 'huracán', 'volcán',
  'diluvio', 'cuchillo', 'cazuela', 'puchero', 'lavandería', 'pescado', 'azulejo',
]
const motivosRecientes = []

function motivosDe(texto) {
  const t = String(texto ?? '').toLowerCase()
  return MOTIVOS.filter(m => t.includes(m))
}

function anotarMotivos(texto) {
  for (const m of motivosDe(texto)) {
    const i = motivosRecientes.indexOf(m)
    if (i >= 0) motivosRecientes.splice(i, 1)
    motivosRecientes.push(m)
  }
  while (motivosRecientes.length > 6) motivosRecientes.shift()
}

function recordar(agente, rol, contenido) {
  const m = memoria[agente]
  m.push({ role: rol, content: contenido })
  while (m.length > MAX_MEMORIA) m.shift()
}

function anotarDicha(agente, texto) {
  const norm = String(texto ?? '').toLowerCase().trim()
  if (!norm) return
  dichas[agente].push(norm)
  while (dichas[agente].length > MAX_DICHAS) dichas[agente].shift()
  aperturas[agente].push(aperturaDe(texto))
  while (aperturas[agente].length > MAX_DICHAS) aperturas[agente].shift()
  anotarMotivos(texto)
  const ap = apodoDe(texto)
  if (ap) ultimoApodo[agente] = ap
  if (ap) {
    apodosRecientes.push(ap)
    while (apodosRecientes.length > 6) apodosRecientes.shift()
  }
  recientesGlobales.push(String(texto ?? ''))
  while (recientesGlobales.length > 6) recientesGlobales.shift()
}

/**
 * Últimas frases del chat, de CUALQUIERA de los dos: si una réplica clona cuatro
 * palabras seguidas de otra reciente, es la misma imagen reciclada y el pique se
 * nota falso. La lista de MOTIVOS es cerrada y se le escapan inventos nuevos.
 */
const recientesGlobales = []
function shingles4(texto) {
  const w = String(texto ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const s = new Set()
  for (let i = 0; i + 3 < w.length; i++) s.add(w.slice(i, i + 4).join(' '))
  return s
}

// ------------------------------------------------------- pelea sobre algo concreto

/**
 * Palabras de contenido (sustantivos, verbos, adjetivos): fuera stopwords y
 * palabras cortas. Es la base del chequeo "esto contesta a lo que dijo".
 */
const STOPWORDS = new Set(
  (
    'para como esto otro otra todo toda nada poco mucho cada cuando donde porque aunque ' +
    'tambien tampoco desde hasta entre sobre bajo tras ante contra segun sino solo aun pero ' +
    'pues que quien cual cuyo este esta estos estas ese esa esos esas aquel aquella eso mismo ' +
    'misma ahora antes despues luego entonces asi alla aqui alli bien mal hace tener tiene ' +
    'tienes vamos vais estan estoy estas estais ser somos sois era eran fue fueron sido ' +
    'siendo tengo tienes tiene tenemos teneis tienen voy vas va van ir ver visto decir dicho ' +
    'hacer hecho puede puedo puedes pueden quiero quieres quiere quieren sabe sabes saben'
  ).split(' '),
)
function palabrasSignificativas(texto) {
  return new Set(
    String(texto ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w)),
  )
}

/**
 * Raíces de 5 letras de las palabras de contenido. Comparar palabras exactas
 * fallaba con la morfología castellana ("prometo"/"prometes",
 * "aplaudidme"/"aplausos"): dos réplicas que SÍ se contestaban contaban como
 * non-sequitur. Con la raíz enganchan.
 */
function raices(texto) {
  return new Set([...palabrasSignificativas(texto)].map(w => w.slice(0, 5)))
}

/**
 * Humor meta o filosófico sobre el propio chat. Es EXACTAMENTE lo que el dueño
 * señaló como más random: «búsqueda aleatoria», «lo estudié», «eso cuenta como
 * plan». Una pelea no se define, se pelea.
 */
const META_RE =
  /(b[uú]squeda aleatoria|lo estudi|lo he estudiado|filos[oó]fic|en t[eé]rminos generales|sun tzu|conceptualmente|dial[eé]ctic|paradoja|disquisici[oó]n|humor meta|meta-humor|algoritmo|estad[ií]stic\w*|matem[aá]tic\w*|cuenta como plan|como un plan|es un plan|narrativa|libreto|gui[oó]n|teor[ií]a de|definici[oó]n|definir|concepto de|epistemolog)/i

/**
 * REGISTRO DE TEBEO ANTIGUO. El dueño lo señaló tal cual: «mentira podrida»,
 * «ja, ja...», «puf». Suena a cómic de los 90 y rompe la voz del personaje.
 */
const REGISTRO_INFANTIL_RE =
  /\b(mentira podrida|mastuerzo|zoquete|berzas|badulaque|mequetrefe|p[aá]nfilo|botarate|gazn[aá]piro|canalla|villano|bellaco|chaval|chavales|caramba|rec[oó]rcholis|por tutatis|ja\s*,\s*ja|jaja+|puf|bah|ejem)\b/i

/**
 * REGISTRO DE MANUAL. El otro extremo: AZUL hablaba como un catedrático, no como
 * un cuñao. «Tus datos no sustentan tu hipótesis» es el ejemplo que dio el dueño.
 */
const REGISTRO_FRIKI_RE =
  /\b(hip[oó]tesis|datos|dato|tendencia|tendencias|estad[ií]stic\w*|correlaci[oó]n|algoritmo|dial[eé]ctic\w*|conceptual\w*|variable|variables|probabilidad|matem[aá]tic\w*|metodolog[ií]a|inferencia|sesgo|percentil|muestras?|muestreo|emp[ií]ric\w*|axioma|silogismo|teorema|postulado)\b/i

/** La cordillera en el ojo: la frase concreta que citó el dueño. Cero apariciones. */
const CORDILLERA_RE = /\bcordilleras?\b/i

/**
 * Grosería de verdad. El dueño pidió mala leche sin insultos gruesos: "meando la
 * plaza" no es un pique, es una ordinariez, y no se puede publicar.
 */
const VULGAR_RE =
  /\b(meando|meo|mear|mierda|joder|jodid\w*|jodiendo|cagar|cagando|hostia|ostia|polla|coño|cojones|capullo|gilipollas|subnormal|imb[eé]cil|idiota|est[uú]pido|cerdo|asqueroso|cabr[oó]n\w*|pendejo|hijoputa|put[ao]\w*|maric[oó]n\w*|zorra|guarra|por donde te quepa|por el culo|a tomar por|me la suda)\b/i

/** Erratas que el modelo cuela de vez en cuando y se ven en el chat. */
const TYPOS = [
  [/\bfliplao\b/gi, 'flipao'],
  [/\bespavila\b/gi, 'espabila'],
  [/\bcuentitas\b/gi, 'cuentista'],
]

/**
 * Los apodos ("figura", "campeón", "majo"…) son un recurso buenísimo, pero el
 * modelo se engancha a uno y lo repite cuatro veces seguidas: el chat suena a
 * plantilla. Se recuerda el último de cada agente y se prohíbe encadenarlo.
 */
const APODOS = [
  'figura', 'campeón', 'campeon', 'majo', 'tronco', 'listillo', 'genio', 'artista',
  'fantasma', 'cuentista', 'flipao', 'payaso', 'pesao', 'cuñao', 'vendehumos',
  'farolero', 'postureo', 'relato',
]
const ultimoApodo = { rojo: '', azul: '' }
/** Apodos usados en las últimas frases de CUALQUIERA de los dos: si uno se
 *  repite, el chat suena a plantilla ("fantasma, fantasma, fantasma"). */
const apodosRecientes = []
function apodoDe(texto) {
  const x = String(texto ?? '').toLowerCase()
  return APODOS.find(a => new RegExp(`\\b${a}\\b`, 'i').test(x)) ?? ''
}

/**
 * Mayúscula pegada del rival: "a tus Figura le quedan temblando". El modelo copia
 * el fragmento del rival con su mayúscula y la frase queda rota.
 */
const APODO_MAYUS_RE =
  /\b(mis|tus|sus)\s+(Figura|Campe[oó]n|Majo|Tronco|Listillo|Genio|Artista|Fantasma|Cuentista|Flipao|Payaso|Pesao|Cu[ñn]ao|Vendehumos|Farolero)\b/

/**
 * TEMA ÚNICO de la ronda. Se deriva SOLO de ronda/rondas/esFinal, así que los dos
 * agentes discuten de lo mismo aunque sus cifras sean distintas. Es lo que
 * convierte dos frases sueltas en una pelea sobre algo concreto.
 */
function temaDeRonda(an, agente) {
  // Si el motor nos da el NOMBRE de una ciudad perdida o arrasada, ese es el
  // asunto de la ronda: una ciudad con nombre concreto da mucho más juego que
  // un contador. (El motor lo rellena; si aún no llega, cadena vacía y no pasa nada.)
  if (an.ciudadArrasada) {
    return (
      `TEMA ÚNICO DE LA RONDA: le has arrasado ${an.ciudadArrasada}. ` +
      'Restriégale esa ciudad por el nombre, di qué queda de ella y que se despida.'
    )
  }
  if (an.ciudadPerdida) {
    return (
      `TEMA ÚNICO DE LA RONDA: te ha quitado ${an.ciudadPerdida}. ` +
      'Exige explicaciones por esa ciudad por su nombre: que la devuelva o que se atenga.'
    )
  }
  const pool = an.esFinal ? ['final'] : ['bajas', 'arma', 'turno', 'marcador']
  const clave = pool[(((an.ronda || 1) * 3) + (an.rondas || 0)) % pool.length]
  switch (clave) {
    case 'bajas':
      return (
        `TEMA ÚNICO DE LA RONDA: las bajas. Tú le has causado ${an.misB} y llevas ${an.misP} perdidas. ` +
        'Discute SOBRE ESO: acúsale de algo concreto con esas cifras. No cambies de asunto.'
      )
    case 'arma':
      return an.ultimoGolpe || an.golpeRival
        ? `TEMA ÚNICO DE LA RONDA: el golpe ("${an.ultimoGolpe || an.golpeRival}"). ` +
            'Habla de ese ataque concreto: si fue una chapuza, si no mató nada, si te lo cobras.'
        : 'TEMA ÚNICO DE LA RONDA: las armas y los trucos que se están usando en el campo. Habla de eso.'
    case 'turno':
      return (
        `TEMA ÚNICO DE LA RONDA: el intercambio de este turno (${an.bajasT} bajas suyas, ${an.perdidasT} tuyas). ` +
        'Ese es el asunto de la discusión; no te vayas por las ramas.'
      )
    case 'marcador':
      return `TEMA ÚNICO DE LA RONDA: el marcador (${an.misU} tuyos frente a ${an.susU} suyos). Discute sobre eso.`
    default:
      return `TEMA ÚNICO DE LA RONDA: el resultado final (${an.gana ? 'has ganado' : 'has perdido'}). Remátalo.`
  }
}

/** Escalón de la pelea: cada réplica tiene que subir uno respecto a la anterior. */
const BEAT = {
  apertura:
    'APERTURA (provocación): abre el fuego con una pulla concreta y déjale claro de qué va la pelea.',
  turno:
    'INTERCAMBIO (réplica + acusación): cita lo que acaba de decir y acúsale de algo concreto: que miente, que presume, que se esconde.',
  contra:
    'INTERCAMBIO (contraataque): devuélvele su pulla subiendo el tono; no repitas su imagen, supérala.',
  golpe: 'CLÍMAX (amenaza): convierte el golpe en una amenaza personal y concreta.',
  burla: 'CLÍMAX (humillación): ya no discutes, te ríes de él y de lo que ha dicho.',
  nervios: 'JUSTIFICACIÓN: te está doliendo. Justifícate o disimula, pero que se te note el nervio.',
  final: 'SENTENCIA: cierra. Sentencia al rival si ganas; justifícate con dignidad si pierdes.',
}
function beatDe(tipo) {
  return BEAT[String(tipo ?? '').toLowerCase()] ?? BEAT.turno
}

/** ¿El rival termina en pregunta? Entonces hay que contestarla. */
function esPregunta(texto) {
  return /\?\s*[»"']?\s*$/.test(String(texto ?? '').trim())
}

/** ¿Se parece demasiado a algo que ya dijo? */
function repetida(agente, texto) {
  const norm = String(texto ?? '').toLowerCase().trim()
  const ap = aperturaDe(texto)
  return {
    frase: dichas[agente].includes(norm),
    apertura: ap !== '' && aperturas[agente].includes(ap),
  }
}

// ---------------------------------------------------------------- generación

const EMOJI_RE = /\p{Extended_Pictographic}/u

/** Limpia la respuesta cruda del modelo: comillas, prefijos, acotaciones, emojis de más. */
function limpiar(texto, agente) {
  let t = String(texto ?? '').trim()
  t = t.replace(/\r/g, ' ')
  // comillas envolventes y prefijos tipo "ROJO:"
  for (let i = 0; i < 3; i++) t = t.replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, '')
  t = t.replace(/^(rojo|azul)\s*[:\-—]\s*/i, '')
  // marcadores de markdown
  t = t.replace(/\*\*|__/g, '')
  // el prefijo "ROJO:" puede venir envuelto en markdown (**AZUL:**): se quita
  // otra vez DESPUÉS de limpiar los asteriscos, o se cuela en el chat.
  t = t.replace(/^(rojo|azul)\s*[:\-—]\s*/i, '')
  // acotaciones del tipo (ríe) / *se ríe*, solo si parecen indicaciones de escena
  t = t.replace(/(^|\s)[(*]([^)*]{0,40})[)*](?=\s|$)/g, (m, pre, dentro) => {
    const esAcotacion = !/\d/.test(dentro) && dentro.trim().split(/\s+/).length <= 4
    return esAcotacion ? pre : m
  })
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  // como mucho un emoji
  const emojis = [...t.matchAll(/\p{Extended_Pictographic}/gu)]
  if (emojis.length > 1) {
    const primero = emojis[0][0]
    t = t.replace(/\p{Extended_Pictographic}/gu, '')
    t = t.replace(/\s{2,}/g, ' ').trim() + ' ' + primero
  }
  // como mucho DOS frases: el validador lo exige y el chat pinta una sola línea
  const trozos = t.split(/(?<=[.!?…])\s+/).filter(Boolean)
  if (trozos.length > 2) t = trozos.slice(0, 2).join(' ').trim()
  // longitud: por debajo del límite del validador (190) o el corte lo garantiza.
  // Antes se cortaba a 200 y el validador rechazaba >190: toda frase entre 191 y
  // 200 caracteres era un fallo garantizado y el motor caía al procedural.
  if (t === '') return null
  // --- recorte limpio: máx 24 palabras y ~190 caracteres, SIEMPRE cerrando la
  //     frase. Antes se cortaba a mitad y salía «…que un saco de…», que en el
  //     chat se lee como un fallo de la herramienta, no como una pulla.
  const recortar = (txt, maxPalabras) => {
    const ws = txt.split(/\s+/).filter(Boolean)
    if (ws.length <= maxPalabras) return txt
    const cabeza = ws.slice(0, maxPalabras).join(' ')
    // 1) cortar por la última pausa fuerte (coma, punto y coma, dos puntos)
    const pausas = [...cabeza.matchAll(/[,;:](?=\s)/g)].map(m => m.index)
    if (pausas.length) {
      const trozo = cabeza.slice(0, pausas[pausas.length - 1]).trim()
      if (trozo.split(/\s+/).filter(Boolean).length >= 10) return trozo.replace(/[,;:]+$/, '') + '.'
    }
    // 2) si no hay pausa útil, quitar conectores/preposiciones que quedan colgando
    const palabras = ws.slice(0, maxPalabras)
    while (palabras.length > 8 && FIN_COLGANDO.test(palabras[palabras.length - 1])) palabras.pop()
    return palabras.join(' ').replace(/[,;:]+$/, '') + '.'
  }
  t = recortar(t, 20)
  if (t.length > 190) {
    const corte = t.slice(0, 178)
    const sp = corte.lastIndexOf(' ')
    t = (sp > 120 ? corte.slice(0, sp) : corte).replace(/[,;:]+$/, '') + '.'
  }
  // que la frase cierre: el modelo a veces se deja el punto final.
  // OJO: el emoji puede llevar selector de variación (🏖️ = U+1F3D6 + U+FE0F);
  // si no se incluye, el recorte deja el FE0F suelto y sale "🏖️." al revés.
  const EMO_FIN = /([\p{Extended_Pictographic}\uFE0F\u200D]+)$/u
  const emojiFinal = t.match(EMO_FIN)
  const cuerpo = emojiFinal ? t.slice(0, t.length - emojiFinal[0].length).trim() : t
  if (cuerpo && !/[.!?…]$/.test(cuerpo)) {
    // si abrió interrogación, tiene que cerrarla con "?": salían cosas como
    // "¿En serio que eso es un aviso y no un fallo tuyo." con punto final.
    const cierre = cuerpo.includes('¿') ? '?' : '.'
    t = cuerpo + cierre + (emojiFinal ? ' ' + emojiFinal[0] : '')
  }
  // y si abrió "¿" pero cerró con punto, se corrige la puntuación
  if (/¿/.test(t) && !/\?/.test(t)) {
    t = t.replace(/([\p{Extended_Pictographic}\uFE0F\u200D]*)\s*\.\s*([\p{Extended_Pictographic}\uFE0F\u200D]*)\s*$/u, '? $1$2').trim()
    if (!/\?/.test(t)) t = t.replace(/\.\s*$/, '?').trim()
  }
  // erratas típicas del modelo ("fliplao" por "flipao")
  for (const [re, bien] of TYPOS) t = t.replace(re, bien)
  // y si el modelo dejó "…🖍️.", el punto va ANTES del emoji (se hace al final,
  // cuando ya no queda nada que añada puntuación detrás).
  t = t
    .replace(/([\p{Extended_Pictographic}\uFE0F\u200D]+)\s*([.!?…])\s*$/u, (m, emo, p) => p + ' ' + emo)
    .trim()
  return t
}

/** Palabras que no pueden quedar colgando al final de una frase recortada. */
const FIN_COLGANDO =
  /^(de|del|la|el|los|las|un|una|unos|unas|que|y|o|u|con|sin|para|por|en|a|al|como|m[aá]s|mi|mis|tu|tus|su|sus|ni|pero|si|se|lo|le|les|me|te|nos|muy|tan|todo|toda)$/i

/**
 * El chiste del llanto. Es LITERALMENTE el ejemplo que el dueño puso como malo
 * («¡No estoy llorando! ¡Se me ha metido una cordillera en el ojo!»): prohibido.
 */
const BANIDO_RE =
  /\b(no estoy llorando|no lloro|no he llorado|se me ha metido .{0,25}en el ojo|tengo algo en el ojo|me ha entrado .{0,25}en el ojo|es el polvo|es una alergia)\b/i

/** Marcas de que la réplica se refiere EXPLÍCITAMENTE a lo que dijo el rival. */
const REFERENCIA_RE =
  /\b(dices|dir[aá]s|dijiste|dice|dijo|eso|esas palabras|lo que dices|t[uú] mismo|tu frase|presumes|presume|presumir|presumes|llamas|llam[aá]s|hablas|habl[aá]s|contestas)\b/i

const GANA_RE =
  /\b(he ganado|he vencido|gano yo|me llevo (el mapa|la corona)|soy el campe[oó]n|has perdido t[uú]|has perdido la partida)\b/i
const PIERDE_RE = /\b(he perdido la partida|he perdido el show|me has ganado|has ganado t[uú]|me rindo|estoy derrotado)\b/i

/** Fanfarronadas que no pueden salir si el registro es llanto/pánico/nervios. */
const CHULO_RE =
  /\b(soy invencible|soy el mejor|nadie puede conmigo|esto est[aá] ganado|ya he ganado|voy a ganar|te estoy aplastando|me r[ií]o de tu ej[eé]rcito|te voy a borrar del mapa)\b/i
/** Cifras escritas con letras (el modelo a veces no usa dígitos). */
const NUM_PALABRA_RE =
  /\b(cien|ciento|mil|mill[oó]n|doscient|trescient|cuatrocient|quinient|seiscient|setecient|ochocient|novecient|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\w*/i
const RECUENTO_RE = /\b(bajas|unidades|soldados|tropas|hombres|tipos|ciudades)\b/i

/**
 * Comprueba una réplica contra el briefing.
 * Devuelve la lista de problemas; vacía = válida.
 *
 * OJO: aquí ya NO se exige citar cifras. Esa obligación era la causa del
 * "balance contable": el validador rechazaba cualquier frase sin número y el
 * modelo aprendió a meter números en todas. Ahora la regla es la contraria.
 *
 * @param {string} tipo apertura|turno|golpe|nervios|burla|contra|final
 */
/**
 * Cifras escritas en letras ("mil cuatrocientas", "ochenta y seis"). El validador
 * solo miraba dígitos, así que un "ochenta y seis" por 860 se colaba como cifra
 * inventada. Se convierten a número para poder contrastarlas con las reales.
 */
const NUM_LETRAS = (() => {
  const m = {
    cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
    ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
    dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
    veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
    veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
    veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
    ochenta: 80, noventa: 90, cien: 100, ciento: 100,
    doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
    cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
    seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
    ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900, mil: 1000,
  }
  return m
})()

function numerosEnLetras(texto) {
  const toks = String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const vals = []
  let i = 0
  while (i < toks.length) {
    let j = i
    let acc = 0
    let total = 0
    let any = false
    let grande = false
    while (j < toks.length) {
      const w = toks[j]
      if (w === 'y' && any && NUM_LETRAS[toks[j + 1]] != null) {
        j++
        continue
      }
      const v = NUM_LETRAS[w]
      if (v == null) break
      any = true
      if (v === 1000) {
        total += (acc || 1) * 1000
        acc = 0
        grande = true
      } else {
        acc += v
        if (v >= 100) grande = true
      }
      j++
    }
    if (any && (j - i >= 2 || grande)) vals.push(total + acc)
    i = any ? j : i + 1
  }
  return vals
}

function validar(texto, an, agente, ultimoRival = '', tipo = 'turno', publico = false) {
  const problemas = []
  const t = String(texto ?? '').trim()
  if (!t) return ['la respuesta está vacía']

  // MISMO criterio de frase que limpiar(): si el modelo pega "frase.Otra" sin
  // espacio, aquí se cuenta como UNA frase (limpiar no la separa y no la recorta),
  // y contar de otra forma tiraba réplicas válidas al procedural.
  const frases = t.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean)
  const palabras = t.split(/\s+/).filter(Boolean).length
  if (frases.length > 2) problemas.push('son más de dos frases')
  // Tope del prompt nuevo: 20 palabras. limpiar() recorta con el mismo número.
  if (palabras > 20) problemas.push('es demasiado larga')
  // "Vale." o "Nos vemos en el mapa." son respuestas legítimas: no se exige mínimo.
  if (t.length > 190) problemas.push('es demasiado larga')
  if (/^(rojo|azul)\s*[:\-—]/i.test(t)) problemas.push('empieza con tu nombre')
  if (/\*/.test(t)) problemas.push('mete asteriscos o narración')
  if (/\([^)\d]{1,30}\)/.test(t)) problemas.push('mete acotaciones o narración')

  // --- cifras: pueden salir siempre, pero tienen que ser REALES ---
  const digitos = [...t.matchAll(/\d{1,6}/g)].map(m => Number(m[0]))
  const permitidos = new Set([
    ...(an.permitidos ?? []),
    ...[...String(ultimoRival ?? '').matchAll(/\d{1,6}/g)].map(m => Number(m[0])),
  ])
  const inventadas = digitos.filter(n => !permitidos.has(n))
  if (inventadas.length > 0) {
    problemas.push(`se inventa cifras que no son de la partida (${[...new Set(inventadas)].join(', ')})`)
  }
  // y las que escribe en letras, igual de vigiladas ("ochenta y seis" por 860)
  const inventadasLetras = numerosEnLetras(t).filter(n => !permitidos.has(n))
  if (inventadasLetras.length > 0) {
    problemas.push(`se inventa cifras que no son de la partida (${[...new Set(inventadasLetras)].join(', ')})`)
  }
  // el recuento "X contra Y" es el molde que hace que el chat parezca un balance
  if (/\b\d{1,6}\s+contra\s+(mis\s+|los\s+|sus\s+|tus\s+)?\d{1,6}\b/i.test(t)) {
    problemas.push('lees el marcador en voz alta ("X contra Y"): reacciona a lo que pasa, no recites cifras')
  }
  // comparaciones recicladas
  const motivosRepetidos = motivosDe(t).filter(m => motivosRecientes.includes(m))
  if (motivosRepetidos.length > 0) {
    problemas.push(`repite una comparación que ya se ha usado (${motivosRepetidos.join(', ')})`)
  }

  // "tu corte"/"tu capital" es la muletilla que el modelo copia del prompt: no
  // puede encadenarla dos turnos seguidos o el chat suena a plantilla.
  if (CORTE_RE.test(t) && CORTE_RE.test(dichas[agente].at(-1) ?? '')) {
    problemas.push('repite "tu corte"/"tu capital" dos veces seguidas: usa otra imagen')
  }

  const rep = repetida(agente, t)
  if (rep.apertura) problemas.push(`empieza igual que una de tus frases anteriores ("${aperturaDe(t)}")`)
  if (rep.frase) problemas.push('repites literalmente una frase que ya has dicho')

  // imagen calcada de una frase reciente (de cualquiera de los dos)
  const mios = shingles4(t)
  if (mios.size > 0) {
    for (const previa of recientesGlobales) {
      const suyos = shingles4(previa)
      const copia = [...mios].find(s => suyos.has(s))
      if (copia) {
        problemas.push(`repite una imagen calcada de una frase reciente ("${copia}")`)
        break
      }
    }
  }

  // --- ¿esto es una pelea de verdad? ---
  // (a) nada de humor meta/filosófico sobre el propio chat
  if (META_RE.test(t)) {
    problemas.push('es humor meta o filosófico sobre el propio chat: eso es relleno genérico, prohíbo')
  }
  // (a2) registro: ni tebeo de los 90 ni manual de universidad. Se nombra la
  //      palabra concreta para que la reparación sepa qué tachar.
  const inf = t.match(REGISTRO_INFANTIL_RE)
  if (inf) {
    problemas.push(`usa registro de tebeo antiguo ("${inf[0]}"): suena a cómic de los 90, prohíbo`)
  }
  const fri = t.match(REGISTRO_FRIKI_RE)
  if (fri) {
    problemas.push(`usa registro de manual/libro de texto ("${fri[0]}"): habla como una persona, no como un catedrático`)
  }
  if (CORDILLERA_RE.test(t)) {
    problemas.push('tira de la cordillera en el ojo, que es literalmente el ejemplo malo del dueño')
  }
  // (a3) ordinariez: se puede ser macarra sin ser grosero
  const vul = t.match(VULGAR_RE)
  if (vul) {
    problemas.push(`es una ordinariez ("${vul[0]}"): mala leche sí, grosería no`)
  }
  // (a4) mayúscula pegada del rival: "a tus Figura le quedan temblando"
  if (APODO_MAYUS_RE.test(t)) {
    problemas.push('pega una palabra con mayúscula copiada del rival y la frase queda rota: escríbela normal o cambia la frase')
  }
  // (a5) el mismo apodo dos turnos seguidos ("figura", "campeón", "majo"…)
  const ap = apodoDe(t)
  if (ap && ap === ultimoApodo[agente]) {
    problemas.push(`repites el mismo apodo que en tu frase anterior ("${ap}"): busca otro o quítalo`)
  }
  if (ap && apodosRecientes.filter(x => x === ap).length >= 2) {
    problemas.push(`el apodo "${ap}" ya ha salido ${apodosRecientes.filter(x => x === ap).length} veces seguidas: cambia de recurso`)
  }
  // (d) el chiste del llanto es el ejemplo malo del dueño, no se usa
  if (BANIDO_RE.test(t)) {
    problemas.push('tira del chiste del llanto o del "algo en el ojo", que es justo el ejemplo malo del dueño')
  }
  // (e) nada de hablar de uno mismo en tercera persona ("presento al rey ROJO")
  const yo = agente === 'rojo' ? 'rojo' : 'azul'
  if (new RegExp(`\\brey\\s+${yo}\\b`, 'i').test(t)) {
    problemas.push('hablas de ti mismo en tercera persona: eres tú, no un narrador')
  }
  // (f) ni del RIVAL en tercera persona: en un 1 contra 1 se le habla de tú.
  //     Salía "y su reino entero cabe en el mío", que suena a crónica, no a pique.
  const tercera = t.match(/\b(su|sus)\s+(reino|ej[eé]rcito|plaza|trono|capital|pueblo|gente|tropa|ciudad)\b/i)
  if (tercera) {
    problemas.push(`hablas del rival en tercera persona ("${tercera[0]}"): dile "tu reino", "tu ejército", háblale de tú`)
  }

  if (an.gana === false && GANA_RE.test(t)) problemas.push('dice que ha ganado, pero va perdiendo')
  if (an.gana === true && PIERDE_RE.test(t)) problemas.push('dice que ha perdido, pero va ganando')

  // --- modo público: se le habla a un ESPECTADOR, no al rival del juego ---
  if (publico) {
    const enemigo = t.match(/\b(tu|tus)\s+(reino|unidades|ej[eé]rcito|plaza|trono|capital|tropas)\b/i)
    if (enemigo) {
      problemas.push(
        `le hablas al espectador como si fuera el rival del juego ("${enemigo[0]}"): ` +
          'el rival es la otra IA; al público se le saluda, se le bromea o se le pide el voto',
      )
    }
    if (/\b(te voy a (arrasar|destruir|enterrar)|te arraso|te destruyo)\b/i.test(t)) {
      problemas.push('amenazas al espectador: no es tu enemigo, es el público')
    }
  }

  return problemas
}

/**
 * Pide una réplica. Reintenta con otra cuenta si el pool está saturado y, si la
 * respuesta incumple el briefing, pide UNA corrección explícita.
 * @returns {Promise<{ok:boolean, texto?:string, tono?:string, ms?:number, cuenta?:string, error?:string, reparado?:boolean}>}
 */
/**
 * Una llamada al pool, con reintento por otra cuenta si la actual está
 * saturada. Devuelve el texto ya limpio (o { ok:false }).
 */
async function pedirTexto(agente, listaMensajes, { maxTokens, temperatura }) {
  let ultimoError = 'sin cuentas disponibles'
  for (let intento = 0; intento < 6; intento++) {
    const c = elegirCuenta()
    if (!c) {
      // todas en enfriamiento: esperamos lo justo para no bloquear el show
      const esperaMin = cuentas.length ? Math.min(...cuentas.map(x => x.cooldownHasta - Date.now())) : 0
      if (esperaMin > 0 && esperaMin < 2500) await new Promise(r => setTimeout(r, esperaMin))
      ultimoError = 'todas las cuentas en enfriamiento'
      continue
    }
    c.ultimoUso = Date.now()
    try {
      const r = await chat(c, listaMensajes, { maxTokens, temperatura })
      const texto = limpiar(r.texto, agente)
      if (!texto) throw Object.assign(new Error('respuesta vacía'), { status: 0 })
      c.fallos = 0
      return { ok: true, texto, ms: r.ms, cuenta: c.nickname }
    } catch (e) {
      const status = e.status ?? 0
      const cuerpo = String(e.cuerpo ?? e.message ?? '')
      if (status === 401) {
        const ok = await refrescar(c)
        if (!ok) c.cooldownHasta = Date.now() + 10 * 60_000
      } else if (status === 429 || /14003|too many requests|busy|saturad/i.test(cuerpo)) {
        c.cooldownHasta = Date.now() + 20_000
      } else if (status === 403 || /credits exhausted|14018|insufficient/i.test(cuerpo)) {
        c.cooldownHasta = Date.now() + 30 * 60_000
      } else if (status === 0 || status >= 500) {
        c.cooldownHasta = Date.now() + 8_000
      } else {
        c.cooldownHasta = Date.now() + 30_000
      }
      c.fallos++
      ultimoError = `${status || 'red'} ${cuerpo.slice(0, 160)}`
    }
  }
  return { ok: false, error: ultimoError }
}

/** Problemas que hacen la réplica inservible (no solo mejorable). */
const GRAVES =
  /vacía|acotaciones|tu nombre|demasiado larga|más de dos frases|inventa cifras|registro de tebeo|registro de manual|ordinariez|cordillera|chiste del llanto|tercera persona|hablas al espectador/

/**
 * Pide una réplica. Si la respuesta incumple el briefing, pide UNA corrección
 * diciéndole exactamente qué ha incumplido; si aun así no vale, se queda con el
 * mejor intento (o devuelve ok:false para que el motor use el procedural).
 * @returns {Promise<{ok:boolean, texto?:string, ms?:number, cuenta?:string, error?:string, reparado?:boolean, problemas?:string[]}>}
 */
async function pedirReplica(agente, instruccion, opts = {}) {
  const {
    maxTokens = 140,
    temperatura = 0.9,
    analisis = null,
    ultimoRival = '',
    tipo = 'turno',
    publico = false,
    validarSalida = true,
  } = opts
  const persona = PERSONAS[agente] ?? PERSONAS.rojo
  const temp = Math.min(1.1, Math.max(0.5, Number(temperatura) || 0.9))
  const mensajes = [{ role: 'system', content: persona.system }, ...memoria[agente]]
  const base = [...mensajes, { role: 'user', content: instruccion }]

  const primero = await pedirTexto(agente, base, { maxTokens, temperatura: temp })
  if (!primero.ok) return primero

  const problemas = validarSalida && analisis ? validar(primero.texto, analisis, agente, ultimoRival, tipo, publico) : []
  if (problemas.length === 0) {
    recordar(agente, 'user', instruccion)
    recordar(agente, 'assistant', primero.texto)
    anotarDicha(agente, primero.texto)
    return { ...primero, reparado: false, problemas: [] }
  }

  // una sola corrección, diciéndole exactamente qué ha incumplido
  const correccion =
    `${instruccion}\n\n` +
    `TU INTENTO ANTERIOR ERA: "${primero.texto}"\n` +
    `NO VALE porque: ${problemas.join('; ')}.\n` +
    `Escribe OTRA frase distinta que cumpla todo lo anterior y corrija eso. Solo la frase.`
  const segundo = await pedirTexto(agente, [...base, { role: 'user', content: correccion }], {
    maxTokens,
    temperatura: Math.min(1.0, temp),
  })

  let elegido = primero
  let elegidosProblemas = problemas
  if (segundo.ok) {
    const p2 = validar(segundo.texto, analisis, agente, ultimoRival, tipo, publico)
    if (p2.length <= problemas.length) {
      elegido = segundo
      elegidosProblemas = p2
    }
  }

  // si lo elegido sigue siendo inservible, que decida el fallback procedural
  if (elegidosProblemas.some(p => GRAVES.test(p))) {
    return { ok: false, error: `respuesta inválida: ${elegidosProblemas.join('; ')}` }
  }

  recordar(agente, 'user', instruccion)
  recordar(agente, 'assistant', elegido.texto)
  anotarDicha(agente, elegido.texto)
  return { ...elegido, reparado: elegido !== primero, problemas: elegidosProblemas }
}

/** Contexto → bloque de instrucción. Este es el corazón del arreglo. */
/**
 * Réplica para un ESPECTADOR del chat en vivo. No es el rival del juego: no tiene
 * reino ni ejército. El showman le saluda, le bromea o le pide el voto.
 */
function construirInstruccionPublica(agente, nick, texto, ctx = {}) {
  const an = analizar(ctx)
  const p = PERSONAS[agente] ?? PERSONAS.rojo
  const quien = nick ? `«${nick}»` : 'un espectador'
  const lineas = []
  lineas.push(`Eres ${p.nombre}, rey de ${p.reino}, en un show de peleas de WorldBox. ${p.caracter}.`)
  lineas.push(`Hablas así: ${p.forma}.`)
  lineas.push(
    `Estás en el chat en vivo y te acaba de escribir ${quien}, un ESPECTADOR del público. ` +
      'No es tu rival del juego: no tiene reino, ni ejército, ni unidades.',
  )
  if (texto) lineas.push(`Te ha dicho: "${String(texto).slice(0, 160)}"`)
  lineas.push(
    'Contéstale al espectador como showman: salúdale por su nombre si lo sabes, bromea con él, ' +
      'pídele su opinión o su voto, dale complicidad. UNA frase corta (máximo 20 palabras), con tu carácter.',
  )
  lineas.push(
    'NO le trates como enemigo: prohibido "tu reino", "tus unidades", "te voy a arrasar" o cualquier cifra de la partida.',
  )
  if (an.ronda != null) {
    lineas.push(`Contexto del show (por si te sirve de tema): ronda ${an.ronda}${an.rondas ? ` de ${an.rondas}` : ''}.`)
  }
  lineas.push('FORMATO: sin comillas, sin acotaciones, sin tu nombre delante, un emoji como máximo.')
  return lineas.join('\n')
}

function construirInstruccion(tipo, ctx, ultimoRival, agente) {
  const an = analizar(ctx)
  const rival = agente === 'rojo' ? 'AZUL' : 'ROJO'
  const p = PERSONAS[agente] ?? PERSONAS.rojo
  const lineas = []

  // 1. quién eres (dos líneas, sin listas de vocabulario)
  lineas.push(`Eres ${p.nombre}, rey de ${p.reino}. ${p.caracter}.`)
  lineas.push(`Hablas así: ${p.forma}.`)

  // 2. el estado real de la partida: unidades, bajas, ciudades y resultado
  lineas.push(`ESTADO REAL: ${situacion(ctx, an, { conCifras: true })}`)

  // 3. lo que acaba de pasar en el mapa (los nombres de ciudad no están en situacion)
  const eventos = []
  if (an.ciudadArrasada) eventos.push(`le has arrasado ${an.ciudadArrasada}`)
  if (an.ciudadPerdida) eventos.push(`te ha quitado ${an.ciudadPerdida}`)
  if (eventos.length) lineas.push(`LO QUE ACABA DE PASAR: ${eventos.join('; ')}.`)

  // 4. lo que dijo el rival. Se le da, pero NO se le obliga a contestarle.
  const ur = String(ultimoRival ?? '').trim()
  if (ur) lineas.push(`${rival} acaba de decir: "${ur.slice(0, 200)}"`)

  // 5. el encargo: una frase, corta, reaccionando a lo que pasa
  lineas.push(
    'Di UNA sola frase corta (máximo 20 palabras) reaccionando a lo que acaba de pasar, como lo diría tu personaje. ' +
      (ur ? 'Puedes contestarle o ignorarlo, lo que te salga natural. ' : '') +
      'Si no hay nada interesante que decir, dilo simple. No inventes cifras: usa solo las del estado.',
  )
  lineas.push(
    'No leas el marcador en voz alta ("X contra Y", "tengo N y tú M"): eso suena a contabilidad, no a una persona. ' +
      'Y no reacciones siempre de la misma forma: unas veces amenaza, otras pregunta, otras contesta seco, otras se ríe.',
  )
  lineas.push('FORMATO: sin comillas, sin acotaciones, sin tu nombre delante, un emoji como máximo.')

  // 6. anti-repetición mínima: no se fuerza la gracia, solo que no se calque
  const previa = [...memoria[agente]].reverse().find(m => m.role === 'assistant')
  if (previa?.content) {
    lineas.push(`Tu frase anterior fue: "${String(previa.content).slice(0, 140)}". No la repitas ni empieces igual.`)
  }
  if (ultimoEmoji[agente]) lineas.push(`No repitas el emoji ${ultimoEmoji[agente]}.`)

  // 7. prohibiciones que siguen vigentes (las que pidió el dueño)
  lineas.push(
    'PROHIBIDO: humor meta o filosófico, definiciones, "búsqueda aleatoria", "lo estudié", ' +
      '"cordillera en el ojo", hablar de ti mismo en tercera persona.',
  )
  if (an.fase === 'final' && an.gana === false) {
    lineas.push('Ojo: has PERDIDO. No digas que has ganado.')
  }
  return lineas.join('\n')
}
// ---------------------------------------------------------------- emojis

const EMOJI_EMOCION = {
  panico: ['😱', '🫠', '😰', '🥴', '💀', '😭'],
  nervios: ['😬', '😤', '🫠', '😳', '🥴', '🙃'],
  rabia: ['🤬', '😡', '💢', '🔥', '😤', '🗯️'],
  dolor: ['💀', '😖', '😱', '💥', '🫠', '🥴'],
  pique: ['🙄', '😒', '🤨', '😑', '🍿', '🤌'],
  chuleria: ['😏', '😎', '🍿', '🤣', '😌', '🃏'],
  euforia: ['😂', '🏆', '💥', '🔥', '🤣', '😎'],
  triunfo: ['🏆', '👑', '😏', '💪', '😂', '🍿'],
  resignacion: ['😮‍💨', '😐', '🫠', '💀', '🙃', '🥀'],
}

/** Cada rey tiene su repertorio; se suma al de la emoción para que se le reconozca. */
const EMOJI_AGENTE = {
  rojo: ['💪', '🤬', '🔥', '💥', '🍿', '😤'],
  azul: ['📊', '🤓', '🧊', '😏', '🧮', '🎩'],
}

function emojisDe(agente, emocion) {
  // SOLO el repertorio de la emoción. Fusionar el del personaje metía 😤 en
  // "pánico" y 📊🤓 en la cara de AZUL, que es justo el registro friki vetado.
  return EMOJI_EMOCION[emocion] ?? EMOJI_EMOCION.pique
}

/** Emoción sin tipo de beat: para /emoji, que solo recibe el contexto. */
function emocionPorContexto(an) {
  if (an.fase === 'final') {
    if (an.gana === true) return 'triunfo'
    if (an.gana === false) return 'resignacion'
  }
  if (an.gana === false) return an.ratio !== null && an.ratio < 0.5 ? 'panico' : 'rabia'
  if (an.gana === true) return an.ratio !== null && an.ratio > 3 ? 'euforia' : 'chuleria'
  if (an.tension != null && an.tension > 70) return 'pique'
  return 'pique'
}

function elegirEmoji(agente, emocion) {
  const lista = emojisDe(agente, emocion)
  return lista[Math.floor(Math.random() * lista.length)]
}

// ---------------------------------------------------------------- HTTP

let llamadas = 0
let fallos = 0
let reparaciones = 0
const inicio = Date.now()

function json(res, code, obj) {
  const cuerpo = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(cuerpo)
}

function leerCuerpo(req) {
  return new Promise(resolve => {
    let d = ''
    req.on('data', c => {
      d += c
      if (d.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function diagnosticoDe(an, tipo, agente) {
  return {
    fase: an.fase,
    emocion: emocionDe(an, tipo),
    gana: an.gana,
    ratio: an.ratio != null ? Math.round(an.ratio * 100) / 100 : null,
    cifras: cifrasDe(an).map(c => c.v),
    agente,
  }
}

async function manejar(req, res) {
  const url = (req.url ?? '/').split('?')[0]
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    })
    res.end()
    return
  }
  if (url === '/health') {
    const ahora = Date.now()
    return json(res, 200, {
      ok: cuentas.length > 0,
      cuentas: cuentas.length,
      sanas: cuentas.filter(c => c.cooldownHasta <= ahora).length,
      modelo: MODEL,
      llamadas,
      fallos,
      reparaciones,
      uptime_s: Math.round((ahora - inicio) / 1000),
    })
  }
  if (url === '/line' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const tipo = String(b.tipo ?? 'turno')
    const ctx = b.contexto ?? {}
    const an = analizar(ctx)

    // ¿esto es una réplica al PÚBLICO o al rival del juego? La pasarela de chat
    // (25-live-gateway.mjs) manda los mensajes de visitantes como
    // `ultimoRival: "<nick> dice: <texto>"`, sin flag: se detecta ese formato
    // para no tratar al espectador como si tuviera reino y ejército.
    let publico = b.publico === true || b.esPublico === true || b.es_publico === true
    let nickPublico = String(b.nickPublico ?? b.nick ?? '').trim()
    let textoPublico = String(b.textoPublico ?? '').trim()
    if (!publico) {
      const m = String(b.ultimoRival ?? '').match(/^\s*([^:\n]{1,24}?)\s+dice:\s*([\s\S]+)$/i)
      if (m) {
        publico = true
        nickPublico = nickPublico || m[1].trim()
        textoPublico = textoPublico || m[2].trim()
      }
    }

    // el contador se incrementa ANTES de construir la instrucción
    contador[agente] = (contador[agente] ?? 0) + 1
    // Modo "suelta": petición mínima para cuando la réplica normal no pasó la
    // validación. Menos exigencias = más probabilidad de una frase válida. Es el
    // reintento del director; si esto también falla, la línea va en silencio.
    const simple = b.simple === true
    const instruccion = simple
      ? `Eres ${PERSONAS[agente].nombre}, ${PERSONAS[agente].caracter}. ` +
        'Escribe UNA sola frase corta (máximo 12 palabras) de pique para el chat, en tu voz y en español de España, ' +
        'sin cifras, sin nombres propios, sin comillas ni acotaciones. Solo la frase.'
      : publico
        ? construirInstruccionPublica(agente, nickPublico, textoPublico, ctx)
        : construirInstruccion(tipo, ctx, b.ultimoRival ?? '', agente)
    llamadas++
    const r = await pedirReplica(agente, instruccion, {
      maxTokens: Number(b.maxTokens ?? 120),
      temperatura: Number(b.temperatura ?? 0.9),
      analisis: an,
      ultimoRival: publico ? '' : (b.ultimoRival ?? ''),
      tipo,
      publico,
      validarSalida: !simple,
    })
    if (!r.ok) {
      fallos++
      anotarFallo({
        ts: new Date().toISOString(), agente, tipo, simple, publico,
        error: r.error, problemas: r.problemas ?? [],
      })
      return json(res, 200, {
        ok: false,
        error: r.error,
        tipo,
        publico,
        diagnostico: diagnosticoDe(an, tipo, agente),
      })
    }
    if (r.reparado) reparaciones++
    r.texto = desmuletillar(r.texto)
    const emojiUsado = (r.texto.match(/\p{Extended_Pictographic}/gu) ?? [])[0] ?? ''
    if (emojiUsado) ultimoEmoji[agente] = emojiUsado
    return json(res, 200, {
      ok: true,
      texto: r.texto,
      ms: r.ms,
      cuenta: r.cuenta,
      tipo,
      publico,
      nickPublico: publico ? nickPublico : undefined,
      reparado: !!r.reparado,
      diagnostico: { ...diagnosticoDe(an, tipo, agente), problemas: r.problemas ?? [] },
    })
  }
  if (url === '/emoji' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const an = analizar(b.contexto ?? {})
    const emocion = emocionPorContexto(an)
    const permitidos = emojisDe(agente, emocion)

    // la emoción la decide el modelo cuando puede; si no, cae a su repertorio
    if (b.conModelo === true) {
      const r = await pedirReplica(
        agente,
        `${situacion(b.contexto ?? {}, an)}\n` +
          `Emoción que estás sintiendo: ${emocion}.\n` +
          `Devuelve SOLO uno de estos emojis, el que mejor resuma cómo te sientes: ${permitidos.join(' ')}\n` +
          `Nada de texto, solo el emoji.`,
        { maxTokens: 12, temperatura: 0.7, validarSalida: false },
      )
      if (r.ok) {
        const m = String(r.texto).match(EMOJI_RE)
        // solo vale si pertenece al repertorio de la emoción: si no, es incoherente
        if (m && permitidos.includes(m[0])) return json(res, 200, { ok: true, emoji: m[0], emocion })
      }
    }
    return json(res, 200, { ok: true, emoji: elegirEmoji(agente, emocion), emocion })
  }
  if (url === '/headline' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const ctx = b.contexto ?? {}
    // OJO: el contexto llega en POV del agente que pide el titular, no en POV
    // de ROJO. `bajasTurno` son las bajas que ha causado ÉL, así que hay que
    // reetiquetar según quién pregunte o el titular atribuye las cifras al reino
    // equivocado.
    const ronda = ctx.ronda ?? '?'
    const causa = Number(ctx.bajasTurno ?? 0) || 0
    const recibe = Number(ctx.perdidasTurno ?? 0) || 0
    const bR = agente === 'rojo' ? causa : recibe
    const bA = agente === 'rojo' ? recibe : causa
    const quien = bR > bA ? 'ROJO' : bA > bR ? 'AZUL' : 'ninguno (ronda igualada)'
    const r = await pedirReplica(
      agente,
      `Acaba de cerrarse la ronda ${ronda}: ROJO ha causado ${bR} bajas y AZUL ${bA}. Ha dominado ${quien}.\n` +
        `Escribe el titular de la ronda como si fuera prensa deportiva: máximo 12 palabras, con gancho, ` +
        `sin comillas y sin tu nombre delante. Tiene que incluir las dos cifras (${bR} y ${bA}).`,
      { maxTokens: 40, temperatura: 0.9, validarSalida: false },
    )
    return json(res, 200, r.ok ? { ok: true, texto: r.texto } : { ok: false, error: r.error })
  }
  if (url === '/verdict' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const an = analizar(b.contexto ?? {})
    const ganador = String(b.ganador ?? '').toLowerCase()
    const hasGanado = ganador === agente
    const r = await pedirReplica(
      agente,
      `${situacion(b.contexto ?? {}, an)}\n` +
        `La partida ha terminado y ha ganado ${ganador ? ganador.toUpperCase() : 'nadie'}. ` +
        `${hasGanado ? 'HAS GANADO TÚ' : 'HAS PERDIDO TÚ'}. ` +
        `Cifras finales: le has causado ${an.misB} bajas y has perdido ${an.misP}.\n` +
        `Dedica una frase breve al rival: ${hasGanado ? 'restregándole la victoria con las cifras' : 'reconociendo que perdió, con dignidad rota y una excusa'}. ` +
        `Máximo 20 palabras, una sola frase.`,
      { maxTokens: 60, temperatura: 0.9, validarSalida: false },
    )
    return json(res, 200, r.ok ? { ok: true, texto: r.texto } : { ok: false, error: r.error })
  }
  return json(res, 404, { ok: false, error: 'ruta desconocida' })
}

// ---------------------------------------------------------------- arranque

if (SELFTEST) {
  console.log(`cuentas: ${cuentas.length}  modelo: ${MODEL}`)
  const casos = [
    ['rojo', 'golpe', { ronda: 3, rondas: 8, misUnidades: 420, susUnidades: 1034, misBajas: 315, misPerdidas: 847, ratio: 0.4, ultimoGolpe: 'lanzar la Bomba del Zar' }, 'Tus 340 bajas no las has visto ni en tus sueños, mastodonte.'],
    ['azul', 'contra', { ronda: 3, rondas: 8, misUnidades: 1034, susUnidades: 420, misBajas: 847, misPerdidas: 315, ratio: 2.46 }, 'Te voy a borrar del mapa, payaso'],
    ['rojo', 'nervios', { ronda: 7, rondas: 8, misUnidades: 140, susUnidades: 1200, misBajas: 500, misPerdidas: 2200, ratio: 0.12 }, 'Mi ejercito es una curva exponencial; el tuyo es un garabato.'],
  ]
  for (const [ag, tipo, ctx, ur] of casos) {
    const an = analizar(ctx)
    contador[ag] = (contador[ag] ?? 0) + 1
    const instruccion = construirInstruccion(tipo, ctx, ur, ag)
    console.log(`\n--- ${ag} / ${tipo} ---`)
    console.log(instruccion)
    const r = await pedirReplica(ag, instruccion, { analisis: an, ultimoRival: ur, tipo })
    console.log('>>', r.ok ? r.texto : `FALLO: ${r.error}`, r.problemas?.length ? `[problemas: ${r.problemas.join('; ')}]` : '')
  }
  const em = await pedirReplica('rojo', 'Devuelve solo un emoji de rabia.', { maxTokens: 12, validarSalida: false })
  console.log('\nemoji crudo:', em.ok ? em.texto : em.error)
  process.exit(0)
}

const server = http.createServer((req, res) => {
  manejar(req, res).catch(e => json(res, 500, { ok: false, error: String(e) }))
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`drama-llm escuchando en http://127.0.0.1:${PORT} (modelo ${MODEL}, ${cuentas.length} cuentas)`)
})
