import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { FileSelector } from './components/FileSelector.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { BatchProgress } from './components/BatchProgress.js';
import { WelcomeScreen } from './components/WelcomeScreen.js';

export type Screen = 'welcome' | 'files' | 'config' | 'processing' | 'done';

export interface TTSConfig {
    voice: string;
    speed: number;
    langCode: string;
    chunkChars: number;
    useMPS: boolean;
}

export interface FileJob {
    id: string;
    inputPath: string;
    outputPath: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    progress: number;
    error?: string;
}

const defaultConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1.0,
    langCode: 'a',
    chunkChars: 1200,
    useMPS: true, // Enable Apple Silicon GPU acceleration by default
};

export function App() {
    const { exit } = useApp();
    const [screen, setScreen] = useState<Screen>('welcome');
    const [files, setFiles] = useState<FileJob[]>([]);
    const [config, setConfig] = useState<TTSConfig>(defaultConfig);

    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
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
        setConfig(newConfig);
        setScreen('processing');
    };

    const handleProcessingComplete = () => {
        setScreen('done');
    };

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
                    <Text color="green">✨ All done! Your audiobooks are ready.</Text>
                    <Box marginTop={1}>
                        {files.map(file => (
                            <Box key={file.id} marginBottom={1}>
                                <Text color="cyan">📁 {file.outputPath}</Text>
                            </Box>
                        ))}
                    </Box>
                    <Text dimColor>Press q to exit</Text>
                </Box>
            )}

            <Box marginTop={1}>
                <Text dimColor>Press q to quit anytime</Text>
            </Box>
        </Box>
    );
}
