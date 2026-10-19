"""Shared chunk processing + the resident engine used by the HTTP server and the file runner."""
from __future__ import annotations

import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np

from .asr import Asr, Seg
from .chunker import Chunk
from .config import Settings
from .mixer import mix_chunk
from .separate import Separator
from .translate import Translator
from .tts import Tts, load_fitted


def decode(path: str | Path, sr: int, ch: int, input_args: list[str] | None = None) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", *(input_args or []), "-i", str(path), "-vn", "-ac", str(ch), "-ar", str(sr),
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    a = np.frombuffer(raw, dtype=np.float32)
    return a.reshape(-1, ch) if ch > 1 else a.copy()


class Engine:
    """Models loaded once; GPU/CPU work is serialised by the caller (one chunk at a time)."""

    def __init__(self, s: Settings):
        self.s = s
        self.asr = Asr(s)
        self.asr_lock = threading.Lock()  # Whisper is used by the chunk loop and the look-ahead thread
        self.sep = Separator(s)
        self.tts = Tts(s)
        self.pool = ThreadPoolExecutor(max_workers=1)  # Demucs overlaps with ASR/translate/TTS

    def close(self) -> None:
        self.tts.close()


class VideoSession:
    """One video: transcribes it ahead of playback so translation can see the whole story."""

    def __init__(self, eng: Engine, tr: Translator, a16: np.ndarray, a44: np.ndarray, chunks: list[Chunk],
                 transcript: list[dict] | None = None, transcript_lang: str | None = None):
        self.eng, self.tr, self.a16, self.a44, self.chunks = eng, tr, a16, a44, chunks
        self.transcript = transcript
        self.transcript_lang = (transcript_lang or "").lower()
        self._segs: dict[int, list[Seg]] = {}
        self._asr_time: dict[int, float] = {}
        self.cancel = threading.Event()
        self.play_time = 0.0  # start of the chunk being processed; read-ahead stays within a window of it
        self._ahead: threading.Thread | None = None

        if self.transcript:
            self._init_from_transcript()

    def _init_from_transcript(self) -> None:
        """Map external transcript cues to planned chunks and avoid running Whisper."""
        is_vi = self.transcript_lang.startswith("vi")
        if not is_vi and self.transcript:
            sample = " ".join(c.get("text", "") for c in self.transcript[:10])
            vi_chars = set("àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ")
            if any(ch in vi_chars for ch in sample.lower()):
                is_vi = True

        for c in self.chunks:
            self._segs[c.index] = []
            self._asr_time[c.index] = 0.0

        for cue in self.transcript:
            start = float(cue.get("start", 0.0))
            end = float(cue.get("end", start + 2.0))
            text = cue.get("text", "").strip()
            if not text:
                continue
            mid = (start + end) / 2.0
            target_chunk = None
            for c in self.chunks:
                if c.start <= mid < c.end:
                    target_chunk = c
                    break
            if target_chunk is None and self.chunks:
                target_chunk = min(self.chunks, key=lambda c: abs(c.start - start))
            if target_chunk:
                seg = Seg(start=start, end=end, zh=text, vi=text if is_vi else "")
                self._segs[target_chunk.index].append(seg)

        total_segs = sum(len(v) for v in self._segs.values())
        print(f"[transcript] Pre-populated {total_segs} segments across {len(self.chunks)} chunks (is_vietnamese={is_vi})", flush=True)

    def segs_for(self, i: int) -> list[Seg]:
        with self.eng.asr_lock:
            if i not in self._segs:
                c = self.chunks[i]
                t = time.time()
                self._segs[i] = self.eng.asr.transcribe(
                    self.a16[int(c.start * 16000) : int(c.end * 16000)], c.start)
                self._asr_time[i] = time.time() - t
            return self._segs[i]

    def _lines(self) -> list[tuple[float, str]]:
        return [(g.start, g.zh) for i in sorted(self._segs) for g in self._segs[i]]

    def warm_up(self) -> None:
        """Build first story bible / terminology, then read ahead in the background."""
        if self.cancel.is_set():
            return
        if self.transcript:
            is_vi = self.transcript_lang.startswith("vi") or any(bool(g.vi) for segs in self._segs.values() for g in segs)
            if not is_vi:
                self.tr.understand(self._lines(), complete=True)
            return

        self.segs_for(self.chunks[0].index)
        if self.cancel.is_set():
            return
        self.tr.understand(self._lines(), complete=len(self.chunks) == 1)
        if len(self.chunks) > 1 and not self.cancel.is_set():
            self._ahead = threading.Thread(target=self._read_ahead, daemon=True)
            self._ahead.start()

    def _read_ahead(self) -> None:
        s = self.eng.s
        last_bible = 1
        for c in self.chunks:
            while not self.cancel.is_set() and c.start > self.play_time + s.story_lookahead_sec:
                if self.cancel.wait(0.5):
                    return
            if self.cancel.is_set():
                return
            self.segs_for(c.index)
            if self.cancel.is_set():
                return
            done = len(self._segs)
            if done - last_bible >= s.bible_every or done == len(self.chunks):
                last_bible = done
                self.tr.understand(self._lines(), complete=done == len(self.chunks))

    def process(self, i: int, work: Path, cancel_event: threading.Event | None = None) -> tuple[np.ndarray, list[dict], dict]:
        self.play_time = self.chunks[i].start
        return process_chunk(self.eng, self.tr, self.a44, self.chunks[i], work,
                             self.segs_for(i), self._asr_time.get(i, 0.0), cancel_event=cancel_event)


