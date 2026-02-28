# AI Audiobook Fast

Convert EPUB books into MP3 or M4B audiobooks using Kokoro TTS.

The repository has two main parts:
- `cli/`: an interactive terminal UI built with Ink, React, and TypeScript
- `app.py`: the Python backend that parses EPUBs, runs TTS, manages checkpoints, and exports audio with `ffmpeg`

## Documentation

- `README.md`: setup, usage, examples, and testing
- `ARCHITECTURE.md`: runtime design, batch planning, pipeline modes, and IPC
- `CHECKPOINTS.md`: checkpoint lifecycle, resume rules, and troubleshooting
- `FORMATS_AND_METADATA.md`: MP3 vs M4B behavior and metadata rules
- `CLAUDE.md`: contributor and coding-agent guidance

## Features

- Interactive terminal workflow with preflight checks and batch processing
- Direct backend CLI usage (`python app.py ...`) for scripting and automation
- MP3 and M4B output formats
- M4B chapter markers plus title, author, and cover overrides
- Optional checkpoint and resume support for long jobs
- Auto backend selection (`auto`, `pytorch`, `mlx`, `mock`)
- Structured JSON or legacy text events for integrations
- Direct `ffmpeg` export pipeline, including a streaming MP3 path when checkpoints are off

## Quick Start (macOS)

`setup.sh` is a macOS-focused bootstrap script that sources `scripts/setup-macos.sh`.

```bash
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast
./setup.sh
cd cli && npm run dev
```

What `./setup.sh` does:
- Checks or installs Homebrew
- Installs `ffmpeg`
- Installs a compatible Python (3.10-3.12, usually 3.12)
- Installs Node.js 18+
- Creates `.venv`
- Installs Python dependencies from `requirements.txt`
- Installs CLI dependencies in `cli/`
- Optionally installs MLX backend dependencies from `requirements-mlx.txt`
- Optionally pre-downloads the Kokoro model

## Manual Setup

### Prerequisites

- `ffmpeg` available on `PATH`
- Python `3.10`, `3.11`, or `3.12`
- Node.js `18+` for the interactive CLI

### Install

```bash
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast

# Python runtime
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional but required for the documented Python test commands below
pip install -r requirements-dev.txt

# Optional MLX backend (Apple Silicon)
pip install -r requirements-mlx.txt

# Interactive CLI
npm install --prefix cli
```

## Usage

### Interactive CLI (recommended)

```bash
cd cli && npm run dev
```

Apple Silicon users can also start the dev CLI with PyTorch MPS fallback pre-set:

```bash
cd cli && npm run dev:mps
```

Current interactive flow:
1. Preflight checks for `ffmpeg`, the Python virtual environment, Python dependencies, and `app.py`
2. File selection for one file, a folder, or a glob-style pattern
3. Configuration wizard for accent, voice, speed, backend, format, quality, checkpointing, GPU, and output location
4. M4B metadata editor for single-file `m4b` runs only
5. Planning pass that inspects every selected file, estimates chunk and character counts, checks checkpoint compatibility, and detects output collisions
6. Batch review screen that summarizes ready jobs, resumable jobs, warnings, and blocked collisions
7. Processing screen with live per-file progress plus weighted batch progress and ETA

Important current behavior:
- The planner inspects every selected file before execution.
- Checkpoint handling is chosen automatically per job: `resume`, `start-fresh`, or `ignore`.
- The review screen offers a batch-level `Start fresh for all resumable jobs` override; there is no active per-file resume dialog in the current workflow.
- If checkpointing is disabled, existing checkpoints are ignored rather than deleted.
- Output-path collisions are blocked per job, and ready jobs can still run.

### Direct backend CLI

Basic conversion:

```bash
.venv/bin/python app.py --input book.epub --output book.mp3
```

Common examples:

```bash
# Select backend explicitly
.venv/bin/python app.py --backend pytorch --input book.epub --output book.mp3
.venv/bin/python app.py --backend mlx --input book.epub --output book.mp3

# M4B with metadata overrides and cover art
.venv/bin/python app.py --format m4b --title "Book Title" --author "Author" \
  --cover ./cover.jpg --input book.epub --output book.m4b

# Enable checkpoint writes, then resume later
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3
.venv/bin/python app.py --resume --input book.epub --output book.mp3

# Check checkpoint status only
.venv/bin/python app.py --check_checkpoint --input book.epub --output book.mp3

# Inspect a job for planning or integration use
.venv/bin/python app.py --inspect_job --event_format json \
  --input book.epub --output book.mp3

# Extract EPUB metadata only
.venv/bin/python app.py --extract_metadata --input book.epub --output /dev/null

# Emit JSON events and append backend logs to a file
.venv/bin/python app.py --event_format json --log_file ./run.log \
  --input book.epub --output book.mp3

# Force a pipeline mode explicitly
.venv/bin/python app.py --pipeline_mode sequential --input book.epub --output book.mp3
```

### Backend options (high-value flags)

