/*!
 * viewer-fx.js — motor de efectos de espectáculo de "WorldBox AI Show" (v4.0.0)
 * ============================================================================
 * ÚNICA capa de efectos sobre el mapa. Sin dependencias, sin módulos ES, sin
 * CDN, sin build: funciona con <script src="viewer-fx.js"> tanto por HTTP como
 * con file://. Inyecta sus estilos una sola vez (<style id="vfx2-css">).
 *
 * API (contrato SHOW-V4 §4; v4 añade emojis propios, anti-solape y efectos):
 * ----------------------------------------------------------------------------
 *   ViewerFX.version;                                   // '4.0.0'
 *   ViewerFX.apiVersion;                                // 4
 *   ViewerFX.init({ map: Element, motion: 'full'|'lite', maxEffects: 24 });
 *
 *   // Emoji invasor gigante, animación propia por emoción
 *   ViewerFX.invader(emoji, { side, emotion, size, duration, text, x, y, from, prio });
 *       emoji = NOMBRE propio ('palomitas', 'corona', 'gg'...), alias ('popcorn'),
 *               ':palomitas:' o cualquier Unicode de siempre (🍿 -> palomitas).
 *       x,y   = % del escenario donde aparece (sin x/y: comportamiento v2 38/62 %)
 *       from  = 'rojo'|'azul' -> entra volando desde ese lado (overshoot + onda)
 *       text  = frase de la IA -> burbuja bajo el emoji (máx. 2 líneas / 190 chars)
 *       prio  = 0..3 (por defecto 1; euforia 2) -> prioridad en la cola
 *       Anti-solape: 1 grande por bando, hueco entre bandos, cola FIFO con
 *       caducidad (~2,2 s). Si el bando está ocupado devuelve null y encola.
 *
 *   // Emoji pequeño en un punto (reacciones, coronas, iconos sueltos)
 *   ViewerFX.emojiAt(nombre, xPct, yPct, { size, duration, side });  // -> Element
 *
 *   // Etiqueta grande de acción en % del mapa (¡BOMBA ATÓMICA!, ¡TROPAS!...)
 *   ViewerFX.label(texto, xPct, yPct, { color, size, ms, kick });  // -> Element
 *
 *   // Impacto en % del mapa (0..100): onda, escombros, chispas, destello
 *   ViewerFX.impact(xPct, yPct, { power, color, emoji, debris, shake });
 *
 *   // v4 — efectos nuevos (todos activables desde el feed)
 *   ViewerFX.shockwave(xPct, yPct, { power, color });        // onda expansiva
 *   ViewerFX.quake(intensity, { duration, x, y });           // grietas/terremoto
 *   ViewerFX.ashfall({ duration, density, side });           // lluvia de ceniza
 *   ViewerFX.cameraFlash({ color, opacity, duration });      // flash de cámara
 *   ViewerFX.victory(side, { emoji, text, x, y });           // confeti+trofeo+flash
 *
 *   ViewerFX.damage(n, xPct, yPct, side);       // número flotante 90-110 px
 *   ViewerFX.sparks(xPct, yPct, { color, count });
 *   ViewerFX.shake(strength, { duration });     // 0..1
 *   ViewerFX.flash(color, { opacity, duration });
 *   ViewerFX.vignette(level, { color, duration });
 *   ViewerFX.confetti(side, { count });         // 'rojo'|'azul'|'mix'
 *   ViewerFX.clear();
 *
 *   // Catálogo de emojis propios (para QA y para el feed)
 *   ViewerFX.emojiNames();        // -> ['palomitas','risa',...]
 *   ViewerFX.emojiInfo(nombre);   // -> { name, label, svg } | null
 *   ViewerFX.emojiSVG(nombre);    // -> string SVG | null
 *   ViewerFX.legacy(true|false);  // QA: true = comportamiento v3 (sin anti-solape)
 *   ViewerFX.stageState();        // -> { activos, cola, cajas, solapes }
 *
 * Compatibilidad TOTAL con la API v3, v2 y v1 (alias a lo nuevo):
 *   spawnImpact(x,y,power,opts), spawnDamage(n,x,y,side,opts), flyEmoji(emoji,opts),
 *   flash, vignette, shake, spawnReaction, tremblePanel, focus, setMap, getMapEl,
 *   setMotion. Las firmas v1/v2/v3 no cambian; `version` pasa a '4.0.0'
 *   (apiVersion 4) y se exponen esV2/esV3/esV4 por si algún consumidor mira la versión.
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

  var VERSION = '4.0.0';
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
  var watchId = 0;       // v4: vigilante de dibujo (si el rAF no corre)
  var lastRafT = 0;
  var drawCount = 0;     // QA: nº de veces que drawP() ha pintado

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
    var old = doc.getElementById('vfx2-css');
    if (old && old.getAttribute('data-vfx') === VERSION) return;
    if (old && old.parentNode) {
      try { old.parentNode.removeChild(old); } catch (e) { /* nada */ }
    }
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
      /* etiqueta de emoción: GRANDE y SIEMPRE visible (v3) */
      '.vfx2-inv-tag{position:relative;font:900 clamp(20px,1.85vw,34px)/1 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'letter-spacing:.16em;text-transform:uppercase;color:#fff;padding:9px 22px 8px;border-radius:999px;',
      'background:rgba(5,8,14,.78);border:2.5px solid var(--c);',
      'box-shadow:0 0 28px var(--glow),0 8px 26px rgba(0,0,0,.6),inset 0 0 16px rgba(0,0,0,.6);',
      'text-shadow:0 0 20px var(--glow),0 2px 0 rgba(0,0,0,.9);',
      'margin-bottom:12px;white-space:nowrap;text-indent:.16em;animation:vfx2-tagpulse 1.7s ease-in-out infinite}',
      '.vfx2-inv-emoji{position:relative;font-size:var(--size);line-height:.92;',
      'filter:drop-shadow(0 14px 30px rgba(0,0,0,.62)) drop-shadow(0 0 30px var(--glow));',
      'will-change:transform,filter}',
      /* burbuja de diálogo bajo el emoji (v3): máx. 2 líneas, borde del bando */
      '.vfx2-inv-say{position:relative;margin-top:14px;display:flex;justify-content:center;',
      'animation:vfx2-textin .5s cubic-bezier(.2,1.4,.4,1) .14s both}',
      '.vfx2-inv-say:before{content:"";position:absolute;left:50%;top:-7px;width:13px;height:13px;',
      'background:rgba(4,7,12,.88);border-left:2px solid var(--sc,var(--c));border-top:2px solid var(--sc,var(--c));',
      'transform:translateX(-50%) rotate(45deg);border-top-left-radius:3px;z-index:2}',
      '.vfx2-inv-text{position:relative;z-index:1;max-width:min(calc(var(--size) * 2.6),380px);',
      'font:800 clamp(15px,1.1vw,18px)/1.3 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'color:#fff;text-align:center;letter-spacing:.005em;background:rgba(4,7,12,.88);',
      'border:2px solid var(--sc,var(--c));border-radius:16px;padding:9px 15px 10px;',
      'box-shadow:0 12px 34px rgba(0,0,0,.66),0 0 24px var(--glow),inset 0 0 18px rgba(0,0,0,.5);',
      'text-shadow:0 2px 0 rgba(0,0,0,.9),0 1px 10px rgba(0,0,0,.75);',
      'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}',
      '.vfx2-inv.vfx2-out .vfx2-inv-enter{animation:vfx2-out .34s ease-in forwards}',
      /* v3: entrada volando desde un lado con overshoot (aterriza con onda) */
      '.vfx2-inv-from-rojo .vfx2-inv-enter{animation:vfx2-fly-l .8s cubic-bezier(.2,.84,.24,1) both}',
      '.vfx2-inv-from-azul .vfx2-inv-enter{animation:vfx2-fly-a .8s cubic-bezier(.2,.84,.24,1) both}',
      /* v3: ecos del emoji (burla) */
      '.vfx2-echo{position:absolute;left:0;top:0;line-height:1;pointer-events:none;',
      'transform:translate(-50%,-50%);filter:drop-shadow(0 8px 18px rgba(0,0,0,.5));',
      'animation:vfx2-echo 1.35s ease-out both}',

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
      /* v4: el arcoíris va SOLO en el glow; el emoji personalizado conserva sus colores */
      '.vfx2-inv-euforia .vfx2-inv-glow{animation:vfx2-rainbowglow 2.4s linear infinite}',
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
      '.vfx2-dmg-r{color:#fff4f4;-webkit-text-stroke:4px #420808;',
      'text-shadow:-4px -4px 0 #5b0d0d,4px -4px 0 #5b0d0d,-4px 4px 0 #5b0d0d,4px 4px 0 #5b0d0d,0 8px 0 #3d0505,0 0 36px rgba(255,70,60,.95),0 12px 30px rgba(0,0,0,.9)}',
      '.vfx2-dmg-a{color:#eef9ff;-webkit-text-stroke:4px #031f2e;',
      'text-shadow:-4px -4px 0 #06344d,4px -4px 0 #06344d,-4px 4px 0 #06344d,4px 4px 0 #06344d,0 8px 0 #041f30,0 0 36px rgba(56,189,248,.95),0 12px 30px rgba(0,0,0,.9)}',

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

      /* ---- v3: etiqueta grande de acción (¡BOMBA ATÓMICA!, ¡TROPAS!...) ---- */
      '.vfx2-label{position:absolute;transform:translate(-50%,-50%);z-index:9;pointer-events:none;',
      'font:900 var(--fs,64px)/1 ui-sans-serif,system-ui,"Segoe UI",Roboto,Arial,sans-serif;',
      'letter-spacing:.015em;text-transform:uppercase;white-space:nowrap;',
      'color:var(--c,#ffd36b);-webkit-text-stroke:var(--stroke,5px) rgba(0,0,0,.94);paint-order:stroke fill;',
      'text-shadow:0 0 34px var(--glow,rgba(255,211,107,.8)),0 10px 34px rgba(0,0,0,.9);',
      'animation:vfx2-label var(--d,1.7s) cubic-bezier(.16,.9,.2,1) forwards;will-change:transform,opacity}',

      /* ---- v3: efectos de pantalla por emoción ---- */
      '.vfx2-desat{position:absolute;inset:0;pointer-events:none;z-index:0;background:rgba(146,158,182,.16);',
      '-webkit-backdrop-filter:grayscale(.84) saturate(.55) contrast(1.02);',
      'backdrop-filter:grayscale(.84) saturate(.55) contrast(1.02);',
      'animation:vfx2-desat var(--d,.55s) ease-out forwards;will-change:opacity}',
      '.vfx2-rainbow{position:absolute;inset:-8%;pointer-events:none;z-index:55;',
      'background:linear-gradient(102deg,#ff3b30 0%,#ff9f0a 18%,#ffd60a 34%,#34d399 50%,#38bdf8 66%,#a78bfa 84%,#ff3b30 100%);',
      'filter:blur(48px) saturate(1.35);mix-blend-mode:screen;opacity:0;',
      'animation:vfx2-rbsweep var(--d,.9s) ease-out forwards;will-change:opacity,transform}',

      /* ---- lite ---- */
      '.vfx2-lite .vfx2-inv-body,.vfx2-lite .vfx2-inv-emoji,.vfx2-lite .vfx2-inv-glow,',
      '.vfx2-lite .vfx2-inv-tag,.vfx2-lite .vfx2-inv-text,.vfx2-lite .vfx2-inv-say{animation:none!important}',
      '.vfx2-lite .vfx2-inv-enter,.vfx2-lite .vfx2-inv-from-rojo .vfx2-inv-enter,',
      '.vfx2-lite .vfx2-inv-from-azul .vfx2-inv-enter{animation:vfx2-in .3s ease-out both}',
      '.vfx2-lite .vfx2-echo{display:none}',
      /* Modo lite: la etiqueta y el daño deben verse SIEMPRE (estáticos).
         No usan animación porque con prefers-reduced-motion los navegadores
         fuerzan animation-duration:.001ms!important y acabarían en opacity 0. */
      '.vfx2-lite .vfx2-label{animation:none!important;opacity:1}',
      '.vfx2-lite .vfx2-dmg{animation:none!important;opacity:1}',

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
      '@keyframes vfx2-rainbowglow{0%{filter:blur(26px) hue-rotate(0deg)}',
      '100%{filter:blur(26px) hue-rotate(360deg)}}',
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
      '@keyframes vfx2-flash{0%{opacity:var(--o,.35)}14%{opacity:var(--o,.35)}100%{opacity:0}}',

      /* ---- v3 ---- */
      '@keyframes vfx2-tagpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.055)}}',
      '@keyframes vfx2-fly-l{0%{opacity:0;transform:translate(-60vw,-4vh) scale(.6) rotate(-16deg)}',
      '9%{opacity:1}',
      '54%{opacity:1;transform:translate(4.6vw,1vh) scale(1.1) rotate(2.4deg)}',
      '70%{transform:translate(-1.9vw,0) scale(.97) rotate(-1.2deg)}',
      '84%{transform:translate(.7vw,0) scale(1.02) rotate(.4deg)}',
      '100%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}}',
      '@keyframes vfx2-fly-a{0%{opacity:0;transform:translate(60vw,-4vh) scale(.6) rotate(16deg)}',
      '9%{opacity:1}',
      '54%{opacity:1;transform:translate(-4.6vw,1vh) scale(1.1) rotate(-2.4deg)}',
      '70%{transform:translate(1.9vw,0) scale(.97) rotate(1.2deg)}',
      '84%{transform:translate(-.7vw,0) scale(1.02) rotate(-.4deg)}',
      '100%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}}',
      '@keyframes vfx2-echo{0%{opacity:.5;transform:translate(-50%,-50%) scale(.9)}',
      '100%{opacity:0;transform:translate(calc(-50% + var(--ex,0px)),calc(-50% + var(--ey,0px))) scale(1.32)}}',
      '@keyframes vfx2-label{0%{opacity:0;transform:translate(-50%,-50%) scale(.5) rotate(-4deg)}',
      '11%{opacity:1;transform:translate(-50%,-50%) scale(calc(1 + .16 * var(--kick,1))) rotate(1.2deg)}',
      '23%{opacity:1;transform:translate(-50%,-50%) scale(.975) rotate(-.6deg)}',
      '33%{opacity:1;transform:translate(-50%,-50%) scale(1.015) rotate(0deg)}',
      '72%{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(0deg)}',
      '100%{opacity:0;transform:translate(-50%,-50%) scale(1.06) translateY(-16px) rotate(0deg)}}',
      '@keyframes vfx2-desat{0%{opacity:0}10%{opacity:1}62%{opacity:.92}100%{opacity:0}}',
      '@keyframes vfx2-rbsweep{0%{opacity:0;transform:translateY(-6%)}12%{opacity:.3}55%{opacity:.22}100%{opacity:0;transform:translateY(2%)}}',
      /* ---- v4: emojis propios (SVG inline) ---- */
      '.vfx2-inv-emoji svg,.vfx2-echo svg,.vfx2-boom svg,.vfx2-react svg,.vfx2-fly svg{width:1em;height:1em;display:block;overflow:visible;pointer-events:none}',
      '.vfx2-inv-emoji svg,.vfx2-boom svg,.vfx2-react svg,.vfx2-fly svg{filter:drop-shadow(0 8px 14px rgba(0,0,0,.42))}',
      '.vfx2-inv-emoji svg *,.vfx2-boom svg *,.vfx2-react svg *{vector-effect:non-scaling-stroke}',
      /* ---- v4: onda expansiva ---- */
      '.vfx2-sw{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:5}',
      '.vfx2-sw-ring{position:absolute;left:0;top:0;width:var(--s,240px);height:var(--s,240px);margin-left:calc(var(--s,240px) / -2);margin-top:calc(var(--s,240px) / -2);border-radius:50%;border:var(--bw,10px) solid var(--c,#ffd36b);box-shadow:0 0 46px var(--c,#ffd36b),inset 0 0 30px var(--c,#ffd36b);opacity:0;animation:vfx2-sw var(--d,1.1s) cubic-bezier(.15,.72,.2,1) forwards;animation-delay:var(--delay,0s)}',
      '.vfx2-sw-ring.vfx2-sw-fill{background:radial-gradient(circle,var(--c,#ffd36b) 0%,transparent 64%);border:none;box-shadow:none;animation-name:vfx2-swfill}',
      '@keyframes vfx2-sw{0%{opacity:.95;transform:scale(.12)}68%{opacity:.45}100%{opacity:0;transform:scale(1)}}',
      '@keyframes vfx2-swfill{0%{opacity:.5;transform:scale(.2)}100%{opacity:0;transform:scale(1.18)}}',
      /* ---- v4: grietas / terremoto ---- */
      '.vfx2-quake{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:4;opacity:0;animation:vfx2-quakefade var(--d,2.4s) ease-out forwards}',
      '.vfx2-quake svg{width:100%;height:100%;display:block}',
      '.vfx2-quake path{fill:none;stroke:var(--c,#1a1208);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;opacity:.9;stroke-dasharray:var(--len,700);stroke-dashoffset:var(--len,700);animation:vfx2-crack var(--d,1.4s) ease-out forwards;animation-delay:var(--delay,0s)}',
      '.vfx2-quake path.vfx2-crack-glow{stroke:rgba(255,190,80,.55);stroke-width:5.5}',
      '@keyframes vfx2-crack{0%{stroke-dashoffset:var(--len,700);opacity:0}10%{opacity:1}70%{opacity:.95}100%{stroke-dashoffset:0;opacity:0}}',
      '@keyframes vfx2-quakefade{0%{opacity:0}7%{opacity:1}72%{opacity:.92}100%{opacity:0}}',
      /* ---- v4: lluvia de ceniza ---- */
      '.vfx2-ash{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:4;opacity:0;background:radial-gradient(120% 92% at 50% 0%,rgba(96,96,104,.16) 0%,rgba(30,30,36,.50) 72%,rgba(12,12,16,.64) 100%);animation:vfx2-ash var(--d,5s) linear forwards}',
      '@keyframes vfx2-ash{0%{opacity:0}10%{opacity:1}78%{opacity:.95}100%{opacity:0}}',
      /* ---- v4: flash de cámara (obturador) ---- */
      '.vfx2-cam{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:9;overflow:hidden}',
      '.vfx2-cam-flash{position:absolute;left:0;top:0;width:100%;height:100%;background:var(--c,#ffffff);opacity:0;animation:vfx2-camflash var(--d,.62s) ease-out forwards}',
      '.vfx2-cam-bar{position:absolute;left:0;width:100%;height:7%;background:#0b0d10;transform:scaleY(0);box-shadow:0 0 34px rgba(0,0,0,.65)}',
      '.vfx2-cam-bar.vfx2-cam-top{top:0;transform-origin:top center}',
      '.vfx2-cam-bar.vfx2-cam-bot{bottom:0;transform-origin:bottom center}',
      '.vfx2-cam-bar.vfx2-cam-top{animation:vfx2-cambar-top var(--d,.62s) cubic-bezier(.2,.85,.2,1) forwards}',
      '.vfx2-cam-bar.vfx2-cam-bot{animation:vfx2-cambar-bot var(--d,.62s) cubic-bezier(.2,.85,.2,1) forwards}',
      '.vfx2-cam-iris{position:absolute;left:50%;top:50%;width:34vmin;height:34vmin;margin-left:-17vmin;margin-top:-17vmin;border-radius:50%;border:2px solid rgba(255,255,255,.75);box-shadow:0 0 60px rgba(255,255,255,.35),inset 0 0 40px rgba(255,255,255,.18);opacity:0;animation:vfx2-camiris var(--d,.62s) ease-out forwards}',
      '@keyframes vfx2-camflash{0%{opacity:0}5%{opacity:var(--o,.85)}100%{opacity:0}}',
      '@keyframes vfx2-cambar-top{0%{transform:scaleY(0)}12%{transform:scaleY(1)}66%{transform:scaleY(1)}100%{transform:scaleY(0)}}',
      '@keyframes vfx2-cambar-bot{0%{transform:scaleY(0)}12%{transform:scaleY(1)}66%{transform:scaleY(1)}100%{transform:scaleY(0)}}',
      '@keyframes vfx2-camiris{0%{opacity:0;transform:scale(1.5)}14%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(.82)}}',
      /* ---- v4: victoria ---- */
      '.vfx2-vic{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:8;background:radial-gradient(circle at 50% 44%,rgba(255,212,94,.24) 0%,rgba(255,212,94,.06) 34%,transparent 66%);opacity:0;animation:vfx2-vic 2.8s ease-out forwards}',
      '@keyframes vfx2-vic{0%{opacity:0}10%{opacity:1}66%{opacity:.9}100%{opacity:0}}'
    ].join('');
    var st = make('style');
    st.id = 'vfx2-css';
    st.setAttribute('data-vfx', VERSION);
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
    kickDraw();
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

  /* v4: si el rAF no corre (headless, pestaña oculta, compositor parado) las
     partículas se acumularían sin pintarse nunca. Este vigilante las dibuja a
     25 fps SOLO cuando el rAF lleva >120 ms sin dar señales. */
  function kickDraw() {
    if (watchId) return;
    watchId = every(function () {
      if (!P.length) {
        stopEvery(watchId); watchId = 0; lastT = 0;
        if (nowMs() - lastRafT > 400) rafId = 0; // deja que startLoop reintente
        return;
      }
      if (doc && doc.hidden) return;
      if (nowMs() - lastRafT < 120) return;      // rAF vivo: no duplicamos
      var t = nowMs();
      var dt = lastT ? clamp((t - lastT) / 1000, 0, 0.05) : 0.016;
      lastT = t;
      stepP(dt);
      drawP();
    }, 40);
  }

  function loop(t) {
    rafId = 0;
    lastRafT = nowMs();
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
    drawCount++;
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

  /* ==========================================================================
   * v4 — EMOJIS PERSONALIZADOS (SVG inline, estilo plano con contorno)
   * ------------------------------------------------------------------------
   * Se piden por NOMBRE desde el feed: emoji:"palomitas", "corona", "gg"...
   * Los Unicode de siempre (🍿👑😂...) se traducen al emoji propio; si no hay
   * traducción se pintan como texto (fallback intacto). Todo el arte va inline:
   * cero peticiones, cero ficheros que sincronizar.
   * ======================================================================== */

  var EMOJI = {
    palomitas: {
      label: 'PALOMITAS', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="34" r="23" fill="#FFD45E"/>' +
        '<path d="M30 30 Q30 12 50 11 Q70 12 70 30 Q62 22 50 23 Q38 22 30 30 Z" fill="#6B3F1D"/>' +
        '<path d="M36 34 q5 -7 10 0" fill="none"/>' +
        '<path d="M54 34 q5 -7 10 0" fill="none"/>' +
        '<path d="M35 43 Q50 62 65 43 Q50 50 35 43 Z" fill="#7A1F1F"/>' +
        '<ellipse cx="50" cy="50" rx="9" ry="4.5" fill="#F87171" stroke="none"/>' +
        '<rect x="33" y="66" width="34" height="26" rx="4" fill="#E23B3B"/>' +
        '<path d="M41 66 v26 M50 66 v26 M59 66 v26" stroke="#FFF7E6" stroke-width="6"/>' +
        '<circle cx="39" cy="62" r="6.5" fill="#FFF7E6"/>' +
        '<circle cx="50" cy="57" r="7.5" fill="#FFF7E6"/>' +
        '<circle cx="61" cy="62" r="6.5" fill="#FFF7E6"/>' +
        '<circle cx="44" cy="56" r="5.5" fill="#FFF7E6"/>' +
        '<circle cx="56" cy="56" r="5.5" fill="#FFF7E6"/>' +
        '<circle cx="31" cy="76" r="5.5" fill="#FFD45E"/>' +
        '<circle cx="69" cy="76" r="5.5" fill="#FFD45E"/>' +
        '</g>'
    },
    risa: {
      label: 'RISA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#FFD45E"/>' +
        '<path d="M23 38 q8 -13 18 -1" fill="none"/>' +
        '<path d="M59 38 q8 -13 18 -1" fill="none"/>' +
        '<path d="M23 50 Q50 90 77 50 Q50 64 23 50 Z" fill="#7A1F1F"/>' +
        '<path d="M33 54 Q50 64 67 54" fill="none" stroke="#F87171"/>' +
        '<ellipse cx="50" cy="68" rx="11" ry="6" fill="#F87171" stroke="none"/>' +
        '<path d="M20 40 q-7 12 -2 20" fill="none" stroke="#38BDF8"/>' +
        '<path d="M80 40 q7 12 2 20" fill="none" stroke="#38BDF8"/>' +
        '</g>'
    },
    llorando: {
      label: 'LLORANDO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#8ED8F8"/>' +
        '<path d="M26 40 q7 -8 15 -2" fill="none"/>' +
        '<path d="M59 38 q8 -6 15 2" fill="none"/>' +
        '<path d="M32 48 q5 7 10 0" fill="none"/>' +
        '<path d="M58 48 q5 7 10 0" fill="none"/>' +
        '<path d="M39 62 Q50 82 61 62 Q50 68 39 62 Z" fill="#7A1F1F"/>' +
        '<path d="M33 52 q-6 16 1 26" fill="none" stroke="#2563EB" stroke-width="7"/>' +
        '<path d="M67 52 q6 16 -1 26" fill="none" stroke="#2563EB" stroke-width="7"/>' +
        '<path d="M26 68 q-3 8 1 12" fill="none" stroke="#60A5FA" stroke-width="5"/>' +
        '<path d="M74 68 q3 8 -1 12" fill="none" stroke="#60A5FA" stroke-width="5"/>' +
        '</g>'
    },
    asco: {
      label: 'ASCO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#A3D977"/>' +
        '<path d="M27 36 l13 11 M40 36 l-13 11" fill="none"/>' +
        '<path d="M60 36 l13 11 M73 36 l-13 11" fill="none"/>' +
        '<path d="M30 64 q6 -9 12 -1 q6 8 12 -1 q5 -7 10 0" fill="none"/>' +
        '<path d="M44 68 q6 16 14 6 q4 -5 2 -8" fill="#F472B6"/>' +
        '<circle cx="27" cy="58" r="4" fill="#86EFAC" stroke="none"/>' +
        '<circle cx="73" cy="58" r="4" fill="#86EFAC" stroke="none"/>' +
        '</g>'
    },
    sorpresa: {
      label: 'SORPRESA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#FFD45E"/>' +
        '<ellipse cx="37" cy="38" rx="8" ry="10" fill="#FFFFFF"/>' +
        '<circle cx="37" cy="39" r="4.2" fill="#141A24" stroke="none"/>' +
        '<ellipse cx="63" cy="38" rx="8" ry="10" fill="#FFFFFF"/>' +
        '<circle cx="63" cy="39" r="4.2" fill="#141A24" stroke="none"/>' +
        '<ellipse cx="50" cy="68" rx="12" ry="14" fill="#7A1F1F"/>' +
        '<path d="M24 22 q7 -6 14 -1" fill="none"/>' +
        '<path d="M76 22 q-7 -6 -14 -1" fill="none"/>' +
        '<path d="M18 54 q-5 10 0 16" fill="none" stroke="#38BDF8" stroke-width="5"/>' +
        '</g>'
    },
    furia: {
      label: 'FURIA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#FF6B5A"/>' +
        '<path d="M23 36 l17 9" fill="none"/>' +
        '<path d="M77 36 l-17 9" fill="none"/>' +
        '<circle cx="37" cy="49" r="5.5" fill="#141A24" stroke="none"/>' +
        '<circle cx="63" cy="49" r="5.5" fill="#141A24" stroke="none"/>' +
        '<path d="M37 71 Q50 60 63 71" fill="none"/>' +
        '<path d="M16 28 q-7 -8 1 -13" fill="none" stroke="#FF3B30" stroke-width="5"/>' +
        '<path d="M84 28 q7 -8 -1 -13" fill="none" stroke="#FF3B30" stroke-width="5"/>' +
        '</g>'
    },
    euforia: {
      label: 'EUFORIA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="50" r="42" fill="#FFD45E"/>' +
        '<path d="M0 -9 L2.6 -2.8 L9 -2.2 L4.2 2 L5.6 8.4 L0 4.8 L-5.6 8.4 L-4.2 2 L-9 -2.2 L-2.6 -2.8 Z" transform="translate(36 39)" fill="#F59E0B" stroke-width="3"/>' +
        '<path d="M0 -9 L2.6 -2.8 L9 -2.2 L4.2 2 L5.6 8.4 L0 4.8 L-5.6 8.4 L-4.2 2 L-9 -2.2 L-2.6 -2.8 Z" transform="translate(64 39)" fill="#F59E0B" stroke-width="3"/>' +
        '<path d="M37 64 Q50 79 63 64 Q50 70 37 64 Z" fill="#7A1F1F"/>' +
        '<ellipse cx="50" cy="68" rx="8" ry="3.5" fill="#F87171" stroke="none"/>' +
        '</g>'
    },
    corona: {
      label: 'CORONA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M16 72 L12 30 L31 45 L50 18 L69 45 L88 30 L84 72 Z" fill="#FFD45E"/>' +
        '<rect x="15" y="72" width="70" height="13" rx="4" fill="#F59E0B"/>' +
        '<circle cx="31" cy="47" r="4.5" fill="#EF4444" stroke="none"/>' +
        '<circle cx="50" cy="37" r="5.5" fill="#38BDF8" stroke="none"/>' +
        '<circle cx="69" cy="47" r="4.5" fill="#EF4444" stroke="none"/>' +
        '<circle cx="24" cy="79" r="3" fill="#FFF7E6" stroke="none"/>' +
        '<circle cx="50" cy="79" r="3" fill="#FFF7E6" stroke="none"/>' +
        '<circle cx="76" cy="79" r="3" fill="#FFF7E6" stroke="none"/>' +
        '</g>'
    },
    calavera: {
      label: 'CALAVERA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M50 8 C25 8 14 27 14 46 C14 60 22 67 29 71 L29 83 Q29 92 38 92 L62 92 Q71 92 71 83 L71 71 C78 67 86 60 86 46 C86 27 75 8 50 8 Z" fill="#F8FAFC"/>' +
        '<ellipse cx="35" cy="45" rx="11" ry="13" fill="#141A24" stroke="none"/>' +
        '<ellipse cx="65" cy="45" rx="11" ry="13" fill="#141A24" stroke="none"/>' +
        '<path d="M50 57 l-7 11 h14 Z" fill="#141A24" stroke="none"/>' +
        '<path d="M33 77 v9 M41 77 v9 M50 77 v9 M59 77 v9 M67 77 v9" stroke-width="3.5"/>' +
        '</g>'
    },
    fuego: {
      label: 'FUEGO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M50 6 C57 24 78 32 78 55 C78 75 65 92 50 92 C35 92 22 75 22 55 C22 40 33 30 39 19 C41 33 47 38 50 44 C56 32 56 19 50 6 Z" fill="#FF6B35"/>' +
        '<path d="M50 40 C56 52 65 57 65 69 C65 81 58 90 50 90 C42 90 35 81 35 69 C35 58 44 52 50 40 Z" fill="#FFD45E" stroke="none"/>' +
        '<path d="M50 62 C53 68 57 71 57 77 C57 83 54 88 50 88 C46 88 43 83 43 77 C43 71 47 68 50 62 Z" fill="#FFF7E6" stroke="none"/>' +
        '</g>'
    },
    explosion: {
      label: 'EXPLOSIÓN', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M50 4 L60 27 L83 18 L74 41 L96 50 L74 59 L83 82 L60 73 L50 96 L40 73 L17 82 L26 59 L4 50 L26 41 L17 18 L40 27 Z" fill="#FF8A3D"/>' +
        '<path d="M50 22 L57 40 L77 36 L63 50 L77 64 L57 60 L50 78 L43 60 L23 64 L37 50 L23 36 L43 40 Z" fill="#FFD45E" stroke="none"/>' +
        '<circle cx="50" cy="50" r="9" fill="#FFF7E6" stroke="none"/>' +
        '</g>'
    },
    'bandera-roja': {
      label: 'BANDERA ROJA', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M28 12 v80" fill="none" stroke-width="6"/>' +
        '<circle cx="28" cy="10" r="5.5" fill="#FFD45E"/>' +
        '<path d="M31 14 Q56 6 82 20 L82 46 Q56 32 31 40 Z" fill="#EF4444"/>' +
        '<path d="M31 20 Q56 13 82 27" fill="none" stroke="#B91C1C" stroke-width="2"/>' +
        '</g>'
    },
    'bandera-azul': {
      label: 'BANDERA AZUL', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M28 12 v80" fill="none" stroke-width="6"/>' +
        '<circle cx="28" cy="10" r="5.5" fill="#FFD45E"/>' +
        '<path d="M31 14 Q56 6 82 20 L82 46 Q56 32 31 40 Z" fill="#38BDF8"/>' +
        '<path d="M31 20 Q56 13 82 27" fill="none" stroke="#0284C7" stroke-width="2"/>' +
        '</g>'
    },
    gg: {
      label: 'GG', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<rect x="7" y="21" width="86" height="58" rx="14" fill="#7C3AED"/>' +
        '<text x="50" y="67" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-size="40" font-weight="900" fill="#FFD45E" stroke-width="3" paint-order="stroke">GG</text>' +
        '</g>'
    },
    punio: {
      label: 'PUÑO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M30 46 V35 Q30 26 38 26 Q46 26 46 35 V32 Q46 23 54 23 Q62 23 62 32 V35 Q62 26 70 26 Q78 26 78 35 V53 Q78 70 66 80 L64 87 Q62 92 56 92 H42 Q36 92 34 86 L30 72 Q25 63 28 55 Z" fill="#FFD45E"/>' +
        '<path d="M46 41 v13 M62 41 v13" fill="none" stroke-width="3"/>' +
        '<path d="M28 56 Q21 52 21 45 Q21 39 28 40" fill="#FFD45E"/>' +
        '</g>'
    },
    diablillo: {
      label: 'DIABLILLO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M23 30 L13 7 L37 19 Z" fill="#EF4444"/>' +
        '<path d="M77 30 L87 7 L63 19 Z" fill="#EF4444"/>' +
        '<circle cx="50" cy="55" r="35" fill="#C084FC"/>' +
        '<path d="M30 44 l12 8 M42 44 l-12 8" fill="none" stroke-width="3.5"/>' +
        '<path d="M58 44 l12 8 M70 44 l-12 8" fill="none" stroke-width="3.5"/>' +
        '<path d="M33 66 Q50 84 67 66 Q50 73 33 66 Z" fill="#7A1F1F"/>' +
        '<path d="M40 67 l3 9 M50 69 v9 M60 67 l-3 9" stroke="#FFF7E6" stroke-width="3.5"/>' +
        '</g>'
    },
    angel: {
      label: 'ÁNGEL', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<circle cx="50" cy="12" r="10" fill="none" stroke="#FBBF24" stroke-width="5"/>' +
        '<path d="M20 42 Q4 54 16 70 Q24 58 29 60 Z" fill="#E0F2FE"/>' +
        '<path d="M80 42 Q96 54 84 70 Q76 58 71 60 Z" fill="#E0F2FE"/>' +
        '<circle cx="50" cy="52" r="32" fill="#FEF3C7"/>' +
        '<path d="M39 47 q4 -5 8 0" fill="none"/>' +
        '<path d="M53 47 q4 -5 8 0" fill="none"/>' +
        '<path d="M41 60 Q50 69 59 60" fill="none"/>' +
        '<circle cx="34" cy="56" r="3.5" fill="#FCA5A5" stroke="none"/>' +
        '<circle cx="66" cy="56" r="3.5" fill="#FCA5A5" stroke="none"/>' +
        '</g>'
    },
    trofeo: {
      label: 'TROFEO', svg:
        '<g stroke="#141A24" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M32 22 H20 Q20 44 36 46" fill="none" stroke-width="5"/>' +
        '<path d="M68 22 H80 Q80 44 64 46" fill="none" stroke-width="5"/>' +
        '<path d="M31 14 H69 V34 Q69 56 50 56 Q31 56 31 34 Z" fill="#FFD45E"/>' +
        '<rect x="44" y="56" width="12" height="14" fill="#F59E0B"/>' +
        '<rect x="31" y="70" width="38" height="11" rx="3" fill="#F59E0B"/>' +
        '<path d="M50 24 L52.6 30 L59 30.6 L54.2 34.8 L55.6 41 L50 37.6 L44.4 41 L45.8 34.8 L41 30.6 L47.4 30 Z" fill="#FFF7E6" stroke-width="2"/>' +
        '</g>'
    }
  };

  var EMOJI_ORDER = ['palomitas', 'risa', 'llorando', 'asco', 'sorpresa', 'furia', 'euforia',
    'corona', 'calavera', 'fuego', 'explosion', 'bandera-roja', 'bandera-azul', 'gg', 'punio',
    'diablillo', 'angel', 'trofeo'];

  var EMOJI_ALIAS = {
    popcorn: 'palomitas', 'tio-palomitas': 'palomitas', 'tio-palomitas-riendo': 'palomitas',
    'palomitas-riendo': 'palomitas', 'tio-palomitas-riendose': 'palomitas',
    laugh: 'risa', lol: 'risa', jaja: 'risa', risas: 'risa',
    cry: 'llorando', llanto: 'llorando', lagrimas: 'llorando', llorar: 'llorando',
    sick: 'asco', vomito: 'asco', asqueroso: 'asco', nausea: 'asco',
    shock: 'sorpresa', wow: 'sorpresa', panico: 'sorpresa', 'o-oh': 'sorpresa',
    angry: 'furia', enfado: 'furia', rabia: 'furia', cabreo: 'furia',
    starstruck: 'euforia', flipado: 'euforia', hype: 'euforia',
    crown: 'corona', rey: 'corona', reina: 'corona',
    skull: 'calavera', muerte: 'calavera', muerto: 'calavera',
    fire: 'fuego', llama: 'fuego', ardiendo: 'fuego',
    boom: 'explosion', bomba: 'explosion', petardazo: 'explosion',
    'bandera_roja': 'bandera-roja', rojo: 'bandera-roja', redflag: 'bandera-roja', 'red-flag': 'bandera-roja',
    'bandera_azul': 'bandera-azul', azul: 'bandera-azul', blueflag: 'bandera-azul', 'blue-flag': 'bandera-azul',
    'buena-partida': 'gg', ggp: 'gg', 'gg-wp': 'gg',
    fist: 'punio', puño: 'punio', fuerza: 'punio', animo: 'punio', 'animo': 'punio',
    devil: 'diablillo', diablo: 'diablillo', demonio: 'diablillo',
    halo: 'angel', 'angelito': 'angel',
    trophy: 'trofeo', campeon: 'trofeo', victoria: 'trofeo', ganador: 'trofeo'
  };

  /* Unicode de siempre -> emoji propio. Si no está aquí, se pinta tal cual. */
  var UNI_EMOJI = {
    '\uD83C\uDF7F': 'palomitas',
    '\uD83D\uDC51': 'corona',
    '\uD83D\uDC80': 'calavera',
    '\uD83D\uDD25': 'fuego',
    '\uD83D\uDCA5': 'explosion',
    '\uD83D\uDE02': 'risa', '\uD83E\uDD23': 'risa',
    '\uD83D\uDE2D': 'llorando', '\uD83D\uDE22': 'llorando',
    '\uD83E\uDD22': 'asco', '\uD83E\uDD2E': 'asco',
    '\uD83D\uDE31': 'sorpresa', '\uD83D\uDE28': 'sorpresa',
    '\uD83D\uDE21': 'furia', '\uD83D\uDE20': 'furia', '\uD83D\uDE24': 'furia',
    '\uD83E\uDD29': 'euforia', '\uD83D\uDE0D': 'euforia',
    '\uD83D\uDE08': 'diablillo', '\uD83D\uDC7F': 'diablillo',
    '\uD83D\uDE07': 'angel', '\uD83D\uDC7C': 'angel',
    '\uD83C\uDFC6': 'trofeo', '\uD83E\uDD47': 'trofeo',
    '\uD83D\uDCAA': 'punio', '\uD83D\uDC4A': 'punio', '\u270A': 'punio',
    '\uD83D\uDEA9': 'bandera-roja',
    '\uD83C\uDFF3': 'bandera-roja',
    /* v4: los que salen de verdad en el show (medidos sobre show.json y feed.json).
       Si aparece uno nuevo, se añade aquí; si no, el catch-all lo pinta genérico. */
    '\uD83D\uDE0F': 'risa',       // 😏 pícaro
    '\uD83D\uDE0E': 'euforia',    // 😎 gafas de sol
    '\uD83E\uDEE0': 'asco',       // 🫠 derritiéndose
    '\uD83D\uDE12': 'asco',       // 😒 desgana
    '\uD83D\uDCA8': 'explosion',  // 💨 racha
    '\uD83C\uDCCF': 'diablillo',  // 🃏 comodín
    '\uD83D\uDE2E': 'sorpresa',   // 😮 boca abierta
    '\uD83C\uDFDA': 'calavera',   // 🏚 ruina
    '\uD83D\uDE0C': 'angel',      // 😌 alivio
    '\u2622': 'explosion',        // ☢ radiactivo
    /* v4: red de seguridad extra (risas, furias y celebraciones habituales) */
    '\uD83D\uDE00': 'risa', '\uD83D\uDE01': 'risa', '\uD83D\uDE03': 'risa',
    '\uD83D\uDE04': 'risa', '\uD83D\uDE05': 'risa', '\uD83D\uDE06': 'risa',
    '\uD83D\uDE44': 'risa',       // 🙄
    '\uD83D\uDE10': 'asco',       // 😑
    '\uD83E\uDD2C': 'furia',      // 🤬
    '\uD83D\uDE29': 'llorando',   // 😩
    '\u2620': 'calavera', '\uD83D\uDC7B': 'calavera',   // ☠ 👻
    '\u2728': 'euforia', '\uD83C\uDF89': 'euforia', '\uD83C\uDF8A': 'euforia',
    '\uD83D\uDC4F': 'euforia', '\uD83D\uDC8E': 'euforia', '\uD83D\uDCB0': 'euforia',
    '\uD83D\uDE80': 'euforia',    // 👏 💎 💰 🚀
    '\uD83E\uDD1D': 'gg',         // 🤝
    '\uD83D\uDE4F': 'angel',      // 🙏
    '\uD83D\uDCA3': 'explosion',  // 💣
    '\u2694': 'furia', '\uD83D\uDD2B': 'furia'   // ⚔ 🔫
  };

  /* v4 — catch-all: NUNCA un emoji del sistema en pantalla. Si llega un Unicode
     que no está en la tabla, se pinta con una pieza propia genérica. */
  var EMOJI_GENERICO = 'sorpresa';
  var RE_EMOJI_SUELTO = (function () {
    try {
      return new RegExp('^[\\p{Extended_Pictographic}\\u200D\\uFE0F\\u20E3\\u{1F3FB}-\\u{1F3FF}]+$', 'u');
    } catch (e) { return null; }
  })();

  /* ¿El valor es UN emoji suelto? (texto normal como '¡SOY EL REY!' -> false) */
  function esEmojiSuelto(s) {
    if (!s || s.length > 24) return false;
    if (RE_EMOJI_SUELTO) {
      try { return RE_EMOJI_SUELTO.test(s); } catch (e) { /* sigue */ }
    }
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD83C && c <= 0xD83E) return true;
    }
    return false;
  }

  /* Acepta nombre ('palomitas'), alias ('popcorn'), ':palomitas:' o Unicode. */
  function normEmoji(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return null;
    if (EMOJI[s]) return s;
    var low = s.toLowerCase().replace(/^:+|:+$/g, '').replace(/\s+/g, '-');
    if (EMOJI[low]) return low;
    if (EMOJI_ALIAS[low]) return EMOJI_ALIAS[low];
    if (UNI_EMOJI[s]) return UNI_EMOJI[s];
    var s2 = s.replace(/[\uFE0E\uFE0F]/g, '');
    if (UNI_EMOJI[s2]) return UNI_EMOJI[s2];
    /* v4: emoji desconocido -> pieza propia genérica (nunca el del sistema) */
    if (esEmojiSuelto(s2)) return EMOJI_GENERICO;
    return null;
  }

  /* Pinta el emoji propio dentro de un contenedor; si no se reconoce, texto. */
  function setEmojiContent(el, v) {
    if (!el) return null;
    var name = normEmoji(v);
    if (name) {
      el.innerHTML = '<svg class="vfx2-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
        EMOJI[name].svg + '</svg>';
      el.setAttribute('data-emoji', name);
      return name;
    }
    el.textContent = String(v == null ? '' : v);
    try { el.removeAttribute('data-emoji'); } catch (e) { /* nada */ }
    return null;
  }

  function emojiInfo(name) {
    var n = normEmoji(name);
    if (!n) return null;
    return { name: n, label: EMOJI[n].label, svg: EMOJI[n].svg };
  }
  function emojiNames() { return EMOJI_ORDER.slice(); }
  function emojiSVG(name) {
    var i = emojiInfo(name);
    if (!i) return null;
    return '<svg class="vfx2-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' + i.svg + '</svg>';
  }

  /* ==========================================================================
   * v4 — ANTI-SOLAPE: un grande por bando + hueco entre bandos + cola FIFO
   * ------------------------------------------------------------------------
   * Reglas:
   *  1) Máx. 1 emoji GRANDE por bando a la vez (ya venía de v3, se conserva).
   *  2) Si los dos bandos apuntan al mismo punto (choque), el segundo se
   *     desplaza a un hueco libre, con preferencia hacia SU lado; si no cabe,
   *     espera en cola.
   *  3) Cola FIFO por bando (máx. 4) con caducidad: un emoji que espera más de
   *     `COLA_MS` se descarta (no tiene sentido enseñarlo tarde).
   *  4) Si el activo ya lleva `CAMBIO_MS` y hay cola, se retira antes para
   *     rotar: el directo sigue viéndose vivo sin apilar emojis.
   *  5) Los pequeños (número de daño, etiqueta, reacción/corona, 💥 del
   *     impacto) se apartan de la caja del grande en vez de taparse.
   * ======================================================================== */

  var activeInv = { rojo: null, azul: null };
  var activeBig = { rojo: null, azul: null };
  var cola = { rojo: [], azul: [] };
  var busy = { rojo: false, azul: false };
  var rotando = { rojo: false, azul: false };
  var draining = { rojo: false, azul: false };
  var LEGACY = false;          // QA: true = comportamiento v3 (sin anti-solape)
  var COLA_MAX = 4;
  var COLA_MS = 2200;          // caducidad de un emoji en cola
  var CAMBIO_MS = 1500;        // antigüedad mínima del activo para rotar
  var MARGEN = 10;             // px de aire entre cajas

  function nowMs() {
    try { return (global.performance && global.performance.now) ? global.performance.now() : Date.now(); }
    catch (e) { return Date.now(); }
  }

  function overlapBox(a, b, m) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + m &&
      Math.abs(a.y - b.y) < (a.h + b.h) / 2 + m;
  }

  /* Límites de la zona segura para la pila etiqueta+emoji+burbuja. */
  function safeLim(size, bubbleMax, hasText) {
    var halfW = Math.max(size * 0.52, bubbleMax * 0.5) + 10;
    var halfH = (size + (hasText ? 200 : 150)) / 2;
    var xa = VIEW.w > 80 ? (halfW / VIEW.w) * 100 : 9;
    var yb = VIEW.h > 80 ? (halfH / VIEW.h) * 100 : 20;
    yb = Math.max(yb, isNarrow() ? 22 : 14);
    return { xa: xa, yb: yb };
  }

  function clampPct(x, y, lim) {
    var nx = lim.xa >= 50 ? 50 : clamp(x, lim.xa, 100 - lim.xa);
    var ny = lim.yb >= 50 ? 50 : clamp(y, lim.yb, 100 - lim.yb);
    return { x: nx, y: ny };
  }

  function bigBox(xPct, yPct, size, bubbleMax, hasText) {
    var w = Math.max(size * 1.04, Math.min(bubbleMax, 380), 190);
    var h = size + (hasText ? 200 : 120);
    var sp = stagePoint(punto(xPct, yPct));
    return { x: sp.x, y: sp.y, w: w, h: h };
  }

  function overlapsOther(box, side) {
    var other = side === 'rojo' ? 'azul' : 'rojo';
    var b = activeBig[other];
    if (!b || !b.el || !b.el.parentNode) return false;
    return overlapBox(box, b, MARGEN);
  }

  /* Busca hueco para el grande del bando `side`. Devuelve {x,y,ok}. */
  function freeSpot(xPct, yPct, size, bubbleMax, hasText, side, lim) {
    var dir = side === 'rojo' ? -1 : 1;
    var cands = [
      [0, 0], [dir * 16, 0], [dir * 16, -13], [dir * 16, 13],
      [dir * 30, 0], [dir * 30, -13], [dir * 30, 13],
      [dir * 10, -22], [dir * 10, 22], [dir * 42, 0],
      [0, -26], [0, 26], [dir * 22, -26], [dir * 22, 26]
    ];
    for (var i = 0; i < cands.length; i++) {
      var c = clampPct(xPct + cands[i][0], yPct + cands[i][1], lim);
      var box = bigBox(c.x, c.y, size, bubbleMax, hasText);
      if (!overlapsOther(box, side)) return { x: c.x, y: c.y, ok: true };
    }
    return { x: xPct, y: yPct, ok: false };
  }

  /* Aparta un efecto pequeño de la caja de cualquier emoji grande.
     Devuelve el punto (en %) ya libre, o el mismo si no hacía falta. */
  function avoidBigs(xPct, yPct, w, h, gap) {
    if (!stage || LEGACY) return { x: xPct, y: yPct, moved: false };
    var p = punto(xPct, yPct);
    var sp = stagePoint(p);
    var box = { x: sp.x, y: sp.y, w: Math.max(24, w), h: Math.max(24, h) };
    var g = gap != null ? gap : 8;
    var moved = false;
    var sides = ['rojo', 'azul'];
    for (var k = 0; k < 4; k++) {
      var hit = null;
      for (var i = 0; i < sides.length; i++) {
        var b = activeBig[sides[i]];
        if (!b || !b.el || !b.el.parentNode) continue;
        if (overlapBox(box, b, g)) { hit = b; break; }
      }
      if (!hit) break;
      var needX = (hit.w + box.w) / 2 + g + 2 - Math.abs(box.x - hit.x);
      var dir = box.x <= hit.x ? -1 : 1;
      if (box.x + dir * needX - box.w / 2 >= 2 &&
        box.x + dir * needX + box.w / 2 <= VIEW.w - 2) {
        box.x += dir * needX;
      } else {
        var needY = (hit.h + box.h) / 2 + g + 2 - Math.abs(box.y - hit.y);
        box.y += (box.y <= hit.y ? -1 : 1) * needY;
      }
      moved = true;
    }
    box.x = clamp(box.x, box.w / 2 + 2, Math.max(box.w / 2 + 2, VIEW.w - box.w / 2 - 2));
    box.y = clamp(box.y, box.h / 2 + 2, Math.max(box.h / 2 + 2, VIEW.h - box.h / 2 - 2));
    var sr, r;
    try {
      sr = stage.getBoundingClientRect();
      r = mapRect();
    } catch (e) { return { x: xPct, y: yPct, moved: false }; }
    var vx = sr.left + box.x, vy = sr.top + box.y;
    return {
      x: ((vx - r.left) / r.width) * 100,
      y: ((vy - r.top) / r.height) * 100,
      moved: moved
    };
  }

  /* --- cola FIFO por bando --- */

  function soltar(side, el) {
    if (activeInv[side] === el) activeInv[side] = null;
    if (activeBig[side] && activeBig[side].el === el) activeBig[side] = null;
    drain(side);
  }

  function retirar(side, el) {
    if (!el) return;
    try { if (el.__stop) { el.__stop(); el.__stop = null; } } catch (e) { /* nada */ }
    try { el.classList.add('vfx2-out'); } catch (e) { /* nada */ }
    soltar(side, el);
    later(function () { removeEl(el); }, 360);
  }

  function drain(side) {
    if (busy[side] || draining[side]) return;
    draining[side] = true;
    try {
      var q = cola[side];
      while (q.length) {
        var it = q.shift();
        if (it.exp < nowMs()) continue;   // caducado: no se enseña tarde
        try { it.fn(); } catch (e) { /* nada */ }
        return;
      }
    } finally {
      draining[side] = false;
    }
  }

  function encolar(side, fn, prio, expMs) {
    var q = cola[side];
    if (q.length >= COLA_MAX) q.shift();
    q.push({
      fn: fn,
      prio: prio,
      exp: nowMs() + clamp(num(expMs, COLA_MS), 400, 8000)
    });
    if (rotando[side]) return;
    var act = activeInv[side];
    if (!act) { drain(side); return; }
    rotando[side] = true;
    var age = activeBig[side] ? nowMs() - activeBig[side].t0 : 0;
    later(function () {
      rotando[side] = false;
      if (!cola[side].length) return;
      var a = activeInv[side];
      if (a) retirar(side, a);       // retirar -> soltar -> drain
    }, Math.max(80, CAMBIO_MS - age));
  }

  /* Estado para QA y para la demo (cajas activas + cola). */
  function stageState() {
    var out = {
      version: VERSION, apiVersion: 4, legacy: LEGACY,
      activos: { rojo: !!activeInv.rojo, azul: !!activeInv.azul },
      cola: { rojo: cola.rojo.length, azul: cola.azul.length },
      cajas: [], solapes: 0,
      /* QA: canvas de partículas (FPS y modo lite se miden con esto) */
      canvas: !!ctx, particulas: P.length, dibujos: drawCount,
      rAF: rafId, watch: watchId, msSinRaf: Math.round(nowMs() - lastRafT),
      view: { w: Math.round(VIEW.w), h: Math.round(VIEW.h) }, dpr: DPR,
      /* QA: primera partícula viva (para diagnosticar generadores) */
      muestra: P.length ? {
        type: P[0].type || 'dot', x: Math.round(P[0].x), y: Math.round(P[0].y),
        size: Math.round((P[0].size || 0) * 10) / 10, color: P[0].color || null,
        life: Math.round(P[0].life || 0), ttl: P[0].ttl || 0,
        alpha: P[0].alpha, blend: P[0].blend || null
      } : null
    };
    var sides = ['rojo', 'azul'];
    for (var i = 0; i < sides.length; i++) {
      var b = activeBig[sides[i]];
      if (!b) continue;
      out.cajas.push({
        side: sides[i], x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.w), h: Math.round(b.h),
        emoji: (b.el && b.el.getAttribute && b.el.getAttribute('data-emoji')) || null
      });
    }
    if (out.cajas.length === 2) {
      out.solapes = overlapBox(out.cajas[0], out.cajas[1], 2) ? 1 : 0;
    }
    return out;
  }


  function normEmotion(e) {
    var s = String(e || '').toLowerCase();
    return EM[s] ? s : 'furia';
  }

  function normSide(s) {
    return String(s || '').toLowerCase() === 'azul' ? 'azul' : 'rojo';
  }

  function isNarrow() { return (global.innerWidth || 1280) < 720; }

  /* Tamaño por defecto v3: 280-420 px escritorio / 180-240 px móvil. */
  function defaultSize() {
    var w = global.innerWidth || 1280;
    if (w < 720) return clamp(w * 0.52, 180, 240);
    return clamp(w * 0.245, 280, 420);
  }

  /* Color flexible: admite '#rrggbb', 'rojo', 'azul', 'oro'. */
  function normColor(c) {
    var s = String(c == null ? '' : c).trim().toLowerCase();
    if (s === 'rojo' || s === 'red') return '#ff4d4d';
    if (s === 'azul' || s === 'blue') return '#38bdf8';
    if (s === 'oro' || s === 'gold' || s === 'amarillo') return '#ffd36b';
    return c ? String(c) : '#ffd36b';
  }

  function hexGlow(c) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return 'rgba(255,211,107,.85)';
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' +
      parseInt(h.slice(4, 6), 16) + ',.85)';
  }

  /* Texto de la burbuja: una línea lógica, máx. 190 chars (2 líneas por CSS). */
  function bubbleText(t) {
    var s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    if (s.length > 190) s = s.slice(0, 187).replace(/[\s,;:.!¡?¿]+$/, '') + '\u2026';
    return s;
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

  /* Onda de aterrizaje del emoji que entra volando: anillos + chispas. */
  function landingWave(el, sp, size, color) {
    if (!el || !el.parentNode || el.classList.contains('vfx2-out')) return;
    var i, ring;
    if (!lite) {
      for (i = 0; i < 2; i++) {
        ring = make('div', 'vfx2-ring');
        ring.style.setProperty('--s', Math.round(size * (1.45 + i * 0.72)) + 'px');
        ring.style.setProperty('--bw', (6 - i * 2) + 'px');
        ring.style.setProperty('--c', i === 0 ? '#ffffff' : color);
        ring.style.setProperty('--d', (0.6 + i * 0.16).toFixed(2) + 's');
        ring.style.setProperty('--delay', (i * 0.06).toFixed(2) + 's');
        if (el.firstChild) el.insertBefore(ring, el.firstChild);
        else el.appendChild(ring);
      }
    }
    burstSparks(sp.x, sp.y + size * 0.3, color, lite ? 6 : 20, 0.5);
    if (!lite) shake(0.32, { duration: 420 });
  }

  /* Ecos del emoji (burla): copias que salen hacia los lados y se desvanecen. */
  function echoes(el, emoji, size, color) {
    if (!el || lite) return;
    var offs = [[-1, -0.35], [1, -0.2], [-0.7, 0.45]];
    for (var i = 0; i < offs.length; i++) {
      var e = make('div', 'vfx2-echo');
      setEmojiContent(e, emoji);
      e.style.fontSize = Math.round(size * (0.72 - i * 0.06)) + 'px';
      e.style.color = color;
      e.style.setProperty('--ex', (offs[i][0] * size * 0.62).toFixed(0) + 'px');
      e.style.setProperty('--ey', (offs[i][1] * size * 0.62).toFixed(0) + 'px');
      e.style.animationDelay = (i * 0.13).toFixed(2) + 's';
      el.appendChild(e);
    }
  }

  /* Gotas azules cayendo por toda la pantalla (llanto). */
  function blueDrops(count) {
    if (!ctx || !stage) return;
    var n = Math.round(count * (lite ? 0.35 : 1));
    for (var i = 0; i < n; i++) {
      var ttl = rnd(800, 1600);
      addP({
        type: 'tear', x: rnd(-20, VIEW.w + 20), y: rnd(-VIEW.h * 0.1, VIEW.h * 0.5),
        vx: rnd(-18, 18), vy: rnd(140, 380),
        g: 640, drag: 0.999, size: rnd(5, 11),
        rot: 0, vr: rnd(-1.4, 1.4),
        color: pick(['#7dd3fc', '#38bdf8', '#bae6fd', '#0ea5e9']),
        life: ttl, ttl: ttl, alpha: rnd(0.65, 1)
      });
    }
  }

  /* Desaturación breve de pantalla (pánico).
     Se pinta DENTRO del escenario y por debajo de los emojis (z-index 0 vs 6) para que
     desature el mapa y no la cara del emoji, que debe seguir leyéndose. */
  function desat(ms) {
    if (!ensureReady() || lite) return null;
    var host = dom || screen;
    if (!host) return null;
    var d = clamp(num(ms, 700), 120, 4000);
    var el = make('div', 'vfx2-desat');
    el.style.setProperty('--d', d + 'ms');
    if (host === dom) host.insertBefore(el, host.firstChild); else host.appendChild(el);
    later(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* nada */ } }, d + 80);
    return el;
  }

  /* Arcoíris de fondo (euforia). Se pinta en el HOST del mapa, justo DEBAJO del escenario
     (z-index 55 < 60), así el blend screen tiñe el mapa y no la cara ni la etiqueta del emoji. */
  function rainbowSweep(ms) {
    if (!ensureReady() || lite) return null;
    var host = (stage && stage.parentNode) || dom || screen;
    if (!host) return null;
    var d = clamp(num(ms, 1000), 200, 5000);
    var el = make('div', 'vfx2-rainbow');
    el.style.setProperty('--d', d + 'ms');
    if (stage && stage.parentNode === host) host.insertBefore(el, stage);
    else host.appendChild(el);
    later(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* nada */ } }, d + 80);
    return el;
  }

  /* Efectos de pantalla propios de cada emoción (además del emoji). */
  function screenFx(emotion, side, sp, size, emoji, el) {
    if (lite) {
      /* En lite/reduced-motion no hay animaciones: viñeta (transición de opacidad
         aplicada inline) en vez de flash, que depende de @keyframes. */
      if (emotion === 'furia') vignette(0.4, { color: 'rgba(255,24,24,.9)', duration: 1200 });
      return;
    }
    if (emotion === 'furia') {
      vignette(0.62, { color: 'rgba(255,24,24,.92)', duration: 1600 });
      shake(0.62, { duration: 780 });
      flash('#ff2d2d', { opacity: 0.08, duration: 260 });
    } else if (emotion === 'panico') {
      shake(0.52, { duration: 900 });
      desat(1600);
      glitchBits(sp.x, sp.y - size * 0.3, 14);
    } else if (emotion === 'llanto') {
      blueDrops(30);
      tears(sp.x, sp.y + size * 0.15, 16);
      vignette(0.3, { color: 'rgba(30,90,220,.85)', duration: 1400 });
    } else if (emotion === 'euforia') {
      confettiRain(side === 'azul' ? 'azul' : 'rojo', 120);
      rainbowSweep(1800);
      stars(sp.x, sp.y - size * 0.45, 22);
    } else if (emotion === 'burla') {
      echoes(el, emoji, size, EM[emotion].c);
    }
  }

  function invader(emoji, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;

    var emotion = normEmotion(o.emotion);
    var side = normSide(o.side);
    var meta = EM[emotion];
    var dur = clamp(num(o.duration, 3200), 900, 15000);
    var size = clamp(num(o.size, defaultSize()), 140, 560);
    var prio = clamp(num(o.prio, (emotion === 'euforia' ? 2 : 1)), 0, 3);

    /* v4: anti-solape. Si el bando ya tiene un grande reciente, este emoji
       espera en cola (con caducidad) en vez de apilarse encima. */
    if (!LEGACY && !o.force && activeInv[side]) {
      var big = activeBig[side];
      var age = big ? nowMs() - big.t0 : 0;
      var actPrio = big ? big.prio : 1;
      if (prio <= actPrio && age < CAMBIO_MS) {
        encolar(side, function () {
          mostrarInvader(emoji, o, side, emotion, meta, dur, size, prio);
        }, prio, o.queueMs);
        return null;
      }
    }
    return mostrarInvader(emoji, o, side, emotion, meta, dur, size, prio);
  }

  /* Pinta el invasor ya colocado. Separado de invader() para poder encolarlo. */
  function mostrarInvader(emoji, o, side, emotion, meta, dur, size, prio) {
    if (!ensureReady()) return null;
    busy[side] = true;
    try {
      var narrow = isNarrow();
      var hasText = !!bubbleText(o.text);

      /* v3: x/y = % del escenario donde aparece el emoji.
         Sin x/y -> mismo sitio que la v2 (38 % rojo / 62 % azul, 44 % vertical). */
      var hasX = o.x != null && isFinite(Number(o.x));
      var hasY = o.y != null && isFinite(Number(o.y));
      var xPct = hasX ? num(o.x, 50) : (narrow ? 50 : (side === 'azul' ? 62 : 38));
      var yPct = hasY ? num(o.y, 44) : (narrow ? 46 : 44);
      var bubbleMax = narrow
        ? Math.min(VIEW.w * 0.72, 300)
        : Math.min(size * 2.6, 380, Math.max(120, VIEW.w * 0.9));
      /* La pila (etiqueta + emoji + burbuja) tiene que caber entera en el escenario. */
      var lim = safeLim(size, bubbleMax, hasText);
      var base = clampPct(xPct, yPct, lim);
      /* v4: si el otro bando ya tiene un grande encima, se desplaza a un hueco
         libre (preferencia hacia su propio lado). Si no cabe, se encola. */
      var spot = (LEGACY || o.force)
        ? { x: base.x, y: base.y, ok: true }
        : freeSpot(base.x, base.y, size, bubbleMax, hasText, side, lim);
      if (!spot.ok) {
        var tries = (o.__tries || 0) + 1;
        if (tries <= 3) {
          var o2 = {};
          for (var kk in o) o2[kk] = o[kk];
          o2.__tries = tries;
          later(function () {
            encolar(side, function () {
              mostrarInvader(emoji, o2, side, emotion, meta, dur, size, prio);
            }, prio, o2.queueMs);
          }, 160 + tries * 170);
          return null;
        }
        /* Sin hueco tras varios intentos: se coloca igual (mejor un solape leve que perder el emoji). */
        spot = { x: base.x, y: base.y, ok: true };
      }
      var p = punto(spot.x, spot.y);
      var sp = stagePoint(p);

      var el = make('div', 'vfx2-inv vfx2-inv-' + emotion);
      el.style.left = sp.x + 'px';
      el.style.top = sp.y + 'px';
      el.style.setProperty('--size', size + 'px');
      el.style.setProperty('--c', meta.c);
      el.style.setProperty('--glow', meta.glow);
      /* borde de la burbuja = color del bando (rojo/azul), no el de la emoción */
      el.style.setProperty('--sc', side === 'azul' ? '#38bdf8' : '#ff4d4d');

      /* v3: entrada volando desde un lado (overshoot + onda de aterrizaje). */
      var from = (o.from === 'rojo' || o.from === 'azul') ? o.from : null;
      if (from) el.classList.add('vfx2-inv-from-' + from);

      var center = make('div', 'vfx2-inv-center');
      var enter = make('div', 'vfx2-inv-enter');
      var body = make('div', 'vfx2-inv-body');
      var face = make('div', 'vfx2-inv-face');
      var glow = make('div', 'vfx2-inv-glow');
      var tag = make('div', 'vfx2-inv-tag');
      tag.textContent = meta.tag;
      var em = make('div', 'vfx2-inv-emoji');
      /* v4: emoji propio por nombre; Unicode de siempre traducido; si no, texto. */
      var emoVal = (emoji != null && String(emoji).trim()) ? emoji : meta.emoji;
      var emoName = setEmojiContent(em, emoVal);
      if (emoName) el.setAttribute('data-emoji', emoName);

      // Glow + emoji en el mismo wrapper: el halo queda SIEMPRE centrado detrás de la cara.
      face.appendChild(glow);
      face.appendChild(em);
      body.appendChild(tag);
      body.appendChild(face);
      var txt = bubbleText(o.text);
      if (txt) {
        var say = make('div', 'vfx2-inv-say');
        var bubble = make('div', 'vfx2-inv-text');
        bubble.textContent = txt;
        bubble.style.maxWidth = Math.round(bubbleMax) + 'px';
        say.appendChild(bubble);
        body.appendChild(say);
      }
      enter.appendChild(body);
      center.appendChild(enter);
      el.appendChild(center);
      dom.appendChild(el);
      track(el);

      /* v3/v4: un emoji por bando. Si ya había uno, se retira rápido y se suelta
         su caja para que la cola pueda entrar. */
      var prev = activeInv[side];
      if (prev && prev !== el) retirar(side, prev);
      activeInv[side] = el;

      // Ráfaga inicial + emisor continuo de partículas de la emoción.
      emitFor(emotion, sp, size);
      emitFor(emotion, sp, size);
      if (emotion === 'euforia') confettiRain(side, 46);
      el.__stop = startEmitter(emotion, sp, size);

      // v3: efectos de pantalla de la emoción (viñeta, shake, desaturación, gotas...).
      screenFx(emotion, side, sp, size, emoVal, el);

      // Onda de aterrizaje si entra volando desde un lado.
      if (from) later(function () { landingWave(el, sp, size, meta.c); }, 620);

      /* v4: caja real (ya pintada) para que los pequeños y el otro bando la esquiven. */
      var bw = 0, bh = 0;
      try { bw = body.offsetWidth || 0; bh = body.offsetHeight || 0; } catch (e) { /* nada */ }
      activeBig[side] = {
        x: sp.x, y: sp.y,
        w: Math.max(bw || size * 1.05, 180),
        h: Math.max(bh || size + 120, 150),
        el: el, t0: nowMs(), prio: prio
      };

      later(function () { el.classList.add('vfx2-out'); }, Math.max(160, dur - 360));
      later(function () {
        removeEl(el);
        soltar(side, el);          // limpia caja y da paso a la cola
      }, dur);
      return el;
    } finally {
      busy[side] = false;
    }
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
    setEmojiContent(boom, o.emoji || (power >= 0.5 ? '\uD83D\uDCA5' : '\u2728'));
    boom.style.setProperty('--fs', Math.round(56 + power * 64) + 'px');
    /* v4: el 💥 del impacto no se pinta encima del emoji grande: se aparta. */
    var av = avoidBigs(xPct, yPct, 160 + power * 90, 160 + power * 90, 6);
    if (av.moved) {
      var bsp = stagePoint(punto(av.x, av.y));
      boom.style.left = (bsp.x - sp.x) + 'px';
      boom.style.top = (bsp.y - sp.y) + 'px';
    }
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

    /* v4: el número de daño se aparta de la caja del emoji grande. */
    var av = avoidBigs(xPct, yPct, 230, 150, 6);
    var p = punto(av.x, av.y);
    var sp = stagePoint(p);
    var azul = normSide(side) === 'azul';
    var narrow = isNarrow();
    var el = make('div', 'vfx2-dmg ' + (azul ? 'vfx2-dmg-a' : 'vfx2-dmg-r'));
    var prefix = o.prefix != null ? String(o.prefix) : '\u2212';
    el.textContent = prefix + fmtNum(v);
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    var mag = clamp(Math.log(Math.max(1, Math.abs(v))) / Math.LN10 / 2.6, 0, 1);
    /* v3: 90-110 px en escritorio (68-86 en móvil para no desbordar 390 px). */
    var base = narrow ? 68 + mag * 18 : 90 + mag * 20;
    el.style.setProperty('--fs', Math.round(clamp(num(o.size, base), 28, 170)) + 'px');
    el.style.setProperty('--arc', ((azul ? -1 : 1) * rnd(14, 34)).toFixed(0) + 'px');
    dom.appendChild(el);
    track(el);

    burstSparks(sp.x, sp.y, azul ? '#7dd3fc' : '#fca5a5', Math.round(18 + mag * 14), 0.55);
    stars(sp.x, sp.y, 7, azul ? '#bae6fd' : '#fecaca');
    if (!lite) shake(0.26 + mag * 0.3, { duration: 560 });
    later(function () { removeEl(el); }, 2050);
    return el;
  }

  /* ==========================================================================
   * v3 — Etiqueta grande de acción (¡BOMBA ATÓMICA!, ¡TROPAS!, ¡ATAQUE!...)
   * ======================================================================== */

  function label(text, xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var txt = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!txt) return null;

    var narrow = isNarrow();
    var w = global.innerWidth || 1440;
    var fs = num(o.size, 0);
    if (!fs) fs = narrow ? clamp(w * 0.105, 30, 48) : clamp(w * 0.062, 46, 96);
    fs = clamp(fs, 20, 150);

    var color = normColor(o.color);
    var ms = clamp(num(o.ms, 1700), 300, 6000);
    var kick = clamp(num(o.kick, 1), 0, 1);

    /* No tapar el HUD: la etiqueta vive dentro de la zona segura del escenario. */
    var x = clamp(num(xPct, 50), 10, 90);
    var y = clamp(num(yPct, 44), narrow ? 20 : 15, narrow ? 84 : 87);
    /* v4: si cae sobre un emoji grande, se aparta (medida estimada de la caja). */
    var estW = Math.min((stage && stage.clientWidth || 1440) * (narrow ? 0.9 : 0.5),
      Math.max(160, txt.length * fs * 0.62));
    var av = avoidBigs(x, y, estW, fs * 1.5, 6);
    x = av.x; y = av.y;
    var p = punto(x, y);
    var sp = stagePoint(p);

    var el = make('div', 'vfx2-label');
    el.textContent = txt.toUpperCase();
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    el.style.setProperty('--fs', Math.round(fs) + 'px');
    el.style.setProperty('--stroke', Math.max(4, Math.round(fs * 0.085)) + 'px');
    el.style.setProperty('--c', color);
    el.style.setProperty('--glow', hexGlow(color));
    el.style.setProperty('--kick', String(kick));
    el.style.setProperty('--d', ms + 'ms');
    dom.appendChild(el);
    track(el);

    /* Auto-ajuste: una etiqueta larga a tamaño grande se salía del mapa y se
       cortaba por los dos lados. Se mide ya pintada y, si no cabe, se reduce
       la fuente; después se recoloca en horizontal para que no se corte.
       El ancho máximo por defecto es la franja central (los paneles laterales
       se comen ~1/4 del ancho cada uno); se puede forzar con opts.maxW. */
    try {
      var stW = (stage && stage.clientWidth) || global.innerWidth || 1440;
      var margen = 12;
      var tope = num(o.maxW, 0);
      var maxW = tope > 0 ? tope : stW * (narrow ? 0.90 : 0.50);
      maxW = Math.max(140, Math.min(maxW, stW - margen * 2));
      var ancho = el.offsetWidth || 0;
      if (ancho > maxW) {
        fs = Math.max(18, Math.floor(fs * maxW / ancho));
        el.style.setProperty('--fs', Math.round(fs) + 'px');
        el.style.setProperty('--stroke', Math.max(3, Math.round(fs * 0.085)) + 'px');
        ancho = el.offsetWidth || 0;
      }
      if (ancho > 0 && stW > 0) {
        var medio = ancho / 2;
        var minX = margen + medio, maxX = stW - margen - medio;
        if (maxX >= minX) {
          var nx = Math.min(Math.max(sp.x, minX), maxX);
          if (nx !== sp.x) el.style.left = Math.round(nx) + 'px';
        }
      }
    } catch (e) { /* si no se puede medir, se queda como estaba */ }

    later(function () { removeEl(el); }, ms + 120);
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
   * v4 — EFECTOS NUEVOS (activables desde el feed)
   *   shockwave(xPct,yPct,{power,color})       onda expansiva con polvo
   *   quake(intensity,{duration,x,y})          grietas + sacudida (terremoto)
   *   ashfall({duration,density,side})         lluvia de ceniza + penumbra
   *   cameraFlash({color,opacity,duration})    flash de cámara con obturador
   *   victory(side,{emoji,text,x,y})           confeti + trofeo + flash + viñeta
   *   emojiAt(nombre,xPct,yPct,{size,duration}) emoji suelto con anti-solape
   * ======================================================================== */

  function shockwave(xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var power = clamp(num(o.power, 0.8), 0, 1);
    var color = normColor(o.color || (power >= 0.7 ? '#ffb02e' : '#ffe08a'));
    var p = punto(xPct, yPct);
    var sp = stagePoint(p);
    var base = 120 + power * 340;

    var root = make('div', 'vfx2-sw');
    root.style.left = sp.x + 'px';
    root.style.top = sp.y + 'px';
    dom.appendChild(root);
    track(root);

    var i;
    for (i = 0; i < 3; i++) {
      var ring = make('div', 'vfx2-sw-ring');
      ring.style.setProperty('--s', Math.round(base * (1 + i * 0.42)) + 'px');
      ring.style.setProperty('--bw', (12 - i * 3) + 'px');
      ring.style.setProperty('--c', i === 1 ? '#ffffff' : color);
      ring.style.setProperty('--d', (0.95 + i * 0.18).toFixed(2) + 's');
      ring.style.setProperty('--delay', (i * 0.06).toFixed(2) + 's');
      root.appendChild(ring);
    }
    var fill = make('div', 'vfx2-sw-ring vfx2-sw-fill');
    fill.style.setProperty('--s', Math.round(base * 1.1) + 'px');
    fill.style.setProperty('--c', color);
    fill.style.setProperty('--d', '0.75s');
    root.appendChild(fill);

    burstSparks(sp.x, sp.y, color, Math.round(30 + power * 40), power);
    burstDebris(sp.x, sp.y, Math.round(18 + power * 26), power, debrisColors(color));
    /* Polvo que se abre en círculo (la firma visual de la onda). */
    var dust = Math.round(14 + power * 18);
    for (i = 0; i < dust; i++) {
      var ang = (Math.PI * 2 * i) / dust + rnd(-0.22, 0.22);
      var v = rnd(140, 420) * (0.6 + power * 0.6);
      var dttl = rnd(500, 900);
      addP({
        type: 'dot', x: sp.x, y: sp.y,
        vx: Math.cos(ang) * v, vy: Math.sin(ang) * v * 0.7,
        g: 60, drag: 2.4, size: rnd(2, 5), color: color,
        ttl: dttl, life: dttl, alpha: 0.55, blend: 'lighter'
      });
    }
    if (power >= 0.45) shake(0.3 + power * 0.5, { duration: 480 });
    later(function () { removeEl(root); }, 1600);
    return root;
  }

  /* Grietas procedurales en viewBox 1000x1000 (se estiran al escenario). */
  function crackSVG(cx, cy, n) {
    var out = '';
    var i, k;
    for (i = 0; i < n; i++) {
      var ang = (Math.PI * 2 * i) / n + rnd(-0.4, 0.4);
      var x = cx, y = cy;
      var d = 'M' + x.toFixed(1) + ' ' + y.toFixed(1);
      var steps = Math.round(rnd(4, 8));
      for (k = 0; k < steps; k++) {
        ang += rnd(-0.55, 0.55);
        x += Math.cos(ang) * rnd(38, 92);
        y += Math.sin(ang) * rnd(38, 92);
        d += ' L' + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      out += '<path class="vfx2-crack-glow" d="' + d + '" pathLength="100" style="--len:100;--delay:' +
        (i * 0.045).toFixed(2) + 's"/>';
      out += '<path d="' + d + '" pathLength="100" style="--len:100;--delay:' +
        (i * 0.045).toFixed(2) + 's"/>';
      /* Una rama corta por grieta: se ve más orgánico. */
      var bx = x, by = y, ba = ang + rnd(0.7, 1.5) * (i % 2 ? 1 : -1);
      var bd = 'M' + bx.toFixed(1) + ' ' + by.toFixed(1);
      for (k = 0; k < 3; k++) {
        ba += rnd(-0.4, 0.4);
        bx += Math.cos(ba) * rnd(20, 52);
        by += Math.sin(ba) * rnd(20, 52);
        bd += ' L' + bx.toFixed(1) + ' ' + by.toFixed(1);
      }
      out += '<path d="' + bd + '" pathLength="100" style="--len:100;--delay:' +
        (0.1 + i * 0.045).toFixed(2) + 's"/>';
    }
    return out;
  }

  function quake(intensity, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var mag = clamp(num(intensity, 0.7), 0, 1);
    var dur = clamp(num(o.duration, 2400), 600, 8000);
    var cx = clamp(num(o.x, 50), 2, 98);
    var cy = clamp(num(o.y, 50), 2, 98);

    var el = make('div', 'vfx2-quake');
    el.style.setProperty('--d', dur + 'ms');
    el.innerHTML = '<svg viewBox="0 0 1000 1000" preserveAspectRatio="none">' +
      crackSVG(500, 500, Math.round(4 + mag * 4)) + '</svg>';
    dom.appendChild(el);
    track(el);

    var i;
    for (i = 0; i < Math.round(20 + mag * 40); i++) {
      var q = punto(clamp(cx + rnd(-20, 20), 2, 98), clamp(cy + rnd(-14, 14), 2, 98));
      var qs = stagePoint(q);
      burstDebris(qs.x, qs.y, 1, 0.15 + mag * 0.5, debrisColors('#8a6b4a'));
    }
    shake(0.25 + mag * 0.85, { duration: Math.min(dur, 1200) });
    if (!lite) vignette(0.16 + mag * 0.22, { color: '#3a2a18', duration: dur });
    later(function () { removeEl(el); }, dur + 200);
    return el;
  }

  function ashfall(opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var dur = clamp(num(o.duration, 5200), 800, 15000);
    var dens = clamp(num(o.density, 0.5), 0, 1);
    var side = (o.side === 'rojo' || o.side === 'azul') ? o.side : null;

    var el = make('div', 'vfx2-ash');
    el.style.setProperty('--d', dur + 'ms');
    dom.appendChild(el);
    track(el);

    var porTanda = Math.round(7 + dens * 17);
    var cada = Math.max(30, 110 - dens * 80);
    var id = every(function () {
      for (var i = 0; i < porTanda; i++) {
        var x = side === 'rojo' ? rnd(-50, VIEW.w * 0.6)
          : side === 'azul' ? rnd(VIEW.w * 0.4, VIEW.w + 50)
            : rnd(-20, VIEW.w + 20);
        var ttl = rnd(3000, 6000);
        addP({
          type: 'dot', x: x, y: rnd(-70, -8),
          vx: rnd(-22, 22), vy: rnd(60, 180),
          g: 10, drag: 0.995, sway: rnd(14, 44), phase: rnd(0, 6.283),
          size: rnd(2.6, 6.4), color: pick(['#cfd3d8', '#b3b8be', '#9aa0a6', '#e6e8ea', '#8b9096']),
          ttl: ttl, life: ttl, alpha: rnd(0.5, 0.9)
        });
      }
    }, cada);
    later(function () { stopEvery(id); }, dur);
    later(function () { removeEl(el); }, dur + 160);
    if (!lite) vignette(0.12, { color: '#20222a', duration: dur });
    return el;
  }

  function cameraFlash(opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var color = normColor(o.color || '#ffffff');
    var dur = clamp(num(o.duration, 620), 200, 2400);

    var el = make('div', 'vfx2-cam');
    el.style.setProperty('--c', color);
    el.style.setProperty('--d', dur + 'ms');
    el.style.setProperty('--o', clamp(num(o.opacity, 0.85), 0, 1).toFixed(2));
    el.appendChild(make('div', 'vfx2-cam-flash'));
    if (!lite) {
      el.appendChild(make('div', 'vfx2-cam-bar vfx2-cam-top'));
      el.appendChild(make('div', 'vfx2-cam-bar vfx2-cam-bot'));
      el.appendChild(make('div', 'vfx2-cam-iris'));
    }
    screen.appendChild(el);
    track(el);
    later(function () { removeEl(el); }, dur + 200);
    return el;
  }

  function victory(side, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var s = normSide(side);
    var x = clamp(num(o.x, s === 'rojo' ? 34 : 66), 12, 88);
    var y = clamp(num(o.y, 40), 16, 84);

    confetti(s, { count: clamp(num(o.count, 260), 40, 420) });
    cameraFlash({ color: '#fff7d6', opacity: 0.55, duration: 640 });
    flash('#ffd45e', { opacity: 0.14, duration: 700 });

    var el = make('div', 'vfx2-vic');
    dom.appendChild(el);
    track(el);
    later(function () { removeEl(el); }, 3000);

    later(function () {
      invader(o.emoji || 'trofeo', {
        side: s, emotion: 'euforia', x: x, y: y,
        size: clamp(num(o.size, defaultSize() * 0.92), 140, 420),
        duration: 3400, text: o.text || '', from: s, prio: 3, force: true
      });
    }, 150);
    later(function () { shockwave(x, y, { power: 0.9, color: '#ffd45e' }); }, 850);
    return el;
  }

  function emojiAt(emoji, xPct, yPct, opts) {
    var o = opts || {};
    if (!ensureReady()) return null;
    var sz = clamp(num(o.size, 84), 24, 300);
    var dur = clamp(num(o.duration, 1600), 400, 6000);
    var av = avoidBigs(xPct, yPct, sz * 1.3, sz * 1.3, 8);
    var p = punto(av.x, av.y);
    var sp = stagePoint(p);
    var el = make('div', 'vfx2-react');
    setEmojiContent(el, emoji || '\u2728');
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    el.style.fontSize = sz + 'px';
    dom.appendChild(el);
    track(el);
    later(function () { removeEl(el); }, dur);
    return el;
  }

  /* QA: legacy(true) reproduce el comportamiento v3 (sin anti-solape). */
  function legacy(v) {
    LEGACY = !!v;
    return LEGACY;
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
    var sz = clamp(num(o.size, 46), 18, 140);
    var av = avoidBigs(xPct, yPct, sz * 1.7, sz * 1.7, 6);
    var p = punto(av.x, av.y);
    var sp = stagePoint(p);
    var el = make('div', 'vfx2-react');
    setEmojiContent(el, emoji || '\u2728');
    el.style.left = sp.x + 'px';
    el.style.top = sp.y + 'px';
    el.style.fontSize = sz + 'px';
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
    setEmojiContent(el, emoji || '\uD83D\uDCA5');
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
    watchId = 0;
    rafId = 0;
    lastT = 0;
    lastRafT = 0;
    activeInv.rojo = null;
    activeInv.azul = null;
    activeBig.rojo = null;
    activeBig.azul = null;
    cola.rojo.length = 0;
    cola.azul.length = 0;
    busy.rojo = false;
    busy.azul = false;
    rotando.rojo = false;
    rotando.azul = false;
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
    /* v4: marcas de compatibilidad para consumidores que miran la versión. */
    apiVersion: 4,
    esV2: true,
    esV3: true,
    esV4: true,

    init: init,
    invader: invader,
    impact: impact,
    damage: damage,
    label: label,
    sparks: sparks,
    shake: shake,
    flash: flash,
    vignette: vignette,
    confetti: confetti,
    clear: clear,

    /* v4: emojis propios + anti-solape + efectos nuevos */
    emojiAt: emojiAt,
    emojiNames: emojiNames,
    emojiInfo: emojiInfo,
    emojiSVG: emojiSVG,
    legacy: legacy,
    stageState: stageState,
    shockwave: shockwave,
    quake: quake,
    ashfall: ashfall,
    cameraFlash: cameraFlash,
    victory: victory,

    /* compat v1 */
    spawnImpact: spawnImpact,
    spawnDamage: spawnDamage,
    spawnReaction: spawnReaction,
    flyEmoji: flyEmoji,
    tremblePanel: tremblePanel,
    focus: focus,
    setMap: setMap,
    setMotion: setMotion,
    getMapEl: mapHost,
    /* QA: fuerza un repintado del canvas (diagnóstico de partículas) */
    forzarDibujo: function () { if (ctx) drawP(); return drawCount; },
    /* QA: simula un frame completo (paso + pintado) y devuelve los ms que cuesta */
    forzarFrame: function (dt) {
      if (!ctx) return null;
      var t0 = nowMs();
      stepP(clamp(dt || 0.016, 0.001, 0.05));
      drawP();
      return Math.round((nowMs() - t0) * 100) / 100;
    },
    /* QA: coste medio/máximo del frame simulado (no depende del rAF del navegador) */
    bench: function (n) {
      if (!ctx) return null;
      n = clamp(num(n, 30), 3, 300);
      var i, t, tot = 0, max = 0, vals = [];
      for (i = 0; i < n; i++) {
        t = nowMs();
        stepP(0.016);
        drawP();
        t = nowMs() - t;
        vals.push(t); tot += t;
        if (t > max) max = t;
      }
      vals.sort(function (a, b) { return a - b; });
      return {
        n: n, mediaMs: Math.round((tot / n) * 100) / 100,
        p95Ms: Math.round(vals[Math.min(n - 1, Math.floor(n * 0.95))] * 100) / 100,
        maxMs: Math.round(max * 100) / 100, particulas: P.length,
        view: { w: Math.round(VIEW.w), h: Math.round(VIEW.h) }, dpr: DPR
      };
    }
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
