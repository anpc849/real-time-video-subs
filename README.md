# Real-time Vietnamese Dub & Sub (`rtsubs`) 🎙️🇻🇳

An end-to-end, near real-time Vietnamese dubbing and subtitling system for streaming web videos (Douyin, TikTok, YouTube, Bilibili, Coursera, etc.). It combines a lightweight Chromium browser extension with a high-performance local AI pipeline server.

---

## 🌟 Key Features

- **Vocal Separation & Background Music Preservation:** Employs `Demucs` (`htdemucs`) to strip original vocals while retaining background music (BGM) and sound effects (SFX), with automated audio ducking when Vietnamese dubbing audio plays.
- **Fast Speech Recognition (ASR):** Uses `faster-whisper` (`large-v3-turbo`) guided by `silero-vad` for intelligent, sentence-boundary chunking (~8–16s) to minimize latency.
- **Context-Aware LLM Translation:** Powered by OpenRouter / OpenAI-compatible APIs (e.g. `google/gemma-4-31b-it`). Maintains dynamic "Story Bible" memory and conversational context across chunks to keep character pronouns and narrative tone consistent.
- **Expressive Vietnamese Text-to-Speech:** Integrated with `VieNeu-TTS v3-Turbo` (quantized ONNX int8) for natural voice synthesis with fast inference.
- **Sleek Browser Extension (Manifest V3):** Injects directly into video players, synchronizes dubbing audio with playback speed/pauses, and displays a customizable floating subtitle banner.
- **Offline Batch Processing:** Includes a standalone CLI tool to dub local video files into fully muxed MP4 files.

---

## 🏗️ Architecture & Pipeline

```
  Browser (Chromium Extension)
         │  (Audio Stream / Media URLs)
         ▼
   FastAPI Server (localhost:8765)
         │
         ├── 1. Silero VAD & Chunker (Splits speech at natural pauses ~8-16s)
         │
         ├── 2. Faster-Whisper ASR (Transcribes original spoken audio)
         │
         ├── 3. LLM Translation (Translates with context window & Story Bible)
         │
         ├── 4. Demucs Separation (Extracts instrumental/ambient track)
         │
         ├── 5. VieNeu-TTS Engine (Generates expressive Vietnamese speech)
         │
         └── 6. Audio Ducking & Mixer (Blends BGM + Voiceover -> Stereo WAV)
         │
         ▼
  Browser Extension receives audio chunk & subtitle cues -> Plays in sync
```

---

## 📋 Prerequisites

1. **Operating System:** Windows 10/11 (or Linux)
2. **GPU:** NVIDIA GPU with CUDA support is strongly recommended for real-time Demucs and Whisper processing.
3. **FFmpeg:** Must have `ffmpeg` and `ffprobe` installed and added to system `PATH`.
   - *Windows (via winget):* `winget install Gyan.FFmpeg`
   - *Verify:* Run `ffmpeg -version` and `ffprobe -version` in terminal.
4. **Python:** Version 3.10 or 3.11 (Miniconda / Anaconda recommended).

---

## 🚀 Installation & Setup

### 1. Clone the repository
```bash
git clone https://github.com/your-username/real-time-video-subs.git
cd real-time-video-subs
```

### 2. Configure Python Environments

To avoid package conflicts, two separate Conda environments are recommended:

#### Environment 1: `rtsubs` (Main Server, Whisper, Demucs, PyTorch)
```bash
conda create -n rtsubs python=3.11 -y
conda activate rtsubs

# Install PyTorch with CUDA (e.g., CUDA 12.4):
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Install core pipeline dependencies:
pip install -r requirements.txt
```

#### Environment 2: `vieneu-tts` (Vietnamese TTS Engine)
```bash
conda create -n vieneu-tts python=3.11 -y
conda activate vieneu-tts

pip install -r requirements-vieneu.txt
```

---

## ⚙️ Environment Configuration

