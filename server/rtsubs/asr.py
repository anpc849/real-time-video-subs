from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Settings


@dataclass
class Seg:
    start: float  # absolute seconds in the source
    end: float
    zh: str
    vi: str = ""


class Asr:
    def __init__(self, s: Settings):
        import torch  # noqa: F401  (loads cuBLAS DLLs before ctranslate2)
        from faster_whisper import WhisperModel

        self.model = WhisperModel(s.whisper_model, device="cuda", compute_type=s.whisper_compute)

    def transcribe(self, audio16k: np.ndarray, offset: float) -> list[Seg]:
        segs, _ = self.model.transcribe(
            audio16k, language="zh", beam_size=1, vad_filter=True,
            condition_on_previous_text=False, no_speech_threshold=0.6,
        )
        out = []
        for g in segs:
            text = g.text.strip()
            if text and g.no_speech_prob < 0.8:
                out.append(Seg(offset + g.start, offset + g.end, text))
        return out
