import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import type { Bitrate, OutputFormat, RunProfile, TTSConfig } from '../types/profile.js';
import { createDefaultProfile, validateProfile } from '../types/profile.js';
import { getPreset } from '../utils/profile-store.js';
import { buildOutputPath, resolveInputPatterns } from '../utils/input-resolver.js';
import { runTTS, type ProgressInfo } from '../utils/tts-runner.js';

interface RunOptions {
    input?: string[];
    profile?: string;
    preset?: string;
    outputDir?: string;
    format?: OutputFormat;
    voice?: string;
    langCode?: 'a' | 'b';
    speed?: string;
    chunkChars?: string;
    workers?: string;
    backend?: TTSConfig['backend'];
    bitrate?: Bitrate;
    normalize?: boolean;
    checkpoint?: boolean;
    resume?: boolean;
    title?: string;
    author?: string;
    cover?: string;
    json?: boolean;
    failFast?: boolean;
}

interface RunResult {
    inputPath: string;
    outputPath: string;
    status: 'done' | 'error';
    durationMs: number;
    error?: string;
}

function readProfileFromPath(profilePath: string): RunProfile {
    const absolute = path.resolve(process.cwd(), profilePath);
    if (!fs.existsSync(absolute)) {
        throw new Error(`Profile file not found: ${absolute}`);
    }

    const raw = fs.readFileSync(absolute, 'utf8');
    const parsed = JSON.parse(raw);
    const validated = validateProfile(parsed);
    if (!validated.ok) {
        const message = 'error' in validated ? validated.error : 'Unknown validation error';
        throw new Error(`Invalid profile at ${absolute}: ${message}`);
    }

    return validated.value;
}

function applyOverrides(profile: RunProfile, options: RunOptions): RunProfile {
    const next: RunProfile = {
        ...profile,
        config: {
            ...profile.config,
        },
        metadata: {
            ...profile.metadata,
        },
        runtime: {
            ...profile.runtime,
        },
    };

    if (options.input && options.input.length > 0) {
        next.inputs = options.input;
    }

    if (options.outputDir !== undefined) {
        next.config.outputDir = path.resolve(process.cwd(), options.outputDir);
    }
    if (options.format) {
        next.config.outputFormat = options.format;
    }
    if (options.voice) {
        next.config.voice = options.voice;
    }
    if (options.langCode) {
        next.config.langCode = options.langCode;
    }
    if (options.speed !== undefined) {
        const speed = Number(options.speed);
        if (Number.isNaN(speed) || speed <= 0) {
            throw new Error(`Invalid --speed: ${options.speed}`);
        }
        next.config.speed = speed;
    }
    if (options.chunkChars !== undefined) {
        const chunkChars = Number(options.chunkChars);
        if (!Number.isInteger(chunkChars) || chunkChars < 100) {
            throw new Error(`Invalid --chunk-chars: ${options.chunkChars}`);
        }
        next.config.chunkChars = chunkChars;
    }
    if (options.workers !== undefined) {
        const workers = Number(options.workers);
        if (!Number.isInteger(workers) || workers < 1) {
            throw new Error(`Invalid --workers: ${options.workers}`);
        }
        next.config.workers = workers;
    }
    if (options.backend) {
        next.config.backend = options.backend;
    }
    if (options.bitrate) {
        next.config.bitrate = options.bitrate;
    }
    if (options.normalize !== undefined) {
        next.config.normalize = options.normalize;
    }
    if (options.checkpoint !== undefined) {
        next.config.checkpointEnabled = options.checkpoint;
    }
    if (options.resume !== undefined) {
        next.config.resume = options.resume;
    }

    const hasMetadataOverride =
        options.title !== undefined || options.author !== undefined || options.cover !== undefined;
    if (hasMetadataOverride) {
        next.metadata.strategy = 'override';
        if (options.title !== undefined) {
            next.metadata.title = options.title;
            next.config.metadataTitle = options.title;
        }
        if (options.author !== undefined) {
            next.metadata.author = options.author;
            next.config.metadataAuthor = options.author;
        }
        if (options.cover !== undefined) {
            const coverPath = path.resolve(process.cwd(), options.cover);
            next.metadata.cover = coverPath;
            next.config.metadataCover = coverPath;
        }
    }

    if (options.json) {
        next.runtime.eventFormat = 'json';
    }

    return next;
}

