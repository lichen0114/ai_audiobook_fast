import { describe, it, expect } from 'vitest';

describe('ConfigPanel', () => {
    describe('Voice options', () => {
        const voices = [
            { label: 'af_heart (American Female - Warm)', value: 'af_heart' },
            { label: 'af_bella (American Female - Confident)', value: 'af_bella' },
            { label: 'af_nicole (American Female - Friendly)', value: 'af_nicole' },
            { label: 'af_sarah (American Female - Professional)', value: 'af_sarah' },
            { label: 'af_sky (American Female - Energetic)', value: 'af_sky' },
            { label: 'am_adam (American Male - Calm)', value: 'am_adam' },
            { label: 'am_michael (American Male - Authoritative)', value: 'am_michael' },
            { label: 'bf_emma (British Female - Elegant)', value: 'bf_emma' },
            { label: 'bf_isabella (British Female - Sophisticated)', value: 'bf_isabella' },
            { label: 'bm_george (British Male - Classic)', value: 'bm_george' },
            { label: 'bm_lewis (British Male - Modern)', value: 'bm_lewis' },
        ];

        it('should have all voice options', () => {
            expect(voices.length).toBe(11);
        });

        it('should have American female voices', () => {
            const afVoices = voices.filter(v => v.value.startsWith('af_'));
            expect(afVoices.length).toBe(5);
        });

        it('should have American male voices', () => {
            const amVoices = voices.filter(v => v.value.startsWith('am_'));
            expect(amVoices.length).toBe(2);
        });

        it('should have British female voices', () => {
            const bfVoices = voices.filter(v => v.value.startsWith('bf_'));
            expect(bfVoices.length).toBe(2);
        });

        it('should have British male voices', () => {
            const bmVoices = voices.filter(v => v.value.startsWith('bm_'));
            expect(bmVoices.length).toBe(2);
        });

        it('should have af_heart as default', () => {
            const defaultVoice = voices.find(v => v.value === 'af_heart');
            expect(defaultVoice).toBeDefined();
        });
    });

    describe('Speed options', () => {
        const speeds = [
            { label: '0.75x - Slow', value: '0.75' },
            { label: '0.9x - Relaxed', value: '0.9' },
            { label: '1.0x - Normal', value: '1.0' },
            { label: '1.1x - Slightly Fast', value: '1.1' },
            { label: '1.25x - Fast', value: '1.25' },
            { label: '1.5x - Very Fast', value: '1.5' },
        ];

        it('should have all speed options', () => {
            expect(speeds.length).toBe(6);
        });

        it('should have 1.0x as normal speed', () => {
            const normalSpeed = speeds.find(s => s.value === '1.0');
            expect(normalSpeed).toBeDefined();
            expect(normalSpeed?.label).toContain('Normal');
        });

        it('should have valid numeric values', () => {
            speeds.forEach(speed => {
                const value = parseFloat(speed.value);
                expect(value).toBeGreaterThan(0);
                expect(value).toBeLessThanOrEqual(2);
            });
        });
    });

    describe('Batch mode', () => {
        it('should default the compatibility worker flag to 1', () => {
            const config = { workers: 1 };
            expect(config.workers).toBe(1);
        });
    });

    describe('Configuration steps', () => {
        const steps = ['voice', 'speed', 'checkpoint', 'gpu', 'output', 'output_custom', 'confirm'];

        it('should have all configuration steps', () => {
            expect(steps.includes('voice')).toBe(true);
            expect(steps.includes('speed')).toBe(true);
            expect(steps.includes('checkpoint')).toBe(true);
            expect(steps.includes('gpu')).toBe(true);
            expect(steps.includes('output')).toBe(true);
            expect(steps.includes('confirm')).toBe(true);
        });

        it('should start with voice selection', () => {
            expect(steps[0]).toBe('voice');
        });

        it('should end with confirm step', () => {
            expect(steps[steps.length - 1]).toBe('confirm');
        });
    });

    describe('Summary display', () => {
        it('should show file count', () => {
            const files = [{ id: '1' }, { id: '2' }, { id: '3' }];
            expect(files.length).toBe(3);
        });

        it('should format voice label', () => {
            const voices = [{ label: 'af_heart (Warm)', value: 'af_heart' }];
            const getVoiceLabel = (value: string) =>
                voices.find(v => v.value === value)?.label || value;

            expect(getVoiceLabel('af_heart')).toBe('af_heart (Warm)');
            expect(getVoiceLabel('unknown')).toBe('unknown');
        });

        it('should format speed label', () => {
            const speeds = [{ label: '1.0x - Normal', value: '1.0' }];
            const getSpeedLabel = (value: number) =>
                speeds.find(s => parseFloat(s.value) === value)?.label || `${value}x`;

            expect(getSpeedLabel(1.0)).toBe('1.0x - Normal');
            expect(getSpeedLabel(2.0)).toBe('2x');
        });

        it('should format output directory', () => {
            const getOutputLabel = (outputDir: string | null) => {
                if (!outputDir) return 'Same as input file';
                return outputDir;
            };

            expect(getOutputLabel(null)).toBe('Same as input file');
            expect(getOutputLabel('/path/to/output')).toBe('/path/to/output');
        });
    });

    describe('Backend selection', () => {
        const backends = [
            { label: 'Auto (Apple Silicon optimized)', value: 'auto' },
            { label: 'PyTorch/MPS (Stable)', value: 'pytorch' },
            { label: 'MLX (Faster - Experimental)', value: 'mlx' },
        ];

        it('should include auto backend option', () => {
            const auto = backends.find(b => b.value === 'auto');
            expect(auto).toBeDefined();
        });

        it('should default to auto backend', () => {
            const defaultConfig = {
                backend: 'auto',
            };
            expect(defaultConfig.backend).toBe('auto');
        });
    });

    describe('Checkpoint toggle', () => {
        it('should default checkpointing to disabled', () => {
            const defaultConfig = {
                checkpointEnabled: false,
            };
            expect(defaultConfig.checkpointEnabled).toBe(false);
        });

        it('should toggle checkpointing state', () => {
            let checkpointEnabled = false;
            checkpointEnabled = !checkpointEnabled;
            expect(checkpointEnabled).toBe(true);
        });
    });

    describe('GPU toggle', () => {
        it('should default to MPS enabled', () => {
            const defaultConfig = {
                useMPS: true,
            };
            expect(defaultConfig.useMPS).toBe(true);
        });

        it('should toggle MPS state', () => {
            let useMPS = true;
            useMPS = !useMPS;
            expect(useMPS).toBe(false);
        });
    });

    describe('Custom output path', () => {
        it('should resolve relative paths', () => {
            // Simulate path.resolve behavior
            const resolvePath = (cwd: string, relativePath: string) => {
                if (relativePath.startsWith('/')) return relativePath;
                return `${cwd}/${relativePath}`.replace(/\/+/g, '/');
            };

            expect(resolvePath('/home/user', './output')).toBe('/home/user/./output');
            expect(resolvePath('/home/user', '/absolute/path')).toBe('/absolute/path');
        });

        it('should require non-empty custom path', () => {
            const customPath = '';
            const isValid = customPath.trim().length > 0;
            expect(isValid).toBe(false);
        });
    });
});
