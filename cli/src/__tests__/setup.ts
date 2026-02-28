import { vi } from 'vitest';

// Mock child_process module
vi.mock('child_process', () => ({
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    execSync: vi.fn(),
    exec: vi.fn(),
}));

// Mock fs module
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        statSync: vi.fn(() => ({ isDirectory: () => false, size: 1024 })),
    };
});

// Mock glob module
vi.mock('glob', () => ({
    glob: vi.fn(() => Promise.resolve([])),
}));
