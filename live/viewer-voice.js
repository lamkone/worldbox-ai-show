/* ============================================================================
 * viewer-voice.js — VOCES del WorldBox AI Show (v1.0.0)
 * ----------------------------------------------------------------------------
 * Usa la Web Speech API del navegador (speechSynthesis): cero dependencias,
 * cero red, cero ficheros de audio. Cada IA tiene su propia voz y entonación.
 *
 *   ViewerVoz.activar()            -> enciende las voces (requiere gesto del usuario)
 *   ViewerVoz.silenciar()          -> apaga
 *   ViewerVoz.alternar()           -> on/off, devuelve el estado
 *   ViewerVoz.decir(texto, agente) -> encola una frase ('rojo' | 'azul' | 'sistema')
 *   ViewerVoz.activarSiParam()     -> si la URL trae ?voces=1 intenta encender
 *   ViewerVoz.activo / disponible / vocesDisponibles()
 *
 * Si el navegador no soporta speechSynthesis, todo degrada en silencio.
 * ========================================================================== */
(function (global) {
  'use strict';

  var synth = global.speechSynthesis || null;
  var activo = false;
  var cola = [];
  var hablando = false;
  var voces = [];
  var elegidas = { rojo: null, azul: null, sistema: null };
  var avisado = false;

  /* Perfiles de voz: ROJO grave y agresivo, AZUL más agudo y pedante. */
  var PERFIL = {
    rojo: { rate: 1.04, pitch: 0.72, volume: 1.0, prefer: /pablo|alvaro|jorge|david|male|hombre/i },
    azul: { rate: 0.97, pitch: 1.18, volume: 1.0, prefer: /helena|laura|elvira|monica|female|mujer/i },
    sistema: { rate: 1.0, pitch: 1.0, volume: 0.9, prefer: /helena|laura|elvira/i }
  };

  function cargarVoces() {
    if (!synth) return;
    try { voces = synth.getVoices() || []; } catch (e) { voces = []; }
    if (!voces.length) return;
    var es = voces.filter(function (v) { return /^es(-|_)/i.test(v.lang || ''); });
    var lista = es.length ? es : voces;
    ['rojo', 'azul', 'sistema'].forEach(function (k) {
      var pref = PERFIL[k].prefer;
      var elegida = lista.filter(function (v) { return pref.test(v.name || ''); })[0];
      if (!elegida) elegida = lista[k === 'azul' ? (lista.length > 1 ? 1 : 0) : 0];
      elegidas[k] = elegida || null;
    });
    if (!avisado && es.length === 0) {
      avisado = true;
      if (global.console && console.info) console.info('[voz] no hay voces en español; se usan las del sistema');
    }
  }

  if (synth) {
    cargarVoces();
    try {
      synth.addEventListener('voiceschanged', cargarVoces);
    } catch (e) {
      synth.onvoiceschanged = cargarVoces;
    }
  }

  function disponible() { return !!synth; }

  function vocesDisponibles() {
    if (!voces.length) cargarVoces();
    return voces.map(function (v) { return { name: v.name, lang: v.lang }; });
  }

  function activar() {
    if (!synth) return false;
    activo = true;
    cargarVoces();
    /* Un speak vacío "desbloquea" la síntesis tras el gesto del usuario. */
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0.01;
      u.lang = 'es-ES';
      synth.speak(u);
    } catch (e) {}
    return true;
  }

  function silenciar() {
    activo = false;
    cola.length = 0;
    hablando = false;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    return false;
  }

  function alternar() {
    if (activo) { silenciar(); return false; }
    return activar();
  }

  /* Limpia markdown/emoji suelto para que la voz no lea símbolos raros. */
  function limpiar(t) {
    return String(t == null ? '' : t)
      .replace(/https?:\/\/\S+/g, ' enlace ')
      .replace(/[*_`#>|]/g, ' ')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function siguiente() {
    if (!activo || hablando || !cola.length || !synth) return;
    var item = cola.shift();
    var texto = limpiar(item.texto);
    if (!texto) { siguiente(); return; }
    var perfil = PERFIL[item.agente] || PERFIL.sistema;
    var u;
    try {
      u = new SpeechSynthesisUtterance(texto);
    } catch (e) { return; }
    u.lang = 'es-ES';
    u.rate = perfil.rate;
    u.pitch = perfil.pitch;
    u.volume = perfil.volume;
    if (elegidas[item.agente]) u.voice = elegidas[item.agente];
    hablando = true;
    u.onend = function () { hablando = false; setTimeout(siguiente, 90); };
    u.onerror = function () { hablando = false; setTimeout(siguiente, 90); };
    try {
      synth.speak(u);
    } catch (e) {
      hablando = false;
      if (!avisado) { avisado = true; if (global.console && console.warn) console.warn('[voz] el navegador bloqueó la síntesis:', e && e.message); }
    }
  }

  /* Encola una frase. Corta las muy largas para que el show no se descuadre. */
  function decir(texto, agente, opts) {
    if (!activo || !synth) return false;
    var o = opts || {};
    var t = String(texto == null ? '' : texto).trim();
    if (!t) return false;
    if (t.length > 190) t = t.slice(0, 187).replace(/\s+\S*$/, '') + '…';
    /* Si hay mucha cola, tira lo viejo: mejor perder una frase que ir 20 s tarde. */
    if (cola.length > 4) cola.splice(0, cola.length - 4);
    cola.push({ texto: t, agente: agente || 'sistema', prioridad: !!o.prioridad });
    if (o.prioridad) { cola.unshift(cola.pop()); }
    siguiente();
    return true;
  }

  function activarSiParam() {
    try {
      var q = String((global.location && global.location.search) || '');
      if (/(?:^|[?&])voces=1(?:&|$)/.test(q)) return activar();
    } catch (e) {}
    return false;
  }

  global.ViewerVoz = {
    version: '1.0.0',
    disponible: disponible,
    vocesDisponibles: vocesDisponibles,
    activo: function () { return activo; },
    activar: activar,
    silenciar: silenciar,
    alternar: alternar,
    decir: decir,
    activarSiParam: activarSiParam
  };
})(typeof window !== 'undefined' ? window : this);
