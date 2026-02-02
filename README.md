# EPUB → MP3 Generator (Kokoro TTS)

![Audiobook Maker](photo.png)

Generate high-quality audiobook MP3s from EPUB files using the Kokoro TTS model.

## ✨ Features

- 🎨 **Beautiful Interactive CLI** - Gorgeous terminal UI with gradient colors and animations
- 📚 **Batch Processing** - Convert multiple EPUBs at once with glob patterns
- 🎙️ **Multiple Voices** - Choose from various American and British voices
- ⚡ **Speed Control** - Adjust reading speed from 0.75x to 1.5x
- 📊 **Progress Tracking** - Real-time progress bars with ETA
- 🖥️ **GPU Monitoring** - Real-time GPU usage display for Apple Silicon Macs

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+** for the CLI
- **Python 3.10–3.12** (Kokoro does not support 3.13+ yet)
- **FFmpeg** for MP3 export

```bash
# Install FFmpeg (macOS)
brew install ffmpeg

# Setup Python environment
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Install CLI dependencies
cd cli && npm install
```

### Interactive Mode (Recommended)

```bash
# From the project root directory:
cd cli && npm run dev

# Or if you're already in the cli directory:
npm run dev
```

This launches the beautiful interactive CLI where you can:
1. 📂 Select EPUB files (single file, folder, or `*.epub` patterns)
2. ⚙️ Configure voice and speed settings
3. 🎧 Watch progress as your audiobooks are generated

### Command Line Usage (Original)

For scripting or simple use cases:

```bash
python app.py --input /path/to/book.epub --output /path/to/book.mp3
```

#### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | *required* | Path to input EPUB |
| `--output` | *required* | Path to output MP3 |
| `--voice` | `af_heart` | Kokoro voice (see available voices below) |
| `--lang_code` | `a` | Language code |
| `--speed` | `1.0` | Speech speed multiplier |
| `--chunk_chars` | `1200` | Max characters per chunk |

#### Available Voices

| Voice | Description |
|-------|-------------|
| `af_heart` | American Female - Warm |
| `af_bella` | American Female - Confident |
| `af_nicole` | American Female - Friendly |
| `af_sarah` | American Female - Professional |
| `af_sky` | American Female - Energetic |
| `am_adam` | American Male - Calm |
| `am_michael` | American Male - Authoritative |
| `bf_emma` | British Female - Elegant |
| `bf_isabella` | British Female - Sophisticated |
| `bm_george` | British Male - Classic |
| `bm_lewis` | British Male - Modern |

## 🖥️ CLI Preview

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🎧  A U D I O B O O K   M A K E R  🎧                   ║
║                                                           ║
║   ✨ Transform your EPUBs into beautiful audiobooks ✨    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝

📚 Selected Files (2)
├── Book1.epub
└── Book2.epub

⚙️  Settings
├── Voice: 💜 af_heart (American Female - Warm)
├── Speed: ▶️  1.0x - Normal
└── Language: English

📊 Processing
├── ✅ Book1.epub - Done
└── ⏳ Book2.epub - [████████░░░░░░░░░░░░] 40%

⏱️  ETA: 2 min
```

## 🔧 Apple Silicon GPU Acceleration

For faster processing on Apple Silicon Macs:

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 npm run dev
```

## 📝 Notes

- MP3 export uses FFmpeg via `pydub`
- ETA is based on average processing speed and stabilizes after the first few chunks
- Output files are saved with the same name as input (`.epub` → `.mp3`)
