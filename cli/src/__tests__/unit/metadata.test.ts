import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';

const runtimeMocks = vi.hoisted(() => ({
    resolvePythonRuntime: vi.fn(() => ({
        projectRoot: '/project',
        appPath: '/project/app.py',
        pythonPath: '/project/.venv/bin/python',
    })),
    getNullDevice: vi.fn(() => '/dev/null'),
}));

vi.mock('../../utils/python-runtime.js', () => runtimeMocks);

import { extractMetadata } from '../../utils/metadata.js';

class FakeChildProcess extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
}

describe('metadata utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses metadata lines from backend stdout', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = extractMetadata('/books/demo.epub');

        proc.stdout.emit('data', Buffer.from('METADATA:title:Test Book\n'));
        proc.stdout.emit('data', Buffer.from('METADATA:author:Jane Doe\n'));
        proc.stdout.emit('data', Buffer.from('METADATA:has_cover:true\n'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({
            title: 'Test Book',
            author: 'Jane Doe',
            hasCover: true,
            extracted: true,
        });

        expect(spawn).toHaveBeenCalledWith(
            '/project/.venv/bin/python',
            ['/project/app.py', '--input', '/books/demo.epub', '--output', '/dev/null', '--extract_metadata'],
            expect.objectContaining({
                cwd: '/project',
                env: expect.objectContaining({ PYTHONUNBUFFERED: '1' }),
            })
        );
    });

    it('returns extracted status without synthetic fallback metadata when lines are missing', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = extractMetadata('/books/demo.epub');
        proc.stdout.emit('data', Buffer.from('unrelated line\n'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({
            hasCover: false,
            extracted: true,
        });
    });

    it('rejects when backend exits non-zero', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = extractMetadata('/books/demo.epub');
        proc.stderr.emit('data', Buffer.from('bad epub'));
        proc.emit('close', 2);

        await expect(promise).rejects.toThrow('Metadata extraction failed with code 2');
    });

    it('rejects on spawn error', async () => {
        const proc = new FakeChildProcess();
        vi.mocked(spawn).mockReturnValue(proc as any);

        const promise = extractMetadata('/books/demo.epub');
        proc.emit('error', new Error('spawn exploded'));

        await expect(promise).rejects.toThrow('Failed to extract metadata: spawn exploded');
    });
});
