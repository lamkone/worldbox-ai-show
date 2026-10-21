#!/usr/bin/env node
/* ============================================================================
 * tts-server.mjs — VOCES NEURONALES del WorldBox AI Show
 * ----------------------------------------------------------------------------
 * Servicio local de texto a voz con las voces neuronales de Microsoft Edge
 * (edge-tts). Suenan naturales, no robóticas como las voces SAPI de Windows.
 *
 *   node scripts/tts-server.mjs [--port 8771]
 *
 *   GET /health                         -> JSON con estado y voces
 *   GET /tts?t=<texto>&v=rojo|azul|sistema   -> audio/mpeg (cacheado)
 *   GET /tts?t=<texto>&v=es-CO-GonzaloNeural  -> voz concreta
 *
 * - Cache en reports/tts-cache/<sha1>.mp3: la misma frase se sintetiza una vez.
 * - Cola de 1 síntesis a la vez (edge-tts es un proceso de Python) y como
 *   máximo 8 pendientes: si el show habla más rápido de lo que se sintetiza,
 *   se tiran las frases viejas antes que ir 20 s por detrás.
 * - CORS abierto: el visor local (8765) y el gateway (8770) pueden pedirlo.
 * - Si edge-tts no está instalado o no hay red, responde 503 y el visor cae a
 *   las voces del navegador (Web Speech API) sin romperse.
 * - POST-PROCESO opcional: si ffmpeg está disponible (imageio-ffmpeg), cada
 *   MP3 pasa por EQ de presencia, compresión suave y normalización de
 *   sonoridad (loudnorm) antes de entregarse. Así el directo
 *   suena con la misma "voz de locutor" que el banco natural/. Se desactiva
 *   con WB_TTS_POST=0 o si no hay ffmpeg (sigue sirviendo el audio crudo).
 * ========================================================================== */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const CACHE = path.join(RAIZ, 'reports', 'tts-cache');
fs.mkdirSync(CACHE, { recursive: true });

const args = process.argv.slice(2);
function arg(nombre, porDefecto) {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
}
const PUERTO = Number(arg('--port', process.env.WB_TTS_PORT || 8771));
const PYTHON = process.env.WB_PYTHON || 'python';
const MAX_TEXTO = 240;          // tope del texto de ENTRADA (lo que manda el visor)
const MAX_NORMALIZADO = 400;    // tope tras normalizar (los números ocupan más en letras)
const MAX_COLA = 8;
const TIMEOUT_MS = 25000;
const NORMALIZACION = 'v1';     // versión de la capa de normalización (invalida la cache)

/* Post-proceso de voz (cadena elegida en reports/voz-casting/natural/):
 *   highpass 80 Hz          quita retumbe
 *   eq 3 kHz +2 dB          presencia / claridad de dicción
 *   acompresor suave        nivel más constante entre frases (attack 5 ms)
 *   loudnorm -16 LUFS       sonoridad homogénea (TP -1,5 dB, sin saturar)
 * SIN reverb: la voz seca suena más de estudio (criterio del Lead).
 * Medido: RMS pasa de -22,9 dB a -18,4 dB y el pico queda en -1,7 dB. */
const POST = process.env.WB_TTS_POST !== '0';
const POST_VERSION = 'post-v2';
const POST_CADENA = 'highpass=f=80,equalizer=f=3000:t=q:w=1:g=2,'
  + 'acompressor=threshold=-18dB:ratio=3:attack=5:release=120:makeup=1.5,'
  + 'loudnorm=I=-16:TP=-1.5:LRA=11';
let ffmpegRuta = null;
let ffmpegBuscado = false;

/* Perfiles: ROJO = Gonzalo (Colombia, hombre), AZUL = Salomé (Colombia, mujer),
 * SISTEMA = Elvira (España, neutra). Elegidos por el dueño tras el casting.
 *
 * Prosodia elegida con el A/B de reports/voz-casting/natural/:
 *   - rate -4%: un 4 % más lento que el original. Da tiempo a articular las
 *     sílabas y suena menos atropellado (en la frase de prueba: 7,02 s ->
 *     7,32 s, +4,3 %; RMS y pico iguales, -22,4 dB / -5,5 dB, sin saturación).
 *     Con -8 % se alarga un 8,7 % y ya suena moroso.
 *   - pitch +0Hz: ±2 Hz no cambia ni duración ni volumen (solo los bytes), así
 *     que no compensa arriesgar artefactos: se deja la entonación de la voz.
 * El post-proceso (EQ, compresión, reverb de sala) NO va aquí: se aplica al
 * generar el pack de voces (scripts/build-voice-pack.ps1) y al banco natural/.
 *
 * La voz se puede cambiar sin tocar el código:
 *   WB_VOZ_ROJO=es-AR-TomasNeural  WB_VOZ_AZUL=es-MX-DaliaNeural  node scripts/tts-server.mjs
 */
