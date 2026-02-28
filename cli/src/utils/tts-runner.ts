import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PipelineModeOption, RecoveryMode, TTSConfig } from '../types/profile.js';
import { resolvePythonRuntime } from './python-runtime.js';

export interface WorkerStatus {
    id: number;
    status: 'IDLE' | 'INFER' | 'ENCODE';
    details: string;
}

export type ProcessingPhase = 'PARSING' | 'INFERENCE' | 'CONCATENATING' | 'EXPORTING' | 'DONE';
export type ResolvedBackend = 'pytorch' | 'mlx' | 'mock';
export type EffectivePipelineMode = Exclude<PipelineModeOption, 'auto'>;

export interface RecoveryInfo {
    attempt: number;
    maxAttempts: number;
    reason: string;
    backend: TTSConfig['backend'];
    useMPS: boolean;
    pipelineMode: EffectivePipelineMode;
    chunkChars: number;
    workers: number;
}

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
    parseCurrentItem?: number;
    parseTotalItems?: number;
    parseChapterCount?: number;
    recovery?: RecoveryInfo;
}

export interface ParserState {
    lastProgress: number;
    lastCurrentChunk: number;
    lastTotal: number;
    lastPhase?: ProcessingPhase;
    lastTotalChars?: number;
    lastChapterCount?: number;
    lastBackendResolved?: ResolvedBackend;
    lastParseCurrentItem?: number;
    lastParseTotalItems?: number;
    lastParseChapterCount?: number;
}

interface JsonEvent {
    type: string;
    phase?: string;
    key?: string;
    value?: string | number | boolean;
    chunk_timing_ms?: number;
    stage?: string;
    heartbeat_ts?: number;
    id?: number;
    status?: string;
    details?: string;
    current_chunk?: number;
    total_chunks?: number;
    current_item?: number;
    total_items?: number;
    current_chapter_count?: number;
    attempt?: number;
    max_attempts?: number;
    reason?: string;
    backend?: TTSConfig['backend'];
    use_mps?: boolean;
    pipeline_mode?: EffectivePipelineMode;
    chunk_chars?: number;
    workers?: number;
}

const DEFAULT_PIPELINE_MODE: PipelineModeOption = 'auto';
const DEFAULT_WORKERS = 1;
const MAX_APPLE_RECOVERY_ATTEMPTS = 2;
const RECOVERABLE_APPLE_FAILURE_MARKERS = [
    'out of memory',
    'mps',
    'metal',
    'mlx',
    'killed',
    'abort trap',
    'segmentation fault',
    'bus error',
    'broken pipe',
    'terminated',
    'signal',
];
const NON_RECOVERABLE_FAILURE_MARKERS = [
    'input epub not found',
    'file not found',
    'filenotfounderror',
    'permission denied',
    'ffmpeg not found',
    'ffprobe not found',
    'invalid epub',
    'no readable text',
    'no text chunks',
    'python version',
    'voice',
];

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

function buildProgressInfo(
    state: ParserState,
    overrides: Partial<ProgressInfo> = {},
): ProgressInfo {
    return {
        progress: state.lastProgress,
        currentChunk: state.lastCurrentChunk,
        totalChunks: state.lastTotal,
        phase: state.lastPhase,
        totalChars: state.lastTotalChars,
        chapterCount: state.lastChapterCount,
        backendResolved: state.lastBackendResolved,
        parseCurrentItem: state.lastParseCurrentItem,
        parseTotalItems: state.lastParseTotalItems,
        parseChapterCount: state.lastParseChapterCount,
        ...overrides,
    };
}

