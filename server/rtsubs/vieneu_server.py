"""Resident VieNeu TTS process. Run with the vieneu-tts env's python.

Protocol: one JSON object per stdin line {"id","text","output"}; replies one JSON
line {"id","ok","dur","error"} on stdout. First line out is {"ready":true}.
"""
import argparse
import json
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

MODEL_REPO = "pnnbao-ump/VieNeu-TTS-v3-Turbo"
CODEC_REPO = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX"


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", type=Path, required=True)
    p.add_argument("--codec-dir", type=Path, required=True)
    p.add_argument("--voice", default="Trúc Ly")
    p.add_argument("--threads", type=int, default=6)
    a = p.parse_args()

    onnx_dir = a.model_dir / "onnx_int8"
    if not (onnx_dir / "vieneu_backbone_shared.data").is_file():
        snapshot_download(repo_id=MODEL_REPO, local_dir=a.model_dir, allow_patterns=["onnx_int8/*"])
    if not (a.codec_dir / "moss_audio_tokenizer_decode_shared.data").is_file():
        snapshot_download(repo_id=CODEC_REPO, local_dir=a.codec_dir)
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine

    orig = OnnxV3LiteEngine._fetch
    OnnxV3LiteEngine._fetch = staticmethod(
        lambda repo, files, sub: a.codec_dir if repo == CODEC_REPO else orig(repo, files, sub)
    )
    from vieneu import Vieneu

    tts = Vieneu(
        mode="v3turbo", device="cpu", backend="onnx", precision="int8",
        threads=a.threads, onnx_dir=str(onnx_dir),
    )
    out = sys.stdout
    out.write(json.dumps({"ready": True, "sr": tts.sample_rate}) + "\n")
    out.flush()

    for line in sys.stdin:
        job = json.loads(line)
        try:
            audio = tts.infer(job["text"], voice=a.voice)
            if audio is None or len(audio) == 0:
                raise RuntimeError("empty audio")
            tts.save(audio, job["output"])
            reply = {"id": job["id"], "ok": True, "dur": len(audio) / tts.sample_rate}
        except Exception as exc:
            reply = {"id": job["id"], "ok": False, "error": str(exc)}
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
