# Checkpoints and Resume

This guide explains how resumable processing works in AI Audiobook Fast.

## Summary

Checkpointing is optional. When enabled, the backend stores per-chunk audio plus job metadata so an interrupted run can resume later.

Checkpoint data lives in a directory next to the output file:

- `<output>.checkpoint/state.json`
- `<output>.checkpoint/chunk_000000.npy`
- `<output>.checkpoint/chunk_000001.npy`
- ...

Examples:
- `book.mp3` -> `book.mp3.checkpoint/`
- `book.m4b` -> `book.m4b.checkpoint/`

## Relevant Flags and Modes

| Flag | Purpose |
| --- | --- |
| `--checkpoint` | Enable checkpoint writes during processing |
| `--resume` | Attempt to reuse an existing compatible checkpoint |
| `--check_checkpoint` | Report checkpoint existence and EPUB hash compatibility, then exit |
| `--inspect_job` | Emit full checkpoint compatibility plus job estimates, warnings, and metadata |
| `--no_checkpoint` | Deprecated no-op; checkpointing is already opt-in |

## Typical Workflows

### 1. Create a resumable run

```bash
.venv/bin/python app.py --checkpoint --input book.epub --output book.mp3
```

This writes checkpoint state and per-chunk `.npy` audio as the job progresses.

### 2. Resume later

```bash
.venv/bin/python app.py --resume --input book.epub --output book.mp3
```

If the checkpoint is compatible, completed chunks are reused and the backend continues from missing work.

### 3. Probe checkpoint status without processing

```bash
.venv/bin/python app.py --check_checkpoint --input book.epub --output book.mp3
```

This is the lightweight probe used by older helper flows and simple scripts.

### 4. Inspect a job with full resume compatibility

```bash
.venv/bin/python app.py --inspect_job --event_format json \
  --input book.epub --output book.mp3
```

Unlike `--check_checkpoint`, this mode performs the same compatibility checks used by resume mode and also returns chunk estimates, EPUB metadata, warnings, and errors.

## Interactive CLI Behavior

The interactive CLI uses a planning pass before processing starts.

Current behavior:
- The planner inspects every selected file, not just the first one.
- Each job gets a checkpoint action of `resume`, `start-fresh`, or `ignore`.
- The review screen summarizes resumable jobs, warnings, errors, and blocked output collisions.
- The only override in the current UI is `Start fresh for all resumable jobs`.

Important nuance:
- When checkpointing is disabled in the CLI, existing checkpoints are ignored, not deleted.
- Deletion happens only for jobs that are explicitly planned as `start-fresh`, and it happens just before that job runs.

## What Gets Stored

### `state.json`

The backend stores:
- `epub_hash`: SHA-256 hash of the input EPUB
- `config`: key generation and export settings used for compatibility checks
- `total_chunks`: number of chunks in the job
- `completed_chunks`: chunk indexes already saved
- `chapter_start_indices`: chapter boundary information used for final chapter metadata generation

### Chunk audio (`chunk_*.npy`)

Each completed chunk is stored as a NumPy array, `int16` in practice.

This lets the backend reuse generated chunks during resume and still produce final output without rerunning TTS for completed chunks.

## Comparing Checkpoint-Related Modes

### `--check_checkpoint`

`--check_checkpoint` is a lightweight status mode that reports checkpoint existence and basic input compatibility.

Legacy text output forms:
- `CHECKPOINT:NONE`
- `CHECKPOINT:FOUND:<total_chunks>:<completed_chunks>`
- `CHECKPOINT:INVALID:hash_mismatch`

Important limitation:
- It verifies checkpoint existence and EPUB hash match.
- It does not perform the full config compatibility validation used by `--resume`.

### `--inspect_job`

`--inspect_job` is the planning and integration surface used by the current CLI batch planner.

