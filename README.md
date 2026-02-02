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

📊 **Real-time Progress**
Live progress bars with accurate ETA calculations

</td>
<td>

🖥️ **GPU Acceleration**
Native Apple Silicon support for lightning-fast processing

</td>
</tr>
</table>

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 18+ | For the interactive CLI |
| Python | 3.10–3.12 | Kokoro TTS doesn't support 3.13+ yet |
| FFmpeg | Latest | Required for MP3 export |

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast

# 2. Install FFmpeg (macOS)
brew install ffmpeg

# 3. Set up Python environment
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 4. Install CLI dependencies
cd cli && npm install
```

### Launch

```bash
# Start the interactive CLI
cd cli && npm run dev

# For Apple Silicon GPU acceleration
PYTORCH_ENABLE_MPS_FALLBACK=1 npm run dev
```

---

## 📖 Usage

### Interactive Mode *(Recommended)*

Launch the beautiful terminal interface:

```bash
npm run dev
```

The interactive CLI guides you through:
1. 📂 **File Selection** — Choose single files, folders, or use patterns like `*.epub`
2. ⚙️ **Configuration** — Pick your voice, adjust speed, and set language
3. 🎧 **Processing** — Watch real-time progress as audiobooks are generated

### Command Line Mode

For scripting and automation:

```bash
python app.py --input /path/to/book.epub --output /path/to/book.mp3
```

<details>
<summary><strong>📋 All Command Line Options</strong></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | *required* | Path to input EPUB file |
| `--output` | *required* | Path to output MP3 file |
| `--voice` | `af_heart` | Voice selection (see below) |
| `--lang_code` | `a` | Language code |
| `--speed` | `1.0` | Speech speed (0.75–1.5) |
| `--chunk_chars` | `1200` | Characters per audio chunk |

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

---

## 📝 Technical Notes

- **Audio Export** — Uses FFmpeg via `pydub` for high-quality MP3 encoding
- **ETA Calculation** — Based on rolling average, stabilizes after first few chunks
- **Output Naming** — Files are saved with the same name as input (`.epub` → `.mp3`)
- **GPU Support** — Apple Silicon Macs can use MPS acceleration for 2-3x faster processing

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
