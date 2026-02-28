"""Tests for backend resolution, event emission, and ffmpeg stream helpers."""

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import app
from backends.factory import get_available_backends
from backends.kokoro_mlx import is_mlx_available


def build_main_args(tmp_path: Path, **overrides) -> SimpleNamespace:
    input_path = tmp_path / "input.epub"
    input_path.write_bytes(b"dummy-epub")

    values = {
        "input": str(input_path),
        "output": str(tmp_path / "output.mp3"),
        "backend": "mock",
        "pipeline_mode": None,
        "format": "mp3",
        "chunk_chars": 120,
        "checkpoint": False,
        "resume": False,
        "check_checkpoint": False,
        "extract_metadata": False,
        "inspect_job": False,
        "event_format": "text",
        "log_file": None,
        "no_checkpoint": False,
        "prefetch_chunks": 1,
        "pcm_queue_size": 1,
        "workers": 1,
        "title": None,
        "author": None,
        "cover": None,
        "voice": "af_heart",
        "speed": 1.0,
        "lang_code": "a",
        "split_pattern": r"\n+",
        "bitrate": "192k",
        "normalize": False,
        "no_rich": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeProc:
    def __init__(self):
        self.stdin = MagicMock()
        self.returncode = None
        self.wait = MagicMock(side_effect=self._wait)
        self.kill = MagicMock(side_effect=self._kill)

    def poll(self):
        return self.returncode

    def _wait(self, timeout=None):
        self.returncode = 0
        return 0

    def _kill(self):
        self.returncode = -9


@pytest.mark.unit
class TestPipelineModeAndBackendResolution:
    def setup_method(self):
        app._AUTO_BACKEND_CACHE = None

    def teardown_method(self):
        app._AUTO_BACKEND_CACHE = None

    def test_default_pipeline_mode_uses_sequential_on_apple_silicon_mp3_without_checkpoint(
        self, monkeypatch
    ):
        monkeypatch.setattr(app.sys, "platform", "darwin")
        monkeypatch.setattr(app.platform, "machine", lambda: "arm64")

        assert app.default_pipeline_mode("mp3", use_checkpoint=False) == "sequential"

    @pytest.mark.parametrize(
        "output_format,use_checkpoint,platform_name,machine,expected",
        [
            ("m4b", False, "darwin", "arm64", "sequential"),
            ("mp3", True, "darwin", "arm64", "sequential"),
            ("mp3", False, "linux", "x86_64", "sequential"),
        ],
    )
    def test_default_pipeline_mode_sequential_other_cases(
        self,
        monkeypatch,
        output_format,
        use_checkpoint,
        platform_name,
        machine,
        expected,
    ):
        monkeypatch.setattr(app.sys, "platform", platform_name)
        monkeypatch.setattr(app.platform, "machine", lambda: machine)

        assert app.default_pipeline_mode(output_format, use_checkpoint) == expected

    def test_resolve_backend_returns_explicit_backend_without_auto_detection(self):
        assert app.resolve_backend("mock") == "mock"

    def test_resolve_backend_auto_uses_mlx_when_probe_succeeds(self, monkeypatch):
        monkeypatch.setattr(app.sys, "platform", "darwin")
        monkeypatch.setattr(app.platform, "machine", lambda: "arm64")
        monkeypatch.setattr(app.importlib.util, "find_spec", lambda name: object())
        probe = MagicMock(returncode=0)
        run_mock = MagicMock(return_value=probe)
        monkeypatch.setattr(app.subprocess, "run", run_mock)

        first = app.resolve_backend("auto")
        second = app.resolve_backend("auto")

        assert first == "mlx"
        assert second == "mlx"
        run_mock.assert_called_once()

    def test_resolve_backend_auto_falls_back_when_mlx_not_installed(self, monkeypatch):
        monkeypatch.setattr(app.sys, "platform", "darwin")
        monkeypatch.setattr(app.platform, "machine", lambda: "arm64")
        monkeypatch.setattr(app.importlib.util, "find_spec", lambda name: None)
        run_mock = MagicMock()
        monkeypatch.setattr(app.subprocess, "run", run_mock)

        assert app.resolve_backend("auto") == "pytorch"
        run_mock.assert_not_called()

    def test_resolve_backend_auto_falls_back_on_probe_timeout(self, monkeypatch):
        monkeypatch.setattr(app.sys, "platform", "darwin")
        monkeypatch.setattr(app.platform, "machine", lambda: "arm64")
        monkeypatch.setattr(app.importlib.util, "find_spec", lambda name: object())

        def raise_timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="probe", timeout=8)

        monkeypatch.setattr(app.subprocess, "run", raise_timeout)

        assert app.resolve_backend("auto") == "pytorch"


