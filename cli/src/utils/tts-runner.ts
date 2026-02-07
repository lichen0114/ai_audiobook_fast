import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import type { TTSConfig } from '../App.js';

export interface WorkerStatus {
    id: number;
    status: 'IDLE' | 'INFER' | 'ENCODE';
    details: string;
}

export type ProcessingPhase = 'PARSING' | 'INFERENCE' | 'CONCATENATING' | 'EXPORTING' | 'DONE';
export type ResolvedBackend = 'pytorch' | 'mlx' | 'mock';

export interface ProgressInfo {
    progress: number;
    currentChunk: number;
    totalChunks: number;
    workerStatus?: WorkerStatus;
    phase?: ProcessingPhase;
    chunkTimingMs?: number;  // Per-chunk timing in ms
    heartbeatTs?: number;    // Heartbeat timestamp
    totalChars?: number;     // Total characters in EPUB
    chapterCount?: number;   // Number of chapters in EPUB
    backendResolved?: ResolvedBackend;
}

export interface ParserState {
    lastProgress: number;
    lastCurrentChunk: number;
    lastTotal: number;
    lastPhase?: ProcessingPhase;
    lastTotalChars?: number;
    lastChapterCount?: number;
    lastBackendResolved?: ResolvedBackend;
}

const PROCESSING_PHASES: ProcessingPhase[] = [
    'PARSING',
    'INFERENCE',
    'CONCATENATING',
    'EXPORTING',
    'DONE',
];

function isProcessingPhase(value: string): value is ProcessingPhase {
    return PROCESSING_PHASES.includes(value as ProcessingPhase);
}

export function createParserState(): ParserState {
    return {
        lastProgress: 0,
        lastCurrentChunk: 0,
        lastTotal: 0,
    };
}

export function parseOutputLine(line: string, state: ParserState): ProgressInfo | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith('PHASE:')) {
        const phase = trimmed.slice(6);
        if (!isProcessingPhase(phase)) {
            return null;
        }
        state.lastPhase = phase;
        return {
            progress: state.lastProgress,
            currentChunk: state.lastCurrentChunk,
            totalChunks: state.lastTotal,
            phase,
            totalChars: state.lastTotalChars,
            chapterCount: state.lastChapterCount,
            backendResolved: state.lastBackendResolved,
        };
    }

    if (trimmed.startsWith('METADATA:backend_resolved:')) {
        const backendResolved = trimmed.slice(26);
        if (backendResolved === 'pytorch' || backendResolved === 'mlx' || backendResolved === 'mock') {
            state.lastBackendResolved = backendResolved;
            return {
                progress: state.lastProgress,
                currentChunk: state.lastCurrentChunk,
                totalChunks: state.lastTotal,
                phase: state.lastPhase,
                totalChars: state.lastTotalChars,
                chapterCount: state.lastChapterCount,
                backendResolved,
            };
        }
        return null;
    }

    if (trimmed.startsWith('METADATA:total_chars:')) {
        const totalChars = parseInt(trimmed.slice(21), 10);
        if (Number.isNaN(totalChars)) {
            return null;
        }
        state.lastTotalChars = totalChars;
        return {
            progress: state.lastProgress,
            currentChunk: state.lastCurrentChunk,
            totalChunks: state.lastTotal,
            phase: state.lastPhase,
            totalChars,
            chapterCount: state.lastChapterCount,
            backendResolved: state.lastBackendResolved,
        };
    }

    if (trimmed.startsWith('METADATA:chapter_count:')) {
        const chapterCount = parseInt(trimmed.slice(23), 10);
        if (Number.isNaN(chapterCount)) {
            return null;
        }
        state.lastChapterCount = chapterCount;
        return {
            progress: state.lastProgress,
            currentChunk: state.lastCurrentChunk,
            totalChunks: state.lastTotal,
            phase: state.lastPhase,
            totalChars: state.lastTotalChars,
            chapterCount,
            backendResolved: state.lastBackendResolved,
        };
    }

    if (trimmed.startsWith('TIMING:')) {
        const parts = trimmed.slice(7).split(':');
        if (parts.length >= 2) {
            const chunkTimingMs = parseInt(parts[1], 10);
            if (!Number.isNaN(chunkTimingMs)) {
                return {
                    progress: state.lastProgress,
                    currentChunk: state.lastCurrentChunk,
                    totalChunks: state.lastTotal,
                    phase: state.lastPhase,
                    chunkTimingMs,
                    totalChars: state.lastTotalChars,
                    chapterCount: state.lastChapterCount,
                    backendResolved: state.lastBackendResolved,
                };
            }
        }
        return null;
    }

    if (trimmed.startsWith('HEARTBEAT:')) {
        const heartbeatTs = parseInt(trimmed.slice(10), 10);
        if (Number.isNaN(heartbeatTs)) {
            return null;
        }
        return {
            progress: state.lastProgress,
            currentChunk: state.lastCurrentChunk,
            totalChunks: state.lastTotal,
            phase: state.lastPhase,
            heartbeatTs,
            totalChars: state.lastTotalChars,
            chapterCount: state.lastChapterCount,
            backendResolved: state.lastBackendResolved,
        };
    }

    if (trimmed.startsWith('WORKER:')) {
        const parts = trimmed.split(':');
        if (parts.length >= 4) {
            const id = parseInt(parts[1], 10);
            const status = parts[2];
            if (
                !Number.isNaN(id)
                && (status === 'IDLE' || status === 'INFER' || status === 'ENCODE')
            ) {
                return {
                    progress: state.lastProgress,
                    currentChunk: state.lastCurrentChunk,
                    totalChunks: state.lastTotal,
                    phase: state.lastPhase,
                    workerStatus: { id, status, details: parts.slice(3).join(':') },
                    totalChars: state.lastTotalChars,
                    chapterCount: state.lastChapterCount,
                    backendResolved: state.lastBackendResolved,
                };
            }
        }
        return null;
    }

    const chunkMatch = trimmed.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
    if (chunkMatch) {
        const current = parseInt(chunkMatch[1], 10);
        const total = parseInt(chunkMatch[2], 10);
        if (total <= 0 || Number.isNaN(current) || Number.isNaN(total)) {
            return null;
        }
        const progress = Math.round((current / total) * 100);

        state.lastProgress = progress;
        state.lastCurrentChunk = current;
        state.lastTotal = total;

        return {
            progress,
            currentChunk: current,
            totalChunks: total,
            phase: state.lastPhase,
            totalChars: state.lastTotalChars,
            chapterCount: state.lastChapterCount,
            backendResolved: state.lastBackendResolved,
        };
    }

    return null;
}

