import argparse
import os
import re
import shutil
import subprocess
import sys
import time
import threading
from dataclasses import dataclass
from queue import Queue
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


DEFAULT_SAMPLE_RATE = 24000

# Optimal chunk sizes per backend based on benchmarks
# MLX: 900 chars = 180 chars/s (+11% vs 1200)
# PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
DEFAULT_CHUNK_CHARS = {
    'mlx': 900,
    'pytorch': 600,
}


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
) -> None:
    """Export raw PCM int16 data directly to MP3 via ffmpeg.

    Bypasses pydub's WAV intermediate file, avoiding the 4GB limit.
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
        "-b:a", bitrate,
        "-y", output_path,
    ]

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
) -> None:
    """Export raw PCM int16 data to M4B with chapters and cover art via ffmpeg.

    Args:
        pcm_data: Audio data as int16 numpy array
        output_path: Path to output M4B file
        metadata: Book metadata including optional cover image
        chapters: List of chapter markers
        sample_rate: Audio sample rate
        bitrate: Audio bitrate for AAC encoding
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
        choices=["pytorch", "mlx"],
        default="pytorch",
        help="TTS backend to use (default: pytorch)",
    )
    parser.add_argument(
        "--format",
        choices=["mp3", "m4b"],
        default="mp3",
        help="Output format: mp3 (default) or m4b (with chapters)",
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

    # Determine chunk size: use user-provided value or backend-optimal default
    chunk_chars = args.chunk_chars if args.chunk_chars is not None else DEFAULT_CHUNK_CHARS.get(args.backend, 600)

    # Phase: Parsing
    print("PHASE:PARSING", flush=True)
    chapters = extract_epub_text(args.input)
    chunks, chapter_start_indices = split_text_to_chunks(chapters, chunk_chars)

    # Extract book metadata for M4B format
    book_metadata = None
    if args.format == "m4b":
        book_metadata = extract_epub_metadata(args.input)

    # Emit metadata about extracted text
    total_chars = sum(len(chunk.text) for chunk in chunks)
    print(f"METADATA:total_chars:{total_chars}", flush=True)
    print(f"METADATA:chapter_count:{len(chapter_start_indices)}", flush=True)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    # Initialize the TTS backend
    backend = create_backend(args.backend)
    backend.initialize(lang_code=args.lang_code)
    sample_rate = backend.sample_rate
    total_chunks = len(chunks)

    # Store results as int16 numpy arrays (not AudioSegments) for O(n) concatenation
    # Dict[chunk_idx, List[np.ndarray]]
    results_dict: dict = {}
    results_lock = threading.Lock()

    # Queue for background CPU encoding: (chunk_idx, audio_tensor)
    encoding_queue: Queue = Queue()
    encoding_error: List[Optional[Exception]] = [None]

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
        task_id = progress.add_task("tts", total=total_chunks)

    times: List[float] = []

    def encoding_worker():
        """Background thread: CPU-bound int16 conversion."""
        try:
            while True:
                item = encoding_queue.get()
                if item is None:  # Sentinel to stop
                    break
                idx, audio = item
                int16_audio = audio_to_int16(audio)
                with results_lock:
                    if idx not in results_dict:
                        results_dict[idx] = []
                    results_dict[idx].append(int16_audio)
        except Exception as e:
            encoding_error[0] = e

    # Start background encoding thread
    encoder_thread = threading.Thread(target=encoding_worker, daemon=True)
    encoder_thread.start()

    print(f"Processing {total_chunks} chunks with {backend.name} backend (sequential inference + background encoding)", flush=True)

    # Phase: Inference
    print("PHASE:INFERENCE", flush=True)
    last_heartbeat = time.time()

    def run_inference():
        """Main thread: sequential GPU inference."""
        nonlocal last_heartbeat
        for idx, chunk in enumerate(chunks):
            start = time.perf_counter()

            # Status: Inference
            print(f"WORKER:0:INFER:Chunk {idx+1}/{total_chunks}", flush=True)

            # Inference - sequential for optimal performance
            for audio in backend.generate(
                text=chunk.text,
                voice=args.voice,
                speed=args.speed,
                split_pattern=args.split_pattern,
            ):
                # Queue audio for background CPU encoding
                encoding_queue.put((idx, audio))

            elapsed = time.perf_counter() - start
            times.append(elapsed)

            # Emit per-chunk timing
            print(f"TIMING:{idx}:{int(elapsed*1000)}", flush=True)

            # Emit heartbeat every 5 seconds
            now = time.time()
            if now - last_heartbeat >= 5:
                print(f"HEARTBEAT:{int(now*1000)}", flush=True)
                last_heartbeat = now

            # Update progress
            if progress and task_id is not None:
                progress.update(task_id, advance=1)
            print(f"PROGRESS:{idx+1}/{total_chunks} chunks", flush=True)

        # Signal encoding thread to finish
        encoding_queue.put(None)

    if progress:
        with progress:
            run_inference()
    else:
        run_inference()

    # Wait for encoding to complete
    encoder_thread.join()

    if encoding_error[0]:
        raise encoding_error[0]

    # Phase: Concatenating
    print("PHASE:CONCATENATING", flush=True)
    # O(n) concatenation: collect all int16 arrays, concatenate once
    # Also track cumulative samples per chunk for chapter markers
    print("Concatenating audio segments...", flush=True)
    all_arrays: List[np.ndarray] = []
    chunk_sample_offsets: List[int] = []  # Sample offset where each chunk starts
    cumulative_samples = 0

    for idx in range(total_chunks):
        chunk_sample_offsets.append(cumulative_samples)
        if idx in results_dict:
            for arr in results_dict[idx]:
                all_arrays.append(arr)
                cumulative_samples += len(arr)

    if all_arrays:
        combined_np = np.concatenate(all_arrays)
    else:
        combined_np = np.array([], dtype=np.int16)

    total_samples = len(combined_np)

    # Build chapter info for M4B
    chapter_infos: List[ChapterInfo] = []
    if args.format == "m4b" and chapter_start_indices:
        for i, (chunk_idx, title) in enumerate(chapter_start_indices):
            start_sample = chunk_sample_offsets[chunk_idx] if chunk_idx < len(chunk_sample_offsets) else 0

            # End sample is the start of the next chapter, or end of audio
            if i + 1 < len(chapter_start_indices):
                next_chunk_idx = chapter_start_indices[i + 1][0]
                end_sample = chunk_sample_offsets[next_chunk_idx] if next_chunk_idx < len(chunk_sample_offsets) else total_samples
            else:
                end_sample = total_samples

            # Use chapter title, falling back to a numbered chapter
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
        export_pcm_to_m4b(
            combined_np,
            args.output,
            metadata=book_metadata,
            chapters=chapter_infos,
            sample_rate=sample_rate,
            bitrate="192k"
        )
    else:
        export_pcm_to_mp3(combined_np, args.output, sample_rate=sample_rate, bitrate="192k")

    avg_time = sum(times) / max(len(times), 1)

    # Cleanup backend resources
    backend.cleanup()

    print("\nDone.")
    print(f"Output: {args.output}")
    print(f"Chunks: {total_chunks}")
    print(f"Average chunk time: {avg_time:.2f}s")


if __name__ == "__main__":
    main()

