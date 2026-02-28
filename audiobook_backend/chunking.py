import re
from typing import List, Tuple

from .models import ParsedSection, TextChunk


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clean_text_with_paragraphs(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = []

    for raw_paragraph in re.split(r"\n\s*\n+", text):
        paragraph = re.sub(r"\s+", " ", raw_paragraph).strip()
        if paragraph:
            paragraphs.append(paragraph)

    return "\n\n".join(paragraphs)


def split_text_to_chunks(
    chapters: List[Tuple[str, str] | ParsedSection], chunk_chars: int
) -> Tuple[List[TextChunk], List[Tuple[int, str]]]:
    """Split chapters into text chunks and track chapter boundaries."""
    chunks: List[TextChunk] = []
    chapter_start_indices: List[Tuple[int, str]] = []

    def split_oversized_paragraph(paragraph: str) -> List[str]:
        if len(paragraph) <= chunk_chars:
            return [paragraph]

        pieces: List[str] = []
        sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        sentence_buffer = ""

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            if len(sentence) > chunk_chars:
                if sentence_buffer:
                    pieces.append(sentence_buffer)
                    sentence_buffer = ""
                for start in range(0, len(sentence), chunk_chars):
                    pieces.append(sentence[start:start + chunk_chars])
                continue

            candidate = f"{sentence_buffer} {sentence}".strip()
            if len(candidate) <= chunk_chars:
                sentence_buffer = candidate
            else:
                if sentence_buffer:
                    pieces.append(sentence_buffer)
                sentence_buffer = sentence

        if sentence_buffer:
            pieces.append(sentence_buffer)

        return pieces if pieces else [paragraph]

    for chapter in chapters:
        if isinstance(chapter, ParsedSection):
            title = chapter.title
            text = chapter.text
        else:
            title, text = chapter

        paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
        if not paragraphs:
            continue

        chapter_start_indices.append((len(chunks), title))

        buffer = ""
        for paragraph in paragraphs:
            for piece in split_oversized_paragraph(paragraph):
                if len(buffer) + len(piece) + 1 <= chunk_chars:
                    buffer = f"{buffer} {piece}".strip()
                else:
                    if buffer:
                        chunks.append(TextChunk(title, buffer))
                    buffer = piece

        if buffer:
            chunks.append(TextChunk(title, buffer))

    return chunks, chapter_start_indices

