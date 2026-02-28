"""Tests for apply_metadata_overrides."""

import argparse
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import apply_metadata_overrides, BookMetadata


def build_args(**overrides) -> argparse.Namespace:
    values = {
        "title": None,
        "author": None,
        "cover": None,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


@pytest.mark.unit
class TestApplyMetadataOverrides:
    def test_title_override_replaces_epub_title(self):
        metadata = BookMetadata(title="EPUB Title", author="EPUB Author")

        result = apply_metadata_overrides(metadata, build_args(title="CLI Title"))

        assert result.title == "CLI Title"
        assert result.author == "EPUB Author"

    def test_author_override_replaces_epub_author(self):
        metadata = BookMetadata(title="EPUB Title", author="EPUB Author")

        result = apply_metadata_overrides(metadata, build_args(author="CLI Author"))

        assert result.title == "EPUB Title"
        assert result.author == "CLI Author"

    @pytest.mark.parametrize(
        ("extension", "expected_mime"),
        [
            (".jpg", "image/jpeg"),
            (".jpeg", "image/jpeg"),
            (".png", "image/png"),
            (".gif", "image/gif"),
            (".bmp", "image/jpeg"),
        ],
    )
    def test_cover_override_detects_mime_type(self, tmp_path, extension, expected_mime):
        cover_path = tmp_path / f"cover{extension}"
        cover_path.write_bytes(b"cover-bytes")
        metadata = BookMetadata(title="Book", author="Author")

        result = apply_metadata_overrides(
            metadata,
            build_args(cover=str(cover_path)),
        )

        assert result.cover_image == b"cover-bytes"
        assert result.cover_mime_type == expected_mime

    def test_cover_override_raises_for_missing_path(self, tmp_path):
        missing_cover = tmp_path / "missing.png"
        metadata = BookMetadata(title="Book", author="Author")

        with pytest.raises(FileNotFoundError, match="Cover override file not found"):
            apply_metadata_overrides(metadata, build_args(cover=str(missing_cover)))
