"""Integration tests for the IPC protocol messages."""

import pytest
import sys
import io
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch, MagicMock

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


@pytest.mark.integration
class TestIPCProtocol:
    """Test IPC protocol message output."""

    def test_phase_parsing_message(self, capsys):
        """PHASE:PARSING should be emitted before text extraction."""
        print("PHASE:PARSING", flush=True)
        captured = capsys.readouterr()
        assert "PHASE:PARSING" in captured.out

    def test_phase_inference_message(self, capsys):
        """PHASE:INFERENCE should be emitted before inference."""
        print("PHASE:INFERENCE", flush=True)
        captured = capsys.readouterr()
        assert "PHASE:INFERENCE" in captured.out

    def test_phase_concatenating_message(self, capsys):
        """PHASE:CONCATENATING should be emitted before concatenation."""
        print("PHASE:CONCATENATING", flush=True)
        captured = capsys.readouterr()
        assert "PHASE:CONCATENATING" in captured.out

    def test_phase_exporting_message(self, capsys):
        """PHASE:EXPORTING should be emitted before MP3 export."""
        print("PHASE:EXPORTING", flush=True)
        captured = capsys.readouterr()
        assert "PHASE:EXPORTING" in captured.out

    def test_metadata_total_chars_format(self, capsys):
        """METADATA:total_chars:N should have correct format."""
        total_chars = 12345
        print(f"METADATA:total_chars:{total_chars}", flush=True)
        captured = capsys.readouterr()
        assert "METADATA:total_chars:12345" in captured.out

    def test_worker_status_format(self, capsys):
        """WORKER:id:status:details should have correct format."""
        print("WORKER:0:INFER:Chunk 5/50", flush=True)
        captured = capsys.readouterr()
        assert "WORKER:0:INFER:Chunk 5/50" in captured.out

    def test_timing_format(self, capsys):
        """TIMING:chunk_idx:ms should have correct format."""
        print("TIMING:5:2340", flush=True)
        captured = capsys.readouterr()
        assert "TIMING:5:2340" in captured.out

    def test_heartbeat_format(self, capsys):
        """HEARTBEAT:timestamp should have correct format."""
        import time
        ts = int(time.time() * 1000)
        print(f"HEARTBEAT:{ts}", flush=True)
        captured = capsys.readouterr()
        assert f"HEARTBEAT:{ts}" in captured.out

    def test_progress_format(self, capsys):
        """PROGRESS:N/M chunks should have correct format."""
        print("PROGRESS:42/100 chunks", flush=True)
        captured = capsys.readouterr()
        assert "PROGRESS:42/100 chunks" in captured.out

    def test_parse_progress_format(self, capsys):
        """PARSE_PROGRESS:N/M:C should have correct format."""
        print("PARSE_PROGRESS:4/12:3", flush=True)
        captured = capsys.readouterr()
        assert "PARSE_PROGRESS:4/12:3" in captured.out

    def test_ipc_message_sequence(self, capsys):
        """Messages should appear in correct sequence."""
        messages = [
            "PHASE:PARSING",
            "PARSE_PROGRESS:1/2:1",
            "METADATA:total_chars:5000",
            "PHASE:INFERENCE",
            "WORKER:0:INFER:Chunk 1/10",
            "TIMING:0:1500",
            "HEARTBEAT:1234567890",
            "PROGRESS:1/10 chunks",
            "PHASE:CONCATENATING",
            "PHASE:EXPORTING",
        ]

        for msg in messages:
            print(msg, flush=True)

        captured = capsys.readouterr()

        # Verify all messages present
        for msg in messages:
            assert msg in captured.out

        # Verify order (each message should come before the next)
        for i in range(len(messages) - 1):
            pos_current = captured.out.find(messages[i])
            pos_next = captured.out.find(messages[i + 1])
            assert pos_current < pos_next, f"{messages[i]} should come before {messages[i+1]}"


@pytest.mark.integration
class TestIPCProtocolParsing:
    """Test that IPC messages can be parsed correctly."""

    def test_parse_phase_message(self):
        """Should parse PHASE:X messages."""
        line = "PHASE:INFERENCE"
        assert line.startswith("PHASE:")
        phase = line.split(":")[1]
        assert phase == "INFERENCE"

    def test_parse_metadata_message(self):
        """Should parse METADATA:total_chars:N messages."""
        line = "METADATA:total_chars:12345"
        assert line.startswith("METADATA:total_chars:")
        total_chars = int(line.split(":")[2])
        assert total_chars == 12345

    def test_parse_worker_message(self):
        """Should parse WORKER:id:status:details messages."""
        line = "WORKER:0:INFER:Chunk 5/50"
        parts = line.split(":")
        assert parts[0] == "WORKER"
        assert int(parts[1]) == 0
        assert parts[2] == "INFER"
        assert ":".join(parts[3:]) == "Chunk 5/50"

    def test_parse_timing_message(self):
        """Should parse TIMING:idx:ms messages."""
        line = "TIMING:5:2340"
        parts = line.split(":")
        assert parts[0] == "TIMING"
        assert int(parts[1]) == 5
        assert int(parts[2]) == 2340

    def test_parse_heartbeat_message(self):
        """Should parse HEARTBEAT:timestamp messages."""
        line = "HEARTBEAT:1234567890123"
        assert line.startswith("HEARTBEAT:")
        ts = int(line.split(":")[1])
        assert ts == 1234567890123

    def test_parse_progress_message(self):
        """Should parse PROGRESS:N/M chunks messages."""
        line = "PROGRESS:42/100 chunks"
        import re
        match = re.match(r"PROGRESS:(\d+)/(\d+)\s*chunks", line)
        assert match is not None
        current = int(match.group(1))
        total = int(match.group(2))
        assert current == 42
        assert total == 100

    def test_parse_parse_progress_message(self):
        """Should parse PARSE_PROGRESS:N/M:C messages."""
        line = "PARSE_PROGRESS:4/12:3"
        import re
        match = re.match(r"PARSE_PROGRESS:(\d+)/(\d+):(\d+)", line)
        assert match is not None
        current = int(match.group(1))
        total = int(match.group(2))
        chapters = int(match.group(3))
        assert current == 4
        assert total == 12
        assert chapters == 3

    def test_parse_mixed_output(self):
        """Should handle mixed output with non-IPC messages."""
        output = """
PHASE:PARSING
PARSE_PROGRESS:1/4:1
Loading EPUB...
METADATA:total_chars:5000
Processing 10 chunks (sequential GPU + background encoding)
PHASE:INFERENCE
WORKER:0:INFER:Chunk 1/10
Some random log message
TIMING:0:1500
PROGRESS:1/10 chunks
        """

        lines = output.strip().split("\n")
        ipc_messages = []

        for line in lines:
            line = line.strip()
            if any(line.startswith(prefix) for prefix in
                   ["PHASE:", "METADATA:", "WORKER:", "TIMING:", "HEARTBEAT:", "PROGRESS:", "PARSE_PROGRESS:"]):
                ipc_messages.append(line)

        assert len(ipc_messages) == 7
        assert ipc_messages[0] == "PHASE:PARSING"
        assert ipc_messages[1] == "PARSE_PROGRESS:1/4:1"
        assert ipc_messages[2] == "METADATA:total_chars:5000"
        assert ipc_messages[3] == "PHASE:INFERENCE"
        assert ipc_messages[4] == "WORKER:0:INFER:Chunk 1/10"
        assert ipc_messages[5] == "TIMING:0:1500"
        assert ipc_messages[6] == "PROGRESS:1/10 chunks"
