"""Tests for the extract_epub_metadata function."""

import pytest
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import extract_epub_metadata, BookMetadata
import ebooklib


@pytest.mark.unit
class TestExtractEpubMetadata:
    """Test cases for extract_epub_metadata function."""

    def test_extract_full_metadata(self):
        """Extract title, author, and cover from EPUB."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('Test Book Title', {})],
                ('DC', 'creator'): [('Test Author', {})],
                ('OPF', 'cover'): [],
            }.get((ns, key), [])

            # Mock cover image
            mock_cover = MagicMock()
            mock_cover.get_content.return_value = b'\x89PNG\r\n\x1a\n'
            mock_cover.media_type = 'image/png'
            mock_book.get_items_of_type.return_value = [mock_cover]

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.title == "Test Book Title"
            assert result.author == "Test Author"
            assert result.cover_image == b'\x89PNG\r\n\x1a\n'
            assert result.cover_mime_type == 'image/png'

    def test_missing_title_uses_default(self):
        """Missing title should default to 'Unknown Title'."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [],  # Empty title
                ('DC', 'creator'): [('Author Name', {})],
                ('OPF', 'cover'): [],
            }.get((ns, key), [])
            mock_book.get_items_of_type.return_value = []
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.title == "Unknown Title"

    def test_missing_author_uses_default(self):
        """Missing author should default to 'Unknown Author'."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('Book Title', {})],
                ('DC', 'creator'): [],  # Empty author
                ('OPF', 'cover'): [],
            }.get((ns, key), [])
            mock_book.get_items_of_type.return_value = []
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.author == "Unknown Author"

    def test_cover_from_opf_metadata(self):
        """Extract cover when specified via OPF metadata."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('Book', {})],
                ('DC', 'creator'): [('Author', {})],
                ('OPF', 'cover'): [('', {'content': 'cover-image-id'})],
            }.get((ns, key), [])

            # No ITEM_COVER
            mock_book.get_items_of_type.return_value = []

            # Cover via OPF metadata reference
            mock_cover_item = MagicMock()
            mock_cover_item.get_id.return_value = 'cover-image-id'
            mock_cover_item.get_content.return_value = b'\xff\xd8\xff\xe0'  # JPEG magic bytes
            mock_cover_item.media_type = 'image/jpeg'
            mock_book.get_items.return_value = [mock_cover_item]

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.cover_image == b'\xff\xd8\xff\xe0'
            assert result.cover_mime_type == 'image/jpeg'

    def test_cover_from_filename_fallback(self):
        """Extract cover by finding image with 'cover' in name."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('Book', {})],
                ('DC', 'creator'): [('Author', {})],
                ('OPF', 'cover'): [],
            }.get((ns, key), [])

            # No ITEM_COVER
            def get_items_of_type_side_effect(item_type):
                if item_type == ebooklib.ITEM_COVER:
                    return []
                elif item_type == ebooklib.ITEM_IMAGE:
                    # Return image with "cover" in name
                    mock_img = MagicMock()
                    mock_img.get_name.return_value = 'images/cover.jpg'
                    mock_img.get_content.return_value = b'fake_jpg_data'
                    mock_img.media_type = 'image/jpeg'
                    return [mock_img]
                return []

            mock_book.get_items_of_type.side_effect = get_items_of_type_side_effect
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.cover_image == b'fake_jpg_data'
            assert result.cover_mime_type == 'image/jpeg'

    def test_no_cover_returns_none(self):
        """When no cover is found, cover fields should be None."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: {
                ('DC', 'title'): [('Book', {})],
                ('DC', 'creator'): [('Author', {})],
                ('OPF', 'cover'): [],
            }.get((ns, key), [])

            # No covers anywhere
            mock_book.get_items_of_type.return_value = []
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert result.cover_image is None
            assert result.cover_mime_type is None

    def test_returns_book_metadata_dataclass(self):
        """Result should be a BookMetadata instance."""
        with patch("app.epub") as mock_epub:
            mock_book = MagicMock()
            mock_book.get_metadata.side_effect = lambda ns, key: []
            mock_book.get_items_of_type.return_value = []
            mock_book.get_items.return_value = []

            mock_epub.read_epub.return_value = mock_book

            result = extract_epub_metadata("test.epub")

            assert isinstance(result, BookMetadata)
