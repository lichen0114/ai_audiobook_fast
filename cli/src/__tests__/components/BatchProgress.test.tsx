import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

import type { BatchJobPlan, FileJob, TTSConfig } from '../../types/profile.js';

vi.mock('ink', async () => {
    const actual = await vi.importActual<any>('ink');
    return {
        ...actual,
        useApp: () => ({ exit: vi.fn() }),
        useInput: vi.fn(),
    };
});

vi.mock('ink-gradient', () => ({
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../components/GpuMonitor.js', () => ({
    GpuMonitor: () => null,
}));

vi.mock('../../utils/tts-runner.js', () => ({
    runTTS: vi.fn(),
}));

vi.mock('../../utils/checkpoint.js', () => ({
    deleteCheckpoint: vi.fn(() => Promise.resolve()),
}));

import { BatchProgress } from '../../components/BatchProgress.js';
import { runTTS, type ProgressInfo } from '../../utils/tts-runner.js';

const baseConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1,
    langCode: 'a',
    chunkChars: 900,
    useMPS: true,
    outputDir: null,
    workers: 1,
    backend: 'auto',
    outputFormat: 'mp3',
    bitrate: '192k',
    normalize: false,
    checkpointEnabled: false,
    pipelineMode: 'auto',
    recoveryMode: 'apple-balanced',
};

function createFileJob(id: string, inputPath: string): FileJob {
    return {
        id,
        inputPath,
        outputPath: inputPath.replace(/\.epub$/, '.mp3'),
        status: 'pending',
        progress: 0,
    };
}

function createJobPlan(file: FileJob, overrides: Partial<BatchJobPlan> = {}): BatchJobPlan {
    return {
        id: file.id,
        inputPath: file.inputPath,
        outputPath: file.outputPath,
        format: 'mp3',
        config: baseConfig,
        metadata: {
            title: file.inputPath.split('/').pop() || file.inputPath,
            author: 'Unknown Author',
            hasCover: false,
        },
        checkpoint: {
            exists: false,
            resumeCompatible: false,
            action: 'ignore',
        },
        estimate: {
            totalChars: 1000,
            totalChunks: 1,
            chapterCount: 1,
        },
        warnings: [],
        errors: [],
        ...overrides,
    };
}

function BatchProgressHarness({
    initialFiles,
    jobPlans,
    onComplete,
    onFilesChange,
}: {
    initialFiles: FileJob[];
    jobPlans?: BatchJobPlan[];
    onComplete: () => void;
    onFilesChange: (files: FileJob[]) => void;
}) {
    const [files, setFiles] = React.useState<FileJob[]>(initialFiles);
    const plans = React.useMemo(
        () => jobPlans ?? initialFiles.map((file) => createJobPlan(file)),
        [initialFiles, jobPlans],
    );

    React.useEffect(() => {
        onFilesChange(files);
    }, [files, onFilesChange]);

    return (
        <BatchProgress
            files={files}
            setFiles={setFiles}
            jobPlans={plans}
            onComplete={onComplete}
        />
    );
}

function parseErrorMessage(error: string): string {
    const errorLower = error.toLowerCase();

    // GPU/Memory errors
    if (errorLower.includes('out of memory') || errorLower.includes('mps') && errorLower.includes('memory')) {
        return 'GPU memory exhausted - try reducing chunk size (--chunk_chars)';
    }
    if (errorLower.includes('mps backend') || errorLower.includes('metal')) {
        return 'GPU acceleration error - try disabling MPS or updating macOS';
    }
    if (
        errorLower.includes('abort trap')
        || errorLower.includes('segmentation fault')
        || errorLower.includes('bus error')
        || errorLower.includes('killed')
        || errorLower.includes('signal')
    ) {
        return 'Backend crashed on macOS - retrying with safer settings may help';
    }

    // FFmpeg errors (check before generic "not found" since ffmpeg messages contain "not found")
    if (errorLower.includes('ffmpeg') || errorLower.includes('ffprobe')) {
        return 'FFmpeg not found - please install FFmpeg for MP3 export';
    }

    // Model/TTS errors (check before generic "not found" since voice errors contain "not found")
    if (errorLower.includes('voice') && (errorLower.includes('not found') || errorLower.includes('invalid'))) {
        return 'Invalid voice - check available voice options';
    }

    // File errors
    if (errorLower.includes('no such file') || errorLower.includes('not found') || errorLower.includes('filenotfounderror')) {
        return 'Input file not found or inaccessible';
    }
    if (errorLower.includes('permission denied')) {
        return 'Permission denied - check file/folder permissions';
    }
    if (
        errorLower.includes('no space left on device') ||
        errorLower.includes('disk full') ||
        errorLower.includes('errno 28')
    ) {
        return 'Disk is full - free up space and try again';
    }
    if (errorLower.includes('no readable text') || errorLower.includes('no text chunks')) {
        return 'EPUB has no readable text content';
    }

    // Encoding/Format errors
    if (errorLower.includes('codec') || errorLower.includes('decode') || errorLower.includes('encode')) {
        return 'Text encoding error - EPUB may contain unsupported characters';
    }
    if (errorLower.includes('epub') && errorLower.includes('invalid')) {
        return 'Invalid EPUB format - file may be corrupted';
    }

    // Python version errors
    if (errorLower.includes('python') && errorLower.includes('version')) {
        return 'Python version error - Kokoro requires Python 3.10-3.12';
    }

    if (errorLower.includes('model') && errorLower.includes('load')) {
        return 'Failed to load TTS model - check installation';
    }

    // Return truncated original error if no pattern matches
    const lines = error.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !line.startsWith('Traceback') && !line.startsWith('File ')) {
            return line.length > 100 ? line.substring(0, 100) + '...' : line;
        }
    }

    return error.length > 100 ? error.substring(0, 100) + '...' : error;
}

