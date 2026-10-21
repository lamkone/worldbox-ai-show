#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
voz-engine.py — MOTOR DE VOZ DEL SHOW (Kokoro + edge-tts, con emoción)
========================================================================
Una sola línea de guion entra, un MP3 listo para el directo sale.

  ROJO  -> Kokoro em_santa   (onnx local, ~1,3 s de carga una vez, RTF ~0,3)
  AZUL  -> edge-tts Salomé   (es-CO-SalomeNeural, red)

Lo que hace, en orden:
  1. Trocea el texto en frases (y por comas si la frase es larga).
  2. Sintetiza CADA frase con su propio rate/pitch según la EMOCIÓN de la línea.
     (edge no acepta <break>, así que las pausas se insertan como silencio real.)
  3. Une las frases con el silencio que toca.
  4. Iguala el volumen a -16 LUFS con ganancia LINEAL (sin EQ, sin compresor, sin
     loudnorm dinámico: no bombea). Es lo que pidió el dueño: "solo volumen
     igualado, sin EQ".
  5. Escribe MP3 96 kbps 24 kHz.

RENDIMIENTO (esto es un directo, la latencia importa)
  El coste real en Windows no es el DSP, es ARRANCAR ffmpeg (~0,4 s por proceso).
  Por eso la sonoridad se mide en numpy (ITU-R BS.1770) y la línea se procesa con
  DOS llamadas a ffmpeg como mucho: (1) pitch-shift con rubberband por tubería,
  solo si la emoción lo pide (~55-120 ms), y (2) el encoder MP3. Medido: de
  3,3-5,2 s por línea a ~1,4-2,4 s.

  ORDEN IMPORTANTE: primero el tono, después el volumen. rubberband se come
  entre 0,6 y 1,9 dB (y varía hasta 0,7 dB entre textos con el mismo tono), así
  que normalizar antes del shift dejaría las voces descuadradas.

EMOCIONES (las que puede elegir la IA): neutral, burla, enfadado, triste, confuso.
La emoción mueve ritmo, tono y largo de pausas; no cambia la voz ni el timbre.

USO
  # servidor de líneas por stdin/stdout, en JSON por línea (lo usa tts-server.mjs)
  python scripts/voz-engine.py

  # una sola línea, para pruebas
  python scripts/voz-engine.py --motor kokoro --emocion burla \
      --texto "No te lo vas a creer." --out C:\\tmp\\prueba.mp3 --medir

PROTOCOLO (una petición JSON por línea en stdin, una respuesta por línea en stdout)
  {"id":7,"motor":"kokoro","emocion":"burla","texto":"...","out":"C:\\\\...\\\\x.mp3"}
  -> {"id":7,"ok":true,"ms":1650,"lufs":-16.0,"pico":-1.4,"dur":2.9,"frases":3}
  {"cmd":"ping"} -> {"ok":true,"kokoro":true,"edge":true}
