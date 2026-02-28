import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';

let lastSelectProps: any;
let lastTextInputProps: any;
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

vi.mock('ink-select-input', () => ({
    default: (props: any) => {
        lastSelectProps = props;
        return null;
    },
}));

vi.mock('ink-text-input', () => ({
    default: (props: any) => {
        lastTextInputProps = props;
        return null;
    },
}));

import { MetadataEditor } from '../../components/MetadataEditor.js';

describe('MetadataEditor (interaction)', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        lastSelectProps = undefined;
        lastTextInputProps = undefined;
        inputHandler = undefined;
    });

    it('continues with current metadata and preserves empty custom cover', () => {
        const onConfirm = vi.fn();
        render(
            <MetadataEditor
                metadata={{ title: 'Book', author: 'Author', hasCover: false }}
                onConfirm={onConfirm}
                onBack={() => {}}
            />
        );

        lastSelectProps.onSelect({ value: 'continue' });

        expect(onConfirm).toHaveBeenCalledWith({
            title: 'Book',
            author: 'Author',
            hasCover: false,
            coverPath: undefined,
        });
    });

    it('edits title and custom cover path before confirming', () => {
        const onConfirm = vi.fn();
        const { lastFrame } = render(
            <MetadataEditor
                metadata={{ title: 'Old Title', author: 'Old Author', hasCover: false }}
                onConfirm={onConfirm}
                onBack={() => {}}
            />
        );

        lastSelectProps.onSelect({ value: 'edit_title' });
        expect(lastFrame()).toContain('Enter book title:');
        lastTextInputProps.onSubmit('  New Title  ');

        lastSelectProps.onSelect({ value: 'edit_cover' });
        expect(lastFrame()).toContain('Enter path to cover image:');
        lastTextInputProps.onSubmit('  /tmp/cover.png  ');

        lastSelectProps.onSelect({ value: 'continue' });

        expect(onConfirm).toHaveBeenCalledWith({
            title: 'New Title',
            author: 'Old Author',
            hasCover: true,
            coverPath: '/tmp/cover.png',
        });
    });

    it('uses ESC to leave edit mode and ESC again to go back from review', () => {
        const onBack = vi.fn();
        const { lastFrame } = render(
            <MetadataEditor
                metadata={{ title: 'Book', author: 'Author', hasCover: false }}
                onConfirm={() => {}}
                onBack={onBack}
            />
        );

        lastSelectProps.onSelect({ value: 'edit_author' });
        expect(lastFrame()).toContain('Enter author name:');

        inputHandler('', { escape: true });
        expect(lastFrame()).toContain('Review metadata for your audiobook');
        expect(onBack).not.toHaveBeenCalled();

        inputHandler('', { escape: true });
        expect(onBack).toHaveBeenCalledOnce();
    });
});