const vozEnv = (nombre, porDefecto) => (process.env[nombre] || porDefecto);
const RATE = process.env.WB_TTS_RATE || '-4%';
const PITCH = process.env.WB_TTS_PITCH || '+0Hz';

/* ---------------------------------------------------------------------------
 * MOTOR v9 (decidido con el dueño en reports/voz-casting/v6/)
 * ---------------------------------------------------------------------------
 * El casting acabó eligiendo DOS voces y "solo volumen igualado, sin EQ":
 *   rojo    -> Kokoro em_santa          (onnx local, ~2,5 s por línea, sin red)
 *   azul    -> edge es-CO-SalomeNeural  (la que el dueño eligió en el casting)
 *   sistema -> edge-tts Elvira          (avisos del show)
 *
 * v9.4 (21/10): el AZUL vuelve a edge Salomé y el Kokoro deja de llevar
 * pitch-shift. Las dos cosas son el mismo problema: el dueño dijo "la voz es la
 * misma pero suena a voces distintas entre frases". Medido con
 * reports/qa/probe-timbre-pack.py: el rubberband que aplicábamos al Kokoro movía
 * los FORMANTES junto con el tono, así que la misma voz sonaba a otra persona
 * según la emoción (distancia MFCC entre-emociones 14,2 frente a 7,4 dentro del
 * mismo texto = ratio 1,90; con edge, que mueve el tono de forma nativa, el ratio
 * era 0,89). Quitar el pitch-shift deja ratio ≈1 y no cuesta naturalidad porque
 * la emoción sigue en el ritmo y las pausas. El azul vuelve a Salomé porque el
 * cambio a ef_dora (v9.3) se hizo mirando solo la entonación y contra la elección
 * explícita del dueño. Se puede volver a probar ef_dora con WB_VOZ_AZUL=ef_dora,
 * pero entonces hay que devolver el motor a 'kokoro'.
 * Las dos se clavan a -16,0 LUFS con ganancia lineal + limitador de picos, así
 * que suenan al mismo volumen cuando hablan entre ellas (medido: ±0,1 LU).
 *
 * Además cada línea lleva EMOCIÓN (neutral/burla/enfadado/triste/confuso) y el
 * motor mueve ritmo, pausas y (solo en edge, de forma nativa) el tono. La emoción
 * la elige el cerebro dramático.
 *
 * El trabajo pesado lo hace scripts/voz-engine.py, que se queda vivo como
 * proceso hijo (cargar Kokoro cuesta 1,3 s y la primera síntesis 6 s: se pagan
 * UNA vez al arrancar, no en cada frase).
 *
 *   WB_TTS_MOTOR=legacy   vuelve al edge-tts de antes (una voz fija por perfil)
 * ------------------------------------------------------------------------- */
// v9.1: el motor bajo el techo del limitador de 0,98 a 0,85 (-1,4 dBFS) porque el
// MP3 decodificado sobrepicaba +0,6 dBFS en las lineas percusivas. Cambia el audio,
// asi que la version entra en la marca de cache y los MP3 viejos se regeneran solos.
// v9.4: se quita el pitch-shift (rubberband) del Kokoro y el AZUL vuelve a edge
// Salome, que es lo que el dueño eligio en el casting. Motivo medido: el rubberband
// mueve los formantes junto con el tono y el mismo personaje suena a otra persona
// segun la emocion (ratio MFCC entre-emociones/dentro-texto 1,90 en Kokoro frente a
// 0,89 en edge). La emocion se queda en ritmo y pausas, que no toca el timbre.
// Cambia el audio, asi que la version entra en la marca de cache y el pack se
// regenera solo.
// v9.5: el AZUL (edge) vuelve a sintetizar FRASE A FRASE con la prosodia del
// casting v8 que el dueño aprobo (exclamacion sube +8%/+5Hz, pregunta +3%/+6Hz,
// cierre -12%/-6Hz, pausa de coma 140 ms) y se recorta el silencio de cabeza/cola
// que edge deja en cada peticion (30/80 ms). Sin ese recorte cada frase arrastraba
// ~0,9 s de cola y las pausas internas se iban a 1,3 s (defecto del v8 original,
// no del diseno). v9.2 habia pasado a linea completa para quitar el "mas robotico"
// y con ello se perdio la actuacion; el dueño dijo despues que las frases del
// casting sonaban mas naturales. Kokoro NO se toca: ya coincide con el v8.
const MOTOR_VERSION = 'v9.5';
const MOTOR = (process.env.WB_TTS_MOTOR || 'v9').toLowerCase();
const ENGINE = path.join(AQUI, 'voz-engine.py');
const PERFILES = {
  rojo: { voz: vozEnv('WB_VOZ_ROJO', 'em_santa'), motor: 'kokoro', rate: RATE, pitch: PITCH },
  azul: { voz: vozEnv('WB_VOZ_AZUL', 'es-CO-SalomeNeural'), motor: 'edge', rate: RATE, pitch: PITCH },
  sistema: { voz: vozEnv('WB_VOZ_SISTEMA', 'es-ES-ElviraNeural'), motor: 'edge', rate: RATE, pitch: PITCH },
};

