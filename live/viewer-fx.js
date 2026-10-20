/*!
 * viewer-fx.js — capa de efectos de espectáculo + chat en vivo para el visor
 * de "WorldBox AI Show".
 *
 * SIN dependencias, SIN build, SIN imports. Se puede cargar con una etiqueta
 * <script src="viewer-fx.js"><\/script> (incluso abriendo el HTML con file://)
 * o pegando este fichero entero dentro de un <script> en el HTML: no contiene
 * la secuencia de cierre de etiqueta (escrita aquí como <\/script>) ni imports.
 * Inyecta sus propios estilos en una única etiqueta <style id="vfx-css">.
 *
 * API pública: window.ViewerFX
 * ---------------------------------------------------------------------------
 *   ViewerFX.init({ map: '#stream', chat: '#chat-host' });   // opcional
 *
 *   // Reacción flotante sobre el mapa (xPct/yPct: 0..100 del mapa visible)
 *   ViewerFX.spawnReaction('🔥', 52, 41);
 *
 *   // Impacto / explosión. power: 0..1 (si pasas el conteo crudo de /stats,
 *   // que es > 1, se normaliza dividiendo entre 600)
 *   ViewerFX.spawnImpact(62.5, 31.2, 0.8);
 *
 *   // Emoji gigante que sale del chat, cruza el visor y estalla en el mapa
 *   ViewerFX.flyEmoji('💥', { to: { xPct: 62.5, yPct: 31.2 }, power: 0.9 });
 *
 *   // Chat: mensajes nuevos abajo, autoscroll, sin etiqueta "a todos"
 *   ViewerFX.pushChat({ name: 'ROJO', emoji: '😤', text: 'Te borro del mapa',
 *                       color: '#ff5d5d', para: 'azul' });
 *
 *   // Combate
 *   ViewerFX.spawnDamage(1240, 60, 45, 'rojo');   // número de daño flotante
 *   ViewerFX.flash('#ff5d5d');                   // flash a pantalla completa
 *   ViewerFX.vignette(0.6);                      // viñeta roja (0 = quitar)
 *   ViewerFX.shake(0.8);                         // sacudida de pantalla
 *   ViewerFX.tremblePanel('azul');               // tiembla el panel golpeado
 *
 *   // Cámara cinematográfica opcional (el Lead decide cuándo llamarla)
 *   ViewerFX.focus('#stream', 62.5, 31.2, 1.8, 1400);
 * ---------------------------------------------------------------------------
 * Coordenadas: xPct/yPct son porcentaje 0..100 del CONTENIDO VISIBLE del
 * elemento mapa. Se tiene en cuenta object-fit: contain / cover (usa
 * naturalWidth/naturalHeight de <img>/<video> y width/height de <canvas>),
 * así que los centroides del stream (cx/cy de /stats, normalizados x10000)
 * se pasan tal cual: xPct = cx/100, yPct = cy/100.
 *
 * Todo es tolerante: si el mapa o el contenedor de chat aún no existen, las
 * funciones no lanzan y el chat se monta en un panel flotante por defecto.
 * No escribe nada en la consola.
 */
