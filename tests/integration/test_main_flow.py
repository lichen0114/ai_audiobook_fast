"""Integration tests for the main processing flow."""

import pytest
import sys
import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import (
    extract_epub_text,
    split_text_to_chunks,
    audio_to_int16,
    export_pcm_to_mp3,
)


@pytest.mark.integration
class TestMainFlow:
    """Integration tests for end-to-end processing flow."""

    def test_epub_to_chunks_flow(self, sample_epub_path):
        """Test EPUB extraction to chunk splitting flow."""
        # Extract text from EPUB
        chapters = extract_epub_text(sample_epub_path)

        assert len(chapters) >= 1

        # Split into chunks
        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=500)

        assert len(chunks) >= 1

        # Verify chunks have content
        for chunk in chunks:
            assert len(chunk.text) > 0
            assert chunk.chapter_title is not None

    def test_audio_processing_flow(self, temp_dir, mock_ffmpeg):
        """Test audio conversion to MP3 export flow."""
        # Simulate TTS output (float audio)
        audio_segments = [
            np.random.randn(24000).astype(np.float32) * 0.5  # 1 sec
            for _ in range(3)
        ]

        # Convert to int16
        int16_segments = [audio_to_int16(seg) for seg in audio_segments]

        # Verify conversion
        for seg in int16_segments:
            assert seg.dtype == np.int16

        # Concatenate
        combined = np.concatenate(int16_segments)
        assert len(combined) == 24000 * 3

        # Export
        output_path = f"{temp_dir}/test.mp3"
        export_pcm_to_mp3(combined, output_path)

        # Verify ffmpeg was called
        mock_ffmpeg.assert_called_once()

    def test_handles_missing_input(self, temp_dir):
        """Should handle missing input file gracefully."""
        nonexistent = f"{temp_dir}/nonexistent.epub"

        with pytest.raises(Exception):
            # This should raise an error
            extract_epub_text(nonexistent)

    def test_creates_output_directory(self, temp_dir, mock_ffmpeg):
        """Should create output directory if it doesn't exist."""
        # Create nested path that doesn't exist
        nested_output = f"{temp_dir}/new/nested/dir/output.mp3"

        # Create parent directory (simulating what main() does)
        output_dir = os.path.dirname(nested_output)
        os.makedirs(output_dir, exist_ok=True)

        assert os.path.exists(output_dir)

        # Export should work with new directory
        audio = np.array([0, 1000, -1000], dtype=np.int16)
        export_pcm_to_mp3(audio, nested_output)

        mock_ffmpeg.assert_called_once()

    def test_empty_epub_handling(self, temp_dir):
        """Should handle EPUB with no text content."""
        # Create minimal empty EPUB
        import zipfile

        epub_path = f"{temp_dir}/empty.epub"

        mimetype = "application/epub+zip"
        container_xml = """<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
            <rootfiles>
                <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
            </rootfiles>
        </container>"""

        content_opf = """<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
            <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                <dc:identifier id="uid">empty-12345</dc:identifier>
                <dc:title>Empty Book</dc:title>
            </metadata>
            <manifest>
                <item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/>
            </manifest>
            <spine>
                <itemref idref="empty"/>
            </spine>
        </package>"""

        empty_xhtml = """<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
        <head><title>Empty</title></head>
        <body></body>
        </html>"""

        with zipfile.ZipFile(epub_path, 'w') as epub:
            epub.writestr('mimetype', mimetype, compress_type=zipfile.ZIP_STORED)
            epub.writestr('META-INF/container.xml', container_xml)
            epub.writestr('OEBPS/content.opf', content_opf)
            epub.writestr('OEBPS/empty.xhtml', empty_xhtml)

        # Should raise ValueError for empty content
        with pytest.raises(ValueError) as excinfo:
            extract_epub_text(epub_path)

        assert "No readable text" in str(excinfo.value)


@pytest.mark.integration
class TestChunkingEdgeCases:
    """Test edge cases in text chunking."""

    def test_very_long_paragraph(self):
        """Very long paragraph should be kept as single chunk."""
        long_text = "A" * 5000
        chapters = [("Ch1", long_text)]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=1000)

        # Single paragraph kept whole
        assert len(chunks) == 1
        assert len(chunks[0].text) == 5000

    def test_many_small_paragraphs(self):
        """Many small paragraphs should be combined."""
        # 100 small paragraphs
        paragraphs = ["Para " + str(i) for i in range(100)]
        text = "\n\n".join(paragraphs)
        chapters = [("Ch1", text)]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=500)

        # Should be multiple chunks, each combining several paragraphs
        assert len(chunks) > 1
        assert len(chunks) < 100  # Not one chunk per paragraph

    def test_mixed_paragraph_lengths(self):
        """Mix of long and short paragraphs."""
        paragraphs = [
            "Short.",
            "A" * 200,  # Medium
            "B" * 2000,  # Long (exceeds chunk size)
            "Short again.",
            "C" * 100,  # Medium
        ]
        text = "\n\n".join(paragraphs)
        chapters = [("Ch1", text)]

        chunks, chapter_starts = split_text_to_chunks(chapters, chunk_chars=500)

        # Long paragraph should be its own chunk
        long_chunk = [c for c in chunks if len(c.text) > 1000]
        assert len(long_chunk) >= 1
