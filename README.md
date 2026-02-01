# EPUB → MP3 Generator (Kokoro TTS)

Generate an audiobook MP3 from an EPUB using the Kokoro TTS model. Includes a progress bar with ETA.

## Setup

**Python 3.10–3.12 required** (Kokoro does not support 3.13 yet).

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**FFmpeg is required** for MP3 export:

```bash
brew install ffmpeg
```

## Usage

```bash
python app.py --input /path/to/book.epub --output /path/to/book.mp3
```

### Common options

```bash
python app.py \
  --input /path/to/book.epub \
  --output /path/to/book.mp3 \
  --voice af_heart \
  --lang_code a \
  --speed 1.0 \
  --chunk_chars 1200
```

### Apple Silicon GPU acceleration (optional)

```bash
PYTORCH_ENABLE_MPS_FALLBACK=1 python app.py --input book.epub --output book.mp3
```

## Notes

- MP3 export uses FFmpeg via `pydub`.
- ETA is based on average processing speed per chunk and will stabilize after the first few chunks.
