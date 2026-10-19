from __future__ import annotations

import numpy as np

from .config import Settings


def mix_chunk(bgm: np.ndarray, clips: list[tuple[float, np.ndarray]], s: Settings) -> np.ndarray:
    """bgm: (n,2) for the chunk; clips: [(offset_sec_in_chunk, mono_audio)] -> (n,2)."""
    sr, n = s.mix_sr, len(bgm)
    voice = np.zeros(n, dtype=np.float32)
    for off, clip in clips:
        a = int(off * sr)
        b = min(n, a + len(clip))
        if a < n:
            voice[a:b] += clip[: b - a]
    # duck BGM under speech with a smoothed envelope
    env = (np.abs(voice) > 0.01).astype(np.float32)
    k = int(0.15 * sr)
    env = np.convolve(env, np.ones(k, dtype=np.float32) / k, mode="same").clip(0, 1)
    gain = 1.0 - env * (1.0 - s.duck_gain)
    out = bgm * (s.bgm_gain * gain)[:, None] + (voice * s.tts_gain)[:, None]
    return np.clip(out, -1, 1).astype(np.float32)