Copy the example configuration file and enter your API credentials:

```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
# LLM Translation API (OpenRouter or OpenAI-compatible endpoint)
TRANSLATION_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=your_api_key_here
TRANSLATION_MODEL=google/gemma-4-31b-it

# Path to Python executable with VieNeu-TTS installed (optional if using default miniconda location)
# VIENEU_PYTHON=C:/Users/your_username/miniconda3/envs/vieneu-tts/python.exe
```

> **Note:** Required VieNeu ONNX models and codec weights will automatically download to `models/` on the first launch.

---

## 🖥️ Usage

### Step 1: Start the Backend Server
Run the provided batch script on Windows:
```cmd
run_server.bat
```
Or start manually from the `rtsubs` environment:
```bash
conda activate rtsubs
python -m rtsubs.server
```
Wait until the initialization finishes:
```
[server] models ready
INFO:     Uvicorn running on http://127.0.0.1:8765
```

### Step 2: Load the Browser Extension
1. Open your Chromium browser (Microsoft Edge, Google Chrome, Brave, etc.).
2. Navigate to extensions:
   - Microsoft Edge: `edge://extensions`
   - Google Chrome: `chrome://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension` folder in this repository.

### Step 3: Stream & Dub Videos
1. Open any video on supported websites (Douyin, TikTok, YouTube, Bilibili, Coursera).
2. Click the floating **`VI ⏻`** button at the top-right corner of the video player.
3. The video will pause briefly (1–3 seconds) to prefetch the first audio chunk, then resume playback with live Vietnamese dubbing and synced subtitles.

#### Subtitle Controls:
- **Drag & Move:** Click and drag the subtitle bar anywhere on screen.
- **Resize Font:** Scroll the mouse wheel up or down over the subtitle bar.
- **Reset Position:** Double-click the subtitle bar.

---

## 🎬 Offline Video File Processing (CLI)

You can also dub a local video file directly without the browser:

```bash
conda activate rtsubs
python -m rtsubs.run_file path/to/video.mp4 --max-sec 60
```
The output dubbed video (`dubbed.mp4`), combined audio (`dubbed.wav`), and subtitle cues (`subs.json`) will be generated inside the `workspace/` folder.

---

## 🧪 Local UI Testing

To test the extension overlay and UI behavior locally:
1. Start the main server: `run_server.bat`
2. Start a simple static server from the repo root in another terminal:
   ```bash
   python -m http.server 8000
   ```
3. Place a sample video at `samples/5.mp4` and open `http://localhost:8000/extension/test/index.html`.

---

## 📂 Project Structure

```
real-time-video-subs/
├── extension/                  # Chromium Extension (Manifest V3)
│   ├── manifest.json           # Extension configuration & host permissions
│   ├── content.js              # Overlay UI, audio sync, and server communication
│   ├── page_hook.js            # Video player media interception
│   └── test/                   # Local HTML test fixture
├── server/
│   └── rtsubs/                 # Core server & pipeline package
│       ├── server.py           # FastAPI server & endpoints
│       ├── pipeline.py         # Chunker, ASR, translation & mixing orchestrator
│       ├── asr.py              # Faster-Whisper ASR engine
│       ├── chunker.py          # Silero VAD & audio chunk scheduler
│       ├── separate.py         # Demucs vocal separation
│       ├── translate.py        # LLM translator with context & Story Bible
│       ├── tts.py              # VieNeu resident process manager
│       ├── vieneu_server.py    # Standalone VieNeu-TTS worker
│       ├── mixer.py            # Audio ducking and mixer
│       └── config.py           # Application settings
├── run_server.bat              # Quick-start script for Windows
├── requirements.txt            # Python dependencies for main server
├── requirements-vieneu.txt     # Python dependencies for VieNeu TTS
├── .env.example                # Example environment configuration
├── .gitignore                  # Git ignore rules
├── LICENSE                     # MIT License
└── README.md                   # Documentation
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
