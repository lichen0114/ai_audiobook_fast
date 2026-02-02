import argparse
import os
import re
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor
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


def audio_to_segment(audio: np.ndarray, rate: int = SAMPLE_RATE) -> AudioSegment:
    if not isinstance(audio, np.ndarray):
        try:
            import torch
        except ImportError:
            torch = None

        if torch is not None and isinstance(audio, torch.Tensor):
            audio = audio.detach().cpu().numpy()
        else:
            audio = np.asarray(audio)

    if audio.dtype != np.int16:
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    return AudioSegment(
        audio.tobytes(),
        frame_rate=rate,
        sample_width=2,
        channels=1,
    )


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
    num_workers = max(1, args.workers)

    if not os.path.exists(args.input):
        raise FileNotFoundError(f"Input EPUB not found: {args.input}")

    chapters = extract_epub_text(args.input)
    chunks = split_text_to_chunks(chapters, args.chunk_chars)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    pipeline = KPipeline(lang_code=args.lang_code)
    total_chunks = len(chunks)

    # Queue for text chunks to be processed
    # Each item is (chunk_index, text_chunk)
    chunk_queue: Queue = Queue()
    for idx, chunk in enumerate(chunks):
        chunk_queue.put((idx, chunk))
    
    # Store results by index to ensure correct order
    results_dict: dict = {}
    results_lock = threading.Lock()
    
    completed_count = [0]
    lock = threading.Lock()
    print_lock = threading.Lock()
    errors: List[Exception] = []

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

    def worker(worker_id: int):
        """Combined Worker: Handles both GPU Inference and CPU Encoding"""
        while True:
            try:
                # Non-blocking get or check empty
                if chunk_queue.empty():
                    break
                
                try:
                    item = chunk_queue.get_nowait()
                except:
                    break

                idx, chunk = item
                
                # Status: Inference
                with print_lock:
                    print(f"WORKER:{worker_id}:INFER:Chunk {idx+1}/{total_chunks}", flush=True)

                # 1. Inference (GPU-bound)
                # KPipeline is generally thread-safe for inference if just calling __call__
                # If race conditions occur, we might need a lock around pipeline(), but let's try parallel first for MPS
                start = time.perf_counter()
                
                chunk_audios = []
                # Use a specific list to collect all generator outputs
                for audio in generate_audio_segments(
                    pipeline=pipeline,
                    text=chunk.text,
                    voice=args.voice,
                    speed=args.speed,
                    split_pattern=args.split_pattern,
                ):
                    chunk_audios.append(audio)
                
                # Status: Encoding
                with print_lock:
                    print(f"WORKER:{worker_id}:ENCODE:Chunk {idx+1}", flush=True)

                # 2. Encoding (CPU-bound)
                segments = []
                for audio in chunk_audios:
                    segment = audio_to_segment(audio, rate=SAMPLE_RATE)
                    segments.append(segment)
                
                elapsed = time.perf_counter() - start
                
                # Store results
                with results_lock:
                    results_dict[idx] = segments
                
                with lock:
                    times.append(elapsed)
                    completed_count[0] += 1
                    if progress and task_id is not None:
                        progress.update(task_id, advance=1)
                    # Explicit progress output for CLI parsing
                    with print_lock:
                        print(f"PROGRESS:{completed_count[0]}/{total_chunks} chunks", flush=True)

                # Status: Idle
                with print_lock:
                    print(f"WORKER:{worker_id}:IDLE:", flush=True)

            except Exception as e:
                with lock:
                    errors.append(e)
                # Don't break immediately, maybe just log? 
                # Ideally we stop, but let's try to finish other chunks if possible 
                # or just set a flag to stop all workers.
                break

    print(f"Using {num_workers} parallel workers for Inference + Encoding", flush=True)

    if progress:
        with progress:
            threads = []
            for i in range(num_workers):
                t = threading.Thread(target=worker, args=(i,), daemon=True)
                t.start()
                threads.append(t)

            for t in threads:
                t.join()
    else:
        # Simple execution without rich progress
        threads = []
        for i in range(num_workers):
            t = threading.Thread(target=worker, args=(i,), daemon=True)
            t.start()
            threads.append(t)

        for t in threads:
            t.join()

    if errors:
        raise errors[0]



    # Concatenate all segments in correct order
    print("Concatenating audio segments...", flush=True)
    combined = AudioSegment.empty()
    for idx in range(total_chunks):
        if idx in results_dict:
            for segment in results_dict[idx]:
                combined += segment

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    combined.export(args.output, format="mp3", bitrate="192k")

    avg_time = sum(times) / max(len(times), 1)
    total_est = avg_time * total_chunks

    print("\nDone.")
    print(f"Output: {args.output}")
    print(f"Chunks: {total_chunks}")
    print(f"Workers: {num_workers}")
    print(f"Average chunk time: {avg_time:.2f}s")
    print(f"Estimated total time: {total_est:.2f}s")


if __name__ == "__main__":
    main()

