import argparse
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Iterable, List, Tuple

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
    return parser.parse_args()


def main() -> None:
    if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
        raise RuntimeError(
            "Kokoro requires Python 3.10–3.12. Please use a compatible Python version."
        )

    args = parse_args()

    if not os.path.exists(args.input):
        raise FileNotFoundError(f"Input EPUB not found: {args.input}")

    chapters = extract_epub_text(args.input)
    chunks = split_text_to_chunks(chapters, args.chunk_chars)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    pipeline = KPipeline(lang_code=args.lang_code)

    combined = AudioSegment.empty()

    progress = Progress(
        TextColumn("[bold]Generating[/bold]"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} chunks"),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
    )

    total_chunks = len(chunks)
    task_id = progress.add_task("tts", total=total_chunks)

    times: List[float] = []

    with progress:
        for chunk in chunks:
            start = time.perf_counter()

            for audio in generate_audio_segments(
                pipeline=pipeline,
                text=chunk.text,
                voice=args.voice,
                speed=args.speed,
                split_pattern=args.split_pattern,
            ):
                combined += audio_to_segment(audio, rate=SAMPLE_RATE)

            elapsed = time.perf_counter() - start
            times.append(elapsed)

            progress.update(task_id, advance=1)

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    combined.export(args.output, format="mp3", bitrate="192k")

    avg_time = sum(times) / max(len(times), 1)
    total_est = avg_time * total_chunks

    print("\nDone.")
    print(f"Output: {args.output}")
    print(f"Chunks: {total_chunks}")
    print(f"Average chunk time: {avg_time:.2f}s")
    print(f"Estimated total time: {total_est:.2f}s")


if __name__ == "__main__":
    main()
