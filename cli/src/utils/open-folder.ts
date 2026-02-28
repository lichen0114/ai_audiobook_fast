import { spawn } from 'child_process';

export function getOpenFolderCommand(
    folderPath: string,
    platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
    if (platform === 'darwin') {
        return { command: 'open', args: [folderPath] };
    }
    if (platform === 'win32') {
        return { command: 'cmd', args: ['/c', 'start', '', folderPath] };
    }
    return { command: 'xdg-open', args: [folderPath] };
}

export function openFolder(folderPath: string): void {
    const { command, args } = getOpenFolderCommand(folderPath);

    const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
}
