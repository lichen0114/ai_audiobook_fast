import argparse
import gc
from contextlib import nullcontext
import importlib.util
import json
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, TextIO, Tuple

import numpy as np
from bs4 import BeautifulSoup
try:
    import ebooklib
    from ebooklib import epub
except ImportError:  # pragma: no cover - exercised via fallback tests
    class _EbooklibFallback:
        ITEM_COVER = "ITEM_COVER"
        ITEM_IMAGE = "ITEM_IMAGE"
        ITEM_DOCUMENT = "ITEM_DOCUMENT"

    ebooklib = _EbooklibFallback()
    epub = None
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
    CheckpointInspection,
    CheckpointState,
    compute_epub_hash,
    get_checkpoint_dir,
    save_checkpoint,
    load_checkpoint,
    save_chunk_audio,
    load_chunk_audio,
    cleanup_checkpoint,
    inspect_checkpoint,
    verify_checkpoint,
)


DEFAULT_SAMPLE_RATE = 24000
LOW_MEMORY_APPLE_MEMORY_THRESHOLD_BYTES = 8 * 1024 * 1024 * 1024
LOW_MEMORY_APPLE_PYTORCH_CHUNK_CHARS = 400
SECTION_BLOCK_TAGS = (
    "p",
    "li",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dt",
    "dd",
)
NAV_DOCUMENT_HINT_RE = re.compile(
    r"(^|[\\/._-])(nav|toc|contents?|landmarks?)([\\/._-]|$)",
    re.IGNORECASE,
)

# Optimal chunk sizes per backend based on benchmarks
# MLX: 900 chars = 180 chars/s (+11% vs 1200)
# PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
DEFAULT_CHUNK_CHARS = {
    'mlx': 900,
    'pytorch': 600,
}

_AUTO_BACKEND_CACHE: Optional[str] = None


def _parse_env_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def is_apple_silicon_host() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def _get_macos_total_memory_bytes() -> Optional[int]:
    if sys.platform != "darwin":
        return None

    try:
        probe = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if probe.returncode != 0:
        return None

    try:
        return int(probe.stdout.strip())
    except ValueError:
        return None


def is_low_memory_apple_host() -> bool:
    forced = _parse_env_bool(os.getenv("AUDIOBOOK_FORCE_LOW_MEMORY_APPLE"))
    if forced is not None:
        return forced

    if not is_apple_silicon_host():
        return False

    total_memory = _get_macos_total_memory_bytes()
    if total_memory is None:
        return False

    return total_memory <= LOW_MEMORY_APPLE_MEMORY_THRESHOLD_BYTES


def default_chunk_chars_for_backend(resolved_backend: str) -> int:
    if resolved_backend == "pytorch" and is_low_memory_apple_host():
        return LOW_MEMORY_APPLE_PYTORCH_CHUNK_CHARS
    return DEFAULT_CHUNK_CHARS.get(resolved_backend, 600)


def resolve_device_for_args(
    args: argparse.Namespace,
    resolved_backend: str,
) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    requested_device = getattr(args, "device", "auto")

    if resolved_backend == "mlx":
        if requested_device != "auto":
            warnings.append(
                f"--device={requested_device} is ignored for MLX backend."
            )
        return "mlx", warnings

    if resolved_backend == "mock":
        if requested_device != "auto":
            warnings.append(
                f"--device={requested_device} is ignored for mock backend."
            )
        return "cpu", warnings

    if requested_device == "auto":
        if is_low_memory_apple_host():
            return "cpu", warnings
        if is_apple_silicon_host():
            return "mps", warnings
        return "auto", warnings

    return requested_device, warnings


def default_pipeline_mode(output_format: str, use_checkpoint: bool) -> str:
    """Choose the safest default pipeline mode."""
    return "sequential"


class EventEmitter:
    """Emit progress/log events in legacy text or structured JSON format."""

    def __init__(
        self,
        event_format: str = "text",
        job_id: str = "job",
        log_file: Optional[str] = None,
    ):
        self.event_format = event_format
        self.job_id = job_id
        self._log_fp: Optional[TextIO] = None
        self._write_lock = threading.Lock()

        if log_file:
            log_dir = os.path.dirname(os.path.abspath(log_file))
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)
            self._log_fp = open(log_file, "a", encoding="utf-8")

    def _write(self, line: str, *, stderr: bool = False) -> None:
        with self._write_lock:
            stream = sys.stderr if stderr else sys.stdout
            print(line, file=stream, flush=True)
            if self._log_fp is not None:
                self._log_fp.write(line + "\n")
                self._log_fp.flush()

    def close(self) -> None:
        if self._log_fp is not None:
            self._log_fp.close()
            self._log_fp = None

    def _emit_json(self, event_type: str, **payload: Any) -> None:
        body = {
            "type": event_type,
            "ts_ms": int(time.time() * 1000),
            "job_id": self.job_id,
            **payload,
        }
        self._write(json.dumps(body, ensure_ascii=False))

    def _emit_text_event(self, event_type: str, payload: Dict[str, Any]) -> None:
        if event_type == "phase":
            self._write(f"PHASE:{payload['phase']}")
            return
        if event_type == "metadata":
            self._write(f"METADATA:{payload['key']}:{payload['value']}")
            return
        if event_type == "timing":
            self._write(f"TIMING:{payload['chunk_idx']}:{payload['chunk_timing_ms']}")
            return
        if event_type == "parse_progress":
            self._write(
                "PARSE_PROGRESS:"
                f"{payload['current_item']}/{payload['total_items']}:"
                f"{payload['current_chapter_count']}"
            )
            return
        if event_type == "heartbeat":
            self._write(f"HEARTBEAT:{payload['heartbeat_ts']}")
            return
        if event_type == "worker":
            self._write(
                f"WORKER:{payload['id']}:{payload['status']}:{payload['details']}"
            )
            return
        if event_type == "progress":
            self._write(
                f"PROGRESS:{payload['current_chunk']}/{payload['total_chunks']} chunks"
            )
            return
        if event_type == "checkpoint":
            code = payload.get("code")
            detail = payload.get("detail")
            if detail is not None:
                self._write(f"CHECKPOINT:{code}:{detail}")
            else:
                self._write(f"CHECKPOINT:{code}")
            return
        if event_type == "error":
            self._write(payload["message"], stderr=True)
            return
        if event_type == "done":
            self._write("DONE")
            return
        if event_type == "inspection":
            self._write(f"INSPECTION:{json.dumps(payload['result'], ensure_ascii=False)}")
            return

    def emit(self, event_type: str, **payload: Any) -> None:
        if self.event_format == "json":
            self._emit_json(event_type, **payload)
        else:
            self._emit_text_event(event_type, payload)

    def info(self, message: str) -> None:
        if self.event_format == "json":
            self._emit_json("log", level="info", message=message)
        else:
            self._write(message)

    def warn(self, message: str) -> None:
        if self.event_format == "json":
            self._emit_json("log", level="warning", message=message)
        else:
            self._write(f"WARN: {message}", stderr=True)

    def error(self, message: str) -> None:
        if self.event_format == "json":
            self._emit_json("error", message=message)
        else:
            self._write(message, stderr=True)


