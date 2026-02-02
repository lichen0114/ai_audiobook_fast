import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Gradient from 'ink-gradient';
import type { FileJob, TTSConfig } from '../App.js';
import { runTTS, type ProgressInfo, type ProcessingPhase } from '../utils/tts-runner.js';
import { GpuMonitor } from './GpuMonitor.js';
import * as path from 'path';

// Phase display configuration
const PHASES: ProcessingPhase[] = ['PARSING', 'INFERENCE', 'CONCATENATING', 'EXPORTING'];
const PHASE_LABELS: Record<ProcessingPhase, string> = {
    PARSING: 'Parsing',
    INFERENCE: 'Inference',
    CONCATENATING: 'Concatenating',
    EXPORTING: 'Exporting',
    DONE: 'Done',
};

// EMA alpha for smoothing (0.3 = responsive, 0.1 = very smooth)
const EMA_ALPHA = 0.3;

// Parse Python errors into user-friendly messages
function parseErrorMessage(error: string): string {
    const errorLower = error.toLowerCase();

    // GPU/Memory errors
    if (errorLower.includes('out of memory') || errorLower.includes('mps') && errorLower.includes('memory')) {
        return 'GPU memory exhausted - try reducing chunk size (--chunk_chars)';
    }
    if (errorLower.includes('mps backend') || errorLower.includes('metal')) {
        return 'GPU acceleration error - try disabling MPS or updating macOS';
    }

    // File errors
    if (errorLower.includes('no such file') || errorLower.includes('not found') || errorLower.includes('filenotfounderror')) {
        return 'Input file not found or inaccessible';
    }
    if (errorLower.includes('permission denied')) {
        return 'Permission denied - check file/folder permissions';
    }
    if (errorLower.includes('no readable text') || errorLower.includes('no text chunks')) {
        return 'EPUB has no readable text content';
    }

    // Encoding/Format errors
    if (errorLower.includes('codec') || errorLower.includes('decode') || errorLower.includes('encode')) {
        return 'Text encoding error - EPUB may contain unsupported characters';
    }
    if (errorLower.includes('epub') && errorLower.includes('invalid')) {
        return 'Invalid EPUB format - file may be corrupted';
    }

    // FFmpeg errors
    if (errorLower.includes('ffmpeg') || errorLower.includes('ffprobe')) {
        return 'FFmpeg not found - please install FFmpeg for MP3 export';
    }

    // Python version errors
    if (errorLower.includes('python') && errorLower.includes('version')) {
        return 'Python version error - Kokoro requires Python 3.10-3.12';
    }

    // Model/TTS errors
    if (errorLower.includes('voice') && (errorLower.includes('not found') || errorLower.includes('invalid'))) {
        return 'Invalid voice - check available voice options';
    }
    if (errorLower.includes('model') && errorLower.includes('load')) {
        return 'Failed to load TTS model - check installation';
    }

    // Return truncated original error if no pattern matches
    const lines = error.split('\n');
    // Try to find the most relevant line (usually the last non-empty one)
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !line.startsWith('Traceback') && !line.startsWith('File ')) {
            return line.length > 100 ? line.substring(0, 100) + '...' : line;
        }
    }

    return error.length > 100 ? error.substring(0, 100) + '...' : error;
}

interface BatchProgressProps {
    files: FileJob[];
    setFiles: React.Dispatch<React.SetStateAction<FileJob[]>>;
    config: TTSConfig;
    onComplete: () => void;
}

// Phase Indicator Component
function PhaseIndicator({ currentPhase }: { currentPhase: ProcessingPhase | undefined }) {
    return (
        <Box>
            {PHASES.map((phase, idx) => {
                const isActive = currentPhase === phase;
                const isPast = currentPhase && PHASES.indexOf(currentPhase) > idx;
                const isDone = currentPhase === 'DONE';

                return (
                    <React.Fragment key={phase}>
                        <Text
                            color={isDone ? 'green' : isActive ? 'green' : isPast ? 'gray' : 'gray'}
                            bold={isActive}
                            dimColor={!isActive && !isDone}
                        >
                            {PHASE_LABELS[phase]}
                        </Text>
                        {idx < PHASES.length - 1 && (
                            <Text dimColor color="gray"> → </Text>
                        )}
                    </React.Fragment>
                );
            })}
        </Box>
    );
}

