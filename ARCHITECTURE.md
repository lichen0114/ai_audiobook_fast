# Project Architecture

This document describes the technical structure and architecture of the AI Audiobook generator.

## System Overview

The project consists of two main components:
1.  **Frontend CLI**: A Node.js/TypeScript application providing a rich terminal user interface (TUI).
2.  **Backend Core**: A Python script (`app.py`) that handles the heavy lifting of EPUB parsing and Text-to-Speech (TTS) generation using the Kokoro model.

The CLI acts as a controller, spawning the Python process and visualizing its progress in real-time.

## Directory Structure
```
ai_audiobook_fast/
├── app.py                  # Core Python backend script
├── cli/                    # Frontend CLI Application
│   ├── src/                # Source code
│   │   ├── utils/          # Utilities (e.g., tts-runner)
│   │   └── components/     # UI Components (React/Ink)
│   ├── package.json        # CLI dependencies
│   └── tsconfig.json       # TypeScript configuration
├── requirements.txt        # Python dependencies
└── README.md               # Project documentation
```

## System Architecture

The interaction between the CLI and the Python backend is process-based. The CLI spawns the python script and communicates via `stdout`/`stderr`.

```mermaid
graph TD
    User([User]) -->|Run Command| CLI["CLI App (Node.js)"]
    CLI -->|Spawns Process| Python["Python Backend (app.py)"]
    
    subgraph Frontend [Frontend Layer]
        CLI
        UI["Terminal UI (Ink)"]
        Runner[TTS Runner]
        CLI --> UI
        CLI --> Runner
    end

    subgraph Backend [Backend Layer]
        Python
        Loader[EPUB Loader]
        Pipeline[Kokoro Pipeline]
        Workers[Worker Threads]
        
        Python --> Loader
        Python --> Pipeline
        Python --> Workers
    end

    Runner -->|Args & Env Vars| Python
    Python -->|Stdout: Progress/Status| Runner
    Runner -->|Update State| UI
```

## Parallel Processing Strategy

To maximize performance, especially on machines with capable GPUs (like Apple Silicon), the system employs a parallel processing pipeline.

### Producer-Consumer Pattern
- **Producer**: The main thread reads the EPUB, cleans the text, and splits it into optimal chunks (default ~1200 chars). These chunks are pushed into a thread-safe `queue.Queue`.
- **Consumers**: Multiple worker threads (default: 2) pull chunks from the queue and process them independently.

### Worker Lifecycle
Each worker performs two distinct stages for every chunk:
1.  **Inference (GPU-bound)**: The worker uses the `kokoro` pipeline to generate raw audio data. On Apple Silicon, this leverages MPS (Metal Performance Shaders) for acceleration.
2.  **Encoding (CPU-bound)**: The raw audio is converted to an `AudioSegment` (16-bit PCM, 24kHz) using `pydub`/`numpy`.

### Synchronization
- **Results Storage**: Completed audio segments are stored in a dictionary keyed by chunk index (`results_dict`). A `threading.Lock` facilitates safe concurrent writes.
- **Ordered Assembly**: After all chunks are processed, the main thread reassembles the audio segments in the correct order (0 to N) to ensure the audiobook flows correctly.
- **Console Output**: A dedicated `print_lock` ensures that status updates from multiple threads (e.g., `WORKER:0:INFER...`) do not interleave and corrupt the output parsing by the CLI.

```mermaid
sequenceDiagram
    participant Main as Main Thread
    participant Queue
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant Results as Results Dict

    Main->>Queue: Put Chunk 1
    Main->>Queue: Put Chunk 2
    
    par Worker Processing
        W1->>Queue: Get Chunk 1
        W2->>Queue: Get Chunk 2
        W1->>W1: Inference (GPU)
        W2->>W2: Inference (GPU)
        W1->>W1: Encoding (CPU)
        W2->>W2: Encoding (CPU)
        W1->>Results: Store Segment 1
        W2->>Results: Store Segment 2
    end
    
    Main->>Results: Retrieve All Segments
    Main->>Main: Assemble Audiobook
```


## Data Flow

The data flow pipeline transforms an EPUB file into a single MP3 audio file.

```mermaid
sequenceDiagram
    participant EPUB as EPUB File
    participant Parser as Text Parser
    participant Queue as Chunk Queue
    participant Workers as Worker Threads (GPU/CPU)
    participant Merger as Audio Merger
    participant MP3 as Final Output

    EPUB->>Parser: Extract Chapters & Text
    Parser->>Parser: Clean & Normalize Text
    Parser->>Queue: Split into Chunks (<1200 chars)
    
    loop Parallel Processing
        Queue->>Workers: Valid Text Chunk
        Workers->>Workers: Inference (GPU/Kokoro)
        Workers->>Workers: Encoding (CPU/Pydub)
        Workers-->>Merger: Audio Segment
    end

    Merger->>Merger: Concatenate All Segments
    Merger->>MP3: Export to MP3
```

## Key Components

### 1. Python Backend (`app.py`)
- **Libraries**: `kokoro` (TTS), `ebooklib` (EPUB), `pydub` (Audio), `torch`.
- **Concurrency**: Uses `threading` to run multiple workers. Each worker handles both inference (GPU-bound) and encoding (CPU-bound) for a chunk.
- **IPC**: Prints structured logs (e.g., `WORKER:0:INFER:...`) to `stdout` which the CLI parses.

### 2. CLI Frontend (`cli/`)
- **Stack**: `React`, `Ink`, `TypeScript`.
- **Responsibility**: 
    - Argument parsing.
    - Process management (spawning `app.py`).
    - Visualizing workers status and overall progress.
