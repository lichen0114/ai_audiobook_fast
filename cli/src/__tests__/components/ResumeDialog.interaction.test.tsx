import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

let lastSelectProps: any;

vi.mock('ink-select-input', () => ({
    default: (props: any) => {
        lastSelectProps = props;
        return null;
    },
}));

import { ResumeDialog } from '../../components/ResumeDialog.js';

describe('ResumeDialog (interaction)', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        lastSelectProps = undefined;
    });

    it('renders checkpoint progress and resume help text', () => {
        const { lastFrame } = render(
            <ResumeDialog
                checkpoint={{ totalChunks: 10, completedChunks: 4 }}
                onResume={() => {}}
                onStartFresh={() => {}}
            />
        );

        const frame = lastFrame() ?? '';
        expect(frame).toContain('Previous progress found');
        expect(frame).toContain('4/10 chunks (40%)');
        expect(frame).toContain('resume from where you left off');
    });

    it('shows almost-complete message when checkpoint is at 100%', () => {
        const { lastFrame } = render(
            <ResumeDialog
                checkpoint={{ totalChunks: 8, completedChunks: 8 }}
                onResume={() => {}}
                onStartFresh={() => {}}
            />
        );

        expect(lastFrame()).toContain('Processing was almost complete');
    });

    it('invokes callbacks for resume and start-fresh actions', () => {
        const onResume = vi.fn();
        const onStartFresh = vi.fn();
        render(
            <ResumeDialog
                checkpoint={{ totalChunks: 10, completedChunks: 3 }}
                onResume={onResume}
                onStartFresh={onStartFresh}
            />
        );

        lastSelectProps.onSelect({ value: 'resume' });
        lastSelectProps.onSelect({ value: 'fresh' });

        expect(onResume).toHaveBeenCalledOnce();
        expect(onStartFresh).toHaveBeenCalledOnce();
    });
});
