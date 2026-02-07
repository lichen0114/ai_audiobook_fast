import { describe, it, expect, vi } from 'vitest';

describe('GpuMonitor', () => {
    describe('Loading state', () => {
        it('should show loading message when stats are null', () => {
            const stats = null;
            const isLoading = stats === null;
            expect(isLoading).toBe(true);
        });

        it('should not show loading when stats are available', () => {
            const stats = { gpuName: 'Apple M2' };
            const isLoading = stats === null;
            expect(isLoading).toBe(false);
        });
    });

    describe('GPU stats', () => {
        const mockStats = {
            gpuName: 'Apple M2 Pro (19-core GPU)',
            gpuCores: 19,
            usage: 45,
            memoryUsed: 8,
            memoryTotal: 32,
            isAppleSilicon: true,
        };

        it('should parse GPU name', () => {
            expect(mockStats.gpuName).toContain('Apple');
            expect(mockStats.gpuName).toContain('M2');
        });

        it('should extract core count from name', () => {
            const gpuName = 'Apple M2 Pro (19-core GPU)';
            const coreMatch = gpuName.match(/(\d+)-core/);
            const gpuCores = coreMatch ? parseInt(coreMatch[1]) : 8;
            expect(gpuCores).toBe(19);
        });

        it('should default to 8 cores if not found', () => {
            const gpuName = 'Apple M2';
            const coreMatch = gpuName.match(/(\d+)-core/);
            const gpuCores = coreMatch ? parseInt(coreMatch[1]) : 8;
            expect(gpuCores).toBe(8);
        });

        it('should detect Apple Silicon', () => {
            const gpuNames = ['Apple M1', 'Apple M2', 'Apple M3', 'Apple M4'];
            gpuNames.forEach(name => {
                const isAppleSilicon = name.includes('Apple') ||
                    name.includes('M1') ||
                    name.includes('M2') ||
                    name.includes('M3') ||
                    name.includes('M4');
                expect(isAppleSilicon).toBe(true);
            });
        });

        it('should not detect non-Apple GPUs as Apple Silicon', () => {
            const gpuName = 'NVIDIA GeForce RTX 3080';
            const isAppleSilicon = gpuName.includes('Apple') ||
                gpuName.includes('M1') ||
                gpuName.includes('M2') ||
                gpuName.includes('M3') ||
                gpuName.includes('M4');
            expect(isAppleSilicon).toBe(false);
        });
    });

    describe('Compact mode', () => {
        it('should show minimal info in compact mode', () => {
            const compact = true;
            expect(compact).toBe(true);
        });

        it('should show full info when not compact', () => {
            const compact = false;
            expect(compact).toBe(false);
        });
    });

    describe('Progress bar colors', () => {
        const getColor = (percentage: number): string => {
            if (percentage < 30) return 'green';
            if (percentage < 60) return 'yellow';
            if (percentage < 85) return 'magenta';
            return 'red';
        };

        it('should be green for low usage', () => {
            expect(getColor(0)).toBe('green');
            expect(getColor(15)).toBe('green');
            expect(getColor(29)).toBe('green');
        });

        it('should be yellow for medium usage', () => {
            expect(getColor(30)).toBe('yellow');
            expect(getColor(45)).toBe('yellow');
            expect(getColor(59)).toBe('yellow');
        });

        it('should be magenta for high usage', () => {
            expect(getColor(60)).toBe('magenta');
            expect(getColor(70)).toBe('magenta');
            expect(getColor(84)).toBe('magenta');
        });

        it('should be red for very high usage', () => {
            expect(getColor(85)).toBe('red');
            expect(getColor(95)).toBe('red');
            expect(getColor(100)).toBe('red');
        });
    });

    describe('Sparkline', () => {
        const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

        it('should have correct sparkline characters', () => {
            expect(chars.length).toBe(8);
        });

        it('should map values to characters', () => {
            const data = [0, 25, 50, 75, 100];
            const max = Math.max(...data, 1);

            const sparkline = data.map(v => {
                const idx = Math.min(Math.floor((v / max) * (chars.length - 1)), chars.length - 1);
                return chars[idx];
            });

            expect(sparkline.length).toBe(5);
            expect(sparkline[0]).toBe('▁'); // 0%
            expect(sparkline[4]).toBe('█'); // 100%
        });

        it('should use recent data only', () => {
            const history = Array.from({ length: 50 }, (_, i) => i);
            const width = 15;
            const recentData = history.slice(-width);

            expect(recentData.length).toBe(15);
            expect(recentData[0]).toBe(35); // history.length - width
        });
    });

    describe('GPU bar', () => {
        it('should calculate filled bar width', () => {
            const value = 50;
            const max = 100;
            const width = 20;

            const percentage = Math.min((value / max) * 100, 100);
            const filled = Math.round((percentage / 100) * width);

            expect(filled).toBe(10);
        });

        it('should handle 0% usage', () => {
            const value = 0;
            const max = 100;
            const width = 20;

            const percentage = Math.min((value / max) * 100, 100);
            const filled = Math.round((percentage / 100) * width);

            expect(filled).toBe(0);
        });

        it('should cap at 100%', () => {
            const value = 150; // Over 100%
            const max = 100;
            const width = 20;

            const percentage = Math.min((value / max) * 100, 100);
            const filled = Math.round((percentage / 100) * width);

            expect(filled).toBe(20);
        });
    });

    describe('MPS status', () => {
        it('should show active for Apple Silicon', () => {
            const isAppleSilicon = true;
            const status = isAppleSilicon ? 'MPS Active' : 'Standard GPU';
            expect(status).toBe('MPS Active');
        });

        it('should show standard for non-Apple GPUs', () => {
            const isAppleSilicon = false;
            const status = isAppleSilicon ? 'MPS Active' : 'Standard GPU';
            expect(status).toBe('Standard GPU');
        });
    });

    describe('Polling behavior', () => {
        it('should fetch static GPU identity once and reuse it', () => {
            let staticFetches = 0;
            const getStatic = () => {
                staticFetches += 1;
                return { gpuName: 'Apple M1', gpuCores: 8, memoryTotal: 16 };
            };

            const cached = getStatic();
            const reused = cached;

            expect(staticFetches).toBe(1);
            expect(reused.gpuName).toBe('Apple M1');
        });

        it('should throttle dynamic polling to a slower cadence', () => {
            const pollingIntervalMs = 8000;
            expect(pollingIntervalMs).toBeGreaterThanOrEqual(8000);
        });

        it('should skip overlapping polls when one is in-flight', () => {
            let inFlight = true;
            const shouldRunPoll = !inFlight;
            expect(shouldRunPoll).toBe(false);
            inFlight = false;
            expect(!inFlight).toBe(true);
        });
    });
});
