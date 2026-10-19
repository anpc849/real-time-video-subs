"""Demucs: keep everything except vocals (the BGM/SFX bed)."""
from __future__ import annotations

import numpy as np

from .config import Settings


class Separator:
    def __init__(self, s: Settings):
        import torch
        from demucs.pretrained import get_model

        self.torch = torch
        self.s = s
        self.model = get_model(s.demucs_model).cuda().eval()
        self.sources = list(self.model.sources)
        self.sr = self.model.samplerate  # 44100

    def bgm(self, audio: np.ndarray, start: float, end: float) -> np.ndarray:
        """audio: (n, 2) float32 at self.sr covering the whole track.

        A margin on both sides absorbs Demucs edge artifacts; it is cropped off,
        so adjacent chunks line up sample-exactly without crossfading.
        """
        from demucs.apply import apply_model

        sr, m = self.sr, int(self.s.demucs_margin_sec * self.sr)
        a, b = int(start * sr), int(end * sr)
        lo, hi = max(0, a - m), min(len(audio), b + m)
        x = self.torch.from_numpy(audio[lo:hi].T.copy())
        ref = x.mean(0)
        x = (x - ref.mean()) / (ref.std() + 1e-8)
        with self.torch.no_grad():
            y = apply_model(self.model, x[None].cuda(), shifts=0, split=True, overlap=0.1, device="cuda")[0]
        keep = [i for i, n in enumerate(self.sources) if n != "vocals"]
        y = y[keep].sum(0) * (ref.std() + 1e-8).cuda() + ref.mean().cuda()
        y = y.cpu().numpy().T
        return y[a - lo : a - lo + (b - a)].astype(np.float32)
