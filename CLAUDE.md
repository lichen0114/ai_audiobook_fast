# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Audiobook Fast converts EPUB files into MP3 or M4B audiobooks using Kokoro TTS. It has a two-tier architecture:
- **Frontend CLI** (`cli/`): Node.js/TypeScript/React terminal UI using Ink
- **Backend** (`app.py`): Python script handling EPUB parsing and TTS generation

The CLI spawns the Python process and communicates via stdout (IPC protocol with structured messages).

## Common Commands

### Setup
```bash
./setup.sh                      # One-command setup (installs everything)

# Manual setup
python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
cd cli && npm install
```

### Development
```bash
cd cli
npm run dev                     # Start interactive CLI
npm run dev:mps                 # With Apple Silicon GPU acceleration
npm run build                   # Compile TypeScript
```

### Testing
```bash
# Python (from repo root)
pytest                          # All tests with coverage
pytest tests/unit               # Unit tests only
pytest tests/integration        # Integration tests only
pytest -k test_clean_text       # Single test by name
pytest -m slow                  # Only slow tests
pytest -m "not slow"            # Skip slow tests

# CLI (from cli/)
npm test                        # All tests
npm run test:watch              # Watch mode
npm run test:coverage           # With coverage
```

### Direct Python Usage
```bash
python app.py --input book.epub --output book.mp3 --voice af_heart --speed 1.0
python app.py --backend mlx --input book.epub --output book.mp3  # MLX backend (faster)
python app.py --format m4b --input book.epub --output book.m4b   # M4B with chapters
```

## Architecture

### Backend Abstraction Layer (`backends/`)
TTS backends are pluggable via an abstraction layer:
- `base.py` - `TTSBackend` abstract base class defining the interface (`initialize`, `generate`, `cleanup`)
- `kokoro_pytorch.py` - Default PyTorch/Kokoro implementation (uses MPS on Apple Silicon)
- `kokoro_mlx.py` - MLX implementation for faster inference on Apple Silicon
- `factory.py` - `create_backend(type)` factory function, `get_available_backends()` for discovery

The `--backend` flag selects which backend to use (`pytorch` or `mlx`). MLX requires separate installation (`pip install -r requirements-mlx.txt`).

### Frontend (`cli/src/`)
- `App.tsx` - Main component with state machine: `checking` → `setup-required`|`welcome` → `files` → `config` → `processing` → `done`
- `utils/tts-runner.ts` - Spawns Python process, sets MPS env vars (PyTorch only), parses stdout progress
- `utils/preflight.ts` - Checks for FFmpeg, Python venv, Kokoro, and optionally MLX

### Backend (`app.py`)
Sequential inference + background encoding pipeline:
1. Extract EPUB text and metadata, split into chunks (default: 900 chars for MLX, 600 for PyTorch)
2. Backend generates audio sequentially, queues for encoding
3. Background thread(s) convert audio to int16 numpy arrays (`--workers` controls parallelism)
4. Results concatenated with `np.concatenate()` (O(n) vs O(n²)), tracking chapter sample positions
5. Raw PCM piped to ffmpeg for MP3/M4B export (bypasses WAV 4GB limit)

**Why sequential GPU?** MPS serializes GPU operations; threading is 0.88x slower.

**Why direct ffmpeg?** pydub creates intermediate WAV files with a 4GB limit (~24.9 hours). Long audiobooks exceed this.

### Output Formats
- **MP3** (default): Standard audio format
- **M4B**: Audiobook format with embedded chapter markers, book metadata (title/author), and cover art extracted from EPUB

Key M4B functions in `app.py`:
- `extract_epub_metadata()` - Extracts title, author, cover from EPUB
- `generate_ffmetadata()` - Creates FFMETADATA1 format for chapter markers
- `export_pcm_to_m4b()` - Pipes PCM to ffmpeg with AAC encoding + chapters + cover
- `split_text_to_chunks()` - Returns `(chunks, chapter_start_indices)` tuple for chapter tracking

### IPC Protocol
Python outputs to stdout, parsed by `tts-runner.ts`:
```
PHASE:PARSING              # Before text extraction
PHASE:INFERENCE            # Before inference loop
PHASE:CONCATENATING        # Before np.concatenate()
PHASE:EXPORTING            # Before MP3/M4B export
METADATA:total_chars:N     # Character count
METADATA:chapter_count:N   # Number of chapters
WORKER:0:INFER:Chunk X/Y   # Per-chunk status
TIMING:chunk_idx:ms        # Per-chunk timing
HEARTBEAT:timestamp        # Every 5 seconds
PROGRESS:N/M chunks        # Overall progress
```

### MPS Environment Variables (PyTorch backend only)
When MPS is enabled, `tts-runner.ts` sets:
- `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0` - Aggressive memory cleanup
- `OMP_NUM_THREADS=4` / `OPENBLAS_NUM_THREADS=2` - Reduce GIL contention

## Key Dependencies

- **Python**: kokoro (TTS), ebooklib (EPUB), torch, numpy, mlx-audio (optional)
- **Node.js**: react, ink (terminal UI), commander (CLI args)
- **System**: FFmpeg (required), Python 3.10-3.12

## Voice Options

American: `af_heart` (default), `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael`
British: `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis`
