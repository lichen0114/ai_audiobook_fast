"""Factory function for creating TTS backends."""

import importlib.util
from typing import List

from .base import TTSBackend


def create_backend(backend_type: str) -> TTSBackend:
    """Create a TTS backend instance.

    Args:
        backend_type: The type of backend to create ('pytorch', 'mlx', or 'mock')

    Returns:
        An instance of TTSBackend

    Raises:
        ValueError: If the backend type is unknown
        ImportError: If the required dependencies are not installed
    """
    if backend_type == "pytorch":
        from .kokoro_pytorch import KokoroPyTorchBackend

        return KokoroPyTorchBackend()
    elif backend_type == "mlx":
        from .kokoro_mlx import KokoroMLXBackend

        return KokoroMLXBackend()
    elif backend_type == "mock":
        from .mock import MockTTSBackend

        return MockTTSBackend()
    else:
        raise ValueError(
            f"Unknown backend type: {backend_type}. "
            f"Available backends: {get_available_backends()}"
        )


def get_available_backends() -> List[str]:
    """Get a list of available backend types.

    Returns:
        List of backend type strings that can be used with create_backend()
    """
    backends = ["pytorch", "mock"]  # mock backend is always available for tests

    # Check if MLX backend package is installed without importing MLX runtime.
    if importlib.util.find_spec("mlx_audio") is not None:
        backends.append("mlx")

    return backends
