import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { FileSelector } from './components/FileSelector.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { BatchProgress } from './components/BatchProgress.js';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Screen = 'welcome' | 'files' | 'config' | 'processing' | 'done';

export interface TTSConfig {
    voice: string;
    speed: number;
    langCode: string;
    chunkChars: number;
    useMPS: boolean;
    outputDir: string | null; // null means same directory as input
    workers: number; // Number of parallel workers for audio encoding
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
    outputSize?: number; // in bytes
    processingTime?: number; // in ms
}

const defaultConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1.0,
    langCode: 'a',
    chunkChars: 1200,
    useMPS: true, // Enable Apple Silicon GPU acceleration by default
    outputDir: null,
    workers: 4, // Use 4 parallel workers by default for faster processing
};

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}

export function App() {
    const { exit } = useApp();
    const [screen, setScreen] = useState<Screen>('welcome');
    const [files, setFiles] = useState<FileJob[]>([]);
    const [config, setConfig] = useState<TTSConfig>(defaultConfig);
    const [totalTime, setTotalTime] = useState<number>(0);
    const [startTime, setStartTime] = useState<number>(0);

    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
        }
        // Open output folder in Finder when pressing 'o' on done screen
        if (screen === 'done' && input === 'o') {
            const completedFiles = files.filter(f => f.status === 'done');
            if (completedFiles.length > 0) {
                const outputDir = path.dirname(completedFiles[0].outputPath);
                exec(`open "${outputDir}"`);
            }
        }
        // Start new batch when pressing 'n' on done screen
        if (screen === 'done' && input === 'n') {
            setFiles([]);
            setScreen('files');
        }
    });

    const handleFilesSelected = (selectedFiles: string[]) => {
        const jobs: FileJob[] = selectedFiles.map((file, index) => ({
            id: `job-${index}`,
            inputPath: file,
            outputPath: file.replace(/\.epub$/i, '.mp3'),
            status: 'pending',
            progress: 0,
        }));
        setFiles(jobs);
        setScreen('config');
    };

    const handleConfigConfirm = (newConfig: TTSConfig) => {
        // Update output paths if custom directory is set
        if (newConfig.outputDir) {
            setFiles(prev => prev.map(file => ({
                ...file,
                outputPath: path.join(
                    newConfig.outputDir!,
                    path.basename(file.inputPath).replace(/\.epub$/i, '.mp3')
                ),
            })));
        }
        setConfig(newConfig);
        setStartTime(Date.now());
        setScreen('processing');
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
    const totalOutputSize = completedFiles.reduce((acc, f) => acc + (f.outputSize || 0), 0);

    return (
        <Box flexDirection="column" padding={1}>
            <Header />

            {screen === 'welcome' && (
                <WelcomeScreen onStart={() => setScreen('files')} />
            )}

            {screen === 'files' && (
                <FileSelector onFilesSelected={handleFilesSelected} />
            )}

            {screen === 'config' && (
                <ConfigPanel
                    files={files}
                    config={config}
                    onConfirm={handleConfigConfirm}
                    onBack={() => setScreen('files')}
                />
            )}

            {screen === 'processing' && (
                <BatchProgress
                    files={files}
                    setFiles={setFiles}
                    config={config}
                    onComplete={handleProcessingComplete}
                />
            )}

            {screen === 'done' && (
                <Box flexDirection="column" marginTop={1}>
                    {/* Success Header */}
                    <Box marginBottom={1}>
                        <Text color="green" bold>✨ All done!</Text>
                        <Text> Your audiobooks are ready.</Text>
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
                            </Box>
                            <Box>
                                <Text dimColor>Total output size: </Text>
                                <Text color="cyan" bold>{formatBytes(totalOutputSize)}</Text>
                            </Box>
                            <Box>
                                <Text dimColor>Processing time: </Text>
                                <Text color="yellow" bold>{formatDuration(totalTime)}</Text>
                            </Box>
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
                        {completedFiles.length > 0 && (
                            <Box marginTop={1}>
                                <Text dimColor>Output directory: </Text>
                                <Text color="cyan">{path.dirname(completedFiles[0].outputPath)}</Text>
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

                    {/* Actions */}
                    <Box
                        flexDirection="column"
                        borderStyle="single"
                        borderColor="gray"
                        paddingX={2}
                        paddingY={1}
                    >
                        <Text bold color="white">⌨️ Actions</Text>
                        <Box marginTop={1} flexDirection="column">
                            <Text>
                                <Text color="yellow" bold>o</Text>
                                <Text dimColor> → Open output folder in Finder</Text>
                            </Text>
                            <Text>
                                <Text color="yellow" bold>n</Text>
                                <Text dimColor> → Process new files</Text>
                            </Text>
                            <Text>
                                <Text color="yellow" bold>q</Text>
                                <Text dimColor> → Quit</Text>
                            </Text>
                        </Box>
                    </Box>
                </Box>
            )}

            <Box marginTop={1}>
                <Text dimColor>Press q to quit anytime</Text>
            </Box>
        </Box>
    );
}
