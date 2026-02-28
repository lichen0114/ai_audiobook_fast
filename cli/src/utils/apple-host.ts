import * as os from 'os';

import type { TTSConfig } from '../types/profile.js';

const LOW_MEMORY_APPLE_THRESHOLD_BYTES = 8 * 1024 * 1024 * 1024;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return undefined;
}

export function isAppleSiliconHost(): boolean {
    const forcedAppleSilicon = parseBooleanEnv(process.env.AUDIOBOOK_FORCE_APPLE_SILICON);
    if (forcedAppleSilicon !== undefined) {
        return forcedAppleSilicon;
    }

    return process.platform === 'darwin' && process.arch === 'arm64';
}

export function isLowMemoryAppleHost(): boolean {
    const forcedLowMemoryApple = parseBooleanEnv(process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE);
    if (forcedLowMemoryApple !== undefined) {
        return forcedLowMemoryApple;
    }

    return isAppleSiliconHost() && os.totalmem() <= LOW_MEMORY_APPLE_THRESHOLD_BYTES;
}

export function getDefaultAutoChunkChars(): number {
    if (isLowMemoryAppleHost()) {
        return 400;
    }
    return isAppleSiliconHost() ? 900 : 600;
}

export function getDefaultPytorchChunkChars(): number {
    return isLowMemoryAppleHost() ? 400 : 600;
}

export function getDefaultUseMPS(): boolean {
    return isAppleSiliconHost() && !isLowMemoryAppleHost();
}

export function resolvePythonDeviceArg(
    config: Pick<TTSConfig, 'backend' | 'useMPS'>,
): 'auto' | 'cpu' | 'mps' {
    if (!isAppleSiliconHost() || config.backend === 'mlx' || config.backend === 'mock') {
        return 'auto';
    }

    return config.useMPS ? 'mps' : 'cpu';
}
