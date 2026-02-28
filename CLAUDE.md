# CLAUDE.md

This file provides guidance to Claude Code and other coding agents working in this repository.

## Project Overview

AI Audiobook Fast converts EPUB files into MP3 or M4B audiobooks using Kokoro TTS.

Runtime architecture:
- `cli/`: interactive terminal UI built with TypeScript, Ink, and React
- `app.py`: Python backend for EPUB parsing, TTS generation, checkpointing, inspection, and export
- `backends/`: pluggable TTS backends (`pytorch`, `mlx`, `mock`)
- `checkpoint.py`: resumable processing state, chunk persistence, validation, and inspection

The CLI launches the Python backend as a subprocess and parses its event stream. JSON is the main path for the interactive CLI; legacy text parsing remains for a few helper utilities.

## Documentation Map

Use these docs together when behavior changes:
- `README.md`: end-user setup, usage, and testing
- `ARCHITECTURE.md`: runtime design, planner behavior, pipeline modes, and IPC
- `CHECKPOINTS.md`: checkpoint and resume rules
- `FORMATS_AND_METADATA.md`: MP3 vs M4B behavior and metadata semantics

## Common Commands

### Setup

```bash
./setup.sh

# Manual setup
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Required for documented Python test commands
pip install -r requirements-dev.txt

# Optional MLX backend (Apple Silicon)
pip install -r requirements-mlx.txt

# CLI dependencies
npm install --prefix cli
```

### Development

```bash
npm run dev --prefix cli
npm run dev:mps --prefix cli
npm run build --prefix cli
npm start --prefix cli
```

### Testing

`pytest.ini` includes coverage options, so install `requirements-dev.txt` before running `pytest`.

```bash
# Python fast tests + coverage gate used in CI
.venv/bin/python -m pytest -m "not slow" --cov=app --cov-fail-under=75

# Python subprocess e2e tests
.venv/bin/python -m pytest tests/e2e

# Slow format and ffmpeg validation tests
.venv/bin/python -m pytest -m slow

# CLI tests
npm test --prefix cli
npm run test:coverage --prefix cli
```

### Direct Backend Usage

```bash
# Basic MP3
.venv/bin/python app.py --input book.epub --output book.mp3

# Explicit backend
.venv/bin/python app.py --backend mlx --input book.epub --output book.mp3

# M4B with metadata overrides
.venv/bin/python app.py --format m4b --title "Title" --author "Author" \
  --cover ./cover.jpg --input book.epub --output book.m4b

# Checkpoint create and resume
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3
.venv/bin/python app.py --resume --input book.epub --output book.mp3

# Planning and integration mode
.venv/bin/python app.py --inspect_job --event_format json \
  --input book.epub --output book.mp3
```

## Current Architecture Highlights

### CLI flow (`cli/src/App.tsx`)

Current screen sequence:
- `checking`
- `setup-required` or `welcome`
- `files`
- `config`
- `metadata` for single-file M4B only
- `planning`
- `review`
- `processing`
- `done`

Important implementation details:
- The CLI plans the batch before execution and inspects every selected file.
- Single-file M4B runs call `extractMetadata()` and allow title, author, and cover overrides.
- Multi-file M4B runs skip the metadata editor and do not keep override fields.
- Checkpoint handling is chosen automatically per job during planning.
- The active override is batch-level `Start fresh for all resumable jobs`; do not describe the current UX as ResumeDialog-driven.

### Batch planning and execution

Important current behavior:
- `cli/src/utils/batch-planner.ts` builds a `BatchPlan` by calling `app.py --inspect_job` for each input.
- Jobs with inspection failures still produce plan entries, so the rest of the batch can continue.
- Duplicate output paths are blocked per job.
- `cli/src/utils/batch-scheduler.ts` skips blocked or errored jobs and runs the rest sequentially.
- Existing checkpoints are ignored, not deleted, when checkpointing is disabled.

### Backend (`app.py`)