export function parseOutputLine(line: string, state: ParserState): ProgressInfo | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const event = JSON.parse(trimmed) as JsonEvent;

            if (event.type === 'phase' && typeof event.phase === 'string' && isProcessingPhase(event.phase)) {
                state.lastPhase = event.phase;
                return buildProgressInfo(state, { phase: event.phase });
            }

            if (event.type === 'metadata' && typeof event.key === 'string') {
                if (
                    event.key === 'backend_resolved'
                    && (event.value === 'pytorch' || event.value === 'mlx' || event.value === 'mock')
                ) {
                    state.lastBackendResolved = event.value;
                } else if (event.key === 'total_chars' && typeof event.value === 'number') {
                    state.lastTotalChars = event.value;
                } else if (event.key === 'chapter_count' && typeof event.value === 'number') {
                    state.lastChapterCount = event.value;
                } else {
                    return null;
                }

                return buildProgressInfo(state);
            }

            if (
                event.type === 'parse_progress'
                && typeof event.current_item === 'number'
                && typeof event.total_items === 'number'
                && event.total_items > 0
                && typeof event.current_chapter_count === 'number'
            ) {
                state.lastParseCurrentItem = event.current_item;
                state.lastParseTotalItems = event.total_items;
                state.lastParseChapterCount = event.current_chapter_count;
                return buildProgressInfo(state);
            }

            if (event.type === 'timing' && typeof event.chunk_timing_ms === 'number') {
                return buildProgressInfo(state, { chunkTimingMs: event.chunk_timing_ms });
            }

            if (event.type === 'heartbeat' && typeof event.heartbeat_ts === 'number') {
                return buildProgressInfo(state, { heartbeatTs: event.heartbeat_ts });
            }

            if (
                event.type === 'worker'
                && typeof event.id === 'number'
                && (event.status === 'IDLE' || event.status === 'INFER' || event.status === 'ENCODE')
            ) {
                return buildProgressInfo(state, {
                    workerStatus: {
                        id: event.id,
                        status: event.status,
                        details: event.details ?? '',
                    },
                });
            }

            if (
                event.type === 'progress'
                && typeof event.current_chunk === 'number'
                && typeof event.total_chunks === 'number'
                && event.total_chunks > 0
            ) {
                const progress = Math.round((event.current_chunk / event.total_chunks) * 100);
                state.lastProgress = progress;
                state.lastCurrentChunk = event.current_chunk;
                state.lastTotal = event.total_chunks;

                return buildProgressInfo(state, {
                    progress,
                    currentChunk: event.current_chunk,
                    totalChunks: event.total_chunks,
                });
            }

            if (
                event.type === 'recovery'
                && typeof event.attempt === 'number'
                && typeof event.max_attempts === 'number'
                && typeof event.reason === 'string'
                && typeof event.backend === 'string'
                && typeof event.use_mps === 'boolean'
                && typeof event.pipeline_mode === 'string'
                && typeof event.chunk_chars === 'number'
                && typeof event.workers === 'number'
            ) {
                return buildProgressInfo(state, {
                    recovery: {
                        attempt: event.attempt,
                        maxAttempts: event.max_attempts,
                        reason: event.reason,
                        backend: event.backend,
                        useMPS: event.use_mps,
                        pipelineMode: event.pipeline_mode,
                        chunkChars: event.chunk_chars,
                        workers: event.workers,
                    },
                });
            }
        } catch {
            // Fall back to legacy parser below.
        }
    }

    if (trimmed.startsWith('PHASE:')) {
        const phase = trimmed.slice(6);
        if (!isProcessingPhase(phase)) {
            return null;
        }
        state.lastPhase = phase;
        return buildProgressInfo(state, { phase });
    }

    if (trimmed.startsWith('METADATA:backend_resolved:')) {
        const backendResolved = trimmed.slice(26);
        if (backendResolved === 'pytorch' || backendResolved === 'mlx' || backendResolved === 'mock') {
            state.lastBackendResolved = backendResolved;
            return buildProgressInfo(state, { backendResolved });
        }
        return null;
    }

    if (trimmed.startsWith('METADATA:total_chars:')) {
        const totalChars = parseInt(trimmed.slice(21), 10);
        if (Number.isNaN(totalChars)) {
            return null;
        }
        state.lastTotalChars = totalChars;
        return buildProgressInfo(state, { totalChars });
    }

    if (trimmed.startsWith('METADATA:chapter_count:')) {
        const chapterCount = parseInt(trimmed.slice(23), 10);
        if (Number.isNaN(chapterCount)) {
            return null;
        }
        state.lastChapterCount = chapterCount;
        return buildProgressInfo(state, { chapterCount });
    }

    if (trimmed.startsWith('PARSE_PROGRESS:')) {
        const match = trimmed.match(/^PARSE_PROGRESS:(\d+)\/(\d+):(\d+)$/);
        if (!match) {
            return null;
        }
        const currentItem = parseInt(match[1], 10);
        const totalItems = parseInt(match[2], 10);
        const currentChapterCount = parseInt(match[3], 10);
        if (
            Number.isNaN(currentItem)
            || Number.isNaN(totalItems)
            || Number.isNaN(currentChapterCount)
            || totalItems <= 0
        ) {
            return null;
        }
        state.lastParseCurrentItem = currentItem;
        state.lastParseTotalItems = totalItems;
        state.lastParseChapterCount = currentChapterCount;
        return buildProgressInfo(state);
    }

    if (trimmed.startsWith('TIMING:')) {
        const parts = trimmed.slice(7).split(':');
        if (parts.length >= 2) {
            const chunkTimingMs = parseInt(parts[1], 10);
            if (!Number.isNaN(chunkTimingMs)) {
                return buildProgressInfo(state, { chunkTimingMs });
            }
        }
        return null;
    }

    if (trimmed.startsWith('HEARTBEAT:')) {
        const heartbeatTs = parseInt(trimmed.slice(10), 10);
        if (Number.isNaN(heartbeatTs)) {
            return null;
        }
        return buildProgressInfo(state, { heartbeatTs });
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
                return buildProgressInfo(state, {
                    workerStatus: { id, status, details: parts.slice(3).join(':') },
                });
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

        return buildProgressInfo(state, {
            progress,
            currentChunk: current,
            totalChunks: total,
        });
    }

    return null;
}

