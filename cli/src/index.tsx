#!/usr/bin/env node
import React from 'react';
import { Command } from 'commander';
import { render } from 'ink';
import { App } from './App.js';
import { registerRunCommand } from './commands/run.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerPresetCommands } from './commands/presets.js';

function launchTui(): void {
    render(<App />);
}

async function main(): Promise<void> {
    const program = new Command();

    program
        .name('audiobook')
        .description('Audiobook Maker CLI')
        .version('1.1.0')
        .showHelpAfterError();

    program
        .command('tui')
        .description('Launch interactive dashboard UI')
        .action(() => {
            launchTui();
        });

    registerRunCommand(program);
    registerDoctorCommand(program);
    registerPresetCommands(program);

    // Default command: launch TUI.
    program.action(() => {
        launchTui();
    });

    await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
});
