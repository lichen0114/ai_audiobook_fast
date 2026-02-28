import { afterEach, describe, expect, it } from 'vitest';

import {
    getDefaultAutoChunkChars,
    getDefaultPytorchChunkChars,
    getDefaultUseMPS,
    isAppleSiliconHost,
    isLowMemoryAppleHost,
    resolvePythonDeviceArg,
} from '../../utils/apple-host.js';

describe('apple-host utils', () => {
    afterEach(() => {
        delete process.env.AUDIOBOOK_FORCE_APPLE_SILICON;
        delete process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE;
    });

    it('recognizes forced low-memory Apple hosts', () => {
        process.env.AUDIOBOOK_FORCE_APPLE_SILICON = '1';
        process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE = '1';

        expect(isAppleSiliconHost()).toBe(true);
        expect(isLowMemoryAppleHost()).toBe(true);
        expect(getDefaultAutoChunkChars()).toBe(400);
        expect(getDefaultPytorchChunkChars()).toBe(400);
        expect(getDefaultUseMPS()).toBe(false);
    });

    it('resolves explicit Apple device overrides for Python runs', () => {
        process.env.AUDIOBOOK_FORCE_APPLE_SILICON = '1';
        process.env.AUDIOBOOK_FORCE_LOW_MEMORY_APPLE = '0';

        expect(resolvePythonDeviceArg({ backend: 'auto', useMPS: true })).toBe('mps');
        expect(resolvePythonDeviceArg({ backend: 'pytorch', useMPS: false })).toBe('cpu');
        expect(resolvePythonDeviceArg({ backend: 'mlx', useMPS: true })).toBe('auto');
    });
});
