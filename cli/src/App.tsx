import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Gradient from 'ink-gradient';
import { Header } from './components/Header.js';
import { SetupRequired } from './components/SetupRequired.js';
import { BatchProgress } from './components/BatchProgress.js';
import { KeyboardHint, DONE_HINTS } from './components/KeyboardHint.js';
import { quickCheck, runPreflightChecks, type PreflightCheck } from './utils/preflight.js';
import { buildOutputPath, resolveInputPatterns } from './utils/input-resolver.js';
import {
    getPreset,
    listPresetNames,
    savePreset,
} from './utils/profile-store.js';
import { checkCheckpoint } from './utils/checkpoint.js';
import { formatBytes, formatDuration } from './utils/format.js';
import { openFolder } from './utils/open-folder.js';
import {
    createDefaultConfig,
    createDefaultProfile,
    type FileJob,
    type RunProfile,
    type TTSConfig,
} from './types/profile.js';
import * as fs from 'fs';
import * as path from 'path';

export type { FileJob, TTSConfig };

type Screen = 'checking' | 'setup-required' | 'dashboard' | 'processing' | 'done';
type FocusPanel = 'files' | 'config' | 'actions';

type Modal =
    | 'none'
    | 'add-files'
    | 'set-output'
    | 'save-preset'
    | 'load-preset'
    | 'voice'
    | 'speed'
    | 'backend'
    | 'bitrate';

const VOICES = [
    { label: '🇺🇸 af_heart  • Female Warm', value: 'af_heart' },
    { label: '🇺🇸 af_bella  • Female Confident', value: 'af_bella' },
    { label: '🇺🇸 af_nicole • Female Friendly', value: 'af_nicole' },
    { label: '🇺🇸 af_sarah  • Female Professional', value: 'af_sarah' },
    { label: '🇺🇸 af_sky    • Female Energetic', value: 'af_sky' },
    { label: '🇺🇸 am_adam   • Male Calm', value: 'am_adam' },
    { label: '🇺🇸 am_michael • Male Authoritative', value: 'am_michael' },
    { label: '🇬🇧 bf_emma   • Female Elegant', value: 'bf_emma' },
    { label: '🇬🇧 bf_isabella • Female Sophisticated', value: 'bf_isabella' },
    { label: '🇬🇧 bm_george • Male Classic', value: 'bm_george' },
    { label: '🇬🇧 bm_lewis  • Male Modern', value: 'bm_lewis' },
];

const SPEEDS = [
    { label: '0.75x  Slow', value: '0.75' },
    { label: '0.90x  Relaxed', value: '0.9' },
    { label: '1.00x  Normal', value: '1.0' },
    { label: '1.10x  Slightly Fast', value: '1.1' },
    { label: '1.25x  Fast', value: '1.25' },
    { label: '1.50x  Very Fast', value: '1.5' },
];

const BACKENDS = [
    { label: 'Auto (recommended)', value: 'auto' },
    { label: 'PyTorch (stable)', value: 'pytorch' },
    { label: 'MLX (Apple Silicon)', value: 'mlx' },
    { label: 'Mock (tests)', value: 'mock' },
];

const BITRATES = [
    { label: '128k  Smaller', value: '128k' },
    { label: '192k  Balanced', value: '192k' },
    { label: '320k  Highest quality', value: '320k' },
];

function panelBorderColor(isFocused: boolean): string {
    return isFocused ? 'cyan' : 'gray';
}

function stepLabel(index: number, total: number, title: string): string {
    return `Step ${index}/${total}: ${title}`;
}

function createJobs(inputs: string[], config: TTSConfig): FileJob[] {
    return inputs.map((inputPath, index) => ({
        id: `${Date.now()}-${index}`,
        inputPath,
        outputPath: buildOutputPath(inputPath, config.outputFormat, config.outputDir),
        status: 'pending',
        progress: 0,
    }));
}

function applyOutputConfig(files: FileJob[], config: TTSConfig): FileJob[] {
    return files.map((file) => ({
        ...file,
        outputPath: buildOutputPath(file.inputPath, config.outputFormat, config.outputDir),
    }));
}

function toProfile(files: FileJob[], config: TTSConfig): RunProfile {
    const profile = createDefaultProfile();
    profile.inputs = files.map((file) => file.inputPath);
    profile.config = {
        ...config,
    };
    profile.metadata = {
        strategy:
            config.metadataTitle || config.metadataAuthor || config.metadataCover
                ? 'override'
                : 'auto',
        title: config.metadataTitle,
        author: config.metadataAuthor,
        cover: config.metadataCover,
    };
    return profile;
}

