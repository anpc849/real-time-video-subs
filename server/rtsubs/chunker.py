"""Cut a known audio track into chunks at silences (never mid-sentence)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import Settings


@dataclass
class Chunk:
    index: int
    start: float
    end: float


def speech_timestamps(audio16k: np.ndarray) -> list[tuple[float, float]]:
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    model = load_silero_vad()
    ts = get_speech_timestamps(
        torch.from_numpy(audio16k), model, sampling_rate=16000,
        min_silence_duration_ms=250, speech_pad_ms=100, return_seconds=True,
    )
    return [(t["start"], t["end"]) for t in ts]


def plan_chunks(duration: float, speech: list[tuple[float, float]], s: Settings) -> list[Chunk]:
    gaps = [(speech[i][1], speech[i + 1][0]) for i in range(len(speech) - 1)]
    chunks: list[Chunk] = []
    start = 0.0
    while start < duration - 1e-3:
        if duration - start <= s.chunk_max_sec:
            chunks.append(Chunk(len(chunks), start, duration))
            break
        lo, hi = start + s.chunk_min_sec, start + s.chunk_max_sec
        cands = [(g1 - g0, (g0 + g1) / 2) for g0, g1 in gaps if lo <= (g0 + g1) / 2 <= hi]
        if cands:
            # prefer long silences, then closeness to the target length
            cut = max(cands, key=lambda c: (c[0] > 0.4, -abs(c[1] - start - s.chunk_target_sec), c[0]))[1]
        else:
            cut = hi  # continuous speech/music: hard cut (rare)
        chunks.append(Chunk(len(chunks), start, cut))
        start = cut
    return chunks