Key responsibilities:
- Parse flags and validate inputs
- Resolve TTS backend (`auto`, `pytorch`, `mlx`, `mock`)
- Resolve pipeline mode (`sequential` or `overlap3`)
- Parse EPUB and chunk text
- Emit progress, metadata, parse, checkpoint, inspection, and log events
- Manage checkpoints and resume logic
- Export MP3 and M4B through `ffmpeg`

### Pipeline modes

- `sequential`: current effective default when `--pipeline_mode` is omitted
- `overlap3`: optimized MP3 path without checkpointing

Notes:
- The backend flag accepts only explicit values `sequential` or `overlap3`.
- The CLI may keep an internal `auto` preference, but that is translated into omitting the backend flag.
- The backend warns and falls back to `sequential` when `overlap3` is requested for unsupported combinations.

### Export paths

Runtime export is `ffmpeg`-based:
- MP3 can stream PCM directly to an `ffmpeg` subprocess when checkpoints are off
- MP3 and M4B can use a temporary PCM spool file path
- M4B export writes chapter metadata and optional cover art through `ffmetadata` and `ffmpeg`

Do not document runtime export as `pydub`-driven.

### Apple Silicon recovery

The CLI runner may retry once after a recoverable native failure on Apple Silicon with a safer profile:
- `pytorch`
- CPU instead of MPS
- `sequential`
- Smaller chunk size

## Backend Flags Worth Knowing

These drift easily and should be checked in `app.py` before changing docs:
- `--backend`, `--format`, `--bitrate`, `--normalize`
- `--checkpoint`, `--resume`, `--check_checkpoint`
- `--inspect_job`, `--extract_metadata`
- `--pipeline_mode`, `--prefetch_chunks`, `--pcm_queue_size`
- `--event_format`, `--log_file`
- `--title`, `--author`, `--cover`

Notes:
- `--workers` is a compatibility flag; inference remains sequential.
- `--no_checkpoint` is deprecated and currently a no-op.

## IPC Protocol (CLI <-> Python)

Current backend event categories include:
- `phase`
- `metadata`
- `timing`
- `parse_progress`
- `heartbeat`
- `worker`
- `progress`
- `checkpoint`
- `inspection`
- `error`
- `done`
- `log` in JSON mode

The CLI runner (`cli/src/utils/tts-runner.ts`):
- Always passes `--event_format json`
- Writes backend logs to `~/.audiobook-maker/logs` or the repo `.logs` fallback
- Parses JSON first and then falls back to legacy text parsing

Legacy text parsing is still used directly by helper utilities such as:
- `cli/src/utils/metadata.ts`
- `cli/src/utils/checkpoint.ts`

## Environment Variables

Recognized or relevant variables:
- `AUDIOBOOK_PYTHON`: preferred Python executable for CLI subprocesses
- `PYTHON`: secondary Python override candidate
- `AUDIOBOOK_VERBOSE=1`: echo parsed backend output lines to CLI stderr
- `AUDIOBOOK_OMP_THREADS`: override derived `OMP_NUM_THREADS`
- `AUDIOBOOK_OPENBLAS_THREADS`: override derived `OPENBLAS_NUM_THREADS`

For PyTorch MPS paths, the CLI runner may set:
- `PYTORCH_ENABLE_MPS_FALLBACK=1`
- `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
- `OMP_NUM_THREADS=<derived>`
- `OPENBLAS_NUM_THREADS=<derived>`

## Doc Maintenance Hotspots

If you change any of these, update docs in the same PR:
- CLI workflow screens or planning and review behavior
- Backend flags or effective defaults
- Checkpoint validation rules or event codes
- Output format behavior, metadata handling, or cover handling
- IPC event payloads or parser semantics
- Apple Silicon recovery behavior

Minimum docs to review:
- `README.md`
- `ARCHITECTURE.md`
- `CHECKPOINTS.md` and/or `FORMATS_AND_METADATA.md`