def resolve_backend(backend: str) -> str:
    """Resolve backend selection, supporting auto-detection on Apple Silicon."""
    global _AUTO_BACKEND_CACHE

    if backend != "auto":
        return backend

    if _AUTO_BACKEND_CACHE is not None:
        return _AUTO_BACKEND_CACHE

    if is_apple_silicon_host():
        if is_low_memory_apple_host():
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

        if importlib.util.find_spec("mlx_audio") is None:
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

        # Probe MLX runtime in a subprocess so native crashes cannot
        # terminate the main process.
        try:
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
                _AUTO_BACKEND_CACHE = "mlx"
                return _AUTO_BACKEND_CACHE
        except subprocess.TimeoutExpired:
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

    _AUTO_BACKEND_CACHE = "pytorch"
    return _AUTO_BACKEND_CACHE


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
class ParsedSection:
    title: str
    text: str
    href: str = ""
    item_id: str = ""


@dataclass
class ParsedEpub:
    metadata: BookMetadata
    chapters: List[ParsedSection]


@dataclass
class ChapterInfo:
    title: str
    start_sample: int
    end_sample: int


@dataclass
class JobInspectionResult:
    input_path: str
    output_path: str
    resolved_backend: str
    resolved_device: str
    resolved_chunk_chars: int
    resolved_pipeline_mode: str
    output_format: str
    total_chars: int
    total_chunks: int
    chapter_count: int
    epub_metadata: Dict[str, Any]
    checkpoint: Dict[str, Any]
    warnings: List[str]
    errors: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "input_path": self.input_path,
            "output_path": self.output_path,
            "resolved_backend": self.resolved_backend,
            "resolved_device": self.resolved_device,
            "resolved_chunk_chars": self.resolved_chunk_chars,
            "resolved_pipeline_mode": self.resolved_pipeline_mode,
            "output_format": self.output_format,
            "total_chars": self.total_chars,
            "total_chunks": self.total_chunks,
            "chapter_count": self.chapter_count,
            "epub_metadata": self.epub_metadata,
            "checkpoint": self.checkpoint,
            "warnings": self.warnings,
            "errors": self.errors,
        }


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clean_text_with_paragraphs(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = []

    for raw_paragraph in re.split(r"\n\s*\n+", text):
        paragraph = re.sub(r"\s+", " ", raw_paragraph).strip()
        if paragraph:
            paragraphs.append(paragraph)

    return "\n\n".join(paragraphs)


def _require_epub_support() -> None:
    if epub is None:
        raise ImportError(
            "ebooklib is required for EPUB parsing. Install with: pip install ebooklib"
        )


def _load_epub_book(epub_path: str) -> Any:
    _require_epub_support()
    return epub.read_epub(epub_path)


def _extract_book_metadata(book: Any) -> BookMetadata:
    """Extract title, author, and cover image from a loaded EPUB book."""
    title_meta = book.get_metadata('DC', 'title')
    title = title_meta[0][0] if title_meta else "Unknown Title"

    author_meta = book.get_metadata('DC', 'creator')
    author = author_meta[0][0] if author_meta else "Unknown Author"

    cover_image = None
    cover_mime_type = None

    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover_image = item.get_content()
        cover_mime_type = item.media_type
        break

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


def extract_epub_metadata(epub_path: str) -> BookMetadata:
    """Extract title, author, and cover image from EPUB file."""
    book = _load_epub_book(epub_path)
    return _extract_book_metadata(book)


def _normalize_href_reference(value: Optional[str]) -> str:
    if not value:
        return ""

    normalized = str(value).split("#", 1)[0].strip().lower()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _iter_toc_entries(entries: Any) -> Any:
    if not entries:
        return

    if isinstance(entries, tuple):
        for entry in entries:
            yield from _iter_toc_entries(entry)
        return

    if isinstance(entries, list):
        for entry in entries:
            yield from _iter_toc_entries(entry)
        return

    yield entries

    subitems = getattr(entries, "subitems", None)
    if subitems:
        yield from _iter_toc_entries(subitems)


def _build_toc_label_map(book: Any) -> Dict[str, str]:
    toc_labels: Dict[str, str] = {}
    toc = getattr(book, "toc", None)
    if not isinstance(toc, (list, tuple)):
        return toc_labels

    for entry in _iter_toc_entries(toc):
        href = _normalize_href_reference(getattr(entry, "href", None))
        title = getattr(entry, "title", None) or getattr(entry, "text", None)
        if href and isinstance(title, str):
            cleaned_title = _clean_text(title)
            if cleaned_title:
                toc_labels.setdefault(href, cleaned_title)

    return toc_labels


def _get_item_reference_candidates(item: Any) -> List[str]:
    raw_candidates: List[str] = []

    for attr_name in ("file_name", "href"):
        value = getattr(item, attr_name, None)
        if isinstance(value, str):
            raw_candidates.append(value)

    for method_name in ("get_name", "get_id"):
        method = getattr(item, method_name, None)
        if callable(method):
            try:
                value = method()
            except TypeError:
                continue
            if isinstance(value, str):
                raw_candidates.append(value)

    normalized_candidates: List[str] = []
    for candidate in raw_candidates:
        normalized = _normalize_href_reference(candidate)
        if normalized and normalized not in normalized_candidates:
            normalized_candidates.append(normalized)

    return normalized_candidates


def _get_item_properties(item: Any) -> List[str]:
    properties = getattr(item, "properties", None)
    if properties is None:
        get_properties = getattr(item, "get_properties", None)
        if callable(get_properties):
            try:
                properties = get_properties()
            except TypeError:
                properties = None

    if not properties:
        return []

    if not isinstance(properties, (list, tuple, set)):
        return []

    return [str(property_value).lower() for property_value in properties]


def _is_navigation_document(item: Any) -> bool:
    properties = _get_item_properties(item)
    if "nav" in properties:
        return True

    return any(
        NAV_DOCUMENT_HINT_RE.search(candidate) is not None
        for candidate in _get_item_reference_candidates(item)
    )


def _prune_non_content_nodes(body: Any) -> None:
    for node in list(body.find_all(["script", "style"])):
        node.decompose()

    for node in list(body.find_all(True)):
        if node.name == "nav":
            node.decompose()
            continue

        attr_values = [
            node.get("role"),
            node.get("epub:type"),
            node.get("id"),
            " ".join(node.get("class", [])),
        ]
        if any(
            isinstance(value, str)
            and re.search(r"\b(toc|landmarks?)\b", value, re.IGNORECASE)
            for value in attr_values
        ):
            node.decompose()


def _extract_body_text(soup: BeautifulSoup) -> str:
    body = soup.body or soup
    _prune_non_content_nodes(body)

    paragraphs: List[str] = []
    for node in body.find_all(SECTION_BLOCK_TAGS):
        if node.find(SECTION_BLOCK_TAGS):
            continue

        text = _clean_text(node.get_text(" ", strip=True))
        if text:
            paragraphs.append(text)

    if not paragraphs:
        fallback_text = _clean_text(body.get_text(" ", strip=True))
        if fallback_text:
            paragraphs.append(fallback_text)

    return _clean_text_with_paragraphs("\n\n".join(paragraphs))


def _resolve_section_title(
    item: Any,
    soup: BeautifulSoup,
    toc_labels: Dict[str, str],
    chapter_number: int,
) -> str:
    for candidate in _get_item_reference_candidates(item):
        toc_title = toc_labels.get(candidate)
        if toc_title:
            return toc_title

    body = soup.body or soup
    for heading_tag in ("h1", "h2"):
        heading = body.find(heading_tag)
        if heading is None:
            continue

        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if heading_text:
            return heading_text

    if soup.title is not None:
        title_text = _clean_text(soup.title.get_text(" ", strip=True))
        if title_text:
            return title_text

    return f"Chapter {chapter_number}"


def parse_loaded_epub(
    book: Any,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> ParsedEpub:
    metadata = _extract_book_metadata(book)
    chapters: List[ParsedSection] = []
    document_items = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))
    total_items = len(document_items)
    toc_labels = _build_toc_label_map(book)

    for idx, item in enumerate(document_items, start=1):
        if _is_navigation_document(item):
            if progress_callback is not None:
                progress_callback(idx, total_items, len(chapters))
            continue

        soup = BeautifulSoup(item.get_content(), "html.parser")
        text = _extract_body_text(soup)
        if text:
            chapters.append(
                ParsedSection(
                    title=_resolve_section_title(item, soup, toc_labels, len(chapters) + 1),
                    text=text,
                    href=next(iter(_get_item_reference_candidates(item)), ""),
                    item_id=(
                        item.get_id()
                        if callable(getattr(item, "get_id", None))
                        else ""
                    ),
                )
            )
        if progress_callback is not None:
            progress_callback(idx, total_items, len(chapters))

    if not chapters:
        raise ValueError("No readable text content found in EPUB.")

    return ParsedEpub(metadata=metadata, chapters=chapters)


