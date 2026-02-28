import { spawn } from 'child_process';
import { getNullDevice, resolvePythonRuntime } from './python-runtime.js';

export interface ExtractedMetadata {
    title?: string;
    author?: string;
    hasCover: boolean;
    extracted: boolean;
}

/**
 * Extract metadata from an EPUB file using the Python backend.
 */
export function extractMetadata(epubPath: string): Promise<ExtractedMetadata> {
    return new Promise((resolve, reject) => {
        const { projectRoot, appPath: pythonScript, pythonPath } = resolvePythonRuntime();

        const args = [
            pythonScript,
            '--input', epubPath,
            '--output', getNullDevice(), // Not used in extract mode
            '--extract_metadata',
        ];

        const process = spawn(pythonPath, args, {
            cwd: projectRoot,
            env: {
                ...globalThis.process.env,
                PYTHONUNBUFFERED: '1',
            },
        });

        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        process.on('error', (err) => {
            reject(new Error(`Failed to extract metadata: ${err.message}`));
        });

        process.on('close', (code) => {
            if (code === 0) {
                // Parse the metadata from stdout
                const metadata: ExtractedMetadata = {
                    hasCover: false,
                    extracted: true,
                };

                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.startsWith('METADATA:title:')) {
                        metadata.title = line.slice(15);
                    } else if (line.startsWith('METADATA:author:')) {
                        metadata.author = line.slice(16);
                    } else if (line.startsWith('METADATA:has_cover:')) {
                        metadata.hasCover = line.slice(19) === 'true';
                    }
                }

                resolve(metadata);
            } else {
                reject(new Error(`Metadata extraction failed with code ${code}\n${stderr}`));
            }
        });
    });
}
