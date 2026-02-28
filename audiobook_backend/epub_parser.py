import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

from .chunking import _clean_text, _clean_text_with_paragraphs
from .models import BookMetadata, ParsedEpub, ParsedSection

try:
    import ebooklib
    from ebooklib import epub
except ImportError:  # pragma: no cover - exercised via fallback tests
    class _EbooklibFallback:
        ITEM_COVER = "ITEM_COVER"
        ITEM_IMAGE = "ITEM_IMAGE"
        ITEM_DOCUMENT = "ITEM_DOCUMENT"

    ebooklib = _EbooklibFallback()
    epub = None


SECTION_BLOCK_TAGS = (
    "p",
    "li",
    "blockquote",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "dt",
    "dd",
)
NAV_DOCUMENT_HINT_RE = re.compile(
    r"(^|[\\/._-])(nav|toc|contents?|landmarks?)([\\/._-]|$)",
    re.IGNORECASE,
)


def _require_epub_support() -> None:
    if epub is None:
        raise ImportError(
            "ebooklib is required for EPUB parsing. Install with: pip install ebooklib"
        )


def _load_epub_book(epub_path: str) -> Any:
    _require_epub_support()
    return epub.read_epub(epub_path)


def _extract_book_metadata(book: Any) -> BookMetadata:
    title_meta = book.get_metadata("DC", "title")
    title = title_meta[0][0] if title_meta else "Unknown Title"

    author_meta = book.get_metadata("DC", "creator")
    author = author_meta[0][0] if author_meta else "Unknown Author"

    cover_image = None
    cover_mime_type = None

    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover_image = item.get_content()
        cover_mime_type = item.media_type
        break

    if cover_image is None:
        cover_meta = book.get_metadata("OPF", "cover")
        if cover_meta:
            cover_id = cover_meta[0][1].get("content") if cover_meta[0][1] else None
            if cover_id:
                for item in book.get_items():
                    if item.get_id() == cover_id:
                        cover_image = item.get_content()
                        cover_mime_type = item.media_type
                        break

    if cover_image is None:
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            item_name = item.get_name().lower()
            if "cover" in item_name:
                cover_image = item.get_content()
                cover_mime_type = item.media_type
                break

    return BookMetadata(
        title=title,
        author=author,
        cover_image=cover_image,
        cover_mime_type=cover_mime_type,
    )


def extract_epub_metadata(epub_path: str) -> BookMetadata:
    book = _load_epub_book(epub_path)
    return _extract_book_metadata(book)


def _normalize_href_reference(value: Optional[str]) -> str:
    if not value:
        return ""

    normalized = str(value).split("#", 1)[0].strip().lower()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _iter_toc_entries(entries: Any) -> Any:
    if not entries:
        return

    if isinstance(entries, tuple):
        for entry in entries:
            yield from _iter_toc_entries(entry)
        return

    if isinstance(entries, list):
        for entry in entries:
            yield from _iter_toc_entries(entry)
        return

    yield entries

    subitems = getattr(entries, "subitems", None)
    if subitems:
        yield from _iter_toc_entries(subitems)


def _build_toc_label_map(book: Any) -> Dict[str, str]:
    toc_labels: Dict[str, str] = {}
    toc = getattr(book, "toc", None)
    if not isinstance(toc, (list, tuple)):
        return toc_labels

    for entry in _iter_toc_entries(toc):
        href = _normalize_href_reference(getattr(entry, "href", None))
        title = getattr(entry, "title", None) or getattr(entry, "text", None)
        if href and isinstance(title, str):
            cleaned_title = _clean_text(title)
            if cleaned_title:
                toc_labels.setdefault(href, cleaned_title)

    return toc_labels


def _get_item_reference_candidates(item: Any) -> List[str]:
    raw_candidates: List[str] = []

    for attr_name in ("file_name", "href"):
        value = getattr(item, attr_name, None)
        if isinstance(value, str):
            raw_candidates.append(value)

    for method_name in ("get_name", "get_id"):
        method = getattr(item, method_name, None)
        if callable(method):
            try:
                value = method()
            except TypeError:
                continue
            if isinstance(value, str):
                raw_candidates.append(value)

    normalized_candidates: List[str] = []
    for candidate in raw_candidates:
        normalized = _normalize_href_reference(candidate)
        if normalized and normalized not in normalized_candidates:
            normalized_candidates.append(normalized)

    return normalized_candidates


