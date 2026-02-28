import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'node',
        include: ['src/__tests__/**/*.test.{ts,tsx}'],
        setupFiles: ['src/__tests__/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html', 'lcov'],
            include: [
                'src/utils/**/*.ts',
                'src/components/MetadataEditor.tsx',
                'src/components/ResumeDialog.tsx',
                'src/components/SetupRequired.tsx',
            ],
            exclude: ['src/__tests__/**'],
            thresholds: {
                statements: 85,
                branches: 70,
                functions: 85,
                lines: 85,
            },
        },
    },
});