@pytest.mark.unit
class TestEventEmitter:
    def test_text_event_emitter_writes_stdout_stderr_and_log(self, capsys, tmp_path):
        log_path = tmp_path / "events.log"
        emitter = app.EventEmitter(event_format="text", job_id="job-1", log_file=str(log_path))

        emitter.emit("phase", phase="PARSING")
        emitter.emit("parse_progress", current_item=1, total_items=3, current_chapter_count=1)
        emitter.emit("progress", current_chunk=2, total_chunks=5)
        emitter.emit("checkpoint", code="FOUND", detail="5:2")
        emitter.warn("careful")
        emitter.error("boom")
        emitter.emit("done")
        emitter.close()

        captured = capsys.readouterr()
        assert "PHASE:PARSING" in captured.out
        assert "PARSE_PROGRESS:1/3:1" in captured.out
        assert "PROGRESS:2/5 chunks" in captured.out
        assert "CHECKPOINT:FOUND:5:2" in captured.out
        assert "DONE" in captured.out
        assert "WARN: careful" in captured.err
        assert "boom" in captured.err

        log_text = log_path.read_text(encoding="utf-8")
        assert "PHASE:PARSING" in log_text
        assert "DONE" in log_text

    def test_json_event_emitter_emits_structured_payload(self, monkeypatch, capsys):
        monkeypatch.setattr(app.time, "time", lambda: 1700000000.123)
        emitter = app.EventEmitter(event_format="json", job_id="job-42")

        emitter.emit("progress", current_chunk=4, total_chunks=10)
        emitter.info("hello")

        captured = capsys.readouterr()
        lines = [line for line in captured.out.splitlines() if line.strip()]
        progress = json.loads(lines[0])
        info = json.loads(lines[1])

        assert progress["type"] == "progress"
        assert progress["job_id"] == "job-42"
        assert progress["current_chunk"] == 4
        assert progress["total_chunks"] == 10
        assert progress["ts_ms"] == 1700000000123
        assert info["type"] == "log"
        assert info["level"] == "info"
        assert info["message"] == "hello"

    def test_text_event_emitter_emits_inspection_payload(self, capsys):
        emitter = app.EventEmitter(event_format="text", job_id="job-99")

        emitter.emit("inspection", result={"output_path": "book.mp3", "total_chunks": 4})

        captured = capsys.readouterr()
        assert 'INSPECTION:{"output_path": "book.mp3", "total_chunks": 4}' in captured.out


@pytest.mark.unit
class TestInspectionMode:
    def test_inspect_job_reports_metadata_and_checkpoint_compatibility(self, monkeypatch, tmp_path):
        args = build_main_args(
            tmp_path,
            inspect_job=True,
            checkpoint=True,
            pipeline_mode="overlap3",
            format="m4b",
        )

        parsed_epub = app.ParsedEpub(
            metadata=app.BookMetadata(
                title="Sample Title",
                author="Sample Author",
                cover_image=b"cover",
                cover_mime_type="image/jpeg",
            ),
            chapters=[("Chapter 1", "Hello world")],
        )

        monkeypatch.setattr(app, "parse_epub", lambda *_args, **_kwargs: parsed_epub)
        monkeypatch.setattr(
            app,
            "split_text_to_chunks",
            lambda chapters, chunk_chars: ([app.TextChunk("Chapter 1", "Hello world")], [(0, "Chapter 1")]),
        )
        monkeypatch.setattr(
            app,
            "inspect_checkpoint",
            lambda *_args, **_kwargs: app.CheckpointInspection(
                exists=True,
                resume_compatible=True,
                total_chunks=1,
                completed_chunks=1,
                missing_audio_chunks=[],
            ),
        )

        inspection = app.inspect_job(args)

        assert inspection.resolved_backend == "mock"
        assert inspection.resolved_chunk_chars == 120
        assert inspection.total_chars == len("Hello world")
        assert inspection.total_chunks == 1
        assert inspection.chapter_count == 1
        assert inspection.epub_metadata == {
            "title": "Sample Title",
            "author": "Sample Author",
            "has_cover": True,
        }
        assert inspection.checkpoint["resume_compatible"] is True
        assert inspection.checkpoint["completed_chunks"] == 1
        assert inspection.resolved_pipeline_mode == "sequential"
        assert inspection.warnings == [
            "--pipeline_mode=overlap3 is currently supported only for MP3 without checkpointing; falling back to sequential."
        ]


