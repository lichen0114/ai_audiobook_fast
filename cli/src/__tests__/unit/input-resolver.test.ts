import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildOutputPath, resolveInputPatterns } from '../../utils/input-resolver.js';

describe('input resolver', () => {
    it('builds output path with same directory', () => {
        const output = buildOutputPath('/tmp/book.epub', 'mp3', null);
        expect(output).toBe('/tmp/book.mp3');
    });

    it('builds output path with custom directory', () => {
        const output = buildOutputPath('/tmp/book.epub', 'm4b', '/tmp/out');
        expect(output).toBe('/tmp/out/book.m4b');
    });

    it('resolves explicit file inputs and deduplicates', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-input-'));
        const first = path.join(tempDir, 'first.epub');
        const third = path.join(tempDir, 'notes.txt');

        fs.writeFileSync(first, 'a');
        fs.writeFileSync(third, 'c');

        try {
            const resolved = await resolveInputPatterns([first, first, third]);
            expect(resolved.length).toBe(1);
            expect(resolved).toContain(first);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