function parsePositiveInt(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return undefined;
    }
    return parsed;
}

function isAppleSiliconHost(): boolean {
    return process.env.AUDIOBOOK_FORCE_APPLE_SILICON === '1'
        || (process.platform === 'darwin' && process.arch === 'arm64');
}

function getDefaultRecoveryMode(): RecoveryMode {
    return isAppleSiliconHost() ? 'apple-balanced' : 'off';
}

function resolveThreadEnvOverrides(): { ompThreads: string; openBlasThreads: string } {
    const cpuCount = Math.max(1, os.cpus().length || 1);
    const defaultOmp = Math.min(Math.max(4, Math.floor(cpuCount * 0.5)), 8);
    const defaultOpenBlas = Math.min(Math.max(1, Math.floor(defaultOmp / 2)), 4);

    const ompOverride = parsePositiveInt(process.env.AUDIOBOOK_OMP_THREADS);
    const openBlasOverride = parsePositiveInt(process.env.AUDIOBOOK_OPENBLAS_THREADS);

    return {
        ompThreads: String(ompOverride ?? defaultOmp),
        openBlasThreads: String(openBlasOverride ?? defaultOpenBlas),
    };
}

class PythonProcessError extends Error {
    code: number | null;
    signal: NodeJS.Signals | null;

    constructor(code: number | null, signal: NodeJS.Signals | null, stderrTail: string, logFile: string) {
        const signalSuffix = signal ? ` (signal: ${signal})` : '';
        super(`Python process exited with code ${code ?? 'null'}${signalSuffix}\n${stderrTail}\nLog file: ${logFile}`);
        this.name = 'PythonProcessError';
        this.code = code;
        this.signal = signal;
    }
}

function withInternalDefaults(config: TTSConfig): TTSConfig {
    return {
        ...config,
        workers: config.workers || DEFAULT_WORKERS,
        pipelineMode: config.pipelineMode ?? DEFAULT_PIPELINE_MODE,
        recoveryMode: config.recoveryMode ?? getDefaultRecoveryMode(),
    };
}

