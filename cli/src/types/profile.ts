export type AccentCode = 'a' | 'b';
export type BackendOption = 'auto' | 'pytorch' | 'mlx' | 'mock';
export type OutputFormat = 'mp3' | 'm4b';
export type Bitrate = '128k' | '192k' | '320k';

export interface TTSConfig {
    voice: string;
    speed: number;
    langCode: AccentCode;
    chunkChars: number;
    useMPS: boolean;
    outputDir: string | null;
    workers: number;
    backend: BackendOption;
    outputFormat: OutputFormat;
    bitrate: Bitrate;
    normalize: boolean;
    checkpointEnabled: boolean;
    metadataTitle?: string;
    metadataAuthor?: string;
    metadataCover?: string;
    resume?: boolean;
    noCheckpoint?: boolean;
}

export interface FileJob {
    id: string;
    inputPath: string;
    outputPath: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    progress: number;
    currentChunk?: number;
    totalChunks?: number;
    error?: string;
    outputSize?: number;
    processingTime?: number;
    totalChars?: number;
    avgChunkTimeMs?: number;
    startTime?: number;
}

export interface RuntimeProfile {
    eventFormat: 'text' | 'json';
    logFile?: string;
    noRich: boolean;
}

export interface MetadataProfile {
    strategy: 'auto' | 'override';
    title?: string;
    author?: string;
    cover?: string;
}

export interface RunProfile {
    profileVersion: 1;
    name?: string;
    inputs: string[];
    config: TTSConfig;
    metadata: MetadataProfile;
    runtime: RuntimeProfile;
}

export type ProfileValidationResult =
    | { ok: true; value: RunProfile }
    | { ok: false; error: string };

const AUTO_CHUNK_CHARS =
    process.platform === 'darwin' && process.arch === 'arm64' ? 900 : 600;

export function createDefaultConfig(): TTSConfig {
    return {
        voice: 'af_heart',
        speed: 1.0,
        langCode: 'a',
        chunkChars: AUTO_CHUNK_CHARS,
        useMPS: true,
        outputDir: null,
        workers: 1,
        backend: 'auto',
        outputFormat: 'mp3',
        bitrate: '192k',
        normalize: false,
        checkpointEnabled: false,
    };
}

export function createDefaultProfile(): RunProfile {
    return {
        profileVersion: 1,
        inputs: [],
        config: createDefaultConfig(),
        metadata: {
            strategy: 'auto',
        },
        runtime: {
            eventFormat: 'json',
            noRich: true,
        },
    };
}

function isBackendOption(value: unknown): value is BackendOption {
    return value === 'auto' || value === 'pytorch' || value === 'mlx' || value === 'mock';
}

function isOutputFormat(value: unknown): value is OutputFormat {
    return value === 'mp3' || value === 'm4b';
}

function isBitrate(value: unknown): value is Bitrate {
    return value === '128k' || value === '192k' || value === '320k';
}

export function validateProfile(input: unknown): ProfileValidationResult {
    if (!input || typeof input !== 'object') {
        return { ok: false as const, error: 'Profile must be an object' };
    }

    const candidate = input as Partial<RunProfile> & { config?: Partial<TTSConfig> };

    if (candidate.profileVersion !== 1) {
        return { ok: false as const, error: 'Unsupported profileVersion. Expected 1.' };
    }

    if (!Array.isArray(candidate.inputs) || candidate.inputs.some((item) => typeof item !== 'string')) {
        return { ok: false as const, error: 'inputs must be an array of strings' };
    }

    if (!candidate.config || typeof candidate.config !== 'object') {
        return { ok: false as const, error: 'config is required' };
    }

    const cfg = candidate.config;

    if (typeof cfg.voice !== 'string' || cfg.voice.length === 0) {
        return { ok: false as const, error: 'config.voice must be a non-empty string' };
    }

    if (cfg.langCode !== 'a' && cfg.langCode !== 'b') {
        return { ok: false as const, error: 'config.langCode must be "a" or "b"' };
    }

    if (typeof cfg.speed !== 'number' || Number.isNaN(cfg.speed) || cfg.speed <= 0) {
        return { ok: false as const, error: 'config.speed must be a positive number' };
    }

    if (typeof cfg.chunkChars !== 'number' || Number.isNaN(cfg.chunkChars) || cfg.chunkChars < 100) {
        return { ok: false as const, error: 'config.chunkChars must be a number >= 100' };
    }

    if (typeof cfg.useMPS !== 'boolean') {
        return { ok: false as const, error: 'config.useMPS must be a boolean' };
    }

    if (cfg.outputDir !== null && cfg.outputDir !== undefined && typeof cfg.outputDir !== 'string') {
        return { ok: false as const, error: 'config.outputDir must be a string or null' };
    }

    if (typeof cfg.workers !== 'number' || Number.isNaN(cfg.workers) || cfg.workers < 1) {
        return { ok: false as const, error: 'config.workers must be a number >= 1' };
    }

    if (!isBackendOption(cfg.backend)) {
        return { ok: false as const, error: 'config.backend must be one of auto/pytorch/mlx/mock' };
    }

    if (!isOutputFormat(cfg.outputFormat)) {
        return { ok: false as const, error: 'config.outputFormat must be mp3 or m4b' };
    }

    if (!isBitrate(cfg.bitrate)) {
        return { ok: false as const, error: 'config.bitrate must be 128k, 192k, or 320k' };
    }

    if (typeof cfg.normalize !== 'boolean') {
        return { ok: false as const, error: 'config.normalize must be a boolean' };
    }

    if (typeof cfg.checkpointEnabled !== 'boolean') {
        return { ok: false as const, error: 'config.checkpointEnabled must be a boolean' };
    }

    const metadata = candidate.metadata;
    if (!metadata || typeof metadata !== 'object') {
        return { ok: false as const, error: 'metadata is required' };
    }

    if (metadata.strategy !== 'auto' && metadata.strategy !== 'override') {
        return { ok: false as const, error: 'metadata.strategy must be auto or override' };
    }

    const runtime = candidate.runtime;
    if (!runtime || typeof runtime !== 'object') {
        return { ok: false as const, error: 'runtime is required' };
    }

    if (runtime.eventFormat !== 'text' && runtime.eventFormat !== 'json') {
        return { ok: false as const, error: 'runtime.eventFormat must be text or json' };
    }

    if (typeof runtime.noRich !== 'boolean') {
        return { ok: false as const, error: 'runtime.noRich must be a boolean' };
    }

    return { ok: true as const, value: candidate as RunProfile };
}
