import os
import shutil
import subprocess
import tempfile
from typing import List, Optional

import numpy as np
from pydub import AudioSegment

from .metadata import _infer_cover_mime_type_from_path
from .models import BookMetadata, ChapterInfo

try:
    import torch
except ImportError:
    torch = None


DEFAULT_SAMPLE_RATE = 24000


def audio_to_int16(audio) -> np.ndarray:
    """Convert audio tensor/array to int16 numpy array."""
    if torch is not None and isinstance(audio, torch.Tensor):
        if audio.device.type != "cpu":
            audio = audio.detach().cpu()
        else:
            audio = audio.detach()
        audio = audio.numpy()
    elif not isinstance(audio, np.ndarray):
        audio = np.asarray(audio)

    if audio.dtype != np.int16:
        audio = np.clip(audio, -1.0, 1.0)
        audio = (audio * 32767.0).astype(np.int16)
    return audio


def audio_to_segment(audio: np.ndarray, rate: int = DEFAULT_SAMPLE_RATE) -> AudioSegment:
    if audio.dtype != np.int16:
        audio = audio_to_int16(audio)
    return AudioSegment(
        audio.tobytes(),
        frame_rate=rate,
        sample_width=2,
        channels=1,
    )


def _escape_ffmetadata(text: str) -> str:
    text = text.replace("\\", "\\\\")
    text = text.replace("=", "\\=")
    text = text.replace(";", "\\;")
    text = text.replace("#", "\\#")
    text = text.replace("\n", "\\\n")
    return text


def generate_ffmetadata(
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> str:
    lines = [";FFMETADATA1"]

    lines.append(f"title={_escape_ffmetadata(metadata.title)}")
    lines.append(f"artist={_escape_ffmetadata(metadata.author)}")
    lines.append(f"album={_escape_ffmetadata(metadata.title)}")

    timebase = f"1/{sample_rate}"

    for chapter in chapters:
        lines.append("")
        lines.append("[CHAPTER]")
        lines.append(f"TIMEBASE={timebase}")
        lines.append(f"START={chapter.start_sample}")
        lines.append(f"END={chapter.end_sample}")
        lines.append(f"title={_escape_ffmetadata(chapter.title)}")

    return "\n".join(lines)


def _cover_tempfile_suffix(metadata: BookMetadata) -> str:
    if metadata.cover_mime_type:
        if "png" in metadata.cover_mime_type:
            return ".png"
        if "gif" in metadata.cover_mime_type:
            return ".gif"
    return ".jpg"


def _write_ffmetadata_tempfile(
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int,
) -> str:
    metadata_content = generate_ffmetadata(metadata, chapters, sample_rate)
    metadata_file = tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".txt",
        delete=False,
    )
    metadata_file.write(metadata_content)
    metadata_file.close()
    return metadata_file.name


def _write_cover_tempfile(metadata: BookMetadata) -> Optional[str]:
    if metadata.cover_image is None:
        return None

    cover_file = tempfile.NamedTemporaryFile(
        suffix=_cover_tempfile_suffix(metadata),
        delete=False,
    )
    cover_file.write(metadata.cover_image)
    cover_file.close()
    return cover_file.name


def _build_m4b_ffmpeg_command(
    ffmpeg_path: str,
    audio_input_args: List[str],
    metadata_file: str,
    cover_file: Optional[str],
    bitrate: str,
    normalize: bool,
    output_path: str,
) -> List[str]:
    cmd = [
        ffmpeg_path,
        *audio_input_args,
        "-i", metadata_file,
    ]

    if cover_file:
        cmd.extend(["-i", cover_file])

    cmd.extend([
        "-map", "0:a",
        "-map_metadata", "1",
    ])

    if cover_file:
        cmd.extend([
            "-map", "2:v",
            "-c:v", "copy",
            "-disposition:v:0", "attached_pic",
        ])

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-c:a", "aac",
        "-b:a", bitrate,
        "-movflags", "+faststart",
        "-y", output_path,
    ])
    return cmd


