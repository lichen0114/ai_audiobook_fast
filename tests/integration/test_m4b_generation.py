"""Integration tests for M4B audiobook generation."""

import pytest
import sys
import os
import subprocess
import tempfile
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import (
    extract_epub_metadata,
    extract_epub_text,
    split_text_to_chunks,
    generate_ffmetadata,
    export_pcm_to_m4b,
    BookMetadata,
    ChapterInfo,
    DEFAULT_SAMPLE_RATE,
)


@pytest.mark.integration
class TestM4BGeneration:
    """Integration tests for M4B generation pipeline."""

    def test_metadata_to_chapters_flow(self):
        """Test flow from EPUB metadata extraction to chapter generation."""
        with patch("app.epub") as mock_epub:
            # Create mock EPUB with realistic structure
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('The Great Adventure', {})],
                ('DC', 'creator'): [('Jane Author', {})],
                ('OPF', 'cover'): [],
            }.get((ns, key), [])
            mock_book.get_items_of_type.return_value = []
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            # Extract metadata
            metadata = extract_epub_metadata("fake.epub")

            assert metadata.title == "The Great Adventure"
            assert metadata.author == "Jane Author"

    def test_chapter_tracking_through_split(self):
        """Test that chapter boundaries are tracked through text splitting."""
        chapters = [
            ("Chapter 1: Beginning", "This is the first chapter with some text content."),
            ("Chapter 2: Middle", "The second chapter continues the story."),
            ("Chapter 3: End", "Final chapter wraps everything up."),
        ]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        # Should have chapter start indices
        assert len(chapter_starts) == 3
        assert chapter_starts[0] == (0, "Chapter 1: Beginning")
        # Second chapter starts after first chapter's chunks
        assert chapter_starts[1][1] == "Chapter 2: Middle"
        assert chapter_starts[2][1] == "Chapter 3: End"

    def test_ffmetadata_generation_with_real_chapters(self):
        """Test FFMETADATA generation with realistic chapter data."""
        metadata = BookMetadata(
            title="Test Audiobook",
            author="Test Author"
        )
        # Simulate 3 chapters at 24000 Hz
        # Each chapter is about 1 minute (1,440,000 samples)
        chapters = [
            ChapterInfo(title="Introduction", start_sample=0, end_sample=1440000),
            ChapterInfo(title="Main Content", start_sample=1440000, end_sample=2880000),
            ChapterInfo(title="Conclusion", start_sample=2880000, end_sample=4320000),
        ]

        result = generate_ffmetadata(metadata, chapters)

        # Verify structure
        assert ";FFMETADATA1" in result
        assert "title=Test Audiobook" in result
        assert "artist=Test Author" in result

        # Verify chapters
        assert result.count("[CHAPTER]") == 3

        # Verify timing (60 seconds = 60000 ms)
        assert "START=0" in result
        assert "END=60000" in result
        assert "START=60000" in result
        assert "END=120000" in result

    @pytest.mark.slow
    def test_m4b_export_with_mock_ffmpeg(self, temp_dir):
        """Test M4B export pipeline with mocked ffmpeg."""
        with patch("shutil.which") as mock_which:
            mock_which.return_value = "/usr/bin/ffmpeg"

            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr=b"")

                # Create test data
                pcm_data = np.random.randint(-32768, 32767, size=48000, dtype=np.int16)
                output_path = f"{temp_dir}/test.m4b"
                metadata = BookMetadata(
                    title="Test Book",
                    author="Test Author",
                    cover_image=b'\x89PNG\r\n\x1a\n' + b'\x00' * 100,
                    cover_mime_type='image/png'
                )
                chapters = [
                    ChapterInfo(title="Chapter 1", start_sample=0, end_sample=24000),
                    ChapterInfo(title="Chapter 2", start_sample=24000, end_sample=48000),
                ]

                export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

                # Verify ffmpeg was called correctly
                mock_run.assert_called_once()
                call_args = mock_run.call_args
                cmd = call_args[0][0]

                # Check essential arguments
                assert "-c:a" in cmd and "aac" in cmd
                assert "-movflags" in cmd and "+faststart" in cmd
                assert output_path in cmd

                # Check cover was included
                assert "-disposition:v:0" in cmd

    def test_chapter_info_sample_to_time_conversion(self):
        """Test that sample positions convert to correct timestamps."""
        # At 24000 Hz:
        # 24000 samples = 1 second = 1000 ms
        # 72000 samples = 3 seconds = 3000 ms
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Ch1", start_sample=0, end_sample=24000),
            ChapterInfo(title="Ch2", start_sample=24000, end_sample=72000),
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=24000)

        # Parse chapter timings
        assert "START=0" in result
        assert "END=1000" in result
        assert "START=1000" in result
        assert "END=3000" in result

    def test_empty_toc_fallback(self):
        """Test that chapters get numbered if no titles are present."""
        chapters = [
            ("", "Content without a title."),
            ("", "More content without title."),
        ]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        # Chapter starts should have empty titles
        assert chapter_starts[0][1] == ""
        assert chapter_starts[1][1] == ""

        # When building ChapterInfo, the main code falls back to "Chapter N"
        # This tests the input scenario

    def test_single_chapter_book(self):
        """Test handling of a book with only one chapter."""
        chapters = [
            ("The Whole Book", "This is the entire content of a very short book."),
        ]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        assert len(chapter_starts) == 1
        assert chapter_starts[0] == (0, "The Whole Book")

    def test_special_characters_preserved_in_chapters(self):
        """Test that special characters in chapter titles are handled."""
        chapters = [
            ("Chapter 1: \"Quotes\" & Ampersands", "Content here."),
            ("Part 2 - The 'Apostrophe' Test", "More content."),
        ]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        assert "\"Quotes\" & Ampersands" in chapter_starts[0][1]
        assert "'Apostrophe'" in chapter_starts[1][1]