function isAppleSiliconRecoveryEnabled(config: TTSConfig): boolean {
    return (
        isAppleSiliconHost()
        && config.recoveryMode !== 'off'
        && config.backend !== 'mock'
    );
}

function buildRecoveryInfo(config: TTSConfig, attempt: number, reason: string): RecoveryInfo {
    return {
        attempt,
        maxAttempts: MAX_APPLE_RECOVERY_ATTEMPTS,
        reason,
        backend: config.backend,
        useMPS: config.useMPS,
        pipelineMode: (config.pipelineMode === 'overlap3' ? 'overlap3' : 'sequential'),
        chunkChars: config.chunkChars,
        workers: config.workers || DEFAULT_WORKERS,
    };
}

function createAppleSafeFallbackConfig(config: TTSConfig): TTSConfig {
    const fallbackChunkChars = config.backend === 'pytorch'
        ? Math.min(config.chunkChars, 400)
        : Math.min(config.chunkChars, 600);

    return {
        ...config,
        backend: 'pytorch',
        useMPS: false,
        workers: DEFAULT_WORKERS,
        pipelineMode: 'sequential',
        chunkChars: fallbackChunkChars,
    };
}

function executionProfileMatches(a: TTSConfig, b: TTSConfig): boolean {
    return (
        a.backend === b.backend
        && a.useMPS === b.useMPS
        && (a.workers || DEFAULT_WORKERS) === (b.workers || DEFAULT_WORKERS)
        && (a.pipelineMode ?? DEFAULT_PIPELINE_MODE) === (b.pipelineMode ?? DEFAULT_PIPELINE_MODE)
        && a.chunkChars === b.chunkChars
    );
}

function describeRecoveryReason(error: PythonProcessError): string {
    const errorLower = error.message.toLowerCase();

    if (error.signal) {
        return `backend exited via ${error.signal.toLowerCase()}`;
    }
    if (errorLower.includes('out of memory')) {
        return 'apple runtime reported out-of-memory';
    }
    if (errorLower.includes('metal') || errorLower.includes('mps')) {
        return 'apple gpu runtime became unstable';
    }
    if (errorLower.includes('mlx')) {
        return 'mlx backend crashed';
    }
    return 'native backend crashed on Apple Silicon';
}

function isRecoverableAppleFailure(error: PythonProcessError): boolean {
    const errorLower = error.message.toLowerCase();

    if (NON_RECOVERABLE_FAILURE_MARKERS.some((marker) => errorLower.includes(marker))) {
        return false;
    }

    if (error.signal) {
        return true;
    }

    return RECOVERABLE_APPLE_FAILURE_MARKERS.some((marker) => errorLower.includes(marker));
}

function shouldRetryWithAppleFallback(error: unknown, currentConfig: TTSConfig, attempt: number): boolean {
    if (!(error instanceof PythonProcessError)) {
        return false;
    }
    if (attempt >= MAX_APPLE_RECOVERY_ATTEMPTS || !isAppleSiliconRecoveryEnabled(currentConfig)) {
        return false;
    }

    const fallbackConfig = createAppleSafeFallbackConfig(currentConfig);
    if (executionProfileMatches(currentConfig, fallbackConfig)) {
        return false;
    }

    return isRecoverableAppleFailure(error);
}

function getRunLogPath(projectRoot: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const homeBaseDir = path.join(os.homedir(), '.audiobook-maker', 'logs');
    try {
        fs.mkdirSync(homeBaseDir, { recursive: true });
        return path.join(homeBaseDir, `run-${timestamp}.log`);
    } catch {
        const localBaseDir = path.join(projectRoot, '.logs');
        fs.mkdirSync(localBaseDir, { recursive: true });
        return path.join(localBaseDir, `run-${timestamp}.log`);
    }
}

