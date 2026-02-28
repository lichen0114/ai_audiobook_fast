import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';

import { getOpenFolderCommand, openFolder } from '../../utils/open-folder.js';

describe('open-folder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns macOS command', () => {
        expect(getOpenFolderCommand('/tmp/out', 'darwin')).toEqual({
            command: 'open',
            args: ['/tmp/out'],
        });
    });

    it('returns Windows command', () => {
        expect(getOpenFolderCommand('C:\\temp', 'win32')).toEqual({
            command: 'cmd',
            args: ['/c', 'start', '', 'C:\\temp'],
        });
    });

    it('returns Linux command', () => {
        expect(getOpenFolderCommand('/tmp/out', 'linux')).toEqual({
            command: 'xdg-open',
            args: ['/tmp/out'],
        });
    });

    it('spawns detached process and unreferences it', () => {
        const unref = vi.fn();
        vi.mocked(spawn).mockReturnValue({ unref } as any);

        openFolder('/tmp/out');

        const expected = getOpenFolderCommand('/tmp/out');
        expect(spawn).toHaveBeenCalledWith(expected.command, expected.args, {
            detached: true,
            stdio: 'ignore',
        });
        expect(unref).toHaveBeenCalledOnce();
    });
});
