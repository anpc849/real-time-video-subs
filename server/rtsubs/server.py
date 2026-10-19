"""Local HTTP API used by the Edge extension.

POST /jobs            {urls, duration?, referer?}  -> {job_id}   (urls: candidates; picked by duration)
GET  /jobs/{id}       -> status + per-chunk readiness + subtitles
POST /jobs/{id}/seek  {t}                      -> process chunks near t first
GET  /jobs/{id}/chunks/{i}.wav                 -> dubbed audio (stereo pcm16 @ mix_sr) for chunk i
"""
from __future__ import annotations

import io
import subprocess
import sys
import threading
import time
import uuid

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .chunker import Chunk, plan_chunks, speech_timestamps
from .config import Settings
from .pipeline import Engine, VideoSession, decode
from .translate import Translator

S = Settings()
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def private_network(request, call_next):  # Chrome/Edge Private Network Access preflight
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def _probe_duration(url: str, referer: str | None) -> float | None:
    """Duration of a URL that carries an audio stream; None for unreachable or video-only URLs
    (Douyin serves video and audio as separate DASH streams)."""
    base = ["ffprobe", "-v", "error"]
    if referer:
        base += ["-headers", f"Referer: {referer}\r\nUser-Agent: Mozilla/5.0\r\n"]
    try:
        audio = subprocess.run(base + ["-select_streams", "a", "-show_entries", "stream=codec_type", "-of",
                                       "csv=p=0", url], capture_output=True, text=True, timeout=20).stdout.strip()
        if not audio:
            return None
        out = subprocess.run(base + ["-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return float(out)
    except Exception:
        return None


def resolve_media_url(url: str, referer: str | None = None) -> str:
    return url


def pick_url(urls: list[str], duration: float, referer: str | None, exact: bool = False) -> str:
    """exact=True: the extension traced these URLs to the clicked <video> itself, so take the first one with
    audio (no duration guessing). Otherwise (fallback scan of the page's requests) the page may also have
    preloaded other videos: keep URLs with audio and take the closest duration."""
    if exact:
        for u in urls:
            resolved_u = resolve_media_url(u, referer)
            d = _probe_duration(resolved_u, referer)
            print(f"[pick exact] {d} {resolved_u[:100]}", flush=True)
            if d is not None:
                return resolved_u
        raise RuntimeError("the video's own stream has no audio track or is not reachable")
    best, best_err = None, 1e9
    for u in urls:
        resolved_u = resolve_media_url(u, referer)
        d = _probe_duration(resolved_u, referer)
        print(f"[pick] {d} {resolved_u[:100]}", flush=True)
        if d is None:
            continue
        err = abs(d - duration) if duration > 0 else 0.0
        if err < best_err:
            best, best_err = resolved_u, err
        if duration > 0 and err < 0.3:
            break
    if best is None:
        raise RuntimeError("no media URL with an audio stream among candidates")
    if duration > 0 and best_err > 2.0:
        raise RuntimeError(f"no candidate matches this video's duration ({duration:.1f}s, closest off by {best_err:.1f}s)")
    return best


class Job:
    def __init__(self, urls: list[str], duration: float, referer: str | None, exact: bool = False, start: float = 0.0,
                 transcript: list[dict] | None = None, transcript_lang: str | None = None):
        self.id = uuid.uuid4().hex[:8]
        self.urls, self.expected, self.referer, self.exact = urls, duration, referer, exact
        self.url = ""
        self.state = "loading"  # loading | running | done | error | cancelled
        self.error = ""
        self.duration = 0.0
        self.chunks: list[Chunk] = []
        self.audio: dict[int, bytes] = {}
        self.subs: dict[int, list[dict]] = {}
        self.timing: dict[int, dict] = {}
        self.pointer = 0
        self.initial_start = start
        self.transcript = transcript
        self.transcript_lang = transcript_lang
        self.session: VideoSession | None = None
        self.cancel = threading.Event()
        self.lock = threading.Lock()

    def next_chunk(self) -> int | None:
        todo = [c.index for c in self.chunks if c.index not in self.audio]
        if not todo:
            return None
        return next((i for i in todo if i >= self.pointer), todo[0])


engine: Engine | None = None
jobs: dict[str, Job] = {}
current: Job | None = None
gpu_lock = threading.Lock()


def _engine() -> Engine:
    global engine
    if engine is None:
        engine = Engine(S)
    return engine


def run_job(job: Job) -> None:
    try:
        if job.cancel.is_set():
            job.state = "cancelled"
            return

        work = S.workspace / "live" / job.id
        work.mkdir(parents=True, exist_ok=True)

        is_youtube = any("youtube.com" in u or "youtu.be" in u for u in job.urls) or ("youtube.com" in (job.referer or ""))
        if is_youtube:
            yt_url = next((u for u in job.urls if "youtube.com" in u or "youtu.be" in u), job.urls[0])
            job.url = yt_url
            print(f"[job {job.id}] Downloading YouTube audio via yt-dlp: {yt_url}", flush=True)

            def _ydl_hook(d):
                if job.cancel.is_set():
                    import yt_dlp.utils
                    raise yt_dlp.utils.DownloadCancelled("Job cancelled by client")

            import yt_dlp
            ydl_opts = {
                "format": "ba/b",
                "outtmpl": str(work / "source.%(ext)s"),
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "progress_hooks": [_ydl_hook],
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([yt_url])

            if job.cancel.is_set():
                job.state = "cancelled"
                return

            src_files = [f for f in work.glob("source.*") if not f.name.endswith(".part")]
            if not src_files:
                raise RuntimeError("Failed to locate downloaded YouTube audio file")
            src_audio = src_files[0]
            print(f"[job {job.id}] YouTube audio ready: {src_audio.name} ({src_audio.stat().st_size} bytes)", flush=True)

            a16 = decode(src_audio, 16000, 1)
            if job.cancel.is_set():
                job.state = "cancelled"
                return
            a44 = decode(src_audio, S.mix_sr, 2)
        else:
            job.url = pick_url(job.urls, job.expected, job.referer, job.exact)
            if job.cancel.is_set():
                job.state = "cancelled"
                return
            args = ["-headers", f"Referer: {job.referer}\r\nUser-Agent: Mozilla/5.0\r\n"] if job.referer else []
            a16 = decode(job.url, 16000, 1, args)
            if job.cancel.is_set():
                job.state = "cancelled"
                return
            a44 = decode(job.url, S.mix_sr, 2, args)

        if job.cancel.is_set():
            job.state = "cancelled"
            return
        job.duration = len(a16) / 16000

        if job.transcript and len(job.transcript) > 0:
            print(f"[job {job.id}] Using pre-existing transcript ({len(job.transcript)} cues, lang={job.transcript_lang})", flush=True)
            speech = [(float(c["start"]), float(c["end"])) for c in job.transcript if float(c.get("end", 0)) > float(c.get("start", 0))]
            if not speech:
                speech = speech_timestamps(a16)
        else:
            speech = speech_timestamps(a16)

        job.chunks = plan_chunks(job.duration, speech, S)
        if job.initial_start > 0:
            for c in job.chunks:
                if c.start <= job.initial_start < c.end:
                    job.pointer = c.index
                    break
        if job.cancel.is_set():
            job.state = "cancelled"
            return
        with gpu_lock:
            if job.cancel.is_set():
                job.state = "cancelled"
                return
            eng, tr = _engine(), Translator(S)
        session = VideoSession(eng, tr, a16, a44, job.chunks, transcript=job.transcript, transcript_lang=job.transcript_lang)
        job.session = session
        with gpu_lock:
            if job.cancel.is_set():
                job.state = "cancelled"
                return
            session.warm_up()  # ASR the first ~minute + story bible, then read ahead in the background
        if job.cancel.is_set():
            job.state = "cancelled"
            session.cancel.set()
            return
        job.state = "running"
        while not job.cancel.is_set():
            i = job.next_chunk()
            if i is None or job.cancel.is_set():
                break
            c = job.chunks[i]
            with gpu_lock:
                if job.cancel.is_set():
                    break
                mixed, subs, timing = session.process(i, work, cancel_event=job.cancel)
            if job.cancel.is_set():
                break
            buf = io.BytesIO()
            sf.write(buf, mixed, S.mix_sr, format="WAV", subtype="PCM_16")
            with job.lock:
                job.audio[i], job.subs[i], job.timing[i] = buf.getvalue(), subs, timing
            print(f"[job {job.id}] chunk {i} {c.end - c.start:.1f}s {timing} "
                  f"RTF={timing['total'] / (c.end - c.start):.2f}", flush=True)
        session.cancel.set()
        job.state = "cancelled" if job.cancel.is_set() else "done"
        print(f"[job {job.id}] finished with state: {job.state}", flush=True)
    except Exception as exc:
        if job.cancel.is_set():
            job.state = "cancelled"
            print(f"[job {job.id}] stopped cleanly on cancel: {exc}", flush=True)
            return
        job.state, job.error = "error", str(exc)
        print(f"[job {job.id}] error: {exc}", flush=True)
    finally:
        if job.session:
            job.session.cancel.set()


class NewJob(BaseModel):
    urls: list[str]
    exact: bool = False
    duration: float = 0.0
    referer: str | None = None
    start: float = 0.0
    transcript: list[dict] | None = None
    transcript_lang: str | None = None


class Seek(BaseModel):
    t: float


@app.post("/jobs")
def create_job(req: NewJob):
    global current
    if current and current.state in ("loading", "running"):
        current.cancel.set()
        if current.session:
            current.session.cancel.set()
        current.state = "cancelled"
    job = Job(req.urls, req.duration, req.referer, req.exact, start=req.start, transcript=req.transcript, transcript_lang=req.transcript_lang)
    jobs[job.id] = current = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"job_id": job.id}


@app.post("/jobs/{job_id}/stop")
@app.delete("/jobs/{job_id}")
def stop_job(job_id: str):
    if job_id not in jobs:
        return {"ok": False, "error": "unknown job"}
    j = jobs[job_id]
    j.cancel.set()
    if j.session:
        j.session.cancel.set()
    j.state = "cancelled"
    print(f"[server] Job {job_id} cancelled by client stop request", flush=True)
    return {"ok": True, "job_id": job_id, "state": "cancelled"}


@app.post("/jobs/stop-all")
def stop_all_jobs():
    count = 0
    for j in jobs.values():
        if j.state in ("loading", "running"):
            j.cancel.set()
            if j.session:
                j.session.cancel.set()
            j.state = "cancelled"
            count += 1
    print(f"[server] Cancelled {count} active jobs", flush=True)
    return {"ok": True, "cancelled": count}


def _job(job_id: str) -> Job:
    if job_id not in jobs:
        raise HTTPException(404, "unknown job")
    return jobs[job_id]


@app.get("/jobs/{job_id}")
def status(job_id: str):
    j = _job(job_id)
    with j.lock:
        return {
            "state": j.state, "error": j.error, "duration": j.duration,
            "chunks": [{"i": c.index, "start": c.start, "end": c.end, "ready": c.index in j.audio} for c in j.chunks],
            "subs": [s for i in sorted(j.subs) for s in j.subs[i]],
            "sample_rate": S.mix_sr,
        }


@app.post("/jobs/{job_id}/seek")
def seek(job_id: str, req: Seek):
    j = _job(job_id)
    j.pointer = next((c.index for c in j.chunks if c.start <= req.t < c.end), 0)
    return {"pointer": j.pointer}


@app.get("/jobs/{job_id}/chunks/{index}.wav")
def chunk_audio(job_id: str, index: int):
    j = _job(job_id)
    with j.lock:
        data = j.audio.get(index)
    if data is None:
        raise HTTPException(404, "chunk not ready")
    return Response(data, media_type="audio/wav")


@app.get("/health")
def health():
    return {"ok": True, "engine_loaded": engine is not None}


def main() -> None:
    _engine()  # load models up front so the first request is not slow
    print("[server] models ready", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