/* Emociones que entiende el motor. */
const EMOCIONES = ['neutral', 'burla', 'enfadado', 'triste', 'confuso'];
/* Los nombres de tono que ya usa el cerebro dramático (23-drama-llm.mjs) y los
 * emojis del visor (llanto, furia, euforia...) se traducen a las cinco de voz,
 * para no tener que cambiar el guion entero. */
const ALIAS_EMOCION = {
  neutral: 'neutral', normal: 'neutral', neutro: 'neutral', '': 'neutral',
  burla: 'burla', chuleria: 'burla', chulería: 'burla', euforia: 'burla', pique: 'burla',
  sarcasmo: 'burla', ironia: 'burla', ironía: 'burla',
  enfadado: 'enfadado', enfado: 'enfadado', rabia: 'enfadado', furia: 'enfadado',
  panico: 'enfadado', pánico: 'enfadado', cabreo: 'enfadado', amenaza: 'enfadado',
  triste: 'triste', llanto: 'triste', pena: 'triste', derrota: 'triste', drama: 'triste',
  confuso: 'confuso', duda: 'confuso', sorpresa: 'confuso', desconcierto: 'confuso',
};

function normalizarEmocion(e) {
  const clave = String(e || '').trim().toLowerCase();
  return ALIAS_EMOCION[clave] || 'neutral';
}

const cache = new Map();       // sha1 -> {estado:'listo'|'error', bytes}
let cola = [];
let sintetizando = false;
let sintetizadas = 0;
let fallos = 0;
let ultimoError = '';

function log(msg) { console.log(`[tts] ${msg}`); }

/* ---------------------------------------------------------------------------
 * NORMALIZACIÓN DE TEXTO PARA TTS (español)
 * ---------------------------------------------------------------------------
 * edge-tts pronuncia bien las palabras, pero los números, los símbolos y la
 * puntuación repetida los interpreta a su manera (a veces los deletrea o se
 * come la mitad). Esta capa convierte el texto a lo que diría un locutor:
 *
 *   748            -> setecientos cuarenta y ocho
 *   1.240          -> mil doscientos cuarenta
 *   3,5            -> tres coma cinco
 *   -250 / −250    -> menos doscientos cincuenta
 *   87%            -> ochenta y siete por ciento
 *   12 km          -> doce kilómetros
 *   rojo vs azul   -> rojo contra azul
 *   ¡GG!           -> ¡ge ge!
 *   !!! / ...      -> ! / ,
 *   😡 **texto**   -> texto
 *
 * Es idempotente: normalizar(normalizar(x)) === normalizar(x).
 * ------------------------------------------------------------------------- */
const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const VEINTI = ['veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
  'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = { 3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta', 7: 'setenta', 8: 'ochenta', 9: 'noventa' };
const CENTENAS = { 1: 'ciento', 2: 'doscientos', 3: 'trescientos', 4: 'cuatrocientos', 5: 'quinientos',
  6: 'seiscientos', 7: 'setecientos', 8: 'ochocientos', 9: 'novecientos' };
/* Siglas que se leen letra a letra (las que más salen en el show). */
const SIGLAS = { GG: 'ge ge', HP: 'hache pe', IA: 'i a', KO: 'kao', FPS: 'efe pe ese' };

function apocope(s) {
  if (s === 'veintiuno') return 'veintiún';
  if (s.endsWith('uno')) return s.slice(0, -3) + 'un';
  return s;
}

function hasta99(n) {
  if (n < 20) return UNIDADES[n];
  if (n === 20) return 'veinte';
  if (n < 30) return VEINTI[n - 21];
  const d = Math.floor(n / 10);
  const u = n % 10;
  return DECENAS[d] + (u ? ' y ' + UNIDADES[u] : '');
}

function hasta999(n) {
  if (n < 100) return hasta99(n);
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  return CENTENAS[c] + (r ? ' ' + hasta99(r) : '');
}

