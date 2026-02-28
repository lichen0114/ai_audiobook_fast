import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

let inputHandler: any;

vi.mock('ink', async () => {
    const actual = await vi.importActual<any>('ink');
    return {
        ...actual,
        useInput: (handler: any) => {
            inputHandler = handler;
        },
    };
});

import { SetupRequired } from '../../components/SetupRequired.js';

describe('SetupRequired (interaction)', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        inputHandler = undefined;
    });

    it('renders errors, warnings, and fixes in the setup guidance', () => {
        const { lastFrame } = render(
            <SetupRequired
                checks={[
                    {
                        name: 'FFmpeg',
                        status: 'error',
                        message: 'FFmpeg is not installed',
                        fix: 'brew install ffmpeg',
                    },
                    {
                        name: 'MLX Backend',
                        status: 'warning',
                        message: 'MLX-Audio not installed (optional)',
                        fix: 'pip install -r requirements-mlx.txt',
                    },
                ]}
                onRetry={() => {}}
            />
        );

        const frame = lastFrame() ?? '';
        expect(frame).toContain('Setup Required');
        expect(frame).toContain('FFmpeg is not installed');
        expect(frame).toContain('MLX-Audio not installed');
        expect(frame).toContain('./setup.sh');
        expect(frame).toContain('brew install ffmpeg');
        expect(frame).toContain('requirements-mlx.txt');
    });

    it('calls onRetry when pressing r or R', () => {
        const onRetry = vi.fn();
        render(<SetupRequired checks={[]} onRetry={onRetry} />);

        inputHandler('r', {});
        inputHandler('R', {});

        expect(onRetry).toHaveBeenCalledTimes(2);
    });
});
