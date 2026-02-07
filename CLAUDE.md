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
.venv/bin/python -m pytest -m "not slow" --cov=app --cov-fail-under=75
.venv/bin/python -m pytest tests/e2e
.venv/bin/python -m pytest -m slow

# CLI (from cli/)
npm test                        # All tests
npm run test:watch              # Watch mode
npm run test:coverage           # With coverage
```

### Direct Python Usage
```bash
python app.py --input book.epub --output book.mp3 --voice af_heart --speed 1.0
python app.py --backend mlx --input book.epub --output book.mp3  # MLX backend (faster)
python app.py --backend mock --input book.epub --output book.mp3 # Deterministic test backend
python app.py --format m4b --input book.epub --output book.m4b   # M4B with chapters
python app.py --bitrate 320k --normalize --input book.epub --output book.mp3  # High quality + normalization
python app.py --resume --input book.epub --output book.mp3       # Resume from checkpoint
```

## Architecture

### Backend Abstraction Layer (`backends/`)
TTS backends are pluggable via an abstraction layer:
- `base.py` - `TTSBackend` abstract base class defining the interface (`initialize`, `generate`, `cleanup`)
- `kokoro_pytorch.py` - Default PyTorch/Kokoro implementation (uses MPS on Apple Silicon)
- `kokoro_mlx.py` - MLX implementation for faster inference on Apple Silicon
- `mock.py` - Deterministic backend for subprocess E2E tests
- `factory.py` - `create_backend(type)` factory function, `get_available_backends()` for discovery

The `--backend` flag selects which backend to use (`auto`, `pytorch`, `mlx`, or `mock`). MLX requires separate installation (`pip install -r requirements-mlx.txt`).

### Checkpoint System (`checkpoint.py`)
Enables resumable processing for long audiobooks:
- `CheckpointState` dataclass stores EPUB hash, config, completed chunks, chapter indices
- Chunk audio saved as `.npy` files in `<output>.checkpoint/` directory
- `--resume` loads checkpoint and skips completed chunks
- `--no_checkpoint` disables checkpoint saving
- Checkpoint automatically cleaned up after successful completion

### Frontend (`cli/src/`)
- `App.tsx` - Main component with state machine: `checking` → `setup-required`|`welcome` → `files` → `config` → `metadata` → `resume` → `processing` → `done`
- `utils/tts-runner.ts` - Spawns Python process, sets MPS env vars (PyTorch only), parses stdout progress
- `utils/preflight.ts` - Checks for FFmpeg, Python venv, Kokoro, and optionally MLX
- `utils/metadata.ts` - Extracts EPUB metadata via Python backend
- `utils/checkpoint.ts` - Checks for existing checkpoints via Python backend
- `components/ConfigPanel.tsx` - Multi-step wizard: accent → voice → speed → backend → format → quality → workers → gpu → output
- `components/MetadataEditor.tsx` - Edit M4B metadata (title/author/cover) before export
- `components/ResumeDialog.tsx` - Resume or start fresh when checkpoint found

### Backend (`app.py`)
Sequential inference + background encoding pipeline:
1. Extract EPUB text and metadata, split into chunks (default: 900 chars for MLX, 600 for PyTorch)
2. Check for checkpoint if `--resume` flag set
3. Backend generates audio sequentially, queues for encoding
4. Background thread(s) convert audio to int16 numpy arrays (`--workers` controls parallelism)
5. Save chunk audio to checkpoint after each chunk (unless `--no_checkpoint`)
6. Results concatenated with `np.concatenate()` (O(n) vs O(n²)), tracking chapter sample positions
7. Raw PCM piped to ffmpeg for MP3/M4B export (bypasses WAV 4GB limit)
8. Clean up checkpoint on successful completion

**Why sequential GPU?** MPS serializes GPU operations; threading is 0.88x slower.

**Why direct ffmpeg?** pydub creates intermediate WAV files with a 4GB limit (~24.9 hours). Long audiobooks exceed this.

### Output Formats
- **MP3** (default): Standard audio format with configurable bitrate (128k/192k/320k)
- **M4B**: Audiobook format with embedded chapter markers, book metadata (title/author), and cover art

### Audio Quality Options
- `--bitrate` - Audio bitrate: `128k` (smaller), `192k` (default), `320k` (high quality)
- `--normalize` - Apply -14 LUFS loudness normalization (podcast standard)

### Metadata Override (M4B)
- `--extract_metadata` - Print EPUB metadata and exit
- `--title` / `--author` / `--cover` - Override extracted metadata

### IPC Protocol
Python outputs to stdout, parsed by `tts-runner.ts`:
```
PHASE:PARSING              # Before text extraction
PHASE:INFERENCE            # Before inference loop
PHASE:CONCATENATING        # Before np.concatenate()
PHASE:EXPORTING            # Before MP3/M4B export
METADATA:total_chars:N     # Character count
METADATA:chapter_count:N   # Number of chapters
METADATA:title:<title>     # Extracted book title
METADATA:author:<author>   # Extracted author
METADATA:has_cover:<bool>  # Cover image presence
WORKER:0:INFER:Chunk X/Y   # Per-chunk status
TIMING:chunk_idx:ms        # Per-chunk timing
HEARTBEAT:timestamp        # Every 5 seconds
PROGRESS:N/M chunks        # Overall progress
CHECKPOINT:FOUND:T:C       # Checkpoint found (total:completed)
CHECKPOINT:RESUMING:N      # Resuming from N completed chunks
CHECKPOINT:SAVED:idx       # Chunk saved to checkpoint
CHECKPOINT:CLEANED         # Checkpoint cleaned up
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

Voices are filtered by accent (`--lang_code`):
- **American (a)**: `af_heart` (default), `af_bella`, `af_nicole`, `af_sarah`, `af_sky`, `am_adam`, `am_michael`
- **British (b)**: `bf_emma`, `bf_isabella`, `bm_george`, `bm_lewis`
