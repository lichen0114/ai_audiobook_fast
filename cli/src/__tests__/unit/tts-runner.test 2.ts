import { describe, it, expect } from 'vitest';
import { createParserState, parseOutputLine } from '../../utils/tts-runner.js';

describe('tts-runner parser', () => {
    it('parses phase transitions and validates phase values', () => {
        const state = createParserState();

        const parsing = parseOutputLine('PHASE:PARSING', state);
        expect(parsing?.phase).toBe('PARSING');

        const invalid = parseOutputLine('PHASE:SOMETHING_ELSE', state);
        expect(invalid).toBeNull();
    });

    it('parses metadata updates and keeps parser state', () => {
        const state = createParserState();

        parseOutputLine('METADATA:backend_resolved:mock', state);
        parseOutputLine('METADATA:total_chars:12345', state);
        const chapterUpdate = parseOutputLine('METADATA:chapter_count:12', state);

        expect(chapterUpdate?.backendResolved).toBe('mock');
        expect(chapterUpdate?.totalChars).toBe(12345);
        expect(chapterUpdate?.chapterCount).toBe(12);
    });

    it('parses worker and timing messages', () => {
        const state = createParserState();

        const worker = parseOutputLine('WORKER:1:ENCODE:File: book.mp3', state);
        expect(worker?.workerStatus).toEqual({
            id: 1,
            status: 'ENCODE',
            details: 'File: book.mp3',
        });

        const timing = parseOutputLine('TIMING:5:2340', state);
        expect(timing?.chunkTimingMs).toBe(2340);
    });

    it('parses progress and updates state for following messages', () => {
        const state = createParserState();

        const progress = parseOutputLine('PROGRESS:5/20 chunks', state);
        expect(progress?.progress).toBe(25);
        expect(progress?.currentChunk).toBe(5);
        expect(progress?.totalChunks).toBe(20);

        const phase = parseOutputLine('PHASE:INFERENCE', state);
        expect(phase?.progress).toBe(25);
        expect(phase?.currentChunk).toBe(5);
        expect(phase?.totalChunks).toBe(20);
    });

    it('parses progress lines without prefix and rejects invalid lines', () => {
        const state = createParserState();

        const progress = parseOutputLine('42/100 chunks', state);
        expect(progress?.progress).toBe(42);

        expect(parseOutputLine('PROGRESS:4/0 chunks', state)).toBeNull();
        expect(parseOutputLine('WORKER:bad', state)).toBeNull();
        expect(parseOutputLine('not an ipc message', state)).toBeNull();
    });

    it('parses heartbeat timestamps', () => {
        const state = createParserState();
        const heartbeat = parseOutputLine('HEARTBEAT:1704067200000', state);
        expect(heartbeat?.heartbeatTs).toBe(1704067200000);
    });

    it('parses structured JSON events', () => {
        const state = createParserState();

        const phase = parseOutputLine('{"type":"phase","phase":"PARSING"}', state);
        expect(phase?.phase).toBe('PARSING');

        const metadata = parseOutputLine('{"type":"metadata","key":"backend_resolved","value":"mock"}', state);
        expect(metadata?.backendResolved).toBe('mock');

        const progress = parseOutputLine('{"type":"progress","current_chunk":4,"total_chunks":10}', state);
        expect(progress?.progress).toBe(40);

        const timing = parseOutputLine('{"type":"timing","chunk_timing_ms":321}', state);
        expect(timing?.chunkTimingMs).toBe(321);
    });
});
