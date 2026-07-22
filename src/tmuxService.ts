import * as cp from 'child_process';
import * as util from 'util';
import * as vscode from 'vscode';
import { TmuxSession, TmuxWindow, TmuxPane } from './types';

const exec = util.promisify(cp.exec);

// Which multiplexer binary to call. This is decided by the OS the extension
// host actually runs on — which is the machine tmux commands execute against.
// In a WSL / SSH / container remote the host is Linux, so `process.platform`
// is 'linux' and we correctly use tmux there, even if the UI is on Windows.
// Only a genuinely local Windows host reports 'win32' and uses psmux.
export const TMUX_BIN = process.platform === 'win32' ? 'psmux' : 'tmux';

// What a new session, window or pane should start with. Both fields map onto
// flags that new-session, new-window and split-window all share: `-c` sets the
// working directory and a trailing shell-command replaces the default shell.
export interface LaunchOptions {
    cwd?: string;
    command?: string;
}

// tmux splits in two directions only: -h opens to the right and -v below.
// -b inverts that, creating the pane to the left of or above the target, which
// is how the remaining two directions are expressed.
export type SplitDirection = 'right' | 'left' | 'down' | 'up';

const SPLIT_FLAGS: Record<SplitDirection, string> = {
    right: '-h',
    left: '-h -b',
    down: '-v',
    up: '-v -b'
};

