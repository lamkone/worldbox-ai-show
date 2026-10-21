/* ============================================================================
 * show-audio-ui.js — Panel de audio del WorldBox AI Show
 * ----------------------------------------------------------------------------
 * Popover con sliders de VOLUMEN (Voz / Música / Efectos) + botón de silencio.
 * Sustituye el viejo botón on/off de sonido. Se engancha solo a los módulos:
 *   window.ViewerVoz  (voces neuronales, scripts/viewer-voice.js)
 *   window.ShowMusic  (música y efectos, scripts/show-music.js)
 *
 * API: window.ShowAudioUI = { version, montar({ boton, contenedor, compacto }) }
 *   boton      -> elemento o selector del botón que abre/cierra el panel
 *   contenedor -> elemento o selector donde colgar el panel (por defecto body)
 *
 * Persiste los volúmenes en localStorage. Degrada en silencio si falta algo.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ShowAudioUI && window.ShowAudioUI.version) return;

  var VERSION = '1.0.0';
  var LS_KEY = 'wb-show-audio-v1';

  var estado = {
    voz: 0.85,
    musica: 0.55,
    efectos: 0.70,
    silencio: false
  };

  var panel = null;
  var abierto = false;
  var botonRef = null;
  var contenedorRef = null;
  var duckTimer = null;
  var duckVigia = null;
  var envuelto = false;

  function leerLS() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (typeof o.voz === 'number') estado.voz = clamp01(o.voz);
      if (typeof o.musica === 'number') estado.musica = clamp01(o.musica);
      if (typeof o.efectos === 'number') estado.efectos = clamp01(o.efectos);
      if (typeof o.silencio === 'boolean') estado.silencio = o.silencio;
    } catch (e) {}
  }

  function guardarLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(estado)); } catch (e) {}
  }

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function $(x) {
    if (!x) return null;
    if (typeof x === 'string') return document.querySelector(x);
    return x;
  }

  // ------------------------------------------------------- aplicar valores ---
  function aplicarVoz() {
    var v = window.ViewerVoz;
    if (!v) return;
    var valor = estado.silencio ? 0 : estado.voz;
    try {
      if (typeof v.setVolumen === 'function') v.setVolumen(valor);
      else if (typeof v.setVolume === 'function') v.setVolume(valor);
      else if (typeof v.volumen === 'number' || v.volumen === undefined) v.volumen = valor;
    } catch (e) {}
    // Si el usuario sube la voz desde 0, reactivarla
    if (!estado.silencio && valor > 0.01) {
      try {
        if (typeof v.activo === 'function' && !v.activo() && typeof v.activar === 'function') v.activar();
      } catch (e) {}
    }
    if (estado.silencio) {
      try { if (typeof v.silenciar === 'function') v.silenciar(); } catch (e) {}
    }
  }

  function aplicarMusica() {
    var m = window.ShowMusic;
    if (!m) return;
    try {
      m.setVolume(estado.silencio ? 0 : estado.musica);
      if (typeof m.setVolumenEfectos === 'function') m.setVolumenEfectos(estado.silencio ? 0 : estado.efectos);
    } catch (e) {}
  }

  function aplicarTodo() {
    aplicarVoz();
    aplicarMusica();
    actualizarBotones();
    guardarLS();
  }

  // ------------------------------------------------------------ auto-duck ---
  // La musica baja mientras las voces hablan. En vez de adivinar la duracion
  // por longitud de texto (que se queda corta o larga y puede dejar el show
  // mudo para siempre si algo falla), se sondea el estado REAL de locucion
  // que publica viewer-voice.js (ViewerVoz.hablando()).
  function soltarDuck() {
    if (duckTimer) { clearTimeout(duckTimer); duckTimer = null; }
    try { if (window.ShowMusic) window.ShowMusic.duck(false); } catch (e) {}
  }

  function vigilarDuck() {
    if (duckVigia) return;
    duckVigia = setInterval(function () {
      var m = window.ShowMusic;
      var v = window.ViewerVoz;
      if (!m || typeof m.duck !== 'function') return;
      var suena = false;
      try {
        suena = !!(v && typeof v.hablando === 'function' && v.hablando()) &&
                !estado.silencio && estado.voz > 0.01;
      } catch (e) { suena = false; }
      try { m.duck(suena); } catch (e) {}
      // Red de seguridad: nunca dejar la musica bajada mas de 20 s seguidos.
      if (suena && !duckTimer) {
        duckTimer = setTimeout(soltarDuck, 20000);
      } else if (!suena && duckTimer) {
        clearTimeout(duckTimer); duckTimer = null;
      }
    }, 220);
  }

  function envolverVoz() {
    if (envuelto) return;
    var v = window.ViewerVoz;
    if (!v || typeof v.decir !== 'function') return;
    envuelto = true;
    vigilarDuck();
  }

  // --------------------------------------------------------------- UI DOM ---
  function crearPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.className = 'wb-audio-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Volumen del show');
    panel.style.cssText = [
      'position:absolute', 'z-index:2147483000', 'min-width:238px', 'max-width:min(86vw,300px)',
      'padding:14px 14px 12px', 'border-radius:14px',
      'background:rgba(12,16,24,.94)', 'border:1px solid rgba(255,255,255,.16)',
      'box-shadow:0 18px 48px rgba(0,0,0,.55)', 'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)', 'color:#eef2f7',
      'font:500 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'display:none', 'transform-origin:top right', 'user-select:none'
    ].join(';');

    panel.innerHTML = [
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">',
      '  <strong style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9fb0c6">Audio</strong>',
      '  <button type="button" data-wb-mute style="all:unset;cursor:pointer;padding:4px 9px;border-radius:9px;',
      '    border:1px solid rgba(255,255,255,.18);font-size:12px;color:#eef2f7;background:rgba(255,255,255,.06)">',
      '    <span data-wb-mute-txt>Silenciar</span></button>',
      '</div>',
      fila('voz', 'Voz', '🎙️'),
      fila('musica', 'Música', '🎵'),
      fila('efectos', 'Efectos', '💥'),
      '<div style="margin-top:9px;font-size:11px;color:#8296ad">La música arranca al pulsar ▶ o el mapa.</div>'
    ].join('');

    (contenedorRef || document.body).appendChild(panel);

    // sliders
    ['voz', 'musica', 'efectos'].forEach(function (clave) {
      var input = panel.querySelector('input[data-wb-slider="' + clave + '"]');
      var etiqueta = panel.querySelector('[data-wb-val="' + clave + '"]');
      if (!input) return;
      input.addEventListener('input', function () {
        estado[clave] = clamp01(Number(input.value) / 100);
        if (estado.silencio && estado[clave] > 0) estado.silencio = false;
        if (etiqueta) etiqueta.textContent = Math.round(estado[clave] * 100) + '%';
        aplicarTodo();
      });
    });

    // mute
    var btnMute = panel.querySelector('[data-wb-mute]');
    if (btnMute) btnMute.addEventListener('click', function (ev) {
      ev.preventDefault();
      estado.silencio = !estado.silencio;
      aplicarTodo();
    });

    // cerrar al hacer click fuera
    document.addEventListener('pointerdown', function (ev) {
      if (!abierto) return;
      if (panel.contains(ev.target)) return;
      if (botonRef && (botonRef === ev.target || botonRef.contains(ev.target))) return;
      cerrar();
    }, true);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && abierto) cerrar();
    });

    sincronizarControles();
    return panel;
  }

  function fila(clave, titulo, icono) {
    return [
      '<div style="display:flex;align-items:center;gap:9px;margin:7px 0">',
      '  <span style="width:18px;text-align:center;opacity:.85">' + icono + '</span>',
      '  <label for="wb-aud-' + clave + '" style="flex:0 0 56px;color:#c3d0e0">' + titulo + '</label>',
      '  <input id="wb-aud-' + clave + '" data-wb-slider="' + clave + '" type="range" min="0" max="100" step="1"',
      '    style="flex:1 1 auto;accent-color:#4ea1ff;height:18px;cursor:pointer">',
      '  <span data-wb-val="' + clave + '" style="flex:0 0 38px;text-align:right;font-variant-numeric:tabular-nums;color:#9fb0c6;font-size:12px">0%</span>',
      '</div>'
    ].join('');
  }

  function sincronizarControles() {
    if (!panel) return;
    ['voz', 'musica', 'efectos'].forEach(function (clave) {
      var input = panel.querySelector('input[data-wb-slider="' + clave + '"]');
      var etiqueta = panel.querySelector('[data-wb-val="' + clave + '"]');
      var pct = Math.round(estado[clave] * 100);
      if (input) input.value = String(pct);
      if (etiqueta) etiqueta.textContent = pct + '%';
    });
    var txt = panel.querySelector('[data-wb-mute-txt]');
    if (txt) txt.textContent = estado.silencio ? 'Activar' : 'Silenciar';
  }

  function actualizarBotones() {
    if (!botonRef) return;
    var activo = !estado.silencio && (estado.voz > 0.01 || estado.musica > 0.01);
    botonRef.setAttribute('aria-pressed', activo ? 'true' : 'false');
    botonRef.setAttribute('title', 'Audio: volumen de voces y música');
    // Si el botón tiene un span de icono, reflejar el estado
    var icono = botonRef.querySelector('[data-wb-audio-icon]');
    if (icono) icono.textContent = estado.silencio ? '🔇' : (activo ? '🔊' : '🔈');
    else if (botonRef.dataset.wbAudioTexto === '1') botonRef.textContent = estado.silencio ? '🔇' : '🔊';
  }

  function posicionar() {
    if (!panel || !botonRef) return;
    var r = botonRef.getBoundingClientRect();
    var ancho = panel.offsetWidth || 260;
    var alto = panel.offsetHeight || 190;
    var x = r.right - ancho;
    if (x < 8) x = 8;
    var y = r.bottom + 8;
    if (y + alto > window.innerHeight - 8) y = Math.max(8, r.top - alto - 8);
    panel.style.left = Math.round(x + window.scrollX) + 'px';
    panel.style.top = Math.round(y + window.scrollY) + 'px';
  }

  function abrir() {
    crearPanel();
    sincronizarControles();
    panel.style.display = 'block';
    abierto = true;
    posicionar();
    if (botonRef) botonRef.setAttribute('aria-expanded', 'true');
    // Desbloquear audio con este gesto (política de autoplay)
    try { if (window.ShowMusic) window.ShowMusic.desbloquear(); } catch (e) {}
  }

  function cerrar() {
    if (!panel) return;
    panel.style.display = 'none';
    abierto = false;
    if (botonRef) botonRef.setAttribute('aria-expanded', 'false');
  }

  function montar(opts) {
    opts = opts || {};
    leerLS();
    botonRef = $(opts.boton) || document.querySelector('#btn-audio') || document.querySelector('#btn-sonido');
    contenedorRef = $(opts.contenedor) || document.body;
    if (botonRef) {
      botonRef.style.cursor = 'pointer';
      botonRef.setAttribute('aria-haspopup', 'dialog');
      botonRef.setAttribute('aria-expanded', 'false');
      botonRef.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (abierto) cerrar(); else abrir();
      });
    }
    // Espera a que existan los módulos y engancha el duck de la voz
    var intentos = 0;
    var espera = setInterval(function () {
      intentos++;
      envolverVoz();
      if ((window.ViewerVoz && window.ShowMusic) || intentos > 40) clearInterval(espera);
    }, 150);
    aplicarTodo();
    return { abrir: abrir, cerrar: cerrar, estado: estado };
  }

  window.ShowAudioUI = { version: VERSION, montar: montar };
})();