(function (global) {
  'use strict';

  if (global.ViewerFX && global.ViewerFX.__vfx) return; // idempotente

  var VERSION = '1.0.0';
  var doc = global.document;
  if (!doc) return;

  /* ======================================================================
   * Utilidades
   * ==================================================================== */

  function num(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  function clamp(n, a, b) {
    return n < a ? a : (n > b ? b : n);
  }

  function rnd(a, b) {
    return a + Math.random() * (b - a);
  }

  function now() {
    return (global.performance && global.performance.now)
      ? global.performance.now()
      : Date.now();
  }

  function makeEl(cls, tag) {
    var el = doc.createElement(tag || 'div');
    if (cls) el.className = cls;
    return el;
  }

  function resolveEl(v) {
    if (!v) return null;
    if (typeof v === 'string') {
      try { return doc.querySelector(v); } catch (e) { return null; }
    }
    if (v.nodeType === 1) return v;
    if (v.el && v.el.nodeType === 1) return v.el;
    return null;
  }

  function centerOf(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function shorten(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function timeStr() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtNum(n) {
    try { return Math.round(n).toLocaleString('es-ES'); } catch (e) { return String(Math.round(n)); }
  }

  function toRgba(c, a) {
    c = String(c == null ? '' : c).trim();
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (!m) return c; // ya es rgba()/hsl()/nombre
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' +
      parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  var reducedMQ = null;
  try {
    reducedMQ = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
  } catch (e) { reducedMQ = null; }

  function reduced() {
    return !!(reducedMQ && reducedMQ.matches);
  }

  /* Permite forzar el drama aunque el sistema tenga "reducir movimiento":
     'auto' respeta el sistema, 'full' fuerza animaciones, 'reduced' las evita. */
  function motionAllows() {
    if (CFG.motion === 'full') return true;
    if (CFG.motion === 'reduced') return false;
    return !reduced();
  }

  /* ======================================================================
   * Configuración
   * ==================================================================== */

  var CFG = {
    map: null,          // selector o elemento del mapa
    chat: null,         // selector o elemento contenedor del chat
    z: 58,              // z-index de la capa de efectos (victoria suele ir a 60)
    maxEffects: 44,     // nodos máximos en la capa (recorte de seguridad)
    maxChatLines: 140,  // líneas máximas en el chat
    autoFly: true,      // volar emoji automáticamente al recibir un emoji suelto
    motion: 'auto'      // 'auto' | 'full' | 'reduced' (ver motionAllows)
  };

  var styleEl = null;
  var overlay = null;

  /* ======================================================================
   * Estilos (una única etiqueta <style id="vfx-css">)
   * ==================================================================== */

  var CSS = [
    /* ---------- capa de efectos ---------- */
    '.vfx-layer{position:fixed;inset:0;z-index:58;pointer-events:none;overflow:hidden;contain:layout style paint}',

    /* reacción flotante */
    '.vfx-reaction{position:absolute;transform:translate(-50%,-50%);line-height:1;user-select:none;will-change:transform,opacity;',
    'filter:drop-shadow(0 6px 16px rgba(0,0,0,.55));animation:vfxSubir 1.6s cubic-bezier(.2,.8,.2,1) forwards}',
    '@keyframes vfxSubir{0%{opacity:0;transform:translate(-50%,-50%) translateY(12px) scale(.5) rotate(0deg)}',
    '15%{opacity:1;transform:translate(-50%,-50%) translateY(-2px) scale(1.12) rotate(var(--vfx-rot,0deg))}',
    '62%{opacity:.95;transform:translate(-50%,-50%) translateY(-42px) scale(1) rotate(var(--vfx-rot,0deg))}',
    '100%{opacity:0;transform:translate(-50%,-50%) translateY(-80px) scale(.88) rotate(var(--vfx-rot,0deg))}}',

    /* impacto: destello, anillos, chispas, boom, retícula */
    '.vfx-flash{position:absolute;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;mix-blend-mode:screen;',
    'background:radial-gradient(circle,#fff 0%,var(--vfx-c,#ffd36b) 28%,rgba(255,150,60,.45) 55%,rgba(255,120,40,.12) 70%,transparent 76%);',
    'animation:vfxFlash .58s cubic-bezier(.2,.8,.3,1) forwards}',
    '@keyframes vfxFlash{0%{opacity:0;transform:translate(-50%,-50%) scale(.2)}14%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) scale(1.6)}}',

    '.vfx-ring{position:absolute;border-radius:50%;transform:translate(-50%,-50%);border:3px solid var(--vfx-c,#ffd36b);',
    'box-shadow:0 0 30px var(--vfx-c,#ffd36b),inset 0 0 22px rgba(255,255,255,.45);',
    'animation:vfxRing .66s cubic-bezier(.15,.7,.3,1) forwards}',
    '@keyframes vfxRing{0%{opacity:.95;transform:translate(-50%,-50%) scale(.16)}100%{opacity:0;transform:translate(-50%,-50%) scale(1)}}',

    '.vfx-spark{position:absolute;width:7px;height:7px;border-radius:50%;transform:translate(-50%,-50%);',
    'background:radial-gradient(circle,#fff 0%,var(--vfx-c,#ffcf6b) 52%,transparent 72%);',
    'animation:vfxSpark .72s cubic-bezier(.15,.7,.35,1) forwards}',
    '@keyframes vfxSpark{0%{opacity:1;transform:translate(-50%,-50%) translate(0,0) scale(1.25)}',
    '100%{opacity:0;transform:translate(-50%,-50%) translate(var(--vfx-dx,0px),var(--vfx-dy,0px)) scale(.3)}}',

    '.vfx-boom{position:absolute;transform:translate(-50%,-50%);line-height:1;user-select:none;will-change:transform,opacity;',
    'filter:drop-shadow(0 10px 28px rgba(0,0,0,.6));animation:vfxBoom .82s cubic-bezier(.2,.9,.25,1) forwards}',
    '@keyframes vfxBoom{0%{opacity:0;transform:translate(-50%,-50%) scale(.18) rotate(-20deg)}',
    '20%{opacity:1;transform:translate(-50%,-50%) scale(1.2) rotate(7deg)}',
    '46%{opacity:1;transform:translate(-50%,-50%) scale(1) rotate(0deg)}',
    '100%{opacity:0;transform:translate(-50%,-50%) scale(1.55) rotate(10deg)}}',

    '.vfx-reticle{position:absolute;transform:translate(-50%,-50%);border-radius:50%;border:2px solid var(--vfx-c,#ffd36b);',
    'box-shadow:0 0 18px var(--vfx-c,#ffd36b),inset 0 0 12px rgba(255,255,255,.35);animation:vfxRet .95s ease-out forwards}',
    '.vfx-reticle::before,.vfx-reticle::after{content:"";position:absolute;left:50%;top:50%;background:var(--vfx-c,#ffd36b);',
    'transform:translate(-50%,-50%);border-radius:2px;box-shadow:0 0 8px var(--vfx-c,#ffd36b)}',
    '.vfx-reticle::before{width:130%;height:2px}',
    '.vfx-reticle::after{width:2px;height:130%}',
    '@keyframes vfxRet{0%{opacity:0;transform:translate(-50%,-50%) scale(1.7)}16%{opacity:1;transform:translate(-50%,-50%) scale(.86)}',
    '72%{opacity:.9;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.2)}}',

    /* números de daño */
    '.vfx-dmg{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;user-select:none;will-change:transform,opacity;',
    'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-weight:900;letter-spacing:-.02em;',
    'color:#fff;text-shadow:0 3px 18px rgba(0,0,0,.85),0 0 3px rgba(0,0,0,.7);animation:vfxDmg 1.3s cubic-bezier(.15,.85,.3,1) forwards}',
    '@keyframes vfxDmg{0%{opacity:0;transform:translate(-50%,-50%) translateY(16px) scale(.55)}',
    '16%{opacity:1;transform:translate(-50%,-50%) translateY(0) scale(1.22)}',
    '54%{opacity:1;transform:translate(-50%,-50%) translateY(-34px) scale(1)}',
    '100%{opacity:0;transform:translate(-50%,-50%) translateY(-82px) scale(.94)}}',
    '.vfx-dmg-r{color:#ff9a9a;text-shadow:0 3px 18px rgba(0,0,0,.85),0 0 18px rgba(255,60,60,.75)}',
    '.vfx-dmg-a{color:#a9c8ff;text-shadow:0 3px 18px rgba(0,0,0,.85),0 0 18px rgba(70,130,255,.75)}',

    /* flash a pantalla completa */
    '.vfx-flashfull{position:fixed;inset:0;pointer-events:none;z-index:62;background:var(--vfx-c,#fff);opacity:0;',
    'animation:vfxFull .44s ease-out forwards}',
    '@keyframes vfxFull{0%{opacity:.4}100%{opacity:0}}',

    /* viñeta */
    '.vfx-vignette{position:fixed;inset:0;pointer-events:none;z-index:44;opacity:0;transition:opacity .55s ease;',
    'background:radial-gradient(ellipse at 50% 50%,transparent 40%,var(--vfx-vig,rgba(255,40,40,.30)) 72%,var(--vfx-vig2,rgba(190,10,20,.62)) 100%)}',

    /* sacudidas */
    '.vfx-shake{animation:vfxShake .46s cubic-bezier(.36,.07,.19,.97)}',
    '.vfx-shake-hard{animation:vfxShakeHard .56s cubic-bezier(.36,.07,.19,.97)}',
    '@keyframes vfxShake{0%,100%{transform:translate(0,0)}14%{transform:translate(-5px,3px)}30%{transform:translate(4px,-4px)}',
    '46%{transform:translate(-3px,-2px)}62%{transform:translate(3px,3px)}80%{transform:translate(-2px,1px)}}',
    '@keyframes vfxShakeHard{0%,100%{transform:translate(0,0) rotate(0deg)}10%{transform:translate(-13px,8px) rotate(-.4deg)}',
    '24%{transform:translate(12px,-10px) rotate(.4deg)}38%{transform:translate(-10px,-7px) rotate(-.3deg)}',
    '54%{transform:translate(9px,8px) rotate(.3deg)}70%{transform:translate(-6px,4px) rotate(-.15deg)}86%{transform:translate(3px,-2px)}}',
    '.vfx-temblor{animation:vfxTemblor .52s cubic-bezier(.36,.07,.19,.97)}',
    '@keyframes vfxTemblor{0%,100%{transform:translate(0,0)}20%{transform:translate(-7px,3px)}40%{transform:translate(6px,-4px)}',
    '60%{transform:translate(-5px,2px)}80%{transform:translate(3px,-1px)}}',

    /* emoji volador */
    '.vfx-fly{position:fixed;z-index:72;pointer-events:none;user-select:none;line-height:1;will-change:transform,opacity;',
    'filter:drop-shadow(0 12px 26px rgba(0,0,0,.55)) drop-shadow(0 0 26px rgba(255,190,90,.35))}',

    /* ---------- chat ---------- */
    '.vfx-chat{--vfx-rojo:#ff5d5d;--vfx-azul:#4d8dff;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;',
    'font-family:inherit;color:#eaeff7;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.015)),rgba(6,9,15,.86);',
    'border:1px solid rgba(255,255,255,.09);border-radius:18px;overflow:hidden;',
    'box-shadow:0 24px 60px -30px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.06);',
    'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}',
    '.vfx-chat-flotante{position:fixed;left:16px;bottom:16px;z-index:57;width:min(360px,calc(100vw - 32px));height:min(46vh,430px);pointer-events:auto}',
    '.vfx-chat.min .vfx-chat-body{display:none}',
    '.vfx-chat.min{height:auto!important;min-height:0}',
    '.vfx-chat-h{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.08);',
    'background:linear-gradient(180deg,rgba(255,255,255,.045),transparent);flex:0 0 auto}',
    '.vfx-chat-dot{width:7px;height:7px;border-radius:50%;background:#ff5d5d;box-shadow:0 0 10px #ff5d5d;',
    'animation:vfxPulso 1.4s ease-in-out infinite;flex:0 0 auto}',
    '@keyframes vfxPulso{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}',
    '.vfx-chat-t{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#8792a6;font-weight:700}',
    '.vfx-chat-n{margin-left:auto;font-size:9.5px;color:#5d687b;font-variant-numeric:tabular-nums}',
    '.vfx-chat-b{width:24px;height:24px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.1);',
    'background:rgba(255,255,255,.04);color:#8792a6;border-radius:8px;font-size:13px;line-height:1;cursor:pointer;padding:0;flex:0 0 auto}',
    '.vfx-chat-b:hover{color:#eaeff7;border-color:rgba(255,255,255,.22)}',
    '.vfx-chat-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 10px 12px;',
    'display:flex;flex-direction:column;gap:7px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}',
    '.vfx-chat-body::-webkit-scrollbar{width:8px}',
    '.vfx-chat-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px}',
    '.vfx-chat-body::-webkit-scrollbar-track{background:transparent}',
    '.vfx-chat-nuevos{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:none;',
    'padding:5px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(10,14,22,.94);',
    'color:#eaeff7;font:600 10.5px/1 inherit;cursor:pointer;z-index:3;box-shadow:0 8px 20px -8px rgba(0,0,0,.8)}',
    '.vfx-chat-nuevos.on{display:block}',
    '.vfx-line{display:flex;gap:8px;align-items:flex-start;animation:vfxLineIn .34s cubic-bezier(.2,.8,.2,1)}',
    '.vfx-line.vfx-instant{animation:none}',
    '@keyframes vfxLineIn{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}',
    '.vfx-av{width:26px;height:26px;border-radius:9px;flex:0 0 auto;display:grid;place-items:center;font-size:11px;font-weight:800;',
    'color:#fff;background:linear-gradient(140deg,var(--vfx-c,#6b7789),rgba(255,255,255,.22));box-shadow:0 4px 12px -4px rgba(0,0,0,.65)}',
    '.vfx-bub{min-width:0;max-width:calc(100% - 36px);background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);',
    'border-radius:13px;border-top-left-radius:5px;padding:6px 10px}',
    '.vfx-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
    '.vfx-name{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--vfx-c,#8792a6)}',
    '.vfx-to{font-size:8.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--vfx-c,#8792a6);border:1px solid currentColor;',
    'border-radius:999px;padding:0 5px;opacity:.85;white-space:nowrap;line-height:1.5}',
    '.vfx-time{font-size:9px;color:#5d687b;font-variant-numeric:tabular-nums;margin-left:auto}',
    '.vfx-tx{font-size:12.5px;line-height:1.42;overflow-wrap:anywhere}',
    '.vfx-quote{display:block;font-size:10.5px;color:#8792a6;border-left:2px solid var(--vfx-c,#6b7789);padding-left:6px;',
    'margin-bottom:3px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
    '.vfx-line.vfx-emoji-only .vfx-bub{background:none;border:0;padding:0}',
    '.vfx-line.vfx-emoji-only .vfx-tx{font-size:40px;line-height:1.05;filter:drop-shadow(0 8px 16px rgba(0,0,0,.5));',
    'animation:vfxEmojiVivo 1.7s ease-in-out infinite}',
    '@keyframes vfxEmojiVivo{0%,100%{transform:scale(1) rotate(0deg)}50%{transform:scale(1.1) rotate(-3deg)}}',
    '.vfx-line.vfx-sys{opacity:.92}',
    '.vfx-line.vfx-sys .vfx-bub{background:rgba(255,255,255,.03)}',
    '.vfx-line.vfx-t-golpe .vfx-bub{border-color:rgba(255,93,93,.55);background:rgba(255,93,93,.10);',
    'animation:vfxLineGolpe .5s cubic-bezier(.2,.8,.2,1)}',
    '@keyframes vfxLineGolpe{0%{transform:translateX(0)}25%{transform:translateX(-5px)}50%{transform:translateX(4px)}75%{transform:translateX(-2px)}100%{transform:translateX(0)}}',
    '.vfx-line.vfx-t-burla .vfx-bub{border-color:rgba(255,93,93,.32)}',
    '.vfx-line.vfx-t-nervios .vfx-bub{border-color:rgba(255,190,90,.5);animation:vfxLineNervios .55s ease-in-out 3}',
    '@keyframes vfxLineNervios{0%,100%{transform:translateX(0)}30%{transform:translateX(-2px)}70%{transform:translateX(2px)}}',
    '.vfx-line.vfx-t-llanto .vfx-bub{border-color:rgba(77,141,255,.45);background:rgba(77,141,255,.10)}',
    '.vfx-line.vfx-fuerte .vfx-bub{box-shadow:0 0 0 1px rgba(255,255,255,.04),0 8px 24px -14px rgba(0,0,0,.85)}',

    /* tema claro del visor (body.light) */
    'body.light .vfx-chat{background:linear-gradient(180deg,rgba(255,255,255,.94),rgba(255,255,255,.87));',
    'border-color:rgba(16,24,40,.12);color:#101828;box-shadow:0 20px 50px -30px rgba(16,24,40,.45),inset 0 1px 0 #fff}',
    'body.light .vfx-chat-t,body.light .vfx-chat-n,body.light .vfx-time{color:#5b6779}',
    'body.light .vfx-chat-b{color:#5b6779;border-color:rgba(16,24,40,.12);background:rgba(16,24,40,.04)}',
    'body.light .vfx-bub{background:rgba(16,24,40,.035);border-color:rgba(16,24,40,.10)}',
    'body.light .vfx-chat-nuevos{background:#fff;border-color:rgba(16,24,40,.14);color:#101828}',
    'body.light .vfx-quote{color:#5b6779}',

    /* responsive */
    '@media (max-width:1100px){.vfx-chat-flotante{left:10px;right:10px;width:auto;height:min(42vh,360px)}}',
    '@media (max-width:640px){.vfx-chat-flotante{left:8px;right:8px;bottom:8px;height:min(38vh,310px);border-radius:16px}',
    '.vfx-chat-t{font-size:9px;letter-spacing:.13em}.vfx-tx{font-size:12px}.vfx-line.vfx-emoji-only .vfx-tx{font-size:34px}',

    /* accesibilidad: menos movimiento */
    '@media (prefers-reduced-motion:reduce){.vfx-line,.vfx-line.vfx-emoji-only .vfx-tx{animation:none}',
    '.vfx-reaction,.vfx-boom,.vfx-flash,.vfx-ring,.vfx-spark,.vfx-reticle,.vfx-dmg,.vfx-flashfull{animation-duration:.22s!important}',
    '.vfx-shake,.vfx-shake-hard,.vfx-temblor{animation-duration:.22s!important}}'
  ].join('');

  function ensureStyles() {
    if (styleEl && styleEl.parentNode) return styleEl;
    var prev = doc.getElementById('vfx-css');
    if (prev) { styleEl = prev; return styleEl; }
    if (!doc.head && !doc.documentElement) return null;
    styleEl = doc.createElement('style');
    styleEl.id = 'vfx-css';
    styleEl.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(styleEl);
    return styleEl;
  }

  /* ======================================================================
   * Mapa: localización, object-fit y conversión de porcentajes
   * ==================================================================== */

  function getMap() {
    var el = resolveEl(CFG.map);
    if (el) return el;
    var qs = ['[data-vfx-map]', '.mapa #stream', '.mapa #frame', '#stream', '#frame',
      '.mapa video', '.mapa img:not(#fondo)', '.mapa canvas', '.mapa', '#centro'];
    for (var i = 0; i < qs.length; i++) {
      try {
        el = doc.querySelector(qs[i]);
        if (el) return el;
      } catch (e) { /* selector no soportado: seguir */ }
    }
    return null;
  }

  /* Busca el hijo "media" visible que representa el mapa dentro de un contenedor
     (ignora fondos difuminados o capas decorativas). */
  function mediaChild(el) {
    var list;
    try { list = el.querySelectorAll('img, video, canvas'); } catch (e) { return null; }
    var er = el.getBoundingClientRect();
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
      // Contenedor: usar el hijo media visible (p.ej. .mapa > canvas#frame).
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
    if (fit !== 'contain' && fit !== 'cover') return out; // fill / none / scale-down ≈ caja

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

  function mapRect() {
    var el = getMap();
    if (el) {
      var r = contentRect(el);
      if (r && r.width >= 8 && r.height >= 8) return r;
    }
    // Fallback tolerante: zona central del viewport.
    var w = global.innerWidth || 1280;
    var h = global.innerHeight || 720;
    return { left: w * 0.10, top: h * 0.10, width: w * 0.80, height: h * 0.72, el: null };
  }

  function punto(xPct, yPct) {
    var r = mapRect();
    var x = clamp(num(xPct, 50), -25, 125);
    var y = clamp(num(yPct, 50), -25, 125);
    return {
      x: r.left + (x / 100) * r.width,
      y: r.top + (y / 100) * r.height,
      pctX: x,
      pctY: y,
      rect: r
    };
  }

  function pctFromPoint(x, y) {
    var r = mapRect();
    return {
      xPct: r.width ? ((x - r.left) / r.width) * 100 : 50,
      yPct: r.height ? ((y - r.top) / r.height) * 100 : 50
    };
  }

  /* ======================================================================
   * Capa de efectos
   * ==================================================================== */

  function ensureOverlay() {
    if (overlay && overlay.parentNode) return overlay;
    if (!doc.body) return null;
    var prev = doc.getElementById('vfx-layer');
    if (prev) {
      overlay = prev;
    } else {
      overlay = makeEl('vfx-layer');
      overlay.id = 'vfx-layer';
      overlay.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(overlay);
    }
    overlay.style.zIndex = String(CFG.z);
    return overlay;
  }

  function trimOverlay() {
    if (!overlay) return;
    var max = Math.max(8, num(CFG.maxEffects, 44));
    while (overlay.children.length > max) overlay.removeChild(overlay.firstElementChild);
  }

  function autoRemove(el, ms) {
    setTimeout(function () {
      try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* nada */ }
    }, Math.max(80, num(ms, 1200)));
  }

  function normPower(p) {
    var n = Number(p);
    if (!isFinite(n)) return 0.6;
    if (n > 1) n = n / 600; // conteo crudo de píxeles del detector (/stats)
    return clamp(n, 0.12, 1);
  }

  /* ---------- reacción flotante ---------- */

  function spawnReaction(emoji, xPct, yPct, opts) {
    if (!ensureReady() || !overlay) return null;
    var o = opts || {};
    var p = punto(xPct, yPct);
    var el = makeEl('vfx-reaction');
    el.textContent = String(emoji == null ? '✨' : emoji).slice(0, 12);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.fontSize = clamp(num(o.size, 30 + Math.random() * 16), 16, 110) + 'px';
    el.style.setProperty('--vfx-rot', rnd(-14, 14).toFixed(1) + 'deg');
    var dur = clamp(num(o.duration, 1500 + rnd(-180, 420)), 650, 12000);
    el.style.animationDuration = Math.round(dur) + 'ms';
    if (o.delay) el.style.animationDelay = Math.round(num(o.delay, 0)) + 'ms';
    if (o.color) el.style.filter = 'drop-shadow(0 0 16px ' + o.color + ') drop-shadow(0 6px 14px rgba(0,0,0,.5))';
    overlay.appendChild(el);
    trimOverlay();
    autoRemove(el, dur + 900 + num(o.delay, 0));
    return el;
  }

  /* ---------- impacto / explosión ---------- */

  function addFlash(x, y, size, color) {
    var f = makeEl('vfx-flash');
    f.style.left = x + 'px';
    f.style.top = y + 'px';
    f.style.width = f.style.height = Math.max(40, size) + 'px';
    if (color) f.style.setProperty('--vfx-c', color);
    overlay.appendChild(f);
    autoRemove(f, 1000);
  }

  function addRing(x, y, size, color, dur, delay) {
    var r = makeEl('vfx-ring');
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    r.style.width = r.style.height = Math.max(24, size) + 'px';
    if (color) {
      r.style.borderColor = color;
      r.style.setProperty('--vfx-c', color);
    }
    r.style.animationDuration = num(dur, 0.66) + 's';
    if (delay) r.style.animationDelay = Math.round(num(delay, 0)) + 'ms';
    overlay.appendChild(r);
    autoRemove(r, num(dur, 0.66) * 1000 + 700 + num(delay, 0));
  }

  function spawnImpact(xPct, yPct, power, opts) {
    if (!ensureReady() || !overlay) return null;
    var o = opts || {};
    var p = punto(xPct, yPct);
    var pw = normPower(power);
    var color = o.color || (pw >= 0.62 ? '#ff8a3d' : '#ffd36b');
    var r0 = 34 + pw * 150;

    addFlash(p.x, p.y, r0 * 2.1, color);
    addRing(p.x, p.y, r0, color, 0.66, 0);
    addRing(p.x, p.y, r0 * 0.7, '#ffffff', 0.5, 55);

    var n = Math.round(9 + pw * 16);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var d = r0 * (0.55 + Math.random() * 0.95);
      var sp = makeEl('vfx-spark');
      sp.style.left = p.x + 'px';
      sp.style.top = p.y + 'px';
      sp.style.setProperty('--vfx-dx', (Math.cos(a) * d).toFixed(1) + 'px');
      sp.style.setProperty('--vfx-dy', (Math.sin(a) * d).toFixed(1) + 'px');
      sp.style.setProperty('--vfx-c', color);
      sp.style.animationDelay = Math.round(Math.random() * 45) + 'ms';
      var sz = 4 + Math.random() * (5 + pw * 5);
      sp.style.width = sp.style.height = sz.toFixed(1) + 'px';
      overlay.appendChild(sp);
      autoRemove(sp, 1200);
    }

    var em = o.emoji || (pw >= 0.5 ? '💥' : '✨');
    var b = makeEl('vfx-boom');
    b.textContent = em;
    b.style.left = p.x + 'px';
    b.style.top = p.y + 'px';
    b.style.fontSize = Math.round(30 + pw * 54) + 'px';
    overlay.appendChild(b);
    autoRemove(b, 1400);

    if (pw >= 0.28 && o.reticle !== false) {
      var rt = makeEl('vfx-reticle');
      var rs = Math.round(52 + pw * 46);
      rt.style.left = p.x + 'px';
      rt.style.top = p.y + 'px';
      rt.style.width = rt.style.height = rs + 'px';
      rt.style.setProperty('--vfx-c', color);
      overlay.appendChild(rt);
      autoRemove(rt, 1500);
    }

    trimOverlay();
    return null;
  }

  /* ---------- números de daño ---------- */

  function spawnDamage(n, xPct, yPct, side, opts) {
    if (!ensureReady() || !overlay) return null;
    var val = Number(n);
    if (!isFinite(val) || val === 0) return null;
    var o = opts || {};
    var p = punto(xPct, yPct);
    var el = makeEl('vfx-dmg');
    var prefix = o.prefix != null ? String(o.prefix) : '−';
    el.textContent = prefix + fmtNum(Math.abs(val));
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    if (side === 'rojo') el.classList.add('vfx-dmg-r');
    else if (side === 'azul') el.classList.add('vfx-dmg-a');
    var mag = clamp(Math.log(Math.max(1, Math.abs(val))) / Math.LN10 / 2.2, 0, 1);
    el.style.fontSize = Math.round(num(o.size, 24 + mag * 32)) + 'px';
    if (o.delay) el.style.animationDelay = Math.round(num(o.delay, 0)) + 'ms';
    overlay.appendChild(el);
    trimOverlay();
    autoRemove(el, 1700 + num(o.delay, 0));
    return el;
  }

  /* ---------- flash de pantalla completa ---------- */

  function flash(color, opts) {
    if (!ensureReady() || !doc.body) return null;
    var o = opts || {};
    var f = makeEl('vfx-flashfull');
    f.style.setProperty('--vfx-c', color || '#ffffff');
    if (o.z != null) f.style.zIndex = String(o.z);
    doc.body.appendChild(f);
    autoRemove(f, 800);
    return f;
  }

  /* ---------- viñeta (alguien va perdiendo) ---------- */

  function vignette(level, opts) {
    if (!ensureReady() || !doc.body) return null;
    var o = opts || {};
    var v = doc.getElementById('vfx-vignette');
    if (!v) {
      v = makeEl('vfx-vignette');
      v.id = 'vfx-vignette';
      v.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(v);
    }
    if (o.color) {
      v.style.setProperty('--vfx-vig', toRgba(o.color, 0.30));
      v.style.setProperty('--vfx-vig2', toRgba(o.color, 0.62));
    }
    var lv = clamp(num(level, 0), 0, 1);
    v.style.opacity = String(lv <= 0.01 ? 0 : lv);
    return v;
  }

  /* ---------- sacudidas ---------- */

  var shakeTimer = null;
  var shakeEl = null;

  function shake(strength, opts) {
    if (!ensureReady()) return null;
    var o = opts || {};
    var s = clamp(num(strength, 0.5), 0, 1);
    var target = resolveEl(o.target) || doc.getElementById('app') || doc.querySelector('#centro') || doc.body;
    if (!target) return null;
    var hard = s >= 0.62;
    var cls = hard ? 'vfx-shake-hard' : 'vfx-shake';
    if (shakeEl && shakeEl !== target) {
      shakeEl.classList.remove('vfx-shake', 'vfx-shake-hard');
    }
    shakeEl = target;
    target.classList.remove('vfx-shake', 'vfx-shake-hard');
    void target.offsetWidth; // reinicia la animación
    target.classList.add(cls);
    if (shakeTimer) clearTimeout(shakeTimer);
    shakeTimer = setTimeout(function () {
      try { target.classList.remove('vfx-shake', 'vfx-shake-hard'); } catch (e) { /* nada */ }
    }, hard ? 620 : 520);
    return target;
  }

  var temblorTimers = typeof WeakMap === 'function' ? new WeakMap() : null;

  function tremblePanel(side, opts) {
    if (!ensureReady()) return null;
    var o = opts || {};
    var s = String(side || '').toLowerCase();
    var el = resolveEl(o.el) ||
      (s ? doc.getElementById(s) : null) ||
      (s ? doc.querySelector('[data-lado="' + s + '"]') : null) ||
      (s ? doc.querySelector('.panel-' + s) : null) ||
      (s ? doc.querySelector('aside.' + s) : null);
    if (!el) return null;
    el.classList.remove('vfx-temblor');
    void el.offsetWidth;
    el.classList.add('vfx-temblor');
    var old = temblorTimers ? temblorTimers.get(el) : null;
    if (old) clearTimeout(old);
    var t = setTimeout(function () { try { el.classList.remove('vfx-temblor'); } catch (e) { /* nada */ } }, 600);
    if (temblorTimers) temblorTimers.set(el, t);
    return el;
  }

  /* ---------- zoom cinematográfico (opcional, lo llama el Lead) ---------- */

  var focusTimer = null;
  var focusAnim = null;
  var focusPrev = null;

  function focusCleanup() {
    if (focusPrev && focusPrev.parent) {
      try { focusPrev.parent.style.overflow = focusPrev.overflow; } catch (e) { /* nada */ }
    }
    focusPrev = null;
  }

  function stopFocusAnim() {
    if (focusAnim) {
      try { focusAnim.cancel(); } catch (e) { /* nada */ }
      focusAnim = null;
    }
    focusCleanup();
  }

  function focus(el, xPct, yPct, zoom, ms) {
    if (!ensureReady()) return null;
    var cont = resolveEl(el) || getMap();
    if (!cont) return null;
    // Si nos pasan el contenedor del mapa, se escala su media (img/canvas) para
    // que el recorte del contenedor evite que el zoom se salga del visor.
    var t = mediaChild(cont) || cont;
    var z = clamp(num(zoom, 1.6), 1, 4);
    var dur = clamp(num(ms, 1100), 150, 20000);
    var er = t.getBoundingClientRect();
    if (!er.width || !er.height) return null;
    var r = contentRect(t);
    var lx = (r.left - er.left) + (clamp(num(xPct, 50), 0, 100) / 100) * r.width;
    var ly = (r.top - er.top) + (clamp(num(yPct, 50), 0, 100) / 100) * r.height;
    var tx = (1 - z) * (lx - er.width / 2);
    var ty = (1 - z) * (ly - er.height / 2);
    var to = 'translate(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px) scale(' + z.toFixed(3) + ')';
    var st = t.style;
    var ease = 'cubic-bezier(.22,.8,.24,1)';
    var inRatio = 0.3;
    var outStart = 0.72;

    stopFocusAnim();
    if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
    st.transformOrigin = '50% 50%';
    st.willChange = 'transform';

    // Recorta el contenedor mientras dura el zoom para que el escalado no rompa el layout.
    var par = t.parentElement;
    if (par && par !== doc.body && par !== doc.documentElement) {
      focusPrev = { parent: par, overflow: par.style.overflow };
      try { par.style.overflow = 'hidden'; } catch (e) { focusPrev = null; }
    }

    // Sin WAAPI o con movimiento reducido: se aplica el encuadre y se retira.
    if (!t.animate || !motionAllows()) {
      st.transform = to;
      focusTimer = setTimeout(function () {
        try { st.transform = ''; st.willChange = ''; } catch (e) { /* nada */ }
        focusCleanup();
      }, Math.max(140, dur));
      return t;
    }

    try {
      var a = t.animate([
        { transform: 'none', offset: 0, easing: ease },
        { transform: to, offset: inRatio },
        { transform: to, offset: outStart, easing: 'ease-in' },
        { transform: 'none', offset: 1 }
      ], { duration: dur, fill: 'forwards' });
      focusAnim = a;
      a.onfinish = function () {
        try { a.cancel(); } catch (e) { /* nada */ }
        if (focusAnim === a) focusAnim = null;
        try { st.willChange = ''; } catch (e) { /* nada */ }
        focusCleanup();
      };
    } catch (e) {
      st.transform = to;
      focusTimer = setTimeout(function () {
        try { st.transform = ''; st.willChange = ''; } catch (e2) { /* nada */ }
        focusCleanup();
      }, Math.max(140, dur));
    }
    return t;
  }

  /* ---------- contrato drama del motor: { camara, impacto } ---------- */

  var lastCamKey = '';
  var lastHitKey = '';
  var lastHitAt = -1e9;

  /**
   * Interpreta el objeto `drama` del motor y lanza los efectos que toquen.
   * Defensivo: si `camara`/`impacto` faltan o vienen raros, no hace nada.
   *
   *   ViewerFX.applyDrama(state.drama)
   *   ViewerFX.applyDrama(state.drama, { tiles: 575, zoom: 1.9, map: '#mapa' })
   *
   * x/y llegan en tiles del mundo (0..575) y se convierten a porcentaje del
   * mapa visible. Con `pct:true` se interpretan ya como 0..100.
   * Devuelve { camera:bool, impact:bool }.
   */
  function applyDrama(d, opts) {
    if (!d || typeof d !== 'object') return null;
    var o = opts || {};
    var out = { camera: false, impact: false };
    if (!ensureReady()) return out;

    var t = resolveEl(o.map) || getMap() || null;
    var tiles = num(o.tiles, 575) || 575;
    function toPct(v) {
      var n = num(v, NaN);
      if (!isFinite(n)) return null;
      if (o.pct) return clamp(n, 0, 100);
      return clamp((n / tiles) * 100, 0, 100);
    }
    // `box` permite declarar el sub-rectángulo (en %) del frame que ocupa el
    // mapa del mundo, por si el stream lleva marcos/UI alrededor.
    var bx = 0, by = 0, bw = 100, bh = 100;
    if (o.box && typeof o.box === 'object') {
      bx = clamp(num(o.box.x, 0), 0, 100);
      by = clamp(num(o.box.y, 0), 0, 100);
      bw = clamp(num(o.box.w, 100), 1, 100);
      bh = clamp(num(o.box.h, 100), 1, 100);
    }
    function mapX(p) { return bx + (p / 100) * bw; }
    function mapY(p) { return by + (p / 100) * bh; }

    var c = d.camara;
    if (!c || typeof c !== 'object') {
      lastCamKey = '';
    } else {
      var cx = toPct(c.x);
      var cy = toPct(c.y);
      if (cx != null) cx = mapX(cx);
      if (cy != null) cy = mapY(cy);
      if (cx != null && cy != null && t) {
        var zoom = clamp(num(c.zoom, o.zoom || 1.8), 1, 4);
        var ms = clamp(num(c.ms, 1400), 150, 20000);
        var ck = [Math.round(cx * 10), Math.round(cy * 10), zoom.toFixed(2), Math.round(ms)].join('|');
        if (ck !== lastCamKey && zoom > 1.01) {
          lastCamKey = ck;
          focus(t, cx, cy, zoom, ms);
          out.camera = true;
        }
      }
    }

    var im = d.impacto;
    if (!im || typeof im !== 'object') {
      lastHitKey = '';
    } else {
      var ix = toPct(im.x);
      var iy = toPct(im.y);
      if (ix != null) ix = mapX(ix);
      if (iy != null) iy = mapY(iy);
      if (ix != null && iy != null) {
        var power = num(im.poder, 0.7);
        var ik = [Math.round(ix * 10), Math.round(iy * 10), Math.round(power * 100)].join('|');
        if (ik !== lastHitKey || (now() - lastHitAt) > 1200) {
          lastHitKey = ik;
          lastHitAt = now();
          spawnImpact(ix, iy, power, {});
          out.impact = true;
        }
      }
    }
    return out;
  }

  /** Olvida el último drama procesado (p.ej. al empezar partida nueva). */
  function resetDrama() {
    lastCamKey = '';
    lastHitKey = '';
    lastHitAt = -1e9;
    return true;
  }

  /* ======================================================================
   * Emoji volador: sale del chat, cruza el visor y estalla en el mapa
   * ==================================================================== */

  var lastFlyAt = -1e9;

  function flyEmoji(emoji, opts) {
    if (!ensureReady()) return null;
    if (!overlay) ensureOverlay();
    if (!overlay || !doc.body) return null;

    var o = opts || {};
    var txt = String(emoji == null ? '💥' : emoji).slice(0, 12);

    // Origen: línea del chat / panel / punto libre / borde del mapa.
    var src = null;
    var fromEl = resolveEl(o.fromEl);
    if (fromEl) {
      var fr = fromEl.getBoundingClientRect();
      if (fr.width || fr.height) src = centerOf(fr);
    }
    if (!src && o.from && isFinite(num(o.from.x, NaN)) && isFinite(num(o.from.y, NaN))) {
      src = { x: num(o.from.x, 0), y: num(o.from.y, 0) };
    }
    if (!src && chat.body && chat.body.lastElementChild) {
      src = centerOf(chat.body.lastElementChild.getBoundingClientRect());
    }
    if (!src && chat.panel) src = centerOf(chat.panel.getBoundingClientRect());
    if (!src) {
      var mr = mapRect();
      src = { x: mr.left + mr.width * 0.16, y: mr.top + mr.height * 0.5 };
    }

    // Destino: porcentaje del mapa, elemento o punto aleatorio dentro del mapa.
    var tp;
    if (o.to && isFinite(num(o.to.xPct, NaN))) {
      tp = { xPct: num(o.to.xPct, 50), yPct: num(o.to.yPct, 50) };
    } else {
      var toEl = resolveEl(o.toEl);
      if (toEl) {
        var tr = toEl.getBoundingClientRect();
        var c = centerOf(tr);
        tp = pctFromPoint(c.x, c.y);
      } else {
        tp = { xPct: rnd(16, 84), yPct: rnd(20, 80) };
      }
    }
    var dst = punto(tp.xPct, tp.yPct);

    var power = o.power != null ? normPower(o.power) : 0.55 + Math.random() * 0.3;

    // Accesibilidad: sin vuelo, impacto directo con el emoji en el punto.
    if (!motionAllows()) {
      spawnImpact(tp.xPct, tp.yPct, power, { color: o.color, emoji: o.impactEmoji || txt.slice(0, 4) });
      return null;
    }

    var dx = dst.x - src.x;
    var dy = dst.y - src.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var size = clamp(num(o.size, 46), 22, 110);
    var zEnd = clamp(num(o.scale, 3.4 + dist / 300), 1.5, 8);
    var dur = clamp(num(o.duration, 380 + dist * 0.55), 420, 1300);
    var lift = Math.min(90, dist * 0.16);

    var el = doc.createElement('span');
    el.className = 'vfx-fly';
    el.textContent = txt;
    el.style.fontSize = size + 'px';
    el.style.left = src.x + 'px';
    el.style.top = src.y + 'px';
    el.style.transform = 'translate(-50%,-50%) scale(.8)';
    if (o.color) {
      el.style.filter += ' drop-shadow(0 0 22px ' + o.color + ')';
    }
    doc.body.appendChild(el);

    var frames = [
      { transform: 'translate(-50%,-50%) scale(.8) rotate(-10deg)', opacity: 0.85, offset: 0 },
      {
        transform: 'translate(-50%,-50%) translate(' + (dx * 0.55).toFixed(1) + 'px,' +
          (dy * 0.55 - lift).toFixed(1) + 'px) scale(' + (zEnd * 0.55).toFixed(2) + ') rotate(14deg)',
        opacity: 1, offset: 0.5
      },
      {
        transform: 'translate(-50%,-50%) translate(' + dx.toFixed(1) + 'px,' +
          dy.toFixed(1) + 'px) scale(' + zEnd.toFixed(2) + ') rotate(-8deg)',
        opacity: 1, offset: 1
      }
    ];

    var anim = null;
    if (el.animate) {
      try {
        anim = el.animate(frames, {
          duration: dur,
          easing: 'cubic-bezier(.32,.06,.62,1)',
          fill: 'forwards'
        });
      } catch (e) { anim = null; }
    }

    // Estela: copias retrasadas y difuminadas.
    if (dist > 130) {
      var ghosts = Math.min(5, Math.max(2, Math.round(dist / 140)));
      var ghostFrames = frames.map(function (f) { return { transform: f.transform, offset: f.offset }; });
      for (var i = 1; i <= ghosts; i++) {
        (function (i) {
          var g = el.cloneNode(true);
          g.style.opacity = String(0.30 - i * 0.045);
          g.style.filter = (el.style.filter || '') + ' blur(1.5px)';
          g.style.fontSize = (size * (0.9 - i * 0.08)) + 'px';
          doc.body.appendChild(g);
          try {
            if (g.animate) {
              var ga = g.animate(ghostFrames, {
                duration: dur,
                delay: -i * 70,
                easing: 'cubic-bezier(.32,.06,.62,1)',
                fill: 'forwards'
              });
              if (ga && ga.finish) { /* noop */ }
            }
          } catch (e) { /* nada */ }
          autoRemove(g, dur + 500);
        })(i);
      }
    }

    function finish() {
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* nada */ }
      if (o.impact !== false) {
        spawnImpact(tp.xPct, tp.yPct, power, { color: o.color, emoji: o.impactEmoji });
      }
      if (o.shake) shake(o.shake === true ? 0.55 : num(o.shake, 0.55));
      if (o.damage != null) {
        spawnDamage(o.damage, tp.xPct, tp.yPct, o.side, { size: o.damageSize });
      }
      if (typeof o.onDone === 'function') {
        try { o.onDone({ xPct: tp.xPct, yPct: tp.yPct, power: power }); } catch (e) { /* nada */ }
      }
    }

    if (anim) {
      anim.onfinish = finish;
      anim.oncancel = finish;
    }
    autoRemove(el, dur + 1200); // red de seguridad si onfinish no dispara
    return el;
  }

  /* ======================================================================
   * Chat en vivo
   * ==================================================================== */

  var chat = {
    panel: null, head: null, body: null, badge: null, count: null, floatWrap: null,
    host: null, pending: null, unread: 0, total: 0, lastSeq: null,
    lastKey: '', lastAt: 0, msgs: {}, t0: 0
  };

  function scrollBottom(smooth) {
    var b = chat.body;
    if (!b) return;
    try {
      if (b.scrollTo) b.scrollTo({ top: b.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      else b.scrollTop = b.scrollHeight;
    } catch (e) { b.scrollTop = b.scrollHeight; }
  }

  function nearBottom() {
    var b = chat.body;
    if (!b) return true;
    return (b.scrollHeight - b.scrollTop - b.clientHeight) < 90;
  }

  function setUnread(n) {
    chat.unread = n;
    if (!chat.badge) return;
    if (n > 0) {
      chat.badge.textContent = '↓ ' + n + ' nuevo' + (n === 1 ? '' : 's');
      chat.badge.classList.add('on');
    } else {
      chat.badge.classList.remove('on');
    }
  }

  function buildChat() {
    var panel = makeEl('vfx-chat');
    panel.setAttribute('role', 'log');
    panel.setAttribute('aria-label', 'Chat en directo del show');

    var head = makeEl('vfx-chat-h');
    head.appendChild(makeEl('vfx-chat-dot'));
    var title = makeEl('vfx-chat-t');
    title.textContent = 'CHAT EN DIRECTO';
    head.appendChild(title);
    var countEl = makeEl('vfx-chat-n');
    countEl.textContent = '0';
    head.appendChild(countEl);
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'vfx-chat-b';
    btn.textContent = '–';
    btn.title = 'Minimizar chat';
    btn.setAttribute('aria-label', 'Minimizar chat');
    head.appendChild(btn);

    var body = makeEl('vfx-chat-body');
    var badge = doc.createElement('button');
    badge.type = 'button';
    badge.className = 'vfx-chat-nuevos';
    badge.textContent = '↓ 0 nuevos';

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(badge);

    btn.addEventListener('click', function () {
      panel.classList.toggle('min');
      var min = panel.classList.contains('min');
      btn.textContent = min ? '+' : '–';
      btn.title = min ? 'Expandir chat' : 'Minimizar chat';
      btn.setAttribute('aria-label', btn.title);
      if (!min) scrollBottom(true);
    });
    body.addEventListener('scroll', function () {
      if (nearBottom()) setUnread(0);
    });
    badge.addEventListener('click', function () {
      scrollBottom(true);
      setUnread(0);
    });

    chat.panel = panel;
    chat.head = head;
    chat.body = body;
    chat.badge = badge;
    chat.count = countEl;
    return panel;
  }

  function mountChat(target, opts) {
    ensureReady();
    if (!doc.body) { chat.pending = target || null; return null; }
    var panel = chat.panel || buildChat();
    var host = null;
    if (target) {
      host = resolveEl(target);
      if (!host) { chat.pending = target; return null; }
    }
    if (host) {
      if (panel.parentNode !== host) host.appendChild(panel);
      panel.classList.add('vfx-chat-hosted');
      panel.style.height = '100%';
      if (!host.clientHeight) panel.style.height = num(opts && opts.height, 320) + 'px';
      if (chat.floatWrap && chat.floatWrap.parentNode) chat.floatWrap.parentNode.removeChild(chat.floatWrap);
      chat.floatWrap = null;
      chat.host = host;
    } else {
      if (!chat.floatWrap) {
        chat.floatWrap = makeEl('vfx-chat-flotante');
        doc.body.appendChild(chat.floatWrap);
      }
      if (panel.parentNode !== chat.floatWrap) chat.floatWrap.appendChild(panel);
      panel.classList.remove('vfx-chat-hosted');
      panel.style.height = '';
      chat.host = null;
    }
    chat.t0 = now();
    scrollBottom(false);
    return panel;
  }

  function trimMsgs() {
    var keys = [];
    for (var k in chat.msgs) {
      if (Object.prototype.hasOwnProperty.call(chat.msgs, k)) keys.push(Number(k));
    }
    if (keys.length <= 500) return;
    keys.sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length - 250; i++) delete chat.msgs[keys[i]];
  }

  var EMOJI_RE = null;
  try {
    EMOJI_RE = new RegExp('^[\\p{Extended_Pictographic}\\u200d\\ufe0f\\u20e3\\s]+$', 'u');
  } catch (e) { EMOJI_RE = null; }

  function isEmojiOnly(s) {
    s = String(s == null ? '' : s).trim();
    if (!s || s.length > 24) return false;
    if (EMOJI_RE) {
      try { return EMOJI_RE.test(s); } catch (e) { /* nada */ }
    }
    return !/[a-z0-9áéíóúüñ]/i.test(s);
  }

  function normalizeChat(msg) {
    if (!msg) return null;
    var text = msg.text != null ? String(msg.text) : (msg.texto != null ? String(msg.texto) : '');
    var emoji = msg.emoji ? String(msg.emoji) : '';
    if (!text && emoji) text = emoji;
    if (!text) return null;

    var side = String(msg.side || msg.lado || msg.agente || msg.name || msg.nombre || '').toLowerCase();
    if (side.indexOf('rojo') === 0 || side.indexOf('red') === 0) side = 'rojo';
    else if (side.indexOf('azul') === 0 || side.indexOf('blue') === 0) side = 'azul';
    else side = '';

    var name = String(msg.name || msg.nombre || msg.agente ||
      (side === 'rojo' ? 'ROJO' : side === 'azul' ? 'AZUL' : 'SISTEMA'));
    var color = msg.color || (side === 'rojo' ? '#ff5d5d' : side === 'azul' ? '#4d8dff' : '#8b95a7');

    var para = msg.para != null ? msg.para : (msg.to != null ? msg.to : null);
    if (para != null) {
      para = String(para).trim().toLowerCase();
      if (para === '*' || para === 'todos' || para === 'all' || para === '') para = null;
      else if (para !== 'rojo' && para !== 'azul') para = null;
    }

    var seq = msg.seq != null && isFinite(Number(msg.seq)) ? Number(msg.seq) : null;
    var hora = msg.hora || msg.t || timeStr();
    var intensidad = clamp(num(msg.intensidad, num(msg.intensity, 0.5)), 0, 1);
    var replyTo = msg.respuesta_a != null ? msg.respuesta_a : (msg.replyTo != null ? msg.replyTo : null);
    var quote = '';
    if (replyTo != null) {
      var ref = chat.msgs[replyTo];
      if (ref) quote = (ref.name ? ref.name + ': ' : '') + shorten(ref.text, 64);
      else if (msg.replyText) quote = shorten(String(msg.replyText), 64);
    }

    return {
      text: text,
      side: side,
      name: name,
      color: color,
      para: para,
      intensidad: intensidad,
      seq: seq,
      hora: String(hora),
      onlyEmoji: isEmojiOnly(text),
      quote: quote,
      tono: msg.tono ? String(msg.tono).toLowerCase() : '',
      avatar: emoji
    };
  }

  function buildLine(m) {
    var line = doc.createElement('div');
    line.className = 'vfx-line';
    line.classList.add(m.side ? 'vfx-' + m.side : 'vfx-sys');
    if (m.tono) line.classList.add('vfx-t-' + m.tono.replace(/[^a-z0-9_-]/gi, ''));
    if (m.intensidad >= 0.66) line.classList.add('vfx-fuerte');
    if (m.onlyEmoji) line.classList.add('vfx-emoji-only');
    line.style.setProperty('--vfx-c', m.color);
    if (chat.total < 8 && (now() - chat.t0) < 1500) line.classList.add('vfx-instant');

    var av = doc.createElement('span');
    av.className = 'vfx-av';
    av.textContent = m.avatar || (m.side === 'rojo' ? 'R' : m.side === 'azul' ? 'A' : '·');
    if (m.avatar) av.style.fontSize = '15px';
    if (!m.side) av.style.background = 'rgba(255,255,255,.10)';

    var bub = doc.createElement('div');
    bub.className = 'vfx-bub';

    var meta = doc.createElement('div');
    meta.className = 'vfx-meta';
    var nm = doc.createElement('span');
    nm.className = 'vfx-name';
    nm.textContent = m.name;
    meta.appendChild(nm);
    if (m.para) {
      var chip = doc.createElement('span');
      chip.className = 'vfx-to';
      chip.textContent = '→ ' + m.para.toUpperCase();
      chip.style.setProperty('--vfx-c', m.para === 'rojo' ? '#ff5d5d' : '#4d8dff');
      meta.appendChild(chip);
    }
    var tm = doc.createElement('span');
    tm.className = 'vfx-time';
    tm.textContent = m.hora;
    meta.appendChild(tm);
    bub.appendChild(meta);

    if (m.quote) {
      var q = doc.createElement('span');
      q.className = 'vfx-quote';
      q.textContent = m.quote;
      bub.appendChild(q);
    }

    var tx = doc.createElement('div');
    tx.className = 'vfx-tx';
    tx.textContent = m.text;
    bub.appendChild(tx);

    line.appendChild(av);
    line.appendChild(bub);
    return line;
  }

  function pushChat(msg, opts) {
    ensureReady();
    if (!doc.body) return null;
    var o = opts || {};
    var m = normalizeChat(msg);
    if (!m) return null;

    // Dedupe: por seq (feed) o por texto repetido seguido.
    if (m.seq != null) {
      if (chat.lastSeq != null && m.seq <= chat.lastSeq) return null;
      chat.lastSeq = m.seq;
    } else {
      var key = (m.side || '') + '|' + m.text;
      if (key === chat.lastKey && (now() - chat.lastAt) < 1500) return null;
      chat.lastKey = key;
      chat.lastAt = now();
    }

    if (!chat.panel) mountChat(null);
    if (!chat.body) return null;

    var line = buildLine(m);
    var wasNear = nearBottom();
    chat.body.appendChild(line);
    chat.total++;
    if (chat.count) chat.count.textContent = String(chat.total);

    while (chat.body.children.length > Math.max(20, num(CFG.maxChatLines, 140))) {
      chat.body.removeChild(chat.body.firstElementChild);
    }

    if (wasNear || chat.total <= 2) {
      scrollBottom(true);
      setUnread(0);
    } else {
      setUnread(chat.unread + 1);
    }

    if (m.seq != null) {
      chat.msgs[m.seq] = { text: m.text, name: m.name, side: m.side };
      trimMsgs();
    }

    // Efecto automático: emoji suelto -> vuela del chat al mapa.
    var wantFly = o.fly != null ? !!o.fly : CFG.autoFly !== false;
    if (wantFly && m.onlyEmoji && motionAllows() && (now() - lastFlyAt) > 700 && (now() - chat.t0) > 350) {
      lastFlyAt = now();
      flyEmoji(m.text, {
        fromEl: line,
        power: clamp(0.45 + m.intensidad * 0.5, 0.4, 1),
        shake: m.intensidad >= 0.8 ? 0.5 : 0,
        side: m.side
      });
    }
    return line;
  }

  function clearChat() {
    if (chat.body) {
      while (chat.body.firstChild) chat.body.removeChild(chat.body.firstChild);
    }
    chat.total = 0;
    chat.unread = 0;
    chat.lastSeq = null;
    chat.lastKey = '';
    chat.msgs = {};
    if (chat.count) chat.count.textContent = '0';
    if (chat.badge) chat.badge.classList.remove('on');
  }

  /* ======================================================================
   * Ciclo de vida
   * ==================================================================== */

  function resolvePending() {
    if (!chat.pending || !doc.body) return;
    var t = chat.pending;
    chat.pending = null;
    mountChat(t);
  }

  function ensureReady() {
    if (!doc.body) return false;
    ensureStyles();
    ensureOverlay();
    resolvePending();
    return true;
  }

  function onReady() {
    ensureStyles();
    ensureOverlay();
    resolvePending();
  }

  /* ======================================================================
   * API pública
   * ==================================================================== */

  var api = {
    __vfx: VERSION,
    version: VERSION,

    init: function (opts) {
      var o = opts || {};
      if (o.map != null) CFG.map = o.map;
      if (o.chat != null) CFG.chat = o.chat;
      if (o.z != null) CFG.z = num(o.z, CFG.z);
      if (o.maxEffects != null) CFG.maxEffects = num(o.maxEffects, CFG.maxEffects);
      if (o.maxChatLines != null) CFG.maxChatLines = num(o.maxChatLines, CFG.maxChatLines);
      if (o.autoFly != null) CFG.autoFly = !!o.autoFly;
      if (o.motion != null) CFG.motion = String(o.motion);
      ensureReady();
      if (CFG.chat) mountChat(CFG.chat, o);
      return api;
    },

    setMap: function (el) { CFG.map = el; return api; },

    /** Fuerza o desactiva las animaciones: 'auto' | 'full' | 'reduced'. */
    setMotion: function (mode) {
      if (mode != null) CFG.motion = String(mode);
      return CFG.motion;
    },
    setChat: function (el) { CFG.chat = el; mountChat(el); return api; },
    getMapEl: function () { return getMap(); },
    getChatEl: function () { return chat.panel; },

    mountChat: mountChat,
    pushChat: pushChat,
    clearChat: clearChat,

    spawnReaction: spawnReaction,
    spawnImpact: spawnImpact,
    spawnDamage: spawnDamage,
    flyEmoji: flyEmoji,

    flash: flash,
    vignette: vignette,
    shake: shake,
    tremblePanel: tremblePanel,
    focus: focus,

    applyDrama: applyDrama,
    resetDrama: resetDrama
  };

  global.ViewerFX = api;

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
