# Project Architecture

This document describes how AI Audiobook Fast is structured and how the runtime pipeline works today.

## Overview

The project is a process-based system with a terminal UI frontend and a Python backend:

- `cli/` (TypeScript + Ink): user experience, config wizard, batch orchestration, progress UI
- `app.py` (Python): EPUB parsing, text chunking, TTS generation, checkpointing, export via `ffmpeg`
- `backends/` (Python): pluggable TTS backend implementations (`pytorch`, `mlx`, `mock`)
- `checkpoint.py` (Python): checkpoint state/chunk persistence and validation

The CLI launches the Python backend as a subprocess and parses backend events from `stdout`/`stderr`.

## High-Level Runtime Flow

```mermaid
flowchart TD
    U[User] --> C[CLI UI (Ink)]
    C --> P[Python Backend app.py]
    P --> E[EPUB Parse + Chunking]
    P --> B[TTS Backend: auto/pytorch/mlx/mock]
    P --> X[Export via ffmpeg]
    X --> O[MP3 or M4B Output]
    P --> CP[Checkpoint Store (.checkpoint)]
    P --> EVT[JSON/Text Events]
    EVT --> C
```

## Component Responsibilities

### CLI (`cli/`)

Primary responsibilities:
- Startup preflight checks (`ffmpeg`, Python venv, Python deps, `app.py`)
- File selection and config wizard
- M4B metadata review/edit UI
- Checkpoint status probe and resume/start-fresh prompt
- Spawning the Python backend and rendering progress/phase updates
- Batch processing multiple EPUBs sequentially

Key files:
- `cli/src/App.tsx`: screen state machine and workflow orchestration
- `cli/src/components/ConfigPanel.tsx`: configuration wizard (voice/backend/format/checkpoint/etc.)
- `cli/src/components/MetadataEditor.tsx`: M4B metadata review/override UI
- `cli/src/components/ResumeDialog.tsx`: resume vs fresh-start choice
- `cli/src/components/BatchProgress.tsx`: live processing UI for each file
- `cli/src/utils/tts-runner.ts`: subprocess runner + event parser
- `cli/src/utils/preflight.ts`: environment checks
- `cli/src/utils/metadata.ts`: metadata extraction helper (`--extract_metadata`)
- `cli/src/utils/checkpoint.ts`: checkpoint probe/delete helpers

### Python Backend (`app.py`)

Primary responsibilities:
- Parse CLI args and validate inputs
- Resolve backend (`auto` / explicit)
- Choose pipeline mode (`sequential` vs `overlap3`)
- Parse EPUB chapters/text and split into chunks
- Emit progress/status events (JSON or legacy text)
- Handle checkpoint create/verify/resume/save/cleanup
- Run TTS inference and audio conversion
- Export audio with `ffmpeg` (MP3 or M4B)

### TTS Backends (`backends/`)

- `kokoro_pytorch.py`: default Kokoro backend (PyTorch; can use MPS on Apple Silicon)
- `kokoro_mlx.py`: MLX backend for Apple Silicon (`mlx-audio`)
- `mock.py`: deterministic backend for tests/subprocess validation
- `factory.py`: backend creation + runtime availability discovery

## CLI User Flow (Current)

`App.tsx` implements a screen/state flow similar to:

1. `checking`
2. `setup-required` or `welcome`
3. `files`
4. `config`
5. `metadata` (single-file `m4b` only)
6. `planning`
7. `review`
8. `processing`
9. `done`

Important current behavior:
- The CLI now inspects every selected file before execution.
- Planning resolves output paths, extracts metadata, computes chunk/work estimates, and validates checkpoint compatibility per file.
- The review screen shows resumable jobs, output collisions, warnings, and per-file metadata before processing begins.
- The CLI always starts backend runs with `--event_format json` and `--log_file <path>`.

## Backend Pipeline

### 1. Argument Parsing and Early Modes

`app.py` parses runtime flags including:
- generation options (`--voice`, `--lang_code`, `--speed`, `--chunk_chars`, `--split_pattern`)
- backend/export options (`--backend`, `--format`, `--bitrate`, `--normalize`)
- checkpoint options (`--checkpoint`, `--resume`, `--check_checkpoint`)
- pipeline options (`--pipeline_mode`, `--prefetch_chunks`, `--pcm_queue_size`)
- integration options (`--event_format`, `--log_file`, `--no_rich`)