@pytest.mark.integration
class TestM4BEndToEnd:
    """End-to-end tests for M4B generation (requires real ffmpeg)."""

    @pytest.fixture
    def has_ffmpeg(self):
        """Check if ffmpeg is available."""
        import shutil
        return shutil.which("ffmpeg") is not None

    @pytest.mark.slow
    def test_real_m4b_creation(self, temp_dir, has_ffmpeg):
        """Create an actual M4B file and verify with ffprobe."""
        if not has_ffmpeg:
            pytest.skip("ffmpeg not available")

        # Generate test audio (2 seconds of silence)
        pcm_data = np.zeros(48000, dtype=np.int16)
        output_path = f"{temp_dir}/test_real.m4b"
        metadata = BookMetadata(
            title="Real Test Book",
            author="Test Author"
        )
        chapters = [
            ChapterInfo(title="First Half", start_sample=0, end_sample=24000),
            ChapterInfo(title="Second Half", start_sample=24000, end_sample=48000),
        ]

        export_pcm_to_m4b(pcm_data, output_path, metadata, chapters)

        # Verify file was created
        assert os.path.exists(output_path)
        assert os.path.getsize(output_path) > 0

        # Verify with ffprobe if available
        ffprobe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_chapters", "-show_format", output_path],
            capture_output=True
        )

        if ffprobe.returncode == 0:
            probe_data = json.loads(ffprobe.stdout)

            # Check format
            assert probe_data.get("format", {}).get("format_name") in ["mov,mp4,m4a,3gp,3g2,mj2", "m4a", "mp4"]

            # Check chapters exist
            chapters_data = probe_data.get("chapters", [])
            assert len(chapters_data) == 2

            # Check chapter titles
            chapter_titles = [c.get("tags", {}).get("title", "") for c in chapters_data]
            assert "First Half" in chapter_titles
            assert "Second Half" in chapter_titles
