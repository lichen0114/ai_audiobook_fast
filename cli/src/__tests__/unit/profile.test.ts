import { describe, expect, it } from 'vitest';
import { createDefaultProfile, validateProfile } from '../../types/profile.js';

describe('profile schema', () => {
    it('validates default profile', () => {
        const profile = createDefaultProfile();
        const validated = validateProfile(profile);
        expect(validated.ok).toBe(true);
    });

    it('rejects unsupported profile version', () => {
        const profile = createDefaultProfile() as any;
        profile.profileVersion = 2;

        const validated = validateProfile(profile);
        expect(validated.ok).toBe(false);
        if (!validated.ok) {
            const message = 'error' in validated ? validated.error : '';
            expect(message).toContain('Unsupported profileVersion');
        }
    });

    it('rejects invalid backend', () => {
        const profile = createDefaultProfile() as any;
        profile.config.backend = 'cuda';

        const validated = validateProfile(profile);
        expect(validated.ok).toBe(false);
        if (!validated.ok) {
            const message = 'error' in validated ? validated.error : '';
            expect(message).toContain('config.backend');
        }
    });
});