function ProgressBar({ progress, width = 30, showPercentage = true, useGradient = false }: { progress: number; width?: number; showPercentage?: boolean; useGradient?: boolean }) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;

    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);

    // Gradient color based on progress: blue (0%) -> cyan (50%) -> green (100%)
    const getGradientColor = (pct: number): string => {
        if (pct < 50) return 'blue';
        if (pct < 80) return 'cyan';
        return 'green';
    };

    const color = useGradient ? getGradientColor(progress) : 'green';

    return (
        <Text>
            <Text color={color}>{filledBar}</Text>
            <Text color="gray">{emptyBar}</Text>
            {showPercentage && (
                <>
                    <Text> </Text>
                    <Text bold color="white">{String(progress).padStart(3, ' ')}%</Text>
                </>
            )}
        </Text>
    );
}

// Mini-chunks indicator for small batches (<=50 chunks)
function MiniChunksIndicator({ current, total }: { current: number; total: number }) {
    if (total > 50) return null;

    const filled = '●'.repeat(current);
    const empty = '○'.repeat(total - current);

    return (
        <Box marginTop={1}>
            <Text dimColor>Chunks: </Text>
            <Text color="green">{filled}</Text>
            <Text color="gray">{empty}</Text>
        </Box>
    );
}

function FileStatus({ file, isActive }: { file: FileJob; isActive?: boolean }) {
    const getStatusIcon = () => {
        switch (file.status) {
            case 'pending':
                return <Text color="gray" dimColor>⏳</Text>;
            case 'processing':
                return <Text color="cyan">►</Text>;
            case 'done':
                return <Text color="green">✔</Text>;
            case 'error':
                return <Text color="red">✘</Text>;
        }
    };

    const getStatusColor = (): string => {
        switch (file.status) {
            case 'pending': return 'gray';
            case 'processing': return 'cyan';
            case 'done': return 'green';
            case 'error': return 'red';
        }
    };

    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                {getStatusIcon()}
                <Text> </Text>
                <Text color={getStatusColor()} bold={file.status === 'processing'}>
                    {path.basename(file.inputPath)}
                </Text>
                {file.status === 'done' && (
                    <Text dimColor> → saved</Text>
                )}
            </Box>
            {file.status === 'processing' && (
                <Box marginLeft={3} marginTop={0}>
                    <ProgressBar progress={file.progress} width={25} />
                    {file.currentChunk !== undefined && file.totalChunks !== undefined && (
                        <Text dimColor> ({file.currentChunk}/{file.totalChunks} chunks)</Text>
                    )}
                </Box>
            )}
            {file.error && (
                <Box marginLeft={3}>
                    <Text color="red" dimColor>{file.error}</Text>
                </Box>
            )}
        </Box>
    );
}