Early-exit modes:
- `--extract_metadata`: parse EPUB metadata and print metadata events, then exit
- `--check_checkpoint`: report checkpoint status for an input/output pair, then exit
- `--inspect_job`: emit metadata, chunk/work estimates, and full checkpoint compatibility for one input/output pair, then exit

### 2. Backend Resolution

`--backend auto` resolves at runtime:
- On Apple Silicon macOS, it prefers MLX if `mlx-audio` is installed and a small MLX probe succeeds.
- Otherwise it falls back to PyTorch.
- Non-macOS/non-Apple Silicon resolves to PyTorch.

Resolved backend is emitted as metadata (`backend_resolved`).

### 3. Pipeline Mode Selection

`default_pipeline_mode(output_format, use_checkpoint)` picks the runtime pipeline.

Default behavior:
- `sequential` for all current default paths

If `--pipeline_mode overlap3` is requested for an unsupported combination (currently non-MP3 or any checkpoint-enabled run), the backend emits a warning and falls back to `sequential`.

#### Pipeline Modes

| Mode | What it does | When used |
| --- | --- | --- |
| `sequential` | Single main loop for chunk inference + write/checkpoint work | Default for most cases, required for checkpoints and M4B |
| `overlap3` | Inference thread + conversion thread + streaming export coordination | MP3 without checkpointing on supported Apple Silicon paths |

## Data Processing Flow

### Parsing and Chunking

1. Emit `PHASE:PARSING` / JSON phase event
2. Extract EPUB text into chapters
3. Split text into chunks (`split_text_to_chunks`) using `chunk_chars`
4. Emit metadata events such as total chars and chapter count

Chunk sizing defaults when `--chunk_chars` is omitted:
- MLX: `900`
- PyTorch: `600`

### Checkpoint/Resume Preparation

If checkpointing is active (`--checkpoint` or `--resume`):
- checkpoint dir is computed as `<output>.checkpoint`
- checkpoint state is created (or loaded if resuming)
- resume validation checks:
  - EPUB SHA-256 hash
  - key config values (voice, speed, lang, backend, chunking/split, format, bitrate, normalize)
  - chunk count match for the current chunking pass

If valid resume data exists, completed chunks can be reused.

### Inference Stage

Backend emits `PHASE:INFERENCE`, then runs one of the two pipeline implementations.

#### Sequential pipeline

- Iterates chunks in order
- For each chunk:
  - reuse checkpointed `.npy` chunk audio when resuming (if available)
  - otherwise call backend `generate(...)`
  - convert audio to `int16`
  - write PCM to output stream or spool file
  - optionally save checkpoint chunk `.npy`
  - emit worker/timing/progress/checkpoint events

#### `overlap3` pipeline (MP3 only, no checkpoint)

- Uses an inference thread and a conversion thread with queues
- Streams PCM directly to an `ffmpeg` MP3 process
- Emits worker/timing/progress events from the coordinating loop
- Does not support checkpointing in the current implementation

### Concatenating Phase (Protocol Compatibility)

The backend emits `PHASE:CONCATENATING` for CLI protocol compatibility.

Current runtime behavior:
- Audio is already being streamed or spooled during inference
- The phase is used to finalize sample offsets/chapter boundaries and preserve expected progress semantics

### Export Phase

The backend emits `PHASE:EXPORTING` and exports via `ffmpeg`.

#### MP3 export

Two paths:
- Streaming path (`open_mp3_export_stream` + `close_mp3_export_stream`) when format is MP3 and checkpointing is off
- File-based path (`export_pcm_file_to_mp3`) when a spool file is used

#### M4B export

- Uses file-based PCM spool (`export_pcm_file_to_m4b`)
- Generates `ffmetadata` for title/author/chapters
- Optionally attaches cover art (`jpg`, `png`, `gif`)
- Encodes audio as AAC and writes `.m4b`

Note: runtime export is implemented with direct `ffmpeg` subprocess calls. `pydub` remains installed but is not the primary export path.

### Completion and Cleanup

On successful completion:
- output is finalized
- average chunk timing is reported
- checkpoint directory is cleaned up when checkpoint mode was used
- `done` event is emitted

On failure:
- an error event/message is emitted
- checkpoint artifacts remain on disk (useful for resume/debugging)
- temporary spool files and subprocess resources are cleaned up in `finally` blocks where possible

## Checkpoint Architecture

See `CHECKPOINTS.md` for user/operator guidance. This section focuses on internals.

### Checkpoint Storage Layout

For output `book.mp3`, checkpoint data is stored in:

- `book.mp3.checkpoint/state.json`
- `book.mp3.checkpoint/chunk_000000.npy`
- `book.mp3.checkpoint/chunk_000001.npy`
- ...

