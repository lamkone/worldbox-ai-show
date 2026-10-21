/* ============================================================================
 * show-music.js — Banda sonora procedural del WorldBox AI Show
 * ----------------------------------------------------------------------------
 * Música sintetizada con WebAudio: sin ficheros, sin dependencias, sin red.
 * Suena a "retransmisión de guerra": drone grave, pulso de percusión, acordes
 * menores y, cuando la tensión sube, arpegio de 16avos.
 *
 * API pública (window.ShowMusic):
 *   version                      -> "1.0.0"
 *   init()                       -> crea el AudioContext (idempotente)
 *   desbloquear()                -> resume el contexto (llamar en un gesto)
 *   start() / stop() / toggle()  -> arranca / para / alterna
 *   activo()                     -> bool
 *   setVolume(v) / getVolume()   -> volumen música 0..1
 *   setIntensidad(x)             -> 0..1 (más capas y algo más de tempo)
 *   duck(bool)                   -> baja la música mientras habla una voz
 *   efecto(nombre)               -> "boom" | "ding" | "fanfarria" | "whoosh" | "tick"
 *   setVolumenEfectos(v) / getVolumenEfectos()
 *
 * Reglas: nunca lanza si el navegador no soporta WebAudio (degrada en silencio).
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ShowMusic && window.ShowMusic.version) return; // ya cargado

  var VERSION = '1.0.0';

  var ctx = null;
  var master = null;       // ganancia general de música
  var comp = null;         // compresor/limitador
  var droneGain = null;
  var padGain = null;
  var percGain = null;
  var arpGain = null;
  var sfxGain = null;      // efectos de sonido (aparte, no le afecta duck)
  var ruidoBuf = null;

  var iniciado = false;
  var sonando = false;
  var pendiente = false;   // se pidió start() pero el navegador aún no deja sonar
  var gestosPuestos = false;
  var timer = null;
  var nextTime = 0;
  var paso = 0;            // paso de 16avo dentro del compás
  var bpm = 92;

  var volumen = 0.55;          // 0..1
  var volumenEfectos = 0.7;    // 0..1
  var intensidad = 0.35;       // 0..1
  var duckActivo = false;

  // Progresión en Re menor: Dm - Bb - Gm - A (2 compases cada acorde)
  var ACORDES = [
    [146.83, 174.61, 220.00],   // Dm  (D3 F3 A3)
    [116.54, 146.83, 174.61],   // Bb  (Bb2 D3 F3)
    [98.00, 116.54, 146.83],    // Gm  (G2 Bb2 D3)
    [110.00, 138.59, 164.81]    // A   (A2 C#3 E3)
  ];
  var BAJOS = [73.42, 58.27, 49.00, 55.00]; // D2 Bb1 G1 A1

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function ahora() { return ctx ? ctx.currentTime : 0; }

  // ---------------------------------------------------------------- init ---
  function init() {
    if (iniciado) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
      return false;
    }

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.22;

    master = ctx.createGain();
    master.gain.value = volumen;
    master.connect(comp);
    comp.connect(ctx.destination);

    droneGain = ctx.createGain(); droneGain.gain.value = 0.0; droneGain.connect(master);
    padGain = ctx.createGain();   padGain.gain.value = 0.0;   padGain.connect(master);
    percGain = ctx.createGain();  percGain.gain.value = 0.0;  percGain.connect(master);
    arpGain = ctx.createGain();   arpGain.gain.value = 0.0;   arpGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = volumenEfectos;
    sfxGain.connect(comp);

    // Buffer de ruido blanco (para charles y golpes)
    var n = Math.floor(ctx.sampleRate * 0.5);
    ruidoBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = ruidoBuf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    iniciado = true;
    return true;
  }

  function desbloquear() {
    if (!init()) return false;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx.state === 'running';
  }

  // ------------------------------------------------------------- música ---
  function notaOsc(freq, t, dur, tipo, gainVal, destino, detune) {
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = tipo || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gainVal, t + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(destino);
    o.start(t); o.stop(t + dur + 0.02);
    return o;
  }

  function ruido(t, dur, gainVal, destino, tipoFiltro, freqFiltro, q) {
    var s = ctx.createBufferSource();
    s.buffer = ruidoBuf;
    var f = ctx.createBiquadFilter();
    f.type = tipoFiltro || 'highpass';
    f.frequency.value = freqFiltro || 6000;
    if (q) f.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(destino);
    s.start(t); s.stop(t + dur + 0.02);
  }

  function kick(t, fuerte) {
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(fuerte ? 132 : 108, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(fuerte ? 0.95 : 0.6, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (fuerte ? 0.42 : 0.28));
    o.connect(g); g.connect(percGain);
    o.start(t); o.stop(t + 0.5);
  }

  function charles(t, abierto) {
    ruido(t, abierto ? 0.16 : 0.05, abierto ? 0.20 : 0.11, percGain, 'highpass', abierto ? 7200 : 8600, 0.9);
  }

  function caja(t, gainVal) {
    ruido(t, 0.12, gainVal || 0.16, percGain, 'bandpass', 1900, 1.1);
    notaOsc(190, t, 0.09, 'triangle', 0.10, percGain);
  }

  function pad(acorde, t, dur) {
    for (var i = 0; i < acorde.length; i++) {
      var f = acorde[i];
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      var g = ctx.createGain(), lp = ctx.createBiquadFilter();
      o1.type = 'sawtooth'; o2.type = 'sawtooth';
      o1.frequency.value = f; o2.frequency.value = f;
      o1.detune.value = -7; o2.detune.value = +7;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, t);
      lp.frequency.linearRampToValueAtTime(1500, t + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(800, t + dur);
      lp.Q.value = 0.8;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.055, t + 0.5);
      g.gain.linearRampToValueAtTime(0.045, t + dur * 0.75);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(padGain);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
  }

  function arpegio(freq, t, dur) {
    notaOsc(freq * 2, t, dur, 'triangle', 0.075, arpGain);
    notaOsc(freq * 4, t, dur * 0.6, 'sine', 0.025, arpGain);
  }

  function programarPaso(t) {
    var beat = 60 / bpm;
    var pasoDur = beat / 4;          // 16avo
    var compas = Math.floor(paso / 16);      // compás global
    var acorde = ACORDES[compas % ACORDES.length];
    var bajo = BAJOS[compas % BAJOS.length];

    // Drone continuo: Re grave que respira
    if (paso % 16 === 0) {
      var dur = pasoDur * 16;
      notaOsc(36.71, t, dur, 'sine', 0.16, droneGain);           // D1
      notaOsc(73.42, t, dur, 'triangle', 0.05, droneGain);       // D2
    }

    // Acorde al empezar cada 2 compases
    if (paso % 32 === 0) pad(acorde, t, pasoDur * 32 * 1.02);

    // Percusión
    if (paso % 16 === 0) kick(t, true);
    if (paso % 16 === 8) kick(t, false);
    if (intensidad > 0.25 && paso % 16 === 14) kick(t, false);
    if (paso % 4 === 2) charles(t, false);
    if (intensidad > 0.5 && paso % 8 === 6) charles(t, true);
    if (intensidad > 0.6 && (paso % 16 === 4 || paso % 16 === 12)) caja(t, 0.14);

    // Bajo en contratiempos
    if (paso % 8 === 0 || paso % 8 === 6) {
      notaOsc(bajo, t, pasoDur * 3.4, 'sawtooth', 0.11, percGain);
      notaOsc(bajo * 2, t, pasoDur * 2.0, 'square', 0.03, percGain);
    }

    // Arpegio cuando la tensión sube
    if (intensidad > 0.45 && paso % 2 === 0) {
      var idx = (paso / 2) % 3;
      arpegio(acorde[idx], t, pasoDur * 1.8);
    }
    if (intensidad > 0.8 && paso % 4 === 1) {
      arpegio(acorde[(paso + 1) % 3] * 2, t, pasoDur * 1.2);
    }

    paso = (paso + 1) % 64;
  }

  function planificador() {
    if (!sonando || !ctx) return;
    if (ctx.state !== 'running') return;   // suspendido: no programes notas (evita warnings)
    var beat = 60 / bpm;
    var pasoDur = beat / 4;
    var horizonte = 0.16;
    while (nextTime < ahora() + horizonte) {
      programarPaso(nextTime);
      nextTime += pasoDur;
    }
  }

  function aplicarVolumen(ramp) {
    if (!master) return;
    var v = duckActivo ? volumen * 0.28 : volumen;
    var t = ahora();
    try {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(v, t + (ramp === undefined ? 0.12 : ramp));
    } catch (e) {
      master.gain.value = v;
    }
  }

  // El navegador no deja sonar hasta que hay un gesto del usuario. En vez de
  // programar notas sobre un contexto suspendido (Chrome escupe un warning por
  // cada una), se espera al primer gesto y entonces se arranca de verdad.
  function instalarGestos() {
    if (gestosPuestos) return;
    gestosPuestos = true;
    var despertar = function () {
      var ok = desbloquear();
      if (ok && pendiente) {
        pendiente = false;
        arrancarProgramacion();
      }
      if (ok) quitarGestos();
    };
    window.addEventListener('pointerdown', despertar, true);
    window.addEventListener('keydown', despertar, true);
    window.addEventListener('touchstart', despertar, true);
    window.__showMusicDespertar = despertar;
  }

  function quitarGestos() {
    if (!gestosPuestos) return;
    gestosPuestos = false;
    var d = window.__showMusicDespertar;
    if (!d) return;
    window.removeEventListener('pointerdown', d, true);
    window.removeEventListener('keydown', d, true);
    window.removeEventListener('touchstart', d, true);
    window.__showMusicDespertar = null;
  }

  function arrancarProgramacion() {
    if (!ctx || ctx.state !== 'running') { pendiente = true; instalarGestos(); return false; }
    paso = 0;
    bpm = 88 + Math.round(intensidad * 22);
    nextTime = ahora() + 0.08;
    var t = ahora();
    droneGain.gain.cancelScheduledValues(t);
    droneGain.gain.setValueAtTime(droneGain.gain.value, t);
    droneGain.gain.linearRampToValueAtTime(1.0, t + 1.2);
    padGain.gain.cancelScheduledValues(t);
    padGain.gain.setValueAtTime(padGain.gain.value, t);
    padGain.gain.linearRampToValueAtTime(1.0, t + 1.6);
    percGain.gain.cancelScheduledValues(t);
    percGain.gain.setValueAtTime(percGain.gain.value, t);
    percGain.gain.linearRampToValueAtTime(1.0, t + 0.8);
    arpGain.gain.cancelScheduledValues(t);
    arpGain.gain.setValueAtTime(arpGain.gain.value, t);
    arpGain.gain.linearRampToValueAtTime(1.0, t + 1.0);
    aplicarVolumen(0.4);
    if (timer) clearInterval(timer);
    timer = setInterval(planificador, 25);
    planificador();
    return true;
  }

  function start() {
    if (!init()) return false;
    if (sonando) { desbloquear(); return true; }
    sonando = true;
    if (!desbloquear()) { pendiente = true; instalarGestos(); return true; }
    arrancarProgramacion();
    return true;
  }

  function stop() {
    if (!sonando) return;
    sonando = false;
    pendiente = false;
    quitarGestos();
    if (timer) { clearInterval(timer); timer = null; }
    if (!ctx) return;
    var t = ahora();
    [droneGain, padGain, percGain, arpGain].forEach(function (g) {
      if (!g) return;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      } catch (e) {}
    });
  }

  function toggle() { if (sonando) { stop(); return false; } return start(); }

  // ------------------------------------------------------------- efectos ---
  function efecto(nombre) {
    if (!init()) return;
    if (!desbloquear() || ctx.state !== 'running') return;  // sin gesto no suena: no programes
    var t = ahora() + 0.01;
    nombre = String(nombre || '').toLowerCase();
    if (nombre === 'boom') {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + 1.0);
      ruido(t, 0.5, 0.35, sfxGain, 'lowpass', 900, 0.7);
    } else if (nombre === 'ding') {
      notaOsc(880, t, 0.35, 'sine', 0.22, sfxGain);
      notaOsc(1320, t + 0.02, 0.28, 'sine', 0.12, sfxGain);
    } else if (nombre === 'fanfarria') {
      var notas = [392.0, 493.88, 587.33, 783.99];
      for (var i = 0; i < notas.length; i++) {
        notaOsc(notas[i], t + i * 0.11, 0.5, 'triangle', 0.18, sfxGain);
        notaOsc(notas[i] * 2, t + i * 0.11, 0.35, 'sine', 0.06, sfxGain);
      }
      notaOsc(783.99, t + 0.55, 0.9, 'triangle', 0.2, sfxGain);
    } else if (nombre === 'whoosh') {
      ruido(t, 0.35, 0.28, sfxGain, 'bandpass', 1200, 1.6);
    } else if (nombre === 'tick') {
      ruido(t, 0.03, 0.10, sfxGain, 'highpass', 9000, 0.8);
    }
  }

  // ---------------------------------------------------------------- API ---
  window.ShowMusic = {
    version: VERSION,
    init: init,
    desbloquear: desbloquear,
    start: start,
    stop: stop,
    toggle: toggle,
    activo: function () { return !!sonando; },
    setVolume: function (v) { volumen = clamp01(v); aplicarVolumen(0.08); return volumen; },
    getVolume: function () { return volumen; },
    setIntensidad: function (x) {
      intensidad = clamp01(x);
      bpm = 88 + Math.round(intensidad * 22);
      return intensidad;
    },
    getIntensidad: function () { return intensidad; },
    duck: function (on) {
      var nuevo = !!on;
      if (nuevo === duckActivo) return;
      duckActivo = nuevo;
      aplicarVolumen(0.18);
    },
    efecto: efecto,
    setVolumenEfectos: function (v) {
      volumenEfectos = clamp01(v);
      if (sfxGain) sfxGain.gain.value = volumenEfectos;
      return volumenEfectos;
    },
    getVolumenEfectos: function () { return volumenEfectos; }
  };
})();
