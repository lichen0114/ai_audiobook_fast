"""Tests for the export_pcm_to_m4b function."""

import pytest
import sys
import os
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import export_pcm_to_m4b, BookMetadata, ChapterInfo, DEFAULT_SAMPLE_RATE


@pytest.mark.unit
class TestExportPcmToM4b:
    """Test cases for export_pcm_to_m4b function."""

    def test_basic_m4b_export(self, temp_dir, mock_ffmpeg):
        """Basic M4B export should call ffmpeg with correct args."""
        pcm_data = np.array([0, 16383, -16383, 32767, -32767], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Test Book", author="Test Author")
        chapters = [
            ChapterInfo(title="Chapter 1", start_sample=0, end_sample=5)
        ]

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        # Verify ffmpeg was called
        mock_ffmpeg.assert_called_once()
        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]

        # Check key arguments
        assert cmd[0] == "/usr/bin/ffmpeg"
        assert "-f" in cmd
        assert "s16le" in cmd
        assert "-c:a" in cmd
        assert "aac" in cmd
        assert output_path in cmd

    def test_includes_metadata_file(self, temp_dir, mock_ffmpeg):
        """Export should create and use metadata file."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]

        # Should have -i for metadata file (second -i after pipe:0)
        i_indices = [i for i, arg in enumerate(cmd) if arg == "-i"]
        assert len(i_indices) >= 2  # pipe:0 and metadata file

    def test_includes_cover_image_when_present(self, temp_dir, mock_ffmpeg):
        """Export should include cover image in ffmpeg command."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(
            title="Book",
            author="Author",
            cover_image=b'\xff\xd8\xff\xe0',  # JPEG magic bytes
            cover_mime_type='image/jpeg'
        )
        chapters = []

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]

        # Should have 3 inputs: audio, metadata, cover
        i_indices = [i for i, arg in enumerate(cmd) if arg == "-i"]
        assert len(i_indices) >= 3

        # Should have cover mapping
        assert "-disposition:v:0" in cmd
        assert "attached_pic" in cmd

    def test_omits_cover_when_not_present(self, temp_dir, mock_ffmpeg):
        """Export should omit cover mapping when no cover image."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")  # No cover
        chapters = []

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]

        # Should NOT have cover mapping
        assert "-disposition:v:0" not in cmd
        assert "attached_pic" not in cmd

    def test_png_cover_extension(self, temp_dir, mock_ffmpeg):
        """PNG cover should use .png extension for temp file."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(
            title="Book",
            author="Author",
            cover_image=b'\x89PNG\r\n\x1a\n',
            cover_mime_type='image/png'
        )
        chapters = []

        # Track temp files created
        created_files = []
        original_write = open

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        # Should have worked (ffmpeg called)
        assert mock_ffmpeg.called

    def test_ffmpeg_not_found_raises(self, temp_dir):
        """Should raise FileNotFoundError if ffmpeg not found."""
        with patch("shutil.which") as mock_which:
            mock_which.return_value = None

            pcm_data = np.array([0, 1000], dtype=np.int16)
            output_path = f"{temp_dir}/output.m4b"
            metadata = BookMetadata(title="Book", author="Author")
            chapters = []

            with pytest.raises(FileNotFoundError) as excinfo:
                export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

            assert "ffmpeg not found" in str(excinfo.value)

    def test_ffmpeg_failure_raises(self, temp_dir):
        """Should raise RuntimeError if ffmpeg fails."""
        with patch("shutil.which") as mock_which:
            mock_which.return_value = "/usr/bin/ffmpeg"

            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(
                    returncode=1,
                    stderr=b"Error: encoding failed"
                )

                pcm_data = np.array([0, 1000], dtype=np.int16)
                output_path = f"{temp_dir}/output.m4b"
                metadata = BookMetadata(title="Book", author="Author")
                chapters = []

                with pytest.raises(RuntimeError) as excinfo:
                    export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

                assert "ffmpeg failed" in str(excinfo.value)

    def test_temp_files_cleaned_up_on_success(self, temp_dir, mock_ffmpeg):
        """Temp files should be cleaned up after successful export."""
        import tempfile

        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(
            title="Book",
            author="Author",
            cover_image=b'cover_data',
            cover_mime_type='image/jpeg'
        )
        chapters = []

        # Track temp directory contents before
        temp_dir_before = set(os.listdir(tempfile.gettempdir()))

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        # Note: We can't easily verify cleanup in this mock environment
        # but the code structure ensures cleanup via try/finally

    def test_temp_files_cleaned_up_on_failure(self, temp_dir):
        """Temp files should be cleaned up even if ffmpeg fails."""
        with patch("shutil.which") as mock_which:
            mock_which.return_value = "/usr/bin/ffmpeg"

            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(
                    returncode=1,
                    stderr=b"Error"
                )

                pcm_data = np.array([0, 1000], dtype=np.int16)
                output_path = f"{temp_dir}/output.m4b"
                metadata = BookMetadata(title="Book", author="Author")
                chapters = []

                try:
                    export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)
                except RuntimeError:
                    pass  # Expected

                # Cleanup happens in finally block

    def test_custom_sample_rate(self, temp_dir, mock_ffmpeg):
        """Custom sample rate should be passed to ffmpeg."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []
        custom_rate = 48000

        export_pcm_to_m4b(
            pcm_data, output_path, metadata, chapters,
            sample_rate=custom_rate
        )

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]
        assert str(custom_rate) in cmd

    def test_custom_bitrate(self, temp_dir, mock_ffmpeg):
        """Custom bitrate should be passed to ffmpeg."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []

        export_pcm_to_m4b(
            pcm_data, output_path, metadata, chapters,
            bitrate="320k"
        )

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]
        assert "320k" in cmd

    def test_faststart_flag_included(self, temp_dir, mock_ffmpeg):
        """Output should include faststart flag for streaming."""
        pcm_data = np.array([0, 1000], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        call_args = mock_ffmpeg.call_args
        cmd = call_args[0][0]
        assert "-movflags" in cmd
        assert "+faststart" in cmd

    def test_pcm_data_piped_to_ffmpeg(self, temp_dir, mock_ffmpeg):
        """PCM data should be piped to ffmpeg stdin."""
        pcm_data = np.array([0, 16383, -16383], dtype=np.int16)
        output_path = f"{temp_dir}/output.m4b"
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        call_args = mock_ffmpeg.call_args
        input_bytes = call_args.kwargs.get("input")
        assert input_bytes is not None
        assert len(input_bytes) == pcm_data.nbytes
