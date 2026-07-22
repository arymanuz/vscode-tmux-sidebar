"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TmuxService = exports.TMUX_BIN = void 0;
exports.shellQuote = shellQuote;
const cp = __importStar(require("child_process"));
const util = __importStar(require("util"));
const vscode = __importStar(require("vscode"));
const exec = util.promisify(cp.exec);
// Which multiplexer binary to call. This is decided by the OS the extension
// host actually runs on — which is the machine tmux commands execute against.
// In a WSL / SSH / container remote the host is Linux, so `process.platform`
// is 'linux' and we correctly use tmux there, even if the UI is on Windows.
// Only a genuinely local Windows host reports 'win32' and uses psmux.
exports.TMUX_BIN = process.platform === 'win32' ? 'psmux' : 'tmux';
const SPLIT_FLAGS = {
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
function shellQuote(value) {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/g, '""').replace(/(\\+)$/, '$1$1')}"`;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// Routine successes go to the status bar rather than notification toasts, so
// creating and killing things doesn't stack popups; failures stay loud.
function statusMessage(message) {
    vscode.window.setStatusBarMessage(message, 4000);
}
function launchArgs(options) {
    if (!options?.cwd) {
        return '';
    }
    return ` -c ${shellQuote(options.cwd)}`;
}
function launchCommand(options) {
    if (!options?.command) {
        return '';
    }
    return ` ${shellQuote(options.command)}`;
}
class TmuxService {
    constructor() {
        this.cache = null;
        this.CACHE_DURATION = 2000; // 2 seconds
        this.tmuxInstalled = null;
    }
    async checkTmuxInstallation() {
        if (this.tmuxInstalled !== null) {
            return this.tmuxInstalled;
        }
        try {
            await exec(`${exports.TMUX_BIN} -V`);
            this.tmuxInstalled = true;
            return true;
        }
        catch (error) {
            this.tmuxInstalled = false;
            vscode.window.showErrorMessage(await this.buildMissingBinaryMessage());
            return false;
        }
    }
    async buildMissingBinaryMessage() {
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
    async detectInstallCommand() {
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
            }
            catch {
                // Not this package manager — try the next one.
            }
        }
        return undefined;
    }
    isCacheValid() {
        return this.cache !== null && (Date.now() - this.cache.timestamp) < this.CACHE_DURATION;
    }
    // When no tmux server is running, tmux exits non-zero with a message that
    // varies between versions ("no server running on ...", "error connecting
    // to ... (No such file or directory)"). Treat all of these as "nothing to
    // show" rather than a real failure.
    isNoServerError(error) {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return message.includes('no server running')
            || message.includes('error connecting')
            || message.includes('no such file or directory')
            || message.includes('no sessions');
    }
    async getTmuxData() {
        // Query sessions first. If no server is running (or there are no
        // sessions), bail out here so we never call list-windows/list-panes
        // against a non-existent server, which would otherwise error out.
        let sessionsOutput;
        try {
            const result = await exec(`${exports.TMUX_BIN} list-sessions -F "#{session_attached}:#{session_created}:#{session_activity}:#{session_name}"`);
            sessionsOutput = result.stdout;
        }
        catch (error) {
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
                exec(`${exports.TMUX_BIN} list-windows -a -F "#{session_name}:#{window_index}:#{window_active}:#{window_name}"`),
                exec(`${exports.TMUX_BIN} list-panes -a -F "#{session_name}:#{window_index}:#{pane_index}:#{pane_active}:#{pane_pid}:#{pane_current_command}:#{pane_current_path}"`)
            ]);
            return this.parseTmuxData(sessionsOutput, windowsOutput.stdout, panesOutput.stdout);
        }
        catch (error) {
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
    parseTmuxData(sessionsData, windowsData, panesData) {
        // Parse sessions
        const sessionsMap = new Map();
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
        const panesByWindow = new Map();
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
                    panesByWindow.get(key).push({
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
        const windowsBySession = new Map();
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
                    windowsBySession.get(sessionName).push({
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
        const sessions = [];
        sessionsMap.forEach(session => {
            session.windows = windowsBySession.get(session.name) || [];
            sessions.push(session);
        });
        return sessions;
    }
    async getTmuxTree() {
        if (!await this.checkTmuxInstallation()) {
            return [];
        }
        // Use cache if valid
        if (this.isCacheValid()) {
            return this.cache.data;
        }
        try {
            const data = await this.getTmuxData();
            this.cache = {
                data,
                timestamp: Date.now()
            };
            return data;
        }
        catch (error) {
            // Return cached data if available, even if stale
            if (this.cache) {
                return this.cache.data;
            }
            return [];
        }
    }
    clearCache() {
        this.cache = null;
    }
    async getTmuxTreeFresh() {
        this.clearCache();
        return this.getTmuxTree();
    }
    async getSessions() {
        if (!await this.checkTmuxInstallation()) {
            return [];
        }
        try {
            const { stdout } = await exec(`${exports.TMUX_BIN} ls -F "#{session_name}"`);
            if (stdout && stdout.trim()) {
                return stdout.trim().split('\n').filter(name => name.length > 0);
            }
            return [];
        }
        catch (error) {
            if (!this.isNoServerError(error)) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`Failed to get sessions: ${errorMessage}`);
            }
            return [];
        }
    }
    async renameSession(oldName, newName) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} rename-session -t ${shellQuote(oldName)} ${shellQuote(newName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Session renamed from "${oldName}" to "${newName}"`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to rename session "${oldName}" to "${newName}": ${errorMessage}`);
            throw error;
        }
    }
    async renameWindow(sessionName, windowIndex, newName) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} rename-window -t ${shellQuote(`${sessionName}:${windowIndex}`)} ${shellQuote(newName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Window ${windowIndex} renamed to "${newName}"`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" not found`);
            }
            else if (errorMessage.includes('window not found')) {
                vscode.window.showErrorMessage(`Window ${windowIndex} not found in session "${sessionName}"`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to rename window ${windowIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }
    async newSession(sessionName, options) {
        if (!await this.checkTmuxInstallation()) {
            throw new Error(`${exports.TMUX_BIN} is not installed`);
        }
        try {
            await exec(`${exports.TMUX_BIN} new-session -d -s ${shellQuote(sessionName)}${launchArgs(options)}${launchCommand(options)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Created new session "${sessionName}"`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('duplicate session')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" already exists`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to create session "${sessionName}": ${errorMessage}`);
            }
            throw error;
        }
    }
    async deleteSession(sessionName) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} kill-session -t ${shellQuote(sessionName)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Deleted session "${sessionName}"`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showWarningMessage(`Session "${sessionName}" not found`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to delete session "${sessionName}": ${errorMessage}`);
            }
            throw error;
        }
    }
    async killWindow(sessionName, windowIndex) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} kill-window -t ${shellQuote(`${sessionName}:${windowIndex}`)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Killed window ${windowIndex} in session "${sessionName}"`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('window not found')) {
                vscode.window.showWarningMessage(`Window ${windowIndex} not found in session "${sessionName}"`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to kill window ${windowIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }
    async killPane(sessionName, windowIndex, paneIndex) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} kill-pane -t ${shellQuote(`${sessionName}:${windowIndex}.${paneIndex}`)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Killed pane ${paneIndex} in window ${windowIndex}`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('pane not found')) {
                vscode.window.showWarningMessage(`Pane ${paneIndex} not found in window ${windowIndex}`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to kill pane ${paneIndex}: ${errorMessage}`);
            }
            throw error;
        }
    }
    async selectWindow(sessionName, windowIndex) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} select-window -t ${shellQuote(`${sessionName}:${windowIndex}`)}`);
        }
        catch (error) {
            // Don't show error message here, as it might be confusing if attach works.
            // But log it for debugging
            console.warn(`Failed to select window ${windowIndex}:`, error);
        }
    }
    async selectPane(sessionName, windowIndex, paneIndex) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} select-pane -t ${shellQuote(`${sessionName}:${windowIndex}.${paneIndex}`)}`);
        }
        catch (error) {
            // Don't show error message here.
            // But log it for debugging
            console.warn(`Failed to select pane ${paneIndex}:`, error);
        }
    }
    async newWindow(sessionName, windowName, options) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            let command = `${exports.TMUX_BIN} new-window -t ${shellQuote(sessionName)}`;
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
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('session not found')) {
                vscode.window.showErrorMessage(`Session "${sessionName}" not found`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to create new window: ${errorMessage}`);
            }
            throw error;
        }
    }
    async splitPane(targetPane, direction, options) {
        if (!await this.checkTmuxInstallation()) {
            return;
        }
        try {
            await exec(`${exports.TMUX_BIN} split-window -t ${shellQuote(targetPane)} ${SPLIT_FLAGS[direction]}${launchArgs(options)}${launchCommand(options)}`);
            this.clearCache(); // Clear cache after modification
            statusMessage(`Split pane ${direction}`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('pane not found')) {
                vscode.window.showErrorMessage(`Target pane ${targetPane} not found`);
            }
            else {
                vscode.window.showErrorMessage(`Failed to split pane: ${errorMessage}`);
            }
            throw error;
        }
    }
}
exports.TmuxService = TmuxService;
//# sourceMappingURL=tmuxService.js.map