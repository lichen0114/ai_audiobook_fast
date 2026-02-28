"""Tests for the generate_ffmetadata function."""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import (
    generate_ffmetadata,
    _escape_ffmetadata,
    BookMetadata,
    ChapterInfo,
    DEFAULT_SAMPLE_RATE,
)


@pytest.mark.unit
class TestEscapeFfmetadata:
    """Test cases for _escape_ffmetadata helper."""

    def test_escape_equals_sign(self):
        """Equals sign should be escaped."""
        assert _escape_ffmetadata("a=b") == "a\\=b"

    def test_escape_semicolon(self):
        """Semicolon should be escaped."""
        assert _escape_ffmetadata("a;b") == "a\\;b"

    def test_escape_hash(self):
        """Hash sign should be escaped."""
        assert _escape_ffmetadata("a#b") == "a\\#b"

    def test_escape_backslash(self):
        """Backslash should be escaped first."""
        assert _escape_ffmetadata("a\\b") == "a\\\\b"

    def test_escape_newline(self):
        """Newline should be escaped."""
        assert _escape_ffmetadata("a\nb") == "a\\\nb"

    def test_escape_multiple_special_chars(self):
        """Multiple special characters should all be escaped."""
        result = _escape_ffmetadata("a=b;c#d\\e")
        assert result == "a\\=b\\;c\\#d\\\\e"

    def test_no_escape_needed(self):
        """Normal text should pass through unchanged."""
        assert _escape_ffmetadata("Hello World") == "Hello World"


@pytest.mark.unit
class TestGenerateFfmetadata:
    """Test cases for generate_ffmetadata function."""

    def test_basic_metadata_format(self):
        """Generated metadata should have FFMETADATA1 header."""
        metadata = BookMetadata(title="Test Book", author="Test Author")
        chapters = []

        result = generate_ffmetadata(metadata, chapters)

        assert result.startswith(";FFMETADATA1")
        assert "title=Test Book" in result
        assert "artist=Test Author" in result
        assert "album=Test Book" in result

    def test_single_chapter(self):
        """Single chapter should be formatted correctly."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Chapter 1", start_sample=0, end_sample=24000)
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=24000)

        assert "[CHAPTER]" in result
        assert "TIMEBASE=1/24000" in result
        assert "START=0" in result
        assert "END=24000" in result
        assert "title=Chapter 1" in result

    def test_multiple_chapters(self):
        """Multiple chapters should all be included."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Chapter 1", start_sample=0, end_sample=24000),
            ChapterInfo(title="Chapter 2", start_sample=24000, end_sample=48000),
            ChapterInfo(title="Chapter 3", start_sample=48000, end_sample=72000),
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=24000)

        # Check all chapters are present
        assert result.count("[CHAPTER]") == 3
        assert "title=Chapter 1" in result
        assert "title=Chapter 2" in result
        assert "title=Chapter 3" in result

    def test_chapter_timing_conversion(self):
        """Chapter times should preserve raw sample offsets."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Ch", start_sample=0, end_sample=48000)
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=24000)

        assert "START=0" in result
        assert "END=48000" in result

    def test_special_chars_in_title_escaped(self):
        """Special characters in chapter titles should be escaped."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Part 1: The Beginning", start_sample=0, end_sample=24000)
        ]

        result = generate_ffmetadata(metadata, chapters)

        # Colon is safe, but check title is present
        assert "title=Part 1" in result

    def test_special_chars_in_metadata_escaped(self):
        """Special characters in book metadata should be escaped."""
        metadata = BookMetadata(
            title="Book; Part=1 #2",
            author="Author\\Name"
        )
        chapters = []

        result = generate_ffmetadata(metadata, chapters)

        assert "title=Book\\; Part\\=1 \\#2" in result
        assert "artist=Author\\\\Name" in result

    def test_custom_sample_rate(self):
        """Custom sample rate should change the chapter timebase."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Ch", start_sample=0, end_sample=48000)
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=48000)

        assert "TIMEBASE=1/48000" in result
        assert "END=48000" in result

    def test_empty_chapters_list(self):
        """Empty chapters list should produce metadata without chapters."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = []

        result = generate_ffmetadata(metadata, chapters)

        assert ";FFMETADATA1" in result
        assert "title=Book" in result
        assert "[CHAPTER]" not in result

    def test_chapter_with_zero_duration(self):
        """Chapter with same start and end should still be valid."""
        metadata = BookMetadata(title="Book", author="Author")
        chapters = [
            ChapterInfo(title="Empty Chapter", start_sample=1000, end_sample=1000)
        ]

        result = generate_ffmetadata(metadata, chapters, sample_rate=24000)

        # Should still produce output
        assert "[CHAPTER]" in result
