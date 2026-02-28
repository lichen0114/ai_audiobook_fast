import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TTSConfig } from '../../types/profile.js';

vi.mock('../../utils/python-runtime.js', () => ({
    resolvePythonRuntime: vi.fn(),
}));

import { resolvePythonRuntime } from '../../utils/python-runtime.js';
import { createParserState, parseOutputLine, runTTS } from '../../utils/tts-runner.js';

interface SpawnScript {
    stdout?: string[];
    stderr?: string[];
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
}

class MockStream extends EventEmitter {}

class MockChildProcess extends EventEmitter {
    stdout = new MockStream();
    stderr = new MockStream();
    kill = vi.fn();
}

function createMockChildProcess(script: SpawnScript): MockChildProcess {
    const child = new MockChildProcess();

    queueMicrotask(() => {
        if (script.error) {
            child.emit('error', script.error);
            return;
        }

        for (const line of script.stdout ?? []) {
            child.stdout.emit('data', Buffer.from(`${line}\n`));
        }
        for (const line of script.stderr ?? []) {
            child.stderr.emit('data', Buffer.from(`${line}\n`));
        }

        child.emit('close', script.code ?? 0, script.signal ?? null);
    });

    return child;
}

function getArgValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}

const baseConfig: TTSConfig = {
    voice: 'af_heart',
    speed: 1,
    langCode: 'a',
    chunkChars: 900,
    useMPS: true,
    outputDir: null,
    workers: 2,
    backend: 'auto',
    outputFormat: 'mp3',
    bitrate: '192k',
    normalize: false,
    checkpointEnabled: false,
    pipelineMode: 'auto',
    recoveryMode: 'apple-balanced',
};

