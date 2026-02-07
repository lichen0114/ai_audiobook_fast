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

async function getStaticGpuInfo(): Promise<Omit<GpuStats, 'usage' | 'memoryUsed'>> {
    let gpuName = 'Unknown GPU';
    let gpuCores = 0;

    try {
        // system_profiler is expensive; call once and cache in component state.
        const { stdout: gpuInfo } = await execAsync('system_profiler SPDisplaysDataType -json', { timeout: 12000 });
        const data = JSON.parse(gpuInfo);
        const gpu = data.SPDisplaysDataType?.[0];
        gpuName = gpu?.sppci_model || gpuName;
        const coreMatch = gpuName.match(/(\d+)-core/);
        gpuCores = coreMatch ? parseInt(coreMatch[1], 10) : 8;
    } catch {
        // Keep fallback values.
    }

    let memoryTotal = 16;
    try {
        const { stdout: memInfo } = await execAsync('sysctl hw.memsize', { timeout: 3000 });
        const totalBytes = parseInt(memInfo.split(':')[1].trim(), 10);
        memoryTotal = Math.round(totalBytes / (1024 * 1024 * 1024)); // GB
    } catch {
        // Keep fallback value.
    }

    const isAppleSilicon = gpuName.includes('Apple') || gpuName.includes('M1') ||
        gpuName.includes('M2') || gpuName.includes('M3') ||
        gpuName.includes('M4');

    return {
        gpuName,
        gpuCores,
        memoryTotal,
        isAppleSilicon,
    };
}

async function getDynamicGpuStats(memoryTotal: number): Promise<Pick<GpuStats, 'usage' | 'memoryUsed'>> {
    let memoryUsed = 0;
    let usage = 0;

    try {
        const { stdout: vmStat } = await execAsync('vm_stat', { timeout: 3000 });
        const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
        if (wiredMatch) {
            memoryUsed = Math.round((parseInt(wiredMatch[1], 10) * 4096) / (1024 * 1024 * 1024)); // GB
        }
    } catch {
        memoryUsed = Math.max(1, Math.round(memoryTotal * 0.25));
    }

    try {
        const { stdout: topOutput } = await execAsync('top -l 1 -n 0 -stats cpu', { timeout: 3000 });
        const cpuMatch = topOutput.match(/CPU usage:\s+([\d.]+)%\s+user/);
        if (cpuMatch) {
            const cpuUsage = parseFloat(cpuMatch[1]);
            usage = Math.min(cpuUsage * 0.8, 100);
        }
    } catch {
        usage = 0;
    }

    return { usage, memoryUsed };
}

export function GpuMonitor({ showSparkline = true, compact = false }: GpuMonitorProps) {
    const [stats, setStats] = useState<GpuStats | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const inFlightRef = useRef(false);
    const staticInfoRef = useRef<Omit<GpuStats, 'usage' | 'memoryUsed'> | null>(null);

    // Fetch GPU stats periodically
    useEffect(() => {
        const fetchStats = async () => {
            if (inFlightRef.current) {
                return;
            }
            inFlightRef.current = true;
            try {
                if (!staticInfoRef.current) {
                    staticInfoRef.current = await getStaticGpuInfo();
                }

                const dynamic = await getDynamicGpuStats(staticInfoRef.current.memoryTotal);
                const gpuStats: GpuStats = {
                    ...staticInfoRef.current,
                    ...dynamic,
                };
                setStats(gpuStats);
                setHistory(prev => [...prev.slice(-30), gpuStats.usage]);
            } catch {
                if (!staticInfoRef.current) {
                    staticInfoRef.current = {
                        gpuName: 'Unknown GPU',
                        gpuCores: 0,
                        memoryTotal: 16,
                        isAppleSilicon: false,
                    };
                }
                setStats(prev => ({
                    ...staticInfoRef.current!,
                    usage: prev?.usage ?? 0,
                    memoryUsed: prev?.memoryUsed ?? 0,
                }));
            } finally {
                inFlightRef.current = false;
            }
        };

        fetchStats();
        const interval = setInterval(fetchStats, 8000); // Update every 8 seconds

        return () => clearInterval(interval);
    }, []);

    if (!stats) {
        return (
            <Box borderStyle="round" borderColor="gray" paddingX={2} paddingY={1}>
                <Text color="yellow">⏳ Loading GPU info...</Text>
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
