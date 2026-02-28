import gc
import importlib
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Optional

from backends import TTSBackend, create_backend, get_available_backends
from checkpoint import (
    CheckpointInspection,
    CheckpointState,
    cleanup_checkpoint,
    compute_epub_hash,
    get_checkpoint_dir,
    inspect_checkpoint,
    load_checkpoint,
    load_chunk_audio,
    save_checkpoint,
    save_chunk_audio,
    verify_checkpoint,
)

from audiobook_backend import cli as _cli
from audiobook_backend import epub_parser as _epub_parser
from audiobook_backend import job as _job
from audiobook_backend import pipeline as _pipeline
from audiobook_backend.chunking import _clean_text, _clean_text_with_paragraphs, split_text_to_chunks
from audiobook_backend.cleanup import (
    cleanup_backend as _cleanup_backend,
    cleanup_ffmpeg_process as _cleanup_ffmpeg_process,
    cleanup_spool_path as _cleanup_spool_path,
)
from audiobook_backend.cli import MainDeps, parse_args
from audiobook_backend.events import EventEmitter, start_heartbeat_emitter
from audiobook_backend.export import (
    DEFAULT_SAMPLE_RATE,
    _escape_ffmetadata,
    audio_to_int16,
    audio_to_segment,
    close_mp3_export_stream,
    export_pcm_file_to_m4b,
    export_pcm_file_to_mp3,
    export_pcm_to_m4b,
    export_pcm_to_mp3,
    generate_ffmetadata,
    open_mp3_export_stream,
)
from audiobook_backend.job import JobPreparationDeps, build_checkpoint_config
from audiobook_backend.metadata import apply_metadata_overrides
from audiobook_backend.models import (
    BookMetadata,
    ChapterInfo,
    JobInspectionResult,
    ParsedEpub,
    ParsedSection,
    TextChunk,
)
from audiobook_backend.runtime import (
    DEFAULT_CHUNK_CHARS,
    LOW_MEMORY_APPLE_MEMORY_THRESHOLD_BYTES,
    LOW_MEMORY_APPLE_PYTORCH_CHUNK_CHARS,
    _parse_env_bool,
    _get_macos_total_memory_bytes,
    default_pipeline_mode,
    resolve_pipeline_mode_for_args,
)


ebooklib = _epub_parser.ebooklib
epub = _epub_parser.epub
_AUTO_BACKEND_CACHE = None


def is_apple_silicon_host() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


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


def resolve_backend(backend: str) -> str:
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


def resolve_device_for_args(args, resolved_backend: str):
    warnings = []
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


def _sync_epub_module() -> None:
    _epub_parser.ebooklib = ebooklib
    _epub_parser.epub = epub


def parse_loaded_epub(book, progress_callback=None) -> ParsedEpub:
    _sync_epub_module()
    return _epub_parser.parse_loaded_epub(book, progress_callback=progress_callback)


def parse_epub(epub_path: str, progress_callback=None) -> ParsedEpub:
    _sync_epub_module()
    return _epub_parser.parse_epub(epub_path, progress_callback=progress_callback)


def extract_epub_metadata(epub_path: str) -> BookMetadata:
    _sync_epub_module()
    return _epub_parser.extract_epub_metadata(epub_path)


def extract_epub_text(epub_path: str):
    _sync_epub_module()
    return _epub_parser.extract_epub_text(epub_path)


def _build_preparation_deps() -> JobPreparationDeps:
    return JobPreparationDeps(
        resolve_backend=resolve_backend,
        resolve_device_for_args=resolve_device_for_args,
        default_chunk_chars_for_backend=default_chunk_chars_for_backend,
        resolve_pipeline_mode_for_args=resolve_pipeline_mode_for_args,
        is_low_memory_apple_host=is_low_memory_apple_host,
        parse_epub=parse_epub,
        split_text_to_chunks=split_text_to_chunks,
        apply_metadata_overrides=apply_metadata_overrides,
        inspect_checkpoint=inspect_checkpoint,
        get_checkpoint_dir=get_checkpoint_dir,
    )


def _run_sequential_pipeline(**kwargs):
    return _pipeline.run_sequential_pipeline(
        **kwargs,
        load_chunk_audio_fn=load_chunk_audio,
        save_chunk_audio_fn=save_chunk_audio,
        save_checkpoint_fn=save_checkpoint,
        audio_to_int16_fn=audio_to_int16,
    )


def _run_overlap3_pipeline(**kwargs):
    return _pipeline.run_overlap3_pipeline(
        **kwargs,
        audio_to_int16_fn=audio_to_int16,
    )


def inspect_job(args) -> JobInspectionResult:
    return _cli.inspect_job(args, preparation_deps=_build_preparation_deps())


def _build_main_deps() -> MainDeps:
    return MainDeps(
        parse_args=parse_args,
        event_emitter_cls=EventEmitter,
        extract_epub_metadata=extract_epub_metadata,
        inspect_job=lambda args, preparation_deps=None: _cli.inspect_job(
            args,
            preparation_deps=preparation_deps or _build_preparation_deps(),
        ),
        prepare_job=_job.prepare_job,
        preparation_deps=_build_preparation_deps(),
        get_checkpoint_dir=get_checkpoint_dir,
        load_checkpoint=load_checkpoint,
        compute_epub_hash=compute_epub_hash,
        verify_checkpoint=verify_checkpoint,
        save_checkpoint=save_checkpoint,
        cleanup_checkpoint=cleanup_checkpoint,
        create_backend=create_backend,
        open_mp3_export_stream=open_mp3_export_stream,
        close_mp3_export_stream=close_mp3_export_stream,
        export_pcm_file_to_mp3=export_pcm_file_to_mp3,
        export_pcm_file_to_m4b=export_pcm_file_to_m4b,
        run_sequential_pipeline=_run_sequential_pipeline,
        run_overlap3_pipeline=_run_overlap3_pipeline,
        cleanup_backend=_cleanup_backend,
        cleanup_ffmpeg_process=_cleanup_ffmpeg_process,
        cleanup_spool_path=_cleanup_spool_path,
        start_heartbeat_emitter=start_heartbeat_emitter,
        tempfile_module=tempfile,
        gc_collect=gc.collect,
    )


def main() -> None:
    _sync_epub_module()
    _cli.main(deps=_build_main_deps())


if __name__ == "__main__":
    main()
