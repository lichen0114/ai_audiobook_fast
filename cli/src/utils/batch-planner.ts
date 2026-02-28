import { spawn } from 'child_process';
import * as path from 'path';

import { resolvePythonRuntime } from './python-runtime.js';
import type {
    BatchJobPlan,
    BatchPlan,
    CheckpointAction,
    OutputFormat,
    TTSConfig,
} from '../types/profile.js';

interface InspectionEvent {
    type: string;
    result?: InspectionPayload;
    message?: string;
}

interface InspectionPayload {
    input_path: string;
    output_path: string;
    resolved_backend: TTSConfig['backend'];
    resolved_chunk_chars: number;
    resolved_pipeline_mode: NonNullable<TTSConfig['pipelineMode']>;
    output_format: OutputFormat;
    total_chars: number;
    total_chunks: number;
    chapter_count: number;
    epub_metadata: {
        title: string;
        author: string;
        has_cover: boolean;
    };
    checkpoint: {
        exists: boolean;
        resume_compatible: boolean;
        total_chunks?: number;
        completed_chunks?: number;
        reason?: string;
        missing_audio_chunks?: number[];
    };
    warnings: string[];
    errors: string[];
}

export interface BatchPlanningProgress {
    current: number;
    total: number;
    inputPath: string;
}

function buildOutputPath(
    inputPath: string,
    outputFormat: OutputFormat,
    outputDir: string | null,
): string {
    const ext = outputFormat === 'm4b' ? '.m4b' : '.mp3';
    const baseName = path.basename(inputPath).replace(/\.epub$/i, ext);
    return outputDir
        ? path.join(outputDir, baseName)
        : inputPath.replace(/\.epub$/i, ext);
}

function buildExecutionConfig(
    baseConfig: TTSConfig,
    checkpointAction: CheckpointAction,
    keepMetadataOverrides: boolean,
): TTSConfig {
    const config: TTSConfig = {
        ...baseConfig,
        checkpointEnabled: baseConfig.checkpointEnabled,
        resume: checkpointAction === 'resume',
    };

    if (!keepMetadataOverrides || baseConfig.outputFormat !== 'm4b') {
        delete config.metadataTitle;
        delete config.metadataAuthor;
        delete config.metadataCover;
    }

    return config;
}

function chooseCheckpointAction(
    inspection: InspectionPayload['checkpoint'],
    checkpointEnabled: boolean,
): CheckpointAction {
    if (!checkpointEnabled) {
        return 'ignore';
    }

    if (inspection.resume_compatible && (inspection.completed_chunks ?? 0) > 0) {
        return 'resume';
    }

    if (inspection.exists) {
        return 'start-fresh';
    }

    return 'ignore';
}

function buildInspectArgs(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
): string[] {
    return [
        '--input', inputPath,
        '--output', outputPath,
        '--voice', config.voice,
        '--speed', config.speed.toString(),
        '--lang_code', config.langCode,
        '--chunk_chars', config.chunkChars.toString(),
        '--workers', String(config.workers || 1),
        '--backend', config.backend || 'auto',
        '--format', config.outputFormat || 'mp3',
        '--bitrate', config.bitrate || '192k',
        ...(config.normalize ? ['--normalize'] : []),
        ...(config.checkpointEnabled ? ['--checkpoint'] : []),
        ...(config.pipelineMode && config.pipelineMode !== 'auto' ? ['--pipeline_mode', config.pipelineMode] : []),
        ...(config.metadataTitle ? ['--title', config.metadataTitle] : []),
        ...(config.metadataAuthor ? ['--author', config.metadataAuthor] : []),
        ...(config.metadataCover ? ['--cover', config.metadataCover] : []),
        '--inspect_job',
        '--event_format', 'json',
        '--no_rich',
    ];
}

export function inspectJob(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
): Promise<InspectionPayload> {
    return new Promise((resolve, reject) => {
        const { projectRoot, appPath: pythonScript, pythonPath } = resolvePythonRuntime();
        const child = spawn(
            pythonPath,
            [pythonScript, ...buildInspectArgs(inputPath, outputPath, config)],
            {
                cwd: projectRoot,
                env: {
                    ...globalThis.process.env,
                    PYTHONUNBUFFERED: '1',
                },
            },
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        child.on('error', (error) => {
            reject(new Error(`Failed to inspect job: ${error.message}`));
        });

        child.on('close', (code) => {
            const lines = stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as InspectionEvent;
                    if (event.type === 'inspection' && event.result) {
                        resolve(event.result);
                        return;
                    }
                } catch {
                    // Ignore non-JSON log lines from the Python side.
                }
            }

            const message = stderr.trim() || stdout.trim() || `Inspection failed with code ${code}`;
            reject(new Error(message));
        });
    });
}

