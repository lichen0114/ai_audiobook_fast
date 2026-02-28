import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { execSync, spawnSync } from 'child_process';

const pythonRuntimeMocks = vi.hoisted(() => ({
    getAppPath: vi.fn((root?: string) => `${root ?? '/project'}/app.py`),
    getPreferredVenvPython: vi.fn((root?: string) => `${root ?? '/project'}/.venv/bin/python`),
    getProjectRoot: vi.fn(() => '/project'),
    resolvePythonPath: vi.fn(() => '/project/.venv/bin/python'),
}));

vi.mock('../../utils/python-runtime.js', () => pythonRuntimeMocks);

import { checkMLXDeps, quickCheck, runPreflightChecks } from '../../utils/preflight.js';

type EnvState = {
    ffmpegOk: boolean;
    venvExists: boolean;
    appExists: boolean;
    versionStatus: number;
    versionStdout: string;
    kokoroStatus: number;
    mlxStatus: number;
};

describe('preflight utils', () => {
    const baseState: EnvState = {
        ffmpegOk: true,
        venvExists: true,
        appExists: true,
        versionStatus: 0,
        versionStdout: 'Python 3.11.9\n',
        kokoroStatus: 0,
        mlxStatus: 0,
    };

    let state: EnvState;

    beforeEach(() => {
        vi.clearAllMocks();
        state = { ...baseState };

        vi.mocked(fs.existsSync).mockImplementation((path) => {
            const value = String(path);
            if (value.endsWith('/.venv/bin/python') || value.endsWith('\\.venv\\Scripts\\python.exe')) {
                return state.venvExists;
            }
            if (value.endsWith('/app.py')) {
                return state.appExists;
            }
            return true;
        });

        vi.mocked(execSync).mockImplementation(() => {
            if (!state.ffmpegOk) {
                throw new Error('ffmpeg missing');
            }
            return Buffer.from('ffmpeg version');
        });

        vi.mocked(spawnSync).mockImplementation((cmd, args) => {
            const argList = (args ?? []).map(String);
            if (argList.includes('--version')) {
                return {
                    status: state.versionStatus,
                    stdout: state.versionStdout,
                    stderr: '',
                } as any;
            }
            if (argList[0] === '-c' && argList[1] === 'import kokoro') {
                return { status: state.kokoroStatus, stdout: '', stderr: '' } as any;
            }
            if (argList[0] === '-c' && argList[1]?.includes('mlx_audio')) {
                return { status: state.mlxStatus, stdout: '', stderr: '' } as any;
            }
            return { status: 1, stdout: '', stderr: 'unexpected call' } as any;
        });
    });

    it('reports all critical checks as ok when dependencies are present', () => {
        const result = runPreflightChecks();

        expect(result.passed).toBe(true);
        expect(result.checks).toEqual([
            expect.objectContaining({ name: 'FFmpeg', status: 'ok' }),
            expect.objectContaining({ name: 'Python venv', status: 'ok', message: 'Python 3.11.9' }),
            expect.objectContaining({ name: 'Python deps', status: 'ok' }),
            expect.objectContaining({ name: 'App script', status: 'ok' }),
        ]);
    });

    it('flags unsupported Python version and fails preflight', () => {
        state.versionStdout = 'Python 3.9.18\n';

        const result = runPreflightChecks();
        const pythonCheck = result.checks.find((check) => check.name === 'Python venv');

        expect(result.passed).toBe(false);
        expect(pythonCheck).toEqual(
            expect.objectContaining({
                status: 'error',
                message: expect.stringContaining('3.9.18'),
            })
        );
    });

    it('flags missing ffmpeg and kokoro dependency errors', () => {
        state.ffmpegOk = false;
        state.kokoroStatus = 1;

        const result = runPreflightChecks();
        const ffmpegCheck = result.checks.find((check) => check.name === 'FFmpeg');
        const depsCheck = result.checks.find((check) => check.name === 'Python deps');

        expect(result.passed).toBe(false);
        expect(ffmpegCheck?.status).toBe('error');
        expect(depsCheck).toEqual(
            expect.objectContaining({
                status: 'error',
                message: 'Kokoro TTS not installed',
            })
        );
    });

    it('warns when MLX dependencies are missing but does not error', () => {
        state.mlxStatus = 1;

        const check = checkMLXDeps();

        expect(check).toEqual(
            expect.objectContaining({
                name: 'MLX Backend',
                status: 'warning',
                message: 'MLX-Audio not installed (optional)',
            })
        );
    });

    it('returns warning when MLX check cannot run because venv is missing', () => {
        state.venvExists = false;

        const check = checkMLXDeps();

        expect(check.status).toBe('warning');
        expect(check.message).toContain('venv not found');
    });

    it('quickCheck returns false when ffmpeg is missing', () => {
        state.ffmpegOk = false;
        expect(quickCheck()).toBe(false);
    });

    it('quickCheck returns false when venv or app script are missing', () => {
        state.venvExists = false;
        expect(quickCheck()).toBe(false);

        state.venvExists = true;
        state.appExists = false;
        expect(quickCheck()).toBe(false);
    });

    it('quickCheck returns false when python resolution throws', () => {
        pythonRuntimeMocks.resolvePythonPath.mockImplementationOnce(() => {
            throw new Error('no python');
        });

        expect(quickCheck()).toBe(false);
    });

    it('quickCheck returns true when all checks pass', () => {
        expect(quickCheck()).toBe(true);
    });
});