def export_pcm_to_mp3(
    pcm_data: np.ndarray,
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if pcm_data.size == 0:
        cmd = [
            ffmpeg_path,
            "-f", "lavfi",
            "-i", "anullsrc=r=24000:cl=mono",
            "-t", "0.1",
            "-b:a", bitrate,
            "-y", output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        return

    if pcm_data.dtype != np.int16:
        pcm_data = pcm_data.astype(np.int16)

    cmd = [
        ffmpeg_path,
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", "pipe:0",
    ]

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    proc = subprocess.run(cmd, input=pcm_data.tobytes(), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")


def export_pcm_to_m4b(
    pcm_data: np.ndarray,
    output_path: str,
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if pcm_data.dtype != np.int16:
        pcm_data = audio_to_int16(pcm_data)

    temp_files = []
    try:
        metadata_file = _write_ffmetadata_tempfile(metadata, chapters, sample_rate)
        temp_files.append(metadata_file)
        cover_file = _write_cover_tempfile(metadata)
        if cover_file:
            temp_files.append(cover_file)

        if pcm_data.size == 0:
            audio_input_args = [
                "-f", "lavfi",
                "-t", "0.1",
                "-i", f"anullsrc=r={sample_rate}:cl=mono",
            ]
        else:
            audio_input_args = [
                "-f", "s16le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", "pipe:0",
            ]

        cmd = _build_m4b_ffmpeg_command(
            ffmpeg_path,
            audio_input_args,
            metadata_file,
            cover_file,
            bitrate,
            normalize,
            output_path,
        )

        proc = subprocess.run(cmd, input=pcm_data.tobytes(), capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")

    finally:
        for temp_file in temp_files:
            try:
                os.remove(temp_file)
            except OSError:
                pass


def export_pcm_file_to_mp3(
    pcm_path: str,
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    if not os.path.exists(pcm_path) or os.path.getsize(pcm_path) == 0:
        cmd = [
            ffmpeg_path,
            "-f", "lavfi",
            "-i", f"anullsrc=r={sample_rate}:cl=mono",
            "-t", "0.1",
            "-b:a", bitrate,
            "-y", output_path,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        return

    cmd = [
        ffmpeg_path,
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", pcm_path,
    ]

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")


def open_mp3_export_stream(
    output_path: str,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> subprocess.Popen:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    cmd = [
        ffmpeg_path,
        "-f", "s16le",
        "-ar", str(sample_rate),
        "-ac", "1",
        "-i", "pipe:0",
    ]

    if normalize:
        cmd.extend(["-af", "loudnorm=I=-14:TP=-1:LRA=11"])

    cmd.extend([
        "-b:a", bitrate,
        "-y", output_path,
    ])

    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def close_mp3_export_stream(proc: subprocess.Popen) -> None:
    if proc.stdin is not None:
        proc.stdin.close()
    stderr = b""
    if proc.stderr is not None:
        stderr = proc.stderr.read()
    return_code = proc.wait()
    if return_code != 0:
        err = stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg failed: {err}")


def export_pcm_file_to_m4b(
    pcm_path: str,
    output_path: str,
    metadata: BookMetadata,
    chapters: List[ChapterInfo],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    bitrate: str = "192k",
    normalize: bool = False,
) -> None:
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise FileNotFoundError(
            "ffmpeg not found. Install with: brew install ffmpeg"
        )

    temp_files = []
    try:
        metadata_file = _write_ffmetadata_tempfile(metadata, chapters, sample_rate)
        temp_files.append(metadata_file)

        has_audio = os.path.exists(pcm_path) and os.path.getsize(pcm_path) > 0
        if has_audio:
            audio_input_args = [
                "-f", "s16le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", pcm_path,
            ]
        else:
            audio_input_args = [
                "-f", "lavfi",
                "-t", "0.1",
                "-i", f"anullsrc=r={sample_rate}:cl=mono",
            ]

        cover_file = _write_cover_tempfile(metadata)
        if cover_file:
            temp_files.append(cover_file)

        cmd = _build_m4b_ffmpeg_command(
            ffmpeg_path,
            audio_input_args,
            metadata_file,
            cover_file,
            bitrate,
            normalize,
            output_path,
        )

        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {proc.stderr.decode()}")
    finally:
        for temp_file in temp_files:
            try:
                os.remove(temp_file)
            except OSError:
                pass

