import argparse
import importlib.util
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import List, Tuple, Optional

import numpy as np
from bs4 import BeautifulSoup
import ebooklib
from ebooklib import epub
from pydub import AudioSegment
from rich.progress import (
    BarColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

from backends import create_backend, TTSBackend
from checkpoint import (
    CheckpointState,
    compute_epub_hash,
    get_checkpoint_dir,
    save_checkpoint,
    load_checkpoint,
    save_chunk_audio,
    load_chunk_audio,
    cleanup_checkpoint,
    verify_checkpoint,
)


DEFAULT_SAMPLE_RATE = 24000

# Optimal chunk sizes per backend based on benchmarks
# MLX: 900 chars = 180 chars/s (+11% vs 1200)
# PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
DEFAULT_CHUNK_CHARS = {
    'mlx': 900,
    'pytorch': 600,
}


def resolve_backend(backend: str) -> str:
    """Resolve backend selection, supporting auto-detection on Apple Silicon."""
    if backend != "auto":
        return backend

    if sys.platform == "darwin" and platform.machine() == "arm64":
        if importlib.util.find_spec("mlx_audio") is None:
            return "pytorch"

        # Probe MLX runtime in a subprocess so native crashes cannot
        # terminate the main process.
        probe = subprocess.run(
            [
                sys.executable,
                "-c",
                "import mlx.core as mx; mx.array([1.0]); print('ok')",
            ],
            capture_output=True,
            timeout=8,
        )
        if probe.returncode == 0:
            return "mlx"

    return "pytorch"


@dataclass
class TextChunk:
    chapter_title: str
    text: str


@dataclass
class BookMetadata:
    title: str
    author: str
    cover_image: Optional[bytes] = None
    cover_mime_type: Optional[str] = None


@dataclass
class ChapterInfo:
    title: str
    start_sample: int
    end_sample: int


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_epub_metadata(epub_path: str) -> BookMetadata:
    """Extract title, author, and cover image from EPUB file."""
    book = epub.read_epub(epub_path)

    # Extract title
    title_meta = book.get_metadata('DC', 'title')
    title = title_meta[0][0] if title_meta else "Unknown Title"

    # Extract author
    author_meta = book.get_metadata('DC', 'creator')
    author = author_meta[0][0] if author_meta else "Unknown Author"

    # Extract cover image
    cover_image = None
    cover_mime_type = None

    # Try ITEM_COVER first
    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover_image = item.get_content()
        cover_mime_type = item.media_type
        break

    # If no ITEM_COVER, look for cover in metadata
    if cover_image is None:
        cover_meta = book.get_metadata('OPF', 'cover')
        if cover_meta:
            cover_id = cover_meta[0][1].get('content') if cover_meta[0][1] else None
            if cover_id:
                for item in book.get_items():
                    if item.get_id() == cover_id:
                        cover_image = item.get_content()
                        cover_mime_type = item.media_type
                        break

    # Fallback: look for image items with "cover" in name
    if cover_image is None:
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            item_name = item.get_name().lower()
            if 'cover' in item_name:
                cover_image = item.get_content()
                cover_mime_type = item.media_type
                break

    return BookMetadata(
        title=title,
        author=author,
        cover_image=cover_image,
        cover_mime_type=cover_mime_type
    )


def extract_epub_text(epub_path: str) -> List[Tuple[str, str]]:
    book = epub.read_epub(epub_path)
    chapters = []

    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        title = ""
        if soup.title and soup.title.string:
            title = soup.title.string.strip()
        text = soup.get_text("\n")
        text = _clean_text(text)
        if text:
            chapters.append((title, text))

    if not chapters:
        raise ValueError("No readable text content found in EPUB.")

    return chapters


def split_text_to_chunks(
    chapters: List[Tuple[str, str]], chunk_chars: int
) -> Tuple[List[TextChunk], List[Tuple[int, str]]]:
    """Split chapters into text chunks and track chapter boundaries.

    Returns:
        Tuple of (chunks, chapter_start_indices) where chapter_start_indices
        is a list of (chunk_index, chapter_title) tuples indicating where
        each chapter starts.
    """
    chunks: List[TextChunk] = []
    chapter_start_indices: List[Tuple[int, str]] = []

    for title, text in chapters:
        paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
        if not paragraphs:
            continue

        # Record the chunk index where this chapter starts
        chapter_start_indices.append((len(chunks), title))

        buffer = ""
        for paragraph in paragraphs:
            if len(buffer) + len(paragraph) + 1 <= chunk_chars:
                buffer = f"{buffer} {paragraph}".strip()
            else:
                if buffer:
                    chunks.append(TextChunk(title, buffer))
                buffer = paragraph

        if buffer:
            chunks.append(TextChunk(title, buffer))

    return chunks, chapter_start_indices


try:
    import torch
except ImportError:
    torch = None


def audio_to_int16(audio) -> np.ndarray:
    """Convert audio tensor/array to int16 numpy array.

    Optimized to avoid unnecessary GPU→CPU transfers when tensor is already on CPU.
    """
    if torch is not None and isinstance(audio, torch.Tensor):
        # Always detach to handle tensors with requires_grad=True
        # Only move to CPU if on MPS/CUDA
        if audio.device.type != 'cpu':
            audio = audio.detach().cpu()
        else:
            audio = audio.detach()
        audio = audio.numpy()
    elif not isinstance(audio, np.ndarray):
        audio = np.asarray(audio)

    if audio.dtype != np.int16:
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    return audio


def audio_to_segment(audio: np.ndarray, rate: int = DEFAULT_SAMPLE_RATE) -> AudioSegment:
    """Convert numpy int16 array to AudioSegment."""
    if audio.dtype != np.int16:
        audio = audio_to_int16(audio)
    return AudioSegment(
        audio.tobytes(),
        frame_rate=rate,
        sample_width=2,
        channels=1,
    )


def _escape_ffmetadata(text: str) -> str:
    r"""Escape special characters for FFMETADATA format.

    FFMETADATA1 requires escaping: =, ;, #, \, and newlines
    """
    text = text.replace('\\', '\\\\')  # Must be first
    text = text.replace('=', '\\=')
    text = text.replace(';', '\\;')
    text = text.replace('#', '\\#')
    text = text.replace('\n', '\\\n')
    return text


def generate_ffmetadata(
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE
) -> str:
    """Generate FFMETADATA1 format string with chapter markers.

    Args:
        metadata: Book metadata (title, author)
        chapters: List of chapter info with sample positions
        sample_rate: Audio sample rate for time conversion

    Returns:
        FFMETADATA1 formatted string
    """
    lines = [";FFMETADATA1"]

    # Global metadata
    lines.append(f"title={_escape_ffmetadata(metadata.title)}")
    lines.append(f"artist={_escape_ffmetadata(metadata.author)}")
    lines.append(f"album={_escape_ffmetadata(metadata.title)}")

    # Chapter markers
    for chapter in chapters:
        # Convert samples to milliseconds (FFMETADATA uses ms as TIMEBASE)
        start_ms = int((chapter.start_sample / sample_rate) * 1000)
        end_ms = int((chapter.end_sample / sample_rate) * 1000)

        lines.append("")
        lines.append("[CHAPTER]")
        lines.append("TIMEBASE=1/1000")
        lines.append(f"START={start_ms}")
        lines.append(f"END={end_ms}")
        lines.append(f"title={_escape_ffmetadata(chapter.title)}")

    return "\n".join(lines)


def export_pcm_to_mp3(
    pcm_data: np.ndarray,
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    """Compatibility helper: export in-memory PCM int16 data to MP3 via ffmpeg.

    The runtime pipeline uses export_pcm_file_to_mp3() for disk spooling.
    This function is kept for backward compatibility in tests/importers.

    Args:
        pcm_data: Audio data as int16 numpy array
        output_path: Path to output MP3 file
        sample_rate: Audio sample rate
        bitrate: Audio bitrate (128k, 192k, 320k)
        normalize: Apply -14 LUFS loudness normalization
    """
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if pcm_data.size == 0:
        # Create minimal silent MP3
        cmd = [ffmpeg_path, "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
               "-t", "0.1", "-b:a", bitrate, "-y", output_path]
        subprocess.run(cmd, check=True, capture_output=True)
        return

    if pcm_data.dtype != np.int16:
        pcm_data = pcm_data.astype(np.int16)

    cmd = [
        ffmpeg_path,
        "-f", "s16le",           # signed 16-bit little-endian
        "-ar", str(sample_rate),
        "-ac", "1",              # mono
        "-i", "pipe:0",          # stdin
    ]

    # Add loudness normalization filter if requested
    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    proc = subprocess.run(cmd, input=pcm_data.tobytes(), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")


def export_pcm_to_m4b(
    pcm_data: np.ndarray,
    output_path: str,
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    """Compatibility helper: export in-memory PCM int16 data to M4B via ffmpeg.

    The runtime pipeline uses export_pcm_file_to_m4b() for disk spooling.
    This function is kept for backward compatibility in tests/importers.

    Args:
        pcm_data: Audio data as int16 numpy array
        output_path: Path to output M4B file
        metadata: Book metadata including optional cover image
        chapters: List of chapter markers
        sample_rate: Audio sample rate
        bitrate: Audio bitrate for AAC encoding
        normalize: Apply -14 LUFS loudness normalization
    """
    import tempfile

    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if pcm_data.dtype != np.int16:
        pcm_data = pcm_data.astype(np.int16)

    # Create temp files for metadata and optional cover
    temp_files = []
    try:
        # Write FFMETADATA file
        metadata_content = generate_ffmetadata(metadata, chapters, sample_rate)
        metadata_file = tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', delete=False
        )
        metadata_file.write(metadata_content)
        metadata_file.close()
        temp_files.append(metadata_file.name)

        # Build ffmpeg command
        cmd = [
            ffmpeg_path,
            "-f", "s16le",           # signed 16-bit little-endian
            "-ar", str(sample_rate),
            "-ac", "1",              # mono
            "-i", "pipe:0",          # stdin (audio)
            "-i", metadata_file.name,  # metadata file
        ]

        # Add cover image if available
        cover_file = None
        if metadata.cover_image:
            # Determine extension from mime type
            ext = '.jpg'
            if metadata.cover_mime_type:
                if 'png' in metadata.cover_mime_type:
                    ext = '.png'
                elif 'gif' in metadata.cover_mime_type:
                    ext = '.gif'

            cover_file = tempfile.NamedTemporaryFile(
                suffix=ext, delete=False
            )
            cover_file.write(metadata.cover_image)
            cover_file.close()
            temp_files.append(cover_file.name)
            cmd.extend(["-i", cover_file.name])

        # Mapping and encoding options
        cmd.extend([
            "-map", "0:a",              # Map audio from stdin
            "-map_metadata", "1",       # Map metadata from metadata file
        ])

        if cover_file:
            cmd.extend([
                "-map", "2:v",          # Map cover image
                "-c:v", "copy",         # Copy cover without re-encoding
                "-disposition:v:0", "attached_pic",
            ])

        # Add loudness normalization filter if requested
        if normalize:
            cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

        cmd.extend([
            "-c:a", "aac",              # AAC audio codec
            "-b:a", bitrate,
            "-movflags", "+faststart",  # Enable streaming
            "-y", output_path,
        ])

        proc = subprocess.run(cmd, input=pcm_data.tobytes(), capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")

    finally:
        # Clean up temp files
        for temp_file in temp_files:
            try:
                os.remove(temp_file)
            except OSError:
                pass


def export_pcm_file_to_mp3(
    pcm_path: str,
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    """Export PCM file to MP3 via ffmpeg."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if not os.path.exists(pcm_path) or os.path.getsize(pcm_path) == 0:
        cmd = [
            ffmpeg_path,
            "-f", "lavfi",
            "-i", f"anullsrc=r={sample_rate}:cl=mono",
            "-t", "0.1",
            "-b:a", bitrate,
            "-y", output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        return

    cmd = [
        ffmpeg_path,
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", pcm_path,
    ]

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")


def export_pcm_file_to_m4b(
    pcm_path: str,
    output_path: str,
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    """Export PCM file to M4B with metadata and optional cover."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    temp_files = []
    try:
        metadata_content = generate_ffmetadata(metadata, chapters, sample_rate)
        metadata_file = tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', delete=False
        )
        metadata_file.write(metadata_content)
        metadata_file.close()
        temp_files.append(metadata_file.name)

        has_audio = os.path.exists(pcm_path) and os.path.getsize(pcm_path) > 0
        if has_audio:
            cmd = [
                ffmpeg_path,
                "-f", "s16le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", pcm_path,
                "-i", metadata_file.name,
            ]
        else:
            cmd = [
                ffmpeg_path,
                "-f", "lavfi",
                "-i", f"anullsrc=r={sample_rate}:cl=mono",
                "-t", "0.1",
                "-i", metadata_file.name,
            ]

        cover_file = None
        if metadata.cover_image:
            ext = '.jpg'
            if metadata.cover_mime_type:
                if 'png' in metadata.cover_mime_type:
                    ext = '.png'
                elif 'gif' in metadata.cover_mime_type:
                    ext = '.gif'

            cover_file = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
            cover_file.write(metadata.cover_image)
            cover_file.close()
            temp_files.append(cover_file.name)
            cmd.extend(["-i", cover_file.name])

        cmd.extend([
            "-map", "0:a",
            "-map_metadata", "1",
        ])

        if cover_file:
            cmd.extend([
                "-map", "2:v",
                "-c:v", "copy",
                "-disposition:v:0", "attached_pic",
            ])

        if normalize:
            cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

        cmd.extend([
            "-c:a", "aac",
            "-b:a", bitrate,
            "-movflags", "+faststart",
            "-y", output_path,
        ])

        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")
    finally:
        for temp_file in temp_files:
            try:
                os.remove(temp_file)
            except OSError:
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="EPUB to audiobook using Kokoro TTS")
    parser.add_argument("--input", required=True, help="Path to input EPUB")
    parser.add_argument("--output", required=True, help="Path to output file (MP3 or M4B)")
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice")
    parser.add_argument("--lang_code", default="a", help="Kokoro language code")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument(
        "--chunk_chars",
        type=int,
        default=None,
        help="Approximate max characters per chunk (default: 900 for MLX, 600 for PyTorch)",
    )
    parser.add_argument(
        "--split_pattern",
        default=r"\n+",
        help="Regex used by Kokoro for internal splitting",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=2,
        help="Number of parallel workers for audio encoding (default: 2)",
    )
    parser.add_argument(
        "--no_rich",
        action="store_true",
        help="Disable rich progress bar (for CLI integration)",
    )
    parser.add_argument(
        "--backend",
        choices=["auto", "pytorch", "mlx", "mock"],
        default="auto",
        help="TTS backend to use (default: auto)",
    )
    parser.add_argument(
        "--format",
        choices=["mp3", "m4b"],
        default="mp3",
        help="Output format: mp3 (default) or m4b (with chapters)",
    )
    parser.add_argument(
        "--bitrate",
        default="192k",
        choices=["128k", "192k", "320k"],
        help="Audio bitrate (default: 192k)",
    )
    parser.add_argument(
        "--normalize",
        action="store_true",
        help="Apply loudness normalization (-14 LUFS)",
    )
    parser.add_argument(
        "--extract_metadata",
        action="store_true",
        help="Extract and print EPUB metadata, then exit",
    )
    parser.add_argument(
        "--title",
        help="Override book title in M4B metadata",
    )
    parser.add_argument(
        "--author",
        help="Override book author in M4B metadata",
    )
    parser.add_argument(
        "--cover",
        help="Override cover image path for M4B",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from checkpoint if available",
    )
    parser.add_argument(
        "--checkpoint",
        action="store_true",
        help="Enable checkpoint saving for resumable processing",
    )
    parser.add_argument(
        "--no_checkpoint",
        action="store_true",
        help="Deprecated no-op flag (checkpointing is disabled by default)",
    )
    parser.add_argument(
        "--check_checkpoint",
        action="store_true",
        help="Check for existing checkpoint and report status, then exit",
    )
    return parser.parse_args()


def main() -> None:
    if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
        raise RuntimeError(
            "Kokoro requires Python 3.10–3.12. Please use a compatible Python version."
        )

    args = parse_args()

    if not os.path.exists(args.input):
        raise FileNotFoundError(f"Input EPUB not found: {args.input}")

    if args.no_checkpoint:
        print(
            "WARN: --no_checkpoint is deprecated and has no effect (checkpointing is opt-in via --checkpoint).",
            file=sys.stderr,
            flush=True,
        )

    # Handle --extract_metadata mode: print metadata and exit
    if args.extract_metadata:
        metadata = extract_epub_metadata(args.input)
        print(f"METADATA:title:{metadata.title}", flush=True)
        print(f"METADATA:author:{metadata.author}", flush=True)
        print(f"METADATA:has_cover:{str(metadata.cover_image is not None).lower()}", flush=True)
        return

    # Checkpoint directory for this output file
    checkpoint_dir = get_checkpoint_dir(args.output)
    use_checkpoint = args.checkpoint or args.resume

    # Handle --check_checkpoint mode: report checkpoint status and exit
    if args.check_checkpoint:
        state = load_checkpoint(checkpoint_dir)
        if state is None:
            print("CHECKPOINT:NONE", flush=True)
        else:
            # Verify the checkpoint matches current input
            current_hash = compute_epub_hash(args.input)
            if state.epub_hash != current_hash:
                print("CHECKPOINT:INVALID:hash_mismatch", flush=True)
            else:
                completed = len(state.completed_chunks)
                print(f"CHECKPOINT:FOUND:{state.total_chunks}:{completed}", flush=True)
        return

    resolved_backend = resolve_backend(args.backend)
    print(f"METADATA:backend_resolved:{resolved_backend}", flush=True)

    # Determine chunk size: use user-provided value or backend-optimal default
    chunk_chars = args.chunk_chars if args.chunk_chars is not None else DEFAULT_CHUNK_CHARS.get(resolved_backend, 600)

    # Phase: Parsing
    print("PHASE:PARSING", flush=True)
    chapters = extract_epub_text(args.input)
    chunks, chapter_start_indices = split_text_to_chunks(chapters, chunk_chars)

    # Extract book metadata for M4B format
    book_metadata = None
    if args.format == "m4b":
        book_metadata = extract_epub_metadata(args.input)

        # Apply metadata overrides if provided
        if args.title:
            book_metadata = BookMetadata(
                title=args.title,
                author=book_metadata.author,
                cover_image=book_metadata.cover_image,
                cover_mime_type=book_metadata.cover_mime_type,
            )
        if args.author:
            book_metadata = BookMetadata(
                title=book_metadata.title,
                author=args.author,
                cover_image=book_metadata.cover_image,
                cover_mime_type=book_metadata.cover_mime_type,
            )
        if args.cover:
            # Load cover image from file
            cover_path = args.cover
            if os.path.exists(cover_path):
                with open(cover_path, 'rb') as f:
                    cover_data = f.read()
                # Determine mime type from extension
                ext = os.path.splitext(cover_path)[1].lower()
                mime_type = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                }.get(ext, 'image/jpeg')
                book_metadata = BookMetadata(
                    title=book_metadata.title,
                    author=book_metadata.author,
                    cover_image=cover_data,
                    cover_mime_type=mime_type,
                )

    # Emit metadata about extracted text
    total_chars = sum(len(chunk.text) for chunk in chunks)
    print(f"METADATA:total_chars:{total_chars}", flush=True)
    print(f"METADATA:chapter_count:{len(chapter_start_indices)}", flush=True)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    total_chunks = len(chunks)

    # Checkpoint/resume handling
    completed_chunks: set[int] = set()
    checkpoint_state = None

    if use_checkpoint and args.resume:
        # Try to resume from checkpoint
        config_for_verify = {
            'voice': args.voice,
            'speed': args.speed,
            'lang_code': args.lang_code,
            'backend': resolved_backend,
            'chunk_chars': chunk_chars,
        }
        if verify_checkpoint(checkpoint_dir, args.input, config_for_verify):
            state = load_checkpoint(checkpoint_dir)
            if state and state.total_chunks == total_chunks:
                completed_chunks = set(state.completed_chunks)
                checkpoint_state = state
                print(f"CHECKPOINT:RESUMING:{len(completed_chunks)}", flush=True)
            else:
                print("CHECKPOINT:INVALID:chunk_mismatch", flush=True)
        else:
            print("CHECKPOINT:INVALID:config_mismatch", flush=True)

    backend: Optional[TTSBackend] = None
    spool_path: Optional[str] = None
    should_cleanup_checkpoint = False
    sample_rate = DEFAULT_SAMPLE_RATE

    try:
        # Initialize the TTS backend
        backend = create_backend(resolved_backend)
        backend.initialize(lang_code=args.lang_code)
        sample_rate = backend.sample_rate

        # Create spool file for incremental PCM writes to avoid RAM spikes
        spool_file = tempfile.NamedTemporaryFile(suffix=".pcm", delete=False)
        spool_path = spool_file.name
        spool_file.close()

        chunk_sample_offsets: List[int] = [0] * total_chunks
        cumulative_samples = 0

        # Rebuild spool by streaming contiguous checkpoint chunks (if resuming)
        if use_checkpoint and args.resume and completed_chunks:
            contiguous = 0
            with open(spool_path, "wb") as spool:
                while contiguous < total_chunks and contiguous in completed_chunks:
                    chunk_audio = load_chunk_audio(checkpoint_dir, contiguous)
                    if chunk_audio is None:
                        break
                    if chunk_audio.dtype != np.int16:
                        chunk_audio = audio_to_int16(chunk_audio)
                    chunk_sample_offsets[contiguous] = cumulative_samples
                    spool.write(chunk_audio.tobytes())
                    cumulative_samples += len(chunk_audio)
                    contiguous += 1

            if contiguous != len(completed_chunks):
                print(
                    f"CHECKPOINT:PARTIAL_PREFIX:{contiguous}",
                    flush=True,
                )
            completed_chunks = set(range(contiguous))

        # Create initial checkpoint state if checkpointing is enabled
        if use_checkpoint:
            if checkpoint_state is None:
                epub_hash = compute_epub_hash(args.input)
                checkpoint_config = {
                    'voice': args.voice,
                    'speed': args.speed,
                    'lang_code': args.lang_code,
                    'backend': resolved_backend,
                    'chunk_chars': chunk_chars,
                }
                checkpoint_state = CheckpointState(
                    epub_hash=epub_hash,
                    config=checkpoint_config,
                    total_chunks=total_chunks,
                    completed_chunks=sorted(completed_chunks),
                    chapter_start_indices=chapter_start_indices,
                )
            else:
                checkpoint_state.completed_chunks = sorted(completed_chunks)
            save_checkpoint(checkpoint_dir, checkpoint_state)

        progress = None
        task_id = None
        if not args.no_rich:
            progress = Progress(
                TextColumn("[bold]Generating[/bold]"),
                BarColumn(),
                TextColumn("{task.completed}/{task.total} chunks"),
                TimeElapsedColumn(),
                TimeRemainingColumn(),
            )
            task_id = progress.add_task("tts", total=total_chunks, completed=len(completed_chunks))

        times: List[float] = []
        last_heartbeat = time.time()

        print(
            f"Processing {total_chunks} chunks with {backend.name} backend (sequential inference + disk spooling)",
            flush=True,
        )

        # Phase: Inference
        print("PHASE:INFERENCE", flush=True)

        def run_inference() -> None:
            nonlocal last_heartbeat, cumulative_samples
            processed_count = len(completed_chunks)
            with open(spool_path, "ab") as spool:
                for idx, chunk in enumerate(chunks):
                    if idx in completed_chunks:
                        continue

                    start = time.perf_counter()
                    print(f"WORKER:0:INFER:Chunk {idx+1}/{total_chunks}", flush=True)

                    chunk_sample_offsets[idx] = cumulative_samples
                    chunk_audio_segments: List[np.ndarray] = []

                    for audio in backend.generate(
                        text=chunk.text,
                        voice=args.voice,
                        speed=args.speed,
                        split_pattern=args.split_pattern,
                    ):
                        int16_audio = audio_to_int16(audio)
                        spool.write(int16_audio.tobytes())
                        cumulative_samples += len(int16_audio)
                        if use_checkpoint:
                            chunk_audio_segments.append(int16_audio)

                    elapsed = time.perf_counter() - start
                    times.append(elapsed)

                    if use_checkpoint:
                        if chunk_audio_segments:
                            chunk_audio = (
                                np.concatenate(chunk_audio_segments)
                                if len(chunk_audio_segments) > 1
                                else chunk_audio_segments[0]
                            )
                        else:
                            chunk_audio = np.array([], dtype=np.int16)

                        save_chunk_audio(checkpoint_dir, idx, chunk_audio)
                        completed_chunks.add(idx)
                        checkpoint_state.completed_chunks = sorted(completed_chunks)
                        save_checkpoint(checkpoint_dir, checkpoint_state)
                        print(f"CHECKPOINT:SAVED:{idx}", flush=True)

                    processed_count += 1
                    print(f"TIMING:{idx}:{int(elapsed*1000)}", flush=True)

                    now = time.time()
                    if now - last_heartbeat >= 5:
                        print(f"HEARTBEAT:{int(now*1000)}", flush=True)
                        last_heartbeat = now

                    if progress and task_id is not None:
                        progress.update(task_id, advance=1)
                    print(f"PROGRESS:{processed_count}/{total_chunks} chunks", flush=True)

        if progress:
            with progress:
                run_inference()
        else:
            run_inference()

        # Phase: Concatenating (kept for CLI protocol compatibility)
        print("PHASE:CONCATENATING", flush=True)
        print("Concatenating audio segments...", flush=True)

        total_samples = cumulative_samples

        # Build chapter info for M4B
        chapter_infos: List[ChapterInfo] = []
        if args.format == "m4b" and chapter_start_indices:
            for i, (chunk_idx, title) in enumerate(chapter_start_indices):
                start_sample = chunk_sample_offsets[chunk_idx] if chunk_idx < len(chunk_sample_offsets) else 0

                if i + 1 < len(chapter_start_indices):
                    next_chunk_idx = chapter_start_indices[i + 1][0]
                    end_sample = chunk_sample_offsets[next_chunk_idx] if next_chunk_idx < len(chunk_sample_offsets) else total_samples
                else:
                    end_sample = total_samples

                chapter_title = title if title else f"Chapter {i + 1}"
                chapter_infos.append(ChapterInfo(
                    title=chapter_title,
                    start_sample=start_sample,
                    end_sample=end_sample
                ))

        output_dir = os.path.dirname(os.path.abspath(args.output))
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)

        # Phase: Exporting
        print("PHASE:EXPORTING", flush=True)
        if args.format == "m4b":
            export_pcm_file_to_m4b(
                spool_path,
                args.output,
                metadata=book_metadata,
                chapters=chapter_infos,
                sample_rate=sample_rate,
                bitrate=args.bitrate,
                normalize=args.normalize,
            )
        else:
            export_pcm_file_to_mp3(
                spool_path,
                args.output,
                sample_rate=sample_rate,
                bitrate=args.bitrate,
                normalize=args.normalize,
            )

        avg_time = sum(times) / max(len(times), 1)
        should_cleanup_checkpoint = use_checkpoint

        if should_cleanup_checkpoint:
            cleanup_checkpoint(checkpoint_dir)
            print("CHECKPOINT:CLEANED", flush=True)

        print("\nDone.")
        print(f"Output: {args.output}")
        print(f"Chunks: {total_chunks}")
        print(f"Average chunk time: {avg_time:.2f}s")
    finally:
        if backend is not None:
            backend.cleanup()
        if spool_path and os.path.exists(spool_path):
            try:
                os.remove(spool_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
