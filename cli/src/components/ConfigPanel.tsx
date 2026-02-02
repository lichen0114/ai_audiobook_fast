import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import * as path from 'path';
import type { TTSConfig, FileJob } from '../App.js';

interface ConfigPanelProps {
    files: FileJob[];
    config: TTSConfig;
    onConfirm: (config: TTSConfig) => void;
    onBack: () => void;
}

const voices = [
    { label: '💜 af_heart (American Female - Warm)', value: 'af_heart' },
    { label: '💙 af_bella (American Female - Confident)', value: 'af_bella' },
    { label: '💚 af_nicole (American Female - Friendly)', value: 'af_nicole' },
    { label: '🧡 af_sarah (American Female - Professional)', value: 'af_sarah' },
    { label: '💛 af_sky (American Female - Energetic)', value: 'af_sky' },
    { label: '🤍 am_adam (American Male - Calm)', value: 'am_adam' },
    { label: '🩵 am_michael (American Male - Authoritative)', value: 'am_michael' },
    { label: '🩷 bf_emma (British Female - Elegant)', value: 'bf_emma' },
    { label: '💜 bf_isabella (British Female - Sophisticated)', value: 'bf_isabella' },
    { label: '🩶 bm_george (British Male - Classic)', value: 'bm_george' },
    { label: '🤎 bm_lewis (British Male - Modern)', value: 'bm_lewis' },
];

const speeds = [
    { label: '🐢 0.75x - Slow', value: '0.75' },
    { label: '⏸️  0.9x - Relaxed', value: '0.9' },
    { label: '▶️  1.0x - Normal', value: '1.0' },
    { label: '⏩ 1.1x - Slightly Fast', value: '1.1' },
    { label: '🐇 1.25x - Fast', value: '1.25' },
    { label: '🚀 1.5x - Very Fast', value: '1.5' },
];

type ConfigStep = 'voice' | 'speed' | 'workers' | 'gpu' | 'output' | 'output_custom' | 'confirm';

