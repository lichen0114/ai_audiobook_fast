import queue
import threading
import time
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Callable, Optional

import numpy as np

from checkpoint import CheckpointState, load_chunk_audio, save_checkpoint, save_chunk_audio

from .events import EventEmitter
from .export import audio_to_int16


@dataclass
class PipelineRunResult:
    chunk_sample_offsets: list[int]
    total_samples: int
    times: list[float]
    completed_chunks: list[int]


def run_sequential_pipeline(
    *,
    chunks: list[Any],
    backend: Any,
    voice: str,
    speed: float,
    split_pattern: str,
    events: EventEmitter,
    progress: Optional[Any],
    task_id: Optional[Any],
    use_mp3_stream: bool,
    mp3_export_proc: Optional[Any],
    spool_path: Optional[str],
    use_checkpoint: bool,
    resume: bool,
    checkpoint_dir: str,
    completed_chunks: set[int],
    checkpoint_state: Optional[CheckpointState],
    load_chunk_audio_fn: Callable[..., Optional[np.ndarray]] = load_chunk_audio,
    save_chunk_audio_fn: Callable[..., None] = save_chunk_audio,
    save_checkpoint_fn: Callable[..., None] = save_checkpoint,
    audio_to_int16_fn: Callable[[Any], np.ndarray] = audio_to_int16,
) -> PipelineRunResult:
    total_chunks = len(chunks)
    chunk_sample_offsets: list[int] = [0] * total_chunks
    cumulative_samples = 0
    times: list[float] = []
    last_heartbeat = time.time()
    processed_count = 0

    def emit_heartbeat_if_needed() -> None:
        nonlocal last_heartbeat
        now = time.time()
        if now - last_heartbeat >= 5:
            events.emit("heartbeat", heartbeat_ts=int(now * 1000))
            last_heartbeat = now

    spool_context = (
        open(spool_path, "wb")
        if spool_path is not None
        else nullcontext(None)
    )
    with spool_context as spool:
        for idx, chunk in enumerate(chunks):
            chunk_sample_offsets[idx] = cumulative_samples
            reused_checkpoint_audio = False

            if use_checkpoint and resume and idx in completed_chunks:
                chunk_audio = load_chunk_audio_fn(checkpoint_dir, idx)
                if chunk_audio is not None:
                    if chunk_audio.dtype != np.int16:
                        chunk_audio = audio_to_int16_fn(chunk_audio)

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
                    events.emit("checkpoint", code="REUSED", detail=idx)
                else:
                    completed_chunks.discard(idx)
                    if checkpoint_state is not None:
                        checkpoint_state.completed_chunks = sorted(completed_chunks)
                        save_checkpoint_fn(checkpoint_dir, checkpoint_state)
                    events.emit("checkpoint", code="MISSING_AUDIO", detail=idx)

            if not reused_checkpoint_audio:
                start = time.perf_counter()
                events.emit(
                    "worker",
                    id=0,
                    status="INFER",
                    details=f"Chunk {idx+1}/{total_chunks}",
                )

                checkpoint_parts: Optional[list[np.ndarray]] = [] if use_checkpoint else None
                for audio in backend.generate(
                    text=chunk.text,
                    voice=voice,
                    speed=speed,
                    split_pattern=split_pattern,
                ):
                    int16_audio = audio_to_int16_fn(audio)
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
                    save_chunk_audio_fn(checkpoint_dir, idx, chunk_audio)
                    completed_chunks.add(idx)
                    if checkpoint_state is not None:
                        checkpoint_state.completed_chunks = sorted(completed_chunks)
                        save_checkpoint_fn(checkpoint_dir, checkpoint_state)
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

    return PipelineRunResult(
        chunk_sample_offsets=chunk_sample_offsets,
        total_samples=cumulative_samples,
        times=times,
        completed_chunks=sorted(completed_chunks),
    )


def run_overlap3_pipeline(
    *,
    chunks: list[Any],
    backend: Any,
    voice: str,
    speed: float,
    split_pattern: str,
    prefetch_chunks: int,
    pcm_queue_size: int,
    events: EventEmitter,
    progress: Optional[Any],
    task_id: Optional[Any],
    mp3_export_proc: Any,
    audio_to_int16_fn: Callable[[Any], np.ndarray] = audio_to_int16,
) -> PipelineRunResult:
    total_chunks = len(chunks)
    chunk_sample_offsets: list[int] = [0] * total_chunks
    cumulative_samples = 0
    times: list[float] = []
    last_heartbeat = time.time()

    if mp3_export_proc is None or mp3_export_proc.stdin is None:
        raise RuntimeError("MP3 export process is not writable.")

    inference_queue_max = max(2, prefetch_chunks * 2)
    pcm_queue_max = max(2, pcm_queue_size)

    inference_queue: queue.Queue = queue.Queue(maxsize=inference_queue_max)
    pcm_queue: queue.Queue = queue.Queue(maxsize=pcm_queue_max)
    worker_errors: queue.Queue = queue.Queue()

    def emit_heartbeat_if_needed() -> None:
        nonlocal last_heartbeat
        now = time.time()
        if now - last_heartbeat >= 5:
            events.emit("heartbeat", heartbeat_ts=int(now * 1000))
            last_heartbeat = now

    def inference_worker() -> None:
        try:
            for idx, chunk in enumerate(chunks):
                inference_queue.put(("start", idx, None))
                start = time.perf_counter()
                for audio in backend.generate(
                    text=chunk.text,
                    voice=voice,
                    speed=speed,
                    split_pattern=split_pattern,
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
                    payload = audio_to_int16_fn(payload)
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

    return PipelineRunResult(
        chunk_sample_offsets=chunk_sample_offsets,
        total_samples=cumulative_samples,
        times=times,
        completed_chunks=[],
    )