"""
import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

# --------------------------------------------------------------------------
# Rutas y constantes
# --------------------------------------------------------------------------
AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)

OBJ = -16.0        # LUFS objetivo para las DOS voces (igualado)
# El MP3 se come ~0,45 dB por su banco de filtros (medido: PCM -16,02 -> MP3 -16,47,
# igual a 24 kHz que a 44,1 kHz). Se compensa en el PCM para que el fichero
# entregado mida -16,0 de verdad, que es lo que oye el espectador.
CALIBRACION_MP3 = 0.45
# Techo de pico tras la ganancia. No basta con -0,2 dBFS: el banco de filtros del
# MP3 de 96 kbps reconstruye transitorios POR ENCIMA de lo que se le dio, y en la
# linea mas percusiva (Kokoro burla) el fichero decodificado pico +0,6 dBFS con
# techo 0,98 (medido con ffmpeg ebur128, barrido en reports/qa/v9-techo-test.py).
# Con 0,85 (-1,4 dBFS) el decodificado queda en -0,6 dBFS: headroom de sobra para
# el codec. Coste medido: 1,2 dB mas de limitacion en esa linea (crest 17,3->15,1),
# inaudible en voz hablada; la alternativa (bitrate 128k) NO arreglaba el pico.
TECHO = 0.85
SR = 24000
BITRATE = "96k"

KOKORO_DIR = os.environ.get(
    "WB_KOKORO_DIR", os.path.join(RAIZ, "reports", "voz-casting", "v6", "modelos"))
KOKORO_ONNX = os.path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
KOKORO_BIN = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
VOZ_KOKORO = os.environ.get("WB_VOZ_KOKORO", "em_santa")
VOZ_EDGE = os.environ.get("WB_VOZ_EDGE", "es-CO-SalomeNeural")

_ffmpeg = None


def ffmpeg():
    """Localiza el binario de ffmpeg (el de imageio-ffmpeg, que trae rubberband)."""
    global _ffmpeg
    if _ffmpeg:
        return _ffmpeg
    try:
        import imageio_ffmpeg
        _ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        _ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    return _ffmpeg


def log(msg):
    sys.stderr.write("[voz] %s\n" % msg)
    sys.stderr.flush()


# --------------------------------------------------------------------------
# Emociones -> prosodia
# --------------------------------------------------------------------------
# rate  : % de cambio de ritmo base (edge lo usa tal cual; Kokoro lo pasa a speed)
# pitch : Hz de desvío base en edge; 'semi' = semitonos para Kokoro
# vol   : % de volumen en edge (el volumen final se iguala igualmente)
# pausa : multiplicador del silencio entre frases
# fin_* : cómo acaba la ÚLTIMA frase (la caída de la entonación)
EMOCIONES = {
    "neutral":  dict(rate=0,   pitch=0,   semi=0.0,  vol=0,  pausa=1.00, fin_rate=-12, fin_pitch=-6,  fin_semi=-0.3),
    "burla":    dict(rate=6,   pitch=8,   semi=1.5,  vol=0,  pausa=1.15, fin_rate=-4,  fin_pitch=+3,  fin_semi=+0.5),
    "enfadado": dict(rate=12,  pitch=-5,  semi=-1.2, vol=5,  pausa=0.75, fin_rate=-3,  fin_pitch=-3,  fin_semi=-0.4),
    "triste":   dict(rate=-14, pitch=-10, semi=-2.5, vol=-4, pausa=1.35, fin_rate=-20, fin_pitch=-12, fin_semi=-1.2),
    "confuso":  dict(rate=-6,  pitch=4,   semi=1.0,  vol=0,  pausa=1.20, fin_rate=-2,  fin_pitch=+10, fin_semi=+0.9),
}


def perfil(emocion):
    e = str(emocion or "").strip().lower()
    return EMOCIONES.get(e, EMOCIONES["neutral"]), (e if e in EMOCIONES else "neutral")


def acotar(v, lo, hi):
    return max(lo, min(hi, v))


# --------------------------------------------------------------------------
# Sonoridad ITU-R BS.1770 en numpy (sin arrancar ffmpeg)
# --------------------------------------------------------------------------
def _biquad(x, b, a):
    """IIR de 2º orden. Usa scipy si está; si no, bucle (suficiente a 24 kHz)."""
    import numpy as np
    try:
        from scipy.signal import lfilter
        return lfilter(b, a, x)
    except Exception:
        y = np.zeros_like(x)
        x1 = x2 = y1 = y2 = 0.0
        b0, b1, b2 = b
        a1, a2 = a[1], a[2]
        for i in range(len(x)):
            xi = float(x[i])
            yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2, x1 = x1, xi
            y2, y1 = y1, yi
            y[i] = yi
        return y


def _k_weighting(x, sr):
    """Filtro K de BS.1770-4 (shelf 1681,97 Hz + paso alto 38,14 Hz)."""
    import numpy as np
    # Etapa 1: estante agudo
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / sr)
    Vh = 10.0 ** (G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1.0 + K / Q + K * K
    b1 = [((Vh + Vb * K / Q + K * K) / a0), (2.0 * (K * K - Vh) / a0), ((Vh - Vb * K / Q + K * K) / a0)]
    a1 = [1.0, (2.0 * (K * K - 1.0) / a0), ((1.0 - K / Q + K * K) / a0)]
    # Etapa 2: paso alto
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / sr)
    a0 = 1.0 + K / Q + K * K
    b2 = [1.0 / a0, -2.0 / a0, 1.0 / a0]
    a2 = [1.0, (2.0 * (K * K - 1.0) / a0), ((1.0 - K / Q + K * K) / a0)]
    y = _biquad(np.asarray(x, dtype="float64"), b1, a1)
    return _biquad(y, b2, a2)


def loudness_lufs(pcm, sr=SR):
    """LUFS integrado con gating absoluto (-70) y relativo (-10), como ebur128."""
    import numpy as np
    x = np.asarray(pcm, dtype="float64")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if len(x) < int(0.4 * sr):
        x = np.pad(x, (0, int(0.4 * sr) - len(x)))
    y = _k_weighting(x, sr)
    bloque = int(0.4 * sr)          # 400 ms
    salto = max(1, bloque // 4)     # 75 % de solape
    energias = []
    for i in range(0, len(y) - bloque + 1, salto):
        m = float(np.mean(y[i:i + bloque] ** 2))
        energias.append(m)
    if not energias:
        return -70.0
    e = np.asarray(energias)
    lufs_bloques = -0.691 + 10.0 * np.log10(e + 1e-12)
    # Gating absoluto (-70 LUFS).
    pasa_abs = lufs_bloques > -70.0
    if not pasa_abs.any():
        return -70.0
    # Gating relativo: umbral 10 LU por debajo de la media de los bloques que
    # pasaron el absoluto. OJO: la media se hace sobre ENERGÍA, no sobre dB
    # (promediar dB subestima la sonoridad de las señales con dinámica).
    media = -0.691 + 10.0 * math.log10(float(np.mean(e[pasa_abs])) + 1e-12)
    pasa = pasa_abs & (lufs_bloques > media - 10.0)
    if not pasa.any():
        return -70.0
    return float(-0.691 + 10.0 * math.log10(float(np.mean(e[pasa])) + 1e-12))


def _limitador(x, techo=TECHO, sr=SR, ataque_ms=3.0, suavizado_ms=6.0):
    """Limitador de picos con anticipación (lookahead) en numpy.

    Hace falta de verdad: Kokoro tiene crest ~20 dB, así que a -16 LUFS sus picos
    se irían a +3 dBFS. Con un techo a secas (bajar todo hasta que quepa) la voz
    se quedaría a -24 LUFS y el objetivo sería inalcanzable; hay que recortar solo
    los picos. Es un limitador, no un compresor: por debajo del techo es lineal.
    """
    import numpy as np
    pico = np.abs(x).astype("float64")
    pico = np.maximum(pico, 1e-9)
    g = np.minimum(1.0, techo / pico)          # ganancia necesaria muestra a muestra
    n_at = max(1, int(sr * ataque_ms / 1000.0))
    n_su = max(1, int(sr * suavizado_ms / 1000.0))
    try:
        from scipy.ndimage import minimum_filter1d
        g = minimum_filter1d(g, size=n_at, mode="nearest")   # se anticipa a la subida
    except Exception:
        # sin scipy: ventana mínima con dos pasadas de accumulate (O(n))
        pad = n_at // 2
        gp = np.pad(g, (pad, pad), mode="edge")
        g = np.minimum(np.minimum.accumulate(gp)[pad:pad + len(g)],
                       np.minimum.accumulate(gp[::-1])[::-1][pad:pad + len(g)])
    # suaviza la bajada/subida para que no chasquee
    ventana = np.hanning(n_su + 2)[1:-1]
    ventana = ventana / ventana.sum()
    g = np.convolve(g, ventana, mode="same")
    # la convolución puede dejar pasar algún pico: recorte final exacto
    y = x * g
    p = float(np.max(np.abs(y))) if len(y) else 0.0
    if p > techo:
        y *= techo / p
    return y


def normalizar_pcm(pcm, sr=SR, obj=None):
    """Ganancia LINEAL hasta obj LUFS + limitador de picos. Sin EQ ni compresor."""
    import numpy as np
    if obj is None:
        obj = OBJ
    x = np.asarray(pcm, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if len(x) == 0:
        return x, -70.0, 0.0
    ganancia = 0.0
    y, lufs = x, -70.0
    for _ in range(5):
        y = _limitador(x * (10.0 ** (ganancia / 20.0)), TECHO, sr)
        lufs = loudness_lufs(y, sr)
        if abs(lufs - obj) <= 0.1:
            break
        ganancia += obj - lufs
    return y, lufs, float(np.max(np.abs(y)))


# --------------------------------------------------------------------------
# Troceado en frases
# --------------------------------------------------------------------------
def partir_frases(texto):
    """Devuelve [(frase, pausa_ms)]. Si una frase pasa de 85 caracteres se parte
    por comas, que es donde el locutor respira de verdad."""
    trozos = re.split(r'(?<=[.!?…])\s+', str(texto).strip())
    salida = []
    for t in trozos:
        t = t.strip()
        if not t:
            continue
        if len(t) > 85 and "," in t:
            partes = [p.strip() for p in t.split(",")]
            for i, p in enumerate(partes):
                if not p:
                    continue
                if i < len(partes) - 1:
                    p += ","
                salida.append(p)
        else:
            salida.append(t)
    res = []
    for t in salida:
        if t.endswith("!"):
            pausa = 280
        elif t.endswith("?"):
            pausa = 240
        elif t.endswith(","):
            pausa = 140
        else:
            pausa = 320
        res.append((t, pausa))
    return res or [(str(texto).strip(), 320)]


def prosodia_frase(frase, i, total, emo):
    """(rate_pct, pitch_hz, semi) de esta frase concreta."""
    rate = emo["rate"]
    pitch = emo["pitch"]
    semi = emo["semi"]
    if frase.endswith("!"):
        rate += 8
        pitch += 5
        semi += 0.5
    elif frase.endswith("?"):
        rate += 3
        pitch += 6
        semi += 0.7
    elif i == total - 1:
        rate = emo["fin_rate"]
        pitch = emo["fin_pitch"]
        semi = emo["fin_semi"]
    elif frase.endswith(","):
        rate += 2
    return (acotar(rate, -30, 30), acotar(pitch, -40, 40), acotar(semi, -4.0, 4.0))


def fmt_rate(pct):
    return "%+d%%" % int(round(pct))


def fmt_pitch(hz):
    return "%+dHz" % int(round(hz))


def fmt_vol(pct):
    return "%+d%%" % int(round(pct))


# --------------------------------------------------------------------------
# Motor A: Kokoro (rojo)
# --------------------------------------------------------------------------
_K = None
_K_OK = None


def kokoro_cargar():
    global _K, _K_OK
    if _K_OK is not None:
        return _K_OK
    try:
        from kokoro_onnx import Kokoro
        if not (os.path.exists(KOKORO_ONNX) and os.path.exists(KOKORO_BIN)):
            raise RuntimeError("faltan los modelos en %s" % KOKORO_DIR)
        _K = Kokoro(KOKORO_ONNX, KOKORO_BIN)
        _K_OK = True
        log("kokoro cargado (%s)" % VOZ_KOKORO)
    except Exception as e:
        _K_OK = False
        log("kokoro NO disponible: %s" % e)
    return _K_OK


def kokoro_linea(texto, emo, voz=None):
    """Sintetiza frase a frase con speed propio. Devuelve (pcm, sr, semi_global)."""
    import numpy as np
    if not kokoro_cargar():
        raise RuntimeError("kokoro no disponible")
    voz = voz or VOZ_KOKORO
    frases = partir_frases(texto)
    trozos = []
    sr = SR
    for i, (f, pausa) in enumerate(frases):
        rate, _pitch, _semi = prosodia_frase(f, i, len(frases), emo)
        speed = acotar(1.0 + rate / 100.0, 0.6, 1.6)
        audio, sr = _K.create(f, voice=voz, speed=speed, lang="es",
                              sentence_pause=0.25, clause_pause=0.1)
        trozos.append(np.asarray(audio, dtype="float32"))
        trozos.append(np.zeros(int(sr * (pausa * emo["pausa"]) / 1000.0), dtype="float32"))
    trozos.append(np.zeros(int(sr * 0.06), dtype="float32"))
    pcm = np.concatenate(trozos) if trozos else np.zeros(1, dtype="float32")
    # Un solo desplazamiento de tono para toda la línea: el tono de la emoción.
    # (El matiz frase a frase ya lo lleva la velocidad, que es gratis.)
    return pcm, sr, float(emo["semi"])


# --------------------------------------------------------------------------
# Motor B: edge-tts (azul)
# --------------------------------------------------------------------------
def edge_linea(texto, emo, voz=None):
    """Frase a frase con rate/pitch/volume propios; las peticiones van EN PARALELO
    (una ida y vuelta de red en vez de N) y se unen con silencio real."""
    import numpy as np
    import soundfile as sf
    import edge_tts
    voz = voz or VOZ_EDGE

    async def una(f, rate, pitch, vol):
        fd, tmp = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)
        try:
            com = edge_tts.Communicate(f, voz, rate=rate, pitch=pitch, volume=vol)
            await com.save(tmp)
            a, sr = sf.read(tmp, dtype="float32")
            if a.ndim > 1:
                a = a.mean(axis=1)
            return np.asarray(a, dtype="float32"), sr
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    async def todas():
        frases = partir_frases(texto)
        tareas = []
        for i, (f, pausa) in enumerate(frases):
            rate, pitch, _semi = prosodia_frase(f, i, len(frases), emo)
            tareas.append(una(f, fmt_rate(rate), fmt_pitch(pitch), fmt_vol(emo["vol"])))
        resultados = await asyncio.gather(*tareas)
        trozos = []
        sr = SR
        for (a, s), (f, pausa) in zip(resultados, frases):
            sr = s
            trozos.append(a)
            trozos.append(np.zeros(int(sr * (pausa * emo["pausa"]) / 1000.0), dtype="float32"))
        trozos.append(np.zeros(int(sr * 0.06), dtype="float32"))
        return (np.concatenate(trozos) if trozos else np.zeros(1, dtype="float32")), sr

    return asyncio.run(todas())


# --------------------------------------------------------------------------
# Render de una línea completa
# --------------------------------------------------------------------------
def _aplicar_tono(pcm, sr, semitonos):
    """Pitch-shift con rubberband, en memoria (PCM por tubería, sin ficheros).

    Se hace ANTES de igualar el volumen, y ese orden importa: rubberband se come
    entre 0,6 y 1,9 dB según la emoción (y hasta 0,7 dB de diferencia entre dos
    textos con el mismo tono), así que compensarlo con una ganancia fija dejaría
    el nivel descuadrado. Midiendo DESPUÉS del shift, el -16 LUFS es exacto.
    Cuesta 55-120 ms: barato comparado con arrancar ffmpeg para otra cosa.
    """
    import numpy as np
    if abs(semitonos) < 0.15:
        return np.asarray(pcm, dtype="float32")
    datos = np.asarray(pcm, dtype="float32")
    if datos.ndim > 1:
        datos = datos.mean(axis=1)
    factor = 2.0 ** (semitonos / 12.0)
    args = [ffmpeg(), "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
            "-af", "rubberband=pitch=%.5f" % factor,
            "-f", "f32le", "-ar", str(sr), "-ac", "1", "pipe:1"]
    p = subprocess.run(args, input=np.clip(datos, -1.0, 1.0).astype("<f4").tobytes(),
                       capture_output=True)
    if p.returncode != 0 or len(p.stdout) < 400:
        log("rubberband fallo (%s), sigo sin cambiar el tono"
            % (p.stderr or b"").decode("utf-8", "ignore")[-160:])
        return np.asarray(pcm, dtype="float32")
    return np.frombuffer(p.stdout, dtype="<f4").astype("float32")


def _escribir_mp3(pcm, sr, salida):
    """Codifica a MP3. UNA llamada a ffmpeg, PCM por tubería, sin temporales."""
    import numpy as np
    datos = np.asarray(pcm, dtype="float32")
    if datos.ndim > 1:
        datos = datos.mean(axis=1)
    datos = np.clip(datos, -1.0, 1.0).astype("<f4").tobytes()
    args = [ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "pipe:0",
            "-ar", str(SR),
            "-c:a", "libmp3lame", "-b:a", BITRATE, salida]
    p = subprocess.run(args, input=datos, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg fallo: %s" % (p.stderr or b"").decode("utf-8", "ignore")[-200:])


def render(texto, motor, emocion, salida, voz=None):
    t0 = time.time()
    texto = str(texto or "").strip()
    if not texto:
        raise ValueError("texto vacio")
    emo, nombre_emo = perfil(emocion)
    motor = (motor or "kokoro").strip().lower()
    if motor not in ("kokoro", "edge"):
        motor = "kokoro"
    if motor == "kokoro":
        pcm, sr, semi = kokoro_linea(texto, emo, voz)
    else:
        pcm, sr = edge_linea(texto, emo, voz)
        semi = 0.0
    pcm = _aplicar_tono(pcm, sr, semi)          # 1º el tono...
    pcm, lufs, pico = normalizar_pcm(pcm, sr, OBJ + CALIBRACION_MP3)   # ...y DESPUÉS el volumen
    _escribir_mp3(pcm, sr, salida)
    if not os.path.exists(salida) or os.path.getsize(salida) < 800:
        raise RuntimeError("salida vacia o demasiado corta")
    dur = round(len(pcm) / float(sr), 3)
    return dict(ok=True, motor=motor, voz=(voz or (VOZ_KOKORO if motor == "kokoro" else VOZ_EDGE)),
                emocion=nombre_emo, ms=int((time.time() - t0) * 1000),
                lufs=round(lufs, 2), lufs_mp3=round(lufs - CALIBRACION_MP3, 2), pico=round(pico, 2), dur=dur,
                frases=len(partir_frases(texto)), bytes=os.path.getsize(salida))


# --------------------------------------------------------------------------
# Servidor por stdio (JSON por línea)
# --------------------------------------------------------------------------
def calentar_kokoro():
    """La PRIMERA síntesis de Kokoro cuesta ~6 s (arranque de la sesión onnx).
    Se hace al arrancar, en un hilo aparte, para que la primera línea del directo
    no pague ese peaje."""
    def _hacer():
        t0 = time.time()
        try:
            _K.create("Hola.", voice=VOZ_KOKORO, speed=1.0, lang="es")
            log("kokoro caliente en %.1f s" % (time.time() - t0))
        except Exception as e:
            log("calentamiento kokoro fallo: %s" % e)
    try:
        import threading
        threading.Thread(target=_hacer, daemon=True).start()
    except Exception:
        _hacer()


def servir():
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    kokoro_cargar()          # carga en caliente: la primera línea no espera 1,3 s
    calentar_kokoro()        # y la primera síntesis tampoco
    log("listo (kokoro=%s, edge=%s)" % (_K_OK, VOZ_EDGE))
    for linea in sys.stdin:
        linea = linea.strip()
        if not linea:
            continue
        try:
            req = json.loads(linea)
        except Exception as e:
            _responder(dict(ok=False, error="json invalido: %s" % e))
            continue
        if req.get("cmd") == "ping":
            _responder(dict(ok=True, kokoro=bool(_K_OK), edge=True,
                            voz_kokoro=VOZ_KOKORO, voz_edge=VOZ_EDGE))
            continue
        try:
            r = render(req.get("texto"), req.get("motor"), req.get("emocion"),
                       req.get("out"), req.get("voz"))
            r["id"] = req.get("id")
            _responder(r)
        except Exception as e:
            _responder(dict(id=req.get("id"), ok=False, error=str(e)[:300]))


def _responder(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    if "--out" in argv:
        def val(nombre, defecto=""):
            if nombre in argv:
                i = argv.index(nombre)
                if i + 1 < len(argv):
                    return argv[i + 1]
            return defecto
        r = render(val("--texto"), val("--motor", "kokoro"), val("--emocion", "neutral"),
                   val("--out"), val("--voz") or None)
        if "--medir" in argv:
            import soundfile as sf
            info = sf.info(val("--out"))
            r["dur"] = round(float(info.duration), 3)
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    servir()


if __name__ == "__main__":
    main()

