import os
import subprocess
from typing import Optional

from backends import TTSBackend


def cleanup_backend(backend: Optional[TTSBackend]) -> Optional[BaseException]:
    if backend is None:
        return None

    try:
        backend.cleanup()
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc
    return None


def cleanup_ffmpeg_process(
    proc: Optional[subprocess.Popen],
) -> Optional[BaseException]:
    if proc is None:
        return None

    try:
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (OSError, ValueError):
            pass

        if proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        return None
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc


def cleanup_spool_path(spool_path: Optional[str]) -> Optional[BaseException]:
    if not spool_path:
        return None

    try:
        if os.path.exists(spool_path):
            os.remove(spool_path)
    except FileNotFoundError:
        return None
    except BaseException as exc:  # pragma: no cover - asserted via main() behavior
        return exc
    return None

