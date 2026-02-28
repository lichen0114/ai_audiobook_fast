import argparse
import importlib.util
import os
import platform
import subprocess
import sys
from typing import List, Optional, Tuple


LOW_MEMORY_APPLE_MEMORY_THRESHOLD_BYTES = 8 * 1024 * 1024 * 1024
LOW_MEMORY_APPLE_PYTORCH_CHUNK_CHARS = 400

# Optimal chunk sizes per backend based on benchmarks
# MLX: 900 chars = 180 chars/s (+11% vs 1200)
# PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
DEFAULT_CHUNK_CHARS = {
    "mlx": 900,
    "pytorch": 600,
}

_AUTO_BACKEND_CACHE: Optional[str] = None


def _parse_env_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def is_apple_silicon_host() -> bool:
    return sys.platform == "darwin" and platform.machine() == "arm64"


def _get_macos_total_memory_bytes() -> Optional[int]:
    if sys.platform != "darwin":
        return None

    try:
        probe = subprocess.run(
            ["sysctl", "-n", "hw.memsize"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if probe.returncode != 0:
        return None

    try:
        return int(probe.stdout.strip())
    except ValueError:
        return None


def is_low_memory_apple_host() -> bool:
    forced = _parse_env_bool(os.getenv("AUDIOBOOK_FORCE_LOW_MEMORY_APPLE"))
    if forced is not None:
        return forced

    if not is_apple_silicon_host():
        return False

    total_memory = _get_macos_total_memory_bytes()
    if total_memory is None:
        return False

    return total_memory <= LOW_MEMORY_APPLE_MEMORY_THRESHOLD_BYTES


def default_chunk_chars_for_backend(resolved_backend: str) -> int:
    if resolved_backend == "pytorch" and is_low_memory_apple_host():
        return LOW_MEMORY_APPLE_PYTORCH_CHUNK_CHARS
    return DEFAULT_CHUNK_CHARS.get(resolved_backend, 600)


def resolve_device_for_args(
    args: argparse.Namespace,
    resolved_backend: str,
) -> Tuple[str, List[str]]:
    warnings: List[str] = []
    requested_device = getattr(args, "device", "auto")

    if resolved_backend == "mlx":
        if requested_device != "auto":
            warnings.append(
                f"--device={requested_device} is ignored for MLX backend."
            )
        return "mlx", warnings

    if resolved_backend == "mock":
        if requested_device != "auto":
            warnings.append(
                f"--device={requested_device} is ignored for mock backend."
            )
        return "cpu", warnings

    if requested_device == "auto":
        if is_low_memory_apple_host():
            return "cpu", warnings
        if is_apple_silicon_host():
            return "mps", warnings
        return "auto", warnings

    return requested_device, warnings


def default_pipeline_mode(output_format: str, use_checkpoint: bool) -> str:
    """Choose the safest default pipeline mode."""
    return "sequential"


def resolve_backend(backend: str) -> str:
    """Resolve backend selection, supporting auto-detection on Apple Silicon."""
    global _AUTO_BACKEND_CACHE

    if backend != "auto":
        return backend

    if _AUTO_BACKEND_CACHE is not None:
        return _AUTO_BACKEND_CACHE

    if is_apple_silicon_host():
        if is_low_memory_apple_host():
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

        if importlib.util.find_spec("mlx_audio") is None:
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

        try:
            probe = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import mlx.core as mx; mx.array([1.0]); print('ok')",
                ],
                capture_output=True,
                timeout=8,
            )
            if probe.returncode == 0:
                _AUTO_BACKEND_CACHE = "mlx"
                return _AUTO_BACKEND_CACHE
        except subprocess.TimeoutExpired:
            _AUTO_BACKEND_CACHE = "pytorch"
            return _AUTO_BACKEND_CACHE

    _AUTO_BACKEND_CACHE = "pytorch"
    return _AUTO_BACKEND_CACHE


def resolve_pipeline_mode_for_args(
    args: argparse.Namespace,
    use_checkpoint: bool,
) -> Tuple[str, List[str]]:
    """Resolve the effective pipeline mode and any compatibility warnings."""
    warnings: List[str] = []
    requested_pipeline_mode = args.pipeline_mode or default_pipeline_mode(
        args.format, use_checkpoint
    )
    pipeline_mode = requested_pipeline_mode
    if pipeline_mode == "overlap3" and (args.format != "mp3" or use_checkpoint):
        warnings.append(
            "--pipeline_mode=overlap3 is currently supported only for MP3 "
            "without checkpointing; falling back to sequential."
        )
        pipeline_mode = "sequential"
    return pipeline_mode, warnings

