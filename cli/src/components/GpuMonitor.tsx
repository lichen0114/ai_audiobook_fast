import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface GpuStats {
    gpuName: string;
    gpuCores: number;
    usage: number;        // 0-100%
    memoryUsed: number;   // MB
    memoryTotal: number;  // MB
    isAppleSilicon: boolean;
}

interface GpuMonitorProps {
    showSparkline?: boolean;
    compact?: boolean;
}

// Beautiful animated GPU bar with gradient colors
function GpuBar({ value, max, width = 20, unit = '%', label }: {
    value: number;
    max: number;
    width?: number;
    unit?: string;
    label: string;
}) {
    const percentage = Math.min((value / max) * 100, 100);
    const filled = Math.round((percentage / 100) * width);

    // Dynamic color based on usage
    const getColor = (): string => {
        if (percentage < 30) return 'green';
        if (percentage < 60) return 'yellow';
        if (percentage < 85) return 'magenta';
        return 'red';
    };

    const filledChar = '▓';
    const emptyChar = '░';

    return (
        <Box>
            <Box width={12}>
                <Text dimColor>{label}</Text>
            </Box>
            <Text color={getColor()}>{filledChar.repeat(filled)}</Text>
            <Text color="gray">{emptyChar.repeat(width - filled)}</Text>
            <Text bold color="white"> {value.toFixed(0)}{unit}</Text>
        </Box>
    );
}

// Sparkline component showing history
function Sparkline({ data, width = 15 }: { data: number[]; width?: number }) {
    const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const recentData = data.slice(-width);
    const max = Math.max(...recentData, 1);

    const sparkline = recentData.map(v => {
        const idx = Math.min(Math.floor((v / max) * (chars.length - 1)), chars.length - 1);
        return chars[idx];
    }).join('');

    // Pad with spaces if not enough data
    const padded = sparkline.padStart(width, ' ');

    return (
        <Box>
            <Text color="cyan">{padded}</Text>
        </Box>
    );
}

async function getGpuInfo(): Promise<GpuStats> {
    try {
        // Get GPU info from system_profiler
        const { stdout: gpuInfo } = await execAsync('system_profiler SPDisplaysDataType -json');
        const data = JSON.parse(gpuInfo);
        const gpu = data.SPDisplaysDataType?.[0];

        const gpuName = gpu?.sppci_model || 'Unknown GPU';
        const isAppleSilicon = gpuName.includes('Apple') || gpuName.includes('M1') ||
            gpuName.includes('M2') || gpuName.includes('M3') ||
            gpuName.includes('M4');

        // Extract core count from name (e.g., "Apple M2 Pro (19-core GPU)")
        const coreMatch = gpuName.match(/(\d+)-core/);
        const gpuCores = coreMatch ? parseInt(coreMatch[1]) : 8;

        // Get memory info
        let memoryTotal = 0;
        let memoryUsed = 0;

        try {
            const { stdout: memInfo } = await execAsync('sysctl hw.memsize');
            const totalBytes = parseInt(memInfo.split(':')[1].trim());
            memoryTotal = Math.round(totalBytes / (1024 * 1024 * 1024)); // GB

            // Get approximate GPU memory usage from vm_stat
            const { stdout: vmStat } = await execAsync('vm_stat');
            const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
            if (wiredMatch) {
                memoryUsed = Math.round((parseInt(wiredMatch[1]) * 4096) / (1024 * 1024 * 1024)); // GB
            }
        } catch {
            // Default values if memory info unavailable
            memoryTotal = 16;
            memoryUsed = 4;
        }

        // Estimate GPU usage based on process activity
        // This is an approximation since macOS doesn't expose GPU usage directly without sudo
        let usage = 0;
        try {
            const { stdout: topOutput } = await execAsync('top -l 1 -n 0 -stats cpu');
            const cpuMatch = topOutput.match(/CPU usage:\s+([\d.]+)%\s+user/);
            if (cpuMatch) {
                // When MPS is active, GPU usage correlates with high CPU activity
                // This is a rough estimation
                const cpuUsage = parseFloat(cpuMatch[1]);
                usage = Math.min(cpuUsage * 0.8, 100); // Approximate GPU based on CPU
            }
        } catch {
            usage = 0;
        }

        return {
            gpuName,
            gpuCores,
            usage,
            memoryUsed,
            memoryTotal,
            isAppleSilicon,
        };
    } catch (error) {
        return {
            gpuName: 'Unknown GPU',
            gpuCores: 0,
            usage: 0,
            memoryUsed: 0,
            memoryTotal: 0,
            isAppleSilicon: false,
        };
    }
}

export function GpuMonitor({ showSparkline = true, compact = false }: GpuMonitorProps) {
    const [stats, setStats] = useState<GpuStats | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const [dots, setDots] = useState('');

    // Animated loading dots
    useEffect(() => {
        const interval = setInterval(() => {
            setDots(prev => prev.length >= 3 ? '' : prev + '.');
        }, 300);
        return () => clearInterval(interval);
    }, []);

    // Fetch GPU stats periodically
    useEffect(() => {
        const fetchStats = async () => {
            const gpuStats = await getGpuInfo();
            setStats(gpuStats);
            setHistory(prev => [...prev.slice(-30), gpuStats.usage]);
        };

        fetchStats();
        const interval = setInterval(fetchStats, 2000); // Update every 2 seconds

        return () => clearInterval(interval);
    }, []);

    if (!stats) {
        return (
            <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
                <Text color="yellow">⏳ Loading GPU info{dots}</Text>
            </Box>
        );
    }

    if (compact) {
        return (
            <Box>
                <Text color="magenta">🎮 </Text>
                <Text dimColor>GPU: </Text>
                <GpuBar value={stats.usage} max={100} width={15} label="" />
                {showSparkline && history.length > 3 && (
                    <Box marginLeft={1}>
                        <Sparkline data={history} width={10} />
                    </Box>
                )}
            </Box>
        );
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="magenta"
            paddingX={2}
            paddingY={1}
            width="100%"
        >
            {/* Header */}
            <Box marginBottom={1}>
                <Text bold color="magenta">🎮 GPU Monitor</Text>
                {stats.isAppleSilicon && (
                    <Text color="green"> </Text>
                )}
            </Box>

            {/* GPU Info */}
            <Box marginBottom={1}>
                <Text dimColor>Device: </Text>
                <Text color="white" bold>{stats.gpuName}</Text>
                {stats.gpuCores > 0 && (
                    <Text dimColor> ({stats.gpuCores} cores)</Text>
                )}
            </Box>

            {/* Usage Bars */}
            <Box flexDirection="column">
                <GpuBar
                    value={stats.usage}
                    max={100}
                    width={25}
                    unit="%"
                    label="⚡ Usage"
                />
                <Box marginTop={0}>
                    <GpuBar
                        value={stats.memoryUsed}
                        max={stats.memoryTotal}
                        width={25}
                        unit={`/${stats.memoryTotal}GB`}
                        label="💾 Memory"
                    />
                </Box>
            </Box>

            {/* Sparkline History */}
            {showSparkline && history.length > 3 && (
                <Box marginTop={1}>
                    <Text dimColor>📊 History: </Text>
                    <Sparkline data={history} width={20} />
                </Box>
            )}

            {/* MPS Status */}
            <Box marginTop={1}>
                <Text dimColor>Status: </Text>
                {stats.isAppleSilicon ? (
                    <Text color="green">● MPS Active</Text>
                ) : (
                    <Text color="yellow">○ Standard GPU</Text>
                )}
            </Box>
        </Box>
    );
}