function runTTSAttempt(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
    onProgress: (info: ProgressInfo) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        const { projectRoot, appPath: pythonScript, pythonPath } = resolvePythonRuntime();
        const logFile = getRunLogPath(projectRoot);
        const verbose = process.env.AUDIOBOOK_VERBOSE === '1' || process.env.AUDIOBOOK_VERBOSE === 'true';

        const args = [
            pythonScript,
            '--input', inputPath,
            '--output', outputPath,
            '--voice', config.voice,
            '--speed', config.speed.toString(),
            '--lang_code', config.langCode,
            '--chunk_chars', config.chunkChars.toString(),
            '--workers', (config.workers || DEFAULT_WORKERS).toString(),
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
            ...(config.pipelineMode && config.pipelineMode !== 'auto' ? ['--pipeline_mode', config.pipelineMode] : []),
            '--event_format', 'json',
            '--log_file', logFile,
            '--no_rich',
        ];

        const { ompThreads, openBlasThreads } = resolveThreadEnvOverrides();
        const shouldSetPytorchMpsEnv = config.useMPS && config.backend !== 'mlx' && config.backend !== 'mock';
        const mpsEnvVars = shouldSetPytorchMpsEnv ? {
            PYTORCH_ENABLE_MPS_FALLBACK: '1',
            PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
            OMP_NUM_THREADS: ompThreads,
            OPENBLAS_NUM_THREADS: openBlasThreads,
        } : {};

        const childProc = spawn(pythonPath, args, {
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

        childProc.stdout.on('data', (data: Buffer) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split('\n');
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                if (verbose && line.trim()) {
                    globalThis.process.stderr.write(`[py] ${line}\n`);
                }
                emitParsedLine(line);
            }
        });

        childProc.stderr.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderrTail += chunk;
            if (stderrTail.length > MAX_STDERR) {
                stderrTail = stderrTail.slice(-MAX_STDERR);
            }

            stderrBuffer += chunk;
            const lines = stderrBuffer.split('\n');
            stderrBuffer = lines.pop() || '';
            for (const line of lines) {
                if (verbose && line.trim()) {
                    globalThis.process.stderr.write(`[py:err] ${line}\n`);
                }
                emitParsedLine(line);
            }
        });

        childProc.on('error', (err) => {
            reject(new Error(`Failed to start Python process: ${err.message}\nLog file: ${logFile}`));
        });

        childProc.on('close', (code, signal) => {
            if (stdoutBuffer.trim()) {
                emitParsedLine(stdoutBuffer.trim());
            }
            if (stderrBuffer.trim()) {
                emitParsedLine(stderrBuffer.trim());
            }

            if (code === 0 && !signal) {
                onProgress({
                    progress: 100,
                    currentChunk: parserState.lastTotal,
                    totalChunks: parserState.lastTotal,
                    phase: 'DONE',
                    totalChars: parserState.lastTotalChars,
                    chapterCount: parserState.lastChapterCount,
                    backendResolved: parserState.lastBackendResolved,
                    parseCurrentItem: parserState.lastParseCurrentItem,
                    parseTotalItems: parserState.lastParseTotalItems,
                    parseChapterCount: parserState.lastParseChapterCount,
                });
                resolve();
            } else {
                reject(new PythonProcessError(code, signal, stderrTail, logFile));
            }
        });
    });
}

export async function runTTS(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
    onProgress: (info: ProgressInfo) => void
): Promise<void> {
    const baseConfig = withInternalDefaults(config);
    let attemptConfig = baseConfig;

    for (let attempt = 1; attempt <= MAX_APPLE_RECOVERY_ATTEMPTS; attempt++) {
        try {
            await runTTSAttempt(inputPath, outputPath, attemptConfig, onProgress);
            return;
        } catch (error) {
            if (!shouldRetryWithAppleFallback(error, attemptConfig, attempt)) {
                throw error;
            }

            const fallbackConfig = createAppleSafeFallbackConfig(attemptConfig);
            onProgress({
                progress: 0,
                currentChunk: 0,
                totalChunks: 0,
                recovery: buildRecoveryInfo(fallbackConfig, attempt + 1, describeRecoveryReason(error)),
            });
            attemptConfig = fallbackConfig;
        }
    }
}
