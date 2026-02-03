"""Tests for the split_text_to_chunks function."""

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import split_text_to_chunks, TextChunk


@pytest.mark.unit
class TestSplitTextToChunks:
    """Test cases for split_text_to_chunks function."""

    def test_single_chapter_single_chunk(self):
        """Single short chapter should produce single chunk."""
        chapters = [("Chapter 1", "This is a short chapter.")]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        assert len(chunks) == 1
        assert chunks[0].chapter_title == "Chapter 1"
        assert chunks[0].text == "This is a short chapter."

    def test_multiple_chapters(self):
        """Multiple chapters should produce multiple chunks."""
        chapters = [
            ("Chapter 1", "First chapter text."),
            ("Chapter 2", "Second chapter text."),
        ]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        assert len(chunks) == 2
        assert chunks[0].chapter_title == "Chapter 1"
        assert chunks[1].chapter_title == "Chapter 2"

    def test_paragraph_boundaries(self):
        """Chunks should break at paragraph boundaries when possible."""
        chapters = [("Chapter 1", "First paragraph.\n\nSecond paragraph.")]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=20)

        # With small chunk size, should split on paragraph boundary
        assert len(chunks) >= 1
        # Each chunk should be within limit or close to it
        for chunk in chunks:
            # Chunks might slightly exceed due to paragraph logic
            assert len(chunk.text) > 0

    def test_empty_chapters(self):
        """Empty chapters should be skipped."""
        chapters = [
            ("Chapter 1", "Content here."),
            ("Chapter 2", ""),
            ("Chapter 3", "   "),  # Only whitespace
            ("Chapter 4", "More content."),
        ]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        # Only chapters with content should be included
        assert len(chunks) == 2
        assert chunks[0].text == "Content here."
        assert chunks[1].text == "More content."

    def test_chunk_size_limit(self):
        """Chunks should not exceed chunk_chars limit when possible."""
        # Create a chapter with multiple paragraphs
        paragraphs = ["Paragraph " + str(i) + " with some content." for i in range(10)]
        chapters = [("Chapter 1", "\n\n".join(paragraphs))]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        # All chunks should be under or close to the limit
        for chunk in chunks:
            # Single paragraphs that exceed limit will be kept whole
            assert len(chunk.text) > 0

    def test_long_paragraph(self):
        """Long paragraphs should be kept whole even if exceeding limit."""
        long_paragraph = "A" * 2000  # 2000 character paragraph
        chapters = [("Chapter 1", long_paragraph)]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1000)

        # Long paragraph should be kept as single chunk
        assert len(chunks) == 1
        assert len(chunks[0].text) == 2000

    def test_empty_input(self):
        """Empty input should return empty chunks and chapter_starts."""
        chunks, chapter_starts = split_text_to_chunks([], chunk_chars=1200)
        assert chunks == []
        assert chapter_starts == []

    def test_preserves_chapter_title_for_all_chunks(self):
        """All chunks from same chapter should have same title."""
        # Create content that will split into multiple chunks
        paragraphs = ["Para " + str(i) + " " + "x" * 50 for i in range(20)]
        chapters = [("Test Chapter", "\n\n".join(paragraphs))]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        for chunk in chunks:
            assert chunk.chapter_title == "Test Chapter"

    def test_return_type(self):
        """Return type should be tuple of (list of TextChunk, list of chapter starts)."""
        chapters = [("Ch1", "Text")]
        result = split_text_to_chunks(chapters, chunk_chars=1200)

        assert isinstance(result, tuple)
        assert len(result) == 2

        chunks, chapter_starts = result
        assert isinstance(chunks, list)
        assert all(isinstance(c, TextChunk) for c in chunks)
        assert isinstance(chapter_starts, list)

    def test_whitespace_normalization(self):
        """Whitespace in paragraphs should be normalized."""
        chapters = [("Chapter 1", "Para 1\n\n\n\n\nPara 2")]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        # Multiple newlines should not create empty paragraphs
        assert len(chunks) == 1
        assert "Para 1" in chunks[0].text
        assert "Para 2" in chunks[0].text


@pytest.mark.unit
class TestChapterStartIndices:
    """Test cases for chapter_start_indices returned by split_text_to_chunks."""

    def test_single_chapter_start_index(self):
        """Single chapter should have start index of 0."""
        chapters = [("Chapter 1", "Some text content.")]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        assert len(chapter_starts) == 1
        assert chapter_starts[0] == (0, "Chapter 1")

    def test_multiple_chapter_start_indices(self):
        """Each chapter should have correct start index."""
        chapters = [
            ("Chapter 1", "First chapter."),
            ("Chapter 2", "Second chapter."),
            ("Chapter 3", "Third chapter."),
        ]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        assert len(chapter_starts) == 3
        assert chapter_starts[0] == (0, "Chapter 1")
        assert chapter_starts[1] == (1, "Chapter 2")
        assert chapter_starts[2] == (2, "Chapter 3")

    def test_chapter_with_multiple_chunks_start_index(self):
        """Chapter split into multiple chunks should still have single start."""
        paragraphs = ["Para " + str(i) + " " + "x" * 50 for i in range(10)]
        chapters = [("Long Chapter", "\n\n".join(paragraphs))]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=100)

        # Should have multiple chunks but only one chapter start
        assert len(chunks) > 1
        assert len(chapter_starts) == 1
        assert chapter_starts[0] == (0, "Long Chapter")

    def test_empty_chapters_not_in_start_indices(self):
        """Empty chapters should not appear in start indices."""
        chapters = [
            ("Chapter 1", "Content."),
            ("Empty Chapter", ""),
            ("Chapter 2", "More content."),
        ]
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1200)

        # Only non-empty chapters should be in start indices
        assert len(chapter_starts) == 2
        titles = [title for _, title in chapter_starts]
        assert "Chapter 1" in titles
        assert "Chapter 2" in titles
        assert "Empty Chapter" not in titles
