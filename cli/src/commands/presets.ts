import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { createDefaultProfile, validateProfile } from '../types/profile.js';
import { exportPreset, getPresetStorePath, listPresetNames, savePreset } from '../utils/profile-store.js';

interface SaveOptions {
    from?: string;
}

interface ExportOptions {
    out: string;
}

function loadProfileFromFile(filePath: string) {
    const absolute = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(absolute)) {
        throw new Error(`Profile file not found: ${absolute}`);
    }

    const raw = fs.readFileSync(absolute, 'utf8');
    const parsed = JSON.parse(raw);
    const validated = validateProfile(parsed);
    if (!validated.ok) {
        const message = 'error' in validated ? validated.error : 'Unknown validation error';
        throw new Error(`Invalid profile in ${absolute}: ${message}`);
    }

    return validated.value;
}

export function registerPresetCommands(program: Command): void {
    const preset = program.command('presets').description('Manage saved run presets');

    preset
        .command('list')
        .description('List available presets')
        .action(() => {
            const names = listPresetNames();
            if (names.length === 0) {
                process.stdout.write(`No presets found. Store: ${getPresetStorePath()}\n`);
                return;
            }

            process.stdout.write(`Preset store: ${getPresetStorePath()}\n`);
            for (const name of names) {
                process.stdout.write(`- ${name}\n`);
            }
        });

    preset
        .command('save <name>')
        .description('Save a preset from default profile or a profile file')
        .option('--from <path>', 'Profile JSON to import before saving')
        .action((name: string, options: SaveOptions) => {
            const profile = options.from ? loadProfileFromFile(options.from) : createDefaultProfile();
            profile.name = name;
            savePreset(name, profile);
            process.stdout.write(`Saved preset "${name}" to ${getPresetStorePath()}\n`);
        });

    preset
        .command('export <name>')
        .description('Export a named preset to a profile JSON file')
        .requiredOption('--out <path>', 'Output JSON file path')
        .action((name: string, options: ExportOptions) => {
            const exportedPath = exportPreset(name, options.out);
            process.stdout.write(`Exported preset "${name}" to ${exportedPath}\n`);
        });
}
