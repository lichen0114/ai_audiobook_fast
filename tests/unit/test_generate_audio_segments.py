"""Tests for the TTS backend generate functionality."""

import pytest
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backends import create_backend, TTSBackend
from backends.kokoro_pytorch import KokoroPyTorchBackend
from backends.mock import MockTTSBackend


@pytest.mark.unit
class TestTTSBackendGenerate:
    """Test cases for TTS backend generate functionality."""

    def test_pytorch_backend_yields_audio_arrays(self):
        """PyTorch backend should yield audio arrays from pipeline."""
        backend = KokoroPyTorchBackend()

        # Mock the pipeline
        mock_pipeline = MagicMock()
        mock_audio = np.random.randn(24000).astype(np.float32)
        mock_pipeline.return_value = [
            ("graphemes1", "phonemes1", mock_audio),
            ("graphemes2", "phonemes2", mock_audio),
        ]

        backend._pipeline = mock_pipeline

        results = list(backend.generate(
            text="Hello world",
            voice="af_heart",
            speed=1.0,
            split_pattern=r"\n+",
        ))

        assert len(results) == 2
        for result in results:
            assert isinstance(result, np.ndarray)

    def test_pytorch_backend_passes_params_to_pipeline(self):
        """PyTorch backend should pass correct parameters to pipeline."""
        backend = KokoroPyTorchBackend()

        mock_pipeline = MagicMock()
        mock_pipeline.return_value = []
        backend._pipeline = mock_pipeline

        list(backend.generate(
            text="Test text",
            voice="af_bella",
            speed=1.5,
            split_pattern=r"\n+",
        ))

        mock_pipeline.assert_called_once_with(
            "Test text",
            voice="af_bella",
            speed=1.5,
            split_pattern=r"\n+",
        )

    def test_backend_not_initialized_raises_error(self):
        """Backend should raise error if generate called before initialize."""
        backend = KokoroPyTorchBackend()

        with pytest.raises(RuntimeError) as excinfo:
            list(backend.generate(
                text="Test",
                voice="af_heart",
                speed=1.0,
            ))

        assert "not initialized" in str(excinfo.value)

    def test_backend_empty_text(self):
        """Empty text should yield nothing."""
        backend = KokoroPyTorchBackend()

        mock_pipeline = MagicMock()
        mock_pipeline.return_value = []
        backend._pipeline = mock_pipeline

        results = list(backend.generate(
            text="",
            voice="af_heart",
            speed=1.0,
            split_pattern=r"\n+",
        ))

        assert results == []

    def test_backend_generator_behavior(self):
        """Backend generate should be a generator, not eagerly evaluated."""
        backend = KokoroPyTorchBackend()

        mock_audio = np.random.randn(24000).astype(np.float32)

        # Use a list with side effects to track iteration
        call_count = [0]

        def mock_generator(*args, **kwargs):
            for i in range(3):
                call_count[0] += 1
                yield (f"g{i}", f"p{i}", mock_audio)

        mock_pipeline = MagicMock(side_effect=mock_generator)
        backend._pipeline = mock_pipeline

        gen = backend.generate(
            text="Test",
            voice="af_heart",
            speed=1.0,
            split_pattern=r"\n+",
        )

        # Generator created but pipeline not called yet
        # (generator starts on first next() call)
        initial_count = call_count[0]

        # Iterate one item
        next(gen)
        assert call_count[0] == initial_count + 1

    def test_backend_different_voices(self):
        """Backend should handle different voice parameters."""
        backend = KokoroPyTorchBackend()

        mock_pipeline = MagicMock()
        mock_pipeline.return_value = []
        backend._pipeline = mock_pipeline

        voices = ["af_heart", "af_bella", "am_adam", "bf_emma", "bm_george"]

        for voice in voices:
            list(backend.generate(
                text="Test",
                voice=voice,
                speed=1.0,
                split_pattern=r"\n+",
            ))

            # Verify voice was passed correctly
            last_call = mock_pipeline.call_args
            assert last_call.kwargs["voice"] == voice

    def test_backend_different_speeds(self):
        """Backend should handle different speed parameters."""
        backend = KokoroPyTorchBackend()

        mock_pipeline = MagicMock()
        mock_pipeline.return_value = []
        backend._pipeline = mock_pipeline

        speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

        for speed in speeds:
            list(backend.generate(
                text="Test",
                voice="af_heart",
                speed=speed,
                split_pattern=r"\n+",
            ))

            last_call = mock_pipeline.call_args
            assert last_call.kwargs["speed"] == speed


@pytest.mark.unit
class TestBackendFactory:
    """Test cases for backend factory function."""

    def test_create_pytorch_backend(self):
        """Factory should create PyTorch backend."""
        backend = create_backend("pytorch")
        assert backend.name == "pytorch"
        assert isinstance(backend, KokoroPyTorchBackend)

    def test_create_invalid_backend(self):
        """Factory should raise error for invalid backend type."""
        with pytest.raises(ValueError) as excinfo:
            create_backend("invalid")

        assert "Unknown backend type" in str(excinfo.value)

    def test_backend_properties(self):
        """Backend should have correct properties."""
        backend = create_backend("pytorch")
        assert backend.name == "pytorch"
        assert backend.sample_rate == 24000

    def test_create_mock_backend(self):
        """Factory should create mock backend for tests."""
        backend = create_backend("mock")
        assert backend.name == "mock"
        assert isinstance(backend, MockTTSBackend)
