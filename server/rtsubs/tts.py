from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import Settings

SERVER = Path(__file__).with_name("vieneu_server.py")


class Tts:
    def __init__(self, s: Settings):
        self.s = s
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [s.vieneu_python, "-u", str(SERVER), "--model-dir", str(s.vieneu_model_dir),
             "--codec-dir", str(s.vieneu_codec_dir), "--voice", s.vieneu_voice],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, env=env,
        )
        while True:  # skip stray library prints until the ready line
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("VieNeu worker died during startup")
            if line.startswith("{") and '"ready"' in line:
                self.sr = json.loads(line)["sr"]
                break
        self._n = 0

    def synth(self, text: str, path: Path) -> float:
        self._n += 1
        job = {"id": self._n, "text": text, "output": str(path)}
        self.proc.stdin.write(json.dumps(job, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("VieNeu worker died")
            if line.startswith("{") and '"id"' in line:
                r = json.loads(line)
                if not r["ok"]:
                    raise RuntimeError(r["error"])
                return r["dur"]

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def load_fitted(path: Path, slot: float, s: Settings) -> tuple[np.ndarray, float]:
    """Read a TTS wav as mono at s.mix_sr.

    Same policy as clean_version/timing_fit.py: speed up by exactly the factor
    needed to fit the source slot (no cap, so a clip never overflows into the
    next line); shorter clips keep natural speed.
    """
    dur = sf.info(str(path)).duration
    tempo = max(1.0, dur / max(slot, 0.2))
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path)]
    if tempo > 1.001:
        chain, f = [], tempo
        while f > 2.0:  # one atempo filter handles at most 2.0
            chain.append(2.0)
            f /= 2.0
        chain.append(f)
        cmd += ["-filter:a", ",".join(f"atempo={v:.6f}" for v in chain)]
    cmd += ["-ac", "1", "-ar", str(s.mix_sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy(), tempo
