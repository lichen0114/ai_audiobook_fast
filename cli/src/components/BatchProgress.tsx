import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { FileJob, TTSConfig } from '../App.js';
import { runTTS } from '../utils/tts-runner.js';
import * as path from 'path';

interface BatchProgressProps {
    files: FileJob[];
    setFiles: React.Dispatch<React.SetStateAction<FileJob[]>>;
    config: TTSConfig;
    onComplete: () => void;
}

function ProgressBar({ progress, width = 30 }: { progress: number; width?: number }) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;

    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);

    return (
        <Text>
            <Text color="green">{filledBar}</Text>
            <Text color="gray">{emptyBar}</Text>
            <Text color="cyan"> {progress}%</Text>
        </Text>
    );
}

function FileStatus({ file }: { file: FileJob }) {
    const getStatusIcon = () => {
        switch (file.status) {
            case 'pending':
                return <Text color="gray">⏳</Text>;
            case 'processing':
                return <Text color="cyan"><Spinner type="dots" /></Text>;
            case 'done':
                return <Text color="green">✅</Text>;
            case 'error':
                return <Text color="red">❌</Text>;
        }
    };

    const getStatusColor = () => {
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
                <Text color={getStatusColor()}>{path.basename(file.inputPath)}</Text>
            </Box>
            {file.status === 'processing' && (
                <Box marginLeft={3}>
                    <ProgressBar progress={file.progress} />
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

    return (
        <Box flexDirection="column" paddingX={2}>
            <Box marginBottom={1}>
                <Text color="cyan">🎧 Processing Audiobooks</Text>
            </Box>

            {/* Overall Progress */}
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="cyan"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
            >
                <Box>
                    <Text bold>Overall Progress: </Text>
                    <Text color="green">{completedCount}</Text>
                    <Text>/{files.length} files</Text>
                    {errorCount > 0 && (
                        <Text color="red"> ({errorCount} errors)</Text>
                    )}
                </Box>
                <Box marginTop={1}>
                    <ProgressBar progress={overallProgress} width={40} />
                </Box>
                <Box marginTop={1}>
                    <Text color="yellow">⏱️  ETA: {eta}</Text>
                </Box>
            </Box>

            {/* File List */}
            <Box flexDirection="column">
                <Text bold color="white">Files:</Text>
                <Box flexDirection="column" marginTop={1} paddingLeft={1}>
                    {files.map((file) => (
                        <FileStatus key={file.id} file={file} />
                    ))}
                </Box>
            </Box>
        </Box>
    );
}
