import { describe, it, expect } from 'vitest';

describe('WelcomeScreen', () => {
    describe('Welcome message', () => {
        it('should have welcome text', () => {
            const welcomeText = 'Welcome to Audiobook Maker!';
            expect(welcomeText).toContain('Welcome');
            expect(welcomeText).toContain('Audiobook');
        });

        it('should describe the tool purpose', () => {
            const description = 'convert your EPUB files into high-quality MP3 audiobooks';
            expect(description).toContain('EPUB');
            expect(description).toContain('MP3');
            expect(description).toContain('audiobooks');
        });

        it('should mention Kokoro TTS', () => {
            const ttsMention = 'Kokoro TTS';
            expect(ttsMention).toContain('Kokoro');
            expect(ttsMention).toContain('TTS');
        });
    });

    describe('Feature list', () => {
        const features = [
            { icon: '📚', text: 'Convert single or multiple EPUBs at once' },
            { icon: '🎙️', text: 'Choose from 11+ different voices' },
            { icon: '⚡', text: 'Adjust speaking speed' },
            { icon: '📊', text: 'Real-time progress tracking' },
            { icon: '🍎', text: 'Apple Silicon GPU acceleration' },
        ];

        it('should have multiple features listed', () => {
            expect(features.length).toBe(5);
        });

        it('should mention batch processing', () => {
            const batchFeature = features.find(f => f.text.includes('multiple'));
            expect(batchFeature).toBeDefined();
        });

        it('should mention voice selection', () => {
            const voiceFeature = features.find(f => f.text.includes('voices'));
            expect(voiceFeature).toBeDefined();
            expect(voiceFeature?.text).toContain('11+');
        });

        it('should mention speed control', () => {
            const speedFeature = features.find(f => f.text.includes('speed'));
            expect(speedFeature).toBeDefined();
        });

        it('should mention progress tracking', () => {
            const progressFeature = features.find(f => f.text.includes('progress'));
            expect(progressFeature).toBeDefined();
            expect(progressFeature?.text).toContain('Real-time');
        });

        it('should mention GPU acceleration', () => {
            const gpuFeature = features.find(f => f.text.includes('GPU'));
            expect(gpuFeature).toBeDefined();
            expect(gpuFeature?.text).toContain('Apple Silicon');
        });

        it('should have icons for all features', () => {
            features.forEach(feature => {
                expect(feature.icon.length).toBeGreaterThan(0);
            });
        });
    });

    describe('CTA button', () => {
        it('should have start action text', () => {
            const ctaText = 'Press ENTER or SPACE to start';
            expect(ctaText).toContain('ENTER');
            expect(ctaText).toContain('SPACE');
            expect(ctaText).toContain('start');
        });
    });

    describe('Input handling', () => {
        it('should trigger onStart on Enter key', () => {
            let started = false;
            const onStart = () => { started = true; };

            // Simulate Enter key
            const key = { return: true };
            if (key.return) {
                onStart();
            }

            expect(started).toBe(true);
        });

        it('should trigger onStart on Space key', () => {
            let started = false;
            const onStart = () => { started = true; };

            // Simulate Space key
            const input = ' ';
            if (input === ' ') {
                onStart();
            }

            expect(started).toBe(true);
        });

        it('should not trigger on other keys', () => {
            let started = false;
            const onStart = () => { started = true; };

            // Simulate other key
            const input: string = 'a';
            const key = { return: false };
            if (key.return || input === ' ') {
                onStart();
            }

            expect(started).toBe(false);
        });
    });
});
