"""Checkpoint management for resumable audiobook generation."""

import hashlib
import json
import os
import shutil
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Any, Tuple

import numpy as np


@dataclass
class CheckpointState:
    """State saved in a checkpoint for resumable processing."""
    epub_hash: str
    config: Dict[str, Any]
    total_chunks: int
    completed_chunks: List[int]
    chapter_start_indices: List[Tuple[int, str]]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'CheckpointState':
        return cls(
            epub_hash=data['epub_hash'],
            config=data['config'],
            total_chunks=data['total_chunks'],
            completed_chunks=data['completed_chunks'],
            chapter_start_indices=[tuple(x) for x in data['chapter_start_indices']],
        )


def compute_epub_hash(epub_path: str) -> str:
    """Compute SHA-256 hash of EPUB file for verification."""
    hasher = hashlib.sha256()
    with open(epub_path, 'rb') as f:
        # Read in chunks to handle large files
        while chunk := f.read(8192):
            hasher.update(chunk)
    return hasher.hexdigest()


def get_checkpoint_dir(output_path: str) -> str:
    """Get the checkpoint directory path for a given output file."""
    return f"{output_path}.checkpoint"


def save_checkpoint(checkpoint_dir: str, state: CheckpointState) -> None:
    """Save checkpoint state to disk."""
    os.makedirs(checkpoint_dir, exist_ok=True)
    state_path = os.path.join(checkpoint_dir, 'state.json')
    with open(state_path, 'w') as f:
        json.dump(state.to_dict(), f, indent=2)


def load_checkpoint(checkpoint_dir: str) -> Optional[CheckpointState]:
    """Load checkpoint state from disk."""
    state_path = os.path.join(checkpoint_dir, 'state.json')
    if not os.path.exists(state_path):
        return None
    try:
        with open(state_path, 'r') as f:
            data = json.load(f)
        return CheckpointState.from_dict(data)
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def save_chunk_audio(checkpoint_dir: str, chunk_idx: int, audio: np.ndarray) -> None:
    """Save a single chunk's audio data to the checkpoint directory."""
    os.makedirs(checkpoint_dir, exist_ok=True)
    chunk_path = os.path.join(checkpoint_dir, f'chunk_{chunk_idx:06d}.npy')
    np.save(chunk_path, audio)


def load_chunk_audio(checkpoint_dir: str, chunk_idx: int) -> Optional[np.ndarray]:
    """Load a single chunk's audio data from the checkpoint directory."""
    chunk_path = os.path.join(checkpoint_dir, f'chunk_{chunk_idx:06d}.npy')
    if not os.path.exists(chunk_path):
        return None
    try:
        return np.load(chunk_path)
    except (IOError, ValueError):
        return None


def load_all_chunk_audio(checkpoint_dir: str, total_chunks: int) -> Dict[int, np.ndarray]:
    """Load all available chunk audio from checkpoint directory."""
    results: Dict[int, np.ndarray] = {}
    for chunk_idx in range(total_chunks):
        audio = load_chunk_audio(checkpoint_dir, chunk_idx)
        if audio is not None:
            results[chunk_idx] = audio
    return results


def cleanup_checkpoint(checkpoint_dir: str) -> None:
    """Remove checkpoint directory and all its contents."""
    if os.path.exists(checkpoint_dir):
        shutil.rmtree(checkpoint_dir)


def verify_checkpoint(checkpoint_dir: str, epub_path: str, config: Dict[str, Any]) -> bool:
    """Verify that a checkpoint is valid for the current job.

    Checks:
    1. EPUB file hash matches
    2. Config matches (voice, speed, etc.)
    """
    state = load_checkpoint(checkpoint_dir)
    if state is None:
        return False

    # Verify EPUB hash
    current_hash = compute_epub_hash(epub_path)
    if state.epub_hash != current_hash:
        return False

    # Verify key config options match
    # Only check options that affect audio output
    key_options = ['voice', 'speed', 'lang_code', 'backend', 'chunk_chars']
    for key in key_options:
        if state.config.get(key) != config.get(key):
            return False

    return True
