/* ============================================================================
 * viewer-voice.js — VOCES DEL SHOW  (v2.2.0)
 * ----------------------------------------------------------------------------
 * Motor doble, en este orden:
 *   1) NEURONAL  — pide el MP3 a /tts?t=<texto>&v=rojo|azul|sistema
 *                  (scripts/tts-server.mjs: ROJO = es-CO-GonzaloNeural,
 *                  AZUL = es-CO-SalomeNeural, sistema = es-ES-ElviraNeural).
 *   2) NAVEGADOR — si el servicio no está (GitHub Pages, sin red, sin Python),
 *                  cae a speechSynthesis con las voces del sistema. Más robóticas,
 *                  pero el botón de voz nunca se queda muerto.
 *
 * API compatible con v1:
 *   version, disponible(), activo(), activar(), silenciar(), alternar(),
 *   decir(texto, agente), activarSiParam(), vocesDisponibles()
 * Añade: motor(), baseTTS(), precalentar(texto, agente)
 * Añade v2.2.0: setVolumen(v) / getVolumen() / duck(bool) y la propiedad
 *   `volumen` (0..1, por defecto 0.85). El volumen se aplica a las TRES rutas
 *   de reproducción: <audio> neuronal, pack de MP3 y speechSynthesis.
 *
 * Reglas de oro:
 *   - Nunca lanza ni bloquea el visor: todo va en try/catch y con topes de tiempo.
 *   - Cola máxima de 6 frases; si el show habla más rápido de lo que suena,
 *     se tiran las viejas antes que ir 15 segundos por detrás.
 *   - Frases recortadas a 240 caracteres y limpias de markdown/emoji.
 * ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '2.2.0';
  var MAX_TEXTO = 240;
  var MAX_COLA = 6;
  var TIMEOUT_FETCH = 9000;
  var VOLUMEN_DEFECTO = 0.85;    // nivel de las voces del show
  var DUCK_FACTOR = 0.3;         // duck(): baja al 30 % mientras suena otra cosa

  var synth = global.speechSynthesis || null;
  var Audio_ = global.Audio || null;

  var activo = false;
  var cola = [];                 // {texto, agente, promesa, origen}
  var hablando = false;
  var motor = 'desconocido';     // 'neural' | 'pack' | 'navegador' | 'nada' | 'desconocido'
  var baseTTS = null;            // se resuelve una vez
  var pack = null;               // {base, eventos:{seq:{archivo}}} voces pregrabadas (repetição)
  var fallosNeural = 0;
  var audioActual = null;
  var voces = [];
  var elegidas = { rojo: null, azul: null, sistema: null };
  var volumen = VOLUMEN_DEFECTO; // 0..1
  var duckActivo = false;        // true = volumen reducido temporalmente

  /* Perfil de respaldo (solo se usa con speechSynthesis). */
  var PERFIL = {
    rojo: { rate: 1.02, pitch: 0.72, volume: 0.95, prefer: /pablo|alvaro|jorge|david|male|hombre/i },
    azul: { rate: 0.98, pitch: 1.16, volume: 0.95, prefer: /helena|laura|elvira|monica|ximena|female|mujer/i },
    sistema: { rate: 1.0, pitch: 1.0, volume: 0.9, prefer: /helena|laura|elvira|monica|ximena|es-/i }
  };

  function log() {
    try {
      if (global.__WB_VOZ_DEBUG__) console.log.apply(console, ['[voz]'].concat([].slice.call(arguments)));
    } catch (e) { /* nada */ }
  }

  /* -------------------------------------------------------------------------
   * Volumen (panel de audio del show)
   * ----------------------------------------------------------------------
   * volumen      0..1, por defecto 0.85
   * duck(bool)   baja al 30 % mientras suena otra cosa (música, vídeo...)
   * El nivel se aplica a las TRES rutas: <audio> neuronal, pack y
   * speechSynthesis. En una utterance ya en curso no se puede cambiar el
   * volumen a mitad, así que el valor se aplica a la siguiente.
   */
  function acotarVolumen(v) {
    var n = Number(v);
    if (!isFinite(n)) return volumen;
    return Math.max(0, Math.min(1, n));
  }

  function volumenEfectivo() {
    return duckActivo ? volumen * DUCK_FACTOR : volumen;
  }

  function aplicarVolumenActual() {
    try { if (audioActual) audioActual.volume = volumenEfectivo(); } catch (e) { /* nada */ }
  }

  function setVolumen(v) {
    volumen = acotarVolumen(v);
    aplicarVolumenActual();
    log('volumen=' + volumen.toFixed(2) + (duckActivo ? ' (duck)' : ''));
    return volumen;
  }

  function getVolumen() { return volumen; }

  function duck(activoDuck) {
    duckActivo = !!activoDuck;
    aplicarVolumenActual();
    log('duck=' + duckActivo + ' -> volumen efectivo ' + volumenEfectivo().toFixed(2));
    return duckActivo;
  }

  /* Limpia el texto ANTES de enviarlo: la voz no debe leer símbolos.
   * Aquí se hace la parte barata (markdown, URLs, emoji, % y unidades);
   * los números a letras los convierte el servidor (scripts/tts-server.mjs),
   * que es quien sintetiza. Así el respaldo del navegador también mejora. */
  function limpiar(t) {
    return String(t == null ? '' : t)
      .replace(/https?:\/\/\S+/g, ' enlace ')
      .replace(/www\.\S+/gi, ' enlace ')
      .replace(/[*_`#>|~]+/g, ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
      .replace(/\s*%\s*/g, ' por ciento ')
      .replace(/(\d)\s*km\b/gi, '$1 kilómetros')
      .replace(/\bkm\b/gi, 'kilómetros')
      .replace(/(\d)\s*kg\b/gi, '$1 kilos')
      .replace(/\bkg\b/gi, 'kilos')
      .replace(/\s*&\s*/g, ' y ')
      .replace(/\bvs\.?(?=\s|$)/gi, ' contra ')
      .replace(/[!?]{2,}/g, function (m) { return m.indexOf('?') >= 0 ? '?' : '!'; })
      .replace(/¡{2,}/g, '¡')
      .replace(/¿{2,}/g, '¿')
      .replace(/\.{3,}|…/g, ', ')
      .replace(/[—–]/g, ', ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* -------------------------------------------------------------------------
   * Resolución del servicio de voz
   * ---------------------------------------------------------------------- */
  function baseResuelta() {
    if (baseTTS !== null) return baseTTS;
    var b = '';
    try {
      if (typeof global.__WB_TTS_BASE__ === 'string') {
        b = global.__WB_TTS_BASE__;                       // inyección explícita
      } else {
        var host = String(location.hostname || '');
        if (/\.trycloudflare\.com$/i.test(host)) {
          b = location.origin;                            // el túnel sirve /tts por la pasarela
        } else if (/\.github\.io$/i.test(host)) {
          b = '';                                         // Pages no tiene servicio de voz
        } else if (/^(localhost|127\.0\.0\.1)$/i.test(host)) {
          b = 'http://127.0.0.1:8771';                    // servicio local directo
        } else if (/^https?:$/.test(location.protocol)) {
          b = location.origin;                            // mismo origen (pasarela / proxy propio)
        }
      }
    } catch (e) { b = ''; }
    baseTTS = b ? String(b).replace(/\/+$/, '') : '';
    return baseTTS;
  }

  function urlTTS(texto, agente) {
    var b = baseResuelta();
    if (!b) return '';
    return b + '/tts?t=' + encodeURIComponent(texto) + '&v=' + encodeURIComponent(agente || 'sistema');
  }

  /* -------------------------------------------------------------------------
   * Motor 0: pack de voces pregrabadas (la repetición publicada)
   * ---------------------------------------------------------------------- */
  function usarPack(base, manifiesto) {
    try {
      if (!base) { pack = null; return false; }
      var evs = (manifiesto && (manifiesto.eventos || manifiesto)) || {};
      pack = { base: String(base).replace(/\/+$/, ''), eventos: evs };
      log('pack de voces:', Object.keys(evs).length, 'eventos en', pack.base);
      return true;
    } catch (e) { pack = null; return false; }
  }

  function urlPack(seq) {
    if (!pack || seq == null || seq === '') return '';
    var e = pack.eventos[seq] || pack.eventos[String(seq)];
    if (!e) return '';
    var archivo = (typeof e === 'string') ? e : (e.archivo || (seq + '.mp3'));
    return pack.base + '/' + archivo;
  }

  function pedirPack(url, texto, agente) {
    return fetch(url, { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('pack http ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        if (!blob || blob.size < 800) throw new Error('pack vacio');
        return { url: global.URL.createObjectURL(blob), origen: 'pack' };
      })
      .catch(function () {
        log('pack no disponible, tiro de sintesis', url);
        return pedirAudio(texto, agente).then(function (u) { return { url: u, origen: 'neural' }; });
      });
  }

  /* -------------------------------------------------------------------------
   * Motor 1: audio neuronal (fetch + <audio>)
   * ---------------------------------------------------------------------- */
  function pedirAudio(texto, agente) {
    var url = urlTTS(texto, agente);
    if (!url || motor === 'navegador') return Promise.resolve('');
    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var tope = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, TIMEOUT_FETCH);
    var opciones = { cache: 'force-cache' };
    if (ctrl) opciones.signal = ctrl.signal;
    return fetch(url, opciones)
      .then(function (r) {
        clearTimeout(tope);
        if (!r.ok) throw new Error('tts http ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        if (!blob || blob.size < 800) throw new Error('audio vacio');
        return global.URL.createObjectURL(blob);
      })
      .catch(function (e) {
        clearTimeout(tope);
        fallosNeural++;
        log('fallo neuronal', e && e.message, 'fallos=' + fallosNeural);
        if (fallosNeural >= 2) {
          motor = synth ? 'navegador' : 'nada';
          log('paso a voces del navegador');
        }
        return '';
      });
  }

  function reproducir(url, fin, origen) {
    var hecho = false;
    function terminar() {
      if (hecho) return;
      hecho = true;
      audioActual = null;
      try { global.URL.revokeObjectURL(url); } catch (e) {}
      fin();
    }
    try {
      var a = new Audio_(url);
      audioActual = a;
      a.volume = volumenEfectivo();
      a.onended = terminar;
      a.onerror = terminar;
      var p = a.play();
      if (p && typeof p.catch === 'function') p.catch(function () { terminar(); });
      motor = origen || 'neural';
      fallosNeural = 0;
      setTimeout(terminar, 45000);           // red de seguridad
    } catch (e) {
      terminar();
    }
  }

  /* -------------------------------------------------------------------------
   * Motor 2: voces del navegador (respaldo)
   * ---------------------------------------------------------------------- */
  function cargarVoces() {
    if (!synth || typeof synth.getVoices !== 'function') return;
    try {
      var todas = synth.getVoices() || [];
      voces = todas.filter(function (v) { return /^es([-_]|$)/i.test(v.lang || ''); });
      if (!voces.length) voces = todas.slice(0);
      ['rojo', 'azul', 'sistema'].forEach(function (k) {
        var lista = voces.filter(function (v) { return PERFIL[k].prefer.test(v.name || ''); });
        elegidas[k] = lista[0] || voces[0] || null;
      });
      log('voces del navegador:', voces.length);
    } catch (e) { /* nada */ }
  }

  function hablarNavegador(texto, agente, fin) {
    if (!synth) { fin(); return; }
    var hecho = false;
    function terminar() {
      if (hecho) return;
      hecho = true;
      fin();
    }
    try {
      var perfil = PERFIL[agente] || PERFIL.sistema;
      var u = new global.SpeechSynthesisUtterance(texto);
      var voz = elegidas[agente] || elegidas.sistema;
      if (voz) u.voice = voz;
      u.lang = (voz && voz.lang) || 'es-ES';
      u.rate = perfil.rate;
      u.pitch = perfil.pitch;
      u.volume = volumenEfectivo();
      u.onend = terminar;
      u.onerror = terminar;
      motor = 'navegador';
      synth.speak(u);
      setTimeout(terminar, Math.max(4000, texto.length * 95 + 1800));
    } catch (e) {
      terminar();
    }
  }

  /* -------------------------------------------------------------------------
   * Cola
   * ---------------------------------------------------------------------- */
  function siguiente() {
    if (!activo) { hablando = false; return; }
    var it = cola.shift();
    if (!it) { hablando = false; return; }
    hablando = true;
    it.promesa.then(function (res) {
      if (!activo) { hablando = false; return; }
      var url = (typeof res === 'string') ? res : (res && res.url);
      var origen = (res && res.origen) || 'neural';
      if (url) reproducir(url, siguiente, origen);
      else hablarNavegador(it.texto, it.agente, siguiente);
    });
  }

  function decir(texto, agente, opts) {
    if (!activo) return false;
    var t = limpiar(texto);
    if (!t) return false;
    if (t.length > MAX_TEXTO) t = t.slice(0, MAX_TEXTO - 1) + '…';
    var a = (agente === 'rojo' || agente === 'azul') ? agente : 'sistema';
    while (cola.length >= MAX_COLA) cola.shift();     // tira lo viejo
    var urlP = urlPack(opts && opts.seq);
    var promesa = urlP
      ? pedirPack(urlP, t, a)
      : pedirAudio(t, a).then(function (u) { return { url: u, origen: 'neural' }; });
    cola.push({ texto: t, agente: a, promesa: promesa });
    if (!hablando) siguiente();
    return true;
  }

  /* Precalienta la síntesis de una frase sin encolarla (la cachea el servidor). */
  function precalentar(texto, agente) {
    var t = limpiar(texto);
    if (!t) return;
    pedirAudio(t.slice(0, MAX_TEXTO), agente).then(function (u) {
      if (u) { try { global.URL.revokeObjectURL(u); } catch (e) {} }
    });
  }

  /* -------------------------------------------------------------------------
   * Encendido / apagado
   * ---------------------------------------------------------------------- */
  function disponible() {
    return !!(Audio_ || synth);
  }

  function activoAhora() { return !!activo; }

  function activar() {
    if (!disponible()) return false;
    activo = true;
    // Desbloquea el audio dentro del gesto del usuario (política de autoplay).
    try {
      if (Audio_) {
        var a = new Audio_('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=');
        var p = a.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* nada */ }
    try {
      if (synth && typeof global.SpeechSynthesisUtterance === 'function') {
        var u = new global.SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
      }
    } catch (e) { /* nada */ }
    log('activado, motor=' + motor + ' base=' + (baseResuelta() || '(ninguna)'));
    return true;
  }

  function silenciar() {
    activo = false;
    hablando = false;
    cola.length = 0;
    try { if (audioActual) { audioActual.pause(); audioActual = null; } } catch (e) {}
    try { if (synth) synth.cancel(); } catch (e) {}
    return true;
  }

  function alternar() {
    if (activo) silenciar(); else activar();
    return activo;
  }

  function activarSiParam() {
    try {
      var q = new URLSearchParams(global.location.search || '');
      if (q.get('voces') === '1') { activar(); return true; }
      if (q.get('voces') === '0') { return false; }
    } catch (e) { /* nada */ }
    return false;
  }

  function vocesDisponibles() {
    return voces.map(function (v) { return { nombre: v.name, idioma: v.lang }; });
  }

  /* -------------------------------------------------------------------------
   * Arranque
   * ---------------------------------------------------------------------- */
  if (synth) {
    cargarVoces();
    if (typeof synth.addEventListener === 'function') {
      try { synth.addEventListener('voiceschanged', cargarVoces); } catch (e) {}
    } else {
      synth.onvoiceschanged = cargarVoces;
    }
    setTimeout(cargarVoces, 1200);
  }

  global.ViewerVoz = {
    version: VERSION,
    disponible: disponible,
    activo: activoAhora,
    activar: activar,
    silenciar: silenciar,
    alternar: alternar,
    decir: decir,
    /* Estado real de locucion: true mientras suena una frase o queda cola.
     * El mezclador de audio lo usa para bajar la musica (duck) sin tener que
     * adivinar duraciones por longitud de texto. */
    hablando: function () { return !!activo && (hablando || cola.length > 0); },
    enCola: function () { return cola.length; },
    usarPack: usarPack,
    precalentar: precalentar,
    activarSiParam: activarSiParam,
    vocesDisponibles: vocesDisponibles,
    normalizar: limpiar,
    setVolumen: setVolumen,
    getVolumen: getVolumen,
    duck: duck,
    motor: function () { return motor; },
    baseTTS: baseResuelta
  };
  /* Propiedad cómoda: ViewerVoz.volumen = 0.6  /  ViewerVoz.volumen -> 0.6 */
  try {
    Object.defineProperty(global.ViewerVoz, 'volumen', {
      get: getVolumen,
      set: setVolumen,
      enumerable: true,
      configurable: true
    });
  } catch (e) { /* navegadores muy viejos: quedan los métodos */ }
})(typeof window !== 'undefined' ? window : this);
