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
from typing import Iterable, List, Tuple, Optional

import numpy as np
from bs4 import BeautifulSoup
import ebooklib
from ebooklib import epub
from kokoro import KPipeline
from pydub import AudioSegment
from rich.progress import (
    BarColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)


SAMPLE_RATE = 24000


@dataclass
class TextChunk:
    chapter_title: str
    text: str


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text


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


def split_text_to_chunks(chapters: List[Tuple[str, str]], chunk_chars: int) -> List[TextChunk]:
    chunks: List[TextChunk] = []

    for title, text in chapters:
        paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
        if not paragraphs:
            continue

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

    return chunks


try:
    import torch
except ImportError:
    torch = None


def audio_to_int16(audio) -> np.ndarray:
    """Convert audio tensor/array to int16 numpy array.

    Optimized to avoid unnecessary GPU→CPU transfers when tensor is already on CPU.
    """
    if torch is not None and isinstance(audio, torch.Tensor):
        # Only move to CPU if on MPS/CUDA
        if audio.device.type != 'cpu':
            audio = audio.detach().cpu()
        audio = audio.numpy()
    elif not isinstance(audio, np.ndarray):
        audio = np.asarray(audio)

    if audio.dtype != np.int16:
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    return audio


def audio_to_segment(audio: np.ndarray, rate: int = SAMPLE_RATE) -> AudioSegment:
    """Convert numpy int16 array to AudioSegment."""
    if audio.dtype != np.int16:
        audio = audio_to_int16(audio)
    return AudioSegment(
        audio.tobytes(),
        frame_rate=rate,
        sample_width=2,
        channels=1,
    )


def export_pcm_to_mp3(
    pcm_data: np.ndarray,
    output_path: str,
    sample_rate: int = SAMPLE_RATE,
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


def generate_audio_segments(
    pipeline: KPipeline,
    text: str,
    voice: str,
    speed: float,
    split_pattern: str,
) -> Iterable[np.ndarray]:
    generator = pipeline(text, voice=voice, speed=speed, split_pattern=split_pattern)
    for _, _, audio in generator:
        yield audio


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="EPUB to MP3 using Kokoro TTS")
    parser.add_argument("--input", required=True, help="Path to input EPUB")
    parser.add_argument("--output", required=True, help="Path to output MP3")
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice")
    parser.add_argument("--lang_code", default="a", help="Kokoro language code")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument(
        "--chunk_chars",
        type=int,
        default=1200,
        help="Approximate max characters per chunk",
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
    return parser.parse_args()


def main() -> None:
    if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
        raise RuntimeError(
            "Kokoro requires Python 3.10–3.12. Please use a compatible Python version."
        )

    args = parse_args()

    if not os.path.exists(args.input):
        raise FileNotFoundError(f"Input EPUB not found: {args.input}")

    # Phase: Parsing
    print("PHASE:PARSING", flush=True)
    chapters = extract_epub_text(args.input)
    chunks = split_text_to_chunks(chapters, args.chunk_chars)

    # Emit metadata about extracted text
    total_chars = sum(len(chunk.text) for chunk in chunks)
    print(f"METADATA:total_chars:{total_chars}", flush=True)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    pipeline = KPipeline(lang_code=args.lang_code)
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

    print(f"Processing {total_chunks} chunks (sequential GPU + background encoding)", flush=True)

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

            # GPU inference - sequential for MPS (no benefit from threading)
            for audio in generate_audio_segments(
                pipeline=pipeline,
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
    print("Concatenating audio segments...", flush=True)
    all_arrays: List[np.ndarray] = []
    for idx in range(total_chunks):
        if idx in results_dict:
            all_arrays.extend(results_dict[idx])

    if all_arrays:
        combined_np = np.concatenate(all_arrays)
    else:
        combined_np = np.array([], dtype=np.int16)

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Phase: Exporting
    print("PHASE:EXPORTING", flush=True)
    export_pcm_to_mp3(combined_np, args.output, sample_rate=SAMPLE_RATE, bitrate="192k")

    avg_time = sum(times) / max(len(times), 1)

    print("\nDone.")
    print(f"Output: {args.output}")
    print(f"Chunks: {total_chunks}")
    print(f"Average chunk time: {avg_time:.2f}s")


if __name__ == "__main__":
    main()

