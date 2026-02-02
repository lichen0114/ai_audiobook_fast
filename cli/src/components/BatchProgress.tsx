import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import Gradient from 'ink-gradient';
import type { FileJob, TTSConfig } from '../App.js';
import { runTTS } from '../utils/tts-runner.js';
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
                return <Text color="cyan"><Spinner type="dots12" /></Text>;
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
    const [eta, setEta] = useState<string>('Calculating...');

    // Handle quit
    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
        }
    });

    const completedCount = files.filter(f => f.status === 'done').length;
    const errorCount = files.filter(f => f.status === 'error').length;
    const overallProgress = Math.round(((completedCount + errorCount) / files.length) * 100);

    useEffect(() => {
        const processFiles = async () => {
            for (let i = 0; i < files.length; i++) {
                setCurrentIndex(i);

                // Update status to processing
                setFiles(prev => prev.map((f, idx) =>
                    idx === i ? { ...f, status: 'processing' as const } : f
                ));

                try {
                    await runTTS(
                        files[i].inputPath,
                        files[i].outputPath,
                        config,
                        (progress) => {
                            setFiles(prev => prev.map((f, idx) =>
                                idx === i ? { ...f, progress } : f
                            ));

                            // Update ETA
                            const elapsed = Date.now() - startTime;
                            const avgTimePerFile = elapsed / (i + progress / 100);
                            const remainingFiles = files.length - i - 1 + (100 - progress) / 100;
                            const remainingTime = avgTimePerFile * remainingFiles;

                            if (remainingTime > 60000) {
                                setEta(`${Math.round(remainingTime / 60000)} min`);
                            } else {
                                setEta(`${Math.round(remainingTime / 1000)} sec`);
                            }
                        }
                    );

                    // Mark as done
                    setFiles(prev => prev.map((f, idx) =>
                        idx === i ? { ...f, status: 'done' as const, progress: 100 } : f
                    ));
                } catch (error) {
                    // Mark as error
                    setFiles(prev => prev.map((f, idx) =>
                        idx === i ? {
                            ...f,
                            status: 'error' as const,
                            error: error instanceof Error ? error.message : 'Unknown error'
                        } : f
                    ));
                }
            }

            onComplete();
        };

        processFiles();
    }, []);

    const currentFile = files[currentIndex];

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
                >
                    <Box>
                        <Text dimColor>Currently Processing: </Text>
                        <Text bold color="white">{path.basename(currentFile.inputPath)}</Text>
                    </Box>
                    <Box marginTop={1}>
                        <ProgressBar progress={currentFile.progress} width={35} />
                    </Box>
                </Box>
            )}

            {/* Overall Progress Card */}
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
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
