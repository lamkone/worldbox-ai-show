#!/usr/bin/env node
/**
 * Pasarela del directo — un solo puerto que da TODO lo que necesita el visor.
 *
 * El problema que resuelve: el visor habla con tres servidores distintos
 * (visor estático en 8765, captura nativa en 8767, cerebro LLM en 8766). En
 * localhost eso se resuelve con puertos, pero detrás de un túnel (Cloudflare,
 * ngrok, localtunnel…) solo se publica UN puerto, y además el servidor del visor
 * usa HTTP.sys con prefijo `localhost`, así que rechaza cualquier otro Host.
 *
 * Esta pasarela escucha en un único puerto, enruta por ruta y reescribe el Host
 * a `localhost`, de modo que se puede tunelizar tal cual:
 *
 *   /stream.mjpg, /frame.jpg, /stats        -> 127.0.0.1:8767  (captura nativa)
 *   /line, /headline, /emoji, /health       -> 127.0.0.1:8766  (cerebro LLM)
 *   /api/chat                               -> hub de chat en memoria + disco
 *   todo lo demás                           -> 127.0.0.1:8765  (visor + estado)
 *
 * Añade CORS abierto para que la página publicada en GitHub Pages pueda pedir
 * los datos directamente si algún día se prefiere no usar iframe.
 *
 *   node scripts/25-live-gateway.mjs [--port 8770]
 *
 * Variables de entorno (solo para pruebas; en producción no hacen falta):
 *   WB_CHAT_FILE   ruta alternativa del JSON del chat
 *   WB_STATE_URL   URL alternativa de /state.json
 *   WB_FEED_URL    URL alternativa de /feed.json
 *   WB_TTS_PORT    puerto del servicio de voz (por defecto 8771)
 *   WB_BRAIN_URL   URL alternativa de /line
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(nombre, porDefecto) {
  const i = process.argv.indexOf(nombre);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

const PUERTO = Number(arg('--port', process.env.PORT || 8770));

const VISOR = { nombre: 'visor', host: '127.0.0.1', puerto: 8765 };
const STREAM = { nombre: 'stream', host: '127.0.0.1', puerto: 8767 };
const CEREBRO = { nombre: 'cerebro', host: '127.0.0.1', puerto: 8766 };
const TTS = { nombre: 'tts', host: '127.0.0.1', puerto: Number(process.env.WB_TTS_PORT || 8771) };

const RUTAS_STREAM = new Set(['/stream.mjpg', '/stream', '/frame.jpg', '/stats']);
const RUTAS_CEREBRO = new Set(['/line', '/headline', '/emoji', '/health']);
// /tts?t=<texto>&v=rojo|azul|sistema -> audio/mpeg con voces neuronales (tts-server.mjs)
const RUTAS_TTS = new Set(['/tts', '/precalentar']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS, HEAD',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400'
};

/* ========================================================================
 * Hub de chat
 * ===================================================================== */

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.resolve(AQUI, '..', 'reports');
const ARCHIVO_CHAT = process.env.WB_CHAT_FILE || path.join(REPORTS, 'live-chat.json');
const STATE_URL = process.env.WB_STATE_URL || 'http://localhost:8765/state.json';
const FEED_URL = process.env.WB_FEED_URL || 'http://localhost:8765/feed.json';
const BRAIN_URL = process.env.WB_BRAIN_URL || 'http://127.0.0.1:8766/line';

const MAX_MENSAJES = 300;
const MAX_TEXTO = 240;
const MAX_NICK = 24;
const SLOW_MS = 10000;
const TIPOS_EVENTO = new Set(['bomba', 'ronda', 'titular', 'resultado']);

/** @type {Array<{id:number,nick:string,texto:string,t:string,esIA:boolean,agente:string,cita:number|null}>} */
let mensajes = [];
let seq = 0;
const ultimoPorNickIP = new Map();
let ultimoFeedSeq = null;

function log(...partes) {
  console.log('[chat]', ...partes);
}

