"""Abstract base class for TTS backends."""

from abc import ABC, abstractmethod
from typing import Generator, Any
import numpy as np


class TTSBackend(ABC):
    """Abstract base class for TTS backends.

    All TTS backends must implement this interface to be usable
    with the audiobook generation pipeline.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the name of this backend (e.g., 'pytorch', 'mlx')."""
        pass

    @property
    @abstractmethod
    def sample_rate(self) -> int:
        """Return the audio sample rate in Hz."""
        pass

    @abstractmethod
    def initialize(self, lang_code: str = "a", device: str = "auto") -> None:
        """Initialize the TTS model.

        Args:
            lang_code: Language code for the TTS model (default: 'a' for American English)
            device: Execution device hint for backends that support it
        """
        pass

    @abstractmethod
    def generate(
        self,
        text: str,
        voice: str,
        speed: float,
        split_pattern: str = r"\n+",
    ) -> Generator[np.ndarray, None, None]:
        """Generate audio from text.

        Args:
            text: The text to synthesize
            voice: Voice identifier (e.g., 'af_heart', 'am_adam')
            speed: Speech speed multiplier (e.g., 1.0 for normal)
            split_pattern: Regex pattern for splitting text internally

        Yields:
            numpy arrays of audio samples (float32 or int16)
        """
        pass

    def cleanup(self) -> None:
        """Optional cleanup method for releasing resources."""
        pass