// Commands are run through a shell, so anything interpolated into them has to
// be quoted. On Unix single quotes disable every expansion; an embedded single
// quote is closed, escaped and reopened. On Windows exec goes through cmd.exe,
// where single quotes are ordinary characters — there it's double quotes, an
// embedded quote doubled (the rule psmux's own argument parser follows), and a
// trailing backslash doubled so it can't swallow the closing quote.
export function shellQuote(value: string): string {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Routine successes go to the status bar rather than notification toasts, so
// creating and killing things doesn't stack popups; failures stay loud.
function statusMessage(message: string): void {
    vscode.window.setStatusBarMessage(message, 4000);
}

function launchArgs(options?: LaunchOptions): string {
    if (!options?.cwd) {
        return '';
    }
    return ` -c ${shellQuote(options.cwd)}`;
}

function launchCommand(options?: LaunchOptions): string {
    if (!options?.command) {
        return '';
    }
    return ` ${shellQuote(options.command)}`;
}

interface CacheEntry {
    data: TmuxSession[];
    timestamp: number;
}

export class TmuxService {
    private cache: CacheEntry | null = null;
    private readonly CACHE_DURATION = 2000; // 2 seconds
    private tmuxInstalled: boolean | null = null;

    private async checkTmuxInstallation(): Promise<boolean> {
        if (this.tmuxInstalled !== null) {
            return this.tmuxInstalled;
        }
        
        try {
            await exec(`${TMUX_BIN} -V`);
            this.tmuxInstalled = true;
            return true;
        } catch (error) {
            this.tmuxInstalled = false;
            vscode.window.showErrorMessage(await this.buildMissingBinaryMessage());
            return false;
        }
    }

    private async buildMissingBinaryMessage(): Promise<string> {
        if (process.platform === 'win32') {
            return `"psmux" was not found on your PATH. On Windows this extension uses psmux (a native, tmux-compatible multiplexer). Install it with "winget install psmux", then reload the window.`;
        }

        const installCommand = await this.detectInstallCommand();
        return installCommand
            ? `"tmux" was not found on your PATH. Install it with "${installCommand}", then reload the window.`
            : `"tmux" was not found on your PATH. Install it with your system's package manager, then reload the window.`;
    }

    // Probe for the package manager that is actually present so the user gets a
    // single command that works on their system, instead of a list to pick from.
    private async detectInstallCommand(): Promise<string | undefined> {
        const candidates = process.platform === 'darwin'
            ? [
                { bin: 'brew', command: 'brew install tmux' },
                { bin: 'port', command: 'sudo port install tmux' }
            ]
            : [
                { bin: 'apt-get', command: 'sudo apt install tmux' },
                { bin: 'dnf', command: 'sudo dnf install tmux' },
                { bin: 'pacman', command: 'sudo pacman -S tmux' },
                { bin: 'zypper', command: 'sudo zypper install tmux' },
                { bin: 'apk', command: 'sudo apk add tmux' }
            ];

        for (const { bin, command } of candidates) {
            try {
                await exec(`command -v ${bin}`);
                return command;
            } catch {
                // Not this package manager — try the next one.
            }
        }

        return undefined;
    }

    private isCacheValid(): boolean {
        return this.cache !== null && (Date.now() - this.cache.timestamp) < this.CACHE_DURATION;
    }

    // When no tmux server is running, tmux exits non-zero with a message that
    // varies between versions ("no server running on ...", "error connecting
    // to ... (No such file or directory)"). Treat all of these as "nothing to
    // show" rather than a real failure.
    private isNoServerError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return message.includes('no server running')
            || message.includes('error connecting')
            || message.includes('no such file or directory')
            || message.includes('no sessions');
    }

    private async getTmuxData(): Promise<TmuxSession[]> {
        // Query sessions first. If no server is running (or there are no
        // sessions), bail out here so we never call list-windows/list-panes
        // against a non-existent server, which would otherwise error out.
        let sessionsOutput: string;
        try {
            const result = await exec(`${TMUX_BIN} list-sessions -F "#{session_attached}:#{session_created}:#{session_activity}:#{session_name}"`);
            sessionsOutput = result.stdout;
        } catch (error) {
            if (this.isNoServerError(error)) {
                return [];
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to get tmux data: ${errorMessage}`);
            throw error;
        }

        if (!sessionsOutput.trim()) {
            // Server is up but has no sessions — nothing to show.
            return [];
        }

        try {
            const [windowsOutput, panesOutput] = await Promise.all([
                exec(`${TMUX_BIN} list-windows -a -F "#{session_name}:#{window_index}:#{window_active}:#{window_name}"`),
                exec(`${TMUX_BIN} list-panes -a -F "#{session_name}:#{window_index}:#{pane_index}:#{pane_active}:#{pane_pid}:#{pane_current_command}:#{pane_current_path}"`)
            ]);

            return this.parseTmuxData(sessionsOutput, windowsOutput.stdout, panesOutput.stdout);
        } catch (error) {
            if (this.isNoServerError(error)) {
                // Sessions may have been torn down between calls — treat as empty.
                return [];
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to get tmux data: ${errorMessage}`);
            throw error;
        }
    }

    // The separator must be printable ASCII: for a client without a UTF-8
    // locale (bare docker containers, ssh without locale forwarding) tmux
    // sanitizes command output, turning control characters — a tab too — into
    // '_'. So fields are colon-separated with the one free-text field last on
    // each line, rejoined from the tail; a session name is safe in front
    // because tmux itself forbids ':' in it.
    private parseTmuxData(sessionsData: string, windowsData: string, panesData: string): TmuxSession[] {
        // Parse sessions
        const sessionsMap = new Map<string, TmuxSession>();
        if (sessionsData) {
            sessionsData.trim().split('\n').forEach(line => {
                const parts = line.split(':');
                if (parts.length >= 4) {
                    const [attached, created, activity] = parts;
                    const name = parts.slice(3).join(':');
                    sessionsMap.set(name, {
                        name,
                        // session_attached counts clients — 2 is attached too.
                        isAttached: (parseInt(attached) || 0) > 0,
                        created,
                        lastActivity: activity,
                        windows: []
                    });
                }
            });
        }

        // Parse panes
        const panesByWindow = new Map<string, TmuxPane[]>();
        if (panesData) {
            panesData.trim().split('\n').forEach(line => {
                const parts = line.split(':');
                if (parts.length >= 7) {
                    const [sessionName, windowIndex, paneIndex, isActive, pid, paneCommand] = parts;
                    const currentPath = parts.slice(6).join(':');
                    const key = `${sessionName}:${windowIndex}`;
                    if (!panesByWindow.has(key)) {
                        panesByWindow.set(key, []);
                    }
                    panesByWindow.get(key)!.push({
                        sessionName,
                        windowIndex,
                        index: paneIndex,
                        command: paneCommand,
                        currentPath: currentPath || '~',
                        isActive: isActive === '1',
                        pid: parseInt(pid) || 0
                    });
                }
            });
        }

        // Parse windows
        const windowsBySession = new Map<string, TmuxWindow[]>();
        if (windowsData) {
            windowsData.trim().split('\n').forEach(line => {
                const parts = line.split(':');
                const [sessionName, windowIndex, isActive] = parts;
                const windowName = parts.slice(3).join(':');
                if (sessionName && windowIndex) {
                    const key = `${sessionName}:${windowIndex}`;
                    if (!windowsBySession.has(sessionName)) {
                        windowsBySession.set(sessionName, []);
                    }
                    windowsBySession.get(sessionName)!.push({
                        sessionName,
                        index: windowIndex,
                        name: windowName,
                        isActive: isActive === '1',
                        panes: panesByWindow.get(key) || []
                    });
                }
            });
        }

        // Combine data
        const sessions: TmuxSession[] = [];
        sessionsMap.forEach(session => {
            session.windows = windowsBySession.get(session.name) || [];
            sessions.push(session);
        });

        return sessions;
    }

    public async getTmuxTree(): Promise<TmuxSession[]> {
        if (!await this.checkTmuxInstallation()) {
            return [];
        }

        // Use cache if valid
        if (this.isCacheValid()) {
            return this.cache!.data;
        }

        try {
            const data = await this.getTmuxData();
            this.cache = {
                data,
                timestamp: Date.now()
            };
            return data;
        } catch (error) {
            // Return cached data if available, even if stale
            if (this.cache) {
                return this.cache.data;
            }
            return [];
        }
    }

    public clearCache(): void {
        this.cache = null;
    }

    public async getTmuxTreeFresh(): Promise<TmuxSession[]> {
        this.clearCache();
        return this.getTmuxTree();
    }

    public async getSessions(): Promise<string[]> {
        if (!await this.checkTmuxInstallation()) {
            return [];
        }
        
        try {
            const { stdout } = await exec(`${TMUX_BIN} ls -F "#{session_name}"`);
            if (stdout && stdout.trim()) {
                return stdout.trim().split('\n').filter(name => name.length > 0);
            }
            return [];
        } catch (error) {
            if (!this.isNoServerError(error)) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`Failed to get sessions: ${errorMessage}`);
            }
            return [];
        }
    }

    public async renameSession(oldName: string, newName: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} rename-session -t ${shellQuote(oldName)} ${shellQuote(newName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Session renamed from "${oldName}" to "${newName}"`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to rename session "${oldName}" to "${newName}": ${errorMessage}`);
            throw error;
        }
    }

    public async renameWindow(sessionName: string, windowIndex: string, newName: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} rename-window -t ${shellQuote(`${sessionName}:${windowIndex}`)} ${shellQuote(newName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Window ${windowIndex} renamed to "${newName}"`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" not found`);
            } else if (errorMessage.includes('window not found')) {
                vscode.window.showErrorMessage(`Window ${windowIndex} not found in session "${sessionName}"`);
            } else {
                vscode.window.showErrorMessage(`Failed to rename window ${windowIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }

    public async newSession(sessionName: string, options?: LaunchOptions): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            throw new Error(`${TMUX_BIN} is not installed`);
        }

        try {
            await exec(`${TMUX_BIN} new-session -d -s ${shellQuote(sessionName)}${launchArgs(options)}${launchCommand(options)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Created new session "${sessionName}"`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('duplicate session')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" already exists`);
            } else {
                vscode.window.showErrorMessage(`Failed to create session "${sessionName}": ${errorMessage}`);
            }
            throw error;
        }
    }

    public async deleteSession(sessionName: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} kill-session -t ${shellQuote(sessionName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Deleted session "${sessionName}"`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showWarningMessage(`Session "${sessionName}" not found`);
            } else {
                vscode.window.showErrorMessage(`Failed to delete session "${sessionName}": ${errorMessage}`);
            }
            throw error;
        }
    }

    public async killWindow(sessionName: string, windowIndex: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} kill-window -t ${shellQuote(`${sessionName}:${windowIndex}`)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Killed window ${windowIndex} in session "${sessionName}"`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('window not found')) {
                vscode.window.showWarningMessage(`Window ${windowIndex} not found in session "${sessionName}"`);
            } else {
                vscode.window.showErrorMessage(`Failed to kill window ${windowIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }

    public async killPane(sessionName: string, windowIndex: string, paneIndex: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} kill-pane -t ${shellQuote(`${sessionName}:${windowIndex}.${paneIndex}`)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Killed pane ${paneIndex} in window ${windowIndex}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('pane not found')) {
                vscode.window.showWarningMessage(`Pane ${paneIndex} not found in window ${windowIndex}`);
            } else {
                vscode.window.showErrorMessage(`Failed to kill pane ${paneIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }

    public async selectWindow(sessionName: string, windowIndex: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} select-window -t ${shellQuote(`${sessionName}:${windowIndex}`)}`);
        } catch (error) {
            // Don't show error message here, as it might be confusing if attach works.
            // But log it for debugging
            console.warn(`Failed to select window ${windowIndex}:`, error);
        }
    }

    public async selectPane(sessionName: string, windowIndex: string, paneIndex: string): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        
        try {
            await exec(`${TMUX_BIN} select-pane -t ${shellQuote(`${sessionName}:${windowIndex}.${paneIndex}`)}`);
        } catch (error) {
            // Don't show error message here.
            // But log it for debugging
            console.warn(`Failed to select pane ${paneIndex}:`, error);
        }
    }

    public async newWindow(sessionName: string, windowName?: string, options?: LaunchOptions): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }

        try {
            let command = `${TMUX_BIN} new-window -t ${shellQuote(sessionName)}`;
            if (windowName) {
                command += ` -n ${shellQuote(windowName)}`;
            }
            command += `${launchArgs(options)}${launchCommand(options)}`;
            await exec(command);
            this.clearCache(); // Clear cache after modification
            
            const message = windowName 
                ? `Created new window "${windowName}" in session "${sessionName}"`
                : `Created new window in session "${sessionName}"`;
            statusMessage(message);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" not found`);
            } else {
                vscode.window.showErrorMessage(`Failed to create new window: ${errorMessage}`);
            }
            throw error;
        }
    }

    public async splitPane(targetPane: string, direction: SplitDirection, options?: LaunchOptions): Promise<void> {
        if (!await this.checkTmuxInstallation()) {
            return;
        }

        try {
            await exec(`${TMUX_BIN} split-window -t ${shellQuote(targetPane)} ${SPLIT_FLAGS[direction]}${launchArgs(options)}${launchCommand(options)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Split pane ${direction}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('pane not found')) {
                vscode.window.showErrorMessage(`Target pane ${targetPane} not found`);
            } else {
                vscode.window.showErrorMessage(`Failed to split pane: ${errorMessage}`);
            }
            throw error;
        }
    }
}