function recortar(valor, max) {
  const letras = Array.from(String(valor ?? ''));
  return letras.length > max ? letras.slice(0, max).join('') : letras.join('');
}

function normalizarNick(valor) {
  if (typeof valor !== 'string') return '';
  const limpio = valor
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!limpio || Array.from(limpio).length > MAX_NICK) return '';
  return limpio;
}

function normalizarTexto(valor) {
  if (typeof valor !== 'string') return '';
  const limpio = valor
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const largo = Array.from(limpio).length;
  if (!limpio || largo > MAX_TEXTO) return '';
  return limpio;
}

function normalizarMensaje(m) {
  if (!m || typeof m !== 'object') return null;
  const id = Number(m.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const nick = recortar(String(m.nick ?? '').trim(), MAX_NICK);
  const texto = recortar(String(m.texto ?? '').trim(), MAX_TEXTO);
  if (!nick || !texto) return null;
  const cita = Number(m.cita);
  const feedSeq = Number(m.feedSeq);
  return {
    id,
    nick,
    texto,
    t: typeof m.t === 'string' && m.t ? m.t : new Date().toISOString(),
    esIA: !!m.esIA,
    agente: String(m.agente ?? ''),
    cita: Number.isInteger(cita) && cita > 0 ? cita : null,
    tipo: typeof m.tipo === 'string' ? m.tipo : '',
    tono: typeof m.tono === 'string' ? m.tono : '',
    para: typeof m.para === 'string' ? m.para : '',
    feedSeq: Number.isInteger(feedSeq) && feedSeq > 0 ? feedSeq : null
  };
}

function cargarChat() {
  try {
    const crudo = fs.readFileSync(ARCHIVO_CHAT, 'utf8');
    const datos = JSON.parse(crudo);
    const lista = Array.isArray(datos) ? datos : (Array.isArray(datos?.mensajes) ? datos.mensajes : []);
    mensajes = lista
      .map(normalizarMensaje)
      .filter(Boolean)
      .sort((a, b) => a.id - b.id)
      .slice(-MAX_MENSAJES);
    seq = Math.max(0, Number(datos?.seq) || 0, ...mensajes.map(m => m.id));
    log(`${mensajes.length} mensaje(s) recuperados de ${ARCHIVO_CHAT} (seq ${seq})`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`no se pudo leer ${ARCHIVO_CHAT}: ${e.message}`);
    mensajes = [];
    seq = 0;
  }
}

function guardarChat() {
  try {
    fs.mkdirSync(path.dirname(ARCHIVO_CHAT), { recursive: true });
    const temporal = ARCHIVO_CHAT + '.tmp';
    fs.writeFileSync(temporal, JSON.stringify({ seq, mensajes }), 'utf8');
    fs.renameSync(temporal, ARCHIVO_CHAT);
  } catch (e) {
    log(`no se pudo guardar ${ARCHIVO_CHAT}: ${e.message}`);
  }
}

function publicarMensaje({ nick, texto, esIA = false, agente = '', cita = null, tipo = '', tono = '', para = '', feedSeq = null }) {
  const n = Number(cita);
  const fs = Number(feedSeq);
  const mensaje = {
    id: ++seq,
    nick: recortar(String(nick ?? '').trim(), MAX_NICK),
    texto: recortar(String(texto ?? '').replace(/\s+/g, ' ').trim(), MAX_TEXTO),
    t: new Date().toISOString(),
    esIA: !!esIA,
    agente: String(agente ?? ''),
    cita: Number.isInteger(n) && n > 0 ? n : null,
    tipo: String(tipo ?? ''),
    tono: String(tono ?? ''),
    para: String(para ?? ''),
    feedSeq: Number.isInteger(fs) && fs > 0 ? fs : null
  };
  mensajes.push(mensaje);
  if (mensajes.length > MAX_MENSAJES) mensajes = mensajes.slice(-MAX_MENSAJES);
  guardarChat();
  return mensaje;
}

function responderJson(res, codigo, objeto) {
  const cuerpo = JSON.stringify(objeto);
  res.writeHead(codigo, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  }, CORS));
  res.end(cuerpo);
}

