import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ProgressInfo } from '../../utils/tts-runner.js';

let runTTS: (
    inputPath: string,
    outputPath: string,
    config: any,
    onProgress: (info: ProgressInfo) => void
) => Promise<void>;

describe('runTTS integration (mock backend)', () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const sampleEpubPath = path.join(projectRoot, 'tests', 'fixtures', 'sample.epub');
    const venvPythonPath = path.join(projectRoot, '.venv', 'bin', 'python');
    const appPath = path.join(projectRoot, 'app.py');
    let outputPath = '';

    beforeAll(async () => {
        vi.resetModules();
        vi.unmock('child_process');
        vi.unmock('fs');
        vi.unmock('glob');
        ({ runTTS } = await import('../../utils/tts-runner.js'));
    });

    afterEach(() => {
        if (outputPath && fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        const checkpointDir = `${outputPath}.checkpoint`;
        if (checkpointDir && fs.existsSync(checkpointDir)) {
            fs.rmSync(checkpointDir, { recursive: true, force: true });
        }

        outputPath = '';
    });

    it('runs full CLI-to-Python flow and emits progress updates', async () => {
        if (!fs.existsSync(sampleEpubPath) || !fs.existsSync(venvPythonPath) || !fs.existsSync(appPath)) {
            expect(true).toBe(true);
            return;
        }

        outputPath = path.join(os.tmpdir(), `audiobook-runtts-${Date.now()}.mp3`);
        const updates: ProgressInfo[] = [];

        await runTTS(
            sampleEpubPath,
            outputPath,
            {
                voice: 'af_heart',
                speed: 1.0,
                langCode: 'a',
                chunkChars: 120,
                useMPS: false,
                outputDir: null,
                workers: 1,
                backend: 'mock',
                outputFormat: 'mp3',
                bitrate: '128k',
                normalize: false,
                checkpointEnabled: true,
                noCheckpoint: false,
                resume: false,
            },
            (info) => updates.push(info)
        );

        expect(fs.existsSync(outputPath)).toBe(true);
        expect(fs.statSync(outputPath).size).toBeGreaterThan(0);

        const phases = updates
            .map((u) => u.phase)
            .filter((phase): phase is NonNullable<ProgressInfo['phase']> => Boolean(phase));

        expect(phases).toContain('PARSING');
        expect(phases).toContain('INFERENCE');
        expect(phases).toContain('CONCATENATING');
        expect(phases).toContain('EXPORTING');
        expect(phases).toContain('DONE');

        const parsingIdx = phases.indexOf('PARSING');
        const inferenceIdx = phases.indexOf('INFERENCE');
        const concatIdx = phases.indexOf('CONCATENATING');
        const exportIdx = phases.indexOf('EXPORTING');
        expect(parsingIdx).toBeLessThan(inferenceIdx);
        expect(inferenceIdx).toBeLessThan(concatIdx);
        expect(concatIdx).toBeLessThan(exportIdx);

        const progressValues = updates
            .map((u) => u.progress)
            .filter((p) => Number.isFinite(p));

        expect(progressValues.some((p) => p > 0)).toBe(true);
        expect(progressValues[progressValues.length - 1]).toBe(100);

        expect(updates.some((u) => (u.currentChunk || 0) > 0)).toBe(true);
    });
});
