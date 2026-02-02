import { spawn } from 'child_process';
import * as path from 'path';
import type { TTSConfig } from '../App.js';

export interface ProgressInfo {
    progress: number;
    currentChunk: number;
    totalChunks: number;
}

export function runTTS(
    inputPath: string,
    outputPath: string,
    config: TTSConfig,
    onProgress: (info: ProgressInfo) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Get the project root (parent of cli directory)
        const projectRoot = path.resolve(import.meta.dirname, '../../..');
        const pythonScript = path.join(projectRoot, 'app.py');

        // Check if we're in a virtual environment
        const venvPython = path.join(projectRoot, '.venv', 'bin', 'python');

        const args = [
            pythonScript,
            '--input', inputPath,
            '--output', outputPath,
            '--voice', config.voice,
            '--speed', config.speed.toString(),
            '--lang_code', config.langCode,
            '--chunk_chars', config.chunkChars.toString(),
        ];

        const process = spawn(venvPython, args, {
            cwd: projectRoot,
            env: {
                ...globalThis.process.env,
                PYTHONUNBUFFERED: '1',
                // Enable Apple Silicon GPU acceleration when useMPS is true
                ...(config.useMPS ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}),
            },
        });

        let lastProgress = 0;
        let lastTotal = 0;
        let stderr = '';

        process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();

            // Parse progress from explicit PROGRESS output or rich progress bar
            // Looking for patterns like "PROGRESS:42/100 chunks" or "42/100 chunks"
            const chunkMatch = output.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
            if (chunkMatch) {
                const current = parseInt(chunkMatch[1], 10);
                const total = parseInt(chunkMatch[2], 10);
                const progress = Math.round((current / total) * 100);
                if (progress > lastProgress || total !== lastTotal) {
                    lastProgress = progress;
                    lastTotal = total;
                    onProgress({ progress, currentChunk: current, totalChunks: total });
                }
            }
        });

        process.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();

            // Also check stderr for progress (rich sometimes writes there)
            const chunkMatch = stderr.match(/(\d+)\/(\d+)\s*chunks/);
            if (chunkMatch) {
                const current = parseInt(chunkMatch[1], 10);
                const total = parseInt(chunkMatch[2], 10);
                const progress = Math.round((current / total) * 100);
                if (progress > lastProgress || total !== lastTotal) {
                    lastProgress = progress;
                    lastTotal = total;
                    onProgress({ progress, currentChunk: current, totalChunks: total });
                }
            }
        });

        process.on('error', (err) => {
            reject(new Error(`Failed to start Python process: ${err.message}`));
        });

        process.on('close', (code) => {
            if (code === 0) {
                onProgress({ progress: 100, currentChunk: lastTotal, totalChunks: lastTotal });
                resolve();
            } else {
                reject(new Error(`Python process exited with code ${code}\n${stderr}`));
            }
        });
    });
}
