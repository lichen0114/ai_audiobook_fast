import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TTSConfig } from '../../types/profile.js';

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('../../utils/python-runtime.js', () => ({
    resolvePythonRuntime: vi.fn(),
}));

import { spawn } from 'child_process';
import { resolvePythonRuntime } from '../../utils/python-runtime.js';
import { planBatchJobs } from '../../utils/batch-planner.js';

class MockStream extends EventEmitter {}

class MockChildProcess extends EventEmitter {
    stdout = new MockStream();
    stderr = new MockStream();
}

function emitInspection(result: object): MockChildProcess {
    const child = new MockChildProcess();
    queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'inspection', result })}\n`));
        child.emit('close', 0);
    });
    return child;
}

const baseConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1,
    langCode: 'a',
    chunkChars: 900,
    useMPS: true,
    outputDir: '/tmp/out',
    workers: 1,
    backend: 'auto',
    outputFormat: 'mp3',
    bitrate: '192k',
    normalize: false,
    checkpointEnabled: true,
    pipelineMode: 'auto',
    recoveryMode: 'apple-balanced',
    metadataTitle: 'Global title that should be stripped for multi-file batches',
};

describe('batch-planner', () => {
    beforeEach(() => {
        process.env.AUDIOBOOK_FORCE_APPLE_SILICON = '1';
        process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE = '0';
        vi.mocked(resolvePythonRuntime).mockReturnValue({
            projectRoot: '/tmp/audiobook-fast',
            appPath: '/tmp/audiobook-fast/app.py',
            pythonPath: 'python3',
        });
        vi.mocked(spawn).mockReset();
    });

    afterEach(() => {
        delete process.env.AUDIOBOOK_FORCE_APPLE_SILICON;
        delete process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE;
        vi.clearAllMocks();
    });

    it('builds per-file checkpoint actions and blocks duplicate output paths', async () => {
        vi.mocked(spawn)
            .mockImplementationOnce(() => emitInspection({
                input_path: '/books/a/book.epub',
                output_path: '/tmp/out/book.mp3',
                resolved_backend: 'mock',
                resolved_chunk_chars: 900,
                resolved_pipeline_mode: 'sequential',
                output_format: 'mp3',
                total_chars: 1000,
                total_chunks: 5,
                chapter_count: 3,
                epub_metadata: { title: 'Book A', author: 'Author A', has_cover: false },
                checkpoint: {
                    exists: true,
                    resume_compatible: true,
                    total_chunks: 5,
                    completed_chunks: 3,
                    missing_audio_chunks: [],
                },
                warnings: [],
                errors: [],
            }) as any)
            .mockImplementationOnce(() => emitInspection({
                input_path: '/books/b/book.epub',
                output_path: '/tmp/out/book.mp3',
                resolved_backend: 'mock',
                resolved_chunk_chars: 900,
                resolved_pipeline_mode: 'sequential',
                output_format: 'mp3',
                total_chars: 500,
                total_chunks: 2,
                chapter_count: 1,
                epub_metadata: { title: 'Book B', author: 'Author B', has_cover: true },
                checkpoint: {
                    exists: true,
                    resume_compatible: false,
                    total_chunks: 2,
                    completed_chunks: 1,
                    reason: 'config_mismatch',
                    missing_audio_chunks: [],
                },
                warnings: [],
                errors: [],
            }) as any);

        const plan = await planBatchJobs(
            ['/books/a/book.epub', '/books/b/book.epub'],
            baseConfig,
        );

        expect(plan.jobs[0].checkpoint.action).toBe('resume');
        expect(plan.jobs[1].checkpoint.action).toBe('start-fresh');
        expect(plan.jobs[0].blocked).toBe(true);
        expect(plan.jobs[1].blocked).toBe(true);
        expect(plan.blockedJobs).toBe(2);
        expect(plan.jobs[0].errors[0]).toContain('Output path collides');
        expect(plan.jobs[1].warnings[0]).toContain('Existing checkpoint will be deleted before starting fresh');

        const firstArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
        expect(firstArgs.includes('--title')).toBe(false);
        expect(firstArgs.includes('--device')).toBe(true);
        expect(firstArgs[firstArgs.indexOf('--device') + 1]).toBe('mps');
    });

    it('keeps metadata overrides for a single-file M4B job', async () => {
        vi.mocked(spawn).mockImplementationOnce(() => emitInspection({
            input_path: '/books/a/book.epub',
            output_path: '/tmp/out/book.m4b',
            resolved_backend: 'mock',
            resolved_chunk_chars: 900,
            resolved_pipeline_mode: 'sequential',
            output_format: 'm4b',
            total_chars: 1000,
            total_chunks: 5,
            chapter_count: 3,
            epub_metadata: { title: 'Book A', author: 'Author A', has_cover: true },
            checkpoint: {
                exists: false,
                resume_compatible: false,
                missing_audio_chunks: [],
            },
            warnings: [],
            errors: [],
        }) as any);

        const plan = await planBatchJobs(
            ['/books/a/book.epub'],
            {
                ...baseConfig,
                outputFormat: 'm4b',
                metadataTitle: 'Explicit Title',
                metadataAuthor: 'Explicit Author',
                metadataCover: '/tmp/cover.png',
            },
        );

        expect(plan.jobs[0].config.metadataTitle).toBe('Explicit Title');
        expect(plan.jobs[0].config.metadataAuthor).toBe('Explicit Author');
        expect(plan.jobs[0].config.metadataCover).toBe('/tmp/cover.png');

        const args = vi.mocked(spawn).mock.calls[0][1] as string[];
        expect(args.includes('--title')).toBe(true);
        expect(args.includes('--author')).toBe(true);
        expect(args.includes('--cover')).toBe(true);
        expect(args[args.indexOf('--device') + 1]).toBe('mps');
    });
});