@pytest.mark.unit
class TestMp3StreamHelpers:
    def test_open_mp3_export_stream_raises_when_ffmpeg_missing(self, monkeypatch):
        monkeypatch.setattr(app.shutil, "which", lambda _: None)

        with pytest.raises(FileNotFoundError):
            app.open_mp3_export_stream("out.mp3")

    def test_open_mp3_export_stream_builds_ffmpeg_command(self, monkeypatch):
        popen_mock = MagicMock(return_value=MagicMock())
        monkeypatch.setattr(app.shutil, "which", lambda _: "/usr/bin/ffmpeg")
        monkeypatch.setattr(app.subprocess, "Popen", popen_mock)

        app.open_mp3_export_stream(
            "out.mp3",
            sample_rate=44100,
            bitrate="128k",
            normalize=True,
        )

        cmd = popen_mock.call_args.args[0]
        assert cmd[0] == "/usr/bin/ffmpeg"
        assert "-f" in cmd and "s16le" in cmd
        assert "-ar" in cmd and "44100" in cmd
        assert "-af" in cmd
        assert "loudnorm=I=-14:TP=-1:LRA=11" in cmd
        assert cmd[-1] == "out.mp3"

    def test_close_mp3_export_stream_closes_stdin_and_waits(self):
        proc = SimpleNamespace(
            stdin=MagicMock(),
            stderr=SimpleNamespace(read=MagicMock(return_value=b"")),
            wait=MagicMock(return_value=0),
        )

        app.close_mp3_export_stream(proc)  # type: ignore[arg-type]

        proc.stdin.close.assert_called_once()
        proc.stderr.read.assert_called_once()
        proc.wait.assert_called_once()

    def test_close_mp3_export_stream_raises_on_ffmpeg_failure(self):
        proc = SimpleNamespace(
            stdin=MagicMock(),
            stderr=SimpleNamespace(read=MagicMock(return_value=b"bad audio")),
            wait=MagicMock(return_value=1),
        )

        with pytest.raises(RuntimeError, match="ffmpeg failed: bad audio"):
            app.close_mp3_export_stream(proc)  # type: ignore[arg-type]


