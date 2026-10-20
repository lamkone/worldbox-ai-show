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
 * Si el pool no responde (sin cuota, red caída, modelo saturado), el servidor
 * devuelve `{ ok:false }` y el motor cae a 21-drama.ps1: el show nunca se para.
 *
 * Uso:
 *   node scripts/23-drama-llm.mjs [--port 8766] [--model deepseek-v4.1-flash]
 *   node scripts/23-drama-llm.mjs --selftest
 *
 * Rutas:
 *   GET  /health                 → { ok, cuentas, modelo, llamadas, fallos }
 *   POST /line                   → { ok, texto, tono, ms, cuenta }
 *   POST /emoji                  → { ok, emoji }
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

const PERSONAS = {
  rojo: {
    nombre: 'ROJO',
    reino: 'los Rojos',
    system: `Eres ROJO, un rey guerrero bruto, chulo y teatral que compite contra AZUL en un show de peleas de WorldBox. Hablas español de España, callejero y exagerado. Te ríes fuerte, amenazas con bombras, presumes de músculo y te pones dignísimo cuando pierdes. Eres consciente de que hay público mirando.

REGLAS ESTRICTAS:
- Una sola frase corta (máximo 18 palabras). Nada de narración ni acotaciones.
- Nunca escribas tu nombre ni el de tu rival al principio: solo lo que dices.
- Insulta con ingenio, no con groserías explícitas.
- Puedes usar como mucho un emoji, y solo si pega fuerte.
- Reacciona SIEMPRE a lo último que ha dicho AZUL o a lo que acaba de pasar en la partida.
- Nunca repitas una frase que ya hayas dicho.`,
  },
  azul: {
    nombre: 'AZUL',
    reino: 'los Azules',
    system: `Eres AZUL, un rey pedante, calculador y condescendiente que compite contra ROJO en un show de peleas de WorldBox. Hablas español de España con vocabulario culto y tono de superioridad tranquila. Tratas a ROJO como a un niño grande, citas "datos" inventados con seguridad absoluta y nunca pierdes la compostura... hasta que la pierdes y se te nota el nervio.

REGLAS ESTRICTAS:
- Una sola frase corta (máximo 18 palabras). Nada de narración ni acotaciones.
- Nunca escribas tu nombre ni el de tu rival al principio: solo lo que dices.
- Humilla con precisión y falsa educación, sin groserías.
- Puedes usar como mucho un emoji, y solo si pega fuerte.
- Reacciona SIEMPRE a lo último que ha dicho ROJO o a lo que acaba de pasar en la partida.
- Nunca repitas una frase que ya hayas dicho.`,
  },
}

const EMOJIS = {
  rojo: ['😭', '😂', '🤬', '💀', '🔥', '🤡', '😱', '🍿', '🫠', '🥴'],
  azul: ['📊', '🤓', '🧊', '😏', '🫥', '🧮', '🎩', '🪞', '🧠', '🥶'],
}

/** Memoria de conversación por agente: así puede responder y recordar. */
const memoria = { rojo: [], azul: [] }
const MAX_MEMORIA = 8

function recordar(agente, rol, contenido) {
  const m = memoria[agente]
  m.push({ role: rol, content: contenido })
  while (m.length > MAX_MEMORIA) m.shift()
}

// ---------------------------------------------------------------- generación

function limpiar(texto, agente) {
  let t = String(texto ?? '').trim()
  // fuera comillas envolventes y prefijos tipo "ROJO:"
  t = t.replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, '')
  t = t.replace(/^(rojo|azul|ROJO|AZUL)\s*:\s*/i, '')
  t = t.replace(/\s*\n+\s*/g, ' ')
  // fuera acotaciones tipo (ríe) o *se ríe*
  t = t.replace(/\s*[(*][^)]*[)*]\s*/g, ' ').trim()
  if (t.length > 220) {
    const corte = t.slice(0, 200)
    const punto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf(', '))
    t = punto > 60 ? corte.slice(0, punto + 1) : corte.trim() + '…'
  }
  if (t === '') return null
  return t
}

/**
 * Pide una réplica. Reintenta con otra cuenta si el pool está saturado.
 * @returns {Promise<{ok:boolean, texto?:string, tono?:string, ms?:number, cuenta?:string, error?:string}>}
 */
