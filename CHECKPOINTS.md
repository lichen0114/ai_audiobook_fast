# Checkpoints and Resume

This guide explains how resumable processing works in AI Audiobook Fast.

## Summary

Checkpointing is optional and stores per-chunk audio plus job metadata so an interrupted run can resume later.

Checkpoint data lives in a directory next to the output file:

- `<output>.checkpoint/state.json`
- `<output>.checkpoint/chunk_000000.npy`
- `<output>.checkpoint/chunk_000001.npy`
- ...

Examples:
- `book.mp3` -> `book.mp3.checkpoint/`
- `book.m4b` -> `book.m4b.checkpoint/`

## Flags

| Flag | Purpose |
| --- | --- |
| `--checkpoint` | Enable checkpoint writes during processing |
| `--resume` | Attempt to resume from an existing checkpoint (also enables checkpoint mode) |
| `--check_checkpoint` | Report checkpoint status and exit |
| `--no_checkpoint` | Deprecated no-op (checkpointing is already opt-in) |

## Typical Workflows

### 1. Create a resumable run

```bash
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3
```

This stores checkpoint state and per-chunk `.npy` audio as the job progresses.

### 2. Resume later

```bash
.venv/bin/python app.py --resume --input book.epub --output book.mp3
```

If the checkpoint is compatible, completed chunks are reused and the backend continues from missing work.

### 3. Probe checkpoint status without processing

```bash
.venv/bin/python app.py --check_checkpoint --input book.epub --output book.mp3
```

This is useful for scripts or lightweight UI probes.

### 4. Inspect a job with full resume compatibility

```bash
.venv/bin/python app.py --inspect_job --event_format json \
  --input book.epub --output book.mp3
```

Unlike `--check_checkpoint`, this mode performs the same compatibility checks used by resume mode and also reports chunk/work estimates.

## CLI Behavior (Interactive UI)

The interactive CLI now uses a planning pass before processing starts.

Current behavior:
- The planner inspects every selected file, not just the first one.
- Compatible checkpoints are marked to resume automatically on a per-file basis.
- Incompatible checkpoints are marked `start-fresh` and deleted just before that file runs.
- The review screen shows resumable files, warnings, and blocked output collisions before execution starts.

## What Gets Stored

### `state.json` (`CheckpointState`)

The backend stores:
- `epub_hash`: SHA-256 hash of the input EPUB
- `config`: key generation/export settings used for compatibility checks
- `total_chunks`: number of chunks in the job
- `completed_chunks`: chunk indexes already saved
- `chapter_start_indices`: chapter boundary info used for final chapter metadata generation

### Chunk audio (`chunk_*.npy`)

Each completed chunk is stored as a NumPy array (`int16` audio in practice).

This lets the backend reuse already-generated chunks during resume and still produce final output without re-running TTS for those chunks.

## Checkpoint Status Probe (`--check_checkpoint`)

`--check_checkpoint` is a lightweight status mode that reports checkpoint existence and basic input compatibility.

### Text output forms (legacy mode)

- `CHECKPOINT:NONE`
- `CHECKPOINT:FOUND:<total_chunks>:<completed_chunks>`
- `CHECKPOINT:INVALID:hash_mismatch`

Important limitation:
- `--check_checkpoint` verifies checkpoint existence and EPUB hash match.
- It does **not** perform the full config compatibility validation used by `--resume`.

Use `--inspect_job` when you need the same compatibility answer the runtime uses for `--resume`.

## Full Resume Validation (`--resume`)

When `--resume` is used, the backend performs stronger validation before reusing data.

Validation requires all of the following to match:
- EPUB hash
- `voice`
- `speed`
- `lang_code`
- `backend` (resolved backend)
- `chunk_chars`
- `split_pattern`
- `format`
- `bitrate`
- `normalize`

Additional runtime checks:
- `total_chunks` must match current chunking output (`chunk_mismatch` otherwise)
- each claimed completed chunk should have its `.npy` audio file; missing files are reported and regenerated

## Runtime Checkpoint Events

During normal processing, the backend emits checkpoint events (text or JSON).

Common codes:

| Code | Meaning |
| --- | --- |
| `NONE` | No checkpoint found (`--check_checkpoint` mode) |
| `FOUND` | Checkpoint exists and hash matches (`--check_checkpoint` mode) |
| `INVALID:hash_mismatch` | Probe mode detected different EPUB content |
| `INVALID:config_mismatch` | Resume mode rejected checkpoint due to settings mismatch |
| `INVALID:chunk_mismatch` | Resume mode found incompatible chunk count |
| `RESUMING:<n>` | Resume mode accepted checkpoint with `<n>` completed chunks |
| `REUSED:<idx>` | Chunk audio reused from checkpoint |
| `MISSING_AUDIO:<idx>` | Chunk was marked complete but audio file is missing; chunk will be regenerated |
| `SAVED:<idx>` | New chunk audio saved to checkpoint |
| `CLEANED` | Checkpoint directory removed after successful completion |

## Lifecycle and Cleanup

### On successful completion

If checkpoint mode was active (`--checkpoint` or `--resume`), the backend cleans up the checkpoint directory and emits `CHECKPOINT:CLEANED`.

### On failure/interruption

Checkpoint artifacts are generally left on disk so you can:
- resume later
- inspect partial progress
- debug a failing run

Temporary spool/export files are still cleaned up separately by backend cleanup logic.

## Performance and Behavior Notes

- Checkpointing disables the optimized MP3 streaming path and uses a spool-file export path instead.
- `overlap3` pipeline mode is currently not supported with checkpointing.
- Resume reuse happens at the chunk level (not partial chunk internals).

## Troubleshooting

### Resume was offered but backend started fresh

Likely cause:
- checkpoint hash matched, but runtime config changed (voice, backend, format, bitrate, etc.)

What to do:
- rerun with the same options as the original run, or
- start fresh and allow the CLI to delete the checkpoint, or
- manually delete `<output>.checkpoint/`

### `INVALID:hash_mismatch`

The input EPUB file content changed since the checkpoint was created.

What to do:
- restore the original EPUB, or
- delete the checkpoint and start a new run

### `MISSING_AUDIO:<idx>` events during resume

Some chunk `.npy` files are missing/corrupted but state metadata exists.

What happens:
- the backend drops the missing chunk from the completed set
- regenerates that chunk
- continues processing

### I want resumability for long jobs by default

Current default is checkpointing off for performance/simplicity.

Use one of these:
- direct backend: add `--checkpoint`
- interactive CLI: enable checkpointing in the config wizard

## Related Docs

- `README.md`
- `ARCHITECTURE.md`
- `FORMATS_AND_METADATA.md`
