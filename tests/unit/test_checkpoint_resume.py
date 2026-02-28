"""Tests for checkpoint verification and resume spooling behavior."""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from app import main, TextChunk
from checkpoint import CheckpointState, save_checkpoint, verify_checkpoint


@pytest.mark.unit
def test_verify_checkpoint_rejects_chunk_chars_mismatch(temp_dir):
    epub_path = f"{temp_dir}/book.epub"
    checkpoint_dir = f"{temp_dir}/book.mp3.checkpoint"

    with open(epub_path, "wb") as f:
        f.write(b"dummy-epub")

    state = CheckpointState(
        epub_hash="",
        config={
            "voice": "af_heart",
            "speed": 1.0,
            "lang_code": "a",
            "backend": "pytorch",
            "chunk_chars": 600,
        },
        total_chunks=10,
        completed_chunks=[0, 1],
        chapter_start_indices=[(0, "Chapter 1")],
    )

    # Fill hash after writing file
    from checkpoint import compute_epub_hash

    state.epub_hash = compute_epub_hash(epub_path)
    save_checkpoint(checkpoint_dir, state)

    ok = verify_checkpoint(
        checkpoint_dir,
        epub_path,
        {
            "voice": "af_heart",
            "speed": 1.0,
            "lang_code": "a",
            "backend": "pytorch",
            "chunk_chars": 900,  # mismatch
        },
    )
    assert ok is False


@pytest.mark.unit
def test_verify_checkpoint_rejects_split_pattern_mismatch(temp_dir):
    epub_path = f"{temp_dir}/book.epub"
    checkpoint_dir = f"{temp_dir}/book.mp3.checkpoint"

    with open(epub_path, "wb") as f:
        f.write(b"dummy-epub")

    state = CheckpointState(
        epub_hash="",
        config={
            "voice": "af_heart",
            "speed": 1.0,
            "lang_code": "a",
            "backend": "pytorch",
            "chunk_chars": 600,
            "split_pattern": r"\n+",
            "format": "mp3",
            "bitrate": "192k",
            "normalize": False,
        },
        total_chunks=10,
        completed_chunks=[0, 1],
        chapter_start_indices=[(0, "Chapter 1")],
    )

    from checkpoint import compute_epub_hash

    state.epub_hash = compute_epub_hash(epub_path)
    save_checkpoint(checkpoint_dir, state)

    ok = verify_checkpoint(
        checkpoint_dir,
        epub_path,
        {
            "voice": "af_heart",
            "speed": 1.0,
            "lang_code": "a",
            "backend": "pytorch",
            "chunk_chars": 600,
            "split_pattern": r"\.\s+",
            "format": "mp3",
            "bitrate": "192k",
            "normalize": False,
        },
    )
    assert ok is False


@pytest.mark.unit
def test_resume_reuses_saved_chunk_audio_in_order(temp_dir):
    epub_path = f"{temp_dir}/book.epub"
    output_path = f"{temp_dir}/book.mp3"

    with open(epub_path, "wb") as f:
        f.write(b"dummy-epub")

    checkpoint_state = CheckpointState(
        epub_hash="hash",
        config={
            "voice": "af_heart",
            "speed": 1.0,
            "lang_code": "a",
            "backend": "pytorch",
            "chunk_chars": 600,
        },
        total_chunks=1,
        completed_chunks=[0],
        chapter_start_indices=[(0, "Chapter 1")],
    )

    backend = MagicMock()
    backend.name = "pytorch"
    backend.sample_rate = 24000
    backend.generate.return_value = []

    with patch("sys.argv", [
        "app.py",
        "--input", epub_path,
        "--output", output_path,
        "--backend", "pytorch",
        "--resume",
        "--checkpoint",
        "--no_rich",
    ]):
        with patch("app.verify_checkpoint", return_value=True):
            with patch("app.load_checkpoint", return_value=checkpoint_state):
                with patch("app.extract_epub_text", return_value=[("Chapter 1", "Hello world")]):
                    with patch("app.split_text_to_chunks", return_value=([TextChunk("Chapter 1", "Hello world")], [(0, "Chapter 1")])):
                        with patch("app.create_backend", return_value=backend):
                            with patch("app.load_chunk_audio", return_value=np.array([1, 2, 3], dtype=np.int16)) as mock_load_chunk:
                                with patch("app.export_pcm_file_to_mp3") as mock_export:
                                    with patch("app.save_checkpoint"):
                                        with patch("app.cleanup_checkpoint"):
                                            with patch("app.sys.version_info", (3, 12, 0)):
                                                main()

    mock_load_chunk.assert_called_once()
    mock_export.assert_called_once()
