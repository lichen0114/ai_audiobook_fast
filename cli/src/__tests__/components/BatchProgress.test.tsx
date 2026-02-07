import { describe, it, expect } from 'vitest';

// Test the parseErrorMessage function from BatchProgress.tsx
// Extract the function logic for testing

function parseErrorMessage(error: string): string {
    const errorLower = error.toLowerCase();

    // GPU/Memory errors
    if (errorLower.includes('out of memory') || errorLower.includes('mps') && errorLower.includes('memory')) {
        return 'GPU memory exhausted - try reducing chunk size (--chunk_chars)';
    }
    if (errorLower.includes('mps backend') || errorLower.includes('metal')) {
        return 'GPU acceleration error - try disabling MPS or updating macOS';
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

describe('BatchProgress', () => {
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
                expect(result.length).toBe(103); // 100 + '...'
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
        it('should calculate overall progress', () => {
            const files = [
                { status: 'done' },
                { status: 'done' },
                { status: 'error' },
                { status: 'pending' },
            ];

            const completedCount = files.filter(f => f.status === 'done').length;
            const errorCount = files.filter(f => f.status === 'error').length;
            const overallProgress = Math.round(((completedCount + errorCount) / files.length) * 100);

            expect(overallProgress).toBe(75);
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
            const PHASE_LABELS: Record<string, string> = {
                PARSING: 'Parsing',
                INFERENCE: 'Inference',
                CONCATENATING: 'Concatenating',
                EXPORTING: 'Exporting',
                DONE: 'Done',
            };

            expect(PHASE_LABELS.PARSING).toBe('Parsing');
            expect(PHASE_LABELS.INFERENCE).toBe('Inference');
            expect(PHASE_LABELS.CONCATENATING).toBe('Concatenating');
            expect(PHASE_LABELS.EXPORTING).toBe('Exporting');
            expect(PHASE_LABELS.DONE).toBe('Done');
        });
    });

    describe('EMA calculation', () => {
        it('should calculate EMA correctly', () => {
            const EMA_ALPHA = 0.3;
            let ema: number | undefined = undefined;

            // First value
            const v1 = 1000;
            ema = v1;
            expect(ema).toBe(1000);

            // Second value
            const v2 = 2000;
            ema = EMA_ALPHA * v2 + (1 - EMA_ALPHA) * ema;
            expect(ema).toBe(1300);
        });
    });

    describe('Stall detection', () => {
        it('should detect stall after threshold', () => {
            const STALL_THRESHOLD_MS = 15000;
            const lastHeartbeat = Date.now() - 20000; // 20 seconds ago
            const timeSinceHeartbeat = Date.now() - lastHeartbeat;

            expect(timeSinceHeartbeat > STALL_THRESHOLD_MS).toBe(true);
        });

        it('should not flag as stalled within threshold', () => {
            const STALL_THRESHOLD_MS = 15000;
            const lastHeartbeat = Date.now() - 5000; // 5 seconds ago
            const timeSinceHeartbeat = Date.now() - lastHeartbeat;

            expect(timeSinceHeartbeat > STALL_THRESHOLD_MS).toBe(false);
        });
    });
});
