import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Gradient from 'ink-gradient';
import type { FileJob, TTSConfig } from '../App.js';
import { runTTS, type ProgressInfo } from '../utils/tts-runner.js';
import { GpuMonitor } from './GpuMonitor.js';
import * as path from 'path';

interface BatchProgressProps {
    files: FileJob[];
    setFiles: React.Dispatch<React.SetStateAction<FileJob[]>>;
    config: TTSConfig;
    onComplete: () => void;
}

function ProgressBar({ progress, width = 30, showPercentage = true }: { progress: number; width?: number; showPercentage?: boolean }) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;

    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);

    return (
        <Text>
            <Text color="green">{filledBar}</Text>
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

function FileStatus({ file, isActive }: { file: FileJob; isActive?: boolean }) {
    const getStatusIcon = () => {
        switch (file.status) {
            case 'pending':
                return <Text color="gray" dimColor>⏳</Text>;
            case 'processing':
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

            // Sync ETA (always sync simple string, low cost)
            setEta(etaRef.current);
        }, 250);

        return () => clearInterval(interval);
    }, []);

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
                        files[i].inputPath,
                        files[i].outputPath,
                        config,
                        (progressInfo: ProgressInfo) => {
                            // Update Worker Status Ref (No re-render)
                            if (progressInfo.workerStatus) {
                                const { id, status, details } = progressInfo.workerStatus;
                                const next = new Map(workerStatesRef.current);
                                next.set(id, { status, details });
                                workerStatesRef.current = next;
                                hasWorkerUpdates.current = true;
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

                            // Update ETA Ref (No re-render)
                            const elapsed = Date.now() - startTime;
                            if (progressInfo.totalChunks > 0 && progressInfo.currentChunk > 0) {
                                const avgTimePerChunk = elapsed / progressInfo.currentChunk;
                                const remainingChunks = progressInfo.totalChunks - progressInfo.currentChunk;
                                const remainingTime = avgTimePerChunk * remainingChunks;

                                if (remainingTime > 60000) {
                                    etaRef.current = `${Math.round(remainingTime / 60000)} min`;
                                } else {
                                    etaRef.current = `${Math.round(remainingTime / 1000)} sec`;
                                }
                            }
                        }
                    );

                    // Mark as done
                    setFiles(prev => {
                        const next = prev.map((f, idx) =>
                            idx === i ? { ...f, status: 'done' as const, progress: 100 } : f
                        );
                        filesRef.current = next;
                        return next;
                    });
                } catch (error) {
                    // Mark as error
                    setFiles(prev => {
                        const next = prev.map((f, idx) =>
                            idx === i ? {
                                ...f,
                                status: 'error' as const,
                                error: error instanceof Error ? error.message : 'Unknown error'
                            } : f
                        );
                        filesRef.current = next;
                        return next;
                    });
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

    return (
        <Box flexDirection="column" paddingX={2}>
            {/* Section Header */}
            <Box marginBottom={1}>
                <Gradient name="passion">
                    <Text bold>🎧 Processing Audiobooks</Text>
                </Gradient>
            </Box>

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
                    <Box marginTop={1}>
                        <ProgressBar progress={currentFile.progress} width={35} />
                    </Box>
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
                        <Text dimColor>⏱️  ETA: </Text>
                        <Text color="yellow" bold>{eta}</Text>
                    </Box>
                </Box>
                <Box marginTop={1}>
                    <ProgressBar progress={overallProgress} width={40} />
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
