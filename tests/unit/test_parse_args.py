"""Tests for the parse_args function."""

import pytest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import parse_args


@pytest.mark.unit
class TestParseArgs:
    """Test cases for parse_args function."""

    def test_required_args(self):
        """Should parse required arguments."""
        with patch("sys.argv", ["app.py", "--input", "book.epub", "--output", "book.mp3"]):
            args = parse_args()

            assert args.input == "book.epub"
            assert args.output == "book.mp3"

    def test_default_values(self):
        """Should use default values when not specified."""
        with patch("sys.argv", ["app.py", "--input", "test.epub", "--output", "test.mp3"]):
            args = parse_args()

            assert args.voice == "af_heart"
            assert args.lang_code == "a"
            assert args.speed == 1.0
            # chunk_chars defaults to None, resolved at runtime based on backend
            # (900 for MLX, 600 for PyTorch)
            assert args.chunk_chars is None
            assert args.split_pattern == r"\n+"
            assert args.workers == 2
            assert args.pipeline_mode is None
            assert args.prefetch_chunks == 2
            assert args.pcm_queue_size == 4
            assert args.no_rich is False
            assert args.backend == "auto"
            assert args.device == "auto"
            assert args.checkpoint is False
            assert args.event_format == "text"
            assert args.log_file is None

    def test_custom_voice(self):
        """Should accept custom voice."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--voice", "bf_emma"
        ]):
            args = parse_args()
            assert args.voice == "bf_emma"

    def test_custom_speed(self):
        """Should accept custom speed."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--speed", "1.5"
        ]):
            args = parse_args()
            assert args.speed == 1.5

    def test_custom_chunk_chars(self):
        """Should accept custom chunk_chars."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--chunk_chars", "2000"
        ]):
            args = parse_args()
            assert args.chunk_chars == 2000

    def test_custom_workers(self):
        """Should accept custom workers count."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--workers", "4"
        ]):
            args = parse_args()
            assert args.workers == 4

    def test_custom_pipeline_mode_and_queue_sizes(self):
        """Should accept overlap pipeline tuning args."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--pipeline_mode", "overlap3",
            "--prefetch_chunks", "3",
            "--pcm_queue_size", "6",
        ]):
            args = parse_args()
            assert args.pipeline_mode == "overlap3"
            assert args.prefetch_chunks == 3
            assert args.pcm_queue_size == 6

    def test_backend_auto(self):
        """Should accept auto backend selection."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--backend", "auto"
        ]):
            args = parse_args()
            assert args.backend == "auto"

    def test_custom_device(self):
        """Should accept explicit device selection."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--device", "cpu"
        ]):
            args = parse_args()
            assert args.device == "cpu"

    def test_checkpoint_flag(self):
        """Should accept --checkpoint flag."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--checkpoint"
        ]):
            args = parse_args()
            assert args.checkpoint is True

    def test_no_rich_flag(self):
        """Should accept --no_rich flag."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--no_rich"
        ]):
            args = parse_args()
            assert args.no_rich is True

    def test_custom_lang_code(self):
        """Should accept custom lang_code."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--lang_code", "b"
        ]):
            args = parse_args()
            assert args.lang_code == "b"

    def test_custom_split_pattern(self):
        """Should accept custom split_pattern."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--split_pattern", r"\.\s+"
        ]):
            args = parse_args()
            assert args.split_pattern == r"\.\s+"

    def test_event_format_and_log_file(self):
        """Should accept structured IPC format and backend log file path."""
        with patch("sys.argv", [
            "app.py", "--input", "test.epub", "--output", "test.mp3",
            "--event_format", "json",
            "--log_file", "/tmp/backend.log",
        ]):
            args = parse_args()
            assert args.event_format == "json"
            assert args.log_file == "/tmp/backend.log"

    def test_missing_required_args(self):
        """Should fail when required args missing."""
        with patch("sys.argv", ["app.py"]):
            with pytest.raises(SystemExit):
                parse_args()

    def test_missing_input(self):
        """Should fail when --input missing."""
        with patch("sys.argv", ["app.py", "--output", "test.mp3"]):
            with pytest.raises(SystemExit):
                parse_args()

    def test_missing_output(self):
        """Should fail when --output missing."""
        with patch("sys.argv", ["app.py", "--input", "test.epub"]):
            with pytest.raises(SystemExit):
                parse_args()

    def test_all_args_combined(self):
        """Should handle all arguments together."""
        with patch("sys.argv", [
            "app.py",
            "--input", "my_book.epub",
            "--output", "my_audiobook.mp3",
            "--voice", "am_michael",
            "--speed", "1.25",
            "--lang_code", "a",
            "--chunk_chars", "1500",
            "--split_pattern", r"\n+",
            "--workers", "3",
            "--pipeline_mode", "sequential",
            "--prefetch_chunks", "5",
            "--pcm_queue_size", "7",
            "--backend", "auto",
            "--device", "mps",
            "--checkpoint",
            "--event_format", "json",
            "--log_file", "/tmp/run.log",
            "--no_rich",
        ]):
            args = parse_args()

            assert args.input == "my_book.epub"
            assert args.output == "my_audiobook.mp3"
            assert args.voice == "am_michael"
            assert args.speed == 1.25
            assert args.lang_code == "a"
            assert args.chunk_chars == 1500
            assert args.split_pattern == r"\n+"
            assert args.workers == 3
            assert args.pipeline_mode == "sequential"
            assert args.prefetch_chunks == 5
            assert args.pcm_queue_size == 7
            assert args.backend == "auto"
            assert args.device == "mps"
            assert args.checkpoint is True
            assert args.event_format == "json"
            assert args.log_file == "/tmp/run.log"
            assert args.no_rich is True