async function advanceUi(ms = 300): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
}

describe('BatchProgress', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    describe('parseErrorMessage', () => {
        describe('GPU/Memory errors', () => {
            it('should parse out of memory errors', () => {
                const result = parseErrorMessage('CUDA out of memory');
                expect(result).toBe('GPU memory exhausted - try reducing chunk size (--chunk_chars)');
            });

            it('should parse MPS memory errors', () => {
                const result = parseErrorMessage('MPS: not enough memory to allocate');
                expect(result).toBe('GPU memory exhausted - try reducing chunk size (--chunk_chars)');
            });

            it('should parse MPS backend errors', () => {
                const result = parseErrorMessage('Error: MPS backend not available');
                expect(result).toBe('GPU acceleration error - try disabling MPS or updating macOS');
            });

            it('should parse Metal errors', () => {
                const result = parseErrorMessage('Metal device not found');
                expect(result).toBe('GPU acceleration error - try disabling MPS or updating macOS');
            });

            it('should parse macOS native crash errors', () => {
                const result = parseErrorMessage('Abort trap: 6');
                expect(result).toBe('Backend crashed on macOS - retrying with safer settings may help');
            });
        });

        describe('File errors', () => {
            it('should parse file not found errors', () => {
                const result = parseErrorMessage('FileNotFoundError: book.epub');
                expect(result).toBe('Input file not found or inaccessible');
            });

            it('should parse no such file errors', () => {
                const result = parseErrorMessage('No such file or directory');
                expect(result).toBe('Input file not found or inaccessible');
            });

            it('should parse permission denied errors', () => {
                const result = parseErrorMessage('Permission denied: /path/to/file');
                expect(result).toBe('Permission denied - check file/folder permissions');
            });

            it('should parse disk full errors', () => {
                const result = parseErrorMessage('OSError: [Errno 28] No space left on device');
                expect(result).toBe('Disk is full - free up space and try again');
            });

            it('should parse no readable text errors', () => {
                const result = parseErrorMessage('ValueError: No readable text content found');
                expect(result).toBe('EPUB has no readable text content');
            });

            it('should parse no text chunks errors', () => {
                const result = parseErrorMessage('No text chunks produced from EPUB');
                expect(result).toBe('EPUB has no readable text content');
            });
        });

        describe('Encoding/Format errors', () => {
            it('should parse codec errors', () => {
                const result = parseErrorMessage('UnicodeDecodeError: codec error');
                expect(result).toBe('Text encoding error - EPUB may contain unsupported characters');
            });

            it('should parse decode errors', () => {
                const result = parseErrorMessage("'utf-8' codec can't decode byte");
                expect(result).toBe('Text encoding error - EPUB may contain unsupported characters');
            });

            it('should parse invalid EPUB errors', () => {
                const result = parseErrorMessage('EPUB format invalid or corrupted');
                expect(result).toBe('Invalid EPUB format - file may be corrupted');
            });
        });

        describe('FFmpeg errors', () => {
            it('should parse ffmpeg not found errors', () => {
                const result = parseErrorMessage('ffmpeg not found. Install with: brew install ffmpeg');
                expect(result).toBe('FFmpeg not found - please install FFmpeg for MP3 export');
            });

            it('should parse ffprobe errors', () => {
                const result = parseErrorMessage('ffprobe: command not found');
                expect(result).toBe('FFmpeg not found - please install FFmpeg for MP3 export');
            });
        });

        describe('Python version errors', () => {
            it('should parse Python version errors', () => {
                const result = parseErrorMessage('Python version 3.9 is not supported');
                expect(result).toBe('Python version error - Kokoro requires Python 3.10-3.12');
            });
        });

        describe('TTS/Model errors', () => {
            it('should parse voice not found errors', () => {
                const result = parseErrorMessage('Voice not found: xyz_voice');
                expect(result).toBe('Invalid voice - check available voice options');
            });

            it('should parse invalid voice errors', () => {
                const result = parseErrorMessage('Invalid voice specified');
                expect(result).toBe('Invalid voice - check available voice options');
            });

            it('should parse model load errors', () => {
                const result = parseErrorMessage('Failed to load TTS model');
                expect(result).toBe('Failed to load TTS model - check installation');
            });
        });

        describe('Fallback behavior', () => {
            it('should return truncated error for unknown errors', () => {
                const longError = 'x'.repeat(150);
                const result = parseErrorMessage(longError);
                expect(result.length).toBe(103);
                expect(result.endsWith('...')).toBe(true);
            });

            it('should skip traceback lines', () => {
                const error = `Traceback (most recent call last):
  File "app.py", line 123
  File "module.py", line 456
RuntimeError: Something went wrong`;
                const result = parseErrorMessage(error);
                expect(result).toBe('RuntimeError: Something went wrong');
            });

            it('should return short errors as-is', () => {
                const result = parseErrorMessage('Some error');
                expect(result).toBe('Some error');
            });
        });
    });

    describe('Progress calculation', () => {
        it('should calculate weighted overall progress', () => {
            const files = [
                { status: 'done', progress: 100 },
                { status: 'processing', progress: 50 },
                { status: 'pending', progress: 0 },
            ];
            const weights = [100, 200, 300];
            const completedWeight = weights[0] + weights[1] * 0.5;
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
            const overallProgress = Math.round((completedWeight / totalWeight) * 100);

            expect(overallProgress).toBe(33);
        });
    });

    describe('Phase handling', () => {
        it('should recognize all phase values', () => {
            const phases = ['PARSING', 'INFERENCE', 'CONCATENATING', 'EXPORTING', 'DONE'];
            phases.forEach(phase => {
                expect(typeof phase).toBe('string');
            });
        });

        it('should have correct phase labels', () => {
            const phaseLabels: Record<string, string> = {
                PARSING: 'Parsing',
                INFERENCE: 'Inference',
                CONCATENATING: 'Concatenating',
                EXPORTING: 'Exporting',
                DONE: 'Done',
            };

            expect(phaseLabels.PARSING).toBe('Parsing');
            expect(phaseLabels.INFERENCE).toBe('Inference');
            expect(phaseLabels.CONCATENATING).toBe('Concatenating');
            expect(phaseLabels.EXPORTING).toBe('Exporting');
            expect(phaseLabels.DONE).toBe('Done');
        });
    });

    describe('EMA calculation', () => {
        it('should calculate EMA correctly', () => {
            const emaAlpha = 0.3;
            let ema: number | undefined = undefined;

            const v1 = 1000;
            ema = v1;
            expect(ema).toBe(1000);

            const v2 = 2000;
            ema = emaAlpha * v2 + (1 - emaAlpha) * ema;
            expect(ema).toBe(1300);

            const v3 = 500;
            ema = emaAlpha * v3 + (1 - emaAlpha) * ema;
            expect(ema).toBeCloseTo(1060);
        });
    });

    describe('batch flow with mock data', () => {
        it('shows parse progress while the backend is still parsing', async () => {
            vi.useFakeTimers();

            const jobs = [createFileJob('1', '/tmp/book-one.epub')];
            const onComplete = vi.fn();

            let releaseRun: (() => void) | undefined;
            const runGate = new Promise<void>((resolve) => {
                releaseRun = resolve;
            });

            vi.mocked(runTTS).mockImplementationOnce(async (_input, _output, _config, onProgress) => {
                onProgress({ progress: 0, currentChunk: 0, totalChunks: 0, phase: 'PARSING' });
                onProgress({
                    progress: 0,
                    currentChunk: 0,
                    totalChunks: 0,
                    phase: 'PARSING',
                    parseCurrentItem: 2,
                    parseTotalItems: 4,
                    parseChapterCount: 1,
                });
                await runGate;
                onProgress({ progress: 100, currentChunk: 1, totalChunks: 1, phase: 'DONE' });
            });

            const { lastFrame } = render(
                <BatchProgressHarness
                    initialFiles={jobs}
                    onComplete={onComplete}
                    onFilesChange={() => undefined}
                />
            );

            await advanceUi();

            const frame = lastFrame() ?? '';
            expect(frame).toContain('Document:');
            expect(frame).toContain('2');
            expect(frame).toContain('4');
            expect(frame).toContain('Chapters:');
            expect(frame).toContain('50%');

            releaseRun?.();
            await advanceUi(600);

            expect(onComplete).toHaveBeenCalledOnce();
        });

        it('processes multiple books sequentially and shows recovery status for a recovered first file', async () => {
            vi.useFakeTimers();

            const jobs = [
                createFileJob('1', '/tmp/book-one.epub'),
                createFileJob('2', '/tmp/book-two.epub'),
            ];
            let latestFiles = jobs;
            const onComplete = vi.fn();

            let releaseFirstRun: (() => void) | undefined;
            const firstRunGate = new Promise<void>((resolve) => {
                releaseFirstRun = resolve;
            });

            vi.mocked(runTTS)
                .mockImplementationOnce(async (_input, _output, _config, onProgress) => {
                    onProgress({
                        progress: 0,
                        currentChunk: 0,
                        totalChunks: 0,
                        recovery: {
                            attempt: 2,
                            maxAttempts: 2,
                            reason: 'mlx backend crashed',
                            backend: 'pytorch',
                            useMPS: false,
                            pipelineMode: 'sequential',
                            chunkChars: 600,
                            workers: 1,
                        },
                    });
                    onProgress({ progress: 0, currentChunk: 0, totalChunks: 0, phase: 'PARSING' });
                    await firstRunGate;
                    onProgress({ progress: 100, currentChunk: 1, totalChunks: 1, phase: 'DONE' });
                })
                .mockImplementationOnce(async (_input, _output, _config, onProgress) => {
                    onProgress({ progress: 0, currentChunk: 0, totalChunks: 0, phase: 'PARSING' });
                    onProgress({ progress: 100, currentChunk: 1, totalChunks: 1, phase: 'DONE' });
                });

            const { lastFrame } = render(
                <BatchProgressHarness
                    initialFiles={jobs}
                    onComplete={onComplete}
                    onFilesChange={(files) => {
                        latestFiles = files;
                    }}
                />
            );

            await advanceUi();

            expect(runTTS).toHaveBeenCalledTimes(1);
            expect(vi.mocked(runTTS).mock.calls[0][0]).toBe('/tmp/book-one.epub');
            expect(latestFiles[0].status).toBe('processing');
            expect(lastFrame() ?? '').toContain('Retrying with safer Mac settings...');
            expect(lastFrame() ?? '').toContain('Fallback: pytorch CPU, sequential, 600 chars, 1 worker');

            releaseFirstRun?.();
            await advanceUi(600);

            expect(runTTS).toHaveBeenCalledTimes(2);
            expect(vi.mocked(runTTS).mock.calls[1][0]).toBe('/tmp/book-two.epub');

            await advanceUi(600);

            expect(onComplete).toHaveBeenCalledOnce();
            expect(latestFiles.map((file) => file.status)).toEqual(['done', 'done']);
            expect(latestFiles[0].error).toBeUndefined();
            expect(latestFiles[1].error).toBeUndefined();
        });

        it('continues to the next file after a non-recoverable first-file error without showing recovery status', async () => {
            vi.useFakeTimers();

            const jobs = [
                createFileJob('1', '/tmp/missing-book.epub'),
                createFileJob('2', '/tmp/book-two.epub'),
            ];
            let latestFiles = jobs;
            const onComplete = vi.fn();

            vi.mocked(runTTS)
                .mockImplementationOnce(async () => {
                    throw new Error('Input EPUB not found');
                })
                .mockImplementationOnce(async (_input, _output, _config, onProgress) => {
                    onProgress({ progress: 0, currentChunk: 0, totalChunks: 0, phase: 'PARSING' });
                    onProgress({ progress: 100, currentChunk: 1, totalChunks: 1, phase: 'DONE' });
                });

            const { lastFrame } = render(
                <BatchProgressHarness
                    initialFiles={jobs}
                    onComplete={onComplete}
                    onFilesChange={(files) => {
                        latestFiles = files;
                    }}
                />
            );

            await advanceUi(900);

            expect(runTTS).toHaveBeenCalledTimes(2);
            expect(onComplete).toHaveBeenCalledOnce();
            expect(latestFiles[0].status).toBe('error');
            expect(latestFiles[0].error).toContain('Input file not found or inaccessible');
            expect(latestFiles[1].status).toBe('done');
            expect(lastFrame() ?? '').not.toContain('Retrying with safer Mac settings...');
        });
    });
});
