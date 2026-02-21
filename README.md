<div align="center">

# 🎧 Audiobook Maker

### Transform EPUBs into Beautiful Audiobooks with AI

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10--3.12-3776AB?logo=python&logoColor=white)](https://python.org/)

<img src="photo.png" alt="Audiobook Maker Preview" width="600" />

*Generate studio-quality audiobooks from EPUB files using the advanced Kokoro TTS engine*

[Getting Started](#-quick-start) • [Features](#-features) • [Documentation](#-usage) • [Contributing](#-contributing)

</div>

---

## ✨ Features

<table>
<tr>
<td>

🎨 **Beautiful Interactive CLI**
Gorgeous terminal UI with gradient colors, ASCII art, and smooth animations

</td>
<td>

📚 **Batch Processing**
Convert multiple EPUBs at once using glob patterns (`*.epub`)

</td>
</tr>
<tr>
<td>

🎙️ **11+ Premium Voices**
Choose from American & British accents, male & female voices

</td>
<td>

⚡ **Speed Control**
Adjust playback speed from 0.75x to 1.5x

</td>
</tr>
<tr>
<td>

📊 **Real-time GPU Monitoring**
Live GPU usage visualization with sparklines (Apple Silicon)

</td>
<td>

🧩 **Pipeline Visualization**
Watch GPU inference and background encoding progress in real-time

</td>
</tr>
<tr>
<td>

🚀 **Optimized Pipeline**
Sequential GPU inference + background encoding for maximum throughput on Apple Silicon

</td>
<td>

🔧 **Highly Configurable**
Tune chunk size and more for optimal performance

</td>
</tr>
</table>

---

## 🚀 Quick Start

### One-Command Setup (macOS)

```bash
# 1. Clone the repository
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast

# 2. Run the setup script (installs everything!)
./setup.sh

# 3. Start making audiobooks
cd cli && npm run dev
```

The setup script will automatically:
- Install Homebrew (if needed)
- Install FFmpeg, Python 3.12, and Node.js
- Set up the Python virtual environment
- Install all dependencies
- Optionally pre-download the AI model (~1GB)

### Manual Installation

<details>
<summary>Click to expand manual setup instructions</summary>

#### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | For the interactive CLI |
| Python | 3.10–3.12 | Kokoro TTS doesn't support 3.13+ yet |
| FFmpeg | Latest | Required for MP3 export |

#### Steps

```bash
# 1. Clone the repository
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast

# 2. Install FFmpeg (macOS)
brew install ffmpeg

# 3. Set up Python environment
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 4. Install CLI dependencies
cd cli && npm install
```

</details>

### Launch

```bash
# Start the interactive dashboard UI
cd cli && npm run dev

# Explicitly launch dashboard mode
cd cli && npm run dev -- tui
```

---

## 📖 Usage

### Interactive Dashboard *(Recommended)*

Launch the terminal dashboard:

```bash
cd cli && npm run dev
```

Core shortcuts:
- `Tab` / `Shift+Tab` switch focus panels
- `1` files panel, `2` config panel, `5` quick actions panel
- `Enter` edit selected config or run selected action
- `p` start batch
- `Ctrl+S` save preset, `Ctrl+L` load preset
- `?` help overlay

### Non-Interactive Mode

Use the new command surface for scripts and CI:

```bash
# Run a full batch from globs/paths
cd cli && npm run dev -- run --input \"./books/*.epub\" --backend auto --format m4b

# Run environment checks
cd cli && npm run dev -- doctor

# Manage presets
cd cli && npm run dev -- presets list
cd cli && npm run dev -- presets save weekday-batch
cd cli && npm run dev -- presets export weekday-batch --out ./weekday-batch.profile.json
```

<details>
<summary><strong>📋 All Command Line Options</strong></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `run --input <pathOrGlob...>` | *required* | File(s), directories, or glob patterns |
| `--preset <name>` | none | Load a saved preset |
| `--profile <path>` | none | Load profile JSON |
| `--output-dir <path>` | same as input | Output directory |
| `--format` | `mp3` | `mp3` or `m4b` |
| `--voice` | `af_heart` | Voice selection (see below) |
| `--lang-code` | `a` | Accent code (`a`/`b`) |
| `--speed` | `1.0` | Speech speed |
| `--backend` | `auto` | `auto`, `pytorch`, `mlx`, `mock` |
| `--bitrate` | `192k` | `128k`, `192k`, `320k` |
| `--normalize` | off | Enable loudness normalization |
| `--checkpoint` | off | Enable checkpoint writes |
| `--resume` | off | Resume from available checkpoints |
| `--json` | off | Emit machine-readable summary |

</details>

---

## 🎙️ Available Voices

<table>
<tr>
<th colspan="2">🇺🇸 American English</th>
<th colspan="2">🇬🇧 British English</th>
</tr>
<tr>
<td><code>af_heart</code></td>
<td>Female — Warm & Friendly</td>
<td><code>bf_emma</code></td>
<td>Female — Elegant</td>
</tr>
<tr>
<td><code>af_bella</code></td>
<td>Female — Confident</td>
<td><code>bf_isabella</code></td>
<td>Female — Sophisticated</td>
</tr>
<tr>
<td><code>af_nicole</code></td>
<td>Female — Friendly</td>
<td><code>bm_george</code></td>
<td>Male — Classic</td>
</tr>
<tr>
<td><code>af_sarah</code></td>
<td>Female — Professional</td>
<td><code>bm_lewis</code></td>
<td>Male — Modern</td>
</tr>
<tr>
<td><code>af_sky</code></td>
<td>Female — Energetic</td>
<td></td>
<td></td>
</tr>
<tr>
<td><code>am_adam</code></td>
<td>Male — Calm</td>
<td></td>
<td></td>
</tr>
<tr>
<td><code>am_michael</code></td>
<td>Male — Authoritative</td>
<td></td>
<td></td>
</tr>
</table>

---

## 🖥️ CLI Preview

```
  🎧 Processing Audiobooks

╭─────────────────────────────────────╮
│                                     │
│  Currently Processing:              │
│  Book1.epub                         │
│                                     │
│  Chunk: 14/35 (40%)                 │
│  ████████████░░░░░░░░░░░░░░░░░░     │
│                                     │
╰─────────────────────────────────────╯

╭− 👷 Processing ─────────────────────╮
│                                     │
│  GPU: INFER  Chunk 15/35            │
│  Encoder: Converting to int16       │
│                                     │
╰─────────────────────────────────────╯

╭──────────────────────────────────────────────╮
│                                              │
│  Overall Progress: 1/2 files                 │
│  ⏱️  ETA: 45 sec                             │
│                                              │
│  ██████████████████████░░░░░░░░░░░░░░░░░░░░  │
│                                              │
╰──────────────────────────────────────────────╯

 GPU Usage:  ▇▄ ▆▃ █▅ ▂▄ ▆▃ 
 Memory:     3.2 GB / 16 GB

 📚 Files
   ✔ Book_Volume_1.epub → saved
   ► Book_Volume_2.epub
       ████████████░░░░░░░░░░░░░░░░░ (40%)
   ⏳ Book_Volume_3.epub
```

---

## 🏗️ Architecture

For a detailed technical overview of the project structure and data flow, please refer to [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 📝 Technical Notes

- **Optimized Pipeline** — Sequential GPU inference (main thread) + background CPU encoding thread. This avoids GPU contention that slows down multi-threaded approaches on MPS
- **O(n) Audio Assembly** — Stores int16 numpy arrays during processing, concatenates once at the end (vs O(n²) AudioSegment concatenation)
- **Audio Export** — Uses FFmpeg via `pydub` for high-quality MP3 encoding
- **ETA Calculation** — Based on rolling average, stabilizes after first few chunks
- **Output Naming** — Files are saved with the same name as input (`.epub` → `.mp3`)
- **GPU Support** — Apple Silicon Macs use MPS acceleration with optimized memory settings

### Performance Tips

```bash
# For maximum speed on Apple Silicon:
python app.py --input book.epub --output book.mp3
```

- **Workers**: On Apple Silicon, 1-2 workers is optimal. The GPU serializes operations via MPS, so more workers add overhead without speedup
- **Chunk size**: Defaults are optimized per backend (900 for MLX, 600 for PyTorch). Override with `--chunk_chars` if needed
- **Memory**: The optimized pipeline uses O(n) audio concatenation, keeping memory usage flat even for large books

---

## 🧪 Testing

### Fast local checks

```bash
# Python (skips slow marker)
.venv/bin/python -m pytest -m "not slow" --cov=app --cov-fail-under=75

# CLI
npm test --prefix cli
npm run test:coverage --prefix cli
```

### Full subprocess E2E checks

```bash
# Python subprocess E2E (uses --backend mock internally)
.venv/bin/python -m pytest tests/e2e

# Slow real ffmpeg validation
.venv/bin/python -m pytest -m slow
```

### CI quality gates
- Python coverage gate: `app.py` must stay at or above **75%**
- CLI coverage gates (Vitest): **60%** statements/functions/lines and **50%** branches
- Scheduled/manual CI also runs `pytest -m slow` for real ffmpeg/M4B validation

---

## 🤝 Contributing

Contributions are welcome! Feel free to:

- 🐛 Report bugs
- 💡 Suggest new features
- 🔧 Submit pull requests

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

**Made with ❤️ by [Li-Chen Wang](https://github.com/lichen0114)**

*Powered by [Kokoro TTS](https://github.com/hexgrad/kokoro)*

</div>
