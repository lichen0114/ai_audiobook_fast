import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import {
    getAppPath,
    getPreferredVenvPython,
    getProjectRoot,
    resolvePythonPath,
} from './python-runtime.js';

export interface PreflightCheck {
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    fix?: string;
}

export interface PreflightResult {
    passed: boolean;
    checks: PreflightCheck[];
}

function hasPythonModule(venvPython: string, moduleName: string): boolean {
    const result = spawnSync(
        venvPython,
        [
            '-c',
            `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`,
        ],
        {
            encoding: 'utf-8',
            timeout: 5000,
        }
    );

    return result.status === 0;
}

/**
 * Check if FFmpeg is installed
 */
function checkFFmpeg(): PreflightCheck {
    try {
        execSync('ffmpeg -version', { stdio: 'pipe' });
        return {
            name: 'FFmpeg',
            status: 'ok',
            message: 'FFmpeg is installed',
        };
    } catch {
        return {
            name: 'FFmpeg',
            status: 'error',
            message: 'FFmpeg is not installed',
            fix: 'brew install ffmpeg',
        };
    }
}

/**
 * Check if Python virtual environment exists and has correct version
 */
function checkPythonVenv(): PreflightCheck {
    const projectRoot = getProjectRoot();
    const venvPython = getPreferredVenvPython(projectRoot);

    if (!fs.existsSync(venvPython)) {
        return {
            name: 'Python venv',
            status: 'error',
            message: 'Python virtual environment not found',
            fix: './setup.sh',
        };
    }

    // Check Python version
    try {
        const result = spawnSync(venvPython, ['--version'], { encoding: 'utf-8' });
        if (result.status !== 0) {
            return {
                name: 'Python venv',
                status: 'error',
                message: 'Failed to get Python version',
                fix: './setup.sh',
            };
        }

        const version = result.stdout.trim().replace('Python ', '');
        const [major, minor] = version.split('.').map(Number);

        if (major !== 3 || minor < 10 || minor > 12) {
            return {
                name: 'Python venv',
                status: 'error',
                message: `Python ${version} found, but 3.10-3.12 is required`,
                fix: './setup.sh',
            };
        }

        return {
            name: 'Python venv',
            status: 'ok',
            message: `Python ${version}`,
        };
    } catch {
        return {
            name: 'Python venv',
            status: 'error',
            message: 'Failed to check Python version',
            fix: './setup.sh',
        };
    }
}

/**
 * Check if Python dependencies are installed (specifically kokoro)
 */
function checkPythonDeps(): PreflightCheck {
    const projectRoot = getProjectRoot();
    const venvPython = getPreferredVenvPython(projectRoot);

    if (!fs.existsSync(venvPython)) {
        return {
            name: 'Python deps',
            status: 'error',
            message: 'Python venv not found',
            fix: './setup.sh',
        };
    }

    try {
        // Use module discovery instead of importing kokoro, which eagerly loads
        // torch-backed runtime code and can exceed a preflight timeout.
        if (!hasPythonModule(venvPython, 'kokoro')) {
            return {
                name: 'Python deps',
                status: 'error',
                message: 'Kokoro TTS not installed',
                fix: 'source .venv/bin/activate && pip install -r requirements.txt',
            };
        }

        return {
            name: 'Python deps',
            status: 'ok',
            message: 'Kokoro TTS ready',
        };
    } catch {
        return {
            name: 'Python deps',
            status: 'error',
            message: 'Failed to check Python dependencies',
            fix: './setup.sh',
        };
    }
}

/**
 * Check if the app.py script exists
 */
function checkAppScript(): PreflightCheck {
    const projectRoot = getProjectRoot();
    const appPath = getAppPath(projectRoot);

    if (!fs.existsSync(appPath)) {
        return {
            name: 'App script',
            status: 'error',
            message: 'app.py not found',
            fix: 'Make sure you are running from the project directory',
        };
    }

    return {
        name: 'App script',
        status: 'ok',
        message: 'app.py found',
    };
}

/**
 * Check if MLX backend dependencies are installed
 * This is a warning check - MLX is optional
 */
export function checkMLXDeps(): PreflightCheck {
    const projectRoot = getProjectRoot();
    const venvPython = getPreferredVenvPython(projectRoot);

    if (!fs.existsSync(venvPython)) {
        return {
            name: 'MLX Backend',
            status: 'warning',
            message: 'Python venv not found (cannot check MLX)',
        };
    }

    try {
        if (!hasPythonModule(venvPython, 'mlx_audio')) {
            return {
                name: 'MLX Backend',
                status: 'warning',
                message: 'MLX-Audio not installed (optional)',
                fix: 'pip install -r requirements-mlx.txt',
            };
        }

        return {
            name: 'MLX Backend',
            status: 'ok',
            message: 'MLX-Audio ready',
        };
    } catch {
        return {
            name: 'MLX Backend',
            status: 'warning',
            message: 'Failed to check MLX dependencies',
            fix: 'pip install -r requirements-mlx.txt',
        };
    }
}

/**
 * Run all preflight checks
 */
export function runPreflightChecks(): PreflightResult {
    const checks: PreflightCheck[] = [
        checkFFmpeg(),
        checkPythonVenv(),
        checkPythonDeps(),
        checkAppScript(),
    ];

    const passed = checks.every(
        (check) => check.status === 'ok' || check.status === 'warning'
    );

    return { passed, checks };
}

/**
 * Quick check - returns true if all critical dependencies are available
 * This is faster than runPreflightChecks() as it doesn't import Python modules
 */
export function quickCheck(): boolean {
    const projectRoot = getProjectRoot();
    const venvPython = getPreferredVenvPython(projectRoot);
    const appPath = getAppPath(projectRoot);

    // Check FFmpeg
    try {
        execSync('ffmpeg -version', { stdio: 'pipe' });
    } catch {
        return false;
    }

    // Check venv exists
    if (!fs.existsSync(venvPython)) {
        return false;
    }

    // Check app.py exists
    if (!fs.existsSync(appPath)) {
        return false;
    }

    try {
        resolvePythonPath(projectRoot);
    } catch {
        return false;
    }

    return true;
}
