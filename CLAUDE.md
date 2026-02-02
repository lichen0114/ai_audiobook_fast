# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Audiobook Fast converts EPUB files into MP3 audiobooks using the Kokoro TTS engine. It has a two-tier architecture:
- **Frontend CLI** (`cli/`): Node.js/TypeScript/React terminal UI using Ink
- **Backend** (`app.py`): Python script handling EPUB parsing and TTS generation

The CLI spawns the Python process and communicates via stdout (IPC protocol with structured messages).

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
python app.py --input book.epub --output book.mp3 --voice af_heart --speed 1.0
```

## Architecture

### Frontend (cli/src/)
- `index.tsx` - Entry point
- `App.tsx` - Main component with state machine: `welcome` → `files` → `config` → `processing` → `done`
- `components/` - UI components (Header, FileSelector, ConfigPanel, BatchProgress, GpuMonitor, KeyboardHint)
- `utils/tts-runner.ts` - Spawns Python process, sets MPS env vars, parses stdout progress

### Backend (app.py)
Uses sequential GPU inference + background encoding (optimized for Apple Silicon MPS):
1. Main thread extracts EPUB text, splits into ~1200-char chunks
2. Main thread runs Kokoro inference sequentially (GPU), queues audio for encoding
3. Background thread converts audio tensors to int16 numpy arrays
4. Results stored as numpy arrays, concatenated with `np.concatenate()` (O(n) vs O(n²))
5. Raw PCM piped directly to ffmpeg for MP3 export (bypasses WAV 4GB limit)

**Why not multi-threaded GPU?** MPS serializes GPU operations, so multiple workers queue up waiting. Testing showed 0.88x slower with threading.

**Why direct ffmpeg instead of pydub?** pydub's `export()` creates an intermediate WAV file, which has a 4GB limit (~24.9 hours at 24kHz 16-bit mono). Long audiobooks exceed this. The `export_pcm_to_mp3()` function pipes raw PCM via stdin to ffmpeg, avoiding this limitation.

Key Python args: `--input`, `--output`, `--voice`, `--speed`, `--chunk_chars`

### IPC Protocol
Python outputs to stdout, parsed by `tts-runner.ts`:
```
PHASE:PARSING              # Before text extraction
PHASE:INFERENCE            # Before inference loop
PHASE:CONCATENATING        # Before np.concatenate()
PHASE:EXPORTING            # Before MP3 export
METADATA:total_chars:N     # After text extraction (character count)
WORKER:0:INFER:Chunk X/Y   # Per-chunk inference status
TIMING:chunk_idx:ms        # Per-chunk timing in milliseconds
HEARTBEAT:timestamp        # Every 5 seconds during inference
PROGRESS:N/M chunks        # Overall progress
```

### MPS Environment Variables
When MPS is enabled, `tts-runner.ts` sets:
- `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` - Aggressive memory cleanup
- `OMP_NUM_THREADS=4` / `OPENBLAS_NUM_THREADS=2` - Reduce GIL contention

## Key Dependencies

- **Python**: kokoro (TTS), ebooklib (EPUB), torch, numpy
- **Node.js**: react, ink (terminal UI), commander (CLI args), glob (file patterns)
- **System**: FFmpeg (required for MP3 export), Python 3.10-3.12 (Kokoro requirement)

## Voice Options

American: `af_heart` (default), `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael`
British: `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis`
