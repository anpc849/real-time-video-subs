from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_env() -> None:
    env = ROOT / ".env"
    if not env.is_file():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_env()


@dataclass
class Settings:
    workspace: Path = ROOT / "workspace"
    vieneu_python: str = os.environ.get(
        "VIENEU_PYTHON", str(Path.home() / "miniconda3/envs/vieneu-tts/python.exe")
    )
    vieneu_model_dir: Path = ROOT / "models/vieneu/v3-turbo"
    vieneu_codec_dir: Path = ROOT / "models/vieneu/codec"
    vieneu_voice: str = "Trúc Ly"
    whisper_model: str = "large-v3-turbo"
    whisper_compute: str = "int8_float16"
    demucs_model: str = "htdemucs"
    demucs_margin_sec: float = 1.0
    chunk_min_sec: float = 8.0
    chunk_target_sec: float = 12.0
    chunk_max_sec: float = 16.0
    mix_sr: int = 44100
    chars_per_sec: float = 18.0  # Vietnamese TTS budget for translation brevity
    duck_gain: float = 0.35  # BGM gain while a Vietnamese line is speaking
    bgm_gain: float = 1.0
    tts_gain: float = 1.4
    base_url: str = field(default_factory=lambda: os.environ.get("TRANSLATION_BASE_URL", ""))
    api_key: str = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY", "") or "dummy")
    model: str = field(default_factory=lambda: os.environ.get("TRANSLATION_MODEL", ""))
    context_pairs: int = 10
    story_lookahead_sec: float = 90.0  # background ASR stays at most this far ahead of the chunk being processed
    bible_every: int = 3  # rebuild the story bible after this many newly transcribed chunks
    transcript_max_chars: int = 20000  # cap on the source transcript placed in the prompt