/* Entero -> letras (0 .. 999.999.999.999). */
function enteroATexto(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return 'cero';
  const partes = [];
  const billones = Math.floor(n / 1e12);
  const millones = Math.floor((n % 1e12) / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  if (billones) partes.push(billones === 1 ? 'un billón' : apocope(enteroATexto(billones)) + ' billones');
  if (millones) partes.push(millones === 1 ? 'un millón' : apocope(enteroATexto(millones)) + ' millones');
  if (miles) partes.push(miles === 1 ? 'mil' : apocope(enteroATexto(miles)) + ' mil');
  if (resto) partes.push(hasta999(resto));
  return partes.join(' ');
}

function leerDigitos(s) {
  return String(s).split('').map((d) => UNIDADES[Number(d)] || '').filter(Boolean).join(' ');
}

/* Parte decimal: "3,5" -> cinco; "19,99" -> noventa y nueve; "3,05" -> cero cinco. */
function decimalATexto(d) {
  const s = String(d);
  if (s.length <= 2 && s.charAt(0) !== '0') return enteroATexto(Number(s));
  return leerDigitos(s);
}

/* Un token numérico tal cual aparece en el texto ("1.240", "3,5", "87"). */
function numeroToken(tok) {
  const t = String(tok);
  const milesDecimal = t.match(/^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/);
  if (milesDecimal) {
    const entero = enteroATexto(Number(milesDecimal[1].replace(/\./g, '')));
    return milesDecimal[2] ? entero + ' coma ' + decimalATexto(milesDecimal[2]) : entero;
  }
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? enteroATexto(n) : leerDigitos(t);
  }
  const dec = t.match(/^(\d+)[.,](\d+)$/);
  if (dec) return enteroATexto(Number(dec[1])) + ' coma ' + decimalATexto(dec[2]);
  return t;
}

