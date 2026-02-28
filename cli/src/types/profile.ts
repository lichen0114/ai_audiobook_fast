export type AccentCode = 'a' | 'b';
export type BackendOption = 'auto' | 'pytorch' | 'mlx' | 'mock';
export type OutputFormat = 'mp3' | 'm4b';
export type Bitrate = '128k' | '192k' | '320k';
export type PipelineModeOption = 'auto' | 'sequential' | 'overlap3';
export type RecoveryMode = 'off' | 'apple-balanced';

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
    pipelineMode?: PipelineModeOption;
    recoveryMode?: RecoveryMode;
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
