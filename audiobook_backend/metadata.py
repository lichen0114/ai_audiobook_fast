import argparse
import os

from .models import BookMetadata


def _infer_cover_mime_type_from_path(cover_path: str) -> str:
    ext = os.path.splitext(cover_path)[1].lower()
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
    }.get(ext, "image/jpeg")


def apply_metadata_overrides(
    base_metadata: BookMetadata,
    args: argparse.Namespace,
) -> BookMetadata:
    book_metadata = base_metadata

    if args.title:
        book_metadata = BookMetadata(
            title=args.title,
            author=book_metadata.author,
            cover_image=book_metadata.cover_image,
            cover_mime_type=book_metadata.cover_mime_type,
        )
    if args.author:
        book_metadata = BookMetadata(
            title=book_metadata.title,
            author=args.author,
            cover_image=book_metadata.cover_image,
            cover_mime_type=book_metadata.cover_mime_type,
        )
    if args.cover:
        cover_path = os.path.abspath(args.cover)
        if not os.path.exists(cover_path):
            raise FileNotFoundError(
                f"Cover override file not found: {cover_path}"
            )
        with open(cover_path, "rb") as f:
            cover_data = f.read()
        book_metadata = BookMetadata(
            title=book_metadata.title,
            author=book_metadata.author,
            cover_image=cover_data,
            cover_mime_type=_infer_cover_mime_type_from_path(cover_path),
        )

    return book_metadata