def _get_item_properties(item: Any) -> List[str]:
    properties = getattr(item, "properties", None)
    if properties is None:
        get_properties = getattr(item, "get_properties", None)
        if callable(get_properties):
            try:
                properties = get_properties()
            except TypeError:
                properties = None

    if not properties:
        return []

    if not isinstance(properties, (list, tuple, set)):
        return []

    return [str(property_value).lower() for property_value in properties]


def _is_navigation_document(item: Any) -> bool:
    properties = _get_item_properties(item)
    if "nav" in properties:
        return True

    return any(
        NAV_DOCUMENT_HINT_RE.search(candidate) is not None
        for candidate in _get_item_reference_candidates(item)
    )


def _prune_non_content_nodes(body: Any) -> None:
    for node in list(body.find_all(["script", "style"])):
        node.decompose()

    for node in list(body.find_all(True)):
        if node.name == "nav":
            node.decompose()
            continue

        attr_values = [
            node.get("role"),
            node.get("epub:type"),
            node.get("id"),
            " ".join(node.get("class", [])),
        ]
        if any(
            isinstance(value, str)
            and re.search(r"\b(toc|landmarks?)\b", value, re.IGNORECASE)
            for value in attr_values
        ):
            node.decompose()


def _extract_body_text(soup: BeautifulSoup) -> str:
    body = soup.body or soup
    _prune_non_content_nodes(body)

    paragraphs: List[str] = []
    for node in body.find_all(SECTION_BLOCK_TAGS):
        if node.find(SECTION_BLOCK_TAGS):
            continue

        text = _clean_text(node.get_text(" ", strip=True))
        if text:
            paragraphs.append(text)

    if not paragraphs:
        fallback_text = _clean_text(body.get_text(" ", strip=True))
        if fallback_text:
            paragraphs.append(fallback_text)

    return _clean_text_with_paragraphs("\n\n".join(paragraphs))


def _resolve_section_title(
    item: Any,
    soup: BeautifulSoup,
    toc_labels: Dict[str, str],
    chapter_number: int,
) -> str:
    for candidate in _get_item_reference_candidates(item):
        toc_title = toc_labels.get(candidate)
        if toc_title:
            return toc_title

    body = soup.body or soup
    for heading_tag in ("h1", "h2"):
        heading = body.find(heading_tag)
        if heading is None:
            continue

        heading_text = _clean_text(heading.get_text(" ", strip=True))
        if heading_text:
            return heading_text

    if soup.title is not None:
        title_text = _clean_text(soup.title.get_text(" ", strip=True))
        if title_text:
            return title_text

    return f"Chapter {chapter_number}"


def parse_loaded_epub(
    book: Any,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> ParsedEpub:
    metadata = _extract_book_metadata(book)
    chapters: List[ParsedSection] = []
    document_items = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))
    total_items = len(document_items)
    toc_labels = _build_toc_label_map(book)

    for idx, item in enumerate(document_items, start=1):
        if _is_navigation_document(item):
            if progress_callback is not None:
                progress_callback(idx, total_items, len(chapters))
            continue

        soup = BeautifulSoup(item.get_content(), "html.parser")
        text = _extract_body_text(soup)
        if text:
            chapters.append(
                ParsedSection(
                    title=_resolve_section_title(item, soup, toc_labels, len(chapters) + 1),
                    text=text,
                    href=next(iter(_get_item_reference_candidates(item)), ""),
                    item_id=(
                        item.get_id()
                        if callable(getattr(item, "get_id", None))
                        else ""
                    ),
                )
            )
        if progress_callback is not None:
            progress_callback(idx, total_items, len(chapters))

    if not chapters:
        raise ValueError("No readable text content found in EPUB.")

    return ParsedEpub(metadata=metadata, chapters=chapters)


def parse_epub(
    epub_path: str,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> ParsedEpub:
    book = _load_epub_book(epub_path)
    return parse_loaded_epub(book, progress_callback=progress_callback)


def extract_epub_text(epub_path: str) -> List[Tuple[str, str]]:
    return [(chapter.title, chapter.text) for chapter in parse_epub(epub_path).chapters]

