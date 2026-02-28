import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

import {
    getNullDevice,
    getPreferredVenvPython,
    resolvePythonPath,
    resolvePythonRuntime,
} from '../../utils/python-runtime.js';

describe('python-runtime', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
    });

    it('prefers AUDIOBOOK_PYTHON when executable', () => {
        process.env.AUDIOBOOK_PYTHON = '/custom/python';
        vi.mocked(fs.existsSync).mockImplementation((path) => path === '/custom/python');
        vi.mocked(spawnSync).mockImplementation((cmd) => ({ status: cmd === '/custom/python' ? 0 : 1 } as any));

        expect(resolvePythonPath('/project')).toBe('/custom/python');
        expect(spawnSync).toHaveBeenCalledWith('/custom/python', ['--version'], expect.any(Object));
    });

    it('skips missing path candidates and falls back to python3', () => {
        process.env.AUDIOBOOK_PYTHON = '/missing/python';
        vi.mocked(fs.existsSync).mockImplementation((path) => {
            const p = String(path);
            return p === 'python3' || p === 'python' ? true : false;
        });
        vi.mocked(spawnSync).mockImplementation((cmd) => ({ status: cmd === 'python3' ? 0 : 1 } as any));

        expect(resolvePythonPath('/project')).toBe('python3');
        expect(vi.mocked(spawnSync).mock.calls.some(([cmd]) => cmd === '/missing/python')).toBe(false);
    });

    it('raises when no interpreter is usable', () => {
        delete process.env.AUDIOBOOK_PYTHON;
        delete process.env.PYTHON;
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(spawnSync).mockImplementation(() => ({ status: 1 } as any));

        expect(() => resolvePythonPath('/project')).toThrow(
            'Unable to find a working Python interpreter'
        );
    });

    it('builds runtime object with project and app paths', () => {
        vi.mocked(fs.existsSync).mockImplementation((path) => String(path).includes('.venv'));
        vi.mocked(spawnSync).mockImplementation((cmd) => ({ status: String(cmd).includes('.venv') ? 0 : 1 } as any));

        const runtime = resolvePythonRuntime();

        expect(runtime.projectRoot.length).toBeGreaterThan(0);
        expect(runtime.appPath.endsWith('/app.py')).toBe(true);
        expect(runtime.pythonPath.length).toBeGreaterThan(0);
    });

    it('returns the expected null device for the current platform', () => {
        const expected = process.platform === 'win32' ? 'NUL' : '/dev/null';
        expect(getNullDevice()).toBe(expected);
    });

    it('computes preferred venv path under a project root', () => {
        const venvPython = getPreferredVenvPython('/project');
        if (process.platform === 'win32') {
            expect(venvPython).toBe('/project/.venv/Scripts/python.exe');
        } else {
            expect(venvPython).toBe('/project/.venv/bin/python');
        }
    });
});