### `state.json` Contents (`CheckpointState`)

- `epub_hash`: SHA-256 of the input EPUB
- `config`: selected generation/export settings used for validation
- `total_chunks`: chunk count for the run
- `completed_chunks`: chunk indexes already persisted
- `chapter_start_indices`: chapter boundary references for final chapter metadata generation

### Validation Rules (`verify_checkpoint`)

Resume only proceeds when all match:
- EPUB hash
- `voice`
- `speed`
- `lang_code`
- `backend`
- `chunk_chars`
- `split_pattern`
- `format`
- `bitrate`
- `normalize`

## IPC and Event Protocol

The backend emits events through `EventEmitter` in one of two formats:

- `text` (legacy, human-readable lines)
- `json` (structured events; used by the interactive CLI runner)

### Event Categories

Backend event types include:
- `phase`
- `metadata`
- `timing`
- `heartbeat`
- `worker`
- `progress`
- `checkpoint`
- `error`
- `done`
- `log` (for `info`/`warn` in JSON mode)

### Example JSON events

```json
{"type":"phase","phase":"INFERENCE","ts_ms":1730000000000,"job_id":"book.mp3"}
{"type":"progress","current_chunk":12,"total_chunks":80,"ts_ms":1730000001234,"job_id":"book.mp3"}
{"type":"checkpoint","code":"SAVED","detail":11,"ts_ms":1730000001300,"job_id":"book.mp3"}
```

### Example text events

```text
PHASE:INFERENCE
METADATA:total_chars:123456
PROGRESS:12/80 chunks
CHECKPOINT:SAVED:11
DONE
```

## CLI Event Parsing and Integration

`cli/src/utils/tts-runner.ts`:
- spawns the backend subprocess
- forces `--event_format json`
- stores backend logs to a timestamped file (prefers `~/.audiobook-maker/logs`, falls back to `<repo>/.logs`)
- parses JSON first, then falls back to legacy text parsing
- updates progress state used by `BatchProgress`

The CLI parser preserves state across partial event streams (phase/progress/metadata) so UI updates remain stable.

## Environment and Runtime Settings

### Python runtime resolution (CLI side)

`cli/src/utils/python-runtime.ts` resolves Python using this candidate order:
1. `AUDIOBOOK_PYTHON`
2. `PYTHON`
3. repo `.venv` Python
4. `python3`
5. `python`

### MPS-related env vars (set by CLI runner when appropriate)

For PyTorch paths (`useMPS` enabled, backend not MLX/mock), the CLI runner sets:
- `PYTORCH_ENABLE_MPS_FALLBACK=1`
- `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`
- `OMP_NUM_THREADS=<derived or override>`
- `OPENBLAS_NUM_THREADS=<derived or override>`

Optional overrides supported by the CLI runner:
- `AUDIOBOOK_OMP_THREADS`
- `AUDIOBOOK_OPENBLAS_THREADS`
- `AUDIOBOOK_VERBOSE` (echo backend lines to CLI stderr)

## Code Map (Quick Navigation)

### Backend

- `app.py`: main entry point, orchestration, event emission, export paths
- `checkpoint.py`: checkpoint state/hash/validation/persistence
- `backends/base.py`: backend interface
- `backends/factory.py`: backend creation and discovery
- `backends/kokoro_pytorch.py`: PyTorch backend
- `backends/kokoro_mlx.py`: MLX backend
- `backends/mock.py`: deterministic test backend

### CLI

- `cli/src/App.tsx`: state machine and top-level workflow
- `cli/src/utils/tts-runner.ts`: subprocess + parser
- `cli/src/utils/preflight.ts`: setup verification
- `cli/src/utils/metadata.ts`: metadata extraction subprocess
- `cli/src/utils/checkpoint.ts`: checkpoint probe/delete subprocess/filesystem helpers
- `cli/src/components/*.tsx`: UI screens and widgets

## Current Constraints and Design Tradeoffs

- `--workers` is a compatibility flag in the backend today; inference is still sequential.
- `overlap3` is intentionally restricted because checkpoint reuse and M4B export need sequential/spool semantics.
- `ffmpeg` is a hard system dependency for output generation.
- Runtime export is `ffmpeg`-first even though `pydub` is present in dependencies.
- Sample rate is backend-defined (currently `24000` for bundled PyTorch and MLX backends).

## Related Docs

- `README.md`
- `CHECKPOINTS.md`
- `FORMATS_AND_METADATA.md`
- `CLAUDE.md`
