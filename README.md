# AI Audiobook Fast

Convert EPUB books into MP3 or M4B audiobooks using Kokoro TTS.

This repo has two main parts:
- `cli/`: an interactive terminal UI (Ink + React + TypeScript)
- `app.py`: the Python backend that parses EPUBs, runs TTS, and exports audio via `ffmpeg`

## Documentation

- `README.md`: quick start, usage, examples
- `ARCHITECTURE.md`: system design, pipeline modes, IPC protocol
- `CHECKPOINTS.md`: resume/checkpoint lifecycle and troubleshooting
- `FORMATS_AND_METADATA.md`: MP3 vs M4B behavior and metadata overrides
- `CLAUDE.md`: repo-specific guidance for coding agents/contributors

## Features

- Interactive terminal UI with setup checks and batch processing
- Direct backend CLI usage (`python app.py ...`) for scripting/automation
- MP3 and M4B output formats
- M4B chapter markers plus title/author/cover metadata overrides
- Checkpoint/resume support for long jobs (opt-in checkpoint writes)
- Auto backend selection (`auto`, `pytorch`, `mlx`, `mock`)
- Structured JSON or legacy text progress events for integrations
- Direct `ffmpeg` export pipeline (streaming MP3 path when possible)

## Quick Start (macOS)

`setup.sh` is a macOS-focused bootstrap script that sources `scripts/setup-macos.sh`.

```bash
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast
./setup.sh
cd cli && npm run dev
```

What `./setup.sh` does:
- Checks/installs Homebrew (optional prompt)
- Installs `ffmpeg`
- Installs a compatible Python (3.10-3.12, usually 3.12)
- Installs Node.js 18+
- Creates `.venv`
- Installs Python deps from `requirements.txt`
- Installs CLI deps in `cli/` via `npm install`
- Optionally installs MLX backend deps (`requirements-mlx.txt`)
- Optionally pre-downloads the Kokoro model

## Manual Setup

### Prerequisites

- `ffmpeg` available on PATH
- Python `3.10`, `3.11`, or `3.12`
- Node.js `18+` (for the interactive CLI)

### Install

```bash
git clone https://github.com/lichen0114/ai_audiobook_fast.git
cd ai_audiobook_fast

# Python runtime
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Optional: test tooling
pip install -r requirements-dev.txt

# Optional: MLX backend (Apple Silicon)
pip install -r requirements-mlx.txt

# Interactive CLI
npm install --prefix cli
```

## Usage

### Interactive CLI (recommended)

```bash
cd cli && npm run dev
```

Apple Silicon users can also start the dev CLI with `PYTORCH_ENABLE_MPS_FALLBACK=1` pre-set:

```bash
cd cli && npm run dev:mps
```

Current interactive flow:
1. Preflight checks (`ffmpeg`, `.venv`, Python deps, backend script)
2. File selection (single file, folder, or pattern)
3. Configuration wizard (accent, voice, speed, backend, format, quality, checkpoint, GPU, output)
4. M4B metadata editor (single-file `m4b` runs only)
5. Batch planning pass (metadata, chunk/work estimates, checkpoint compatibility, output collision checks)
6. Batch review screen with per-file resume/fresh decisions and warnings
7. Batch processing view with live per-file progress plus weighted batch progress/ETA

### Direct backend CLI (for scripts/automation)

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

# Enable checkpoint writes, then resume a later run
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3
.venv/bin/python app.py --resume --input book.epub --output book.mp3

# Check checkpoint status only
.venv/bin/python app.py --check_checkpoint --input book.epub --output book.mp3

# Inspect a job for planning/integration use
.venv/bin/python app.py --inspect_job --event_format json \
  --input book.epub --output book.mp3

# Emit JSON events for integrations and write backend logs to a file
.venv/bin/python app.py --event_format json --log_file ./run.log \
  --input book.epub --output book.mp3

