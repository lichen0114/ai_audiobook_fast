"""Tests for file-based PCM export helpers."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import (
    export_pcm_file_to_m4b,
    export_pcm_file_to_mp3,
    BookMetadata,
    ChapterInfo,
)


@pytest.mark.unit
class TestExportPcmFile:
    """Test cases for file-based exporters."""

    def test_mp3_export_uses_pcm_file_input(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.mp3"
        pcm = np.array([0, 16383, -16383], dtype=np.int16)
        with open(pcm_path, "wb") as f:
            f.write(pcm.tobytes())

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_mp3(pcm_path, output_path)

        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert "-i" in cmd
        assert pcm_path in cmd
        assert "pipe:0" not in cmd
        assert mock_run.call_args.kwargs.get("input") is None

    def test_m4b_export_keeps_metadata_and_cover(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        pcm = np.array([0, 16383, -16383], dtype=np.int16)
        with open(pcm_path, "wb") as f:
            f.write(pcm.tobytes())

        metadata = BookMetadata(
            title="Book",
            author="Author",
            cover_image=b"\xff\xd8\xff\xe0",
            cover_mime_type="image/jpeg",
        )
        chapters = [ChapterInfo(title="Chapter 1", start_sample=0, end_sample=10)]

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_m4b(pcm_path, output_path, metadata, chapters)

        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert pcm_path in cmd
        assert "-map_metadata" in cmd
        assert "attached_pic" in cmd
        assert mock_run.call_args.kwargs.get("input") is None
