"""Chunked pipeline runner on a local file. Usage: python -m rtsubs.run_file <video> [--max-sec N]"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


import numpy as np
import soundfile as sf

from .chunker import plan_chunks, speech_timestamps
from .config import Settings
from .pipeline import Engine, VideoSession, decode
from .translate import Translator


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--max-sec", type=float, default=0)
    args = ap.parse_args()

    s = Settings()
    out_dir = s.workspace / args.video.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    a16, a44 = decode(args.video, 16000, 1), decode(args.video, s.mix_sr, 2)
    duration = min(len(a16) / 16000, args.max_sec or 1e9)
    chunks = plan_chunks(duration, [t for t in speech_timestamps(a16) if t[0] < duration], s)

    eng, tr = Engine(s), Translator(s)
    session = VideoSession(eng, tr, a16, a44, chunks)
    t0 = time.time()
    session.warm_up()
    print(f"[warm-up] chunk 0 transcribed + bible in {time.time() - t0:.1f}s", flush=True)
    mixed, subs, total = [], [], 0.0
    for c in chunks:
        audio, cs, tm = session.process(c.index, out_dir)
        mixed.append(audio)
        subs += cs
        total += tm["total"]
        dur = c.end - c.start
        print(f"[chunk {c.index:02d}] {dur:5.1f}s {tm} RTF={tm['total'] / dur:.2f}", flush=True)

    sf.write(str(out_dir / "dubbed.wav"), np.concatenate(mixed), s.mix_sr)
    (out_dir / "subs.json").write_text(json.dumps(subs, ensure_ascii=False, indent=1), encoding="utf-8")
    final = out_dir / "dubbed.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(args.video), "-i", str(out_dir / "dubbed.wav"),
                    "-map", "0:v", "-map", "1:a", "-t", f"{duration:.2f}", "-c:v", "copy", "-c:a", "aac",
                    "-b:a", "192k", str(final)], check=True)
    print(f"[done] {duration:.0f}s audio in {total:.1f}s, overall RTF={total / duration:.2f} -> {final}")
    eng.close()


if __name__ == "__main__":
    main()
