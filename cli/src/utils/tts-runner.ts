import { spawn } from 'child_process';
import * as path from 'path';
import type { TTSConfig } from '../App.js';

export interface WorkerStatus {
    id: number;
    status: 'IDLE' | 'INFER' | 'ENCODE';
    details: string;
}

export interface ProgressInfo {
    progress: number;
    currentChunk: number;
    totalChunks: number;
    workerStatus?: WorkerStatus;
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
            '--workers', (config.workers || 2).toString(),
            '--no_rich', // Disable rich progress bar to prevent CLI flashing
        ];

        const process = spawn(venvPython, args, {
            cwd: projectRoot,
            env: {
                ...globalThis.process.env,
                PYTHONUNBUFFERED: '1',
                // Enable Apple Silicon GPU acceleration when useMPS is true
                ...(config.useMPS ? {
                    PYTORCH_ENABLE_MPS_FALLBACK: '1',
                    // MPS memory optimization - aggressive cleanup for 8GB Macs
                    PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
                    // Limit thread parallelism to reduce GIL contention
                    OMP_NUM_THREADS: '4',
                    OPENBLAS_NUM_THREADS: '2',
                } : {}),
            },
        });

        let lastProgress = 0;
        let lastCurrentChunk = 0;
        let lastTotal = 0;
        let stderr = '';
        const MAX_STDERR = 10000;

        process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            // console.log("Has stdout", output)

            const lines = output.split('\n');
            for (const line of lines) {
                // Parse worker status
                // WORKER:0:INFER:Chunk 5/50
                if (line.startsWith('WORKER:')) {
                    const parts = line.split(':');
                    if (parts.length >= 4) {
                        const id = parseInt(parts[1], 10);
                        const status = parts[2] as 'IDLE' | 'INFER' | 'ENCODE';
                        const details = parts.slice(3).join(':'); // Rejoin rest in case details contain colons

                        onProgress({
                            progress: lastProgress,
                            currentChunk: lastCurrentChunk,
                            totalChunks: lastTotal,
                            workerStatus: { id, status, details }
                        });
                    }
                }

                // Parse progress from explicit PROGRESS output or rich progress bar
                // Looking for patterns like "PROGRESS:42/100 chunks" or "42/100 chunks"
                const chunkMatch = line.match(/(?:PROGRESS:)?(\d+)\/(\d+)\s*chunks/);
                if (chunkMatch) {
                    const current = parseInt(chunkMatch[1], 10);
                    const total = parseInt(chunkMatch[2], 10);
                    const progress = Math.round((current / total) * 100);
                    // Always update on progress match
                    lastProgress = progress;
                    lastCurrentChunk = current;
                    lastTotal = total;
                    onProgress({ progress, currentChunk: current, totalChunks: total });
                }
            }
        });

        process.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            // Bound stderr buffer to prevent memory leak on long runs
            if (stderr.length > MAX_STDERR) {
                stderr = stderr.slice(-MAX_STDERR);
            }

            // Also check stderr for progress (rich sometimes writes there)
            const chunkMatch = stderr.match(/(\d+)\/(\d+)\s*chunks/);
            if (chunkMatch) {
                const current = parseInt(chunkMatch[1], 10);
                const total = parseInt(chunkMatch[2], 10);
                const progress = Math.round((current / total) * 100);
                if (progress > lastProgress || total !== lastTotal) {
                    lastProgress = progress;
                    lastCurrentChunk = current;
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
