/* ============================================================================
 * show-audio-ui.js — Panel de audio del WorldBox AI Show
 * ----------------------------------------------------------------------------
 * Popover con sliders de VOLUMEN (Voz / Música / Efectos) + botón de silencio
 * + SELECTOR DE PISTA de música (Auto / Espera / Chill / Tensión / Combate /
 * Victoria), que habla con el motor v2 de scripts/show-music.js.
 * Se engancha solo a los módulos:
 *   window.ViewerVoz  (voces neuronales, scripts/viewer-voice.js)
 *   window.ShowMusic  (música y efectos, scripts/show-music.js)
 *
 * API: window.ShowAudioUI = {
 *   version,
 *   montar({ boton, contenedor, compacto }),
 *   pista(nombre, variante),   // fuerza una pista, p.ej. pista('combate', 2)
 *   auto(),                    // vuelve a la selección automática del show
 *   getPista()                 // { pista, variante, nombre, ... } del motor
 * }
 *   boton      -> elemento o selector del botón que abre/cierra el panel
 *   contenedor -> elemento o selector donde colgar el panel (por defecto body)
 *
 * Persiste los volúmenes en localStorage. La pista manual NO se persiste: al
 * recargar vuelve al modo Auto (si no, un ?musica=combate de una prueba se
 * quedaría pegado para siempre en el show).
 * Degrada en silencio si falta algo.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.ShowAudioUI && window.ShowAudioUI.version) return;

  var VERSION = '1.2.1';
  // v9.7 (21/10/2026): se sube la versión de la clave para que el nuevo defecto
  // entre aunque el dueño ya tenga volúmenes guardados con la clave vieja
  // (wb-show-audio-v1). Lo guardado en v1 se ignora a propósito una sola vez.
  var LS_KEY = 'wb-show-audio-v2';
  var LS_KEY_VIEJA = 'wb-show-audio-v1';

  // Defecto v9.7: el dueño dijo "el sonido x default parece estar un poco alto
  // en general, aunque los niveles están bien equilibrados" (21/10/2026). Se
  // baja TODO el conjunto un factor 0,80 (≈ −2 dB) manteniendo la proporción
  // exacta que dio por buena: 0,85/0,55/0,70 → 0,68/0,44/0,56.
  // 0,68 coincide con VOLUMEN_DEFECTO de scripts/viewer-voice.js.
  var estado = {
    voz: 0.68,
    musica: 0.44,
    efectos: 0.56,
    silencio: false
  };

  var panel = null;
  var abierto = false;
  var botonRef = null;
  var contenedorRef = null;
  var duckTimer = null;
  var duckVigia = null;
  var envuelto = false;
  var pistaTimer = null;
  var pistaManual = null;   // null = auto; {pista, variante} = forzada desde el panel

  function leerLS() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) {
        // Migración v9.7: los volúmenes viejos (wb-show-audio-v1) se descartan
        // para que el nuevo defecto −2 dB se aplique de verdad una vez.
        try { localStorage.removeItem(LS_KEY_VIEJA); } catch (e2) {}
        return;
      }
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
    sincronizarControles();   // el rótulo del botón de silencio (Silenciar/Activar) y los sliders
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

  // ------------------------------------------------------------- pista UI ---
  // v9.7: el popup NATIVO del <select> salía con el tema CLARO aunque el panel
  // es oscuro ("el dropdown de audio donde dice auto(segun el show) etc, no
  // esta en modo oscuro cuando es modo oscuro", 21/10/2026). Se arregla de dos
  // formas a la vez: `color-scheme:dark` en el <select> (Chromium pinta el
  // popup oscuro con eso) y estilo EXPLÍCITO en cada <option> por si el
  // navegador ignora el color-scheme del select.
  var ESTILO_OPCION = 'style="background:#12161e;color:#eef2f7;color-scheme:dark"';

  // Catálogo del motor: [{id,nombre,variantes:[{indice,nombre}]}]. Se reconstruye
  // cada vez que se abre el panel por si el motor aún no estaba al montar.
  function opcionesPista() {
    var m = window.ShowMusic;
    if (!m || typeof m.pistas !== 'function') return null;
    var cat = null;
    try { cat = m.pistas(); } catch (e) { return null; }
    if (!cat || !cat.length) return null;
    var html = ['<option value="auto" ' + ESTILO_OPCION + '>Auto (según el show)</option>'];
    for (var i = 0; i < cat.length; i++) {
      var p = cat[i];
      var vs = p.variantes || [{ indice: 0, nombre: p.nombre }];
      for (var j = 0; j < vs.length; j++) {
        var v = vs[j];
        // Los nombres de variante ya llevan la pista delante ("Combate · Re menor"), así que
        // no se repite: antes salía "Chill · Chill · La menor". Si algún día una variante no
        // lo lleva, se compone "Pista · Variante".
        var vn = String(v.nombre || '').trim();
        var etiqueta;
        if (vs.length > 1) {
          etiqueta = (vn.toLowerCase().indexOf(String(p.nombre).toLowerCase()) === 0)
            ? vn
            : p.nombre + ' · ' + vn;
        } else {
          etiqueta = p.nombre;
        }
        html.push('<option value="' + p.id + ':' + v.indice + '" ' + ESTILO_OPCION + '>' + escapar(etiqueta) + '</option>');
      }
    }
    return html.join('');
  }

  function escapar(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rellenarPistaSelect() {
    if (!panel) return;
    var sel = panel.querySelector('[data-wb-pista]');
    if (!sel) return;
    var html = opcionesPista();
    if (html == null) {
      sel.innerHTML = '<option value="auto" ' + ESTILO_OPCION + '>Auto (motor aún no cargado)</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    // No pisar la selección del usuario si ya había una válida
    var actual = sel.value;
    sel.innerHTML = html;
    if (actual && sel.querySelector('option[value="' + actual + '"]')) sel.value = actual;
    else sel.value = 'auto';
    sincronizarPista();
  }

  function pistaSeleccionada() {
    var m = window.ShowMusic;
    if (pistaManual) return pistaManual;
    if (m && typeof m.getPista === 'function') {
      try {
        var g = m.getPista();
        if (g && g.pista) return { pista: g.pista, variante: g.variante || 0 };
      } catch (e) {}
    }
    return null;
  }

  function sincronizarPista() {
    if (!panel) return;
    var sel = panel.querySelector('[data-wb-pista]');
    var txt = panel.querySelector('[data-wb-pista-actual]');
    if (sel && pistaManual) sel.value = pistaManual.pista + ':' + pistaManual.variante;
    else if (sel) sel.value = 'auto';
    if (txt) {
      var m = window.ShowMusic;
      var g = pistaSeleccionada();
      if (!g) { txt.textContent = '—'; return; }
      var nombre = g.pista;
      try {
        if (m && typeof m.getPista === 'function') {
          var gp = m.getPista();
          if (gp && gp.pista === g.pista) nombre = gp.nombre || g.pista;
        }
      } catch (e) {}
      txt.textContent = nombre + ' · v' + ((g.variante || 0) + 1);
    }
  }

  function elegirPista(valor) {
    var m = window.ShowMusic;
    if (!m) return;
    if (!valor || valor === 'auto') {
      pistaManual = null;
      try { if (typeof m.setAuto === 'function') m.setAuto(); else if (typeof m.setFase === 'function') m.setFase('auto'); } catch (e) {}
      sincronizarPista();
      return;
    }
    var partes = String(valor).split(':');
    var id = partes[0];
    var v = parseInt(partes[1], 10);
    if (!isFinite(v)) v = 0;
    pistaManual = { pista: id, variante: v };
    try {
      if (typeof m.setFase === 'function') m.setFase(id, v);
      else if (typeof m.setVariante === 'function') m.setVariante(v);
    } catch (e) {}
    sincronizarPista();
  }

  function vigilarPista() {
    if (pistaTimer) return;
    pistaTimer = setInterval(function () {
      if (!abierto) return;
      sincronizarPista();
    }, 600);
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
      '<div style="margin:11px 0 4px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)">',
      '  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px">',
      '    <label for="wb-aud-pista" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9fb0c6">Pista</label>',
      '    <span data-wb-pista-actual style="font-size:11px;color:#7fd4a8;font-variant-numeric:tabular-nums">—</span>',
      '  </div>',
      '  <select id="wb-aud-pista" data-wb-pista style="all:unset;box-sizing:border-box;width:100%;cursor:pointer;',
      '    padding:6px 26px 6px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.18);',
      '    color-scheme:dark;',
      '    background-color:#161c26;color:#eef2f7;font:500 12px system-ui,sans-serif;',
      '    background-image:url(&quot;data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' fill=\'none\' stroke=\'%239fb0c6\' stroke-width=\'1.6\' stroke-linecap=\'round\'/%3E%3C/svg%3E&quot;);',
      '    background-repeat:no-repeat;background-position:right 9px center">',
      '  </select>',
      '</div>',
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

    // selector de pista
    var sel = panel.querySelector('[data-wb-pista]');
    if (sel) sel.addEventListener('change', function () { elegirPista(sel.value); });

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
    rellenarPistaSelect();
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
    rellenarPistaSelect();
    panel.style.display = 'block';
    abierto = true;
    posicionar();
    if (botonRef) botonRef.setAttribute('aria-expanded', 'true');
    // Desbloquear audio con este gesto (política de autoplay)
    try { if (window.ShowMusic) window.ShowMusic.desbloquear(); } catch (e) {}
    vigilarPista();
  }

  function cerrar() {
    if (!panel) return;
    panel.style.display = 'none';
    abierto = false;
    if (botonRef) botonRef.setAttribute('aria-expanded', 'false');
  }

  // --------------------------------------------------------------- API ------
  function pista(nombre, variante) {
    var m = window.ShowMusic;
    if (!m) return false;
    var v = variante == null ? 0 : variante;
    if (nombre == null || nombre === 'auto' || nombre === '') {
      pistaManual = null;
      try { if (typeof m.setAuto === 'function') m.setAuto(); else if (typeof m.setFase === 'function') m.setFase('auto'); } catch (e) {}
    } else {
      pistaManual = { pista: String(nombre), variante: v };
      try {
        if (typeof m.setFase === 'function') m.setFase(nombre, v);
        else if (typeof m.setVariante === 'function') m.setVariante(v);
      } catch (e) {}
    }
    sincronizarPista();
    return true;
  }

  function auto() { return pista('auto'); }

  function getPista() {
    var m = window.ShowMusic;
    if (m && typeof m.getPista === 'function') { try { return m.getPista(); } catch (e) {} }
    return null;
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
    return { abrir: abrir, cerrar: cerrar, estado: estado, pista: pista, auto: auto, getPista: getPista };
  }

  window.ShowAudioUI = { version: VERSION, montar: montar, pista: pista, auto: auto, getPista: getPista, estado: estado };
})();
