import { Command } from 'commander';
import { runPreflightChecks } from '../utils/preflight.js';

interface DoctorOptions {
    json?: boolean;
}

export function registerDoctorCommand(program: Command): void {
    program
        .command('doctor')
        .description('Run dependency and runtime checks')
        .option('--json', 'Emit machine-readable result')
        .action((options: DoctorOptions) => {
            const result = runPreflightChecks();

            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
                process.stdout.write('Audiobook Maker doctor\n\n');
                for (const check of result.checks) {
                    const icon = check.status === 'ok' ? 'OK ' : check.status === 'warning' ? 'WARN' : 'ERR';
                    process.stdout.write(`[${icon}] ${check.name}: ${check.message}\n`);
                    if (check.fix) {
                        process.stdout.write(`      fix: ${check.fix}\n`);
                    }
                }
                process.stdout.write(`\nStatus: ${result.passed ? 'healthy' : 'setup required'}\n`);
            }

            if (!result.passed) {
                process.exitCode = 1;
            }
        });
}
