/*!
 * viewer-fx.js — motor de efectos de espectáculo de "WorldBox AI Show" (v2.0.0)
 * ============================================================================
 * ÚNICA capa de efectos sobre el mapa. Sin dependencias, sin módulos ES, sin
 * CDN, sin build: funciona con <script src="viewer-fx.js"> tanto por HTTP como
 * con file://. Inyecta sus estilos una sola vez (<style id="vfx2-css">).
 *
 * API (contrato SHOW-V3 §3):
 * ----------------------------------------------------------------------------
 *   ViewerFX.version;                                   // '2.0.0'
 *   ViewerFX.init({ map: Element, motion: 'full'|'lite', maxEffects: 24 });
 *
 *   // Emoji invasor gigante, animación propia por emoción
 *   ViewerFX.invader(emoji, { side, emotion, size, duration, text });
 *
 *   // Impacto en % del mapa (0..100): onda, escombros, chispas, destello
 *   ViewerFX.impact(xPct, yPct, { power, color, emoji, debris, shake });
 *
 *   ViewerFX.damage(n, xPct, yPct, side);       // número flotante
 *   ViewerFX.sparks(xPct, yPct, { color, count });
 *   ViewerFX.shake(strength, { duration });     // 0..1
 *   ViewerFX.flash(color, { opacity, duration });
 *   ViewerFX.vignette(level, { color, duration });
 *   ViewerFX.confetti(side, { count });         // 'rojo'|'azul'|'mix'
 *   ViewerFX.clear();
 *
 * Compatibilidad con la API v1 que usa el visor actual (alias a lo nuevo):
 *   spawnImpact(x,y,power,opts), spawnDamage(n,x,y,side,opts), flyEmoji(emoji,opts),
 *   flash, vignette, shake, spawnReaction, tremblePanel, focus, setMap, getMapEl,
 *   setMotion.
 *
 * Reglas que cumple este fichero:
 *   - Solo transform/opacity en animaciones CSS (más hue-rotate del arcoíris,
 *     pedido explícitamente por el contrato para euforia).
 *   - Un único canvas de partículas con un único bucle rAF (arranca/para solo).
 *   - Tope de efectos simultáneos (maxEffects) y de partículas (MAXP).
 *   - prefers-reduced-motion -> modo lite automático.
 *   - DPR-aware (canvas escalado por devicePixelRatio, tope 2.5).
 *   - Todo k = (t - t0)/dur se clampea a [0,1] (relojes raros / virtual time).
 *   - Nunca escribe en consola; los fallos son silenciosos.
 *   - Coordenadas xPct/yPct = 0..100 del contenido VISIBLE del mapa
 *     (respeta object-fit: contain / cover de <img>/<video>/<canvas>).
 */