function fromProfile(profile: RunProfile): TTSConfig {
    return {
        ...createDefaultConfig(),
        ...profile.config,
        metadataTitle: profile.metadata.title,
        metadataAuthor: profile.metadata.author,
        metadataCover: profile.metadata.cover,
    };
}

export function App() {
    const { exit } = useApp();

    const [screen, setScreen] = useState<Screen>('checking');
    const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([]);
    const [files, setFiles] = useState<FileJob[]>([]);
    const [config, setConfig] = useState<TTSConfig>(createDefaultConfig());

    const [totalTime, setTotalTime] = useState<number>(0);
    const [startTime, setStartTime] = useState<number>(0);

    const [focusPanel, setFocusPanel] = useState<FocusPanel>('files');
    const [selectedFileIndex, setSelectedFileIndex] = useState(0);
    const [selectedConfigIndex, setSelectedConfigIndex] = useState(0);
    const [selectedActionIndex, setSelectedActionIndex] = useState(0);

    const [modal, setModal] = useState<Modal>('none');
    const [modalInput, setModalInput] = useState('');
    const [modalError, setModalError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState('Load EPUBs, tune settings, then press p to process.');
    const [helpOpen, setHelpOpen] = useState(false);
    const [checkpointByJobId, setCheckpointByJobId] = useState<Record<string, string>>({});

    const [presetNames, setPresetNames] = useState<string[]>([]);

    const actionItems = useMemo(
        () => [
            { id: 'add-files', label: 'Add EPUB files' },
            { id: 'remove-file', label: 'Remove selected file' },
            { id: 'toggle-format', label: `Toggle format (${config.outputFormat.toUpperCase()})` },
            { id: 'toggle-normalize', label: `Toggle normalize (${config.normalize ? 'ON' : 'OFF'})` },
            { id: 'toggle-checkpoint', label: `Toggle checkpoint (${config.checkpointEnabled ? 'ON' : 'OFF'})` },
            { id: 'toggle-resume', label: `Toggle resume (${config.resume ? 'ON' : 'OFF'})` },
            { id: 'save-preset', label: 'Save preset' },
            { id: 'load-preset', label: 'Load preset' },
            { id: 'start', label: 'Start processing' },
        ],
        [config]
    );

    const configRows = useMemo(
        () => [
            { id: 'voice', label: 'Voice', value: config.voice },
            { id: 'accent', label: 'Accent', value: config.langCode === 'a' ? 'American (a)' : 'British (b)' },
            { id: 'speed', label: 'Speed', value: `${config.speed.toFixed(2)}x` },
            { id: 'backend', label: 'Backend', value: config.backend },
            { id: 'format', label: 'Output format', value: config.outputFormat.toUpperCase() },
            { id: 'bitrate', label: 'Bitrate', value: config.bitrate },
            { id: 'normalize', label: 'Normalize', value: config.normalize ? 'ON' : 'OFF' },
            { id: 'checkpoint', label: 'Checkpoint', value: config.checkpointEnabled ? 'ON' : 'OFF' },
            { id: 'resume', label: 'Resume', value: config.resume ? 'ON' : 'OFF' },
            {
                id: 'output',
                label: 'Output dir',
                value: config.outputDir || 'same as input',
            },
        ],
        [config]
    );

    useEffect(() => {
        if (screen !== 'checking') {
            return;
        }

        const result = quickCheck() ? runPreflightChecks() : runPreflightChecks();
        if (result.passed) {
            setScreen('dashboard');
            setStatusMessage('Environment is healthy. Ready for a run.');
        } else {
            setPreflightChecks(result.checks);
            setScreen('setup-required');
        }
    }, [screen]);

    useEffect(() => {
        setFiles((prev) => applyOutputConfig(prev, config));
    }, [config.outputDir, config.outputFormat]);

    useEffect(() => {
        if (files.length === 0 || screen !== 'dashboard') {
            return;
        }

        const selected = files[Math.min(selectedFileIndex, files.length - 1)];
        if (!selected) {
            return;
        }

        let cancelled = false;

        checkCheckpoint(selected.inputPath, selected.outputPath)
            .then((status) => {
                if (cancelled) {
                    return;
                }

                if (status.exists && status.valid && status.totalChunks && status.completedChunks) {
                    setCheckpointByJobId((prev) => ({
                        ...prev,
                        [selected.id]: `${status.completedChunks}/${status.totalChunks}`,
                    }));
                } else if (status.exists && !status.valid) {
                    setCheckpointByJobId((prev) => ({
                        ...prev,
                        [selected.id]: 'invalid',
                    }));
                } else {
                    setCheckpointByJobId((prev) => ({
                        ...prev,
                        [selected.id]: 'none',
                    }));
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCheckpointByJobId((prev) => ({
                        ...prev,
                        [selected.id]: 'check failed',
                    }));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [files, selectedFileIndex, screen]);

    const completedFiles = files.filter((file) => file.status === 'done');
    const errorFiles = files.filter((file) => file.status === 'error');

    const totalOutputSize = completedFiles.reduce((acc, file) => acc + (file.outputSize || 0), 0);

    const resetBatch = () => {
        setFiles([]);
        setSelectedFileIndex(0);
        setSelectedActionIndex(0);
        setSelectedConfigIndex(0);
        setStartTime(0);
        setTotalTime(0);
        setScreen('dashboard');
        setStatusMessage('New batch started. Add files to continue.');
    };

    const startProcessing = () => {
        if (files.length === 0) {
            setStatusMessage('Add at least one EPUB before starting.');
            return;
        }

        const resetJobs = files.map((file) => ({
            ...file,
            status: 'pending' as const,
            progress: 0,
            error: undefined,
            currentChunk: undefined,
            totalChunks: undefined,
            outputSize: undefined,
        }));

        setFiles(resetJobs);
        setStartTime(Date.now());
        setScreen('processing');
    };

    const handleProcessingComplete = () => {
        setTotalTime(Date.now() - startTime);

        setFiles((prev) =>
            prev.map((file) => {
                if (file.status === 'done' && fs.existsSync(file.outputPath)) {
                    return {
                        ...file,
                        outputSize: fs.statSync(file.outputPath).size,
                    };
                }
                return file;
            })
        );

        setScreen('done');
    };

    const openPresetSave = () => {
        setModalInput('');
        setModalError(null);
        setModal('save-preset');
    };

    const openPresetLoad = () => {
        const names = listPresetNames();
        setPresetNames(names);
        setModalError(null);
        setModal('load-preset');
    };

    const executeAction = (actionId: string) => {
        switch (actionId) {
            case 'add-files':
                setModalInput('');
                setModalError(null);
                setModal('add-files');
                return;
            case 'remove-file':
                if (files.length === 0) {
                    setStatusMessage('No files to remove.');
                    return;
                }
                setFiles((prev) => prev.filter((_, index) => index !== selectedFileIndex));
                setSelectedFileIndex((prev) => Math.max(0, prev - 1));
                setStatusMessage('Removed selected file from batch.');
                return;
            case 'toggle-format':
                setConfig((prev) => ({ ...prev, outputFormat: prev.outputFormat === 'mp3' ? 'm4b' : 'mp3' }));
                return;
            case 'toggle-normalize':
                setConfig((prev) => ({ ...prev, normalize: !prev.normalize }));
                return;
            case 'toggle-checkpoint':
                setConfig((prev) => ({ ...prev, checkpointEnabled: !prev.checkpointEnabled }));
                return;
            case 'toggle-resume':
                setConfig((prev) => ({ ...prev, resume: !prev.resume, checkpointEnabled: true }));
                return;
            case 'save-preset':
                openPresetSave();
                return;
            case 'load-preset':
                openPresetLoad();
                return;
            case 'start':
                startProcessing();
                return;
            default:
                return;
        }
    };

    const openConfigEditor = (configId: string) => {
        if (configId === 'voice') {
            setModal('voice');
            return;
        }
        if (configId === 'speed') {
            setModal('speed');
            return;
        }
        if (configId === 'backend') {
            setModal('backend');
            return;
        }
        if (configId === 'bitrate') {
            setModal('bitrate');
            return;
        }
        if (configId === 'output') {
            setModalInput(config.outputDir || '');
            setModal('set-output');
            return;
        }

        if (configId === 'accent') {
            setConfig((prev) => ({ ...prev, langCode: prev.langCode === 'a' ? 'b' : 'a' }));
            return;
        }
        if (configId === 'format') {
            setConfig((prev) => ({ ...prev, outputFormat: prev.outputFormat === 'mp3' ? 'm4b' : 'mp3' }));
            return;
        }
        if (configId === 'normalize') {
            setConfig((prev) => ({ ...prev, normalize: !prev.normalize }));
            return;
        }
        if (configId === 'checkpoint') {
            setConfig((prev) => ({ ...prev, checkpointEnabled: !prev.checkpointEnabled }));
            return;
        }
        if (configId === 'resume') {
            setConfig((prev) => ({ ...prev, resume: !prev.resume, checkpointEnabled: true }));
            return;
        }
    };

    const refreshDoctor = () => {
        const result = runPreflightChecks();
        if (result.passed) {
            setStatusMessage('Doctor passed. Environment healthy.');
        } else {
            setStatusMessage('Doctor found setup issues.');
        }
        setPreflightChecks(result.checks);
    };

    const handleTextModalSubmit = async () => {
        setModalError(null);

        if (modal === 'add-files') {
            const input = modalInput.trim();
            if (!input) {
                setModalError('Enter a path, directory, or glob pattern.');
                return;
            }

            const resolved = await resolveInputPatterns([input]);
            if (resolved.length === 0) {
                setModalError('No EPUB files found.');
                return;
            }

            const nextFiles = [
                ...files,
                ...createJobs(resolved, config),
            ];
            setFiles(nextFiles);
            setSelectedFileIndex(Math.max(0, nextFiles.length - resolved.length));
            setModal('none');
            setModalInput('');
            setStatusMessage(`Added ${resolved.length} EPUB file${resolved.length === 1 ? '' : 's'}.`);
            return;
        }

        if (modal === 'set-output') {
            const value = modalInput.trim();
            setConfig((prev) => ({
                ...prev,
                outputDir: value.length > 0 ? path.resolve(process.cwd(), value) : null,
            }));
            setModal('none');
            setModalInput('');
            return;
        }

        if (modal === 'save-preset') {
            const name = modalInput.trim();
            if (!name) {
                setModalError('Preset name is required.');
                return;
            }

            const profile = toProfile(files, config);
            profile.name = name;
            savePreset(name, profile);
            setModal('none');
            setModalInput('');
            setStatusMessage(`Saved preset "${name}".`);
            return;
        }
    };

    const handlePresetSelection = async (name: string) => {
        const preset = getPreset(name);
        if (!preset) {
            setStatusMessage(`Preset "${name}" not found.`);
            setModal('none');
            return;
        }

        const nextConfig = fromProfile(preset);
        setConfig(nextConfig);

        const resolvedInputs = await resolveInputPatterns(preset.inputs);
        setFiles(createJobs(resolvedInputs, nextConfig));
        setSelectedFileIndex(0);
        setModal('none');
        setStatusMessage(`Loaded preset "${name}" with ${resolvedInputs.length} input(s).`);
    };

    useInput((input, key) => {
        if (input === 'q' || (key.ctrl && input === 'c')) {
            exit();
            return;
        }

        if (screen === 'done') {
            if (input === 'o' && completedFiles.length > 0) {
                openFolder(path.dirname(completedFiles[0].outputPath));
                return;
            }
            if (input === 'n') {
                resetBatch();
                return;
            }
            return;
        }

        if (screen === 'setup-required') {
            if (input === 'r') {
                setScreen('checking');
            }
            return;
        }

        if (screen !== 'dashboard') {
            return;
        }

        if (modal !== 'none') {
            if (key.escape) {
                setModal('none');
                setModalInput('');
                setModalError(null);
            }
            return;
        }

        if (helpOpen) {
            if (input === '?' || key.escape) {
                setHelpOpen(false);
            }
            return;
        }

        if (input === '?') {
            setHelpOpen(true);
            return;
        }

        if (key.ctrl && input === 'r') {
            refreshDoctor();
            return;
        }

        if (key.ctrl && input === 's') {
            openPresetSave();
            return;
        }

        if (key.ctrl && input === 'l') {
            openPresetLoad();
            return;
        }

        if (key.ctrl && input === '.') {
            resetBatch();
            return;
        }

        if (input === '1') {
            setFocusPanel('files');
            return;
        }
        if (input === '2') {
            setFocusPanel('config');
            return;
        }
        if (input === '5') {
            setFocusPanel('actions');
            return;
        }

        if (input === 'p') {
            startProcessing();
            return;
        }

        if (input === 'r') {
            setConfig((prev) => ({ ...prev, resume: true, checkpointEnabled: true }));
            setStatusMessage('Resume enabled for next run.');
            return;
        }

        if (key.tab) {
            setFocusPanel((prev) => {
                if (prev === 'files') return 'config';
                if (prev === 'config') return 'actions';
                return 'files';
            });
            return;
        }

        if (key.shift && key.tab) {
            setFocusPanel((prev) => {
                if (prev === 'files') return 'actions';
                if (prev === 'actions') return 'config';
                return 'files';
            });
            return;
        }

        if (key.downArrow) {
            if (focusPanel === 'files') {
                setSelectedFileIndex((prev) => Math.min(prev + 1, Math.max(0, files.length - 1)));
            } else if (focusPanel === 'config') {
                setSelectedConfigIndex((prev) => Math.min(prev + 1, configRows.length - 1));
            } else {
                setSelectedActionIndex((prev) => Math.min(prev + 1, actionItems.length - 1));
            }
            return;
        }

        if (key.upArrow) {
            if (focusPanel === 'files') {
                setSelectedFileIndex((prev) => Math.max(prev - 1, 0));
            } else if (focusPanel === 'config') {
                setSelectedConfigIndex((prev) => Math.max(prev - 1, 0));
            } else {
                setSelectedActionIndex((prev) => Math.max(prev - 1, 0));
            }
            return;
        }

        if (key.return) {
            if (focusPanel === 'config') {
                const target = configRows[selectedConfigIndex];
                if (target) {
                    openConfigEditor(target.id);
                }
                return;
            }

            if (focusPanel === 'actions') {
                const target = actionItems[selectedActionIndex];
                if (target) {
                    executeAction(target.id);
                }
                return;
            }

            if (focusPanel === 'files') {
                if (files.length > 0) {
                    const target = files[selectedFileIndex];
                    setStatusMessage(`Selected ${path.basename(target.inputPath)}.`);
                }
            }
        }
    });

    if (screen === 'checking') {
        return (
            <Box flexDirection="column" padding={1}>
                <Header />
                <Box marginTop={1} paddingX={2}>
                    <Text dimColor>Running environment checks...</Text>
                </Box>
            </Box>
        );
    }

    if (screen === 'setup-required') {
        return (
            <Box flexDirection="column" padding={1}>
                <Header />
                <SetupRequired
                    checks={preflightChecks}
                    onRetry={() => {
                        setScreen('checking');
                    }}
                />
            </Box>
        );
    }

    if (screen === 'processing') {
        return (
            <Box flexDirection="column" padding={1}>
                <Header />
                <BatchProgress
                    files={files}
                    setFiles={setFiles}
                    config={config}
                    onComplete={handleProcessingComplete}
                />
                <Box marginTop={1}>
                    <KeyboardHint
                        hints={[
                            { key: 'q', action: 'quit' },
                            { key: 'Ctrl+C', action: 'quit' },
                        ]}
                        compact={true}
                    />
                </Box>
            </Box>
        );
    }

    if (screen === 'done') {
        return (
            <Box flexDirection="column" padding={1}>
                <Header />
                <Box flexDirection="column" marginTop={1}>
                    <Box marginBottom={1}>
                        <Text color="green" bold>Batch completed</Text>
                        <Text>  {completedFiles.length} success • {errorFiles.length} failed</Text>
                    </Box>

                    <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} marginBottom={1}>
                        <Box flexDirection="column">
                            <Text dimColor>Total output size: <Text color="cyan">{formatBytes(totalOutputSize)}</Text></Text>
                            <Text dimColor>Elapsed time: <Text color="yellow">{formatDuration(totalTime)}</Text></Text>
                        </Box>
                    </Box>

                    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1}>
                        <Box flexDirection="column">
                            {completedFiles.map((file) => (
                                <Box key={file.id}>
                                    <Text color="green">✔ </Text>
                                    <Text>{path.basename(file.outputPath)}</Text>
                                    {file.outputSize ? <Text dimColor> ({formatBytes(file.outputSize)})</Text> : null}
                                </Box>
                            ))}
                            {errorFiles.map((file) => (
                                <Box key={file.id}>
                                    <Text color="red">✘ </Text>
                                    <Text>{path.basename(file.inputPath)}</Text>
                                    {file.error ? <Text dimColor> - {file.error}</Text> : null}
                                </Box>
                            ))}
                        </Box>
                    </Box>

                    <Box>
                        <KeyboardHint hints={DONE_HINTS} compact={true} />
                    </Box>
                </Box>
            </Box>
        );
    }

    const selectedFile = files[selectedFileIndex];

    return (
        <Box flexDirection="column" padding={1}>
            <Header />

            <Box marginTop={1} marginBottom={1}>
                <Gradient name="morning">
                    <Text bold>{stepLabel(3, 3, 'Dashboard')}</Text>
                </Gradient>
                <Text dimColor>  •  {files.length} file{files.length === 1 ? '' : 's'} queued</Text>
            </Box>

            <Box flexDirection="row" width="100%">
                <Box
                    flexDirection="column"
                    width="34%"
                    borderStyle="round"
                    borderColor={panelBorderColor(focusPanel === 'files')}
                    paddingX={1}
                    marginRight={1}
                >
                    <Text bold color={focusPanel === 'files' ? 'cyan' : 'white'}>Files (1)</Text>
                    <Box flexDirection="column" marginTop={1}>
                        {files.length === 0 ? (
                            <Text dimColor>No files yet. Use action "Add EPUB files".</Text>
                        ) : (
                            files.map((file, index) => (
                                <Box key={file.id}>
                                    <Text color={index === selectedFileIndex ? 'yellow' : 'gray'}>
                                        {index === selectedFileIndex ? '▶ ' : '  '}
                                    </Text>
                                    <Text color={index === selectedFileIndex ? 'white' : 'gray'}>
                                        {path.basename(file.inputPath)}
                                    </Text>
                                    <Text dimColor>
                                        {' '}
                                        [{checkpointByJobId[file.id] || 'unknown'}]
                                    </Text>
                                </Box>
                            ))
                        )}
                    </Box>
                </Box>

                <Box
                    flexDirection="column"
                    width="40%"
                    borderStyle="round"
                    borderColor={panelBorderColor(focusPanel === 'config')}
                    paddingX={1}
                    marginRight={1}
                >
                    <Text bold color={focusPanel === 'config' ? 'cyan' : 'white'}>Config (2)</Text>
                    <Box flexDirection="column" marginTop={1}>
                        {configRows.map((row, index) => (
                            <Box key={row.id}>
                                <Text color={index === selectedConfigIndex ? 'yellow' : 'gray'}>
                                    {index === selectedConfigIndex ? '▶ ' : '  '}
                                </Text>
                                <Text>{row.label}: </Text>
                                <Text color="green">{row.value}</Text>
                            </Box>
                        ))}
                    </Box>
                </Box>

                <Box
                    flexDirection="column"
                    width="26%"
                    borderStyle="round"
                    borderColor={panelBorderColor(focusPanel === 'actions')}
                    paddingX={1}
                >
                    <Text bold color={focusPanel === 'actions' ? 'cyan' : 'white'}>Quick Actions (5)</Text>
                    <Box flexDirection="column" marginTop={1}>
                        {actionItems.map((item, index) => (
                            <Box key={item.id}>
                                <Text color={index === selectedActionIndex ? 'yellow' : 'gray'}>
                                    {index === selectedActionIndex ? '▶ ' : '  '}
                                </Text>
                                <Text>{item.label}</Text>
                            </Box>
                        ))}
                    </Box>
                </Box>
            </Box>

            <Box
                marginTop={1}
                borderStyle="round"
                borderColor="magenta"
                paddingX={2}
                paddingY={1}
            >
                <Box flexDirection="column">
                    <Text color="magenta" bold>Status</Text>
                    <Text>{statusMessage}</Text>
                    {selectedFile ? (
                        <Text dimColor>
                            Selected output: {selectedFile.outputPath}
                        </Text>
                    ) : null}
                </Box>
            </Box>

            <Box marginTop={1}>
                <KeyboardHint
                    hints={[
                        { key: 'Tab', action: 'switch panel' },
                        { key: '1/2/5', action: 'jump panel' },
                        { key: 'Enter', action: 'edit/apply' },
                        { key: 'p', action: 'start' },
                        { key: '?', action: 'help' },
                        { key: 'Ctrl+S', action: 'save preset' },
                        { key: 'Ctrl+L', action: 'load preset' },
                        { key: 'Ctrl+R', action: 'doctor' },
                        { key: 'q', action: 'quit' },
                    ]}
                    compact={true}
                />
            </Box>

            {helpOpen && (
                <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="yellow" bold>Keyboard Help</Text>
                        <Text>Tab/Shift+Tab: move between files/config/actions</Text>
                        <Text>Enter: edit selected config row or execute action</Text>
                        <Text>p: start processing  •  r: force resume mode on</Text>
                        <Text>Ctrl+S: save preset  •  Ctrl+L: load preset</Text>
                        <Text>Ctrl+R: re-run doctor checks</Text>
                        <Text>Esc or ?: close this help card</Text>
                    </Box>
                </Box>
            )}

            {modal === 'add-files' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Add EPUB files</Text>
                        <Text dimColor>Enter file path, directory, or glob pattern</Text>
                        <Box>
                            <Text color="green">❯ </Text>
                            <TextInput
                                value={modalInput}
                                onChange={setModalInput}
                                onSubmit={() => {
                                    void handleTextModalSubmit();
                                }}
                                placeholder="./books/*.epub"
                            />
                        </Box>
                        {modalError ? <Text color="red">{modalError}</Text> : null}
                        <Text dimColor>Enter to confirm • Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'set-output' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Set output directory</Text>
                        <Text dimColor>Leave empty to use input folder</Text>
                        <Box>
                            <Text color="green">❯ </Text>
                            <TextInput
                                value={modalInput}
                                onChange={setModalInput}
                                onSubmit={() => {
                                    void handleTextModalSubmit();
                                }}
                                placeholder="./output"
                            />
                        </Box>
                        <Text dimColor>Enter to confirm • Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'save-preset' && (
                <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="green" bold>Save preset</Text>
                        <Box>
                            <Text color="green">❯ </Text>
                            <TextInput
                                value={modalInput}
                                onChange={setModalInput}
                                onSubmit={() => {
                                    void handleTextModalSubmit();
                                }}
                                placeholder="weekday-batch"
                            />
                        </Box>
                        {modalError ? <Text color="red">{modalError}</Text> : null}
                        <Text dimColor>Enter to save • Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'load-preset' && (
                <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="green" bold>Load preset</Text>
                        {presetNames.length === 0 ? (
                            <Text dimColor>No presets found. Save one first.</Text>
                        ) : (
                            <SelectInput
                                items={presetNames.map((name) => ({ label: name, value: name }))}
                                onSelect={(item) => {
                                    void handlePresetSelection(item.value);
                                }}
                            />
                        )}
                        <Text dimColor>Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'voice' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Select voice</Text>
                        <SelectInput
                            items={VOICES}
                            onSelect={(item) => {
                                setConfig((prev) => ({ ...prev, voice: item.value }));
                                setModal('none');
                            }}
                            initialIndex={Math.max(0, VOICES.findIndex((item) => item.value === config.voice))}
                        />
                        <Text dimColor>Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'speed' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Select speed</Text>
                        <SelectInput
                            items={SPEEDS}
                            onSelect={(item) => {
                                setConfig((prev) => ({ ...prev, speed: parseFloat(item.value) }));
                                setModal('none');
                            }}
                            initialIndex={Math.max(0, SPEEDS.findIndex((item) => parseFloat(item.value) === config.speed))}
                        />
                        <Text dimColor>Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'backend' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Select backend</Text>
                        <SelectInput
                            items={BACKENDS}
                            onSelect={(item) => {
                                setConfig((prev) => ({ ...prev, backend: item.value as TTSConfig['backend'] }));
                                setModal('none');
                            }}
                            initialIndex={Math.max(0, BACKENDS.findIndex((item) => item.value === config.backend))}
                        />
                        <Text dimColor>Esc to cancel</Text>
                    </Box>
                </Box>
            )}

            {modal === 'bitrate' && (
                <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
                    <Box flexDirection="column">
                        <Text color="cyan" bold>Select bitrate</Text>
                        <SelectInput
                            items={BITRATES}
                            onSelect={(item) => {
                                setConfig((prev) => ({ ...prev, bitrate: item.value as TTSConfig['bitrate'] }));
                                setModal('none');
                            }}
                            initialIndex={Math.max(0, BITRATES.findIndex((item) => item.value === config.bitrate))}
                        />
                        <Text dimColor>Esc to cancel</Text>
                    </Box>
                </Box>
            )}
        </Box>
    );
}
