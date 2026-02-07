import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration } from '../../utils/format.js';

describe('Utility Functions', () => {
    describe('formatBytes', () => {
        it('should format 0 bytes', () => {
            expect(formatBytes(0)).toBe('0 B');
        });

        it('should format bytes', () => {
            expect(formatBytes(100)).toBe('100 B');
            expect(formatBytes(500)).toBe('500 B');
            expect(formatBytes(1023)).toBe('1023 B');
        });

        it('should format kilobytes', () => {
            expect(formatBytes(1024)).toBe('1 KB');
            expect(formatBytes(1536)).toBe('1.5 KB');
            expect(formatBytes(10240)).toBe('10 KB');
            expect(formatBytes(1048575)).toBe('1024 KB');
        });

        it('should format megabytes', () => {
            expect(formatBytes(1048576)).toBe('1 MB');
            expect(formatBytes(1572864)).toBe('1.5 MB');
            expect(formatBytes(10485760)).toBe('10 MB');
            expect(formatBytes(104857600)).toBe('100 MB');
        });

        it('should format gigabytes', () => {
            expect(formatBytes(1073741824)).toBe('1 GB');
            expect(formatBytes(1610612736)).toBe('1.5 GB');
            expect(formatBytes(10737418240)).toBe('10 GB');
        });

        it('should handle decimal precision', () => {
            expect(formatBytes(1126)).toBe('1.1 KB');
            expect(formatBytes(2252)).toBe('2.2 KB');
        });
    });

    describe('formatDuration', () => {
        it('should format seconds only', () => {
            expect(formatDuration(0)).toBe('0s');
            expect(formatDuration(1000)).toBe('1s');
            expect(formatDuration(30000)).toBe('30s');
            expect(formatDuration(59000)).toBe('59s');
        });

        it('should format minutes and seconds', () => {
            expect(formatDuration(60000)).toBe('1m 0s');
            expect(formatDuration(90000)).toBe('1m 30s');
            expect(formatDuration(120000)).toBe('2m 0s');
            expect(formatDuration(3599000)).toBe('59m 59s');
        });

        it('should format hours, minutes, and seconds', () => {
            expect(formatDuration(3600000)).toBe('1h 0m 0s');
            expect(formatDuration(3661000)).toBe('1h 1m 1s');
            expect(formatDuration(7200000)).toBe('2h 0m 0s');
            expect(formatDuration(7384000)).toBe('2h 3m 4s');
        });

        it('should handle edge cases', () => {
            expect(formatDuration(59999)).toBe('59s');
            expect(formatDuration(3599999)).toBe('59m 59s');
            expect(formatDuration(36000000)).toBe('10h 0m 0s');
        });
    });

    describe('Progress Calculation', () => {
        it('should calculate progress percentage correctly', () => {
            const calculate = (current: number, total: number) =>
                Math.round((current / total) * 100);

            expect(calculate(0, 100)).toBe(0);
            expect(calculate(50, 100)).toBe(50);
            expect(calculate(100, 100)).toBe(100);
            expect(calculate(1, 3)).toBe(33);
            expect(calculate(2, 3)).toBe(67);
        });

        it('should handle edge cases in progress', () => {
            const calculate = (current: number, total: number) =>
                total > 0 ? Math.round((current / total) * 100) : 0;

            expect(calculate(0, 0)).toBe(0);
            expect(calculate(5, 5)).toBe(100);
        });
    });

    describe('ETA Calculation', () => {
        it('should calculate ETA based on elapsed time', () => {
            const calculateEta = (
                elapsed: number,
                current: number,
                total: number
            ): string => {
                if (current === 0) return 'Calculating...';

                const avgTimePerChunk = elapsed / current;
                const remainingChunks = total - current;
                const remainingTime = avgTimePerChunk * remainingChunks;

                if (remainingTime > 60000) {
                    return `${Math.round(remainingTime / 60000)} min`;
                }
                return `${Math.round(remainingTime / 1000)} sec`;
            };

            expect(calculateEta(30000, 10, 100)).toBe('5 min');
            expect(calculateEta(10000, 50, 100)).toBe('10 sec');
            expect(calculateEta(5000, 0, 100)).toBe('Calculating...');
        });
    });

    describe('EMA Calculation', () => {
        it('should calculate exponential moving average', () => {
            const EMA_ALPHA = 0.3;
            let ema: number | undefined = undefined;

            const updateEma = (newValue: number): number => {
                if (ema === undefined) {
                    ema = newValue;
                } else {
                    ema = EMA_ALPHA * newValue + (1 - EMA_ALPHA) * ema;
                }
                return ema;
            };

            expect(updateEma(1000)).toBe(1000);
            expect(updateEma(2000)).toBe(1300);
            expect(updateEma(1500)).toBe(1360);
        });
    });
});