function resolveBackendForEnv(config: TTSConfig, projectRoot: string, venvPython: string): ResolvedBackend {
    if (config.backend === 'pytorch' || config.backend === 'mlx' || config.backend === 'mock') {
        return config.backend;
    }

    if (!(process.platform === 'darwin' && process.arch === 'arm64')) {
        return 'pytorch';
    }

    try {
        const probe = spawnSync(
            venvPython,
            ['-c', 'import mlx.core as mx; mx.array([1.0]); print("mlx")'],
            {
                cwd: projectRoot,
                encoding: 'utf-8',
                timeout: 5000,
            }
        );

        if (probe.status === 0 && probe.stdout.trim() === 'mlx') {
            return 'mlx';
        }
    } catch {
        // Ignore probe failures and use conservative fallback.
    }

    return 'pytorch';
}

export function runTTS(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
    onProgress: (info: ProgressInfo) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const projectRoot = path.resolve(import.meta.dirname, '../../..');
        const pythonScript = path.join(projectRoot, 'app.py');
        const venvPython = path.join(projectRoot, '.venv', 'bin', 'python');
        const backendForEnv = resolveBackendForEnv(config, projectRoot, venvPython);

        const args = [
            pythonScript,
            '--input', inputPath,
            '--output', outputPath,
            '--voice', config.voice,
            '--speed', config.speed.toString(),
            '--lang_code', config.langCode,
            '--chunk_chars', config.chunkChars.toString(),
            '--workers', (config.workers || 2).toString(),
            '--backend', config.backend || 'auto',
            '--format', config.outputFormat || 'mp3',
            '--bitrate', config.bitrate || '192k',
            ...(config.normalize ? ['--normalize'] : []),
            ...(config.metadataTitle ? ['--title', config.metadataTitle] : []),
            ...(config.metadataAuthor ? ['--author', config.metadataAuthor] : []),
            ...(config.metadataCover ? ['--cover', config.metadataCover] : []),
            ...(config.checkpointEnabled ? ['--checkpoint'] : []),
            ...(config.resume ? ['--resume'] : []),
            ...(config.noCheckpoint ? ['--no_checkpoint'] : []),
            '--no_rich',
        ];

        const isPyTorchBackend = backendForEnv === 'pytorch';
        const mpsEnvVars = isPyTorchBackend && config.useMPS ? {
            PYTORCH_ENABLE_MPS_FALLBACK: '1',
            PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
            OMP_NUM_THREADS: '4',
            OPENBLAS_NUM_THREADS: '2',
        } : {};

        const process = spawn(venvPython, args, {
            cwd: projectRoot,
            env: {
                ...globalThis.process.env,
                PYTHONUNBUFFERED: '1',
                ...mpsEnvVars,
            },
        });

        const parserState = createParserState();
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let stderrTail = '';
        const MAX_STDERR = 10000;

        const emitParsedLine = (line: string) => {
            const update = parseOutputLine(line, parserState);
            if (update) {
                onProgress(update);
            }
        };

        process.stdout.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                emitParsedLine(line);
            }
        });

        process.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderrTail += chunk;
            if (stderrTail.length > MAX_STDERR) {
                stderrTail = stderrTail.slice(-MAX_STDERR);
            }

            stderrBuffer += chunk;
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop() || '';
            for (const line of lines) {
                emitParsedLine(line);
            }
        });

        process.on('error', (err) => {
            reject(new Error(`Failed to start Python process: ${err.message}`));
        });

        process.on('close', (code) => {
            if (stdoutBuffer.trim()) {
                emitParsedLine(stdoutBuffer.trim());
            }
            if (stderrBuffer.trim()) {
                emitParsedLine(stderrBuffer.trim());
            }

            if (code === 0) {
                onProgress({
                    progress: 100,
                    currentChunk: parserState.lastTotal,
                    totalChunks: parserState.lastTotal,
                    phase: 'DONE',
                    totalChars: parserState.lastTotalChars,
                    chapterCount: parserState.lastChapterCount,
                    backendResolved: parserState.lastBackendResolved,
                });
                resolve();
            } else {
                reject(new Error(`Python process exited with code ${code}\n${stderrTail}`));
            }
        });
    });
}