def process_chunk(
    eng: Engine, tr: Translator, a44: np.ndarray, c: Chunk, work: Path, segs: list[Seg], t_asr: float = 0.0,
    cancel_event: threading.Event | None = None,
) -> tuple[np.ndarray, list[dict], dict]:
    """Returns (mixed stereo audio for the chunk, subtitle dicts, timing dict). segs come from ASR."""
    s = eng.s
    t_start = time.time()
    bgm_future = eng.pool.submit(eng.sep.bgm, a44, c.start, c.end)

    slots = [max(0.6, min(g.end, c.end) - g.start) for g in segs]
    t = time.time()
    if cancel_event and cancel_event.is_set():
        bgm_future.cancel()
        return np.zeros((int((c.end - c.start) * s.mix_sr), 2), dtype=np.float32), [], {}

    # If all segments already have Vietnamese text (e.g. Vietnamese transcript), skip translation!
    if all(bool(g.vi) for g in segs):
        t_tr = 0.0
    else:
        tr.translate(segs, slots)
        t_tr = time.time() - t

    t = time.time()
    clips, subs, tempos = [], [], []
    for i, g in enumerate(segs):
        if cancel_event and cancel_event.is_set():
            bgm_future.cancel()
            break
        subs.append({"start": round(g.start, 2), "end": round(min(g.end, c.end), 2), "zh": g.zh, "vi": g.vi})
        wav = work / f"c{c.index:03d}_{i:02d}.wav"
        try:
            eng.tts.synth(g.vi, wav)
            audio, tempo = load_fitted(wav, slots[i], s)
        except Exception as exc:  # one bad line must not kill the chunk
            print(f"[tts] skipped {g.vi!r}: {exc}", flush=True)
            continue
        end = min(g.end, c.end) - c.start
        off = max(g.start - c.start, end - len(audio) / s.mix_sr)  # right-align to the source end
        clips.append((off, audio))
        tempos.append(tempo)
        wav.unlink(missing_ok=True)
    t_tts = time.time() - t

    if cancel_event and cancel_event.is_set():
        bgm_future.cancel()
        return np.zeros((int((c.end - c.start) * s.mix_sr), 2), dtype=np.float32), [], {}

    mixed = mix_chunk(bgm_future.result(), clips, s)
    timing = {
        "asr": round(t_asr, 2), "translate": round(t_tr, 2), "tts": round(t_tts, 2),
        "total": round(time.time() - t_start + t_asr, 2), "max_atempo": round(max(tempos, default=1.0), 2),
    }
    return mixed, subs, timing