def parse_epub(
    epub_path: str,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> ParsedEpub:
    book = _load_epub_book(epub_path)
    return parse_loaded_epub(book, progress_callback=progress_callback)


def start_heartbeat_emitter(
    events: EventEmitter,
    interval_seconds: float = 5.0,
    thread_name: str = "event-heartbeat",
) -> Tuple[threading.Event, threading.Thread]:
    stop_event = threading.Event()

    def heartbeat_worker() -> None:
        while not stop_event.wait(interval_seconds):
            events.emit("heartbeat", heartbeat_ts=int(time.time() * 1000))

    thread = threading.Thread(
        target=heartbeat_worker,
        name=thread_name,
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def extract_epub_text(epub_path: str) -> List[Tuple[str, str]]:
    return [(chapter.title, chapter.text) for chapter in parse_epub(epub_path).chapters]


def split_text_to_chunks(
    chapters: List[Tuple[str, str] | ParsedSection], chunk_chars: int
) -> Tuple[List[TextChunk], List[Tuple[int, str]]]:
    """Split chapters into text chunks and track chapter boundaries.

    Returns:
        Tuple of (chunks, chapter_start_indices) where chapter_start_indices
        is a list of (chunk_index, chapter_title) tuples indicating where
        each chapter starts.
    """
    chunks: List[TextChunk] = []
    chapter_start_indices: List[Tuple[int, str]] = []

    def split_oversized_paragraph(paragraph: str) -> List[str]:
        """Split oversized paragraphs into sentence-aware chunks."""
        if len(paragraph) <= chunk_chars:
            return [paragraph]

        pieces: List[str] = []
        sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        sentence_buffer = ""

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            if len(sentence) > chunk_chars:
                if sentence_buffer:
                    pieces.append(sentence_buffer)
                    sentence_buffer = ""
                for start in range(0, len(sentence), chunk_chars):
                    pieces.append(sentence[start:start + chunk_chars])
                continue

            candidate = f"{sentence_buffer} {sentence}".strip()
            if len(candidate) <= chunk_chars:
                sentence_buffer = candidate
            else:
                if sentence_buffer:
                    pieces.append(sentence_buffer)
                sentence_buffer = sentence

        if sentence_buffer:
            pieces.append(sentence_buffer)

        return pieces if pieces else [paragraph]

    for chapter in chapters:
        if isinstance(chapter, ParsedSection):
            title = chapter.title
            text = chapter.text
        else:
            title, text = chapter

        paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
        if not paragraphs:
            continue

        # Record the chunk index where this chapter starts
        chapter_start_indices.append((len(chunks), title))

        buffer = ""
        for paragraph in paragraphs:
            for piece in split_oversized_paragraph(paragraph):
                if len(buffer) + len(piece) + 1 <= chunk_chars:
                    buffer = f"{buffer} {piece}".strip()
                else:
                    if buffer:
                        chunks.append(TextChunk(title, buffer))
                    buffer = piece

        if buffer:
            chunks.append(TextChunk(title, buffer))

    return chunks, chapter_start_indices


def build_checkpoint_config(
    args: argparse.Namespace,
    resolved_backend: str,
    chunk_chars: int,
    resolved_device: str,
) -> Dict[str, Any]:
    """Build the checkpoint compatibility config shared by inspect and run modes."""
    return {
        "voice": args.voice,
        "speed": args.speed,
        "lang_code": args.lang_code,
        "backend": resolved_backend,
        "device": resolved_device if resolved_backend == "pytorch" else "auto",
        "chunk_chars": chunk_chars,
        "split_pattern": args.split_pattern,
        "format": args.format,
        "bitrate": args.bitrate,
        "normalize": args.normalize,
    }


def resolve_pipeline_mode_for_args(
    args: argparse.Namespace,
    use_checkpoint: bool,
) -> Tuple[str, List[str]]:
    """Resolve the effective pipeline mode and any compatibility warnings."""
    warnings: List[str] = []
    requested_pipeline_mode = args.pipeline_mode or default_pipeline_mode(
        args.format, use_checkpoint
    )
    pipeline_mode = requested_pipeline_mode
    if pipeline_mode == "overlap3" and (args.format != "mp3" or use_checkpoint):
        warnings.append(
            "--pipeline_mode=overlap3 is currently supported only for MP3 "
            "without checkpointing; falling back to sequential."
        )
        pipeline_mode = "sequential"
    return pipeline_mode, warnings


def apply_metadata_overrides(
    base_metadata: BookMetadata,
    args: argparse.Namespace,
) -> BookMetadata:
    """Apply CLI metadata override flags to extracted EPUB metadata."""
    book_metadata = base_metadata

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
        cover_path = os.path.abspath(args.cover)
        if not os.path.exists(cover_path):
            raise FileNotFoundError(
                f"Cover override file not found: {cover_path}"
            )
        with open(cover_path, "rb") as f:
            cover_data = f.read()
        book_metadata = BookMetadata(
            title=book_metadata.title,
            author=book_metadata.author,
            cover_image=cover_data,
            cover_mime_type=_infer_cover_mime_type_from_path(cover_path),
        )

    return book_metadata


def inspect_job(args: argparse.Namespace) -> JobInspectionResult:
    """Inspect a job before execution so the CLI can plan an entire batch."""
    checkpoint_dir = get_checkpoint_dir(args.output)
    use_checkpoint = args.checkpoint or args.resume
    resolved_backend = resolve_backend(args.backend)
    resolved_device, device_warnings = resolve_device_for_args(args, resolved_backend)
    chunk_chars = (
        args.chunk_chars
        if args.chunk_chars is not None
        else default_chunk_chars_for_backend(resolved_backend)
    )
    pipeline_mode, pipeline_warnings = resolve_pipeline_mode_for_args(args, use_checkpoint)
    warnings = [*device_warnings, *pipeline_warnings]

    if is_low_memory_apple_host() and args.backend == "auto" and args.device == "auto":
        warnings.append(
            "Low-memory Apple profile detected: auto mode will use PyTorch on CPU "
            f"with {chunk_chars}-character chunks for stability."
        )
    if is_low_memory_apple_host() and resolved_backend == "mlx":
        warnings.append(
            "MLX can be unstable on 8 GB Apple Silicon when processing multiple books."
        )

    parsed_epub = parse_epub(args.input)
    chapters = parsed_epub.chapters
    chunks, _chapter_start_indices = split_text_to_chunks(chapters, chunk_chars)
    total_chars = sum(len(chunk.text) for chunk in chunks)

    if not chunks:
        raise ValueError("No text chunks produced from EPUB.")

    metadata = apply_metadata_overrides(parsed_epub.metadata, args)
    checkpoint_status = inspect_checkpoint(
        checkpoint_dir,
        args.input,
        build_checkpoint_config(args, resolved_backend, chunk_chars, resolved_device),
        expected_total_chunks=len(chunks),
    )

    if checkpoint_status.missing_audio_chunks:
        warnings.append(
            f"Checkpoint is missing {len(checkpoint_status.missing_audio_chunks)} saved chunk audio file(s); "
            "those chunks will be regenerated."
        )

    return JobInspectionResult(
        input_path=args.input,
        output_path=args.output,
        resolved_backend=resolved_backend,
        resolved_device=resolved_device,
        resolved_chunk_chars=chunk_chars,
        resolved_pipeline_mode=pipeline_mode,
        output_format=args.format,
        total_chars=total_chars,
        total_chunks=len(chunks),
        chapter_count=len(chapters),
        epub_metadata={
            "title": metadata.title,
            "author": metadata.author,
            "has_cover": metadata.cover_image is not None,
        },
        checkpoint={
            "exists": checkpoint_status.exists,
            "resume_compatible": checkpoint_status.resume_compatible,
            "total_chunks": checkpoint_status.total_chunks,
            "completed_chunks": checkpoint_status.completed_chunks,
            "reason": checkpoint_status.reason,
            "missing_audio_chunks": checkpoint_status.missing_audio_chunks or [],
        },
        warnings=warnings,
        errors=[],
    )


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

    timebase = f"1/{sample_rate}"

    # Chapter markers
    for chapter in chapters:
        lines.append("")
        lines.append("[CHAPTER]")
        lines.append(f"TIMEBASE={timebase}")
        lines.append(f"START={chapter.start_sample}")
        lines.append(f"END={chapter.end_sample}")
        lines.append(f"title={_escape_ffmetadata(chapter.title)}")

    return "\n".join(lines)


def _infer_cover_mime_type_from_path(cover_path: str) -> str:
    ext = os.path.splitext(cover_path)[1].lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
    }.get(ext, "image/jpeg")


def _cover_tempfile_suffix(metadata: BookMetadata) -> str:
    if metadata.cover_mime_type:
        if "png" in metadata.cover_mime_type:
            return ".png"
        if "gif" in metadata.cover_mime_type:
            return ".gif"
    return ".jpg"


def _write_ffmetadata_tempfile(
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int,
) -> str:
    metadata_content = generate_ffmetadata(metadata, chapters, sample_rate)
    metadata_file = tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".txt",
        delete=False,
    )
    metadata_file.write(metadata_content)
    metadata_file.close()
    return metadata_file.name