function normalizarTexto(t) {
  let s = String(t == null ? '' : t);

  // 1) URLs y markdown fuera: la voz no debe leer ni enlaces ni asteriscos.
  s = s.replace(/https?:\/\/\S+/g, ' enlace ')
    .replace(/www\.\S+/gi, ' enlace ')
    .replace(/[*_`#>|~]+/g, ' ');

  // 2) Emoji, banderas y símbolos decorativos: se quitan (no se leen).
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u2022\u25AA\u25AB\u25FE\u25FD]/gu, ' ');

  // 3) Caracteres de formato invisibles (ancho cero, marcas de dirección...).
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');

  // 4) Símbolos que se dicen con palabras.
  s = s.replace(/\s*%\s*/g, ' por ciento ')
    .replace(/\bkm\s*\/\s*h\b/gi, ' kilómetros por hora ')
    .replace(/(\d)\s*km\b/gi, '$1 kilómetros')
    .replace(/\bkm\b/gi, 'kilómetros')
    .replace(/(\d)\s*kg\b/gi, '$1 kilos')
    .replace(/\bkg\b/gi, 'kilos')
    .replace(/(\d)\s*cm\b/gi, '$1 centímetros')
    .replace(/\bcm\b/gi, 'centímetros')
    .replace(/(\d)\s*mm\b/gi, '$1 milímetros')
    .replace(/\bmm\b/gi, 'milímetros')
    .replace(/\s*&\s*/g, ' y ')
    .replace(/\s*\+\s*/g, ' más ')
    .replace(/\s*=\s*/g, ' igual a ')
    .replace(/\s*[×xX]\s*(?=\d)/g, ' por ')
    .replace(/\s*→\s*/g, ' hacia ')
    .replace(/€/g, ' euros ')
    .replace(/\$/g, ' dólares ')
    .replace(/°/g, ' grados ')
    .replace(/@/g, ' arroba ')
    .replace(/\//g, ' barra ')
    .replace(/\bvs\.?(?=\s|$)/gi, ' contra ');

  // 5) Números negativos: -250 y −250 se dicen "menos doscientos cincuenta".
  s = s.replace(/(^|[\s(¡¿"'])[-−]\s*(?=\d)/g, '$1menos ');

  // 6) Rangos numéricos cortos: "3-0" se dice "tres a cero".
  s = s.replace(/(\d)\s*[-–—]\s*(?=\d)/g, '$1 a ');

  // 7) Puntuación repetida y rayas: pausas de verdad, no símbolos raros.
  s = s.replace(/[!?]{2,}/g, (m) => (m.indexOf('?') >= 0 ? '?' : '!'))
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/¡{2,}/g, '¡')
    .replace(/¿{2,}/g, '¿')
    .replace(/\.{3,}|…/g, ', ')
    .replace(/[—–]/g, ', ')
    .replace(/\s-\s/g, ', ');

  // 8) Comillas y paréntesis: pausa.
  s = s.replace(/[«»“”„"'']/g, ' ')
    .replace(/[()\[\]{}]/g, ', ');

  // 8b) Ordinales cortos ("1.º", "3º"): "primer", "tercer"...
  s = s.replace(/\b(\d{1,2})\s*\.?\s*[º°]/g, (m, d) => {
    const n = Number(d);
    const ORD = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo',
      'noveno', 'décimo', 'undécimo', 'duodécimo', 'decimotercero', 'decimocuarto', 'decimoquinto',
      'decimosexto', 'decimoséptimo', 'decimoctavo', 'decimonoveno', 'vigésimo'];
    return n >= 1 && n <= 20 ? ORD[n] : m;
  });

  // 9) Números a letras (al final, cuando ya no hay símbolos alrededor).
  s = s.replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g, (m) => numeroToken(m));

  // 10) Siglas conocidas.
  s = s.replace(/\b(GG|HP|IA|KO|FPS)\b/g, (m) => SIGLAS[m] || m);

  // 11) Limpieza final: espacios y comas duplicadas.
  s = s.replace(/\s*,\s*/g, ', ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s*\.\s*/g, '. ')
    .replace(/\s*!\s*/g, '! ')
    .replace(/\s*\?\s*/g, '? ')
    .replace(/\s*:\s*/g, ': ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/(?:\.\s*){2,}/g, '. ')
    .replace(/^[\s,;.]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;]+$/, '')
    .trim();
  return s;
}

function resolverPerfil(v) {
  const clave = String(v || '').trim();
  if (PERFILES[clave]) return { nombre: clave, ...PERFILES[clave] };
  for (const [nombre, p] of Object.entries(PERFILES)) {
    if (p.voz.toLowerCase() === clave.toLowerCase()) return { nombre, ...p };
  }
  // Voz Kokoro suelta (em_santa, em_alex...): motor local.
  if (/^[a-z]{2}_[a-z]+$/i.test(clave)) {
    return { nombre: clave, voz: clave, motor: 'kokoro', rate: '+0%', pitch: '+0Hz' };
  }
  if (/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/.test(clave)) {
    return { nombre: clave, voz: clave, motor: 'edge', rate: '+0%', pitch: '+0Hz' };
  }
  return { nombre: 'sistema', ...PERFILES.sistema };
}

function rutaCache(perfil, texto, emocion) {
  const marca = MOTOR === 'legacy' ? (POST ? POST_VERSION : 'sin-post') : MOTOR_VERSION;
  const h = createHash('sha1')
    .update(`${marca}|${perfil.motor}|${perfil.voz}|${emocion || 'neutral'}|${texto}`)
    .digest('hex');
  return path.join(CACHE, `${h}.mp3`);
}

/* Localiza ffmpeg la primera vez que hace falta. Se instala con
 *   python -m pip install imageio-ffmpeg
 * y esta función pregunta a ese paquete dónde dejó el binario. Si no está,
 * el servidor sigue funcionando sin post-proceso (audio crudo de edge-tts). */
function buscarFfmpeg() {
  if (ffmpegBuscado) return ffmpegRuta;
  ffmpegBuscado = true;
  try {
    const r = spawnSync(PYTHON, ['-c', 'import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const ruta = String(r.stdout || '').trim();
    if (r.status === 0 && ruta && fs.existsSync(ruta)) ffmpegRuta = ruta;
  } catch (e) { /* sin ffmpeg */ }
  if (ffmpegRuta) log(`post-proceso ${POST_VERSION} activo (ffmpeg: ${path.basename(ffmpegRuta)})`);
  else log('post-proceso desactivado: ffmpeg no disponible (python -m pip install imageio-ffmpeg)');
  return ffmpegRuta;
}

/* ===========================================================================
 * CLIENTE DEL MOTOR DE VOZ (scripts/voz-engine.py)
 * ---------------------------------------------------------------------------
 * Un único proceso hijo que se queda vivo. Se le manda una petición JSON por
 * línea y responde otra por línea. Ventajas frente a arrancar `python -m
 * edge_tts` en cada frase:
 *   - Kokoro se carga UNA vez (1,3 s) y se calienta UNA vez (6 s de la primera
 *     síntesis); a partir de ahí cada línea cuesta 1,2-2,5 s.
 *   - La emoción y el nivel de volumen los aplica el motor, no hay post-proceso
 *     aparte (ni un ffmpeg extra por frase).
 * Si el motor se cae o no responde, se marca error y el visor cae a las voces
 * del navegador, como antes.
 * ========================================================================= */
let motor = null;            // { proc, vivo, pendientes:Map, siguienteId, buffer }
let motorEstado = 'sin arrancar';
let motorFallos = 0;

function arrancarMotor() {
  if (motor && motor.vivo) return motor;
  if (MOTOR === 'legacy') return null;
  motorEstado = 'arrancando';
  const proc = spawn(PYTHON, ['-u', ENGINE], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  const m = { proc, vivo: true, pendientes: new Map(), siguienteId: 1, buffer: '' };
  motor = m;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (trozo) => {
    m.buffer += trozo;
    let corte;
    while ((corte = m.buffer.indexOf('\n')) >= 0) {
      const linea = m.buffer.slice(0, corte).trim();
      m.buffer = m.buffer.slice(corte + 1);
      if (!linea) continue;
      let r;
      try { r = JSON.parse(linea); } catch (e) { log(`motor: respuesta ilegible: ${linea.slice(0, 120)}`); continue; }
      const p = m.pendientes.get(r.id);
      if (p) { m.pendientes.delete(r.id); clearTimeout(p.reloj); p.resolver(r); }
    }
  });
  let err = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => {
    err = (err + d).slice(-600);
    for (const linea of String(d).split('\n')) {
      const t = linea.trim();
      if (t && !/^\s*$/.test(t)) log(`motor: ${t.slice(0, 200)}`);
    }
  });
  proc.on('exit', (code) => {
    m.vivo = false;
    motorEstado = `caido (${code})`;
    log(`motor de voz terminado (codigo ${code})${err ? ': ' + err.trim().split('\n').pop() : ''}`);
    for (const [, p] of m.pendientes) { clearTimeout(p.reloj); p.resolver({ ok: false, error: 'motor caido' }); }
    m.pendientes.clear();
  });
  proc.on('error', (e) => {
    m.vivo = false;
    motorEstado = 'error al arrancar';
    ultimoError = `motor: ${e.message}`;
  });
  motorEstado = 'vivo';
  log(`motor de voz arrancado (${ENGINE})`);
  return m;
}

function pedirMotor(peticion, timeoutMs = TIMEOUT_MS) {
  const m = arrancarMotor();
  if (!m || !m.vivo) return Promise.resolve({ ok: false, error: 'motor no disponible' });
  const id = m.siguienteId++;
  return new Promise((resolve) => {
    const reloj = setTimeout(() => {
      m.pendientes.delete(id);
      ultimoError = 'timeout del motor de voz';
      resolve({ ok: false, error: 'timeout del motor' });
    }, timeoutMs);
    m.pendientes.set(id, { resolver: resolve, reloj });
    try {
      m.proc.stdin.write(JSON.stringify({ id, ...peticion }) + '\n');
    } catch (e) {
      clearTimeout(reloj);
      m.pendientes.delete(id);
      resolve({ ok: false, error: e.message });
    }
  });
}

/* Síntesis con el motor v9: una sola llamada, que ya devuelve el MP3 con la
 * emoción aplicada y el volumen igualado. */
async function sintetizarMotor(perfil, texto, destino, emocion) {
  const r = await pedirMotor({
    motor: perfil.motor, voz: perfil.voz, emocion, texto, out: destino,
  });
  if (!r || !r.ok) {
    ultimoError = (r && r.error) || 'motor sin respuesta';
    return false;
  }
  try {
    if (!fs.existsSync(destino) || fs.statSync(destino).size < 800) {
      ultimoError = 'audio vacio';
      return false;
    }
  } catch (e) { ultimoError = e.message; return false; }
  return true;
}

/* Aplica la cadena de post-proceso al MP3 recién sintetizado (solo camino
 * legacy; el motor v9 ya entrega el nivel igualado y sin EQ).
 * Escribe a un temporal y solo sustituye el destino si ffmpeg termina bien. */
function postProcesar(entrada, destino) {
  return new Promise((resolve) => {
    const ff = buscarFfmpeg();
    if (!ff) return resolve(false);
    const tmp = `${destino}.post.mp3`;
    const proc = spawn(ff, [
      '-hide_banner', '-nostats', '-y',
      '-i', entrada,
      '-af', POST_CADENA,
      '-c:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000',
      tmp,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const reloj = setTimeout(() => { try { proc.kill(); } catch (e) {} }, TIMEOUT_MS);
    proc.stderr.on('data', (d) => { err += String(d); });
    proc.on('error', () => { clearTimeout(reloj); try { fs.rmSync(tmp, { force: true }); } catch (e) {} resolve(false); });
    proc.on('close', (code) => {
      clearTimeout(reloj);
      try {
        if (code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size < 800) {
          ultimoError = 'post-proceso fallo: ' + (err || `ffmpeg salio con ${code}`).trim().slice(-200);
          try { fs.rmSync(tmp, { force: true }); } catch (e) {}
          return resolve(false);
        }
        fs.renameSync(tmp, destino);
        try { fs.rmSync(entrada, { force: true }); } catch (e) {}
        resolve(true);
      } catch (e) {
        ultimoError = e.message;
        try { fs.rmSync(tmp, { force: true }); } catch (e2) {}
        resolve(false);
      }
    });
  });
}

async function sintetizar(perfil, texto, destino, emocion) {
  if (MOTOR !== 'legacy') {
    const ok = await sintetizarMotor(perfil, texto, destino, emocion);
    if (ok) return true;
    // Si el motor nuevo falla (p. ej. Kokoro no instalado), se intenta el
    // camino de siempre antes de rendirse: mejor una voz peor que silencio.
    log(`motor v9 fallo (${ultimoError}); se intenta edge-tts clasico`);
  }
  return sintetizarLegacy(perfil, texto, destino);
}

function sintetizarLegacy(perfil, texto, destino) {
  return new Promise((resolve) => {
    const tmp = `${destino}.part`;
    // OJO: con `--pitch -6Hz` argparse lee "-6Hz" como una opcion y falla.
    // La forma `--clave=valor` evita ese problema con valores que empiezan por "-".
    const proc = spawn(PYTHON, [
      '-m', 'edge_tts',
      `--voice=${perfil.voz}`,
      `--rate=${perfil.rate}`,
      `--pitch=${perfil.pitch}`,
      `--text=${texto}`,
      `--write-media=${tmp}`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const reloj = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      ultimoError = 'timeout de edge-tts';
      try { fs.rmSync(tmp, { force: true }); } catch (e) {}
      resolve(false);
    }, TIMEOUT_MS);
    proc.stderr.on('data', (d) => { err += String(d); });
    proc.on('error', (e) => {
      clearTimeout(reloj);
      ultimoError = e.message;
      resolve(false);
    });
    proc.on('close', async (code) => {
      clearTimeout(reloj);
      if (code !== 0) {
        ultimoError = (err || `edge-tts salio con ${code}`).trim().slice(0, 300);
        try { fs.rmSync(tmp, { force: true }); } catch (e) {}
        return resolve(false);
      }
      try {
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 800) {
          ultimoError = 'audio vacio';
          try { fs.rmSync(tmp, { force: true }); } catch (e) {}
          return resolve(false);
        }
        // Post-proceso opcional: si falla, se entrega el audio crudo igualmente.
        if (POST && buscarFfmpeg()) {
          const ok = await postProcesar(tmp, destino);
          if (!ok) {
            log('aviso: post-proceso fallo, se entrega el audio crudo');
            fs.renameSync(tmp, destino);
          }
        } else {
          fs.renameSync(tmp, destino);
        }
        resolve(true);
      } catch (e) {
        ultimoError = e.message;
        resolve(false);
      }
    });
  });
}

function bombear() {
  if (sintetizando || !cola.length) return;
  const tarea = cola.shift();
  sintetizando = true;
  sintetizar(tarea.perfil, tarea.texto, tarea.destino, tarea.emocion)
    .then((ok) => {
      sintetizando = false;
      if (ok) {
        sintetizadas++;
        cache.set(tarea.destino, { estado: 'listo', bytes: 1 });
        tarea.resolver({ ok: true, archivo: tarea.destino });
      } else {
        fallos++;
        log(`fallo al sintetizar (${tarea.perfil.nombre}/${tarea.emocion}): ${ultimoError}`);
        tarea.resolver({ ok: false, error: ultimoError });
      }
      setImmediate(bombear);
    })
    .catch((e) => {
      sintetizando = false;
      fallos++;
      tarea.resolver({ ok: false, error: e.message });
      setImmediate(bombear);
    });
}

function pedir(perfil, texto, destino, emocion) {
  if (cache.has(destino) && cache.get(destino).estado === 'listo') {
    return Promise.resolve({ ok: true, archivo: destino, cacheado: true });
  }
  // Tras reiniciar el servidor el Map está vacío pero los MP3 siguen en disco:
  // si ya existe uno válido, se reutiliza sin volver a sintetizar.
  try {
    if (fs.existsSync(destino) && fs.statSync(destino).size >= 800) {
      cache.set(destino, { estado: 'listo', bytes: fs.statSync(destino).size });
      return Promise.resolve({ ok: true, archivo: destino, cacheado: true });
    }
  } catch (e) { /* se sintetiza de nuevo */ }
  return new Promise((resolve) => {
    if (cola.length >= MAX_COLA) {
      const vieja = cola.shift();
      if (vieja) vieja.resolver({ ok: false, error: 'cola llena' });
    }
    cola.push({ perfil, texto, destino, emocion, resolver: resolve });
    bombear();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function json(res, code, obj) {
  const cuerpo = JSON.stringify(obj);
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(cuerpo) });
  res.end(cuerpo);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PUERTO}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true, servicio: 'worldbox-tts', version: '2.1.0',
      motor: MOTOR === 'legacy' ? 'edge-tts clasico' : 'v9 (Kokoro rojo + edge azul, volumen igualado)',
      motorVersion: MOTOR_VERSION,
      motorEstado,
      motorFallos,
      puerto: PUERTO, sintetizadas, fallos, pendientes: cola.length,
      sintetizando, ultimoError: ultimoError || null,
      normalizacion: NORMALIZACION,
      emociones: EMOCIONES,
      postproceso: MOTOR === 'legacy' && POST ? POST_VERSION : 'off',
      ffmpeg: ffmpegRuta ? path.basename(ffmpegRuta) : (ffmpegBuscado ? 'no disponible' : 'sin probar'),
      prosodia: Object.fromEntries(Object.entries(PERFILES).map(([k, v]) => [k, { motor: v.motor, voz: v.voz }])),
      perfiles: Object.fromEntries(Object.entries(PERFILES).map(([k, v]) => [k, v.voz])),
    });
  }

  /* Diagnóstico de la normalización: /normalizar?t=<texto> devuelve qué se va
   * a leer de verdad. Útil para el banco de pruebas y para depurar frases. */
  if (url.pathname === '/normalizar' || url.pathname === '/normalizar/') {
    const bruto = String(url.searchParams.get('t') || '');
    const normalizado = normalizarTexto(bruto);
    return json(res, 200, { ok: true, original: bruto, normalizado, largo: normalizado.length });
  }

  if (url.pathname === '/tts' || url.pathname === '/tts/') {
    const bruto = String(url.searchParams.get('t') || '');
    if (!bruto.trim()) return json(res, 400, { ok: false, error: 'falta el texto (t=)' });
    if (bruto.length > MAX_TEXTO) return json(res, 400, { ok: false, error: `texto demasiado largo (max ${MAX_TEXTO})` });
    let texto = normalizarTexto(bruto);
    if (!texto) return json(res, 400, { ok: false, error: 'el texto queda vacio tras normalizar' });
    // Los números en letras ocupan más: si se pasa, corta por palabra (nunca a mitad).
    if (texto.length > MAX_NORMALIZADO) {
      texto = texto.slice(0, MAX_NORMALIZADO).replace(/\s+\S*$/, '');
    }
    const perfil = resolverPerfil(url.searchParams.get('v'));
    const emocion = normalizarEmocion(url.searchParams.get('e'));
    const destino = rutaCache(perfil, texto, emocion);
    const r = await pedir(perfil, texto, destino, emocion);
    if (!r.ok) {
      return json(res, 503, {
        ok: false, error: r.error || 'no se pudo sintetizar',
        pista: 'comprueba que el motor de voz arranca: python scripts/voz-engine.py',
      });
    }
    let datos;
    try { datos = fs.readFileSync(destino); }
    catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    cache.set(destino, { estado: 'listo', bytes: datos.length });
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': datos.length,
      'X-Voz': perfil.voz,
      'X-Emocion': emocion,
      'X-Cache': r.cacheado ? 'hit' : 'miss',
    });
    return res.end(datos);
  }

  /* Precalentado: el guion sabe la frase ANTES de que se muestre en pantalla,
   * así que se sintetiza aquí y cuando el visor la pida ya está en caché (hit
   * instantáneo). No devuelve audio, solo el estado. */
  if (url.pathname === '/precalentar' || url.pathname === '/precalentar/') {
    const bruto = String(url.searchParams.get('t') || '');
    if (!bruto.trim()) return json(res, 400, { ok: false, error: 'falta el texto (t=)' });
    let texto = normalizarTexto(bruto.slice(0, MAX_TEXTO));
    if (texto.length > MAX_NORMALIZADO) texto = texto.slice(0, MAX_NORMALIZADO).replace(/\s+\S*$/, '');
    if (!texto) return json(res, 400, { ok: false, error: 'texto vacio' });
    const perfil = resolverPerfil(url.searchParams.get('v'));
    const emocion = normalizarEmocion(url.searchParams.get('e'));
    const destino = rutaCache(perfil, texto, emocion);
    const yaEstaba = cache.has(destino) || (fs.existsSync(destino) && fs.statSync(destino).size >= 800);
    pedir(perfil, texto, destino, emocion).then((r) => {
      if (!r.ok) log(`precalentado fallo (${perfil.nombre}/${emocion}): ${r.error}`);
    });
    return json(res, 200, { ok: true, yaEstaba, encolado: !yaEstaba, pendientes: cola.length });
  }

  return json(res, 404, { ok: false, error: 'ruta desconocida', rutas: ['/health', '/tts?t=&v='] });
});

/* Solo arranca el servidor si este fichero se ejecuta directamente:
 * así los tests pueden `import { normalizarTexto }` sin abrir un puerto. */
const esPrincipal = (() => {
  try {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch (e) { return false; }
})();

if (esPrincipal) {
  servidor.listen(PUERTO, '127.0.0.1', () => {
    log(`escuchando en http://127.0.0.1:${PUERTO}  (motor ${MOTOR} ${MOTOR_VERSION}, cache ${CACHE})`);
    log(`perfiles: rojo=${PERFILES.rojo.voz} (${PERFILES.rojo.motor})  azul=${PERFILES.azul.voz} (${PERFILES.azul.motor})  sistema=${PERFILES.sistema.voz}`);
    log(`emociones: ${EMOCIONES.join(', ')}  (el visor las pide con &e=)`);
    if (MOTOR !== 'legacy') arrancarMotor();
    if (MOTOR === 'legacy' && POST) buscarFfmpeg();
  });

  for (const senal of ['SIGINT', 'SIGTERM']) {
    process.on(senal, () => {
      log('cerrando');
      try { servidor.close(); } catch (e) {}
      try { if (motor && motor.vivo) motor.proc.kill(); } catch (e) {}
      process.exit(0);
    });
  }
}

export { normalizarTexto, enteroATexto, numeroToken, PERFILES, MAX_TEXTO, MAX_NORMALIZADO, normalizarEmocion, EMOCIONES };