It performs the same compatibility checks used for resume mode and also reports:
- Resolved backend
- Resolved chunk size
- Resolved pipeline mode
- Total characters
- Total chunks
- Chapter count
- EPUB metadata
- Warnings and errors

Use `--inspect_job` when you need the same resume answer the runtime uses for `--resume`.

### `--resume`

When `--resume` is used, the backend validates the checkpoint again during the real run before reusing data.

Validation requires all of the following to match:
- EPUB hash
- `voice`
- `speed`
- `lang_code`
- resolved `backend`
- `chunk_chars`
- `split_pattern`
- `format`
- `bitrate`
- `normalize`

Additional runtime checks:
- `total_chunks` must match the current chunking output or the checkpoint is rejected as `chunk_mismatch`
- Each completed chunk should have a saved `.npy` file; missing files are reported and regenerated

## Runtime Checkpoint Events

During processing, the backend emits checkpoint events in text or JSON form.

Common codes:

| Code | Meaning |
| --- | --- |
| `NONE` | No checkpoint found in `--check_checkpoint` mode |
| `FOUND` | Checkpoint exists and the EPUB hash matches in `--check_checkpoint` mode |
| `INVALID:hash_mismatch` | Lightweight probe detected different EPUB content |
| `INVALID:config_mismatch` | Resume mode rejected the checkpoint because settings changed |
| `INVALID:chunk_mismatch` | Resume mode rejected the checkpoint because chunk count changed |
| `RESUMING:<n>` | Resume mode accepted the checkpoint with `<n>` completed chunks |
| `REUSED:<idx>` | Chunk audio was reused from checkpoint |
| `MISSING_AUDIO:<idx>` | Chunk was marked complete but its `.npy` file is missing and will be regenerated |
| `SAVED:<idx>` | New chunk audio was saved to checkpoint |
| `CLEANED` | Checkpoint directory was removed after successful completion |

## Lifecycle and Cleanup

### On successful completion

If checkpoint mode was active (`--checkpoint` or `--resume`), the backend cleans up the checkpoint directory and emits `CHECKPOINT:CLEANED`.

### On failure or interruption

Checkpoint artifacts are generally left on disk so you can:
- Resume later
- Inspect partial progress
- Debug a failing run

Temporary spool and export files are cleaned up separately by backend cleanup logic.

## Performance and Behavior Notes

- Checkpointing disables the optimized MP3 streaming path and uses a spool-file export path instead.
- `overlap3` is currently not supported with checkpointing.
- Resume reuse happens at the chunk level, not at partial chunk internals.
- Existing checkpoints can remain on disk even after a non-checkpointed CLI run, because ignored checkpoints are not deleted automatically.

## Troubleshooting

### Resume was expected, but the backend started fresh

Likely cause:
- The EPUB hash matched, but runtime settings changed, such as voice, backend, format, bitrate, normalization, or chunk size

What to do:
- Rerun with the same settings as the original run
- Use the CLI review action to start fresh for resumable jobs
- Manually delete `<output>.checkpoint/`

### `INVALID:hash_mismatch`

The input EPUB content changed since the checkpoint was created.

What to do:
- Restore the original EPUB
- Or delete the checkpoint and start a new run

### `MISSING_AUDIO:<idx>` events during resume

Some chunk `.npy` files are missing or unreadable while the state metadata still exists.

What happens:
- The runtime drops the missing chunk from the completed set
- Regenerates that chunk
- Continues processing

### The CLI ignored a checkpoint instead of deleting it

Likely cause:
- Checkpointing was disabled, so the planner chose `ignore`

What to know:
- Ignored checkpoints stay on disk
- Only `start-fresh` jobs delete checkpoint data before execution

### I want resumability for long jobs by default

Current default is checkpointing off for performance and simplicity.

Use one of these:
- Direct backend: add `--checkpoint`
- Interactive CLI: enable checkpointing in the config wizard

## Related Docs

- `README.md`
- `ARCHITECTURE.md`
- `FORMATS_AND_METADATA.md`