(function (global) {
  'use strict';

  var VERSION = '2.0.0';
  if (global.ViewerFX && global.ViewerFX.__vfx === VERSION) return;

  var doc = global.document;
  if (!doc) return;

  /* ==========================================================================
   * Utilidades
   * ======================================================================== */

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : d;
  }

  function clamp(n, a, b) {
    n = Number(n);
    if (!isFinite(n)) return a;
    return n < a ? a : (n > b ? b : n);
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function make(tag, cls) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  function resolveEl(v) {
    if (!v) return null;
    if (typeof v === 'string') {
      try { return doc.querySelector(v); } catch (e) { return null; }
    }
    return (v.nodeType === 1) ? v : null;
  }

  function fmtNum(n) {
    var v = Math.abs(Number(n) || 0);
    try { return v.toLocaleString('es-ES'); } catch (e) { return String(Math.round(v)); }
  }

  function nowMs() {
    try {
      return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    } catch (e) { return Date.now(); }
  }

  var raf = (typeof global.requestAnimationFrame === 'function')
    ? function (fn) { return global.requestAnimationFrame(fn); }
    : function (fn) { return setTimeout(function () { fn(nowMs()); }, 16); };
  var caf = (typeof global.cancelAnimationFrame === 'function')
    ? function (id) { return global.cancelAnimationFrame(id); }
    : function (id) { return clearTimeout(id); };

  /* ==========================================================================
   * Configuración y estado
   * ======================================================================== */

  var CFG = {
    map: null,
    motion: 'auto',   // 'auto' | 'full' | 'lite' | 'reduced'
    maxEffects: 24
  };

  var lite = false;
  var stage = null;      // capa absoluta dentro del mapa
  var dom = null;        // capa DOM de efectos
  var canvas = null;     // canvas único de partículas
  var ctx = null;
  var screen = null;     // capa fija a pantalla completa (flash + viñeta)
  var vigEl = null;
  var DPR = 1;
  var VIEW = { w: 1280, h: 720 };
  var roots = [];        // raíces de efecto para el tope maxEffects
  var timers = [];
  var intervals = [];
  var P = [];            // partículas
  var MAXP = 720;
  var rafId = 0;
  var lastT = 0;

  var mq = null;
  try {
    mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch (e) { mq = null; }

  function computeLite() {
    if (CFG.motion === 'lite' || CFG.motion === 'reduced') return true;
    if (CFG.motion === 'full') return false;
    return !!(mq && mq.matches);
  }

  /* ==========================================================================
   * Temporizadores (centralizados para que clear() los mate todos)
   * ======================================================================== */

  function later(fn, ms) {
    var id = setTimeout(function () {
      var i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
      try { fn(); } catch (e) { /* silencioso */ }
    }, Math.max(0, ms));
    timers.push(id);
    return id;
  }

  function every(fn, ms) {
    var id = setInterval(function () {
      try { fn(); } catch (e) { /* silencioso */ }
    }, Math.max(16, ms));
    intervals.push(id);
    return id;
  }

  function stopEvery(id) {
    try { clearInterval(id); } catch (e) { /* nada */ }
    var i = intervals.indexOf(id);
    if (i >= 0) intervals.splice(i, 1);
  }

  function clearTimers() {
    var i;
    for (i = 0; i < timers.length; i++) { try { clearTimeout(timers[i]); } catch (e) { /* nada */ } }
    timers.length = 0;
    for (i = 0; i < intervals.length; i++) { try { clearInterval(intervals[i]); } catch (e) { /* nada */ } }
    intervals.length = 0;
  }

  /* ==========================================================================
   * Estilos (una sola vez)
   * ======================================================================== */

  function ensureStyles() {
    if (doc.getElementById('vfx2-css')) return;
    var css = [
      /* ---- capas ---- */
      '#vfx2-stage{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:60;',
      'contain:layout style paint;transform:translateZ(0)}',
      '#vfx2-stage.vfx2-fixed{position:fixed;z-index:9997}',
      '.vfx2-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}',
      '.vfx2-dom{position:absolute;inset:0;pointer-events:none}',
      '#vfx2-screen{position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden}',

      /* ---- invasor ---- */
      '.vfx2-inv{position:absolute;pointer-events:none;will-change:transform,opacity;z-index:6}',
      '.vfx2-inv-center{position:absolute;left:0;top:0;transform:translate(-50%,-50%)}',
      '.vfx2-inv-enter{position:relative;animation:vfx2-in .46s cubic-bezier(.18,1.3,.4,1) both}',
      '.vfx2-inv-body{position:relative;display:flex;flex-direction:column;align-items:center;',
      'transform-origin:50% 88%;will-change:transform}',
      '.vfx2-inv-face{position:relative;display:flex;align-items:center;justify-content:center}',
      '.vfx2-inv-glow{position:absolute;left:50%;top:50%;width:calc(var(--size) * 2.1);',
      'height:calc(var(--size) * 2.1);transform:translate(-50%,-50%);border-radius:50%;',
      'background:radial-gradient(circle,var(--glow) 0%,rgba(0,0,0,0) 62%);opacity:.46;',
      'filter:blur(18px);animation:vfx2-pulse 1.6s ease-in-out infinite;pointer-events:none}',
      '.vfx2-inv-tag{position:relative;font:900 13px/1 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'letter-spacing:.24em;text-transform:uppercase;color:var(--c);padding:6px 12px 5px;border-radius:999px;',
      'background:rgba(6,9,16,.62);border:1px solid var(--c);box-shadow:0 0 14px var(--glow),inset 0 0 10px rgba(0,0,0,.5);',
      'margin-bottom:10px;white-space:nowrap;text-indent:.24em}',
      '.vfx2-inv-emoji{position:relative;font-size:var(--size);line-height:.92;',
      'filter:drop-shadow(0 14px 30px rgba(0,0,0,.62)) drop-shadow(0 0 30px var(--glow));',
      'will-change:transform,filter}',
      '.vfx2-inv-text{position:relative;margin-top:12px;max-width:calc(var(--size) * 3.4);',
      'font:800 clamp(15px,1.9vw,30px)/1.18 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'color:#fff;text-align:center;font-style:italic;letter-spacing:.01em;',
      'text-shadow:0 2px 0 rgba(0,0,0,.85),0 0 20px var(--glow),0 4px 18px rgba(0,0,0,.7);',
      'animation:vfx2-textin .5s cubic-bezier(.2,1.4,.4,1) .14s both}',
      '.vfx2-inv.vfx2-out .vfx2-inv-enter{animation:vfx2-out .34s ease-in forwards}',

      /* entrada por emoción (--s0 SIEMPRE 1: en el primer frame ya se ve a tamaño final) */
      '.vfx2-inv-furia{--dx:-180px;--dy:0px;--s0:1;--r0:-10deg}',
      '.vfx2-inv-llanto{--dx:0px;--dy:-210px;--s0:1;--r0:0deg}',
      '.vfx2-inv-burla{--dx:0px;--dy:0px;--s0:1;--r0:-30deg}',
      '.vfx2-inv-euforia{--dx:0px;--dy:170px;--s0:1;--r0:8deg}',
      '.vfx2-inv-panico{--dx:170px;--dy:0px;--s0:1;--r0:0deg}',

      /* animación de cada emoción (lo que las hace inconfundibles) */
      '.vfx2-inv-furia .vfx2-inv-body{animation:vfx2-furia .32s linear infinite;transform-origin:50% 90%}',
      '.vfx2-inv-furia .vfx2-inv-glow{background:radial-gradient(circle,#ff3b30 0%,rgba(255,80,0,.55) 34%,rgba(0,0,0,0) 66%)}',
      '.vfx2-inv-llanto .vfx2-inv-body{animation:vfx2-llanto 3.1s ease-in-out infinite;transform-origin:50% 85%}',
      '.vfx2-inv-llanto .vfx2-inv-emoji{filter:drop-shadow(0 14px 30px rgba(0,0,0,.62)) drop-shadow(0 0 34px var(--glow)) saturate(.75)}',
      '.vfx2-inv-burla .vfx2-inv-body{animation:vfx2-burla 1.12s cubic-bezier(.34,0,.4,1) infinite;transform-origin:50% 100%}',
      '.vfx2-inv-euforia .vfx2-inv-body{animation:vfx2-euforia 1.22s cubic-bezier(.4,0,.4,1) infinite;transform-origin:50% 100%}',
      '.vfx2-inv-euforia .vfx2-inv-glow{background:conic-gradient(from 0deg,#ff3b30,#ffd60a,#34d399,#38bdf8,#a78bfa,#ff3b30);filter:blur(26px);opacity:.55}',
      '.vfx2-inv-euforia .vfx2-inv-emoji{animation:vfx2-rainbow 2.4s linear infinite}',
      '.vfx2-inv-panico .vfx2-inv-body{animation:vfx2-panico .42s steps(1,end) infinite}',
      '.vfx2-inv-panico .vfx2-inv-emoji{animation:vfx2-flicker .9s steps(1,end) infinite;',
      'text-shadow:-4px 0 rgba(255,0,80,.9),4px 0 rgba(0,240,255,.9)}',
      '.vfx2-inv-panico .vfx2-inv-tag{animation:vfx2-flicker 1.1s steps(1,end) infinite}',

      /* ---- impacto ---- */
      '.vfx2-fx{position:absolute}',
      '.vfx2-pt{width:0;height:0;left:0;top:0}',
      '.vfx2-ring{position:absolute;left:0;top:0;width:var(--s);height:var(--s);border-radius:50%;',
      'border:var(--bw) solid var(--c);transform:translate(-50%,-50%) scale(.55);opacity:1;',
      'box-shadow:0 0 30px var(--c),0 0 60px var(--c),inset 0 0 24px var(--c);',
      'animation:vfx2-ring var(--d) cubic-bezier(.12,.7,.3,1) var(--delay,0s) forwards;',
      'will-change:transform,opacity}',
      '.vfx2-core{position:absolute;left:0;top:0;width:var(--s);height:var(--s);border-radius:50%;',
      'background:radial-gradient(circle,#fff 0%,#fff3c4 16%,var(--c) 46%,rgba(255,120,0,.55) 62%,rgba(0,0,0,0) 76%);',
      'transform:translate(-50%,-50%) scale(.9);opacity:1;animation:vfx2-core .85s ease-out forwards;',
      'mix-blend-mode:screen;will-change:transform,opacity}',
      '.vfx2-boom{position:absolute;left:0;top:0;font-size:var(--fs);line-height:1;',
      'transform:translate(-50%,-50%) scale(1) rotate(-8deg);opacity:1;',
      'animation:vfx2-boom 1s cubic-bezier(.16,1.25,.3,1) forwards;',
      'filter:drop-shadow(0 6px 18px rgba(0,0,0,.6));will-change:transform,opacity}',

      /* ---- número de daño (grande, contundente, legible de un vistazo) ---- */
      '.vfx2-dmg{position:absolute;font:900 var(--fs,60px)/1 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'letter-spacing:-.035em;transform:translate(-50%,-50%);white-space:nowrap;will-change:transform,opacity;',
      'animation:vfx2-dmg 1.9s cubic-bezier(.16,.9,.2,1) forwards;font-variant-numeric:tabular-nums;',
      'paint-order:stroke fill}',
      '.vfx2-dmg-r{color:#fff4f4;-webkit-text-stroke:2.5px #4a0a0a;',
      'text-shadow:-3px -3px 0 #5b0d0d,3px -3px 0 #5b0d0d,-3px 3px 0 #5b0d0d,3px 3px 0 #5b0d0d,0 6px 0 #3d0505,0 0 30px rgba(255,70,60,.95),0 10px 26px rgba(0,0,0,.85)}',
      '.vfx2-dmg-a{color:#eef9ff;-webkit-text-stroke:2.5px #04283a;',
      'text-shadow:-3px -3px 0 #06344d,3px -3px 0 #06344d,-3px 3px 0 #06344d,3px 3px 0 #06344d,0 6px 0 #041f30,0 0 30px rgba(56,189,248,.95),0 10px 26px rgba(0,0,0,.85)}',

      /* ---- reacciones / vuelo (compat v1) ---- */
      '.vfx2-react{position:absolute;transform:translate(-50%,-50%);line-height:1;',
      'animation:vfx2-react 1.35s ease-out forwards;will-change:transform,opacity;',
      'filter:drop-shadow(0 6px 16px rgba(0,0,0,.5))}',
      '.vfx2-fly{position:absolute;transform:translate(-50%,-50%);line-height:1;z-index:7;',
      'filter:drop-shadow(0 10px 22px rgba(0,0,0,.55));will-change:transform,opacity}',

      /* ---- pantalla completa ---- */
      '.vfx2-flash{position:absolute;inset:0;background:var(--c);opacity:0;',
      'animation:vfx2-flash var(--d,.42s) ease-out forwards;will-change:opacity}',
      '.vfx2-vignette{position:absolute;inset:0;opacity:0;transition:opacity .45s ease;',
      'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 42%,var(--c) 100%)}',

      /* ---- lite ---- */
      '.vfx2-lite .vfx2-inv-body,.vfx2-lite .vfx2-inv-emoji,.vfx2-lite .vfx2-inv-glow,',
      '.vfx2-lite .vfx2-inv-tag,.vfx2-lite .vfx2-inv-text{animation:none!important}',
      '.vfx2-lite .vfx2-inv-enter{animation:vfx2-in .3s ease-out both}',

      /* ---- keyframes ---- */
      '@keyframes vfx2-in{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0deg)}',
      '20%{opacity:1;transform:translate(calc(var(--dx,0px) * .1),calc(var(--dy,0px) * .1)) scale(1.1) rotate(calc(var(--r0,0deg) * .5))}',
      '46%{opacity:1;transform:translate(0,0) scale(.975) rotate(0deg)}',
      '72%{opacity:1;transform:translate(0,0) scale(1.02) rotate(0deg)}',
      '100%{opacity:1;transform:translate(0,0) scale(1) rotate(0deg)}}',
      '@keyframes vfx2-out{0%{opacity:1;transform:scale(1) translateY(0)}100%{opacity:0;transform:scale(.72) translateY(-18px)}}',
      '@keyframes vfx2-textin{0%{opacity:1;transform:translateY(0) scale(.94)}100%{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes vfx2-pulse{0%,100%{opacity:.42;transform:translate(-50%,-50%) scale(.94)}50%{opacity:.72;transform:translate(-50%,-50%) scale(1.08)}}',
      '@keyframes vfx2-furia{',
      '0%,100%{transform:translate(0,0) rotate(0deg) scale(1)}',
      '8%{transform:translate(-9px,3px) rotate(-2.6deg) scale(1.03)}',
      '16%{transform:translate(8px,-4px) rotate(2.6deg) scale(.98)}',
      '24%{transform:translate(-7px,2px) rotate(-2deg) scale(1.04)}',
      '32%{transform:translate(9px,3px) rotate(2.2deg) scale(1)}',
      '40%{transform:translate(-5px,-2px) rotate(-1.6deg) scale(1.02)}',
      '48%{transform:translate(6px,2px) rotate(1.8deg) scale(.99)}',
      '56%{transform:translate(-8px,0) rotate(-2.2deg) scale(1.03)}',
      '64%{transform:translate(7px,3px) rotate(2.2deg) scale(1)}',
      '72%{transform:translate(-4px,-3px) rotate(-1.2deg) scale(1.02)}',
      '80%{transform:translate(5px,2px) rotate(1.4deg) scale(1)}',
      '90%{transform:translate(-2px,0) rotate(-.6deg) scale(1)}}',
      '@keyframes vfx2-llanto{0%,100%{transform:translate(0,0) rotate(-2deg) scale(1,1)}',
      '25%{transform:translate(-7px,16px) rotate(-4.5deg) scale(1.01,.98)}',
      '50%{transform:translate(0,30px) rotate(1deg) scale(1,.96)}',
      '75%{transform:translate(7px,16px) rotate(3.5deg) scale(1.01,.98)}}',
      '@keyframes vfx2-burla{0%,100%{transform:translate(0,0) scale(1,1) rotate(-5deg)}',
      '12%{transform:translate(0,-36px) scale(.9,1.12) rotate(-12deg)}',
      '24%{transform:translate(0,0) scale(1.22,.78) rotate(-2deg)}',
      '36%{transform:translate(0,-12px) scale(.96,1.05) rotate(4deg)}',
      '48%{transform:translate(0,0) scale(1.08,.94) rotate(10deg)}',
      '60%{transform:translate(0,-42px) scale(.92,1.1) rotate(16deg)}',
      '72%{transform:translate(0,0) scale(1.18,.82) rotate(6deg)}',
      '86%{transform:translate(0,-6px) scale(1,1) rotate(-1deg)}}',
      '@keyframes vfx2-euforia{0%,100%{transform:translate(0,0) scale(1,1) rotate(0)}',
      '10%{transform:translate(0,-18px) scale(1.06,.94) rotate(-2deg)}',
      '35%{transform:translate(0,-88px) scale(.97,1.04) rotate(-4deg)}',
      '50%{transform:translate(0,-98px) scale(1,1) rotate(0)}',
      '68%{transform:translate(0,-10px) scale(1.1,.9) rotate(2deg)}',
      '82%{transform:translate(0,0) scale(.94,1.08) rotate(0)}',
      '92%{transform:translate(0,-28px) scale(1.02,.98) rotate(-1deg)}}',
      '@keyframes vfx2-rainbow{0%{filter:drop-shadow(0 14px 30px rgba(0,0,0,.62)) drop-shadow(0 0 30px var(--glow)) hue-rotate(0deg)}',
      '100%{filter:drop-shadow(0 14px 30px rgba(0,0,0,.62)) drop-shadow(0 0 30px var(--glow)) hue-rotate(360deg)}}',
      '@keyframes vfx2-panico{0%{transform:translate(0,0)}10%{transform:translate(-11px,4px)}',
      '20%{transform:translate(9px,-5px)}30%{transform:translate(-6px,-3px)}',
      '40%{transform:translate(12px,5px)}50%{transform:translate(-8px,2px)}',
      '60%{transform:translate(4px,-6px)}70%{transform:translate(-11px,4px)}',
      '80%{transform:translate(7px,3px)}90%{transform:translate(-5px,-4px)}100%{transform:translate(0,0)}}',
      '@keyframes vfx2-flicker{0%,44%{opacity:1}46%{opacity:.3}48%{opacity:1}72%{opacity:.55}74%{opacity:1}100%{opacity:1}}',
      '@keyframes vfx2-ring{0%{transform:translate(-50%,-50%) scale(.55);opacity:1}',
      '30%{transform:translate(-50%,-50%) scale(.78);opacity:.95}',
      '100%{transform:translate(-50%,-50%) scale(1.08);opacity:0}}',
      '@keyframes vfx2-core{0%{transform:translate(-50%,-50%) scale(.9);opacity:1}',
      '26%{transform:translate(-50%,-50%) scale(1.02);opacity:1}',
      '100%{transform:translate(-50%,-50%) scale(1.3);opacity:0}}',
      '@keyframes vfx2-boom{0%{transform:translate(-50%,-50%) scale(1) rotate(-8deg);opacity:1}',
      '20%{transform:translate(-50%,-52%) scale(1.16) rotate(4deg);opacity:1}',
      '60%{transform:translate(-50%,-58%) scale(1.02) rotate(0)}',
      '100%{transform:translate(-50%,-78%) scale(.86) rotate(8deg);opacity:0}}',
      '@keyframes vfx2-dmg{0%{transform:translate(-50%,-50%) scale(1.05);opacity:1}',
      '16%{transform:translate(calc(-50% + var(--arc,0px)),-66%) scale(1.22) rotate(-1.5deg);opacity:1}',
      '34%{transform:translate(calc(-50% + var(--arc,0px) * .6),-78%) scale(1.04);opacity:1}',
      '62%{transform:translate(calc(-50% + var(--arc,0px) * .3),-92%) scale(1);opacity:1}',
      '100%{transform:translate(-50%,-130%) scale(.94);opacity:0}}',
      '@keyframes vfx2-react{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}',
      '18%{opacity:1;transform:translate(-50%,-70%) scale(1.1)}',
      '100%{opacity:0;transform:translate(-50%,-210%) scale(.9)}}',
      '@keyframes vfx2-flash{0%{opacity:var(--o,.35)}14%{opacity:var(--o,.35)}100%{opacity:0}}'
    ].join('');
    var st = make('style');
    st.id = 'vfx2-css';
    st.appendChild(doc.createTextNode(css));
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ==========================================================================
   * Geometría: mapa -> coordenadas de la capa
   * ======================================================================== */

  function getMap() {
    var el = resolveEl(CFG.map);
    if (el) return el;
    var qs = ['[data-vfx-map]', '.mapa #frame', '.mapa video', '.mapa img',
      '.mapa canvas', '.mapa', '#stream', '#frame', '#centro'];
    for (var i = 0; i < qs.length; i++) {
      try {
        el = doc.querySelector(qs[i]);
        if (el) return el;
      } catch (e) { /* selector no soportado */ }
    }
    return null;
  }

  function mediaChild(el) {
    var list;
    try { list = el.querySelectorAll('img, video, canvas'); } catch (e) { return null; }
    var er;
    try { er = el.getBoundingClientRect(); } catch (e) { return null; }
    var best = null, bestArea = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var r = m.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var area = r.width * r.height;
      if (area < er.width * er.height * 0.15) continue;
      if (r.width > er.width * 1.06 || r.height > er.height * 1.06) continue;
      var cs = null;
      try { cs = global.getComputedStyle(m); } catch (e) { cs = null; }
      if (cs) {
        if (parseFloat(cs.opacity || '1') < 0.5) continue;
        if ((cs.filter || '').indexOf('blur') >= 0) continue;
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      }
      if (area > bestArea) { best = m; bestArea = area; }
    }
    return best;
  }

  /* Rect del contenido visible (respeta object-fit contain/cover). */
  function contentRect(el) {
    var r = el.getBoundingClientRect();
    var out = { left: r.left, top: r.top, width: r.width, height: r.height, el: el };
    if (!r.width || !r.height) return out;
    var media = el;
    var tag = (el.tagName || '').toUpperCase();
    var iw = 0, ih = 0;
    if (tag === 'IMG') { iw = el.naturalWidth || 0; ih = el.naturalHeight || 0; }
    else if (tag === 'VIDEO') { iw = el.videoWidth || 0; ih = el.videoHeight || 0; }
    else if (tag === 'CANVAS') { iw = el.width || 0; ih = el.height || 0; }
    if (!iw || !ih) {
      var child = mediaChild(el);
      if (child) {
        var cr = child.getBoundingClientRect();
        if (cr.width && cr.height) {
          media = child;
          r = cr;
          out.left = cr.left; out.top = cr.top; out.width = cr.width; out.height = cr.height;
          tag = (child.tagName || '').toUpperCase();
          if (tag === 'IMG') { iw = child.naturalWidth || 0; ih = child.naturalHeight || 0; }
          else if (tag === 'VIDEO') { iw = child.videoWidth || 0; ih = child.videoHeight || 0; }
          else { iw = child.width || 0; ih = child.height || 0; }
        }
      }
    }
    if (!iw || !ih || !r.width || !r.height) return out;
    var fit = 'fill';
    try { fit = (global.getComputedStyle(media).objectFit || 'fill').toLowerCase(); } catch (e) { fit = 'fill'; }
    if (fit !== 'contain' && fit !== 'cover') return out;
    var s = fit === 'cover'
      ? Math.max(r.width / iw, r.height / ih)
      : Math.min(r.width / iw, r.height / ih);
    var w = iw * s, h = ih * s;
    out.left = r.left + (r.width - w) / 2;
    out.top = r.top + (r.height - h) / 2;
    out.width = w;
    out.height = h;
    return out;
  }

  function mapHost() {
    var el = getMap();
    if (!el) return null;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') {
      return el.parentElement || el;
    }
    return el;
  }

  function mapRect() {
    var el = mapHost();
    if (el) {
      var r = contentRect(el);
      if (r && r.width >= 8 && r.height >= 8) return r;
    }
    var w = global.innerWidth || 1280;
    var h = global.innerHeight || 720;
    return { left: w * 0.10, top: h * 0.10, width: w * 0.80, height: h * 0.72, el: null };
  }

  /* Punto en coordenadas de viewport. */
  function punto(xPct, yPct) {
    var r = mapRect();
    var x = clamp(num(xPct, 50), -25, 125);
    var y = clamp(num(yPct, 50), -25, 125);
    return { x: r.left + (x / 100) * r.width, y: r.top + (y / 100) * r.height, pctX: x, pctY: y, rect: r };
  }

  /* Punto de viewport -> coordenadas locales de la capa FX. */
  function stagePoint(p) {
    if (!stage) return { x: p.x, y: p.y };
    var sr = stage.getBoundingClientRect();
    return { x: p.x - sr.left, y: p.y - sr.top };
  }

  /* ==========================================================================
   * Capas
   * ======================================================================== */

  function sizeCanvas() {
    if (!canvas || !stage) return;
    var w = stage.clientWidth || (global.innerWidth || 1280);
    var h = stage.clientHeight || (global.innerHeight || 720);
    var dpr = clamp(global.devicePixelRatio || 1, 1, 2.5);
    var pw = Math.max(1, Math.round(w * dpr));
    var ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    DPR = dpr;
    VIEW.w = w; VIEW.h = h;
    if (ctx) { try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { /* nada */ } }
  }

  function ensureStage() {
    var host = mapHost();
    var fixed = false;
    if (!host) { host = doc.body; fixed = true; }
    if (!host) return null;
    if (stage && stage.parentNode === host) { sizeCanvas(); return stage; }

    if (stage && stage.parentNode) {
      try { stage.parentNode.removeChild(stage); } catch (e) { /* nada */ }
    }
    stage = make('div');
    stage.id = 'vfx2-stage';
    if (fixed) stage.className = 'vfx2-fixed';
    stage.setAttribute('aria-hidden', 'true');
    canvas = make('canvas', 'vfx2-canvas');
    dom = make('div', 'vfx2-dom');
    stage.appendChild(canvas);
    stage.appendChild(dom);
    host.appendChild(stage);

    if (!fixed) {
      try {
        var cs = global.getComputedStyle(host);
        if (cs && cs.position === 'static') host.style.position = 'relative';
      } catch (e) { /* nada */ }
    }
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    stage.classList.toggle('vfx2-lite', lite);
    sizeCanvas();
    return stage;
  }

  function ensureScreen() {
    if (screen && screen.parentNode) return screen;
    if (!doc.body) return null;
    screen = make('div');
    screen.id = 'vfx2-screen';
    screen.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(screen);
    return screen;
  }

  function ensureReady() {
    ensureStyles();
    var st = ensureStage();
    ensureScreen();
    return !!st;
  }

  /* ==========================================================================
   * Tope de efectos
   * ======================================================================== */

  function maxRoots() { return Math.max(4, Math.round(clamp(num(CFG.maxEffects, 24), 4, 80))); }

  function track(el) {
    roots.push(el);
    var max = maxRoots();
    while (roots.length > max) {
      var old = roots.shift();
      try { if (old.parentNode) old.parentNode.removeChild(old); } catch (e) { /* nada */ }
      if (old && old.__stop) { try { old.__stop(); } catch (e) { /* nada */ } }
    }
  }

  function untrack(el) {
    var i = roots.indexOf(el);
    if (i >= 0) roots.splice(i, 1);
  }

  function removeEl(el) {
    if (!el) return;
    try { if (el.__stop) el.__stop(); } catch (e) { /* nada */ }
    try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* nada */ }
    untrack(el);
  }

  /* ==========================================================================
   * Partículas (canvas único + un único rAF)
   * ======================================================================== */

  var spawnDrawId = 0;

  function addP(p) {
    if (!ctx || !stage) return;
    if (P.length >= MAXP) P.shift();
    P.push(p);
    startLoop();
    // Primer frame garantizado: si el rAF no llega a correr (headless/virtual-time,
    // pestaña en segundo plano) pintamos igualmente la posición de nacimiento.
    if (!spawnDrawId) {
      spawnDrawId = later(function () {
        spawnDrawId = 0;
        if (P.length) drawP();
      }, 16);
    }
  }

  function startLoop() {
    if (rafId) return;
    lastT = 0;
    rafId = raf(loop);
  }

  function loop(t) {
    rafId = 0;
    if (!P.length) {
      if (ctx) { try { ctx.clearRect(0, 0, VIEW.w, VIEW.h); } catch (e) { /* nada */ } }
      return;
    }
    if (!lastT) lastT = t;
    // Clamp defensivo: con virtual-time o pestañas dormidas dt puede ser enorme.
    var dt = clamp((t - lastT) / 1000, 0, 0.05);
    lastT = t;
    stepP(dt);
    drawP();
    rafId = raf(loop);
  }

  function stepP(dt) {
    for (var i = P.length - 1; i >= 0; i--) {
      var p = P[i];
      p.life -= dt * 1000;
      if (p.life <= 0) { P.splice(i, 1); continue; }
      if (p.g) p.vy += p.g * dt;
      if (p.drag != null) {
        var d = Math.pow(p.drag, dt * 60);
        p.vx *= d;
        p.vy *= d;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.vr) p.rot += p.vr * dt;
      if (p.sway) p.x += Math.sin((p.ttl - p.life) * 0.006 + p.phase) * p.sway * dt * 60;
      if (p.floor && p.y > p.floor) {
        p.y = p.floor;
        p.vy *= -0.42;
        p.vx *= 0.78;
        if (Math.abs(p.vy) < 30) p.vy = 0;
      }
      if (p.y > VIEW.h + 120 || p.x < -160 || p.x > VIEW.w + 160) {
        P.splice(i, 1);
      }
    }
  }

  function drawP() {
    if (!ctx) return;
    try { ctx.clearRect(0, 0, VIEW.w, VIEW.h); } catch (e) { return; }
    var i, p;
    ctx.globalCompositeOperation = 'source-over';
    for (i = 0; i < P.length; i++) {
      p = P[i];
      if (p.blend === 'lighter') continue;
      drawOne(p);
    }
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < P.length; i++) {
      p = P[i];
      if (p.blend !== 'lighter') continue;
      drawOne(p);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawOne(p) {
    // k clampeado a [0,1]: la vida restante nunca da alfa fuera de rango.
    var k = clamp(p.life / p.ttl, 0, 1);
    var a = k * (p.alpha != null ? p.alpha : 1);
    if (a <= 0) return;
    ctx.globalAlpha = clamp(a, 0, 1);
    if (p.type === 'rect' || p.type === 'confetti') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
      return;
    }
    if (p.type === 'tear') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.size * 0.42, p.size, 0, 0, 6.2832);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (p.type === 'spark') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
      return;
    }
    if (p.type === 'star') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      var s = p.size;
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.34, 0);
      ctx.lineTo(0, s);
      ctx.lineTo(-s * 0.34, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, 6.2832);
    ctx.fill();
  }

  /* ---- generadores de partículas ---- */

  function burstSparks(x, y, color, count, power) {
    var n = Math.round(count * (lite ? 0.35 : 1));
    var pw = clamp(power, 0, 1);
    for (var i = 0; i < n; i++) {
      var a = rnd(0, 6.2832);
      var rad = rnd(4, 26 + pw * 96);          // nacen ya esparcidas: se lee como explosión
      var sp = rnd(160, 520) * (0.55 + pw);
      var ttl = rnd(360, 900);
      addP({
        type: 'spark', x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad * 0.72,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        g: 700, drag: 0.93, size: rnd(2.2, 4.6), color: color,
        life: ttl, ttl: ttl, blend: 'lighter', alpha: rnd(0.8, 1)
      });
    }
  }

  function burstDebris(x, y, count, power, colors) {
    var n = Math.round(count * (lite ? 0.4 : 1));
    var pw = clamp(power, 0, 1);
    for (var i = 0; i < n; i++) {
      var a = rnd(0, 6.2832);
      var rad = rnd(14, 40 + pw * 120);
      var ttl = rnd(750, 1550);
      addP({
        type: 'rect', x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad * 0.62,
        vx: rnd(-340, 340) * (0.5 + pw * 0.8),
        vy: rnd(-680, -150) * (0.5 + pw * 0.8),
        g: 1050, drag: 0.992, size: rnd(10, 24),
        rot: rnd(0, 6.28), vr: rnd(-11, 11),
        color: pick(colors), floor: y + rnd(40, 210),
        life: ttl, ttl: ttl, alpha: 0.98
      });
    }
  }

  function embers(x, y, count) {
    var n = lite ? Math.max(1, count >> 1) : count;
    for (var i = 0; i < n; i++) {
      var ttl = rnd(480, 1050);
      addP({
        type: 'dot', x: x + rnd(-10, 10), y: y + rnd(-6, 14),
        vx: rnd(-34, 34), vy: rnd(-190, -70),
        g: -46, drag: 0.97, size: rnd(1.4, 4),
        color: pick(['#ff3b30', '#ff8a3d', '#ffd36b', '#ffb703']),
        life: ttl, ttl: ttl, blend: 'lighter', alpha: rnd(0.6, 1)
      });
    }
  }

  function tears(x, y, count) {
    var n = lite ? Math.max(1, count >> 1) : count;
    for (var i = 0; i < n; i++) {
      var ttl = rnd(520, 1050);
      addP({
        type: 'tear', x: x + rnd(-72, 72), y: y + rnd(-58, 34),
        vx: rnd(-34, 34), vy: rnd(80, 230),
        g: 780, drag: 0.999, size: rnd(2, 4.6),
        rot: 0, vr: rnd(-1.2, 1.2),
        color: pick(['#7dd3fc', '#38bdf8', '#bae6fd']),
        life: ttl, ttl: ttl, alpha: rnd(0.55, 0.9)
      });
    }
  }

  function stars(x, y, count, color) {
    var n = lite ? Math.max(1, count >> 1) : count;
    for (var i = 0; i < n; i++) {
      var ttl = rnd(380, 820);
      addP({
        type: 'star', x: x + rnd(-16, 16), y: y + rnd(-12, 12),
        vx: rnd(-70, 70), vy: rnd(-150, -20),
        g: 240, drag: 0.97, size: rnd(3, 7),
        rot: rnd(0, 6.28), vr: rnd(-5, 5),
        color: color || pick(['#fde047', '#f0abfc', '#67e8f9', '#86efac']),
        life: ttl, ttl: ttl, blend: 'lighter', alpha: rnd(0.8, 1)
      });
    }
  }

  function glitchBits(x, y, count) {
    var n = lite ? Math.max(1, count >> 1) : count;
    for (var i = 0; i < n; i++) {
      var ttl = rnd(240, 560);
      addP({
        type: 'rect', x: x + rnd(-96, 96), y: y + rnd(-76, 76),
        vx: rnd(-260, 260), vy: rnd(-160, 160),
        g: 0, drag: 0.9, size: rnd(1.8, 4.6),
        rot: rnd(0, 6.28), vr: rnd(-14, 14),
        color: pick(['#a78bfa', '#c4b5fd', '#22d3ee', '#f472b6', '#ffffff']),
        life: ttl, ttl: ttl, blend: 'lighter', alpha: rnd(0.5, 0.9)
      });
    }
  }

  function confettiRain(side, count) {
    var colsR = ['#ff2d2d', '#ff8a1f', '#ffd60a', '#ff5ea8', '#ffffff', '#ff4d4d'];
    var colsA = ['#22d3ee', '#38bdf8', '#60a5fa', '#a78bfa', '#e0f2fe', '#ffffff'];
    var cols = side === 'rojo' ? colsR : (side === 'azul' ? colsA : colsR.concat(colsA, ['#ffd700', '#34d399', '#f472b6']));
    var n = Math.round((count || 80) * (lite ? 0.3 : 1));
    var inView = Math.max(1, Math.round(n * 0.55));   // mayoría ya dentro: estallido instantáneo
    for (var i = 0; i < n; i++) {
      var x = (side === 'rojo') ? rnd(-20, VIEW.w * 0.55)
        : (side === 'azul') ? rnd(VIEW.w * 0.45, VIEW.w + 20)
          : rnd(-20, VIEW.w + 20);
      var ttl = rnd(2600, 4600);
      var y = i < inView ? rnd(-VIEW.h * 0.05, VIEW.h * 0.52) : rnd(-VIEW.h * 0.18, -10);
      addP({
        type: 'confetti', x: x, y: y,
        vx: rnd(-70, 70), vy: rnd(160, 340),
        g: 420, drag: 0.997, size: rnd(9, 17),
        rot: rnd(0, 6.28), vr: rnd(-9, 9),
        sway: rnd(22, 60), phase: rnd(0, 6.28),
        color: pick(cols), life: ttl, ttl: ttl, alpha: 0.98
      });
    }
  }

  /* ==========================================================================
   * Invasor (emoji gigante con emoción)
   * ======================================================================== */

  var EM = {
    furia: {
      c: '#ff4d4d', glow: 'rgba(255,59,48,.85)', tag: 'FURIA', emoji: '\uD83D\uDE21',
      dx: '-180px', dy: '0px', s0: '1', r0: '-10deg', every: 110
    },
    llanto: {
      c: '#38bdf8', glow: 'rgba(56,189,248,.8)', tag: 'LLANTO', emoji: '\uD83D\uDE2D',
      dx: '0px', dy: '-210px', s0: '1', r0: '0deg', every: 150
    },
    burla: {
      c: '#facc15', glow: 'rgba(250,204,21,.8)', tag: 'BURLA', emoji: '\uD83D\uDE02',
      dx: '0px', dy: '0px', s0: '1', r0: '-30deg', every: 175
    },
    euforia: {
      c: '#c084fc', glow: 'rgba(192,132,252,.9)', tag: 'EUFORIA', emoji: '\uD83E\uDD29',
      dx: '0px', dy: '170px', s0: '1', r0: '8deg', every: 150
    },
    panico: {
      c: '#a78bfa', glow: 'rgba(167,139,250,.9)', tag: 'P\u00C1NICO', emoji: '\uD83D\uDE31',
      dx: '170px', dy: '0px', s0: '1', r0: '0deg', every: 90
    }
  };

  function normEmotion(e) {
    var s = String(e || '').toLowerCase();
    return EM[s] ? s : 'furia';
  }

  function normSide(s) {
    return String(s || '').toLowerCase() === 'azul' ? 'azul' : 'rojo';
  }

  function defaultSize() {
    var w = global.innerWidth || 1280;
    return clamp(w * 0.22, 96, 340);
  }

  function emitFor(emotion, pt, size) {
    if (emotion === 'furia') {
      embers(pt.x + rnd(-size * 0.42, size * 0.42), pt.y + size * 0.45, 2);
    } else if (emotion === 'llanto') {
      tears(pt.x + rnd(-size * 0.3, size * 0.3), pt.y + size * 0.18, 2);
    } else if (emotion === 'burla') {
      stars(pt.x + rnd(-size * 0.5, size * 0.5), pt.y + rnd(-size * 0.2, size * 0.3), 2, '#fde047');
    } else if (emotion === 'euforia') {
      stars(pt.x + rnd(-size * 0.5, size * 0.5), pt.y + rnd(-size * 0.5, size * 0.05), 2);
    } else {
      glitchBits(pt.x + rnd(-size * 0.5, size * 0.5), pt.y + rnd(-size * 0.35, size * 0.35), 3);
    }
  }

  function startEmitter(emotion, pt, size) {
    if (lite) return null;
    var stop = false;
    var id = every(function () {
      if (stop) return;
      emitFor(emotion, pt, size);
    }, EM[emotion].every);
    return function () {
      stop = true;
      stopEvery(id);
    };
  }

  function invader(emoji, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;

    var emotion = normEmotion(o.emotion);
    var side = normSide(o.side);
    var dur = clamp(num(o.duration, 3200), 900, 15000);
    var size = clamp(num(o.size, defaultSize()), 64, 520);
    var narrow = (global.innerWidth || 1280) < 720;
    var xPct = narrow ? 50 : (side === 'azul' ? 62 : 38);
    var p = punto(xPct, narrow ? 46 : 44);
    var sp = stagePoint(p);

    var meta = EM[emotion];
    var el = make('div', 'vfx2-inv vfx2-inv-' + emotion);
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    el.style.setProperty('--size', size + 'px');
    el.style.setProperty('--c', meta.c);
    el.style.setProperty('--glow', meta.glow);

    var center = make('div', 'vfx2-inv-center');
    var enter = make('div', 'vfx2-inv-enter');
    var body = make('div', 'vfx2-inv-body');
    var face = make('div', 'vfx2-inv-face');
    var glow = make('div', 'vfx2-inv-glow');
    var tag = make('div', 'vfx2-inv-tag');
    tag.textContent = meta.tag;
    var em = make('div', 'vfx2-inv-emoji');
    em.textContent = emoji || meta.emoji;

    // Glow + emoji en el mismo wrapper: el halo queda SIEMPRE centrado detrás de la cara.
    face.appendChild(glow);
    face.appendChild(em);
    body.appendChild(tag);
    body.appendChild(face);
    if (o.text) {
      var txt = make('div', 'vfx2-inv-text');
      txt.textContent = String(o.text);
      body.appendChild(txt);
    }
    enter.appendChild(body);
    center.appendChild(enter);
    el.appendChild(center);
    dom.appendChild(el);
    track(el);

    // Ráfaga inicial + emisor continuo de partículas de la emoción.
    emitFor(emotion, sp, size);
    emitFor(emotion, sp, size);
    if (emotion === 'euforia') confettiRain(side, 46);
    el.__stop = startEmitter(emotion, sp, size);

    later(function () { el.classList.add('vfx2-out'); }, Math.max(160, dur - 360));
    later(function () { removeEl(el); }, dur);
    return el;
  }

  /* ==========================================================================
   * Impacto
   * ======================================================================== */

  function debrisColors(color) {
    var base = ['#8b5e34', '#b45309', '#d97706', '#6b7280', '#9ca3af', '#d1d5db', '#57534e'];
    if (color) base.push(color, '#ffd36b', '#ffffff');
    return base;
  }

  function impact(xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;

    var power = clamp(num(o.power, 1), 0, 1);
    var color = o.color || (power >= 0.7 ? '#ff7a2d' : '#ffd36b');
    var p = punto(xPct, yPct);
    var sp = stagePoint(p);

    var root = make('div', 'vfx2-fx vfx2-pt');
    root.style.left = sp.x + 'px';
    root.style.top = sp.y + 'px';
    dom.appendChild(root);
    track(root);

    var base = 90 + power * 230;

    var core = make('div', 'vfx2-core');
    core.style.setProperty('--s', (base * 0.82).toFixed(0) + 'px');
    core.style.setProperty('--c', color);
    root.appendChild(core);

    var i;
    for (i = 0; i < 3; i++) {
      var ring = make('div', 'vfx2-ring');
      ring.style.setProperty('--s', (base * (1.45 + i * 0.55)).toFixed(0) + 'px');
      ring.style.setProperty('--bw', (9 - i * 2).toFixed(1) + 'px');
      ring.style.setProperty('--c', i === 1 ? '#ffffff' : color);
      ring.style.setProperty('--d', (0.9 + i * 0.16).toFixed(2) + 's');
      ring.style.setProperty('--delay', (i * 0.05).toFixed(2) + 's');
      root.appendChild(ring);
    }

    var boom = make('div', 'vfx2-boom');
    boom.textContent = o.emoji || (power >= 0.5 ? '\uD83D\uDCA5' : '\u2728');
    boom.style.setProperty('--fs', Math.round(56 + power * 64) + 'px');
    root.appendChild(boom);

    burstSparks(sp.x, sp.y, color, Math.round(26 + power * 44), power);
    if (o.debris !== false) {
      burstDebris(sp.x, sp.y, Math.round(22 + power * 30), power, debrisColors(color));
    }
    if (power >= 0.55) {
      flash(color, { opacity: 0.08 + power * 0.13, duration: 420 });
    }
    var sh = o.shake != null ? num(o.shake, 0) : (0.25 + power * 0.65);
    if (sh > 0.02) shake(sh, { duration: 420 + power * 320 });

    later(function () { removeEl(root); }, 1650);
    return root;
  }

  /* ==========================================================================
   * Número de daño
   * ======================================================================== */

  function damage(n, xPct, yPct, side, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var v = Number(n);
    if (!isFinite(v) || v === 0) return null;

    var p = punto(xPct, yPct);
    var sp = stagePoint(p);
    var azul = normSide(side) === 'azul';
    var el = make('div', 'vfx2-dmg ' + (azul ? 'vfx2-dmg-a' : 'vfx2-dmg-r'));
    var prefix = o.prefix != null ? String(o.prefix) : '\u2212';
    el.textContent = prefix + fmtNum(v);
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    var mag = clamp(Math.log(Math.max(1, Math.abs(v))) / Math.LN10 / 2.6, 0, 1);
    el.style.setProperty('--fs', Math.round(num(o.size, 56 + mag * 16)) + 'px');
    el.style.setProperty('--arc', ((azul ? -1 : 1) * rnd(14, 30)).toFixed(0) + 'px');
    dom.appendChild(el);
    track(el);

    burstSparks(sp.x, sp.y, azul ? '#7dd3fc' : '#fca5a5', 12, 0.45);
    later(function () { removeEl(el); }, 2050);
    return el;
  }

  /* ==========================================================================
   * Sacudida / destello / viñeta / confeti / chispas
   * ======================================================================== */

  var shakeEls = [];

  function shake(strength, opts) {
    var o = opts || {};
    var s = clamp(num(strength, 0.5), 0, 1);
    if (s <= 0.01) return null;
    if (lite) s *= 0.28;

    var target = resolveEl(o.target) || mapHost() || doc.body;
    if (!target || !target.animate) return null;

    var dur = clamp(num(o.duration, 380 + s * 320), 120, 2000);
    var amp = 3 + s * 15;
    var frames = [];
    var steps = 11;
    for (var i = 0; i <= steps; i++) {
      var k = i / steps;
      var decay = 1 - k;
      var dx = Math.sin(k * 47.0) * amp * decay;
      var dy = Math.cos(k * 39.0) * amp * 0.7 * decay;
      var rot = Math.sin(k * 53.0) * (s * 0.9) * decay;
      frames.push({ transform: 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) rotate(' + rot.toFixed(3) + 'deg)' });
    }
    try {
      var anim = target.animate(frames, {
        duration: dur,
        easing: 'linear',
        composite: 'add'
      });
      try { anim.id = 'vfx2-shake'; } catch (e) { /* nada */ }
      shakeEls.push(target);
      anim.onfinish = function () {
        var j = shakeEls.indexOf(target);
        if (j >= 0) shakeEls.splice(j, 1);
      };
      return target;
    } catch (e) {
      // Navegador sin composite 'add': reintento simple sin composición.
      try { target.animate(frames, { duration: dur, easing: 'linear' }); } catch (e2) { /* nada */ }
      return target;
    }
  }

  function flash(color, opts) {
    var o = opts || {};
    if (!ensureReady() || !screen) return null;
    var f = make('div', 'vfx2-flash');
    f.style.setProperty('--c', color || '#ffffff');
    f.style.setProperty('--o', String(clamp(num(o.opacity, 0.35), 0, 1)));
    var dur = clamp(num(o.duration, 420), 80, 3000);
    f.style.setProperty('--d', dur + 'ms');
    screen.appendChild(f);
    later(function () { try { if (f.parentNode) f.parentNode.removeChild(f); } catch (e) { /* nada */ } }, dur + 80);
    return f;
  }

  function vignette(level, opts) {
    var o = opts || {};
    if (!ensureReady() || !screen) return null;
    if (!vigEl || !vigEl.parentNode) {
      vigEl = make('div', 'vfx2-vignette');
      screen.appendChild(vigEl);
    }
    if (o.color) {
      try {
        var c = String(o.color);
        vigEl.style.setProperty('--c', c);
      } catch (e) { /* nada */ }
    } else if (!vigEl.style.getPropertyValue('--c')) {
      vigEl.style.setProperty('--c', 'rgba(255,45,45,.85)');
    }
    var lv = clamp(num(level, 0), 0, 1);
    vigEl.style.opacity = String(lv <= 0.01 ? 0 : lv);
    if (o.duration != null && lv > 0) {
      var d = clamp(num(o.duration, 1200), 100, 20000);
      later(function () { if (vigEl) vigEl.style.opacity = '0'; }, d);
    }
    return vigEl;
  }

  function confetti(side, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    confettiRain(normSide(side) === 'azul' ? 'azul' : (String(side).toLowerCase() === 'mix' ? 'mix' : 'rojo'), num(o.count, 90));
    return true;
  }

  function sparks(xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var p = punto(xPct, yPct);
    var sp = stagePoint(p);
    var count = clamp(num(o.count, 26), 1, 140);
    burstSparks(sp.x, sp.y, o.color || '#ffd36b', count, 0.55);
    stars(sp.x, sp.y, Math.round(count * 0.4), o.color || '#fde047');
    return true;
  }

  /* ==========================================================================
   * Compatibilidad con la API v1 del visor actual
   * ======================================================================== */

  function compatPower(p) {
    var n = Number(p);
    if (!isFinite(n)) n = 0.6;
    if (n > 1) n = n / 3;
    return clamp(n, 0.15, 1);
  }

  function spawnImpact(xPct, yPct, power, opts) {
    var o = opts || {};
    return impact(xPct, yPct, {
      power: compatPower(power),
      color: o.color,
      emoji: o.emoji,
      debris: o.debris !== false,
      shake: o.shake
    });
  }

  function spawnDamage(n, xPct, yPct, side, opts) {
    return damage(n, xPct, yPct, side, opts);
  }

  function spawnReaction(emoji, xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var p = punto(xPct, yPct);
    var sp = stagePoint(p);
    var el = make('div', 'vfx2-react');
    el.textContent = emoji || '\u2728';
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    el.style.fontSize = clamp(num(o.size, 46), 18, 140) + 'px';
    dom.appendChild(el);
    track(el);
    later(function () { removeEl(el); }, 1400);
    return el;
  }

  function flyEmoji(emoji, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;

    var fromEl = resolveEl(o.fromEl) || dom;
    var sr;
    try { sr = stage.getBoundingClientRect(); } catch (e) { return null; }
    var sx = VIEW.w / 2, sy = VIEW.h * 0.8;
    try {
      var fr = fromEl.getBoundingClientRect();
      if (fr && fr.width) {
        sx = fr.left + fr.width / 2 - sr.left;
        sy = fr.top + fr.height / 2 - sr.top;
      }
    } catch (e) { /* usa el centro */ }

    var to = o.to || {};
    var p = punto(num(to.xPct, 50), num(to.yPct, 50));
    var tx = p.x - sr.left;
    var ty = p.y - sr.top;

    var size = clamp(num(o.size, 100), 24, 320);
    var el = make('div', 'vfx2-fly');
    el.textContent = emoji || '\uD83D\uDCA5';
    el.style.fontSize = size + 'px';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    dom.appendChild(el);
    track(el);

    var dur = clamp(num(o.duration, 1200), 300, 4000);
    var midX = (sx + tx) / 2 + rnd(-70, 70);
    var midY = Math.min(sy, ty) - rnd(50, 140);
    var mx = (midX - sx).toFixed(1);
    var my = (midY - sy).toFixed(1);
    var ex = (tx - sx).toFixed(1);
    var ey = (ty - sy).toFixed(1);

    try {
      el.animate([
        { transform: 'translate(-50%,-50%) scale(.5) rotate(-20deg)', opacity: 0, offset: 0 },
        { transform: 'translate(-50%,-50%) scale(1.1) rotate(6deg)', opacity: 1, offset: 0.18 },
        { transform: 'translate(calc(-50% + ' + mx + 'px),calc(-50% + ' + my + 'px)) scale(1) rotate(12deg)', opacity: 1, offset: 0.55 },
        { transform: 'translate(calc(-50% + ' + ex + 'px),calc(-50% + ' + ey + 'px)) scale(1.15) rotate(-6deg)', opacity: 1, offset: 0.92 },
        { transform: 'translate(calc(-50% + ' + ex + 'px),calc(-50% + ' + ey + 'px)) scale(.3) rotate(0deg)', opacity: 0, offset: 1 }
      ], { duration: dur, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' });
    } catch (e) {
      el.style.opacity = '0';
    }

    later(function () {
      removeEl(el);
      impact(p.pctX, p.pctY, {
        power: compatPower(o.power),
        color: o.color,
        emoji: '\uD83D\uDCA5',
        debris: true,
        shake: 0.45
      });
    }, dur);
    return el;
  }

  function tremblePanel(side, opts) {
    var o = opts || {};
    var s = String(side || '').toLowerCase();
    var el = resolveEl(o.el) ||
      (s ? doc.getElementById(s) : null) ||
      (s ? doc.querySelector('[data-lado="' + s + '"]') : null) ||
      (s ? doc.querySelector('.panel-' + s) : null);
    if (!el) return null;
    shake(0.45, { target: el, duration: 520 });
    return el;
  }

  function focus(el, xPct, yPct, zoom, ms) {
    if (!ensureReady()) return null;
    var cont = resolveEl(el) || mapHost();
    if (!cont) return null;
    var t = mediaChild(cont) || cont;
    var z = clamp(num(zoom, 1.6), 1, 3.2);
    var dur = clamp(num(ms, 1200), 300, 9000);
    var er, r;
    try {
      er = t.getBoundingClientRect();
      if (!er.width || !er.height) return null;
      r = contentRect(t);
    } catch (e) { return null; }
    var lx = (r.left - er.left) + (clamp(num(xPct, 50), 0, 100) / 100) * r.width;
    var ly = (r.top - er.top) + (clamp(num(yPct, 50), 0, 100) / 100) * r.height;
    var tx = (1 - z) * (lx - er.width / 2);
    var ty = (1 - z) * (ly - er.height / 2);
    try {
      t.animate([
        { transform: 'translate(0,0) scale(1)' },
        { transform: 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + z.toFixed(3) + ')', offset: 0.3 },
        { transform: 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + z.toFixed(3) + ')', offset: 0.7 },
        { transform: 'translate(0,0) scale(1)' }
      ], { duration: dur, easing: 'ease-in-out', fill: 'none' });
    } catch (e) { /* nada */ }
    return t;
  }

  /* ==========================================================================
   * clear()
   * ======================================================================== */

  function clear() {
    clearTimers();
    P.length = 0;
    spawnDrawId = 0;
    if (ctx) {
      try { ctx.clearRect(0, 0, VIEW.w, VIEW.h); } catch (e) { /* nada */ }
    }
    if (dom) {
      while (dom.firstChild) {
        try { dom.removeChild(dom.firstChild); } catch (e) { break; }
      }
    }
    roots.length = 0;
    if (screen) {
      var kids = screen.children;
      for (var i = kids.length - 1; i >= 0; i--) {
        if (kids[i] !== vigEl) {
          try { screen.removeChild(kids[i]); } catch (e) { /* nada */ }
        }
      }
    }
    if (vigEl) vigEl.style.opacity = '0';
    var host = mapHost() || doc.body;
    try {
      if (host && host.getAnimations) {
        var anims = host.getAnimations();
        for (var j = 0; j < anims.length; j++) {
          if (anims[j].id === 'vfx2-shake') {
            try { anims[j].cancel(); } catch (e) { /* nada */ }
          }
        }
      }
    } catch (e) { /* nada */ }
    shakeEls.length = 0;
    return api;
  }

  /* ==========================================================================
   * init / API pública
   * ======================================================================== */

  function init(opts) {
    var o = opts || {};
    if (o.map != null) CFG.map = o.map;
    if (o.motion != null) CFG.motion = String(o.motion);
    if (o.maxEffects != null) CFG.maxEffects = clamp(num(o.maxEffects, 24), 4, 80);
    lite = computeLite();
    ensureStyles();
    ensureStage();
    ensureScreen();
    if (stage) stage.classList.toggle('vfx2-lite', lite);
    return api;
  }

  function setMotion(mode) {
    if (mode != null) CFG.motion = String(mode);
    lite = computeLite();
    if (stage) stage.classList.toggle('vfx2-lite', lite);
    return lite ? 'lite' : 'full';
  }

  function setMap(el) {
    CFG.map = el;
    if (stage && stage.parentNode) {
      try { stage.parentNode.removeChild(stage); } catch (e) { /* nada */ }
    }
    stage = null; canvas = null; ctx = null; dom = null;
    ensureStage();
    return api;
  }

  var api = {
    __vfx: VERSION,
    version: VERSION,

    init: init,
    invader: invader,
    impact: impact,
    damage: damage,
    sparks: sparks,
    shake: shake,
    flash: flash,
    vignette: vignette,
    confetti: confetti,
    clear: clear,

    /* compat v1 */
    spawnImpact: spawnImpact,
    spawnDamage: spawnDamage,
    spawnReaction: spawnReaction,
    flyEmoji: flyEmoji,
    tremblePanel: tremblePanel,
    focus: focus,
    setMap: setMap,
    setMotion: setMotion,
    getMapEl: mapHost
  };

  global.ViewerFX = api;

  // Reacciona a cambios de "reducir movimiento" del sistema sin recargar.
  try {
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', function () {
        if (CFG.motion === 'auto') {
          lite = computeLite();
          if (stage) stage.classList.toggle('vfx2-lite', lite);
        }
      });
    }
  } catch (e) { /* nada */ }

  // Mantiene el canvas a tamaño correcto si cambia la ventana o el mapa.
  try {
    global.addEventListener('resize', function () {
      try { sizeCanvas(); } catch (e) { /* nada */ }
    }, { passive: true });
  } catch (e) { /* nada */ }

  try {
    if (global.ResizeObserver && stage) {
      var ro = new global.ResizeObserver(function () {
        try { sizeCanvas(); } catch (e) { /* nada */ }
      });
      ro.observe(stage);
    }
  } catch (e) { /* nada */ }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
