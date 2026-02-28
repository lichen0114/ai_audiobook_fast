import argparse
import gc
import os
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from rich.progress import (
    BarColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

from backends import TTSBackend, create_backend
from checkpoint import (
    CheckpointState,
    cleanup_checkpoint,
    compute_epub_hash,
    get_checkpoint_dir,
    load_checkpoint,
    save_checkpoint,
    verify_checkpoint,
)

from .cleanup import cleanup_backend, cleanup_ffmpeg_process, cleanup_spool_path
from .events import EventEmitter, start_heartbeat_emitter
from .epub_parser import extract_epub_metadata
from .export import (
    DEFAULT_SAMPLE_RATE,
    close_mp3_export_stream,
    export_pcm_file_to_m4b,
    export_pcm_file_to_mp3,
    open_mp3_export_stream,
)
from .job import (
    DEFAULT_PREPARATION_DEPS,
    JobPreparationDeps,
    PreparedJob,
    build_checkpoint_config,
    prepare_job,
)
from .models import ChapterInfo, JobInspectionResult
from .pipeline import run_overlap3_pipeline, run_sequential_pipeline


@dataclass
class MainDeps:
    parse_args: Callable[[], argparse.Namespace]
    event_emitter_cls: Callable[..., EventEmitter]
    extract_epub_metadata: Callable[[str], Any]
    inspect_job: Callable[..., JobInspectionResult]
    prepare_job: Callable[..., PreparedJob]
    preparation_deps: JobPreparationDeps
    get_checkpoint_dir: Callable[[str], str]
    load_checkpoint: Callable[[str], Optional[CheckpointState]]
    compute_epub_hash: Callable[[str], str]
    verify_checkpoint: Callable[..., bool]
    save_checkpoint: Callable[..., None]
    cleanup_checkpoint: Callable[[str], None]
    create_backend: Callable[[str], TTSBackend]
    open_mp3_export_stream: Callable[..., Any]
    close_mp3_export_stream: Callable[[Any], None]
    export_pcm_file_to_mp3: Callable[..., None]
    export_pcm_file_to_m4b: Callable[..., None]
    run_sequential_pipeline: Callable[..., Any]
    run_overlap3_pipeline: Callable[..., Any]
    cleanup_backend: Callable[[Optional[TTSBackend]], Optional[BaseException]]
    cleanup_ffmpeg_process: Callable[[Optional[Any]], Optional[BaseException]]
    cleanup_spool_path: Callable[[Optional[str]], Optional[BaseException]]
    start_heartbeat_emitter: Callable[..., Any]
    tempfile_module: Any
    gc_collect: Callable[[], Any]


DEFAULT_MAIN_DEPS = MainDeps(
    parse_args=lambda: parse_args(),
    event_emitter_cls=EventEmitter,
    extract_epub_metadata=extract_epub_metadata,
    inspect_job=lambda args, preparation_deps=None: inspect_job(
        args,
        preparation_deps=preparation_deps,
    ),
    prepare_job=prepare_job,
    preparation_deps=DEFAULT_PREPARATION_DEPS,
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
    run_sequential_pipeline=run_sequential_pipeline,
    run_overlap3_pipeline=run_overlap3_pipeline,
    cleanup_backend=cleanup_backend,
    cleanup_ffmpeg_process=cleanup_ffmpeg_process,
    cleanup_spool_path=cleanup_spool_path,
    start_heartbeat_emitter=start_heartbeat_emitter,
    tempfile_module=tempfile,
    gc_collect=gc.collect,
)


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


def inspect_job(
    args: argparse.Namespace,
    preparation_deps: Optional[JobPreparationDeps] = None,
) -> JobInspectionResult:
    prepared = prepare_job(
        args,
        inspect_checkpoint_state=True,
        deps=preparation_deps,
    )
    checkpoint_status = prepared.checkpoint_status
    if checkpoint_status is None:
        raise RuntimeError("Checkpoint inspection is required for inspect_job().")

    metadata = prepared.book_metadata
    return JobInspectionResult(
        input_path=args.input,
        output_path=args.output,
        resolved_backend=prepared.resolved_backend,
        resolved_device=prepared.resolved_device,
        resolved_chunk_chars=prepared.chunk_chars,
        resolved_pipeline_mode=prepared.pipeline_mode,
        output_format=args.format,
        total_chars=prepared.total_chars,
        total_chunks=len(prepared.chunks),
        chapter_count=len(prepared.chapters),
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
        warnings=prepared.warnings,
        errors=[],
    )


def main(deps: Optional[MainDeps] = None) -> None:
    deps = deps or DEFAULT_MAIN_DEPS

    if sys.version_info < (3, 10) or sys.version_info >= (3, 13):
        raise RuntimeError(
            "Kokoro requires Python 3.10-3.12. Please use a compatible Python version."
        )

    args = deps.parse_args()
    events = deps.event_emitter_cls(
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

        if args.extract_metadata:
            metadata = deps.extract_epub_metadata(args.input)
            events.emit("metadata", key="title", value=metadata.title)
            events.emit("metadata", key="author", value=metadata.author)
            events.emit(
                "metadata",
                key="has_cover",
                value=str(metadata.cover_image is not None).lower(),
            )
            return

        if args.inspect_job:
            inspection = deps.inspect_job(args, preparation_deps=deps.preparation_deps)
            events.emit("inspection", result=inspection.to_dict())
            return

        checkpoint_dir = deps.get_checkpoint_dir(args.output)
        use_checkpoint = args.checkpoint or args.resume

        if args.check_checkpoint:
            state = deps.load_checkpoint(checkpoint_dir)
            if state is None:
                events.emit("checkpoint", code="NONE")
            else:
                current_hash = deps.compute_epub_hash(args.input)
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

        events.emit("phase", phase="PARSING")
        parse_heartbeat_stop, parse_heartbeat_thread = deps.start_heartbeat_emitter(
            events,
            thread_name="parse-heartbeat",
        )
        try:
            prepared = deps.prepare_job(
                args,
                inspect_checkpoint_state=True,
                progress_callback=lambda current_item, total_items, chapter_count: (
                    events.emit(
                        "parse_progress",
                        current_item=current_item,
                        total_items=total_items,
                        current_chapter_count=chapter_count,
                    )
                ),
                deps=deps.preparation_deps,
            )
        finally:
            parse_heartbeat_stop.set()
            parse_heartbeat_thread.join(timeout=1)

        events.emit("metadata", key="backend_resolved", value=prepared.resolved_backend)
        events.emit("metadata", key="device_resolved", value=prepared.resolved_device)
        events.emit("metadata", key="pipeline_mode", value=prepared.pipeline_mode)
        for warning in prepared.warnings:
            events.warn(warning)

        events.emit("metadata", key="total_chars", value=prepared.total_chars)
        events.emit(
            "metadata",
            key="chapter_count",
            value=len(prepared.chapter_start_indices),
        )

        total_chunks = len(prepared.chunks)
        completed_chunks: set[int] = set()
        checkpoint_state = None

        if use_checkpoint and args.resume:
            config_for_verify = build_checkpoint_config(
                args,
                prepared.resolved_backend,
                prepared.chunk_chars,
                prepared.resolved_device,
            )
            if deps.verify_checkpoint(checkpoint_dir, args.input, config_for_verify):
                state = deps.load_checkpoint(checkpoint_dir)
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
        mp3_export_proc: Optional[Any] = None
        should_cleanup_checkpoint = False
        sample_rate = DEFAULT_SAMPLE_RATE
        main_error: Optional[BaseException] = None

        try:
            try:
                backend = deps.create_backend(prepared.resolved_backend)
                backend.initialize(
                    lang_code=args.lang_code,
                    device=prepared.resolved_device,
                )
                sample_rate = backend.sample_rate
            except ImportError as exc:
                raise RuntimeError(
                    f"Failed to initialize '{prepared.resolved_backend}' backend: {exc}"
                ) from exc

            output_dir = os.path.dirname(os.path.abspath(args.output))
            if output_dir and not os.path.exists(output_dir):
                os.makedirs(output_dir, exist_ok=True)

            use_mp3_stream = args.format == "mp3" and not use_checkpoint
            if use_mp3_stream:
                mp3_export_proc = deps.open_mp3_export_stream(
                    args.output,
                    sample_rate=sample_rate,
                    bitrate=args.bitrate,
                    normalize=args.normalize,
                )
            else:
                spool_file = deps.tempfile_module.NamedTemporaryFile(
                    suffix=".pcm",
                    delete=False,
                )
                spool_path = spool_file.name
                spool_file.close()

            if use_checkpoint:
                if checkpoint_state is None:
                    epub_hash = deps.compute_epub_hash(args.input)
                    checkpoint_config = build_checkpoint_config(
                        args,
                        prepared.resolved_backend,
                        prepared.chunk_chars,
                        prepared.resolved_device,
                    )
                    checkpoint_state = CheckpointState(
                        epub_hash=epub_hash,
                        config=checkpoint_config,
                        total_chunks=total_chunks,
                        completed_chunks=sorted(completed_chunks),
                        chapter_start_indices=prepared.chapter_start_indices,
                    )
                else:
                    checkpoint_state.completed_chunks = sorted(completed_chunks)
                deps.save_checkpoint(checkpoint_dir, checkpoint_state)

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

            mode_description = (
                "streaming MP3 export" if use_mp3_stream else "disk spooling"
            )
            events.info(
                f"Processing {total_chunks} chunks with {backend.name} backend "
                f"({prepared.pipeline_mode} pipeline + {mode_description})"
            )

            events.emit("phase", phase="INFERENCE")

            if progress:
                with progress:
                    if prepared.pipeline_mode == "overlap3":
                        run_result = deps.run_overlap3_pipeline(
                            chunks=prepared.chunks,
                            backend=backend,
                            voice=args.voice,
                            speed=args.speed,
                            split_pattern=args.split_pattern,
                            prefetch_chunks=args.prefetch_chunks,
                            pcm_queue_size=args.pcm_queue_size,
                            events=events,
                            progress=progress,
                            task_id=task_id,
                            mp3_export_proc=mp3_export_proc,
                        )
                    else:
                        run_result = deps.run_sequential_pipeline(
                            chunks=prepared.chunks,
                            backend=backend,
                            voice=args.voice,
                            speed=args.speed,
                            split_pattern=args.split_pattern,
                            events=events,
                            progress=progress,
                            task_id=task_id,
                            use_mp3_stream=use_mp3_stream,
                            mp3_export_proc=mp3_export_proc,
                            spool_path=spool_path,
                            use_checkpoint=use_checkpoint,
                            resume=args.resume,
                            checkpoint_dir=checkpoint_dir,
                            completed_chunks=completed_chunks,
                            checkpoint_state=checkpoint_state,
                        )
            else:
                if prepared.pipeline_mode == "overlap3":
                    run_result = deps.run_overlap3_pipeline(
                        chunks=prepared.chunks,
                        backend=backend,
                        voice=args.voice,
                        speed=args.speed,
                        split_pattern=args.split_pattern,
                        prefetch_chunks=args.prefetch_chunks,
                        pcm_queue_size=args.pcm_queue_size,
                        events=events,
                        progress=progress,
                        task_id=task_id,
                        mp3_export_proc=mp3_export_proc,
                    )
                else:
                    run_result = deps.run_sequential_pipeline(
                        chunks=prepared.chunks,
                        backend=backend,
                        voice=args.voice,
                        speed=args.speed,
                        split_pattern=args.split_pattern,
                        events=events,
                        progress=progress,
                        task_id=task_id,
                        use_mp3_stream=use_mp3_stream,
                        mp3_export_proc=mp3_export_proc,
                        spool_path=spool_path,
                        use_checkpoint=use_checkpoint,
                        resume=args.resume,
                        checkpoint_dir=checkpoint_dir,
                        completed_chunks=completed_chunks,
                        checkpoint_state=checkpoint_state,
                    )

            events.emit("phase", phase="CONCATENATING")
            events.info("Concatenating audio segments...")

            chapter_infos: list[ChapterInfo] = []
            if args.format == "m4b" and prepared.chapter_start_indices:
                for index, (chunk_idx, title) in enumerate(prepared.chapter_start_indices):
                    start_sample = (
                        run_result.chunk_sample_offsets[chunk_idx]
                        if chunk_idx < len(run_result.chunk_sample_offsets)
                        else 0
                    )

                    if index + 1 < len(prepared.chapter_start_indices):
                        next_chunk_idx = prepared.chapter_start_indices[index + 1][0]
                        end_sample = (
                            run_result.chunk_sample_offsets[next_chunk_idx]
                            if next_chunk_idx < len(run_result.chunk_sample_offsets)
                            else run_result.total_samples
                        )
                    else:
                        end_sample = run_result.total_samples

                    chapter_title = title if title else f"Chapter {index + 1}"
                    chapter_infos.append(
                        ChapterInfo(
                            title=chapter_title,
                            start_sample=start_sample,
                            end_sample=end_sample,
                        )
                    )

            events.emit("phase", phase="EXPORTING")
            if args.format == "m4b":
                if spool_path is None:
                    raise RuntimeError("M4B export requires a spool path.")
                deps.export_pcm_file_to_m4b(
                    spool_path,
                    args.output,
                    metadata=prepared.book_metadata,
                    chapters=chapter_infos,
                    sample_rate=sample_rate,
                    bitrate=args.bitrate,
                    normalize=args.normalize,
                )
            else:
                if use_mp3_stream:
                    if mp3_export_proc is None:
                        raise RuntimeError("MP3 export process was not initialized.")
                    deps.close_mp3_export_stream(mp3_export_proc)
                    mp3_export_proc = None
                else:
                    if spool_path is None:
                        raise RuntimeError("MP3 export requires a spool path.")
                    deps.export_pcm_file_to_mp3(
                        spool_path,
                        args.output,
                        sample_rate=sample_rate,
                        bitrate=args.bitrate,
                        normalize=args.normalize,
                    )

            avg_time = sum(run_result.times) / max(len(run_result.times), 1)
            should_cleanup_checkpoint = use_checkpoint

            if should_cleanup_checkpoint:
                deps.cleanup_checkpoint(checkpoint_dir)
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

            backend_cleanup_error = deps.cleanup_backend(backend)
            if cleanup_error is None and backend_cleanup_error is not None:
                cleanup_error = backend_cleanup_error

            ffmpeg_cleanup_error = deps.cleanup_ffmpeg_process(mp3_export_proc)
            if cleanup_error is None and ffmpeg_cleanup_error is not None:
                cleanup_error = ffmpeg_cleanup_error

            spool_cleanup_error = deps.cleanup_spool_path(spool_path)
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
            deps.gc_collect()
        finally:
            events.close()
