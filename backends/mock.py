"""Deterministic mock backend for end-to-end tests."""

import re
from typing import Generator

import numpy as np

from .base import TTSBackend


class MockTTSBackend(TTSBackend):
    """Fast, deterministic backend that generates synthetic PCM audio."""

    def __init__(self) -> None:
        self._initialized = False
        self._lang_code = "a"

    @property
    def name(self) -> str:
        return "mock"

    @property
    def sample_rate(self) -> int:
        return 24000

    def initialize(self, lang_code: str = "a", device: str = "auto") -> None:
        self._initialized = True
        self._lang_code = lang_code

    def generate(
        self,
        text: str,
        voice: str,
        speed: float,
        split_pattern: str = r"\n+",
    ) -> Generator[np.ndarray, None, None]:
        if not self._initialized:
            raise RuntimeError("Mock backend not initialized. Call initialize() first.")

        segments = [seg.strip() for seg in re.split(split_pattern, text) if seg.strip()]
        if not segments and text.strip():
            segments = [text.strip()]

        for segment in segments:
            yield self._segment_to_audio(segment, speed)

    def cleanup(self) -> None:
        self._initialized = False

    def _segment_to_audio(self, segment: str, speed: float) -> np.ndarray:
        """Generate deterministic int16 tone data from input segment text."""
        safe_speed = max(speed, 0.1)
        base_len = max(480, min(48000, int(len(segment) * (160 / safe_speed))))
        seed = sum((idx + 1) * ord(ch) for idx, ch in enumerate(segment)) % 9973
        freq_hz = 180 + (seed % 220)
        phase = (seed % 360) * np.pi / 180.0

        t = np.arange(base_len, dtype=np.float32)
        waveform = np.sin((2 * np.pi * freq_hz * t / self.sample_rate) + phase)
        envelope = np.linspace(0.9, 0.5, base_len, dtype=np.float32)
        pcm = np.clip(waveform * envelope * 12000.0, -32768, 32767)
        return pcm.astype(np.int16)