| Flag | Default | Notes |
| --- | --- | --- |
| `--voice` | `af_heart` | Kokoro voice ID |
| `--lang_code` | `a` | `a` = American, `b` = British |
| `--speed` | `1.0` | Speech speed multiplier |
| `--backend` | `auto` | `auto`, `pytorch`, `mlx`, `mock` |
| `--chunk_chars` | backend-dependent | `900` for MLX and `600` for PyTorch when omitted |
| `--split_pattern` | `\n+` | Regex for internal text splitting |
| `--format` | `mp3` | `mp3` or `m4b` |
| `--bitrate` | `192k` | `128k`, `192k`, `320k` |
| `--normalize` | off | Applies `loudnorm` targeting about `-14 LUFS` |
| `--checkpoint` | off | Enables checkpoint writes for resume support |
| `--resume` | off | Attempts to reuse an existing compatible checkpoint |
| `--check_checkpoint` | off | Reports checkpoint existence and hash compatibility, then exits |
| `--inspect_job` | off | Emits metadata, chunk estimates, warnings, and full resume compatibility |
| `--pipeline_mode` | omitted | Accepted values are `sequential` or `overlap3`; omitted currently resolves to `sequential` |
| `--prefetch_chunks` | `2` | `overlap3` tuning |
| `--pcm_queue_size` | `4` | `overlap3` tuning |
| `--workers` | `2` | Compatibility flag; inference still runs sequentially |
| `--event_format` | `text` | `json` is used by the interactive CLI |
| `--log_file` | none | Append backend logs and events to a file |
| `--no_checkpoint` | off | Deprecated no-op; checkpointing is already opt-in |

## Output Formats and Metadata

### MP3

- Default output format
- Uses direct `ffmpeg` export
- When checkpointing is off, runtime can stream PCM directly to `ffmpeg`
- Supports `--bitrate` and optional `--normalize`
- Does not embed chapters or cover art in the current pipeline

### M4B

- Uses AAC audio in an `.m4b` container via `ffmpeg`
- Embeds chapter markers derived from parsed EPUB content documents with sample-accurate offsets
- Supports EPUB metadata plus overrides from `--title`, `--author`, and `--cover`
- The interactive CLI exposes the metadata editor only for single-file M4B runs, and only explicit edits become overrides
- Multi-file M4B CLI runs use EPUB metadata and do not expose per-file override editing

See `FORMATS_AND_METADATA.md` for the full behavior matrix and metadata rules.

## Checkpoint and Resume (Quick Guide)

Checkpoint files are stored next to the output file:

- `<output>.checkpoint/state.json`
- `<output>.checkpoint/chunk_000000.npy`
- `<output>.checkpoint/chunk_000001.npy`
- ...

Typical flow:

```bash
# First run: create checkpoint data while processing
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3

# Later run: attempt resume
.venv/bin/python app.py --resume --input book.epub --output book.mp3
```

Resume only succeeds when the checkpoint matches:
- The EPUB file hash
- Key generation and export settings such as voice, speed, backend, chunking, format, bitrate, and normalization
- The chunk count produced by the current parse and chunking pass

The interactive CLI uses `--inspect_job` during planning to choose whether each job should resume, start fresh, or ignore checkpoint data.

See `CHECKPOINTS.md` for the full lifecycle, validation rules, and troubleshooting guidance.

## Voices

American (`--lang_code a`):
- `af_heart` (default)
- `af_bella`
- `af_nicole`
- `af_sarah`
- `af_sky`
- `am_adam`
- `am_michael`

British (`--lang_code b`):
- `bf_emma`
- `bf_isabella`
- `bm_george`
- `bm_lewis`

## Technical Notes

- Runtime export uses `ffmpeg` directly via subprocesses. `pydub` remains installed for compatibility helpers and tests, not as the primary export path.
- `--backend auto` resolves to MLX on Apple Silicon when `mlx-audio` is installed and a runtime probe succeeds; otherwise it falls back to PyTorch.
- `--pipeline_mode overlap3` is currently supported only for MP3 output without checkpointing. Unsupported combinations fall back to `sequential` with a warning.
- `--workers` is currently a compatibility setting. The backend warns when it is not `1`, and the interactive CLI keeps it pinned to `1`.
- The CLI runner may retry once on recoverable Apple Silicon native failures with a safer profile: `pytorch`, CPU, `sequential`, and smaller chunk sizes.

## Testing

Install `requirements-dev.txt` before running the Python test commands below. `pytest.ini` includes coverage options, so `pytest` will fail if `pytest-cov` is missing.

### Python

```bash
# Fast suite; CI also enforces --cov-fail-under=75
.venv/bin/python -m pytest -m "not slow" --cov=app --cov-fail-under=75

# Subprocess E2E tests
.venv/bin/python -m pytest tests/e2e

# Slow ffmpeg and format validation tests
.venv/bin/python -m pytest -m slow
```

### CLI

```bash
npm test --prefix cli
npm run test:coverage --prefix cli
```

Current CLI coverage thresholds (`cli/vitest.config.ts`):
- Statements: `85%`
- Branches: `70%`
- Functions: `85%`
- Lines: `85%`

### CI (GitHub Actions)

`.github/workflows/tests.yml` runs:
- A fast job on pull requests and pushes: Python tests, CLI tests, and CLI coverage
- A slow Python test job on schedule or manual dispatch

## Architecture

See `ARCHITECTURE.md` for the detailed runtime, batch planner, pipeline, and IPC design.

## Contributing

If you change runtime behavior or CLI flags, update:
- `README.md`
- `ARCHITECTURE.md`
- `CHECKPOINTS.md` and/or `FORMATS_AND_METADATA.md` when relevant
- `CLAUDE.md` if contributor or agent workflow changed

## License

MIT (`LICENSE`)
