import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { spawn } from 'child_process';

const runtimeMocks = vi.hoisted(() => ({
    resolvePythonRuntime: vi.fn(() => ({
        projectRoot: '/project',
        appPath: '/project/app.py',
        pythonPath: '/project/.venv/bin/python',
    })),
}));

vi.mock('../../utils/python-runtime.js', () => runtimeMocks);

import { checkCheckpoint, deleteCheckpoint } from '../../utils/checkpoint.js';

class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
}

describe('checkpoint utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns none status when backend reports no checkpoint', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = checkCheckpoint('/books/demo.epub', '/out/demo.mp3');
        proc.stdout.emit('data', Buffer.from('CHECKPOINT:NONE\n'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({ exists: false, valid: false });
    });

    it('parses a valid checkpoint result', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = checkCheckpoint('/books/demo.epub', '/out/demo.mp3');
        proc.stdout.emit('data', Buffer.from('CHECKPOINT:FOUND:12:5\n'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({
            exists: true,
            valid: true,
            totalChunks: 12,
            completedChunks: 5,
        });
    });

    it('parses invalid checkpoint reason', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = checkCheckpoint('/books/demo.epub', '/out/demo.mp3');
        proc.stdout.emit('data', Buffer.from('CHECKPOINT:INVALID:hash mismatch\n'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({
            exists: true,
            valid: false,
            reason: 'hash mismatch',
        });
    });

    it('rejects on backend exit failure', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = checkCheckpoint('/books/demo.epub', '/out/demo.mp3');
        proc.stderr.emit('data', Buffer.from('boom'));
        proc.emit('close', 1);

        await expect(promise).rejects.toThrow('Checkpoint check failed with code 1');
    });

    it('rejects on spawn error', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = checkCheckpoint('/books/demo.epub', '/out/demo.mp3');
        proc.emit('error', new Error('spawn failed'));

        await expect(promise).rejects.toThrow('Failed to check checkpoint: spawn failed');
    });

    it('deletes checkpoint directory when present', async () => {
        vi.mocked(fs.existsSync).mockImplementation((path) => String(path) === '/out/demo.mp3.checkpoint');
        const rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any);

        await deleteCheckpoint('/out/demo.mp3');

        expect(fs.existsSync).toHaveBeenCalledWith('/out/demo.mp3.checkpoint');
        expect(rmSyncSpy).toHaveBeenCalledWith('/out/demo.mp3.checkpoint', {
            recursive: true,
            force: true,
        });
    });

    it('skips delete when checkpoint directory does not exist', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        const rmSyncSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any);

        await deleteCheckpoint('/out/demo.mp3');

        expect(rmSyncSpy).not.toHaveBeenCalled();
    });
});
