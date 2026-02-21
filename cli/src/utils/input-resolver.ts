import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

function isGlobPattern(value: string): boolean {
    return /[*?\[\]{}]/.test(value);
}

async function resolveSingleInput(input: string): Promise<string[]> {
    if (isGlobPattern(input)) {
        const matches = await glob(input, { absolute: true, nodir: true });
        return matches.filter((item) => item.toLowerCase().endsWith('.epub'));
    }

    const absolute = path.resolve(process.cwd(), input);
    if (!fs.existsSync(absolute)) {
        return [];
    }

    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
        const matches = await glob(path.join(absolute, '**/*.epub'), { absolute: true, nodir: true });
        return matches;
    }

    if (absolute.toLowerCase().endsWith('.epub')) {
        return [absolute];
    }

    return [];
}

export async function resolveInputPatterns(inputs: string[]): Promise<string[]> {
    const dedupe = new Set<string>();

    for (const input of inputs) {
        const resolved = await resolveSingleInput(input);
        for (const item of resolved) {
            dedupe.add(item);
        }
    }

    return Array.from(dedupe).sort((a, b) => a.localeCompare(b));
}

export function buildOutputPath(inputPath: string, format: 'mp3' | 'm4b', outputDir: string | null): string {
    const extension = format === 'm4b' ? '.m4b' : '.mp3';
    const fileName = path.basename(inputPath).replace(/\.epub$/i, extension);
    if (outputDir) {
        return path.join(outputDir, fileName);
    }

    return inputPath.replace(/\.epub$/i, extension);
}