export function BatchProgress({ files, setFiles, config, onComplete }: BatchProgressProps) {
    const { exit } = useApp();
    const [currentIndex, setCurrentIndex] = useState(0);
    const [startTime] = useState(Date.now());
    const [elapsedTime, setElapsedTime] = useState(0);

    // Phase tracking
    const [currentPhase, setCurrentPhase] = useState<ProcessingPhase | undefined>(undefined);
    const currentPhaseRef = React.useRef<ProcessingPhase | undefined>(undefined);

    // Per-chunk timing with EMA
    const [avgChunkTime, setAvgChunkTime] = useState<number | undefined>(undefined);
    const emaChunkTimeRef = React.useRef<number | undefined>(undefined);

    // Total characters for stats
    const [totalChars, setTotalChars] = useState<number | undefined>(undefined);
    const totalCharsRef = React.useRef<number | undefined>(undefined);

    // Stall detection
    const [isStalled, setIsStalled] = useState(false);
    const lastHeartbeatRef = React.useRef<number>(Date.now());
    const STALL_THRESHOLD_MS = 15000; // 15 seconds

    // Handle quit
    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
        }
    });

    const completedCount = files.filter(f => f.status === 'done').length;
    const errorCount = files.filter(f => f.status === 'error').length;
    const overallProgress = Math.round(((completedCount + errorCount) / files.length) * 100);

    const [workerStates, setWorkerStates] = useState<Map<number, { status: string; details: string }>>(new Map());

    // Refs for throttling updates
    const workerStatesRef = React.useRef<Map<number, { status: string; details: string }>>(new Map());
    const filesRef = React.useRef<FileJob[]>(files);

    // Dirty flags to prevent unnecessary re-renders
    const hasWorkerUpdates = React.useRef(false);
    const hasFileUpdates = React.useRef(false);
    const hasPhaseUpdate = React.useRef(false);
    const hasTimingUpdate = React.useRef(false);
    const hasCharsUpdate = React.useRef(false);

    const [eta, setEta] = useState<string>('Calculating...');
    const etaRef = React.useRef<string>('Calculating...');

    // Sync refs to state periodically (4Hz) to prevent flashing
    useEffect(() => {
        const interval = setInterval(() => {
            // Check if we need to update worker states
            if (hasWorkerUpdates.current) {
                setWorkerStates(new Map(workerStatesRef.current));
                hasWorkerUpdates.current = false;
            }

            // Sync files progress
            if (hasFileUpdates.current) {
                setFiles([...filesRef.current]);
                hasFileUpdates.current = false;
            }

            // Sync phase
            if (hasPhaseUpdate.current) {
                setCurrentPhase(currentPhaseRef.current);
                hasPhaseUpdate.current = false;
            }

            // Sync timing
            if (hasTimingUpdate.current) {
                setAvgChunkTime(emaChunkTimeRef.current);
                hasTimingUpdate.current = false;
            }

            // Sync total chars
            if (hasCharsUpdate.current) {
                setTotalChars(totalCharsRef.current);
                hasCharsUpdate.current = false;
            }

            // Sync ETA (always sync simple string, low cost)
            setEta(etaRef.current);

            // Update elapsed time
            setElapsedTime(Date.now() - startTime);

            // Check for stall (only during INFERENCE phase)
            if (currentPhaseRef.current === 'INFERENCE') {
                const timeSinceHeartbeat = Date.now() - lastHeartbeatRef.current;
                setIsStalled(timeSinceHeartbeat > STALL_THRESHOLD_MS);
            } else {
                setIsStalled(false);
            }
        }, 250);

        return () => clearInterval(interval);
    }, [startTime]);

    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    useEffect(() => {
        const processFiles = async () => {
            for (let i = 0; i < files.length; i++) {
                setCurrentIndex(i);

                // Clear worker states for new file
                workerStatesRef.current = new Map();
                hasWorkerUpdates.current = true; // Force update

                // Capture file info to avoid stale closure
                const { inputPath, outputPath, id } = files[i];

                // Update status to processing
                setFiles(prev => {
                    const next = prev.map((f, idx) =>
                        idx === i ? { ...f, status: 'processing' as const } : f
                    );
                    filesRef.current = next;
                    hasFileUpdates.current = true;
                    return next;
                });

                try {
                    await runTTS(
                        inputPath,
                        outputPath,
                        config,
                        (progressInfo: ProgressInfo) => {
                            // Update phase
                            if (progressInfo.phase && progressInfo.phase !== currentPhaseRef.current) {
                                currentPhaseRef.current = progressInfo.phase;
                                hasPhaseUpdate.current = true;
                                // Reset heartbeat timer on phase change
                                lastHeartbeatRef.current = Date.now();
                            }

                            // Update heartbeat timestamp
                            if (progressInfo.heartbeatTs) {
                                lastHeartbeatRef.current = Date.now();
                            }

                            // Update per-chunk timing with EMA
                            if (progressInfo.chunkTimingMs !== undefined) {
                                if (emaChunkTimeRef.current === undefined) {
                                    emaChunkTimeRef.current = progressInfo.chunkTimingMs;
                                } else {
                                    emaChunkTimeRef.current = EMA_ALPHA * progressInfo.chunkTimingMs + (1 - EMA_ALPHA) * emaChunkTimeRef.current;
                                }
                                hasTimingUpdate.current = true;
                                // Also update heartbeat on timing
                                lastHeartbeatRef.current = Date.now();
                            }

                            // Update total characters
                            if (progressInfo.totalChars !== undefined && progressInfo.totalChars !== totalCharsRef.current) {
                                totalCharsRef.current = progressInfo.totalChars;
                                hasCharsUpdate.current = true;
                            }

                            // Update Worker Status Ref (No re-render)
                            if (progressInfo.workerStatus) {
                                const { id, status, details } = progressInfo.workerStatus;
                                const next = new Map(workerStatesRef.current);
                                next.set(id, { status, details });
                                workerStatesRef.current = next;
                                hasWorkerUpdates.current = true;
                                // Also update heartbeat on worker activity
                                lastHeartbeatRef.current = Date.now();
                            }

                            // Update Progress Ref (No re-render)
                            if (progressInfo.totalChunks > 0) {
                                const currentFiles = [...filesRef.current];
                                currentFiles[i] = {
                                    ...currentFiles[i],
                                    progress: progressInfo.progress,
                                    currentChunk: progressInfo.currentChunk,
                                    totalChunks: progressInfo.totalChunks,
                                };
                                filesRef.current = currentFiles;
                                hasFileUpdates.current = true;
                            }

                            // Update ETA with EMA-based calculation
                            if (progressInfo.totalChunks > 0 && progressInfo.currentChunk > 0) {
                                let remainingTime: number;

                                if (emaChunkTimeRef.current !== undefined) {
                                    // Use EMA for smoother estimates
                                    const remainingChunks = progressInfo.totalChunks - progressInfo.currentChunk;
                                    remainingTime = emaChunkTimeRef.current * remainingChunks;
                                } else {
                                    // Fallback to simple average
                                    const elapsed = Date.now() - startTime;
                                    const avgTimePerChunk = elapsed / progressInfo.currentChunk;
                                    const remainingChunks = progressInfo.totalChunks - progressInfo.currentChunk;
                                    remainingTime = avgTimePerChunk * remainingChunks;
                                }

                                if (remainingTime > 60000) {
                                    etaRef.current = `${Math.round(remainingTime / 60000)} min`;
                                } else {
                                    etaRef.current = `${Math.round(remainingTime / 1000)} sec`;
                                }
                            }
                        }
                    );

                    // Mark as done with stats
                    setFiles(prev => {
                        const next = prev.map((f, idx) =>
                            idx === i ? {
                                ...f,
                                status: 'done' as const,
                                progress: 100,
                                totalChars: totalCharsRef.current,
                                avgChunkTimeMs: emaChunkTimeRef.current,
                            } : f
                        );
                        filesRef.current = next;
                        return next;
                    });

                    // Reset stats for next file
                    emaChunkTimeRef.current = undefined;
                    totalCharsRef.current = undefined;
                    currentPhaseRef.current = undefined;
                } catch (error) {
                    // Mark as error with user-friendly message
                    const rawError = error instanceof Error ? error.message : 'Unknown error';
                    const friendlyError = parseErrorMessage(rawError);

                    setFiles(prev => {
                        const next = prev.map((f, idx) =>
                            idx === i ? {
                                ...f,
                                status: 'error' as const,
                                error: friendlyError
                            } : f
                        );
                        filesRef.current = next;
                        return next;
                    });

                    // Reset stats for next file
                    emaChunkTimeRef.current = undefined;
                    totalCharsRef.current = undefined;
                    currentPhaseRef.current = undefined;
                }
            }

            onComplete();
        };

        processFiles();
    }, []);

    const currentFile = files[currentIndex];

    // Worker Grid Component
    const renderWorkers = () => {
        if (workerStates.size === 0) return null;

        const workers = Array.from(workerStates.entries()).sort((a, b) => a[0] - b[0]);

        return (
            <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
                <Box marginBottom={1}>
                    <Text bold color="blue">👷 Workers ({workers.length})</Text>
                </Box>
                <Box flexDirection="column">
                    {workers.map(([id, state]) => (
                        <Box key={id} marginBottom={0}>
                            <Text dimColor>Worker {id}: </Text>
                            <Text
                                color={state.status === 'INFER' ? 'magenta' : state.status === 'ENCODE' ? 'cyan' : 'gray'}
                                bold={state.status !== 'IDLE'}
                            >
                                {state.status.padEnd(7)}
                            </Text>
                            <Text> {state.details}</Text>
                        </Box>
                    ))}
                </Box>
            </Box>
        );
    };

    // Format elapsed time
    const formatElapsed = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    };

    return (
        <Box flexDirection="column" paddingX={2}>
            {/* Section Header */}
            <Box marginBottom={1}>
                <Gradient name="passion">
                    <Text bold>🎧 Processing Audiobooks</Text>
                </Gradient>
            </Box>

            {/* Stall Warning */}
            {isStalled && (
                <Box marginBottom={1} paddingX={2} paddingY={1} borderStyle="round" borderColor="yellow">
                    <Text color="yellow" bold>⚠️ Warning: </Text>
                    <Text color="yellow">No response for 15+ seconds. Processing may be stalled.</Text>
                </Box>
            )}

            {/* Phase Indicator */}
            {currentPhase && (
                <Box marginBottom={1}>
                    <Text dimColor>Phase: </Text>
                    <PhaseIndicator currentPhase={currentPhase} />
                </Box>
            )}

            {/* Currently Processing Card */}
            {currentFile && currentFile.status === 'processing' && (
                <Box
                    flexDirection="column"
                    borderStyle="round"
                    borderColor="magenta"
                    paddingX={2}
                    paddingY={1}
                    marginBottom={1}
                    width="100%"
                >
                    <Box>
                        <Text dimColor>Currently Processing: </Text>
                        <Text bold color="white">{path.basename(currentFile.inputPath)}</Text>
                    </Box>
                    {currentFile.currentChunk !== undefined && currentFile.totalChunks !== undefined && (
                        <Box marginTop={1}>
                            <Text dimColor>Chunk: </Text>
                            <Text bold color="yellow">{currentFile.currentChunk}</Text>
                            <Text dimColor>/</Text>
                            <Text>{currentFile.totalChunks}</Text>
                            <Text dimColor> ({Math.round((currentFile.currentChunk / currentFile.totalChunks) * 100)}%)</Text>
                        </Box>
                    )}
                    {/* Per-chunk timing stats */}
                    {avgChunkTime !== undefined && (
                        <Box marginTop={1}>
                            <Text dimColor>Avg chunk time: </Text>
                            <Text color="cyan" bold>{(avgChunkTime / 1000).toFixed(2)}s</Text>
                            {totalChars !== undefined && (
                                <>
                                    <Text dimColor>  •  Total chars: </Text>
                                    <Text color="cyan">{totalChars.toLocaleString()}</Text>
                                </>
                            )}
                        </Box>
                    )}
                    <Box marginTop={1}>
                        <ProgressBar progress={currentFile.progress} width={35} useGradient={true} />
                    </Box>
                    {/* Mini-chunks indicator for small batches */}
                    {currentFile.currentChunk !== undefined && currentFile.totalChunks !== undefined && (
                        <MiniChunksIndicator current={currentFile.currentChunk} total={currentFile.totalChunks} />
                    )}
                </Box>
            )}

            {/* Worker Monitor */}
            {renderWorkers()}

            {/* Overall Progress Card */}
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
                width="100%"
            >
                <Box justifyContent="space-between">
                    <Box>
                        <Text dimColor>Overall Progress: </Text>
                        <Text bold color="green">{completedCount}</Text>
                        <Text dimColor>/</Text>
                        <Text>{files.length}</Text>
                        <Text dimColor> files</Text>
                        {errorCount > 0 && (
                            <Text color="red"> ({errorCount} errors)</Text>
                        )}
                    </Box>
                    <Box>
                        <Text dimColor>⏱️  Elapsed: </Text>
                        <Text color="cyan">{formatElapsed(elapsedTime)}</Text>
                        <Text dimColor>  •  ETA: </Text>
                        <Text color="yellow" bold>{eta}</Text>
                    </Box>
                </Box>
                <Box marginTop={1}>
                    <ProgressBar progress={overallProgress} width={40} useGradient={true} />
                </Box>
            </Box>

            {/* GPU Monitor */}
            <Box marginBottom={1}>
                <GpuMonitor compact={false} showSparkline={true} />
            </Box>

            {/* File List */}
            <Box flexDirection="column">
                <Box marginBottom={1}>
                    <Text dimColor>📚 </Text>
                    <Text bold color="white">Files</Text>
                </Box>
                <Box
                    flexDirection="column"
                    paddingLeft={1}
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={2}
                    paddingY={1}
                >
                    {files.map((file, idx) => (
                        <FileStatus key={file.id} file={file} isActive={idx === currentIndex} />
                    ))}
                </Box>
            </Box>
        </Box>
    );
}
