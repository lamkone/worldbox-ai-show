/* ============================================================================
 * show-music.js — Banda sonora procedural del WorldBox AI Show · v2.0.0
 * ----------------------------------------------------------------------------
 * Motor MULTI-PISTA con WebAudio puro: sin ficheros, sin dependencias, sin red.
 * Cada pista es un loop procedural de 8 compases con sus acordes, bajo,
 * percusión, arpegio y (en algunas) metales. Las pistas se cruzan con
 * crossfade corto: no hay clics, no hay silencios y nunca suenan dos a la vez
 * más tiempo del crossfade.
 *
 * PISTAS
 *   espera   · pre-partida: drone grave + pad lento + pulso suave (la de antes)
 *   chill    · rondas tranquilas · 2 variantes (Am7-F-C-G / D-Bm-G-A)
 *   tension  · rondas de tensión media: latido, tics, cluster disonante
 *   combate  · rondas duras · 3 variantes (Dm-Bb-G-A / Em-C-G-D / Cm-Ab-Bb-G)
 *   victoria · post-partido: fanfarria mayor C-G-Am-F
 *
 * API pública (window.ShowMusic)
 *   version                          -> "2.0.0"
 *   init() / desbloquear()
 *   start() / stop() / toggle() / activo()
 *   setVolume(v) / getVolume()
 *   setIntensidad(0..1) / getIntensidad()   -> capas, tempo y variación
 *   duck(bool)                               -> baja mientras habla una voz
 *   efecto(nombre)                           -> boom|ding|fanfarria|whoosh|tick
 *   setVolumenEfectos(v) / getVolumenEfectos()
 *   --- NUEVO ---
 *   setFase('espera'|'chill'|'tension'|'combate'|'victoria'[, variante])
 *   setFase('auto')                          -> vuelve a selección automática
 *   setVariante(n)                           -> cambia variante de la pista actual
 *   setAuto()                                -> limpia el forzado
 *   auto(estado)                             -> elige pista según estado del show
 *   getPista()                               -> {pista,variante,bpm,loop,forzada,...}
 *   pistas()                                 -> catálogo [{id,nombre,variantes,bpm}]
 *   loopSegundos()                           -> duración del loop actual
 *   nivel()                                  -> {peak,rms,dbPeak,dbRms} del master
 *   capasActivas()                           -> capas audibles (crossfade en curso)
 *
 * AUTO-SELECCIÓN (auto(estado)) — acepta el state.json del show tal cual:
 *   estado.fase      espera | apertura | ronda | final
 *   estado.ronda     0..rondas
 *   estado.terminada / estado.ganador
 *   estado.drama.tension   0..100 (o 0..1)
 *   - espera / ronda 0        -> espera
 *   - apertura                -> tension
 *   - ronda con tensión >=62  -> combate, variante (ronda-1)%3  [alterna por ronda]
 *   - ronda con tensión <=30  -> chill,   variante (ronda-1)%2
 *   - ronda con tensión media  -> tension
 *   - terminada / final       -> victoria
 *   Con histéresis de ±5 puntos para que no parpadee en el umbral.
 *
 * CONTROL MANUAL
 *   URL:  ?musica=espera | chill | tension | combate | victoria | auto | off
 *         ?musica=combate&variante=2   (variante 1..3, 0 = primera)
 *   UI:   show-audio-ui.js pinta un selector de pista en el panel de volumen.
 *
 * Reglas: nunca lanza si el navegador no soporta WebAudio (degrada en silencio).
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ShowMusic && window.ShowMusic.version) return; // ya cargado

  var VERSION = '2.0.0';
  var FADE = 0.7;            // crossfade por defecto (s)
  var HORIZONTE = 0.16;      // programación por delante (s)
  var BAJAS_CHILL = 300;     // ≤ estas bajas en la ronda = "ronda tranquila" → chill

  var ctx = null;
  var master = null;         // ganancia general de música
  var comp = null;           // compresor de glue
  var limitador = null;      // limitador de seguridad (nada de clipping)
  var analizador = null;     // medida de nivel del master
  var sfxGain = null;        // efectos de sonido (aparte, no le afecta duck)
  var ruidoBuf = null;

  var iniciado = false;
  var sonando = false;
  var pendiente = false;     // se pidió start() pero el navegador aún no deja sonar
  var gestosPuestos = false;
  var timer = null;

  // v9.7 (21/10/2026): el dueño pidió bajar el sonido por defecto ("parece
  // estar un poco alto en general, aunque los niveles están bien equilibrados").
  // Factor 0,80 (≈ −2 dB) sobre los valores buenos: música 0,55 → 0,44 y
  // efectos 0,70 → 0,56. La voz va aparte (viewer-voice.js: 0,68).
  var volumen = 0.44;        // 0..1  (master de música; antes 0.55)
  var volumenEfectos = 0.56; // 0..1  (bus de efectos; antes 0.7)
  var intensidad = 0.35;     // 0..1
  var duckActivo = false;

  var capas = [];            // capas vivas: [{pistaId,pista,variante,bus,buses,paso,nextTime,bpm,quitarA}]
  var capaSeq = 0;
  var pistaActual = null;
  var varianteActual = 0;
  var faseForzada = null;    // {pista,variante} | null
  var pendienteFase = null;  // fase calculada antes de arrancar
  var ultimoEstado = null;   // último estado del show pasado a auto()
  var silencioURL = false;   // ?musica=off

  // ============================================================ utilidades ===
  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function ahora() { return ctx ? ctx.currentTime : 0; }

  function normalizarVariante(pista, n) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || n < 0) n = 0;
    var total = pista.variantes.length;
    return ((n % total) + total) % total;
  }

  function bpmDe(pista) {
    return pista.bpm + Math.round(intensidad * (pista.bpmPorIntensidad || 0));
  }

  // ================================================================== init ===
  function init() {
    if (iniciado) return true;
    leerURL();          // antes de crear nodos: ?musica=off debe verse en el primer start()
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
      return false;
    }

    // Compresor de glue: pega las capas sin bombear
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 20;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;

    // Limitador de seguridad: el peak final no pasa de ~-4 dBFS
    limitador = ctx.createDynamicsCompressor();
    limitador.threshold.value = -4;
    limitador.knee.value = 0;
    limitador.ratio.value = 20;
    limitador.attack.value = 0.002;
    limitador.release.value = 0.12;

    analizador = ctx.createAnalyser();
    analizador.fftSize = 2048;
    analizador.smoothingTimeConstant = 0.2;

    master = ctx.createGain();
    master.gain.value = volumen;
    master.connect(comp);
    comp.connect(limitador);
    limitador.connect(analizador);
    analizador.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = volumenEfectos;
    sfxGain.connect(comp);

    // Buffer de ruido blanco (charles, cajas, golpes)
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

  // ============================================================== sintesis ===
  // Todas las funciones reciben el nodo destino (sub-bus de la capa), de modo
  // que dos capas pueden sonar a la vez durante el crossfade sin mezclarse.
  function notaOsc(destino, freq, t, dur, tipo, gainVal, detune) {
    // blindaje: una frecuencia no finita (índice de acorde mal calculado) rompe
    // setValueAtTime y con él todo el planificador. Mejor una nota muda que el
    // silencio de todo el show.
    if (!isFinite(freq) || freq <= 0) return null;
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = tipo || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (detune) o.detune.setValueAtTime(detune, t);
    var at = Math.min(0.02, dur * 0.2);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gainVal, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(destino);
    o.start(t); o.stop(t + dur + 0.03);
    return o;
  }

  function ruido(destino, t, dur, gainVal, tipoFiltro, freqFiltro, q, ataque) {
    var s = ctx.createBufferSource();
    s.buffer = ruidoBuf;
    var f = ctx.createBiquadFilter();
    f.type = tipoFiltro || 'highpass';
    f.frequency.value = freqFiltro || 6000;
    if (q) f.Q.value = q;
    var g = ctx.createGain();
    var at = ataque == null ? 0.002 : ataque;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gainVal, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(destino);
    s.start(t); s.stop(t + dur + 0.03);
  }

  function kick(destino, t, fuerte) {
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(fuerte ? 132 : 108, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(fuerte ? 0.9 : 0.55, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (fuerte ? 0.42 : 0.28));
    o.connect(g); g.connect(destino);
    o.start(t); o.stop(t + 0.5);
  }

  function charles(destino, t, abierto, gain) {
    var g = gain == null ? (abierto ? 0.2 : 0.11) : gain;
    ruido(destino, t, abierto ? 0.16 : 0.05, g, 'highpass', abierto ? 7200 : 8600, 0.9);
  }

  function caja(destino, t, gainVal) {
    ruido(destino, t, 0.12, gainVal || 0.16, 'bandpass', 1900, 1.1);
    notaOsc(destino, 190, t, 0.09, 'triangle', 0.10);
  }

  function tom(destino, t, freq) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq || 150, t);
    o.frequency.exponentialRampToValueAtTime((freq || 150) * 0.55, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.30, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g); g.connect(destino);
    o.start(t); o.stop(t + 0.3);
  }

  function timbal(destino, t, freq) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq || 100, t);
    o.frequency.exponentialRampToValueAtTime((freq || 100) * 0.72, t + 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.42, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g); g.connect(destino);
    o.start(t); o.stop(t + 1.0);
  }

  function crash(destino, t, gain) {
    ruido(destino, t, 1.2, gain == null ? 0.10 : gain, 'highpass', 5200, 0.6, 0.004);
  }

  function padAcorde(destino, acorde, t, dur, opts) {
    opts = opts || {};
    var gain = opts.ganancia == null ? 0.055 : opts.ganancia;
    var tipo = opts.tipo || 'sawtooth';
    var corte = opts.corte == null ? 1400 : opts.corte;
    for (var i = 0; i < acorde.length; i++) {
      var f = acorde[i];
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      var g = ctx.createGain(), lp = ctx.createBiquadFilter();
      o1.type = tipo; o2.type = tipo;
      o1.frequency.value = f; o2.frequency.value = f;
      o1.detune.value = -7; o2.detune.value = +7;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(corte * 0.55, t);
      lp.frequency.linearRampToValueAtTime(corte, t + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(corte * 0.6, t + dur);
      lp.Q.value = 0.8;
      var at = Math.min(0.5, dur * 0.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + at);
      g.gain.linearRampToValueAtTime(gain * 0.82, t + dur * 0.75);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(destino);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
  }

  function pluck(destino, freq, t, dur, gain) {
    notaOsc(destino, freq, t, dur, 'sine', gain == null ? 0.06 : gain);
    notaOsc(destino, freq * 2, t, dur * 0.6, 'sine', (gain == null ? 0.06 : gain) * 0.35);
    notaOsc(destino, freq * 3, t, dur * 0.35, 'sine', (gain == null ? 0.06 : gain) * 0.12);
  }

  function arpegio(destino, freq, t, dur, gain) {
    notaOsc(destino, freq * 2, t, dur, 'triangle', gain == null ? 0.075 : gain);
    notaOsc(destino, freq * 4, t, dur * 0.6, 'sine', (gain == null ? 0.075 : gain) * 0.33);
  }

  function brass(destino, acorde, t, dur, gain) {
    for (var i = 0; i < acorde.length; i++) {
      var f = acorde[i];
      var o = ctx.createOscillator(), o2 = ctx.createOscillator();
      var g = ctx.createGain(), lp = ctx.createBiquadFilter();
      o.type = 'sawtooth'; o2.type = 'sawtooth';
      o.frequency.value = f; o2.frequency.value = f;
      o.detune.value = -5; o2.detune.value = +5;
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.linearRampToValueAtTime(2600, t + 0.05);
      lp.frequency.linearRampToValueAtTime(1200, t + dur);
      lp.Q.value = 0.7;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain == null ? 0.05 : gain, t + 0.03);
      g.gain.linearRampToValueAtTime((gain == null ? 0.05 : gain) * 0.6, t + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(destino);
      o.start(t); o2.start(t);
      o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
  }

  function campana(destino, freq, t, dur, gain) {
    var g = gain == null ? 0.05 : gain;
    notaOsc(destino, freq, t, dur, 'sine', g);
    notaOsc(destino, freq * 2.76, t, dur * 0.45, 'sine', g * 0.25);
    notaOsc(destino, freq * 1.5, t, dur * 0.7, 'sine', g * 0.12);
  }

  // ============================================================== patrones ===
  // firma: patron(c, t, paso) con c = {buses,acorde,bajo,compas,dur,int,pista,v}
  function patronEspera(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde;
    if (paso % 16 === 0) {
      notaOsc(B.drone, 36.71, t, d * 16, 'sine', 0.16);
      notaOsc(B.drone, 73.42, t, d * 16, 'triangle', 0.045);
    }
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32 * 1.02, { ganancia: 0.055 });
    if (paso % 16 === 0) kick(B.perc, t, true);
    if (paso % 16 === 8) kick(B.perc, t, false);
    if (c.int > 0.3 && paso % 16 === 14) kick(B.perc, t, false);
    if (paso % 4 === 2) charles(B.perc, t, false, 0.09);
    if (c.int > 0.55 && paso % 8 === 6) charles(B.perc, t, true, 0.14);
    if (c.int > 0.7 && (paso % 16 === 4 || paso % 16 === 12)) caja(B.perc, t, 0.12);
    if (paso % 8 === 0 || paso % 8 === 6) {
      notaOsc(B.bajo, c.bajo, t, d * 3.4, 'sawtooth', 0.10);
      notaOsc(B.bajo, c.bajo * 2, t, d * 2.0, 'square', 0.028);
    }
    if (c.int > 0.5 && paso % 2 === 0) arpegio(B.arp, ac[(paso / 2) % ac.length], t, d * 1.8, 0.06);
    if (c.int > 0.8 && paso % 4 === 1) arpegio(B.arp, ac[((paso + 1) / 2 | 0) % ac.length] * 2, t, d * 1.2, 0.035);
  }

  function patronChill(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde;
    if (paso % 16 === 0) notaOsc(B.drone, c.bajo / 2, t, d * 16, 'sine', 0.07);
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32 * 1.02, { ganancia: 0.05, tipo: 'triangle', corte: 1200 });
    if (paso % 16 === 0) kick(B.perc, t, false);
    if (paso % 16 === 10) ruido(B.perc, t, 0.04, 0.045, 'bandpass', 4200, 1.3);
    if (paso % 4 === 1) ruido(B.perc, t, 0.03, 0.028, 'bandpass', 5600, 1.2);
    if (paso % 2 === 0) {
      var seq = [0, 1, 2, 3, 2, 1];
      pluck(B.arp, ac[seq[(paso / 2) % seq.length] % ac.length], t, d * 2.6, 0.05);
    }
    if (paso % 16 === 0 || paso % 16 === 8) notaOsc(B.bajo, c.bajo, t, d * 5, 'sine', 0.11);
    if (c.int > 0.55 && paso % 4 === 2) pluck(B.arp, ac[2] * 2, t, d * 1.6, 0.028);
    if (c.int > 0.7 && paso % 16 === 12) kick(B.perc, t, false);
  }

  function patronChill2(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde;
    if (paso % 16 === 0) notaOsc(B.drone, c.bajo, t, d * 16, 'sine', 0.06);
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32 * 1.02, { ganancia: 0.045, tipo: 'sine', corte: 900 });
    if (paso % 16 === 0) kick(B.perc, t, false);
    if (paso % 16 === 6) kick(B.perc, t, false);
    if (paso % 8 === 3) ruido(B.perc, t, 0.04, 0.05, 'bandpass', 3200, 1.4);
    if (paso % 8 === 6) ruido(B.perc, t, 0.04, 0.04, 'bandpass', 3200, 1.4);
    if (paso % 4 === 2) pluck(B.arp, ac[Math.floor(paso / 4) % ac.length], t, d * 2.2, 0.048);
    if (paso % 8 === 0) notaOsc(B.bajo, c.bajo, t, d * 6, 'triangle', 0.09);
    if (paso % 16 === 8) notaOsc(B.bajo, c.bajo * 1.5, t, d * 3, 'sine', 0.05);
    if (c.int > 0.6 && paso % 8 === 5) pluck(B.arp, ac[Math.floor(paso / 8) % ac.length] * 2, t, d * 1.4, 0.033);
  }

  function patronTension(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde, p = paso % 16;
    if (paso % 16 === 0) {
      notaOsc(B.drone, 55.0, t, d * 16, 'sine', 0.11);
      notaOsc(B.drone, 110.0, t, d * 16, 'triangle', 0.03);
    }
    if (paso % 64 === 0) padAcorde(B.pad, ac, t, d * 64, { ganancia: 0.042, tipo: 'sawtooth', corte: 700 });
    // latido doble de corazón, cada 2 compases
    if (c.compas % 2 === 0 && (p === 0 || p === 2)) kick(B.perc, t, false);
    if (paso % 8 === 0) ruido(B.perc, t, 0.02, 0.028, 'highpass', 8200, 0.7);
    if (paso % 32 === 16) notaOsc(B.arp, 880, t, d * 2, 'sine', 0.02);
    if (paso % 32 === 24) notaOsc(B.arp, 659.25, t, d * 3, 'sine', 0.018);
    if (paso % 16 === 8) notaOsc(B.bajo, 55, t, d * 6, 'sine', 0.07);
    if (c.int > 0.7 && p === 12) notaOsc(B.arp, 932.33, t, d * 1.5, 'sine', 0.016);
  }

  function patronCombateA(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde, p = paso % 16;
    if (paso % 16 === 0) {
      notaOsc(B.drone, 36.71, t, d * 16, 'sine', 0.14);
      notaOsc(B.drone, 73.42, t, d * 16, 'sawtooth', 0.03);
    }
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32, { ganancia: 0.05 });
    if (paso % 4 === 0) kick(B.perc, t, paso % 8 === 0);
    if (p === 4 || p === 12) caja(B.perc, t, 0.16);
    if (paso % 2 === 1) charles(B.perc, t, false, 0.07);
    if (c.int > 0.5 && p === 14) charles(B.perc, t, true, 0.12);
    if (c.int > 0.85 && p === 15) kick(B.perc, t, false);
    var bp = [0, 3, 6, 8, 11, 14];
    if (bp.indexOf(p) >= 0) {
      notaOsc(B.bajo, c.bajo, t, d * 2, 'sawtooth', 0.12);
      notaOsc(B.bajo, c.bajo * 2, t, d * 1.2, 'square', 0.03);
    }
    if (paso % 2 === 0) arpegio(B.arp, ac[(paso / 2) % ac.length], t, d * 1.5, 0.055);
    if (c.int > 0.75 && paso % 4 === 1) arpegio(B.arp, ac[((paso + 1) / 2 | 0) % ac.length] * 2, t, d * 1.0, 0.03);
    if (c.compas % 8 === 7 && (p === 0 || p === 6)) brass(B.lead, ac, t, d * 2.4, 0.05);
  }

  function patronCombateB(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde, p = paso % 16;
    if (paso % 16 === 0) notaOsc(B.drone, c.bajo / 2, t, d * 16, 'sine', 0.13);
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32, { ganancia: 0.048, corte: 1800 });
    if (p === 0 || p === 6 || p === 8 || p === 14) kick(B.perc, t, p === 0 || p === 8);
    if (p === 4 || p === 12) caja(B.perc, t, 0.15);
    if (c.compas % 8 === 7 && p >= 12) tom(B.perc, t, p === 12 ? 180 : (p === 13 ? 150 : (p === 14 ? 120 : 100)));
    if (paso % 2 === 1) charles(B.perc, t, false, 0.06);
    if (p === 6 && c.int > 0.45) charles(B.perc, t, true, 0.1);
    var bp = [0, 2, 8, 10];
    if (bp.indexOf(p) >= 0) notaOsc(B.bajo, c.bajo, t, d * 2.2, 'square', 0.10);
    if (paso % 2 === 0) {
      var seq = [0, 1, 2, 1];
      arpegio(B.arp, ac[seq[(paso / 2) % 4] % ac.length], t, d * 1.3, 0.05);
    }
    if (c.int > 0.8 && p === 3) arpegio(B.arp, ac[0] * 2, t, d, 0.03);
    if (c.compas % 8 === 3 && p === 0) brass(B.lead, ac, t, d * 3, 0.045);
    if (c.compas % 8 === 7 && p === 8) brass(B.lead, ac, t, d * 3, 0.05);
  }

  function patronCombateC(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde, p = paso % 16;
    if (paso % 16 === 0) {
      notaOsc(B.drone, c.bajo, t, d * 16, 'sine', 0.15);
      notaOsc(B.drone, c.bajo / 2, t, d * 16, 'triangle', 0.05);
    }
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32, { ganancia: 0.055, corte: 900 });
    if (p === 0 || p === 10) kick(B.perc, t, p === 0);
    if (p === 8) caja(B.perc, t, 0.19);
    if (p === 6) tom(B.perc, t, 140);
    if (paso % 2 === 0) charles(B.perc, t, false, 0.05);
    if (c.int > 0.4 && p === 14) charles(B.perc, t, true, 0.09);
    var bp = [0, 3, 6, 11, 14];
    if (bp.indexOf(p) >= 0) notaOsc(B.bajo, c.bajo, t, d * 2.6, 'sawtooth', 0.11);
    if (paso % 3 === 0) arpegio(B.arp, ac[((paso / 3) | 0) % ac.length], t, d * 1.2, 0.045);
    if (p === 0 || p === 6 || p === 11) brass(B.lead, ac, t, d * 2.2, 0.06);
    if (c.compas % 8 === 6 && p === 8) brass(B.lead, ac, t, d * 4, 0.07);
  }

  function patronVictoria(c, t, paso) {
    var B = c.buses, d = c.dur, ac = c.acorde, p = paso % 16;
    if (paso % 16 === 0) notaOsc(B.drone, 65.41, t, d * 16, 'sine', 0.10);
    if (paso % 32 === 0) padAcorde(B.pad, ac, t, d * 32, { ganancia: 0.05, tipo: 'triangle', corte: 1600 });
    if (p === 0 || p === 8) timbal(B.perc, t, p === 0 ? 110 : 98);
    if (paso % 8 === 4) ruido(B.perc, t, 0.12, 0.05, 'highpass', 6200, 0.8);
    if (p === 0) brass(B.lead, ac, t, d * 3.2, 0.075);
    if (p === 6) brass(B.lead, ac, t, d * 1.6, 0.05);
    if (paso % 2 === 0) campana(B.arp, ac[(paso / 2) % ac.length] * 2, t, d * 3, 0.042);
    if (p === 0 || p === 8) notaOsc(B.bajo, c.bajo, t, d * 6, 'triangle', 0.12);
    if (c.compas % 8 === 0 && p === 0) crash(B.perc, t, 0.10);
  }

  // ================================================================ pistas ===
  // cada: compases que dura cada acorde. compases: largo del loop (4/4).
  var PISTAS = {
    espera: {
      id: 'espera', nombre: 'Espera', desc: 'Pre-partida: drone grave, pad lento, pulso suave',
      bpm: 78, bpmPorIntensidad: 10, compases: 8, ganancia: 0.95,
      mix: { drone: 1.0, pad: 1.0, perc: 0.9, bajo: 1.0, arp: 0.9, lead: 1.0 },
      variantes: [{
        nombre: 'Espera', cada: 2, patron: patronEspera,
        acordes: [[146.83, 174.61, 220.00], [116.54, 146.83, 174.61], [98.00, 116.54, 146.83], [110.00, 138.59, 164.81]],
        bajos: [73.42, 58.27, 49.00, 55.00]
      }]
    },
    chill: {
      id: 'chill', nombre: 'Chill', desc: 'Rondas tranquilas: e-piano, pads suaves, pulso relajado',
      bpm: 82, bpmPorIntensidad: 10, compases: 8, ganancia: 0.92,
      mix: { drone: 1.0, pad: 1.0, perc: 0.85, bajo: 1.0, arp: 1.0, lead: 1.0 },
      variantes: [
        {
          nombre: 'Chill · La menor', cada: 2, patron: patronChill,
          acordes: [[110.00, 130.81, 164.81, 196.00], [87.31, 130.81, 174.61, 220.00], [130.81, 164.81, 196.00, 246.94], [98.00, 123.47, 146.83, 196.00]],
          bajos: [55.00, 43.65, 65.41, 49.00]
        },
        {
          nombre: 'Chill · Re mayor', cada: 2, patron: patronChill2,
          acordes: [[146.83, 185.00, 220.00, 277.18], [123.47, 146.83, 185.00, 220.00], [98.00, 123.47, 146.83, 185.00], [110.00, 138.59, 164.81, 185.00]],
          bajos: [73.42, 61.74, 49.00, 55.00]
        }
      ]
    },
    tension: {
      id: 'tension', nombre: 'Tensión', desc: 'Rondas medias: latido, tics, cluster disonante',
      bpm: 66, bpmPorIntensidad: 12, compases: 8, ganancia: 1.12,
      mix: { drone: 1.0, pad: 1.0, perc: 0.8, bajo: 0.9, arp: 0.8, lead: 1.0 },
      variantes: [{
        nombre: 'Tensión', cada: 4, patron: patronTension,
        acordes: [[110.00, 130.81, 164.81], [87.31, 110.00, 130.81]],
        bajos: [55.00, 43.65]
      }]
    },
    combate: {
      id: 'combate', nombre: 'Combate', desc: 'Rondas duras: percusión, bajo y arpegios de 16avos',
      bpm: 96, bpmPorIntensidad: 20, compases: 8, ganancia: 0.95,
      mix: { drone: 1.0, pad: 0.9, perc: 1.0, bajo: 1.0, arp: 0.95, lead: 1.0 },
      variantes: [
        {
          nombre: 'Combate · Re menor', cada: 2, patron: patronCombateA,
          acordes: [[146.83, 174.61, 220.00], [116.54, 146.83, 174.61], [98.00, 116.54, 146.83], [110.00, 138.59, 164.81]],
          bajos: [73.42, 58.27, 49.00, 55.00]
        },
        {
          nombre: 'Combate · Mi menor', cada: 2, patron: patronCombateB,
          acordes: [[164.81, 196.00, 246.94], [130.81, 164.81, 196.00], [98.00, 123.47, 146.83], [146.83, 185.00, 220.00]],
          bajos: [82.41, 65.41, 49.00, 73.42]
        },
        {
          nombre: 'Combate · Do menor', cada: 2, patron: patronCombateC,
          acordes: [[130.81, 155.56, 196.00], [103.83, 130.81, 155.56], [116.54, 146.83, 174.61], [98.00, 116.54, 146.83]],
          bajos: [65.41, 51.91, 58.27, 49.00]
        }
      ]
    },
    victoria: {
      id: 'victoria', nombre: 'Victoria', desc: 'Post-partido: fanfarria mayor, campanas y timbales',
      bpm: 100, bpmPorIntensidad: 6, compases: 8, ganancia: 0.95,
      mix: { drone: 1.0, pad: 1.0, perc: 1.0, bajo: 1.0, arp: 1.0, lead: 1.0 },
      variantes: [{
        nombre: 'Victoria', cada: 2, patron: patronVictoria,
        acordes: [[130.81, 164.81, 196.00], [98.00, 123.47, 146.83], [110.00, 130.81, 164.81], [87.31, 110.00, 130.81]],
        bajos: [65.41, 49.00, 55.00, 43.65]
      }]
    }
  };

  var ORDEN_PISTAS = ['espera', 'chill', 'tension', 'combate', 'victoria'];

  // ============================================================ auto-selec ===
  function calcularAuto(st, sinHisteresis) {
    st = st || {};
    var fase = String(st.fase || '').toLowerCase();
    var ronda = Math.floor(Number(st.ronda) || 0);
    var terminada = !!st.terminada || fase === 'final';

    var tension = Number(st.drama && st.drama.tension);
    if (!isFinite(tension)) tension = Number(st.tension);   // también acepta {tension} suelto
    if (!isFinite(tension)) tension = 25;
    if (tension > 1) tension = tension / 100;      // acepta 0..100 y 0..1
    tension = clamp01(tension);

    // Bajas de la ronda (señal de "ronda tranquila"): número directo en st.bajas
    // o, si no viene, la última ronda cerrada de st.historial (state.json).
    var bajas = Number(st.bajas);
    if (!isFinite(bajas) || bajas < 0) {
      bajas = 0;
      var hist = st.historial;
      if (hist && hist.length) {
        var h = hist[hist.length - 1] || {};
        bajas = (Number(h.rojo_bajas) || 0) + (Number(h.azul_bajas) || 0);
      }
    }

    var varCombate = ((ronda > 0 ? ronda - 1 : 0) % 3);
    var varChill = ((ronda > 0 ? ronda - 1 : 0) % 2);

    if (terminada) return { pista: 'victoria', variante: 0, motivo: 'final' };
    // apertura va ANTES que espera: en la apertura la ronda sigue siendo 0 pero
    // el partido ya está en marcha (tensión de previa), no es la pantalla de espera.
    if (fase === 'apertura') return { pista: 'tension', variante: 0, motivo: 'apertura' };
    if (fase === 'espera' || ronda === 0) return { pista: 'espera', variante: 0, motivo: 'espera' };

    // histéresis: si ya estamos en combate/chill, el umbral se ensancha
    var umbralCombate = 0.62, umbralChill = 0.30;
    if (!sinHisteresis) {
      if (pistaActual === 'combate') umbralCombate -= 0.05;
      if (pistaActual === 'chill') umbralChill += 0.05;
    }

    if (tension >= umbralCombate) return { pista: 'combate', variante: varCombate, motivo: 'tension ' + tension.toFixed(2) };
    // Ronda tranquila: poca sangre y ambiente no muy caliente → chill, aunque
    // la tensión no llegue al umbral bajo (el director casi nunca baja de 30).
    if (bajas > 0 && bajas <= BAJAS_CHILL && tension < 0.55) {
      return { pista: 'chill', variante: varChill, motivo: 'ronda tranquila (' + bajas + ' bajas, t ' + tension.toFixed(2) + ')' };
    }
    if (tension <= umbralChill) return { pista: 'chill', variante: varChill, motivo: 'tension ' + tension.toFixed(2) };
    return { pista: 'tension', variante: 0, motivo: 'tension ' + tension.toFixed(2) };
  }

  function auto(st) {
    if (st && typeof st === 'object') ultimoEstado = st;
    if (faseForzada) {
      return { pista: faseForzada.pista, variante: faseForzada.variante, forzada: true };
    }
    var d = calcularAuto(ultimoEstado || {});
    if (sonando) cambiarA(d.pista, d.variante);
    else pendienteFase = d;
    return { pista: d.pista, variante: d.variante, motivo: d.motivo, forzada: false };
  }

  function setAuto() {
    faseForzada = null;
    if (sonando && ultimoEstado) {
      var d = calcularAuto(ultimoEstado);
      cambiarA(d.pista, d.variante);
    }
    return true;
  }

  // ================================================================= capas ===
  function crearCapa(pistaId, variante) {
    var pista = PISTAS[pistaId];
    variante = normalizarVariante(pista, variante);
    var bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.connect(master);

    var buses = {};
    var claves = ['drone', 'pad', 'perc', 'bajo', 'arp', 'lead'];
    for (var i = 0; i < claves.length; i++) {
      var k = claves[i];
      var g = ctx.createGain();
      g.gain.value = (pista.mix && pista.mix[k] != null) ? pista.mix[k] : 1;
      g.connect(bus);
      buses[k] = g;
    }

    var capa = {
      id: ++capaSeq,
      pistaId: pistaId,
      pista: pista,
      variante: variante,
      bus: bus,
      buses: buses,
      paso: 0,
      nextTime: 0,
      bpm: bpmDe(pista),
      quitarA: 0
    };
    capas.push(capa);
    return capa;
  }

  function destruirCapa(capa) {
    try { capa.bus.disconnect(); } catch (e) {}
    try {
      for (var k in capa.buses) {
        if (capa.buses.hasOwnProperty(k)) capa.buses[k].disconnect();
      }
    } catch (e) {}
    var i = capas.indexOf(capa);
    if (i >= 0) capas.splice(i, 1);
  }

  function capaActual() {
    for (var i = capas.length - 1; i >= 0; i--) {
      if (!capas[i].quitarA) return capas[i];
    }
    return null;
  }

  function cambiarA(pistaId, variante, fade) {
    if (!PISTAS[pistaId]) return false;
    if (!iniciado || !sonando) { pendienteFase = { pista: pistaId, variante: normalizarVariante(PISTAS[pistaId], variante) }; return false; }
    if (ctx.state !== 'running') { pendienteFase = { pista: pistaId, variante: normalizarVariante(PISTAS[pistaId], variante) }; return false; }

    var pista = PISTAS[pistaId];
    variante = normalizarVariante(pista, variante);
    var actual = capaActual();
    if (actual && actual.pistaId === pistaId && actual.variante === variante) {
      pistaActual = pistaId; varianteActual = variante;
      return false;
    }

    fade = (fade == null) ? FADE : Math.max(0.05, Number(fade) || 0);
    var t = ahora();

    var nueva = crearCapa(pistaId, variante);
    nueva.nextTime = t + 0.06;
    try {
      nueva.bus.gain.setValueAtTime(0.0001, t);
      nueva.bus.gain.linearRampToValueAtTime(pista.ganancia == null ? 1 : pista.ganancia, t + fade);
    } catch (e) { nueva.bus.gain.value = pista.ganancia == null ? 1 : pista.ganancia; }

    for (var i = 0; i < capas.length; i++) {
      var c = capas[i];
      if (c === nueva || c.quitarA) continue;
      c.quitarA = t + fade + 0.15;
      try {
        c.bus.gain.cancelScheduledValues(t);
        c.bus.gain.setValueAtTime(Math.max(0.0001, c.bus.gain.value), t);
        c.bus.gain.linearRampToValueAtTime(0.0001, t + fade);
      } catch (e) {}
    }

    pistaActual = pistaId;
    varianteActual = variante;
    planificador();   // programa ya el primer paso: sin hueco al cruzar
    return true;
  }

  function programarPaso(capa, t) {
    var pista = capa.pista;
    var v = pista.variantes[capa.variante];
    var paso = capa.paso;
    var dur = (60 / capa.bpm) / 4;
    var compas = Math.floor(paso / 16);
    var idx = Math.floor(compas / (v.cada || 2)) % v.acordes.length;
    var c = {
      buses: capa.buses,
      acorde: v.acordes[idx],
      bajo: v.bajos[idx],
      compas: compas,
      idx: idx,
      dur: dur,
      int: intensidad,
      pista: pista,
      v: v
    };
    v.patron(c, t, paso);
    capa.paso = (paso + 1) % (pista.compases * 16);
  }

  function planificador() {
    if (!sonando || !ctx) return;
    if (ctx.state !== 'running') return;
    var t = ahora();
    for (var i = capas.length - 1; i >= 0; i--) {
      var capa = capas[i];
      if (capa.quitarA) {
        if (t > capa.quitarA) { destruirCapa(capa); continue; }
        if (t > capa.quitarA - 0.15) continue;   // ya inaudible
      }
      capa.bpm = bpmDe(capa.pista);
      var pasoDur = (60 / capa.bpm) / 4;
      if (capa.nextTime < t + 0.02) capa.nextTime = t + 0.05;
      var guard = 0;
      while (capa.nextTime < t + HORIZONTE && guard++ < 64) {
        programarPaso(capa, capa.nextTime);
        capa.nextTime += pasoDur;
      }
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

  // ============================================================ arranque ====
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

    var des = faseForzada
      ? { pista: faseForzada.pista, variante: faseForzada.variante }
      : (pendienteFase || calcularAuto(ultimoEstado || {}));
    pendienteFase = null;

    // limpia capas viejas por si venimos de un stop a medias
    for (var i = capas.length - 1; i >= 0; i--) destruirCapa(capas[i]);

    var t = ahora();
    var capa = crearCapa(des.pista, des.variante);
    capa.nextTime = t + 0.08;
    try {
      capa.bus.gain.setValueAtTime(0.0001, t);
      capa.bus.gain.linearRampToValueAtTime(capa.pista.ganancia == null ? 1 : capa.pista.ganancia, t + 1.2);
    } catch (e) { capa.bus.gain.value = capa.pista.ganancia == null ? 1 : capa.pista.ganancia; }

    pistaActual = des.pista;
    varianteActual = capa.variante;

    aplicarVolumen(0.4);
    if (timer) clearInterval(timer);
    timer = setInterval(planificador, 25);
    planificador();
    return true;
  }

  function start(forzar) {
    // ?musica=off apaga el arranque automático (lo que llaman las páginas al
    // cargar), pero un clic explícito del usuario en el botón de música sí
    // enciende: por eso toggle() y el botón pasan forzar=true.
    if (!iniciado) leerURL();
    if (silencioURL && !forzar) return false;
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
    var viejas = capas;
    capas = [];
    for (var i = 0; i < viejas.length; i++) {
      (function (c) {
        try {
          c.bus.gain.cancelScheduledValues(t);
          c.bus.gain.setValueAtTime(Math.max(0.0001, c.bus.gain.value), t);
          c.bus.gain.linearRampToValueAtTime(0.0001, t + 0.5);
        } catch (e) {}
        setTimeout(function () { destruirCapa(c); }, 900);
      })(viejas[i]);
    }
    pistaActual = null;
  }

  function toggle() { if (sonando) { stop(); return false; } return start(true); }

  function setSilencio(v) { silencioURL = !!v; return true; }

  // ============================================================== efectos ===
  function efecto(nombre) {
    if (!init()) return;
    if (!desbloquear() || ctx.state !== 'running') return;
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
      ruido(sfxGain, t, 0.5, 0.35, 'lowpass', 900, 0.7);
    } else if (nombre === 'ding') {
      notaOsc(sfxGain, 880, t, 0.35, 'sine', 0.22);
      notaOsc(sfxGain, 1320, t + 0.02, 0.28, 'sine', 0.12);
    } else if (nombre === 'fanfarria') {
      var notas = [392.0, 493.88, 587.33, 783.99];
      for (var i = 0; i < notas.length; i++) {
        notaOsc(sfxGain, notas[i], t + i * 0.11, 0.5, 'triangle', 0.18);
        notaOsc(sfxGain, notas[i] * 2, t + i * 0.11, 0.35, 'sine', 0.06);
      }
      notaOsc(sfxGain, 783.99, t + 0.55, 0.9, 'triangle', 0.2);
    } else if (nombre === 'whoosh') {
      ruido(sfxGain, t, 0.35, 0.28, 'bandpass', 1200, 1.6);
    } else if (nombre === 'tick') {
      ruido(sfxGain, t, 0.03, 0.10, 'highpass', 9000, 0.8);
    }
  }

  // =================================================================== URL ===
  function leerURL() {
    var qs = null;
    try { qs = new URLSearchParams(window.location.search || ''); } catch (e) { return; }
    var m = qs.get('musica');
    if (m == null) m = qs.get('music');
    if (m == null) return;
    m = String(m).toLowerCase().trim();
    if (m === 'off' || m === '0' || m === 'no' || m === 'silencio' || m === 'false') {
      silencioURL = true;
      return;
    }
    if (m === 'auto') { faseForzada = null; return; }
    var v = parseInt(qs.get('variante') || qs.get('v'), 10);
    if (!isFinite(v)) v = 0;
    if (PISTAS[m]) { faseForzada = { pista: m, variante: normalizarVariante(PISTAS[m], v) }; return; }
    // alias combate1/combate2/combate3, chill2...
    var mm = /^([a-z]+?)[-_]?([123])$/.exec(m);
    if (mm && PISTAS[mm[1]]) {
      faseForzada = { pista: mm[1], variante: normalizarVariante(PISTAS[mm[1]], parseInt(mm[2], 10) - 1) };
    }
  }

  // ============================================================== lectura ====
  function nivel() {
    if (!analizador) return null;
    var n = analizador.fftSize;
    var buf = new Float32Array(n);
    analizador.getFloatTimeDomainData(buf);
    var peak = 0, sum = 0;
    for (var i = 0; i < n; i++) {
      var v = buf[i];
      var a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / n);
    return {
      peak: peak,
      rms: rms,
      dbPeak: peak > 0 ? 20 * Math.log10(peak) : -120,
      dbRms: rms > 0 ? 20 * Math.log10(rms) : -120,
      t: ahora()
    };
  }

  function loopSegundos() {
    if (!pistaActual) return 0;
    var p = PISTAS[pistaActual];
    return p.compases * 4 * (60 / bpmDe(p));
  }

  function getPista() {
    if (!pistaActual) {
      var d = faseForzada ? { pista: faseForzada.pista, variante: faseForzada.variante } : calcularAuto(ultimoEstado || {});
      return {
        pista: d.pista, variante: d.variante, nombre: PISTAS[d.pista].nombre,
        bpm: bpmDe(PISTAS[d.pista]), compases: PISTAS[d.pista].compases,
        loop: PISTAS[d.pista].compases * 4 * (60 / bpmDe(PISTAS[d.pista])),
        forzada: faseForzada ? { pista: faseForzada.pista, variante: faseForzada.variante } : null,
        sonando: false, capas: 0
      };
    }
    var p = PISTAS[pistaActual];
    return {
      pista: pistaActual,
      variante: varianteActual,
      nombre: p.nombre,
      bpm: bpmDe(p),
      compases: p.compases,
      loop: loopSegundos(),
      forzada: faseForzada ? { pista: faseForzada.pista, variante: faseForzada.variante } : null,
      sonando: sonando,
      capas: capasActivas()
    };
  }

  function capasActivas() {
    var n = 0;
    for (var i = 0; i < capas.length; i++) if (!capas[i].quitarA) n++;
    return n;
  }

  function catalogo() {
    var out = [];
    for (var i = 0; i < ORDEN_PISTAS.length; i++) {
      var id = ORDEN_PISTAS[i], p = PISTAS[id];
      var vs = [];
      for (var j = 0; j < p.variantes.length; j++) vs.push({ indice: j, nombre: p.variantes[j].nombre });
      out.push({ id: id, nombre: p.nombre, desc: p.desc, bpm: p.bpm, bpmPorIntensidad: p.bpmPorIntensidad, compases: p.compases, variantes: vs });
    }
    return out;
  }

  function setFase(nombre, variante) {
    nombre = String(nombre == null ? '' : nombre).toLowerCase().trim();
    if (nombre === 'auto' || nombre === '') return setAuto();
    if (!PISTAS[nombre]) return false;
    var v = normalizarVariante(PISTAS[nombre], variante);
    faseForzada = { pista: nombre, variante: v };
    if (!sonando) return true;
    cambiarA(nombre, v);
    return true;
  }

  function setVariante(n) {
    var p = pistaActual || (faseForzada && faseForzada.pista);
    if (!p) return false;
    var v = normalizarVariante(PISTAS[p], n);
    if (faseForzada && faseForzada.pista === p) faseForzada.variante = v;
    if (sonando) cambiarA(p, v);
    return true;
  }

  // ==================================================================== API ==
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

    setIntensidad: function (x) { intensidad = clamp01(x); return intensidad; },
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
    getVolumenEfectos: function () { return volumenEfectos; },

    // ---- pistas / fases (v2) ----
    setFase: setFase,
    setAuto: setAuto,
    setVariante: setVariante,
    auto: auto,
    setSilencio: setSilencio,
    getPista: getPista,
    pistas: catalogo,
    loopSegundos: loopSegundos,
    nivel: nivel,
    capasActivas: capasActivas,
    // Predicción pura (sin tocar el audio ni la histéresis): útil para QA y
    // para que otros módulos sepan qué pista tocaría con un estado dado.
    predecir: function (st) { return calcularAuto(st, true); },
    _debug: function () {
      return {
        sonando: sonando, iniciado: iniciado, pendiente: pendiente,
        pistaActual: pistaActual, varianteActual: varianteActual,
        faseForzada: faseForzada, silencioURL: silencioURL,
        intensidad: intensidad, volumen: volumen, duck: duckActivo,
        capas: capas.map(function (c) {
          return { id: c.id, pista: c.pistaId, variante: c.variante, paso: c.paso, quitarA: c.quitarA };
        })
      };
    }
  };
})();
