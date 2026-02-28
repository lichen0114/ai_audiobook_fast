import json
import os
import sys
import threading
import time
from typing import Any, Dict, Optional, TextIO, Tuple


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