def _write_cover_tempfile(metadata: BookMetadata) -> Optional[str]:
    if metadata.cover_image is None:
        return None

    cover_file = tempfile.NamedTemporaryFile(
        suffix=_cover_tempfile_suffix(metadata),
        delete=False,
    )
    cover_file.write(metadata.cover_image)
    cover_file.close()
    return cover_file.name


def _build_m4b_ffmpeg_command(
    ffmpeg_path: str,
    audio_input_args: List[str],
    metadata_file: str,
    cover_file: Optional[str],
    bitrate: str,
    normalize: bool,
    output_path: str,
) -> List[str]:
    cmd = [
        ffmpeg_path,
        *audio_input_args,
        "-i", metadata_file,
    ]

    if cover_file:
        cmd.extend(["-i", cover_file])

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
    return cmd


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
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if pcm_data.dtype != np.int16:
        pcm_data = audio_to_int16(pcm_data)

    temp_files = []
    try:
        metadata_file = _write_ffmetadata_tempfile(metadata, chapters, sample_rate)
        temp_files.append(metadata_file)
        cover_file = _write_cover_tempfile(metadata)
        if cover_file:
            temp_files.append(cover_file)

        if pcm_data.size == 0:
            audio_input_args = [
                "-f", "lavfi",
                "-t", "0.1",
                "-i", f"anullsrc=r={sample_rate}:cl=mono",
            ]
        else:
            audio_input_args = [
                "-f", "s16le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", "pipe:0",
            ]

        cmd = _build_m4b_ffmpeg_command(
            ffmpeg_path,
            audio_input_args,
            metadata_file,
            cover_file,
            bitrate,
            normalize,
            output_path,
        )

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