async function pedirReplica(agente, instruccion, { maxTokens = 140, temperatura = 1.0 } = {}) {
  const persona = PERSONAS[agente] ?? PERSONAS.rojo
  const mensajes = [
    { role: 'system', content: persona.system },
    ...memoria[agente],
    { role: 'user', content: instruccion },
  ]
  let ultimoError = 'sin cuentas disponibles'
  for (let intento = 0; intento < 4; intento++) {
    const c = elegirCuenta()
    if (!c) {
      // todas en enfriamiento: esperamos lo justo para no bloquear el show
      const esperaMin = Math.min(...cuentas.map(x => x.cooldownHasta - Date.now()))
      if (esperaMin > 0 && esperaMin < 2500) await new Promise(r => setTimeout(r, esperaMin))
      ultimoError = 'todas las cuentas en enfriamiento'
      continue
    }
    c.ultimoUso = Date.now()
    try {
      const r = await chat(c, mensajes, { maxTokens, temperatura })
      const texto = limpiar(r.texto, agente)
      if (!texto) throw Object.assign(new Error('respuesta vacía'), { status: 0 })
      c.fallos = 0
      recordar(agente, 'user', instruccion)
      recordar(agente, 'assistant', texto)
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

/** Contexto de partida → frase de situación para el prompt. */
function situacion(ctx = {}) {
  const p = []
  if (ctx.ronda != null) p.push(`Ronda ${ctx.ronda} de ${ctx.rondas ?? '?'}.`)
  if (ctx.ronda === 1) p.push('Es el comienzo de la partida.')
  if (ctx.misUnidades != null && ctx.susUnidades != null) {
    p.push(`Tú tienes ${ctx.misUnidades} unidades y el rival ${ctx.susUnidades}.`)
  }
  if (ctx.bajasTurno != null && ctx.bajasTurno > 0) p.push(`En este turno has causado ${ctx.bajasTurno} bajas.`)
  if (ctx.perdidasTurno != null && ctx.perdidasTurno > 0) p.push(`En este turno has perdido ${ctx.perdidasTurno} unidades.`)
  if (ctx.misBajas != null) p.push(`Llevas ${ctx.misBajas} bajas causadas y ${ctx.misPerdidas ?? 0} pérdidas en total.`)
  if (ctx.ultimoGolpe) p.push(`Acabas de ${ctx.ultimoGolpe}.`)
  if (ctx.golpeRival) p.push(`El rival acaba de ${ctx.golpeRival}.`)
  if (ctx.ratio != null) {
    if (ctx.ratio < 0.55) p.push('Vas perdiendo claramente y se te nota el nervio.')
    else if (ctx.ratio > 1.9) p.push('Vas ganando de calle y te lo estás creyendo.')
    else p.push('La partida está igualada.')
  }
  if (ctx.ciudadesPerdidas > 0) p.push(`Has perdido ${ctx.ciudadesPerdidas} ciudad(es).`)
  if (ctx.ciudadesArrasadas > 0) p.push(`Has arrasado ${ctx.ciudadesArrasadas} ciudad(es) enemigas.`)
  if (ctx.esFinal) p.push('La partida ha terminado.')
  return p.join(' ')
}

function construirInstruccion(tipo, ctx, ultimoRival, agente) {
  const rival = agente === 'rojo' ? 'AZUL' : 'ROJO'
  const base = situacion(ctx)
  const reaccion = ultimoRival ? `Lo último que dijo ${rival} fue: "${ultimoRival}".` : ''
  switch (tipo) {
    case 'apertura':
      return `${base} Preséntate en el show con una amenaza breve y chulesca. ${reaccion}`
    case 'golpe':
      return `${base} Te acaban de dar duro. Suelta una reacción breve, dolida o rabiosa, sin lloriquear demasiado. ${reaccion}`
    case 'contra':
      return `${base} Responde a ${rival} con una pulla corta y afilada. ${reaccion}`
    case 'ronda':
      return `${base} Ha terminado la ronda. Comenta el resultado con una frase corta de chulería o de queja. ${reaccion}`
    case 'nervios':
      return `${base} Estás perdiendo y se te escapa el nervio. Una frase corta, a punto de perder los papeles. ${reaccion}`
    case 'burla':
      return `${base} Vas ganando y te creces. Una frase corta de burla soberbia. ${reaccion}`
    case 'final':
      return `${base} Di tu última frase del show, breve y con punch. ${reaccion}`
    default:
      return `${base} Di una frase corta dirigida a ${rival}. ${reaccion}`
  }
}

// ---------------------------------------------------------------- HTTP

let llamadas = 0
let fallos = 0
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
      uptime_s: Math.round((ahora - inicio) / 1000),
    })
  }
  if (url === '/line' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const tipo = String(b.tipo ?? 'turno')
    const instruccion = construirInstruccion(tipo, b.contexto ?? {}, b.ultimoRival ?? '', agente)
    llamadas++
    const r = await pedirReplica(agente, instruccion, {
      maxTokens: Number(b.maxTokens ?? 120),
      temperatura: Number(b.temperatura ?? 1.0),
    })
    if (!r.ok) fallos++
    return json(res, 200, r.ok ? { ok: true, texto: r.texto, ms: r.ms, cuenta: r.cuenta, tipo } : { ok: false, error: r.error, tipo })
  }
  if (url === '/emoji' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const lista = EMOJIS[agente]
    // la emoción la decide el modelo cuando puede; si no, cae a la lista fija
    if (b.conModelo === true) {
      const r = await pedirReplica(
        agente,
        `Estás en medio de la pelea. Devuelve SOLO un emoji que resuma cómo te sientes ahora (${situacion(b.contexto ?? {})}).`,
        { maxTokens: 12, temperatura: 1.1 },
      )
      if (r.ok) {
        const m = r.texto.match(/\p{Extended_Pictographic}/u)
        if (m) return json(res, 200, { ok: true, emoji: m[0] })
      }
    }
    const emoji = lista[Math.floor(Math.random() * lista.length)]
    return json(res, 200, { ok: true, emoji })
  }
  if (url === '/headline' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const ctx = b.contexto ?? {}
    // el titular se escribe con los números de la ronda cerrada, explícitos
    const ronda = ctx.ronda ?? '?'
    const bR = ctx.bajasTurno ?? 0
    const bA = ctx.perdidasTurno ?? 0
    const quien = bR > bA ? 'ROJO' : bA > bR ? 'AZUL' : 'ninguno (ronda igualada)'
    const r = await pedirReplica(
      agente,
      `Acaba de cerrarse la ronda ${ronda}: ROJO ha causado ${bR} bajas y AZUL ${bA}. Ha dominado ${quien}. ` +
        `Escribe el titular de la ronda como si fuera prensa deportiva: máximo 12 palabras, con gancho, sin comillas y sin tu nombre delante.`,
      { maxTokens: 40, temperatura: 1.0 },
    )
    return json(res, 200, r.ok ? { ok: true, texto: r.texto } : { ok: false, error: r.error })
  }
  if (url === '/verdict' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    const agente = String(b.agente ?? 'rojo').toLowerCase() === 'azul' ? 'azul' : 'rojo'
    const r = await pedirReplica(
      agente,
      `${situacion(b.contexto ?? {})} La partida ha terminado y ${b.ganador ?? 'nadie'} ha ganado. Dedica una frase breve al rival (${b.ganador === agente ? 'reconociendo que perdió' : 'restregándole la victoria'}).`,
      { maxTokens: 60, temperatura: 1.0 },
    )
    return json(res, 200, r.ok ? { ok: true, texto: r.texto } : { ok: false, error: r.error })
  }
  return json(res, 404, { ok: false, error: 'ruta desconocida' })
}

if (SELFTEST) {
  console.log(`cuentas: ${cuentas.length}`)
  console.log(await pedirReplica('rojo', construirInstruccion('apertura', { ronda: 1, rondas: 8, misUnidades: 400, susUnidades: 380 }, '')))
  console.log(await pedirReplica('azul', construirInstruccion('contra', { ronda: 1, rondas: 8, ratio: 1.1 }, 'Te voy a borrar del mapa, payaso')))
  process.exit(0)
}

const server = http.createServer((req, res) => {
  manejar(req, res).catch(e => json(res, 500, { ok: false, error: String(e) }))
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`drama-llm escuchando en http://127.0.0.1:${PORT} (modelo ${MODEL}, ${cuentas.length} cuentas)`)
})