function formatProgress(info: ProgressInfo): string {
    const phase = info.phase ? `${info.phase.padEnd(12)} ` : '';
    const chunk = info.totalChunks > 0 ? `${String(info.currentChunk).padStart(4)}/${String(info.totalChunks).padStart(4)}` : '   -/   -';
    return `${phase}${String(info.progress).padStart(3)}% ${chunk}`;
}

export function registerRunCommand(program: Command): void {
    program
        .command('run')
        .description('Run non-interactive audiobook conversion')
        .option('-i, --input <pathOrGlob...>', 'Input file(s), directory, or glob pattern')
        .option('--profile <path>', 'Load a run profile JSON')
        .option('--preset <name>', 'Load saved preset by name')
        .option('--output-dir <path>', 'Output directory')
        .option('--format <format>', 'Output format (mp3|m4b)')
        .option('--voice <voice>', 'Voice id')
        .option('--lang-code <code>', 'Language code (a|b)')
        .option('--speed <number>', 'Speech speed (e.g. 1.0)')
        .option('--chunk-chars <number>', 'Chunk size')
        .option('--workers <number>', 'Compatibility worker setting')
        .option('--backend <backend>', 'Backend (auto|pytorch|mlx|mock)')
        .option('--bitrate <bitrate>', 'Bitrate (128k|192k|320k)')
        .option('--normalize', 'Enable loudness normalization')
        .option('--checkpoint', 'Enable checkpoint writes')
        .option('--resume', 'Resume from checkpoint')
        .option('--title <title>', 'Override metadata title for m4b')
        .option('--author <author>', 'Override metadata author for m4b')
        .option('--cover <path>', 'Override metadata cover for m4b')
        .option('--json', 'Emit JSON summary')
        .option('--fail-fast', 'Exit immediately on first file failure')
        .action(async (options: RunOptions) => {
            let profile = createDefaultProfile();

            if (options.profile) {
                profile = readProfileFromPath(options.profile);
            }

            if (options.preset) {
                const preset = getPreset(options.preset);
                if (!preset) {
                    throw new Error(`Preset "${options.preset}" not found`);
                }
                profile = preset;
            }

            profile = applyOverrides(profile, options);

            const validated = validateProfile(profile);
            if (!validated.ok) {
                const message = 'error' in validated ? validated.error : 'Unknown validation error';
                throw new Error(`Profile validation failed: ${message}`);
            }

            const resolvedInputs = await resolveInputPatterns(validated.value.inputs);
            if (resolvedInputs.length === 0) {
                throw new Error('No EPUB files found from provided --input values/profile inputs');
            }

            const results: RunResult[] = [];

            if (validated.value.config.outputDir) {
                fs.mkdirSync(validated.value.config.outputDir, { recursive: true });
            }

            for (let index = 0; index < resolvedInputs.length; index++) {
                const inputPath = resolvedInputs[index];
                const outputPath = buildOutputPath(
                    inputPath,
                    validated.value.config.outputFormat,
                    validated.value.config.outputDir
                );

                fs.mkdirSync(path.dirname(outputPath), { recursive: true });

                const startMs = Date.now();
                let lastLine = '';
                const progressPrinter = (info: ProgressInfo) => {
                    const line = `[${index + 1}/${resolvedInputs.length}] ${path.basename(inputPath)} ${formatProgress(info)}`;
                    if (!options.json && line !== lastLine) {
                        process.stdout.write(line + '\n');
                        lastLine = line;
                    }
                };

                try {
                    await runTTS(inputPath, outputPath, validated.value.config, progressPrinter);
                    results.push({
                        inputPath,
                        outputPath,
                        status: 'done',
                        durationMs: Date.now() - startMs,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    results.push({
                        inputPath,
                        outputPath,
                        status: 'error',
                        durationMs: Date.now() - startMs,
                        error: message,
                    });

                    if (options.failFast) {
                        break;
                    }
                }
            }

            const failures = results.filter((result) => result.status === 'error');
            const summary = {
                ok: failures.length === 0,
                startedAt: new Date().toISOString(),
                total: results.length,
                success: results.length - failures.length,
                failed: failures.length,
                results,
                effectiveProfile: validated.value,
            };

            if (options.json) {
                process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
            } else {
                process.stdout.write('\nBatch complete\n');
                process.stdout.write(`  Success: ${summary.success}\n`);
                process.stdout.write(`  Failed:  ${summary.failed}\n`);
                if (summary.failed > 0) {
                    for (const failure of failures) {
                        process.stdout.write(`  - ${failure.inputPath}: ${failure.error}\n`);
                    }
                }
            }

            if (summary.failed > 0) {
                process.exitCode = 1;
            }
        });
}
