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

    def test_m4b_export_without_cover_omits_attached_picture(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        with open(pcm_path, "wb") as f:
            f.write(np.array([0, 1000], dtype=np.int16).tobytes())

        metadata = BookMetadata(title="Book", author="Author")

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_m4b(pcm_path, output_path, metadata, [])

        cmd = mock_run.call_args[0][0]
        assert "attached_pic" not in cmd

    def test_m4b_export_empty_spool_uses_short_silent_audio(self, temp_dir):
        output_path = f"{temp_dir}/output.m4b"
        pcm_path = f"{temp_dir}/missing.pcm"
        metadata = BookMetadata(title="Book", author="Author")

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_m4b(pcm_path, output_path, metadata, [])

        cmd = mock_run.call_args[0][0]
        assert "lavfi" in cmd
        assert any("anullsrc=r=24000:cl=mono" in arg for arg in cmd)
        assert "-t" in cmd

    def test_m4b_export_propagates_sample_rate_bitrate_and_normalize(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        with open(pcm_path, "wb") as f:
            f.write(np.array([0, 1000], dtype=np.int16).tobytes())

        metadata = BookMetadata(title="Book", author="Author")

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_m4b(
                    pcm_path,
                    output_path,
                    metadata,
                    [],
                    sample_rate=48000,
                    bitrate="320k",
                    normalize=True,
                )

        cmd = mock_run.call_args[0][0]
        assert "48000" in cmd
        assert "320k" in cmd
        assert "loudnorm=I=-14:TP=-1:LRA=11" in cmd

    def test_m4b_export_supports_gif_cover_tempfile(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        with open(pcm_path, "wb") as f:
            f.write(np.array([0, 1000], dtype=np.int16).tobytes())

        metadata = BookMetadata(
            title="Book",
            author="Author",
            cover_image=b"GIF89a",
            cover_mime_type="image/gif",
        )

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")
                export_pcm_file_to_m4b(pcm_path, output_path, metadata, [])

        cmd = mock_run.call_args[0][0]
        assert any(arg.endswith(".gif") for arg in cmd)

    def test_m4b_export_raises_when_ffmpeg_missing(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")

        with patch("shutil.which", return_value=None):
            with pytest.raises(FileNotFoundError, match="ffmpeg not found"):
                export_pcm_file_to_m4b(pcm_path, output_path, metadata, [])

    def test_m4b_export_raises_when_ffmpeg_fails(self, temp_dir):
        pcm_path = f"{temp_dir}/input.pcm"
        output_path = f"{temp_dir}/output.m4b"
        with open(pcm_path, "wb") as f:
            f.write(np.array([0, 1000], dtype=np.int16).tobytes())

        metadata = BookMetadata(title="Book", author="Author")

        with patch("shutil.which", return_value="/usr/bin/ffmpeg"):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=1, stderr=b"boom")
                with pytest.raises(RuntimeError, match="ffmpeg failed: boom"):
                    export_pcm_file_to_m4b(pcm_path, output_path, metadata, [])