export async function planBatchJobs(
    inputPaths: string[],
    baseConfig: TTSConfig,
    onProgress?: (progress: BatchPlanningProgress) => void,
): Promise<BatchPlan> {
    const keepMetadataOverrides = inputPaths.length === 1;
    const outputPaths = inputPaths.map((inputPath) => buildOutputPath(
        inputPath,
        baseConfig.outputFormat,
        baseConfig.outputDir,
    ));
    const outputPathCounts = new Map<string, number>();
    for (const outputPath of outputPaths) {
        outputPathCounts.set(outputPath, (outputPathCounts.get(outputPath) ?? 0) + 1);
    }

    const jobs: BatchJobPlan[] = [];

    for (const [index, inputPath] of inputPaths.entries()) {
        const outputPath = outputPaths[index];
        onProgress?.({
            current: index + 1,
            total: inputPaths.length,
            inputPath,
        });

        try {
            const inspection = await inspectJob(
                inputPath,
                outputPath,
                buildExecutionConfig(baseConfig, 'ignore', keepMetadataOverrides),
            );
            const checkpointAction = chooseCheckpointAction(
                inspection.checkpoint,
                baseConfig.checkpointEnabled,
            );
            const warnings = [...inspection.warnings];
            const errors = [...inspection.errors];
            const blocked = (outputPathCounts.get(outputPath) ?? 0) > 1;

            if (inspection.checkpoint.exists && checkpointAction === 'start-fresh') {
                warnings.push(
                    `Existing checkpoint will be deleted before starting fresh (${inspection.checkpoint.reason ?? 'not resumable'}).`,
                );
            }

            if (blocked) {
                errors.push('Output path collides with another selected file.');
            }

            jobs.push({
                id: `job-${index}`,
                inputPath,
                outputPath,
                format: inspection.output_format,
                config: buildExecutionConfig(baseConfig, checkpointAction, keepMetadataOverrides),
                metadata: {
                    title: inspection.epub_metadata.title,
                    author: inspection.epub_metadata.author,
                    hasCover: inspection.epub_metadata.has_cover,
                },
                checkpoint: {
                    exists: inspection.checkpoint.exists,
                    resumeCompatible: inspection.checkpoint.resume_compatible,
                    completedChunks: inspection.checkpoint.completed_chunks,
                    totalChunks: inspection.checkpoint.total_chunks,
                    reason: inspection.checkpoint.reason,
                    missingAudioChunks: inspection.checkpoint.missing_audio_chunks,
                    action: checkpointAction,
                },
                estimate: {
                    totalChars: inspection.total_chars,
                    totalChunks: inspection.total_chunks,
                    chapterCount: inspection.chapter_count,
                },
                warnings,
                errors,
                blocked,
            });
        } catch (error) {
            jobs.push({
                id: `job-${index}`,
                inputPath,
                outputPath,
                format: baseConfig.outputFormat,
                config: buildExecutionConfig(baseConfig, 'ignore', keepMetadataOverrides),
                metadata: {
                    title: path.basename(inputPath),
                    author: 'Unknown Author',
                    hasCover: false,
                },
                checkpoint: {
                    exists: false,
                    resumeCompatible: false,
                    action: 'ignore',
                },
                estimate: {
                    totalChars: 0,
                    totalChunks: 0,
                    chapterCount: 0,
                },
                warnings: [],
                errors: [error instanceof Error ? error.message : 'Failed to inspect file'],
            });
        }
    }

    return {
        jobs,
        totalChars: jobs.reduce((sum, job) => sum + job.estimate.totalChars, 0),
        totalChunks: jobs.reduce((sum, job) => sum + job.estimate.totalChunks, 0),
        resumableJobs: jobs.filter((job) => job.checkpoint.action === 'resume').length,
        warningCount: jobs.reduce((sum, job) => sum + job.warnings.length, 0),
        blockedJobs: jobs.filter((job) => job.blocked).length,
    };
}