describe('tts-runner parser and recovery flow', () => {
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

    it('parses phase transitions and validates phase values', () => {
        const state = createParserState();

        const parsing = parseOutputLine('PHASE:PARSING', state);
        expect(parsing?.phase).toBe('PARSING');

        const invalid = parseOutputLine('PHASE:SOMETHING_ELSE', state);
        expect(invalid).toBeNull();
    });

    it('parses metadata updates and keeps parser state', () => {
        const state = createParserState();

        parseOutputLine('METADATA:backend_resolved:mock', state);
        parseOutputLine('METADATA:total_chars:12345', state);
        const chapterUpdate = parseOutputLine('METADATA:chapter_count:12', state);

        expect(chapterUpdate?.backendResolved).toBe('mock');
        expect(chapterUpdate?.totalChars).toBe(12345);
        expect(chapterUpdate?.chapterCount).toBe(12);
    });

    it('parses parse-progress messages and keeps parser state', () => {
        const state = createParserState();

        const parseUpdate = parseOutputLine('PARSE_PROGRESS:3/10:2', state);
        expect(parseUpdate?.parseCurrentItem).toBe(3);
        expect(parseUpdate?.parseTotalItems).toBe(10);
        expect(parseUpdate?.parseChapterCount).toBe(2);

        const phase = parseOutputLine('PHASE:INFERENCE', state);
        expect(phase?.parseCurrentItem).toBe(3);
        expect(phase?.parseTotalItems).toBe(10);
        expect(phase?.parseChapterCount).toBe(2);
    });

    it('parses worker and timing messages', () => {
        const state = createParserState();

        const worker = parseOutputLine('WORKER:1:ENCODE:File: book.mp3', state);
        expect(worker?.workerStatus).toEqual({
            id: 1,
            status: 'ENCODE',
            details: 'File: book.mp3',
        });

        const timing = parseOutputLine('TIMING:5:2340', state);
        expect(timing?.chunkTimingMs).toBe(2340);
    });

    it('parses progress and updates state for following messages', () => {
        const state = createParserState();

        const progress = parseOutputLine('PROGRESS:5/20 chunks', state);
        expect(progress?.progress).toBe(25);
        expect(progress?.currentChunk).toBe(5);
        expect(progress?.totalChunks).toBe(20);

        const phase = parseOutputLine('PHASE:INFERENCE', state);
        expect(phase?.progress).toBe(25);
        expect(phase?.currentChunk).toBe(5);
        expect(phase?.totalChunks).toBe(20);
    });

    it('parses progress lines without prefix and rejects invalid lines', () => {
        const state = createParserState();

        const progress = parseOutputLine('42/100 chunks', state);
        expect(progress?.progress).toBe(42);

        expect(parseOutputLine('PROGRESS:4/0 chunks', state)).toBeNull();
        expect(parseOutputLine('WORKER:bad', state)).toBeNull();
        expect(parseOutputLine('not an ipc message', state)).toBeNull();
    });

    it('parses heartbeat timestamps', () => {
        const state = createParserState();
        const heartbeat = parseOutputLine('HEARTBEAT:1704067200000', state);
        expect(heartbeat?.heartbeatTs).toBe(1704067200000);
    });

    it('parses structured JSON events including recovery payloads', () => {
        const state = createParserState();

        const phase = parseOutputLine('{"type":"phase","phase":"PARSING"}', state);
        expect(phase?.phase).toBe('PARSING');

        const parseProgress = parseOutputLine('{"type":"parse_progress","current_item":4,"total_items":12,"current_chapter_count":3}', state);
        expect(parseProgress?.parseCurrentItem).toBe(4);
        expect(parseProgress?.parseTotalItems).toBe(12);
        expect(parseProgress?.parseChapterCount).toBe(3);

        const metadata = parseOutputLine('{"type":"metadata","key":"backend_resolved","value":"mock"}', state);
        expect(metadata?.backendResolved).toBe('mock');

        const progress = parseOutputLine('{"type":"progress","current_chunk":4,"total_chunks":10}', state);
        expect(progress?.progress).toBe(40);

        const timing = parseOutputLine('{"type":"timing","chunk_timing_ms":321}', state);
        expect(timing?.chunkTimingMs).toBe(321);

        const recovery = parseOutputLine('{"type":"recovery","attempt":2,"max_attempts":2,"reason":"mlx backend crashed","backend":"pytorch","use_mps":false,"pipeline_mode":"sequential","chunk_chars":600,"workers":1}', state);
        expect(recovery?.recovery).toEqual({
            attempt: 2,
            maxAttempts: 2,
            reason: 'mlx backend crashed',
            backend: 'pytorch',
            useMPS: false,
            pipelineMode: 'sequential',
            chunkChars: 600,
            workers: 1,
        });
    });

    it('retries once with a safer Apple Silicon profile after a native crash', async () => {
        vi.mocked(spawn)
            .mockImplementationOnce(() => createMockChildProcess({
                stderr: ['Metal out of memory', 'Abort trap: 6'],
                code: 1,
            }) as any)
            .mockImplementationOnce(() => createMockChildProcess({
                stdout: [
                    '{"type":"phase","phase":"PARSING"}',
                    '{"type":"progress","current_chunk":1,"total_chunks":1}',
                ],
                code: 0,
            }) as any);

        const updates: any[] = [];

        await runTTS('book.epub', 'book.mp3', baseConfig, (info) => updates.push(info));

        expect(spawn).toHaveBeenCalledTimes(2);

        const firstArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
        const retryArgs = vi.mocked(spawn).mock.calls[1][1] as string[];
        const retryEnv = vi.mocked(spawn).mock.calls[1][2]?.env as Record<string, string> | undefined;

        expect(getArgValue(firstArgs, '--device')).toBe('mps');
        expect(getArgValue(retryArgs, '--backend')).toBe('pytorch');
        expect(getArgValue(retryArgs, '--device')).toBe('cpu');
        expect(getArgValue(retryArgs, '--workers')).toBe('1');
        expect(getArgValue(retryArgs, '--chunk_chars')).toBe('400');
        expect(getArgValue(retryArgs, '--pipeline_mode')).toBe('sequential');
        expect(retryEnv?.PYTORCH_ENABLE_MPS_FALLBACK).toBeUndefined();

        expect(updates.some((update) => update.recovery)).toBe(true);
        expect(updates.find((update) => update.recovery)?.recovery).toMatchObject({
            attempt: 2,
            backend: 'pytorch',
            useMPS: false,
            pipelineMode: 'sequential',
            chunkChars: 400,
            workers: 1,
        });
        expect(updates[updates.length - 1]?.phase).toBe('DONE');
    });

    it('does not retry when the failure is not recoverable', async () => {
        vi.mocked(spawn).mockImplementationOnce(() => createMockChildProcess({
            stderr: ['Input EPUB not found'],
            code: 1,
        }) as any);

        await expect(runTTS('missing.epub', 'book.mp3', baseConfig, () => undefined)).rejects.toThrow('Input EPUB not found');
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('passes M4B metadata flags only when explicit overrides exist', async () => {
        vi.mocked(spawn).mockImplementation(() => createMockChildProcess({
            stdout: ['{"type":"done"}'],
            code: 0,
        }) as any);

        const config: TTSConfig = {
            ...baseConfig,
            outputFormat: 'm4b',
            metadataTitle: 'Explicit Title',
            metadataAuthor: 'Explicit Author',
            metadataCover: '/tmp/cover.png',
        };

        await runTTS('book.epub', 'book.m4b', config, () => undefined);

        const args = vi.mocked(spawn).mock.calls[0][1] as string[];
        expect(getArgValue(args, '--format')).toBe('m4b');
        expect(getArgValue(args, '--title')).toBe('Explicit Title');
        expect(getArgValue(args, '--author')).toBe('Explicit Author');
        expect(getArgValue(args, '--cover')).toBe('/tmp/cover.png');
    });

    it('omits M4B metadata flags when no explicit overrides are present', async () => {
        vi.mocked(spawn).mockImplementation(() => createMockChildProcess({
            stdout: ['{"type":"done"}'],
            code: 0,
        }) as any);

        await runTTS('book.epub', 'book.m4b', {
            ...baseConfig,
            outputFormat: 'm4b',
            metadataTitle: undefined,
            metadataAuthor: undefined,
            metadataCover: undefined,
        }, () => undefined);

        const args = vi.mocked(spawn).mock.calls[0][1] as string[];
        expect(args.includes('--title')).toBe(false);
        expect(args.includes('--author')).toBe(false);
        expect(args.includes('--cover')).toBe(false);
    });

    it('uses reduced thread env and cpu device on low-memory Apple hosts', async () => {
        process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE = '1';

        vi.mocked(spawn).mockImplementation(() => createMockChildProcess({
            stdout: ['{"type":"done"}'],
            code: 0,
        }) as any);

        await runTTS('book.epub', 'book.mp3', {
            ...baseConfig,
            useMPS: false,
        }, () => undefined);

        const args = vi.mocked(spawn).mock.calls[0][1] as string[];
        const env = vi.mocked(spawn).mock.calls[0][2]?.env as Record<string, string> | undefined;

        expect(getArgValue(args, '--device')).toBe('cpu');
        expect(env?.OMP_NUM_THREADS).toBe('2');
        expect(env?.OPENBLAS_NUM_THREADS).toBe('1');
    });
});
