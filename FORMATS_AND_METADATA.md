# Formats and Metadata

This guide explains output format behavior and how metadata is extracted, overridden, and embedded.

## Overview

The backend supports two output formats:
- `mp3` (default)
- `m4b` (audiobook container with chapters and embedded metadata)

Both are exported through direct `ffmpeg` subprocess calls in `app.py`.

## MP3 vs M4B at a Glance

| Topic | MP3 | M4B |
| --- | --- | --- |
| Default format | Yes | No |
| Container and codec | MP3 | `.m4b` with AAC audio |
| Chapter markers | No | Yes |
| Embedded title and author | Not a primary part of the current pipeline | Yes, via `ffmetadata` |
| Cover art embedding | No | Yes, optional |
| Streaming export path | Yes, when checkpointing is off | No |
| Checkpoint support | Yes | Yes |

## MP3 Export Behavior

MP3 export uses `ffmpeg` directly.

Current runtime has two MP3 paths:
1. Streaming path
   - Used when output is `mp3` and checkpointing is off
   - PCM is streamed directly into an `ffmpeg` subprocess
2. Spool-file path
   - Used when checkpointing is on, or whenever the streaming path is not used
   - Backend writes PCM to a temporary file, then runs `ffmpeg`

### MP3 options

- `--bitrate {128k,192k,320k}`
- `--normalize`

Example:

```bash
.venv/bin/python app.py \
  --input book.epub \
  --output book.mp3 \
  --bitrate 320k \
  --normalize
```

## M4B Export Behavior

M4B export always uses a spool-file path in the current implementation.

### What gets embedded

- Title from EPUB metadata or `--title`
- Author from EPUB metadata or `--author`
- Chapter markers derived from parsed EPUB content documents and final sample offsets
- Optional cover image from `--cover` or the EPUB cover when present

### M4B options

- `--format m4b`
- `--bitrate {128k,192k,320k}`
- `--normalize`
- `--title`
- `--author`
- `--cover`

Example:

```bash
.venv/bin/python app.py \
  --format m4b \
  --title "My Book" \
  --author "Someone" \
  --cover ./cover.png \
  --input book.epub \
  --output book.m4b
```

## Metadata Sources and Override Precedence

### EPUB metadata extraction

The backend can extract EPUB metadata with:

```bash
.venv/bin/python app.py --extract_metadata --input book.epub --output /dev/null
```

The backend emits metadata including:
- `title`
- `author`
- `has_cover`

The interactive CLI uses this helper before the metadata editor flow for single-file M4B runs.

### Direct backend usage

When `--format m4b` is used directly:
1. The backend extracts metadata from the EPUB
2. Explicit overrides from `--title`, `--author`, and `--cover` are applied
3. Final metadata is exported through `ffmetadata` and `ffmpeg`

### Interactive CLI usage

The current CLI behavior depends on batch size:

| CLI path | Current behavior |
| --- | --- |
| Single-file `m4b` | Opens the metadata editor, lets the user review title, author, and cover, and only passes explicit edits as overrides |
| Multi-file `m4b` | Skips the metadata editor and keeps per-file EPUB metadata without a per-file override UI |
| Any non-`m4b` output | Does not keep metadata override fields |

This distinction matters because the CLI planner strips metadata override fields unless the batch contains exactly one file and the output format is `m4b`.

If metadata extraction fails in the CLI, the editor opens with blank text fields and a warning so the final M4B keeps EPUB metadata unless the user explicitly enters overrides.

### Cover image overrides

`--cover <path>` replaces the EPUB cover when present.

Supported extension handling in the current backend:
- `.jpg`, `.jpeg` -> `image/jpeg`
- `.png` -> `image/png`
- `.gif` -> `image/gif`
- Unknown extension -> defaults to `image/jpeg`

If the file does not exist, the backend raises `FileNotFoundError`.

## Chapter Markers (M4B)

Chapter markers are generated from parsed EPUB content sections after chunking and audio generation.

At a high level:
1. EPUB parsing extracts body content, preserves paragraph boundaries, skips navigation-only documents, and derives a section title from TOC labels, visible headings, or HTML `<title>`
2. EPUB text is split into chunks while preserving chapter-start references
3. The backend tracks sample offsets while processing chunks
4. Chapter boundaries are converted into `ffmetadata` chapter entries using a sample-accurate timebase
5. `ffmpeg` writes the final M4B with embedded chapters

If a section title cannot be derived, the backend falls back to `Chapter <n>`.

## Format-Specific Operational Notes

### Checkpointing and format choice

- Checkpointing works with both MP3 and M4B.
- Checkpointing disables the MP3 streaming fast path and forces the spool-file path.
- `overlap3` is currently restricted to MP3 without checkpointing.

### Bitrate and normalization

- `--bitrate` affects both MP3 and M4B outputs.
- `--normalize` adds an `ffmpeg` loudness filter to both formats.
- Normalization can increase processing time slightly.

### Limitations to keep in mind

- Chapter markers are implemented for M4B only.
- The current interactive CLI does not expose per-file metadata override editing for multi-file M4B batches.
- MP3 output does not use the M4B chapter and cover metadata path.

## Troubleshooting

### M4B produced without the expected metadata

Check:
- You used `--format m4b`
- Override flags were passed correctly for direct backend usage
- The cover file path exists and is readable
- If you used the interactive CLI, confirm whether the run was single-file or multi-file

### Cover override failed

Common causes:
- Wrong path
- Path contains shell characters without quoting
- Unsupported or mislabeled file extension

### I expected chapter markers in MP3

Chapter markers are implemented for M4B output only. Use `--format m4b`.

## Related Docs

- `README.md`
- `ARCHITECTURE.md`
- `CHECKPOINTS.md`