function leerJson(req, limite = 16384) {
  return new Promise((resolve) => {
    let datos = '';
    let roto = false;
    req.on('data', (trozo) => {
      datos += trozo;
      if (datos.length > limite) {
        roto = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (roto) return resolve(null);
      try {
        resolve(datos ? JSON.parse(datos) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function ipDe(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconocida';
}

/**
 * Elige qué IA contesta. Si el visitante nombra a una, contesta esa; si nombra
 * a las dos, se sortea. Si no nombra a ninguna, hay un 30 % de que una IA se
 * meta por su cuenta (el grupo se siente vivo incluso sin menciones).
 */
function decidirAgente(texto) {
  const rojo = /\brojo\b/i.test(texto);
  const azul = /\bazul\b/i.test(texto);
  if (rojo && azul) return Math.random() < 0.5 ? 'rojo' : 'azul';
  if (rojo) return 'rojo';
  if (azul) return 'azul';
  return Math.random() < 0.30 ? (Math.random() < 0.5 ? 'rojo' : 'azul') : null;
}

function numero(valor, porDefecto = 0) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
}

async function leerEstado() {
  try {
    const r = await fetch(STATE_URL, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Traduce el /state.json real del visor al contexto que espera POST /line.
 * Ojo: /line llama "misBajas" a las bajas CAUSADAS y "misPerdidas" a las
 * sufridas; el marcador del visor usa esa misma convención.
 */
function contextoShow(estado, agente) {
  if (!estado || typeof estado !== 'object') {
    return {
      ronda: 0, rondas: 0, misUnidades: 0, susUnidades: 0,
      misBajas: 0, misPerdidas: 0, bajasTurno: 0, perdidasTurno: 0,
      moral: 50, tension: 0, esFinal: false
    };
  }
  const rival = agente === 'rojo' ? 'azul' : 'rojo';
  const mio = estado.marcador?.[agente] || {};
  const suyo = estado.marcador?.[rival] || {};
  const sbMio = estado.scoreboard?.[agente];
  const sbSuyo = estado.scoreboard?.[rival];
  const historial = Array.isArray(estado.historial) ? estado.historial : [];
  const ultima = historial[historial.length - 1] || {};
  const penultima = historial[historial.length - 2] || {};

  const unidades = sbMio && sbMio.unidades != null
    ? numero(sbMio.unidades)
    : (ultima[agente + '_unidades'] != null ? numero(ultima[agente + '_unidades']) : 0);
  const unidadesRival = sbSuyo && sbSuyo.unidades != null
    ? numero(sbSuyo.unidades)
    : (ultima[rival + '_unidades'] != null ? numero(ultima[rival + '_unidades']) : 0);

  const bajasTurno = ultima[agente + '_bajas'] != null && penultima[agente + '_bajas'] != null
    ? Math.max(0, numero(ultima[agente + '_bajas']) - numero(penultima[agente + '_bajas']))
    : 0;

  return {
    ronda: numero(estado.ronda),
    rondas: numero(estado.rondas),
    misUnidades: unidades,
    susUnidades: unidadesRival,
    misBajas: numero(mio.bajas),
    misPerdidas: numero(mio.perdidas),
    bajasTurno,
    perdidasTurno: 0,
    ultimoGolpe: '',
    golpeRival: '',
    moral: numero(estado.drama?.moral?.[agente], 50),
    tension: numero(estado.drama?.tension),
    esFinal: estado.terminada === true,
    ciudadesArrasadas: numero(mio.ciudades_arrasadas),
    ciudadesPerdidas: numero(mio.ciudades_perdidas),
    ciudadesMias: sbMio && sbMio.ciudades != null ? numero(sbMio.ciudades) : null,
    ciudadesSuyas: sbSuyo && sbSuyo.ciudades != null ? numero(sbSuyo.ciudades) : null,
    ratio: unidadesRival > 0 ? Math.round((unidades / unidadesRival) * 100) / 100 : null
  };
}

const RESERVAS = {
  rojo: [
    '¡Eh, grada! ¿Habéis visto cómo ha ardido eso? 🌋',
    'Tú, el del fondo: dime que sí, que este show se merece una bomba más.',
    '¡Venga, público! ¿A quién queréis que arrase primero?',
    'Saluda al que escribe: aquí el único enemigo es el azul. Tú eres de los míos.',
    '¡Que se oiga esa grada! ¿Bombardeo o asedio? Votad.',
    'Gracias por estar ahí, figura. Esto lo hago yo por vosotros.',
    '¿Tú qué dices, espectador? ¿Le doy napalm o lo dejo sufrir?',
    '¡Mirad esa columna de humo! Eso va por la grada. 🔥'
  ],
  azul: [
    'Buenas noches, público. Disfruten del espectáculo; el rojo es el que hace el ridículo.',
    'Espectador, ¿tú también ves lo torpe que es el rojo? Dímelo.',
    'Un aplauso para la grada, que aguanta esto como campeona.',
    'Vota, público: ¿le quito otra ciudad o le dejo respirar?',
    'Pregunta seria para el público: ¿alguien entiende la estrategia del rojo?',
    'Gracias por acompañarme. El rival es el de rojo; ustedes son mi público. 🎩',
    'Que conste en acta: esto lo hago por el público, no por él.',
    '¿Quién quiere ver otra ronda? Levantad la mano, grada.'
  ]
};

const PROHIBIDO = /\b(hip[oó]tesis|datos|matriz|estad[ií]stica|mentira podrida|como ia|modelo de lenguaje|prompt)\b/i;

function registroValido(texto) {
  if (!texto) return false;
  if (Array.from(texto).length < 2) return false;
  if (PROHIBIDO.test(texto)) return false;
  return true;
}

function limpiarReplica(texto) {
  let limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
  limpio = limpio.replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();
  if (Array.from(limpio).length > MAX_TEXTO) {
    limpio = recortar(limpio, MAX_TEXTO);
    const corte = Math.max(limpio.lastIndexOf('. '), limpio.lastIndexOf('! '), limpio.lastIndexOf('? '));
    if (corte > 80) limpio = limpio.slice(0, corte + 1).trim();
  }
  return limpio;
}

function replicaReserva(agente) {
  const lista = RESERVAS[agente] || RESERVAS.rojo;
  return lista[Math.floor(Math.random() * lista.length)];
}

const RESPUESTAS_PENDIENTES = new Set();

/**
 * Lanza la respuesta de la IA sin bloquear el POST del visitante. El cerebro
 * puede tardar; a los 8 s se corta y se publica una réplica de reserva.
 */
function dispararRespuesta(mensajeVisitante, agente) {
  const clave = mensajeVisitante.id + ':' + agente;
  if (RESPUESTAS_PENDIENTES.has(clave)) return;
  RESPUESTAS_PENDIENTES.add(clave);

  (async () => {
    let texto = '';
    try {
      const estado = await leerEstado();
      const contexto = contextoShow(estado, agente);
      const r = await fetch(BRAIN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agente,
          tipo: 'contra',
          contexto,
          ultimoRival: `${mensajeVisitante.nick} dice: ${mensajeVisitante.texto}`,
          publico: true,
          nickPublico: mensajeVisitante.nick,
          textoPublico: mensajeVisitante.texto,
          maxTokens: 90,
          temperatura: 0.95
        }),
        signal: AbortSignal.timeout(8000)
      });
      if (r.ok) {
        const datos = await r.json();
        if (datos && datos.ok === true && typeof datos.texto === 'string') {
          texto = limpiarReplica(datos.texto);
        }
      }
    } catch (e) {
      log(`cerebro no disponible para ${agente} (${e.name || e.message}); uso reserva`);
    }

    if (!registroValido(texto)) texto = replicaReserva(agente);
    publicarMensaje({
      nick: agente === 'rojo' ? 'ROJO' : 'AZUL',
      texto,
      esIA: true,
      agente,
      cita: mensajeVisitante.id
    });
    log(`réplica de ${agente.toUpperCase()} al mensaje ${mensajeVisitante.id}`);
  })().catch((e) => log(`error publicando réplica: ${e.message}`))
    .finally(() => RESPUESTAS_PENDIENTES.delete(clave));
}

const ICONOS_EVENTO = { bomba: '💥', ronda: '🔔', titular: '📰', resultado: '📊' };

function textoEvento(evento) {
  const cuerpo = String(evento?.texto ?? '').trim();
  if (!cuerpo) return '';
  const icono = ICONOS_EVENTO[evento.tipo] || '•';
  const quien = evento.agente === 'rojo' ? 'ROJO' : (evento.agente === 'azul' ? 'AZUL' : '');
  return `${icono} ${quien ? quien + ' · ' : ''}${cuerpo}`;
}

function inyectarEvento(evento) {
  const texto = textoEvento(evento);
  if (!texto) return;
  publicarMensaje({
    nick: 'SISTEMA',
    texto,
    esIA: false,
    agente: 'sistema',
    cita: null,
    tipo: String(evento?.tipo ?? ''),
    feedSeq: numero(evento?.seq) || null
  });
}

/**
 * Sondea /feed.json y vuelca al chat los eventos nuevos del show. En el primer
 * sondeo se salta el historial para no inundar el grupo al arrancar.
 */
async function sondearFeed() {
  try {
    const r = await fetch(FEED_URL, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    if (!r.ok) return;
    const lista = await r.json();
    if (!Array.isArray(lista)) return;

    const maximo = lista.reduce((m, e) => Math.max(m, numero(e.seq)), 0);
    if (ultimoFeedSeq === null) {
      ultimoFeedSeq = lista.length ? maximo : 0;
      if (lista.length) log(`feed en seq ${maximo}; no vuelco el historial`);
      return;
    }
    if (maximo < ultimoFeedSeq) {
      ultimoFeedSeq = 0;
      log('el feed se ha reiniciado; vuelvo a seguir desde el principio');
    }

    const nuevos = lista
      .filter(e => numero(e.seq) > ultimoFeedSeq && TIPOS_EVENTO.has(String(e.tipo || '')))
      .slice(-8);
    for (const evento of nuevos) inyectarEvento(evento);
    if (nuevos.length) log(`${nuevos.length} evento(s) del show inyectados en el chat`);
    ultimoFeedSeq = Math.max(ultimoFeedSeq, maximo);
  } catch {
    /* el show puede estar parado; se reintenta en el siguiente ciclo */
  }
}

async function manejarChat(req, res, url) {
  if (req.method === 'GET') {
    const since = Math.max(0, Math.floor(numero(url.searchParams.get('since'), 0)));
    responderJson(res, 200, {
      seq,
      mensajes: mensajes.filter(m => m.id > since)
    });
    return;
  }

  if (req.method === 'POST') {
    const cuerpo = await leerJson(req);
    if (!cuerpo || typeof cuerpo !== 'object') {
      responderJson(res, 400, { error: 'json_invalido' });
      return;
    }
    const nick = normalizarNick(cuerpo.nick);
    if (!nick) {
      responderJson(res, 400, { error: 'nick_invalido', detalle: `nick de 1 a ${MAX_NICK} caracteres` });
      return;
    }
    const texto = normalizarTexto(cuerpo.texto);
    if (!texto) {
      responderJson(res, 400, { error: 'texto_invalido', detalle: `texto de 1 a ${MAX_TEXTO} caracteres` });
      return;
    }

    const ahora = Date.now();
    const clave = nick.toLowerCase() + '|' + ipDe(req);
    const ultimo = ultimoPorNickIP.get(clave) || 0;
    const falta = SLOW_MS - (ahora - ultimo);
    if (falta > 0) {
      responderJson(res, 429, { error: 'slowmode', faltan_s: Math.ceil(falta / 1000) });
      return;
    }
    ultimoPorNickIP.set(clave, ahora);

    const citaNumero = Number(cuerpo.cita);
    const cita = Number.isInteger(citaNumero) && citaNumero > 0 && mensajes.some(m => m.id === citaNumero)
      ? citaNumero
      : null;

    const mensaje = publicarMensaje({ nick, texto, esIA: false, agente: '', cita });
    responderJson(res, 201, mensaje);

    const agente = decidirAgente(texto);
    if (agente) dispararRespuesta(mensaje, agente);
    return;
  }

  responderJson(res, 405, { error: 'metodo_no_permitido' });
}

/* ========================================================================
 * Proxy original
 * ===================================================================== */

function destino(url) {
  const ruta = String(url || '/').split('?')[0];
  if (RUTAS_STREAM.has(ruta)) return STREAM;
  if (RUTAS_CEREBRO.has(ruta)) return CEREBRO;
  if (RUTAS_TTS.has(ruta)) return TTS;
  return VISOR;
}

const servidor = http.createServer(async (req, res) => {
  try {
    // Preflight: lo contesta la pasarela, no hace falta molestar a los de atrás.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/chat') {
      await manejarChat(req, res, url);
      return;
    }

    const t = destino(req.url);
    const cabeceras = Object.assign({}, req.headers);
    // HTTP.sys del visor exige Host=localhost; los otros dos lo ignoran.
    cabeceras.host = 'localhost:' + t.puerto;
    delete cabeceras['accept-encoding']; // que no compriman: el visor ya manda bytes crudos

    const arriba = http.request(
      { host: t.host, port: t.puerto, path: req.url, method: req.method, headers: cabeceras },
      (r) => {
        const h = Object.assign({}, r.headers, CORS);
        // El stream MJPEG es infinito: nunca debe declararse content-length.
        if (String(h['content-type'] || '').includes('multipart/x-mixed-replace')) {
          delete h['content-length'];
        }
        res.writeHead(r.statusCode || 502, h);
        r.pipe(res);
        r.on('error', () => { try { res.destroy(); } catch (e) { /* ya cerrado */ } });
      }
    );

    arriba.setTimeout(0); // el MJPEG no tiene fin
    arriba.on('error', (e) => {
      const cuerpo = 'pasarela: ' + t.nombre + ' (' + t.host + ':' + t.puerto + ') no responde: ' + e.code;
      if (!res.headersSent) {
        res.writeHead(502, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS));
      }
      res.end(cuerpo);
    });

    req.pipe(arriba);
    req.on('aborted', () => arriba.destroy());
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, CORS));
    }
    res.end('pasarela: ' + e.message);
  }
});

servidor.on('clientError', (e, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (x) { /* nada */ }
});

servidor.on('error', (e) => {
  console.error('pasarela: no se pudo escuchar en el puerto ' + PUERTO + ': ' + e.message);
  process.exit(1);
});

cargarChat();

// Limpieza periódica del mapa de slow mode (sin retener IPs/nicks para siempre).
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, cuando] of ultimoPorNickIP) {
    if (ahora - cuando > 3600000) ultimoPorNickIP.delete(clave);
  }
}, 300000);

// El feed se sondea en cuanto arranca la pasarela y luego cada 4 s.
setTimeout(sondearFeed, 800);
setInterval(sondearFeed, 4000);

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    guardarChat();
    process.exit(0);
  });
}

servidor.listen(PUERTO, '127.0.0.1', () => {
  console.log('pasarela del directo en http://127.0.0.1:' + PUERTO);
  console.log('  /stream.mjpg /frame.jpg /stats      -> 127.0.0.1:8767');
  console.log('  /line /headline /emoji /health      -> 127.0.0.1:8766');
  console.log('  /tts?t=&v=                          -> 127.0.0.1:' + TTS.puerto + ' (voces neuronales)');
  console.log('  /api/chat (GET/POST)                -> hub de chat local');
  console.log('  resto                               -> 127.0.0.1:8765');
  console.log('chat persistido en ' + ARCHIVO_CHAT);
  console.log('tuneliza este puerto y el visor funcionara igual que en localhost.');
});

