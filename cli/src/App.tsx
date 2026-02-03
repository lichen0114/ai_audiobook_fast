import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { FileSelector } from './components/FileSelector.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { BatchProgress } from './components/BatchProgress.js';
import { WelcomeScreen } from './components/WelcomeScreen.js';
import { SetupRequired } from './components/SetupRequired.js';
import { KeyboardHint, DONE_HINTS, PROCESSING_HINTS } from './components/KeyboardHint.js';
import { runPreflightChecks, quickCheck, type PreflightCheck } from './utils/preflight.js';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Screen = 'checking' | 'setup-required' | 'welcome' | 'files' | 'config' | 'processing' | 'done';

export interface TTSConfig {
    voice: string;
    speed: number;
    langCode: string;
    chunkChars: number;
    useMPS: boolean;
    outputDir: string | null; // null means same directory as input
    workers: number; // Number of parallel workers for audio encoding
    backend: 'pytorch' | 'mlx'; // TTS backend to use
    outputFormat: 'mp3' | 'm4b'; // Output format
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
    totalChars?: number; // total characters processed
    avgChunkTimeMs?: number; // average chunk time in ms
    startTime?: number; // processing start timestamp
}

// Optimal chunk sizes per backend based on benchmarks
// MLX: 900 chars = 180 chars/s (+11% vs 1200)
// PyTorch: 600 chars = 98 chars/s (+3% vs 1200)
const BACKEND_CHUNK_CHARS: Record<'pytorch' | 'mlx', number> = {
    mlx: 900,
    pytorch: 600,
};

const defaultConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1.0,
    langCode: 'a',
    chunkChars: 600, // Default for PyTorch; updated when backend changes
    useMPS: true, // Enable Apple Silicon GPU acceleration by default
    outputDir: null,
    workers: 2, // Use 2 parallel workers by default (optimal for Apple Silicon MPS)
    backend: 'pytorch', // Default to PyTorch backend
    outputFormat: 'mp3', // Default to MP3 format
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
    const [screen, setScreen] = useState<Screen>('checking');
    const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
    const [files, setFiles] = useState<FileJob[]>([]);
    const [config, setConfig] = useState<TTSConfig>(defaultConfig);
    const [totalTime, setTotalTime] = useState<number>(0);
    const [startTime, setStartTime] = useState<number>(0);

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

    const handleConfigConfirm = (newConfig: TTSConfig) => {
        const ext = newConfig.outputFormat === 'm4b' ? '.m4b' : '.mp3';
        // Update output paths based on format and custom directory
        setFiles(prev => prev.map(file => {
            const baseName = path.basename(file.inputPath).replace(/\.epub$/i, ext);
            const outputPath = newConfig.outputDir
                ? path.join(newConfig.outputDir, baseName)
                : file.inputPath.replace(/\.epub$/i, ext);
            return { ...file, outputPath };
        }));
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
    const totalCharsProcessed = completedFiles.reduce((acc, f) => acc + (f.totalChars || 0), 0);
    const totalChunksProcessed = completedFiles.reduce((acc, f) => acc + (f.totalChunks || 0), 0);
    const avgChunkTimeOverall = completedFiles.length > 0
        ? completedFiles.reduce((acc, f) => acc + (f.avgChunkTimeMs || 0), 0) / completedFiles.length
        : 0;
    const processingSpeed = totalTime > 0 && totalCharsProcessed > 0
        ? Math.round(totalCharsProcessed / (totalTime / 1000))
        : 0;

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
                    <Box marginTop={1}>
                        <Text dimColor>⌨️  </Text>
                        <KeyboardHint hints={DONE_HINTS} compact={true} />
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
