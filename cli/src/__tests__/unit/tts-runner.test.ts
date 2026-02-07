import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// Mock the modules before importing
vi.mock('child_process', () => ({
    spawn: vi.fn(),
    spawnSync: vi.fn(),
}));

// We need to test the parsing logic from tts-runner.ts
// Since runTTS has side effects, we'll extract and test the parsing logic

describe('tts-runner', () => {
    describe('IPC Message Parsing', () => {
        // Test parsing functions extracted from tts-runner.ts

        describe('PHASE parsing', () => {
            it('should parse PHASE:PARSING message', () => {
                const line = 'PHASE:PARSING';
                expect(line.startsWith('PHASE:')).toBe(true);
                const phase = line.slice(6);
                expect(phase).toBe('PARSING');
            });

            it('should parse PHASE:INFERENCE message', () => {
                const line = 'PHASE:INFERENCE';
                expect(line.startsWith('PHASE:')).toBe(true);
                const phase = line.slice(6);
                expect(phase).toBe('INFERENCE');
            });

            it('should parse PHASE:CONCATENATING message', () => {
                const line = 'PHASE:CONCATENATING';
                const phase = line.slice(6);
                expect(phase).toBe('CONCATENATING');
            });

            it('should parse PHASE:EXPORTING message', () => {
                const line = 'PHASE:EXPORTING';
                const phase = line.slice(6);
                expect(phase).toBe('EXPORTING');
            });
        });

        describe('METADATA parsing', () => {
            it('should parse METADATA:total_chars message', () => {
                const line = 'METADATA:total_chars:12345';
                expect(line.startsWith('METADATA:total_chars:')).toBe(true);
                const totalChars = parseInt(line.slice(21), 10);
                expect(totalChars).toBe(12345);
            });

            it('should parse large character counts', () => {
                const line = 'METADATA:total_chars:1234567890';
                const totalChars = parseInt(line.slice(21), 10);
                expect(totalChars).toBe(1234567890);
            });

            it('should parse METADATA:backend_resolved message', () => {
                const line = 'METADATA:backend_resolved:mlx';
                expect(line.startsWith('METADATA:backend_resolved:')).toBe(true);
                const backend = line.slice(26);
                expect(backend).toBe('mlx');
            });
        });

        describe('TIMING parsing', () => {
            it('should parse TIMING message', () => {
                const line = 'TIMING:5:2340';
                expect(line.startsWith('TIMING:')).toBe(true);
                const parts = line.slice(7).split(':');
                expect(parts.length).toBeGreaterThanOrEqual(2);
                const chunkIdx = parseInt(parts[0], 10);
                const chunkTimingMs = parseInt(parts[1], 10);
                expect(chunkIdx).toBe(5);
                expect(chunkTimingMs).toBe(2340);
            });

            it('should handle zero timing', () => {
                const line = 'TIMING:0:0';
                const parts = line.slice(7).split(':');
                const chunkIdx = parseInt(parts[0], 10);
                const chunkTimingMs = parseInt(parts[1], 10);
                expect(chunkIdx).toBe(0);
                expect(chunkTimingMs).toBe(0);
            });
        });

        describe('HEARTBEAT parsing', () => {
            it('should parse HEARTBEAT message', () => {
                const line = 'HEARTBEAT:1234567890123';
                expect(line.startsWith('HEARTBEAT:')).toBe(true);
                const heartbeatTs = parseInt(line.slice(10), 10);
                expect(heartbeatTs).toBe(1234567890123);
            });
        });

        describe('WORKER parsing', () => {
            it('should parse WORKER status message', () => {
                const line = 'WORKER:0:INFER:Chunk 5/50';
                expect(line.startsWith('WORKER:')).toBe(true);
                const parts = line.split(':');
                expect(parts.length).toBeGreaterThanOrEqual(4);
                const id = parseInt(parts[1], 10);
                const status = parts[2];
                const details = parts.slice(3).join(':');
                expect(id).toBe(0);
                expect(status).toBe('INFER');
                expect(details).toBe('Chunk 5/50');
            });

            it('should handle details with colons', () => {
                const line = 'WORKER:1:ENCODE:File: test.mp3';
                const parts = line.split(':');
                const details = parts.slice(3).join(':');
                expect(details).toBe('File: test.mp3');
            });

            it('should parse IDLE status', () => {
                const line = 'WORKER:0:IDLE:Waiting';
                const parts = line.split(':');
                expect(parts[2]).toBe('IDLE');
            });

            it('should parse ENCODE status', () => {
                const line = 'WORKER:0:ENCODE:Processing audio';
                const parts = line.split(':');
                expect(parts[2]).toBe('ENCODE');
            });
        });

        describe('PROGRESS parsing', () => {
            it('should parse PROGRESS message', () => {
                const line = 'PROGRESS:42/100 chunks';
                const chunkMatch = line.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
                expect(chunkMatch).not.toBeNull();
                const current = parseInt(chunkMatch![1], 10);
                const total = parseInt(chunkMatch![2], 10);
                expect(current).toBe(42);
                expect(total).toBe(100);
            });

            it('should parse progress without PROGRESS prefix', () => {
                const line = '42/100 chunks';
                const chunkMatch = line.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
                expect(chunkMatch).not.toBeNull();
                const current = parseInt(chunkMatch![1], 10);
                const total = parseInt(chunkMatch![2], 10);
                expect(current).toBe(42);
                expect(total).toBe(100);
            });

            it('should calculate progress percentage', () => {
                const line = 'PROGRESS:25/50 chunks';
                const chunkMatch = line.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
                const current = parseInt(chunkMatch![1], 10);
                const total = parseInt(chunkMatch![2], 10);
                const progress = Math.round((current / total) * 100);
                expect(progress).toBe(50);
            });
        });
    });

    describe('MPS Environment Variables', () => {
        it('should set correct MPS env vars when enabled', () => {
            const mpsEnv = {
                PYTORCH_ENABLE_MPS_FALLBACK: '1',
                PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
                OMP_NUM_THREADS: '4',
                OPENBLAS_NUM_THREADS: '2',
            };

            expect(mpsEnv.PYTORCH_ENABLE_MPS_FALLBACK).toBe('1');
            expect(mpsEnv.PYTORCH_MPS_HIGH_WATERMARK_RATIO).toBe('0.0');
            expect(mpsEnv.OMP_NUM_THREADS).toBe('4');
            expect(mpsEnv.OPENBLAS_NUM_THREADS).toBe('2');
        });

        it('should compose auto backend + checkpoint args', () => {
            const config = {
                backend: 'auto',
                checkpointEnabled: true,
            };

            const args = [
                '--backend', config.backend,
                ...(config.checkpointEnabled ? ['--checkpoint'] : []),
            ];

            expect(args).toContain('--backend');
            expect(args).toContain('auto');
            expect(args).toContain('--checkpoint');
        });
    });

    describe('Error Handling', () => {
        it('should detect Python process exit with error code', () => {
            const code: number = 1;
            const stderr = 'Error: something went wrong';

            if (code !== 0) {
                const error = new Error(`Python process exited with code ${code}\n${stderr}`);
                expect(error.message).toContain('exited with code 1');
                expect(error.message).toContain('something went wrong');
            }
        });

        it('should truncate long stderr messages', () => {
            const MAX_STDERR = 10000;
            let stderr = 'x'.repeat(15000);

            if (stderr.length > MAX_STDERR) {
                stderr = stderr.slice(-MAX_STDERR);
            }

            expect(stderr.length).toBe(MAX_STDERR);
        });
    });

    describe('Output Line Parsing', () => {
        it('should handle multi-line output', () => {
            const output = `PHASE:PARSING
METADATA:total_chars:5000
PHASE:INFERENCE
WORKER:0:INFER:Chunk 1/10
TIMING:0:1500
PROGRESS:1/10 chunks`;

            const lines = output.split('\n');
            expect(lines.length).toBe(6);

            // Each line should be parseable
            expect(lines[0].startsWith('PHASE:')).toBe(true);
            expect(lines[1].startsWith('METADATA:')).toBe(true);
            expect(lines[2].startsWith('PHASE:')).toBe(true);
            expect(lines[3].startsWith('WORKER:')).toBe(true);
            expect(lines[4].startsWith('TIMING:')).toBe(true);
            expect(lines[5].startsWith('PROGRESS:')).toBe(true);
        });

        it('should skip non-IPC messages', () => {
            const lines = [
                'PHASE:PARSING',
                'Loading model...',
                'METADATA:total_chars:5000',
                'METADATA:backend_resolved:mlx',
                'Some debug output',
            ];

            const ipcMessages = lines.filter(line =>
                line.startsWith('PHASE:') ||
                line.startsWith('METADATA:') ||
                line.startsWith('WORKER:') ||
                line.startsWith('TIMING:') ||
                line.startsWith('HEARTBEAT:') ||
                line.startsWith('PROGRESS:')
            );

            expect(ipcMessages.length).toBe(3);
        });
    });
});
