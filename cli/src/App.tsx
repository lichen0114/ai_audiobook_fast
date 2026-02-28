import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { FileSelector } from './components/FileSelector.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { MetadataEditor, type BookMetadata } from './components/MetadataEditor.js';
import { BatchReview } from './components/BatchReview.js';
import { BatchProgress } from './components/BatchProgress.js';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { SetupRequired } from './components/SetupRequired.js';
import { KeyboardHint, DONE_HINTS, PROCESSING_HINTS } from './components/KeyboardHint.js';
import type { BatchPlan, FileJob, TTSConfig } from './types/profile.js';
import { runPreflightChecks, quickCheck, type PreflightCheck } from './utils/preflight.js';
import { extractMetadata } from './utils/metadata.js';
import { planBatchJobs, type BatchPlanningProgress } from './utils/batch-planner.js';
import { formatBytes, formatDuration } from './utils/format.js';
import { openFolder } from './utils/open-folder.js';
import * as fs from 'fs';
import * as path from 'path';

export type Screen = 'checking' | 'setup-required' | 'welcome' | 'files' | 'config' | 'metadata' | 'planning' | 'review' | 'processing' | 'done';

// Optimal chunk sizes per backend based on benchmarks
// MLX: 900 chars = 180 chars/s (+11% vs 1200)
// PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
const AUTO_CHUNK_CHARS =
    process.platform === 'darwin' && process.arch === 'arm64' ? 900 : 600;

const BACKEND_CHUNK_CHARS: Record<'auto' | 'pytorch' | 'mlx' | 'mock', number> = {
    auto: AUTO_CHUNK_CHARS,
    mlx: 900,
    pytorch: 600,
    mock: 600,
};

const defaultConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1.0,
    langCode: 'a',
    chunkChars: BACKEND_CHUNK_CHARS.auto,
    useMPS: true, // Enable Apple Silicon GPU acceleration by default
    outputDir: null,
    workers: 1, // Execution remains sequential; keep the compatibility flag at 1.
    backend: 'auto', // Default to auto backend selection
    outputFormat: 'mp3', // Default to MP3 format
    bitrate: '192k', // Default to 192k bitrate
    normalize: false, // Loudness normalization off by default
    checkpointEnabled: false, // Default off for stability/perf
};

