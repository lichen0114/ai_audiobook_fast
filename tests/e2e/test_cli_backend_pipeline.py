"""Subprocess end-to-end tests for CLI/backend integration."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT_DIR = Path(__file__).resolve().parents[2]
APP_PATH = ROOT_DIR / "app.py"
SAMPLE_EPUB = ROOT_DIR / "tests" / "fixtures" / "sample.epub"


def run_app(args: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(APP_PATH), *args, "--no_rich"]
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )


def assert_phase_order(stdout: str) -> None:
    required_phases = [
        "PHASE:PARSING",
        "PHASE:INFERENCE",
        "PHASE:CONCATENATING",
        "PHASE:EXPORTING",
    ]

    positions = [stdout.find(phase) for phase in required_phases]
    assert all(pos != -1 for pos in positions), f"Missing phase(s). stdout:\n{stdout}"
    assert positions == sorted(positions), f"Phases out of order. stdout:\n{stdout}"


@pytest.mark.e2e
@pytest.mark.integration
def test_mock_backend_mp3_end_to_end(tmp_path: Path):
    output_path = tmp_path / "mock-e2e.mp3"
    checkpoint_dir = Path(f"{output_path}.checkpoint")

    result = run_app([
        "--input", str(SAMPLE_EPUB),
        "--output", str(output_path),
        "--backend", "mock",
        "--chunk_chars", "120",
        "--checkpoint",
    ])

    assert result.returncode == 0, result.stderr
    assert_phase_order(result.stdout)

    assert output_path.exists()
    assert output_path.stat().st_size > 0

    assert "CHECKPOINT:SAVED:" in result.stdout
    assert "CHECKPOINT:CLEANED" in result.stdout
    assert not checkpoint_dir.exists()


@pytest.mark.e2e
@pytest.mark.integration
def test_mock_backend_m4b_end_to_end_with_ffprobe(tmp_path: Path):
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg/ffprobe not available")

    output_path = tmp_path / "mock-e2e.m4b"

    result = run_app([
        "--input", str(SAMPLE_EPUB),
        "--output", str(output_path),
        "--backend", "mock",
        "--format", "m4b",
        "--chunk_chars", "120",
        "--checkpoint",
    ])

    assert result.returncode == 0, result.stderr
    assert_phase_order(result.stdout)

    assert output_path.exists()
    assert output_path.stat().st_size > 0

    ffprobe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_chapters",
            "-show_format",
            str(output_path),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert ffprobe.returncode == 0, ffprobe.stderr

    probe_data = json.loads(ffprobe.stdout)
    chapters = probe_data.get("chapters", [])
    assert len(chapters) >= 1


@pytest.mark.e2e
@pytest.mark.integration
def test_resume_after_failed_export_uses_checkpoint(tmp_path: Path):
    output_path = tmp_path / "resume-e2e.mp3"
    checkpoint_dir = Path(f"{output_path}.checkpoint")

    failing_env = os.environ.copy()
    failing_env["PATH"] = ""

    first = run_app([
        "--input", str(SAMPLE_EPUB),
        "--output", str(output_path),
        "--backend", "mock",
        "--chunk_chars", "80",
        "--checkpoint",
    ], env=failing_env)

    assert first.returncode != 0
    assert "ffmpeg not found" in first.stderr.lower()
    assert checkpoint_dir.exists()

    second = run_app([
        "--input", str(SAMPLE_EPUB),
        "--output", str(output_path),
        "--backend", "mock",
        "--chunk_chars", "80",
        "--resume",
    ])

    assert second.returncode == 0, second.stderr
    assert "CHECKPOINT:RESUMING:" in second.stdout
    assert "CHECKPOINT:CLEANED" in second.stdout
    assert output_path.exists()
    assert output_path.stat().st_size > 0
    assert not checkpoint_dir.exists()


@pytest.mark.e2e
@pytest.mark.integration
@pytest.mark.parametrize(
    "args, expected_substring",
    [
        (
            [
                "--input", "missing.epub",
                "--output", "out.mp3",
                "--backend", "mock",
            ],
            "Input EPUB not found",
        ),
    ],
)
def test_failure_paths_report_actionable_errors(
    tmp_path: Path, args: list[str], expected_substring: str
):
    result = run_app(args)
    assert result.returncode != 0
    assert expected_substring in result.stderr

    invalid_epub = tmp_path / "invalid.epub"
    invalid_epub.write_text("this-is-not-a-valid-epub", encoding="utf-8")

    invalid = run_app([
        "--input", str(invalid_epub),
        "--output", str(tmp_path / "invalid.mp3"),
        "--backend", "mock",
    ])

    assert invalid.returncode != 0
    assert invalid.stderr.strip()
    assert (
        "readable text" in invalid.stderr.lower()
        or "zip" in invalid.stderr.lower()
        or "epub" in invalid.stderr.lower()
    )