# Force pipeline mode (advanced)
.venv/bin/python app.py --pipeline_mode sequential --input book.epub --output book.mp3
```

### Backend options (high-value flags)

| Flag | Default | Notes |
| --- | --- | --- |
| `--voice` | `af_heart` | Kokoro voice id |
| `--lang_code` | `a` | `a` = American, `b` = British |
| `--speed` | `1.0` | Speech speed multiplier |
| `--backend` | `auto` | `auto`, `pytorch`, `mlx`, `mock` |
| `--chunk_chars` | backend-dependent | `900` (MLX) / `600` (PyTorch) when omitted |
| `--split_pattern` | `\n+` | Regex for internal text splitting |
| `--format` | `mp3` | `mp3` or `m4b` |
| `--bitrate` | `192k` | `128k`, `192k`, `320k` |
| `--normalize` | off | Applies `loudnorm` target around -14 LUFS |
| `--checkpoint` | off | Enables checkpoint writes for resume support |
| `--resume` | off | Attempts to resume from checkpoint (also enables checkpoint mode) |
| `--check_checkpoint` | off | Reports checkpoint status and exits |
| `--inspect_job` | off | Emits metadata, chunk/work estimates, and full resume compatibility |
| `--pipeline_mode` | auto | `sequential` or `overlap3`; `overlap3` is restricted |
| `--prefetch_chunks` | `2` | `overlap3` tuning |
| `--pcm_queue_size` | `4` | `overlap3` tuning |
| `--workers` | `2` | Compatibility flag; inference is still sequential |
| `--event_format` | `text` | `json` is used by the interactive CLI |
| `--log_file` | none | Append backend logs/events to file |
| `--no_checkpoint` | off | Deprecated no-op (checkpointing is already opt-in) |

## Output Formats and Metadata

### MP3

- Default output format
- Uses direct `ffmpeg` export
- When checkpointing is off, runtime can stream PCM directly to `ffmpeg` (no spool file)
- Supports `--bitrate` and optional `--normalize`

### M4B

- Uses AAC in an `.m4b` container via `ffmpeg`
- Embeds chapter markers derived from EPUB chapter boundaries
- Supports metadata from EPUB plus overrides (`--title`, `--author`, `--cover`)
- The CLI keeps metadata overrides isolated per file during planning and execution

More detail: `FORMATS_AND_METADATA.md`

## Checkpoint and Resume (Quick Guide)

Checkpoint files are stored next to the output file as:

- `<output>.checkpoint/state.json`
- `<output>.checkpoint/chunk_000000.npy`, etc.

Typical flow:

```bash
# First run (create checkpoint while processing)
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3

# Resume later
.venv/bin/python app.py --resume --input book.epub --output book.mp3
```

Resume is only used when the checkpoint matches:
- EPUB file hash
- key generation/export settings (voice, speed, backend, chunking, format, bitrate, normalize, etc.)
- chunk count for the current chunking pass

More detail: `CHECKPOINTS.md`

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

- Runtime export uses `ffmpeg` directly via subprocesses (streaming and file-based paths). The `pydub` dependency remains for compatibility helpers/tests, not the main export path.
- `--workers` is currently a compatibility setting. The backend warns when it is not `1`, and inference remains sequential. The interactive CLI now keeps this pinned to `1`.
- `--pipeline_mode overlap3` is currently supported only for MP3 output without checkpointing. Incompatible combinations fall back to sequential mode with a warning.
- `--backend auto` resolves to MLX on Apple Silicon when `mlx-audio` is installed and a runtime probe succeeds; otherwise it falls back to PyTorch.

## Testing

### Python

```bash
# Fast suite (no slow tests); CI also uses --cov-fail-under=75
.venv/bin/python -m pytest -m "not slow" --cov=app --cov-fail-under=75

# Subprocess E2E tests (uses the mock backend in test scenarios)
.venv/bin/python -m pytest tests/e2e

# Slow ffmpeg/format validation tests
.venv/bin/python -m pytest -m slow
```

### CLI

```bash
npm test --prefix cli
npm run test:coverage --prefix cli
```

Current CLI coverage thresholds (Vitest config):
- Statements: `60%`
- Branches: `50%`
- Functions: `60%`
- Lines: `60%`

### CI (GitHub Actions)

`/.github/workflows/tests.yml` runs:
- Fast PR job: Python tests (with `--cov-fail-under=75`) + CLI tests + CLI coverage
- Slow job: `pytest -m slow` on schedule/manual dispatch

## Architecture

See `ARCHITECTURE.md` for the detailed runtime and module design.

## Contributing

Issues and pull requests are welcome.

If you change runtime behavior or CLI flags, update:
- `README.md`
- `ARCHITECTURE.md`
- `CHECKPOINTS.md` and/or `FORMATS_AND_METADATA.md` (if relevant)
- `CLAUDE.md` (if contributor/agent workflow changed)

## License

MIT (`LICENSE`)