export function App() {
    const { exit } = useApp();
    const [screen, setScreen] = useState<Screen>('checking');
    const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
    const [files, setFiles] = useState<FileJob[]>([]);
    const [config, setConfig] = useState<TTSConfig>(defaultConfig);
    const [totalTime, setTotalTime] = useState<number>(0);
    const [startTime, setStartTime] = useState<number>(0);
    const [bookMetadata, setBookMetadata] = useState<BookMetadata | null>(null);
    const [metadataLoading, setMetadataLoading] = useState(false);
    const [batchPlan, setBatchPlan] = useState<BatchPlan | null>(null);
    const [planningProgress, setPlanningProgress] = useState<BatchPlanningProgress | null>(null);
    const [planningError, setPlanningError] = useState<string | null>(null);

    // Run preflight checks on startup
    useEffect(() => {
        if (screen === 'checking') {
            // Quick check first (fast)
            if (quickCheck()) {
                // Quick check passed, do full check
                const result = runPreflightChecks();
                if (result.passed) {
                    setScreen('welcome');
                } else {
                    setPreflightChecks(result.checks);
                    setScreen('setup-required');
                }
            } else {
                // Quick check failed, do full check to get details
                const result = runPreflightChecks();
                setPreflightChecks(result.checks);
                setScreen('setup-required');
            }
        }
    }, [screen]);

    const handleRetryChecks = () => {
        setScreen('checking');
    };

    const outputDirectories = Array.from(
        new Set(
            files
                .filter((file) => file.status === 'done')
                .map((file) => path.dirname(file.outputPath)),
        ),
    );
    const doneHints = outputDirectories.length === 1
        ? DONE_HINTS
        : DONE_HINTS.filter((hint) => hint.key !== 'o');

    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
        }
        // Open output folder in Finder when pressing 'o' on done screen
        if (screen === 'done' && input === 'o' && outputDirectories.length === 1) {
            openFolder(outputDirectories[0]);
        }
        // Start new batch when pressing 'n' on done screen
        if (screen === 'done' && input === 'n') {
            setFiles([]);
            setBatchPlan(null);
            setPlanningError(null);
            setScreen('files');
        }
    });

    const handleFilesSelected = (selectedFiles: string[]) => {
        const ext = config.outputFormat === 'm4b' ? '.m4b' : '.mp3';
        const jobs: FileJob[] = selectedFiles.map((file, index) => ({
            id: `job-${index}`,
            inputPath: file,
            outputPath: file.replace(/\.epub$/i, ext),
            status: 'pending',
            progress: 0,
        }));
        setFiles(jobs);
        setScreen('config');
    };

    const buildFilesForConfig = (sourceFiles: FileJob[], nextConfig: TTSConfig): FileJob[] => {
        const ext = nextConfig.outputFormat === 'm4b' ? '.m4b' : '.mp3';
        return sourceFiles.map((file, index) => {
            const baseName = path.basename(file.inputPath).replace(/\.epub$/i, ext);
            const outputPath = nextConfig.outputDir
                ? path.join(nextConfig.outputDir, baseName)
                : file.inputPath.replace(/\.epub$/i, ext);
            return {
                ...file,
                id: `job-${index}`,
                outputPath,
                status: 'pending',
                progress: 0,
                error: undefined,
            };
        });
    };

    const normalizeBatchConfig = (nextConfig: TTSConfig, fileCount: number): TTSConfig => {
        const normalizedConfig: TTSConfig = {
            ...nextConfig,
            workers: 1,
        };

        if (fileCount !== 1 || normalizedConfig.outputFormat !== 'm4b') {
            delete normalizedConfig.metadataTitle;
            delete normalizedConfig.metadataAuthor;
            delete normalizedConfig.metadataCover;
        }

        return normalizedConfig;
    };

    const beginBatchPlanning = async (plannedFiles: FileJob[], nextConfig: TTSConfig) => {
        setPlanningError(null);
        setPlanningProgress({
            current: 0,
            total: plannedFiles.length,
            inputPath: '',
        });
        setScreen('planning');

        try {
            const plan = await planBatchJobs(
                plannedFiles.map((file) => file.inputPath),
                nextConfig,
                (progress) => setPlanningProgress(progress),
            );
            setBatchPlan(plan);
            setFiles(plan.jobs.map((job) => ({
                id: job.id,
                inputPath: job.inputPath,
                outputPath: job.outputPath,
                status: job.errors.length > 0 || job.blocked ? 'skipped' : 'ready',
                progress: 0,
                totalChars: job.estimate.totalChars,
                totalChunks: job.estimate.totalChunks,
                error: job.errors[0],
            })));
            setScreen('review');
        } catch (error) {
            setPlanningError(error instanceof Error ? error.message : 'Failed to plan batch');
            setScreen('config');
        }
    };

    const handleConfigConfirm = async (newConfig: TTSConfig) => {
        const normalizedConfig = normalizeBatchConfig(newConfig, files.length);
        const plannedFiles = buildFilesForConfig(files, normalizedConfig);
        setFiles(plannedFiles);
        setConfig(normalizedConfig);
        setBatchPlan(null);

        // For M4B format, show metadata editor before processing
        if (normalizedConfig.outputFormat === 'm4b' && plannedFiles.length === 1) {
            setMetadataLoading(true);
            try {
                const metadata = await extractMetadata(plannedFiles[0].inputPath);
                setBookMetadata({
                    title: metadata.title ?? '',
                    author: metadata.author ?? '',
                    hasCover: metadata.hasCover,
                    warning: undefined,
                });
                setMetadataLoading(false);
                setScreen('metadata');
            } catch {
                setBookMetadata({
                    title: '',
                    author: '',
                    hasCover: false,
                    warning: 'Metadata extraction failed. Leave fields blank to keep the EPUB metadata untouched, or enter explicit overrides.',
                });
                setMetadataLoading(false);
                setScreen('metadata');
            }
        } else {
            await beginBatchPlanning(plannedFiles, normalizedConfig);
        }
    };

    const handleMetadataConfirm = async (metadata: BookMetadata) => {
        const resolvedCoverPath = metadata.coverPath
            ? path.resolve(process.cwd(), metadata.coverPath)
            : undefined;
        const nextConfig: TTSConfig = {
            ...config,
        };

        if (metadata.titleOverride) {
            nextConfig.metadataTitle = metadata.titleOverride;
        } else {
            delete nextConfig.metadataTitle;
        }

        if (metadata.authorOverride) {
            nextConfig.metadataAuthor = metadata.authorOverride;
        } else {
            delete nextConfig.metadataAuthor;
        }

        if (resolvedCoverPath) {
            nextConfig.metadataCover = resolvedCoverPath;
        } else {
            delete nextConfig.metadataCover;
        }

        setConfig(nextConfig);
        await beginBatchPlanning(files, nextConfig);
    };

    const handleStartProcessing = () => {
        setStartTime(Date.now());
        setScreen('processing');
    };

    const handleStartFreshAll = () => {
        if (!batchPlan) {
            return;
        }
        const updatedJobs = batchPlan.jobs.map((job) => {
            if (job.checkpoint.action !== 'resume') {
                return job;
            }
            return {
                ...job,
                config: {
                    ...job.config,
                    resume: false,
                    checkpointEnabled: config.checkpointEnabled,
                },
                checkpoint: {
                    ...job.checkpoint,
                    action: job.checkpoint.exists ? 'start-fresh' as const : 'ignore' as const,
                },
            };
        });
        setBatchPlan({
            ...batchPlan,
            jobs: updatedJobs,
            resumableJobs: 0,
        });
    };

    const handleProcessingComplete = () => {
        setTotalTime(Date.now() - startTime);
        // Get output file sizes
        setFiles(prev => prev.map(file => {
            if (file.status === 'done' && fs.existsSync(file.outputPath)) {
                const stats = fs.statSync(file.outputPath);
                return { ...file, outputSize: stats.size };
            }
            return file;
        }));
        setScreen('done');
    };

    const completedFiles = files.filter(f => f.status === 'done');
    const errorFiles = files.filter(f => f.status === 'error');
    const skippedFiles = files.filter(f => f.status === 'skipped');
    const totalOutputSize = completedFiles.reduce((acc, f) => acc + (f.outputSize || 0), 0);
    const totalCharsProcessed = completedFiles.reduce((acc, f) => acc + (f.totalChars || 0), 0);
    const totalChunksProcessed = completedFiles.reduce((acc, f) => acc + (f.totalChunks || 0), 0);
    const avgChunkTimeOverall = completedFiles.length > 0
        ? completedFiles.reduce((acc, f) => acc + (f.avgChunkTimeMs || 0), 0) / completedFiles.length
        : 0;
    const processingSpeed = totalTime > 0 && totalCharsProcessed > 0
        ? Math.round(totalCharsProcessed / (totalTime / 1000))
        : 0;
    const doneHeader = errorFiles.length === 0 && skippedFiles.length === 0
        ? { title: '✨ Batch complete!', detail: 'All planned audiobooks finished successfully.' }
        : completedFiles.length > 0
            ? { title: '⚠ Batch finished with issues', detail: 'Some files completed, but not every job finished cleanly.' }
            : { title: '✘ Batch failed', detail: 'No output files were produced from this run.' };

    return (
        <Box flexDirection="column" padding={1}>
            <Header />

            {screen === 'checking' && (
                <Box marginTop={1} paddingX={2}>
                    <Text dimColor>Checking dependencies...</Text>
                </Box>
            )}

            {screen === 'setup-required' && (
                <SetupRequired checks={preflightChecks} onRetry={handleRetryChecks} />
            )}

            {screen === 'welcome' && (
                <WelcomeScreen onStart={() => setScreen('files')} />
            )}

            {screen === 'files' && (
                <FileSelector onFilesSelected={handleFilesSelected} />
            )}

            {screen === 'config' && (
                <Box flexDirection="column">
                    {planningError && (
                        <Box marginBottom={1} paddingX={2}>
                            <Text color="red">{planningError}</Text>
                        </Box>
                    )}
                    <ConfigPanel
                        files={files}
                        config={config}
                        onConfirm={handleConfigConfirm}
                        onBack={() => setScreen('files')}
                    />
                </Box>
            )}

            {screen === 'metadata' && (
                metadataLoading ? (
                    <Box marginTop={1} paddingX={2}>
                        <Text dimColor>Loading metadata from EPUB...</Text>
                    </Box>
                ) : bookMetadata ? (
                    <MetadataEditor
                        metadata={bookMetadata}
                        onConfirm={handleMetadataConfirm}
                        onBack={() => setScreen('config')}
                    />
                ) : null
            )}

            {screen === 'planning' && (
                <Box marginTop={1} paddingX={2} flexDirection="column">
                    <Text dimColor>Inspecting files and checkpoints before processing...</Text>
                    {planningProgress && (
                        <Text dimColor>
                            {planningProgress.current}/{planningProgress.total}
                            {planningProgress.inputPath ? ` • ${planningProgress.inputPath}` : ''}
                        </Text>
                    )}
                    {planningError && (
                        <Text color="red">{planningError}</Text>
                    )}
                </Box>
            )}

            {screen === 'review' && batchPlan && (
                <BatchReview
                    plan={batchPlan}
                    onStart={handleStartProcessing}
                    onStartFreshAll={handleStartFreshAll}
                    onBack={() => setScreen('config')}
                />
            )}

            {screen === 'processing' && (
                <BatchProgress
                    files={files}
                    setFiles={setFiles}
                    jobPlans={batchPlan?.jobs ?? []}
                    onComplete={handleProcessingComplete}
                />
            )}

            {screen === 'done' && (
                <Box flexDirection="column" marginTop={1}>
                    {/* Success Header */}
                    <Box marginBottom={1}>
                        <Text color={errorFiles.length > 0 || skippedFiles.length > 0 ? 'yellow' : 'green'} bold>
                            {doneHeader.title}
                        </Text>
                        <Text> {doneHeader.detail}</Text>
                    </Box>

                    {/* Summary Stats Card */}
                    <Box
                        flexDirection="column"
                        borderStyle="round"
                        borderColor="magenta"
                        paddingX={2}
                        paddingY={1}
                        marginBottom={1}
                    >
                        <Text bold color="white">📊 Summary</Text>
                        <Box marginTop={1} flexDirection="column">
                            <Box>
                                <Text dimColor>Files processed: </Text>
                                <Text color="green" bold>{completedFiles.length}</Text>
                                {errorFiles.length > 0 && (
                                    <Text color="red"> ({errorFiles.length} failed)</Text>
                                )}
                                {skippedFiles.length > 0 && (
                                    <Text color="yellow"> ({skippedFiles.length} skipped)</Text>
                                )}
                            </Box>
                            <Box>
                                <Text dimColor>Total output size: </Text>
                                <Text color="cyan" bold>{formatBytes(totalOutputSize)}</Text>
                            </Box>
                            <Box>
                                <Text dimColor>Processing time: </Text>
                                <Text color="yellow" bold>{formatDuration(totalTime)}</Text>
                            </Box>
                            {totalCharsProcessed > 0 && (
                                <>
                                    <Box>
                                        <Text dimColor>Total characters: </Text>
                                        <Text color="cyan">{totalCharsProcessed.toLocaleString()}</Text>
                                    </Box>
                                    <Box>
                                        <Text dimColor>Processing speed: </Text>
                                        <Text color="green" bold>{processingSpeed.toLocaleString()} chars/sec</Text>
                                    </Box>
                                </>
                            )}
                            {totalChunksProcessed > 0 && (
                                <Box>
                                    <Text dimColor>Total chunks: </Text>
                                    <Text color="cyan">{totalChunksProcessed}</Text>
                                    {avgChunkTimeOverall > 0 && (
                                        <>
                                            <Text dimColor>  •  Avg chunk time: </Text>
                                            <Text color="cyan">{(avgChunkTimeOverall / 1000).toFixed(2)}s</Text>
                                        </>
                                    )}
                                </Box>
                            )}
                        </Box>
                    </Box>

                    {/* Output Files Card */}
                    <Box
                        flexDirection="column"
                        borderStyle="round"
                        borderColor="green"
                        paddingX={2}
                        paddingY={1}
                        marginBottom={1}
                    >
                        <Text bold color="white">📁 Output Files</Text>
                        <Box marginTop={1} flexDirection="column">
                            {completedFiles.map(file => (
                                <Box key={file.id} flexDirection="column" marginBottom={1}>
                                    <Box>
                                        <Text color="green">✔ </Text>
                                        <Text color="white" bold>{path.basename(file.outputPath)}</Text>
                                        {file.outputSize && (
                                            <Text dimColor> ({formatBytes(file.outputSize)})</Text>
                                        )}
                                    </Box>
                                    <Box marginLeft={2}>
                                        <Text dimColor>→ </Text>
                                        <Text color="cyan">{file.outputPath}</Text>
                                    </Box>
                                </Box>
                            ))}
                        </Box>
                        {outputDirectories.length > 0 && (
                            <Box marginTop={1} flexDirection="column">
                                <Text dimColor>Output {outputDirectories.length === 1 ? 'directory' : 'directories'}:</Text>
                                {outputDirectories.map((directory) => (
                                    <Text key={directory} color="cyan">{directory}</Text>
                                ))}
                            </Box>
                        )}
                    </Box>

                    {/* Error Files Card (if any) */}
                    {errorFiles.length > 0 && (
                        <Box
                            flexDirection="column"
                            borderStyle="round"
                            borderColor="red"
                            paddingX={2}
                            paddingY={1}
                            marginBottom={1}
                        >
                            <Text bold color="red">⚠️ Failed Files</Text>
                            <Box marginTop={1} flexDirection="column">
                                {errorFiles.map(file => (
                                    <Box key={file.id} flexDirection="column" marginBottom={1}>
                                        <Box>
                                            <Text color="red">✘ </Text>
                                            <Text color="white">{path.basename(file.inputPath)}</Text>
                                        </Box>
                                        {file.error && (
                                            <Box marginLeft={2}>
                                                <Text dimColor color="red">{file.error}</Text>
                                            </Box>
                                        )}
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    )}

                    {skippedFiles.length > 0 && (
                        <Box
                            flexDirection="column"
                            borderStyle="round"
                            borderColor="yellow"
                            paddingX={2}
                            paddingY={1}
                            marginBottom={1}
                        >
                            <Text bold color="yellow">↷ Skipped Files</Text>
                            <Box marginTop={1} flexDirection="column">
                                {skippedFiles.map(file => (
                                    <Box key={file.id} flexDirection="column" marginBottom={1}>
                                        <Box>
                                            <Text color="yellow">↷ </Text>
                                            <Text color="white">{path.basename(file.inputPath)}</Text>
                                        </Box>
                                        {file.error && (
                                            <Box marginLeft={2}>
                                                <Text dimColor color="yellow">{file.error}</Text>
                                            </Box>
                                        )}
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    )}

                    {/* Actions */}
                    <Box marginTop={1}>
                        <Text dimColor>⌨️  </Text>
                        <KeyboardHint hints={doneHints} compact={true} />
                    </Box>
                </Box>
            )}

            <Box marginTop={1}>
                {screen === 'processing' ? (
                    <KeyboardHint hints={PROCESSING_HINTS} compact={true} />
                ) : screen !== 'done' ? (
                    <Text dimColor>Press q to quit anytime</Text>
                ) : null}
            </Box>
        </Box>
    );
}