@pytest.mark.unit
class TestMainCleanupBehavior:
    def test_main_cleans_backend_ffmpeg_and_gc_on_failure(self, monkeypatch, tmp_path):
        args = build_main_args(tmp_path)
        events = MagicMock()
        parsed_epub = app.ParsedEpub(
            metadata=app.BookMetadata(title="Title", author="Author"),
            chapters=[("Chapter 1", "Hello world")],
        )
        backend = SimpleNamespace(
            name="mock",
            sample_rate=24000,
            initialize=MagicMock(),
            generate=MagicMock(side_effect=RuntimeError("inference failed")),
            cleanup=MagicMock(side_effect=RuntimeError("backend cleanup failed")),
        )
        proc = FakeProc()
        gc_collect = MagicMock()

        monkeypatch.setattr(app.sys, "version_info", (3, 12, 0))
        monkeypatch.setattr(app, "parse_args", lambda: args)
        monkeypatch.setattr(app, "EventEmitter", lambda **kwargs: events)
        monkeypatch.setattr(app, "resolve_backend", lambda _: "mock")
        monkeypatch.setattr(app, "parse_epub", lambda *args, **kwargs: parsed_epub)
        monkeypatch.setattr(
            app,
            "split_text_to_chunks",
            lambda chapters, chunk_chars: ([app.TextChunk("Chapter 1", "Hello world")], [(0, "Chapter 1")]),
        )
        monkeypatch.setattr(app, "create_backend", lambda _: backend)
        monkeypatch.setattr(app, "open_mp3_export_stream", lambda *args, **kwargs: proc)
        monkeypatch.setattr(app.gc, "collect", gc_collect)

        with pytest.raises(RuntimeError, match="inference failed"):
            app.main()

        backend.cleanup.assert_called_once()
        proc.stdin.close.assert_called_once()
        proc.wait.assert_called_once_with(timeout=5)
        gc_collect.assert_called_once()
        events.error.assert_called_once_with("inference failed")
        events.close.assert_called_once()

    def test_main_cleans_spool_file_and_gc_on_export_failure(self, monkeypatch, tmp_path):
        args = build_main_args(tmp_path, checkpoint=True)
        events = MagicMock()
        parsed_epub = app.ParsedEpub(
            metadata=app.BookMetadata(title="Title", author="Author"),
            chapters=[("Chapter 1", "Hello world")],
        )
        backend = SimpleNamespace(
            name="mock",
            sample_rate=24000,
            initialize=MagicMock(),
            generate=MagicMock(return_value=[np.array([0.25, -0.25], dtype=np.float32)]),
            cleanup=MagicMock(side_effect=RuntimeError("backend cleanup failed")),
        )
        spool_path = tmp_path / "spool-file.pcm"
        gc_collect = MagicMock()

        class FakeTempFile:
            def __init__(self, path: Path):
                self.name = str(path)
                path.write_bytes(b"")

            def close(self):
                return None

        monkeypatch.setattr(app.sys, "version_info", (3, 12, 0))
        monkeypatch.setattr(app, "parse_args", lambda: args)
        monkeypatch.setattr(app, "EventEmitter", lambda **kwargs: events)
        monkeypatch.setattr(app, "resolve_backend", lambda _: "mock")
        monkeypatch.setattr(app, "parse_epub", lambda *args, **kwargs: parsed_epub)
        monkeypatch.setattr(
            app,
            "split_text_to_chunks",
            lambda chapters, chunk_chars: ([app.TextChunk("Chapter 1", "Hello world")], [(0, "Chapter 1")]),
        )
        monkeypatch.setattr(app, "create_backend", lambda _: backend)
        monkeypatch.setattr(app, "compute_epub_hash", lambda _: "hash")
        monkeypatch.setattr(app, "save_checkpoint", lambda *args, **kwargs: None)
        monkeypatch.setattr(app, "save_chunk_audio", lambda *args, **kwargs: None)
        monkeypatch.setattr(app.tempfile, "NamedTemporaryFile", lambda **kwargs: FakeTempFile(spool_path))
        monkeypatch.setattr(
            app,
            "export_pcm_file_to_mp3",
            MagicMock(side_effect=RuntimeError("export failed")),
        )
        monkeypatch.setattr(app.gc, "collect", gc_collect)

        with pytest.raises(RuntimeError, match="export failed"):
            app.main()

        backend.cleanup.assert_called_once()
        assert not spool_path.exists()
        gc_collect.assert_called_once()
        events.error.assert_called_once_with("export failed")
        events.close.assert_called_once()

    def test_main_reads_epub_once_for_m4b(self, monkeypatch, tmp_path):
        args = build_main_args(
            tmp_path,
            output=str(tmp_path / "output.m4b"),
            format="m4b",
        )
        events = MagicMock()
        backend = SimpleNamespace(
            name="mock",
            sample_rate=24000,
            initialize=MagicMock(),
            generate=MagicMock(return_value=[np.array([0.25, -0.25], dtype=np.float32)]),
            cleanup=MagicMock(),
        )
        mock_book = MagicMock()
        mock_doc = MagicMock()
        mock_doc.get_content.return_value = (
            b"<html><head><title>Chapter 1</title></head><body><p>Hello world.</p></body></html>"
        )
        mock_book.get_metadata.side_effect = lambda ns, key: {
            ("DC", "title"): [("Test Book", {})],
            ("DC", "creator"): [("Test Author", {})],
            ("OPF", "cover"): [],
        }.get((ns, key), [])
        mock_book.get_items.return_value = []
        mock_book.get_items_of_type.side_effect = lambda item_type: {
            app.ebooklib.ITEM_DOCUMENT: [mock_doc],
            app.ebooklib.ITEM_COVER: [],
            app.ebooklib.ITEM_IMAGE: [],
        }.get(item_type, [])
        mock_epub = MagicMock()
        mock_epub.read_epub.return_value = mock_book

        monkeypatch.setattr(app.sys, "version_info", (3, 12, 0))
        monkeypatch.setattr(app, "parse_args", lambda: args)
        monkeypatch.setattr(app, "EventEmitter", lambda **kwargs: events)
        monkeypatch.setattr(app, "resolve_backend", lambda _: "mock")
        monkeypatch.setattr(app, "create_backend", lambda _: backend)
        monkeypatch.setattr(app, "export_pcm_file_to_m4b", MagicMock())
        monkeypatch.setattr(app, "epub", mock_epub)

        app.main()

        mock_epub.read_epub.assert_called_once_with(str(args.input))


@pytest.mark.unit
class TestBackendAvailabilityHelpers:
    def test_get_available_backends_excludes_mlx_when_missing(self, monkeypatch):
        monkeypatch.setattr("backends.factory.importlib.util.find_spec", lambda name: None)

        assert get_available_backends() == ["pytorch", "mock"]

    def test_get_available_backends_includes_mlx_when_installed(self, monkeypatch):
        monkeypatch.setattr("backends.factory.importlib.util.find_spec", lambda name: object())

        assert get_available_backends() == ["pytorch", "mock", "mlx"]

    def test_is_mlx_available_uses_import_discovery(self, monkeypatch):
        monkeypatch.setattr("backends.kokoro_mlx.importlib.util.find_spec", lambda name: object())
        assert is_mlx_available() is True

        monkeypatch.setattr("backends.kokoro_mlx.importlib.util.find_spec", lambda name: None)
        assert is_mlx_available() is False
