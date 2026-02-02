# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Audiobook Fast converts EPUB files into MP3 audiobooks using the Kokoro TTS engine. It has a two-tier architecture:
- **Frontend CLI** (`cli/`): Node.js/TypeScript/React terminal UI using Ink
- **Backend** (`app.py`): Python script handling EPUB parsing and TTS generation

The CLI spawns the Python process and communicates via stdout (IPC protocol with structured messages like `WORKER:0:INFER:Chunk 5/50`).

## Common Commands

### Setup
```bash
# Python environment
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# CLI dependencies
cd cli && npm install
```

### Development
```bash
cd cli
npm run dev              # Start interactive CLI
npm run dev:mps          # With Apple Silicon GPU acceleration
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled version
```

### Direct Python Usage
```bash
python app.py --input book.epub --output book.mp3 --voice af_heart --speed 1.0 --workers 4
```

## Architecture

### Frontend (cli/src/)
- `index.tsx` - Entry point
- `App.tsx` - Main component with state machine: `welcome` → `files` → `config` → `processing` → `done`
- `components/` - UI components (Header, FileSelector, ConfigPanel, BatchProgress, GpuMonitor)
- `utils/tts-runner.ts` - Spawns Python process and parses stdout progress messages

### Backend (app.py)
Uses producer-consumer pattern with threading:
1. Main thread extracts EPUB text, splits into ~1200-char chunks, pushes to queue
2. Worker threads pull chunks, run Kokoro inference (GPU), encode audio (CPU)
3. Results stored in thread-safe dict keyed by chunk index
4. Main thread reassembles segments in order, exports to MP3

Key Python args: `--input`, `--output`, `--voice`, `--speed`, `--workers`, `--chunk_chars`

### IPC Protocol
Python outputs to stdout:
- `WORKER:N:INFER:Chunk X/Y` - Worker status
- `PROGRESS:N/M chunks` - Overall progress

CLI parses these in `tts-runner.ts` and updates UI.

## Key Dependencies

- **Python**: kokoro (TTS), ebooklib (EPUB), pydub (audio), torch
- **Node.js**: react, ink (terminal UI), commander (CLI args), glob (file patterns)
- **System**: FFmpeg (required for MP3 export)

## Voice Options

American: `af_heart` (default), `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael`
British: `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis`