def open_mp3_export_stream(
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> subprocess.Popen:
    """Open ffmpeg process that accepts PCM s16le data via stdin and emits MP3."""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    cmd = [
        ffmpeg_path,
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", "pipe:0",
    ]

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def close_mp3_export_stream(proc: subprocess.Popen) -> None:
    """Finalize ffmpeg MP3 stream and raise on failures."""
    if proc.stdin is not None:
        proc.stdin.close()
    stderr = b""
    if proc.stderr is not None:
        stderr = proc.stderr.read()
    return_code = proc.wait()
    if return_code != 0:
        err = stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg failed: {err}")


def _cleanup_backend(backend: Optional[TTSBackend]) -> Optional[BaseException]:
    """Best-effort backend finalizer that never prevents later cleanup."""
    if backend is None:
        return None

    try:
        backend.cleanup()
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc
    return None


def _cleanup_ffmpeg_process(
    proc: Optional[subprocess.Popen],
) -> Optional[BaseException]:
    """Best-effort ffmpeg process cleanup for success and failure paths."""
    if proc is None:
        return None

    try:
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (OSError, ValueError):
            pass

        if proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        return None
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc


def _cleanup_spool_path(spool_path: Optional[str]) -> Optional[BaseException]:
    """Best-effort spool file cleanup."""
    if not spool_path:
        return None

    try:
        if os.path.exists(spool_path):
            os.remove(spool_path)
    except FileNotFoundError:
        return None
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc
    return None


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
        metadata_file = _write_ffmetadata_tempfile(metadata, chapters, sample_rate)
        temp_files.append(metadata_file)

        has_audio = os.path.exists(pcm_path) and os.path.getsize(pcm_path) > 0
        if has_audio:
            audio_input_args = [
                "-f", "s16le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", pcm_path,
            ]
        else:
            audio_input_args = [
                "-f", "lavfi",
                "-t", "0.1",
                "-i", f"anullsrc=r={sample_rate}:cl=mono",
            ]

        cover_file = _write_cover_tempfile(metadata)
        if cover_file:
            temp_files.append(cover_file)

        cmd = _build_m4b_ffmpeg_command(
            ffmpeg_path,
            audio_input_args,
            metadata_file,
            cover_file,
            bitrate,
            normalize,
            output_path,
        )

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
        help="Reserved compatibility flag. Current pipeline is sequential (default: 2).",
    )
    parser.add_argument(
        "--pipeline_mode",
        choices=["sequential", "overlap3"],
        default=None,
        help="Pipeline execution mode. Defaults to sequential for stability.",
    )
    parser.add_argument(
        "--prefetch_chunks",
        type=int,
        default=2,
        help="Number of chunks to prefetch for overlap3 mode (default: 2).",
    )
    parser.add_argument(
        "--pcm_queue_size",
        type=int,
        default=4,
        help="PCM queue depth for overlap3 mode (default: 4).",
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
        "--device",
        choices=["auto", "cpu", "mps"],
        default="auto",
        help="Execution device for the PyTorch backend (default: auto)",
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
        "--inspect_job",
        action="store_true",
        help="Inspect job metadata, chunking, and checkpoint compatibility, then exit",
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
    parser.add_argument(
        "--event_format",
        choices=["text", "json"],
        default="text",
        help="IPC event output format (default: text)",
    )
    parser.add_argument(
        "--log_file",
        help="Optional path to append backend logs",
    )
    return parser.parse_args()


def main() -> None:
    if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
        raise RuntimeError(
            "Kokoro requires Python 3.10–3.12. Please use a compatible Python version."
        )

    args = parse_args()
    events = EventEmitter(
        event_format=args.event_format,
        job_id=os.path.basename(args.output) or "job",
        log_file=args.log_file,
    )

    try:
        if not os.path.exists(args.input):
            raise FileNotFoundError(f"Input EPUB not found: {args.input}")

        if args.no_checkpoint:
            events.warn(
                "--no_checkpoint is deprecated and has no effect "
                "(checkpointing is opt-in via --checkpoint)."
            )

        if args.prefetch_chunks < 1:
            raise ValueError("--prefetch_chunks must be >= 1")
        if args.pcm_queue_size < 1:
            raise ValueError("--pcm_queue_size must be >= 1")

        if args.workers != 1:
            events.warn(
                f"--workers={args.workers} is currently a compatibility setting. "
                "Inference remains sequential."
            )

        # Handle --extract_metadata mode: print metadata and exit
        if args.extract_metadata:
            metadata = extract_epub_metadata(args.input)
            events.emit("metadata", key="title", value=metadata.title)
            events.emit("metadata", key="author", value=metadata.author)
            events.emit(
                "metadata",
                key="has_cover",
                value=str(metadata.cover_image is not None).lower(),
            )
            return

        if args.inspect_job:
            inspection = inspect_job(args)
            events.emit("inspection", result=inspection.to_dict())
            return

        # Checkpoint directory for this output file
        checkpoint_dir = get_checkpoint_dir(args.output)
        use_checkpoint = args.checkpoint or args.resume

        # Handle --check_checkpoint mode: report checkpoint status and exit
        if args.check_checkpoint:
            state = load_checkpoint(checkpoint_dir)
            if state is None:
                events.emit("checkpoint", code="NONE")
            else:
                # Verify the checkpoint matches current input
                current_hash = compute_epub_hash(args.input)
                if state.epub_hash != current_hash:
                    events.emit("checkpoint", code="INVALID", detail="hash_mismatch")
                else:
                    completed = len(state.completed_chunks)
                    events.emit(
                        "checkpoint",
                        code="FOUND",
                        detail=f"{state.total_chunks}:{completed}",
                    )
            return

        resolved_backend = resolve_backend(args.backend)
        events.emit("metadata", key="backend_resolved", value=resolved_backend)
        resolved_device, device_warnings = resolve_device_for_args(args, resolved_backend)
        events.emit("metadata", key="device_resolved", value=resolved_device)

        pipeline_mode, pipeline_warnings = resolve_pipeline_mode_for_args(
            args, use_checkpoint
        )
        for warning in [*device_warnings, *pipeline_warnings]:
            events.warn(warning)
        events.emit("metadata", key="pipeline_mode", value=pipeline_mode)

        # Determine chunk size: use user-provided value or backend-optimal default
        chunk_chars = (
            args.chunk_chars
            if args.chunk_chars is not None
            else default_chunk_chars_for_backend(resolved_backend)
        )

        if is_low_memory_apple_host() and args.backend == "auto" and args.device == "auto":
            events.warn(
                "Low-memory Apple profile detected: auto mode will use PyTorch on CPU "
                f"with {chunk_chars}-character chunks for stability."
            )
        if is_low_memory_apple_host() and resolved_backend == "mlx":
            events.warn(
                "MLX can be unstable on 8 GB Apple Silicon when processing multiple books."
            )

        # Phase: Parsing
        events.emit("phase", phase="PARSING")
        parse_heartbeat_stop, parse_heartbeat_thread = start_heartbeat_emitter(
            events,
            thread_name="parse-heartbeat",
        )
        try:
            parsed_epub = parse_epub(
                args.input,
                progress_callback=lambda current_item, total_items, chapter_count: (
                    events.emit(
                        "parse_progress",
                        current_item=current_item,
                        total_items=total_items,
                        current_chapter_count=chapter_count,
                    )
                ),
            )
        finally:
            parse_heartbeat_stop.set()
            parse_heartbeat_thread.join(timeout=1)

        chapters = parsed_epub.chapters
        chunks, chapter_start_indices = split_text_to_chunks(chapters, chunk_chars)

        # Extract book metadata for M4B format
        book_metadata = None
        if args.format == "m4b":
            book_metadata = apply_metadata_overrides(parsed_epub.metadata, args)

        # Emit metadata about extracted text
        total_chars = sum(len(chunk.text) for chunk in chunks)
        events.emit("metadata", key="total_chars", value=total_chars)
        events.emit("metadata", key="chapter_count", value=len(chapter_start_indices))

        if not chunks:
            raise ValueError("No text chunks produced from EPUB.")

        total_chunks = len(chunks)

        # Checkpoint/resume handling
        completed_chunks: set[int] = set()
        checkpoint_state = None

        if use_checkpoint and args.resume:
            # Verify settings that change either generated waveform or exported output.
            config_for_verify = build_checkpoint_config(
                args,
                resolved_backend,
                chunk_chars,
                resolved_device,
            )
            if verify_checkpoint(checkpoint_dir, args.input, config_for_verify):
                state = load_checkpoint(checkpoint_dir)
                if state and state.total_chunks == total_chunks:
                    completed_chunks = set(state.completed_chunks)
                    checkpoint_state = state
                    events.emit("checkpoint", code="RESUMING", detail=len(completed_chunks))
                else:
                    events.emit("checkpoint", code="INVALID", detail="chunk_mismatch")
            else:
                events.emit("checkpoint", code="INVALID", detail="config_mismatch")

        backend: Optional[TTSBackend] = None
        spool_path: Optional[str] = None
        mp3_export_proc: Optional[subprocess.Popen] = None
        should_cleanup_checkpoint = False
        sample_rate = DEFAULT_SAMPLE_RATE
        main_error: Optional[BaseException] = None

        try:
            # Initialize the TTS backend
            try:
                backend = create_backend(resolved_backend)
                backend.initialize(lang_code=args.lang_code, device=resolved_device)
                sample_rate = backend.sample_rate
            except ImportError as exc:
                raise RuntimeError(
                    f"Failed to initialize '{resolved_backend}' backend: {exc}"
                ) from exc

            output_dir = os.path.dirname(os.path.abspath(args.output))
            if output_dir and not os.path.exists(output_dir):
                os.makedirs(output_dir, exist_ok=True)

            # MP3 mode streams directly to ffmpeg to avoid a second disk read pass.
            # Keep checkpoint-enabled runs on spool mode so a failed export can still resume.
            use_mp3_stream = args.format == "mp3" and not use_checkpoint
            if use_mp3_stream:
                mp3_export_proc = open_mp3_export_stream(
                    args.output,
                    sample_rate=sample_rate,
                    bitrate=args.bitrate,
                    normalize=args.normalize,
                )
            else:
                spool_file = tempfile.NamedTemporaryFile(suffix=".pcm", delete=False)
                spool_path = spool_file.name
                spool_file.close()

            chunk_sample_offsets: List[int] = [0] * total_chunks
            cumulative_samples = 0

            # Create initial checkpoint state if checkpointing is enabled
            if use_checkpoint:
                if checkpoint_state is None:
                    epub_hash = compute_epub_hash(args.input)
                    checkpoint_config = build_checkpoint_config(
                        args,
                        resolved_backend,
                        chunk_chars,
                        resolved_device,
                    )
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
                task_id = progress.add_task("tts", total=total_chunks, completed=0)

            times: List[float] = []
            last_heartbeat = time.time()

            mode_description = "streaming MP3 export" if use_mp3_stream else "disk spooling"
            events.info(
                f"Processing {total_chunks} chunks with {backend.name} backend "
                f"({pipeline_mode} pipeline + {mode_description})"
            )

            # Phase: Inference
            events.emit("phase", phase="INFERENCE")

            def emit_heartbeat_if_needed() -> None:
                nonlocal last_heartbeat
                now = time.time()
                if now - last_heartbeat >= 5:
                    heartbeat_ts = int(now * 1000)
                    events.emit("heartbeat", heartbeat_ts=heartbeat_ts)
                    last_heartbeat = now

            def run_inference_sequential() -> None:
                nonlocal last_heartbeat, cumulative_samples, checkpoint_state
                processed_count = 0

                spool_context = (
                    open(spool_path, "wb")
                    if spool_path is not None
                    else nullcontext(None)
                )
                with spool_context as spool:
                    for idx, chunk in enumerate(chunks):
                        chunk_sample_offsets[idx] = cumulative_samples
                        reused_checkpoint_audio = False

                        if use_checkpoint and args.resume and idx in completed_chunks:
                            chunk_audio = load_chunk_audio(checkpoint_dir, idx)
                            if chunk_audio is not None:
                                if chunk_audio.dtype != np.int16:
                                    chunk_audio = audio_to_int16(chunk_audio)

                                if use_mp3_stream:
                                    if mp3_export_proc is None or mp3_export_proc.stdin is None:
                                        raise RuntimeError("MP3 export process is not writable.")
                                    mp3_export_proc.stdin.write(chunk_audio.tobytes())
                                else:
                                    if spool is None:
                                        raise RuntimeError("Spool writer is not available.")
                                    spool.write(chunk_audio.tobytes())

                                cumulative_samples += len(chunk_audio)
                                reused_checkpoint_audio = True
                                events.emit(
                                    "worker",
                                    id=0,
                                    status="ENCODE",
                                    details=f"Reused checkpoint chunk {idx+1}/{total_chunks}",
                                )
                                events.emit(
                                    "checkpoint",
                                    code="REUSED",
                                    detail=idx,
                                )
                            else:
                                completed_chunks.discard(idx)
                                if checkpoint_state is not None:
                                    checkpoint_state.completed_chunks = sorted(completed_chunks)
                                    save_checkpoint(checkpoint_dir, checkpoint_state)
                                events.emit(
                                    "checkpoint",
                                    code="MISSING_AUDIO",
                                    detail=idx,
                                )

                        if not reused_checkpoint_audio:
                            start = time.perf_counter()
                            events.emit(
                                "worker",
                                id=0,
                                status="INFER",
                                details=f"Chunk {idx+1}/{total_chunks}",
                            )

                            checkpoint_parts: Optional[List[np.ndarray]] = (
                                [] if use_checkpoint else None
                            )
                            for audio in backend.generate(
                                text=chunk.text,
                                voice=args.voice,
                                speed=args.speed,
                                split_pattern=args.split_pattern,
                            ):
                                int16_audio = audio_to_int16(audio)
                                if use_mp3_stream:
                                    if mp3_export_proc is None or mp3_export_proc.stdin is None:
                                        raise RuntimeError("MP3 export process is not writable.")
                                    mp3_export_proc.stdin.write(int16_audio.tobytes())
                                else:
                                    if spool is None:
                                        raise RuntimeError("Spool writer is not available.")
                                    spool.write(int16_audio.tobytes())
                                cumulative_samples += len(int16_audio)

                                if checkpoint_parts is not None:
                                    checkpoint_parts.append(int16_audio)

                            elapsed = time.perf_counter() - start
                            times.append(elapsed)

                            if checkpoint_parts is not None:
                                if checkpoint_parts:
                                    chunk_audio = np.concatenate(checkpoint_parts)
                                else:
                                    chunk_audio = np.array([], dtype=np.int16)
                                save_chunk_audio(checkpoint_dir, idx, chunk_audio)
                                completed_chunks.add(idx)
                                if checkpoint_state is not None:
                                    checkpoint_state.completed_chunks = sorted(completed_chunks)
                                    save_checkpoint(checkpoint_dir, checkpoint_state)
                                events.emit("checkpoint", code="SAVED", detail=idx)

                            events.emit(
                                "timing",
                                chunk_idx=idx,
                                chunk_timing_ms=int(elapsed * 1000),
                                stage="infer",
                            )

                        processed_count += 1

                        emit_heartbeat_if_needed()

                        if progress and task_id is not None:
                            progress.update(task_id, advance=1)
                        events.emit(
                            "progress",
                            current_chunk=processed_count,
                            total_chunks=total_chunks,
                        )

            def run_inference_overlap3() -> None:
                nonlocal cumulative_samples
                if mp3_export_proc is None or mp3_export_proc.stdin is None:
                    raise RuntimeError("MP3 export process is not writable.")

                inference_queue_max = max(2, args.prefetch_chunks * 2)
                pcm_queue_max = max(2, args.pcm_queue_size)

                inference_queue: queue.Queue = queue.Queue(maxsize=inference_queue_max)
                pcm_queue: queue.Queue = queue.Queue(maxsize=pcm_queue_max)
                worker_errors: queue.Queue = queue.Queue()

                def inference_worker() -> None:
                    try:
                        for idx, chunk in enumerate(chunks):
                            inference_queue.put(("start", idx, None))
                            start = time.perf_counter()
                            for audio in backend.generate(
                                text=chunk.text,
                                voice=args.voice,
                                speed=args.speed,
                                split_pattern=args.split_pattern,
                            ):
                                inference_queue.put(("audio", idx, audio))
                            infer_ms = int((time.perf_counter() - start) * 1000)
                            inference_queue.put(("done", idx, infer_ms))
                    except Exception as exc:  # pragma: no cover - exercised via integration path
                        worker_errors.put(exc)
                    finally:
                        inference_queue.put(("end", -1, None))

                def convert_worker() -> None:
                    try:
                        while True:
                            kind, idx, payload = inference_queue.get()
                            if kind == "end":
                                break
                            if kind == "audio":
                                payload = audio_to_int16(payload)
                            pcm_queue.put((kind, idx, payload))
                    except Exception as exc:  # pragma: no cover - exercised via integration path
                        worker_errors.put(exc)
                    finally:
                        pcm_queue.put(("end", -1, None))

                infer_thread = threading.Thread(
                    target=inference_worker, name="tts-infer", daemon=True
                )
                convert_thread = threading.Thread(
                    target=convert_worker, name="tts-convert", daemon=True
                )
                infer_thread.start()
                convert_thread.start()

                chunk_started = [False] * total_chunks
                processed_count = 0
                try:
                    while True:
                        if not worker_errors.empty():
                            raise worker_errors.get()

                        try:
                            kind, idx, payload = pcm_queue.get(timeout=0.25)
                        except queue.Empty:
                            emit_heartbeat_if_needed()
                            continue

                        if kind == "end":
                            break

                        if idx < 0 or idx >= total_chunks:
                            raise RuntimeError(f"Invalid chunk index from overlap3 pipeline: {idx}")

                        if kind == "start":
                            chunk_sample_offsets[idx] = cumulative_samples
                            chunk_started[idx] = True
                            events.emit(
                                "worker",
                                id=0,
                                status="INFER",
                                details=f"Chunk {idx+1}/{total_chunks}",
                            )
                            continue

                        if kind == "audio":
                            if not chunk_started[idx]:
                                chunk_sample_offsets[idx] = cumulative_samples
                                chunk_started[idx] = True
                            int16_audio = payload
                            mp3_export_proc.stdin.write(int16_audio.tobytes())
                            cumulative_samples += len(int16_audio)
                            continue

                        if kind == "done":
                            infer_ms = int(payload)
                            times.append(infer_ms / 1000.0)
                            events.emit(
                                "worker",
                                id=0,
                                status="ENCODE",
                                details=f"Chunk {idx+1}/{total_chunks}",
                            )
                            events.emit(
                                "timing",
                                chunk_idx=idx,
                                chunk_timing_ms=infer_ms,
                                stage="infer",
                            )

                            processed_count += 1
                            if progress and task_id is not None:
                                progress.update(task_id, advance=1)
                            events.emit(
                                "progress",
                                current_chunk=processed_count,
                                total_chunks=total_chunks,
                            )
                            emit_heartbeat_if_needed()
                            continue

                        raise RuntimeError(f"Unknown overlap3 pipeline message type: {kind}")

                    if not worker_errors.empty():
                        raise worker_errors.get()
                finally:
                    infer_thread.join(timeout=2)
                    convert_thread.join(timeout=2)

            if progress:
                with progress:
                    if pipeline_mode == "overlap3":
                        run_inference_overlap3()
                    else:
                        run_inference_sequential()
            else:
                if pipeline_mode == "overlap3":
                    run_inference_overlap3()
                else:
                    run_inference_sequential()

            # Phase: Concatenating (kept for CLI protocol compatibility)
            events.emit("phase", phase="CONCATENATING")
            events.info("Concatenating audio segments...")

            total_samples = cumulative_samples

            # Build chapter info for M4B
            chapter_infos: List[ChapterInfo] = []
            if args.format == "m4b" and chapter_start_indices:
                for i, (chunk_idx, title) in enumerate(chapter_start_indices):
                    start_sample = (
                        chunk_sample_offsets[chunk_idx]
                        if chunk_idx < len(chunk_sample_offsets)
                        else 0
                    )

                    if i + 1 < len(chapter_start_indices):
                        next_chunk_idx = chapter_start_indices[i + 1][0]
                        end_sample = (
                            chunk_sample_offsets[next_chunk_idx]
                            if next_chunk_idx < len(chunk_sample_offsets)
                            else total_samples
                        )
                    else:
                        end_sample = total_samples

                    chapter_title = title if title else f"Chapter {i + 1}"
                    chapter_infos.append(
                        ChapterInfo(
                            title=chapter_title,
                            start_sample=start_sample,
                            end_sample=end_sample,
                        )
                    )

            # Phase: Exporting
            events.emit("phase", phase="EXPORTING")
            if args.format == "m4b":
                if spool_path is None:
                    raise RuntimeError("M4B export requires a spool path.")
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
                if use_mp3_stream:
                    if mp3_export_proc is None:
                        raise RuntimeError("MP3 export process was not initialized.")
                    close_mp3_export_stream(mp3_export_proc)
                    mp3_export_proc = None
                else:
                    if spool_path is None:
                        raise RuntimeError("MP3 export requires a spool path.")
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
                events.emit("checkpoint", code="CLEANED")

            events.emit("done", output=args.output, chunks=total_chunks)
            events.info("Done.")
            events.info(f"Output: {args.output}")
            events.info(f"Chunks: {total_chunks}")
            events.info(f"Average chunk time: {avg_time:.2f}s")
        except BaseException as exc:
            main_error = exc
            raise
        finally:
            cleanup_error: Optional[BaseException] = None

            backend_cleanup_error = _cleanup_backend(backend)
            if cleanup_error is None and backend_cleanup_error is not None:
                cleanup_error = backend_cleanup_error

            ffmpeg_cleanup_error = _cleanup_ffmpeg_process(mp3_export_proc)
            if cleanup_error is None and ffmpeg_cleanup_error is not None:
                cleanup_error = ffmpeg_cleanup_error

            spool_cleanup_error = _cleanup_spool_path(spool_path)
            if cleanup_error is None and spool_cleanup_error is not None:
                cleanup_error = spool_cleanup_error

            if main_error is None and cleanup_error is not None:
                raise cleanup_error
    except BaseException as exc:
        if isinstance(exc, Exception):
            events.error(str(exc))
        raise
    finally:
        try:
            gc.collect()
        finally:
            events.close()


if __name__ == "__main__":
    main()
