import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunProfile } from '../types/profile.js';
import { validateProfile } from '../types/profile.js';

interface PresetStoreFile {
    version: 1;
    presets: Record<string, RunProfile>;
}

function getBaseConfigDir(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'audiobook-maker');
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'audiobook-maker');
    }

    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'audiobook-maker');
}

export function getPresetStorePath(): string {
    return path.join(getBaseConfigDir(), 'presets.json');
}

function ensureStoreDir(): void {
    const dir = path.dirname(getPresetStorePath());
    fs.mkdirSync(dir, { recursive: true });
}

function readStore(): PresetStoreFile {
    const storePath = getPresetStorePath();

    if (!fs.existsSync(storePath)) {
        return {
            version: 1,
            presets: {},
        };
    }

    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PresetStoreFile>;

    if (parsed.version !== 1 || !parsed.presets || typeof parsed.presets !== 'object') {
        throw new Error(`Unsupported preset store format at ${storePath}`);
    }

    return {
        version: 1,
        presets: parsed.presets,
    };
}

function writeStore(store: PresetStoreFile): void {
    ensureStoreDir();
    fs.writeFileSync(getPresetStorePath(), JSON.stringify(store, null, 2) + '\n', 'utf8');
}

export function listPresetNames(): string[] {
    const store = readStore();
    return Object.keys(store.presets).sort((a, b) => a.localeCompare(b));
}

export function getPreset(name: string): RunProfile | null {
    const store = readStore();
    const preset = store.presets[name];
    if (!preset) {
        return null;
    }

    const validated = validateProfile(preset);
    if (!validated.ok) {
        const message = 'error' in validated ? validated.error : 'Unknown validation error';
        throw new Error(`Preset "${name}" is invalid: ${message}`);
    }

    return validated.value;
}

export function savePreset(name: string, profile: RunProfile): void {
    const validated = validateProfile(profile);
    if (!validated.ok) {
        const message = 'error' in validated ? validated.error : 'Unknown validation error';
        throw new Error(`Cannot save invalid profile: ${message}`);
    }

    const store = readStore();
    store.presets[name] = validated.value;
    writeStore(store);
}

export function exportPreset(name: string, outPath: string): string {
    const preset = getPreset(name);
    if (!preset) {
        throw new Error(`Preset "${name}" not found`);
    }

    const absolutePath = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify(preset, null, 2) + '\n', 'utf8');
    return absolutePath;
}
