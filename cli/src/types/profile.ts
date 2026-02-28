export type AccentCode = 'a' | 'b';
export type BackendOption = 'auto' | 'pytorch' | 'mlx' | 'mock';
export type OutputFormat = 'mp3' | 'm4b';
export type Bitrate = '128k' | '192k' | '320k';
export type PipelineModeOption = 'auto' | 'sequential' | 'overlap3';
export type RecoveryMode = 'off' | 'apple-balanced';
export type JobStatus = 'pending' | 'ready' | 'processing' | 'done' | 'error' | 'skipped';
export type CheckpointAction = 'resume' | 'start-fresh' | 'ignore';

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
    status: JobStatus;
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

export interface BatchJobMetadata {
    title: string;
    author: string;
    hasCover: boolean;
}

export interface BatchCheckpointPlan {
    exists: boolean;
    resumeCompatible: boolean;
    completedChunks?: number;
    totalChunks?: number;
    reason?: string;
    missingAudioChunks?: number[];
    action: CheckpointAction;
}

export interface BatchJobEstimate {
    totalChars: number;
    totalChunks: number;
    chapterCount: number;
}

export interface BatchJobPlan {
    id: string;
    inputPath: string;
    outputPath: string;
    format: OutputFormat;
    config: TTSConfig;
    metadata: BatchJobMetadata;
    checkpoint: BatchCheckpointPlan;
    estimate: BatchJobEstimate;
    warnings: string[];
    errors: string[];
    blocked?: boolean;
}

export interface BatchPlan {
    jobs: BatchJobPlan[];
    totalChars: number;
    totalChunks: number;
    resumableJobs: number;
    warningCount: number;
    blockedJobs: number;
}
