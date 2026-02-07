"""TTS Backend abstraction layer.

This module provides a unified interface for different TTS backends:
- PyTorch/Kokoro: The default backend using the kokoro library with PyTorch
- MLX/Kokoro: An optimized backend for Apple Silicon using MLX
- Mock: A deterministic backend used by automated end-to-end tests
"""

from .base import TTSBackend
from .factory import create_backend, get_available_backends

__all__ = ["TTSBackend", "create_backend", "get_available_backends"]