export function ConfigPanel({ files, config, onConfirm, onBack }: ConfigPanelProps) {
    const [step, setStep] = useState<ConfigStep>('voice');
    const [selectedVoice, setSelectedVoice] = useState(config.voice);
    const [selectedSpeed, setSelectedSpeed] = useState(config.speed);
    const [selectedWorkers, setSelectedWorkers] = useState(config.workers || 2);
    const [useMPS, setUseMPS] = useState(config.useMPS);
    const [outputDir, setOutputDir] = useState<string | null>(config.outputDir);
    const [customPath, setCustomPath] = useState('');

    useInput((input, key) => {
        if (key.escape || (step === 'voice' && key.backspace)) {
            onBack();
        }
    });

    const handleVoiceSelect = (item: { value: string }) => {
        setSelectedVoice(item.value);
        setStep('speed');
    };

    const handleSpeedSelect = (item: { value: string }) => {
        setSelectedSpeed(parseFloat(item.value));
        setStep('workers');
    };

    const handleWorkerSelect = (item: { value: string }) => {
        setSelectedWorkers(parseInt(item.value));
        setStep('gpu');
    };

    const handleGPUSelect = (item: { value: string }) => {
        setUseMPS(item.value === 'on');
        setStep('output');
    };

    const handleOutputSelect = (item: { value: string }) => {
        if (item.value === 'same') {
            setOutputDir(null);
            setStep('confirm');
        } else if (item.value === 'custom') {
            setStep('output_custom');
        }
    };

    const handleCustomPathSubmit = (value: string) => {
        if (value.trim()) {
            const resolvedPath = path.resolve(process.cwd(), value.trim());
            setOutputDir(resolvedPath);
            setStep('confirm');
        }
    };

    const handleConfirm = (item: { value: string }) => {
        if (item.value === 'start') {
            onConfirm({
                ...config,
                voice: selectedVoice,
                speed: selectedSpeed,
                workers: selectedWorkers,
                useMPS,
                outputDir,
            });
        } else if (item.value === 'voice') {
            setStep('voice');
        } else if (item.value === 'speed') {
            setStep('speed');
        } else if (item.value === 'workers') {
            setStep('workers');
        } else if (item.value === 'gpu') {
            setStep('gpu');
        } else if (item.value === 'output') {
            setStep('output');
        }
    };

    const getVoiceLabel = (value: string) =>
        voices.find(v => v.value === value)?.label || value;

    const getSpeedLabel = (value: number) =>
        speeds.find(s => parseFloat(s.value) === value)?.label || `${value}x`;

    const getOutputLabel = () => {
        if (!outputDir) return 'Same as input file';
        return outputDir;
    };

    return (
        <Box flexDirection="column" paddingX={2}>
            <Box marginBottom={1}>
                <Text color="cyan">⚙️  Configuration</Text>
            </Box>

            {/* Summary Box */}
            <Box
                flexDirection="column"
                borderStyle="round"
                borderColor="gray"
                paddingX={2}
                paddingY={1}
                marginBottom={1}
            >
                <Text color="white" bold>Current Settings:</Text>
                <Box marginTop={1} flexDirection="column">
                    <Text>
                        📚 Files: <Text color="cyan">{files.length}</Text>
                    </Text>
                    <Text>
                        🎙️  Voice: <Text color={step === 'voice' ? 'yellow' : 'green'}>{getVoiceLabel(selectedVoice)}</Text>
                    </Text>
                    <Text>
                        ⚡ Speed: <Text color={step === 'speed' ? 'yellow' : 'green'}>{getSpeedLabel(selectedSpeed)}</Text>
                    </Text>
                    <Text>
                        🔨 Workers: <Text color={step === 'workers' ? 'yellow' : 'green'}>{selectedWorkers}</Text>
                    </Text>
                    <Text>
                        🍎 GPU (Apple Silicon): <Text color={step === 'gpu' ? 'yellow' : useMPS ? 'green' : 'gray'}>{useMPS ? 'Enabled ⚡' : 'Disabled'}</Text>
                    </Text>
                    <Text>
                        📁 Output: <Text color={step === 'output' || step === 'output_custom' ? 'yellow' : 'green'}>{getOutputLabel()}</Text>
                    </Text>
                </Box>
            </Box>

            {/* Voice Selection */}
            {step === 'voice' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Select a voice:</Text>
                    <Box marginTop={1}>
                        <SelectInput items={voices} onSelect={handleVoiceSelect} />
                    </Box>
                </Box>
            )}

            {/* Speed Selection */}
            {step === 'speed' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Select reading speed:</Text>
                    <Box marginTop={1}>
                        <SelectInput
                            items={speeds}
                            onSelect={handleSpeedSelect}
                            initialIndex={speeds.findIndex(s => s.value === '1.0')}
                        />
                    </Box>
                </Box>
            )}

            {/* Worker Selection */}
            {step === 'workers' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Select number of parallel workers:</Text>
                    <Text dimColor>On Apple Silicon, 1-2 workers is optimal (GPU serializes operations)</Text>
                    <Box marginTop={1}>
                        <SelectInput
                            items={[
                                { label: '1 Worker (Recommended for MPS)', value: '1' },
                                { label: '2 Workers (Balanced)', value: '2' },
                                { label: '4 Workers (Max for Apple Silicon)', value: '4' },
                            ]}
                            onSelect={handleWorkerSelect}
                            initialIndex={Math.max(0, [1, 2, 4].indexOf(selectedWorkers > 4 ? 4 : selectedWorkers || 2))}
                        />
                    </Box>
                </Box>
            )}

            {/* GPU Acceleration Selection */}
            {step === 'gpu' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Apple Silicon GPU Acceleration (MPS):</Text>
                    <Text dimColor>Enable for faster processing on M1/M2/M3 Macs</Text>
                    <Box marginTop={1}>
                        <SelectInput
                            items={[
                                { label: '⚡ Enable GPU Acceleration', value: 'on' },
                                { label: '💤 Disable (Use CPU)', value: 'off' },
                            ]}
                            onSelect={handleGPUSelect}
                            initialIndex={useMPS ? 0 : 1}
                        />
                    </Box>
                </Box>
            )}

            {/* Output Directory Selection */}
            {step === 'output' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Where to save output files?</Text>
                    <Box marginTop={1}>
                        <SelectInput
                            items={[
                                { label: '📂 Same folder as input file', value: 'same' },
                                { label: '📁 Custom directory...', value: 'custom' },
                            ]}
                            onSelect={handleOutputSelect}
                        />
                    </Box>
                </Box>
            )}

            {/* Custom Output Path Input */}
            {step === 'output_custom' && (
                <Box flexDirection="column">
                    <Text color="yellow" bold>Enter output directory path:</Text>
                    <Text dimColor>Relative or absolute path. Directory will be created if needed.</Text>
                    <Box marginTop={1}>
                        <Text color="green" bold>{'❯ '}</Text>
                        <TextInput
                            value={customPath}
                            onChange={setCustomPath}
                            onSubmit={handleCustomPathSubmit}
                            placeholder="./output or /path/to/audiobooks"
                        />
                    </Box>
                </Box>
            )}

            {/* Confirmation */}
            {step === 'confirm' && (
                <Box flexDirection="column">
                    <Text color="green" bold>Ready to process! 🚀</Text>
                    <Box marginTop={1}>
                        <SelectInput
                            items={[
                                { label: '✅ Start Processing', value: 'start' },
                                { label: '🎙️  Change Voice', value: 'voice' },
                                { label: '⚡ Change Speed', value: 'speed' },
                                { label: '🔨 Change Workers', value: 'workers' },
                                { label: '🍎 Toggle GPU Acceleration', value: 'gpu' },
                                { label: '📁 Change Output Directory', value: 'output' },
                            ]}
                            onSelect={handleConfirm}
                        />
                    </Box>
                </Box>
            )}

            <Box marginTop={1}>
                <Text dimColor>Press ESC to go back</Text>
            </Box>
        </Box>
    );
}

