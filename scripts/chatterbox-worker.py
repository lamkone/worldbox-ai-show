# -*- coding: utf-8 -*-
"""Worker persistente de Chatterbox Multilingual (motor TTS nuevo, v9.7).

Se lanza desde `scripts/voz-engine.py` con el Python del venv ROCm:
    C:\\DSH\\aimusic\\venv\\Scripts\\python.exe
con PYTHONPATH apuntando a las libs de chatterbox (C:\\DSH\\tts-libs).

Habla JSON por linea: peticion por stdin, respuesta por stdout. Carga el modelo
UNA vez (20 s) y luego sintetiza por linea.

  -> {"id":1,"cmd":"ping"}
  <- {"id":1,"ok":true,"sr":24000,"dispositivo":"cuda"}
  -> {"id":2,"texto":"...","emocion":"burla","voz":"ximena","out":"C:\\...\\a.wav"}
  <- {"id":2,"ok":true,"wav":"...","sr":24000,"dur":4.2,"ms":13000}

`voz` elige el prompt de clonado en `scripts/voz-refs/<voz>.wav`; si no existe o
es "default", usa la voz propia del modelo (masculina).

PARCHES ROCm/gfx1101 (obligatorios, si no revienta MIOpen):
  * `modelo.ve` (voice_encoder, LSTM) -> CPU
  * `modelo.s3gen.speaker_encoder` (CAMPPlus, BatchNorm) -> CPU + wrapper de
    `inference` que mueve la entrada a su device.
"""
import os
import sys
import json
import time

# stdout queda reservado al protocolo JSON; todo lo demas va a stderr.
_PROTO = sys.stdout
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
import torch  # noqa: E402
import soundfile as sf  # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))
REFS = os.environ.get("VOZ_CB_REFS") or os.path.join(AQUI, "voz-refs")

# exaggeration por emocion del motor (el resto de emociones, 0.5)
EXAG = {"neutral": 0.5, "burla": 0.75, "enfadado": 0.85, "confuso": 0.55, "triste": 0.45}
CFG = float(os.environ.get("VOZ_CB_CFG", "0.5") or 0.5)
DEV = os.environ.get("VOZ_CB_DEV", "cuda") or "cuda"


def log(*a):
    print("[cb-worker]", *a, file=sys.stderr, flush=True)


def responder(obj):
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def cargar():
    try:
        import perth
        if getattr(perth, "PerthImplicitWatermarker", None) is None:
            perth.PerthImplicitWatermarker = perth.DummyWatermarker
    except Exception:
        pass

    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    t0 = time.time()
    modelo = ChatterboxMultilingualTTS.from_pretrained(device=DEV)
    log("modelo cargado en %.1fs sr=%s dev=%s" % (time.time() - t0, modelo.sr, DEV))

    try:
        modelo.ve.to("cpu")
        log("VE en CPU")
    except Exception as e:
        log("ve:", e)
    try:
        se = modelo.s3gen.speaker_encoder
        se.to("cpu")
        dev_se = next(se.parameters()).device
        _orig_inf = se.inference

        def _inf(audio_list, *a, **k):
            if isinstance(audio_list, torch.Tensor):
                audio_list = audio_list.to(dev_se)
            return _orig_inf(audio_list, *a, **k)

        se.inference = _inf
        log("CAMPPlus en CPU")
    except Exception as e:
        log("speaker_encoder:", e)

    return modelo


def ruta_prompt(voz):
    if not voz or str(voz).strip().lower() in ("", "default", "none"):
        return None
    p = os.path.join(REFS, "%s.wav" % str(voz).strip().lower())
    return p if os.path.exists(p) else None


def main():
    modelo = cargar()
    sr = int(getattr(modelo, "sr", 24000) or 24000)
    log("listo, esperando peticiones")
    responder(dict(ok=True, cmd="ready", sr=sr))

    for linea in sys.stdin:
        linea = linea.strip()
        if not linea:
            continue
        try:
            req = json.loads(linea)
        except Exception as e:
            responder(dict(ok=False, error="json invalido: %s" % e))
            continue
        rid = req.get("id")
        if req.get("cmd") == "ping":
            responder(dict(id=rid, ok=True, sr=sr, dispositivo=str(getattr(modelo, "device", DEV))))
            continue
        if req.get("cmd") == "salir":
            break
        t0 = time.time()
        try:
            texto = str(req.get("texto") or "").strip()
            if not texto:
                raise ValueError("texto vacio")
            emo = str(req.get("emocion") or "neutral").strip().lower()
            out = req.get("out")
            if not out:
                raise ValueError("falta out")
            prompt = ruta_prompt(req.get("voz"))
            wav = modelo.generate(texto, language_id="es", audio_prompt_path=prompt,
                                  exaggeration=EXAG.get(emo, 0.5), cfg_weight=CFG)
            a = wav.squeeze().detach().cpu().numpy().astype("float32")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            sf.write(out, a, sr)
            seg = len(a) / float(sr)
            log("%s %.2fs audio en %.2fs (x%.2f) voz=%s emo=%s"
                % (os.path.basename(out), seg, time.time() - t0,
                   (time.time() - t0) / max(seg, 1e-6), req.get("voz") or "default", emo))
            responder(dict(id=rid, ok=True, wav=out, sr=sr, dur=round(seg, 3),
                           ms=int((time.time() - t0) * 1000)))
        except Exception as e:
            import traceback
            traceback.print_exc()
            responder(dict(id=rid, ok=False, error="%s: %s" % (type(e).__name__, str(e)[:300])))


if __name__ == "__main__":
    main()
