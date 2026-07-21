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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const treeProvider_1 = require("./treeProvider");
const tmuxService_1 = require("./tmuxService");
const launchWizard_1 = require("./launchWizard");
const programs_1 = require("./programs");
const settingsPanel_1 = require("./settingsPanel");
// Create a terminal that attaches to a tmux/psmux session, making the
// multiplexer the terminal's main process so that exiting it closes the tab
// (instead of dropping back into a shell).
function createAttachTerminal(context, terminalName, sessionName, location) {
    const iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
    if (process.platform === 'win32') {
        // psmux is a native binary and doesn't rely on a shell to set up the
        // environment, so run it directly as the terminal process.
        return vscode.window.createTerminal({
            name: terminalName,
            iconPath,
            location,
            shellPath: tmuxService_1.TMUX_BIN,
            shellArgs: ['attach', '-t', sessionName]
        });
    }
    // On Unix, go through a login shell so it sources the user's profile and
    // sets up the environment (PATH may only pick up tmux from there), then
    // `exec` replaces the shell with tmux so tmux becomes the main process.
    //
    // This is passed as shell arguments rather than sendText on purpose: VS Code
    // replays creationOptions when a terminal is relaunched or a persisted
    // session is restored, but it does not replay sendText — which would leave
    // a bare shell behind.
    return vscode.window.createTerminal({
        name: terminalName,
        iconPath,
        location,
        shellPath: process.env.SHELL || '/bin/bash',
        shellArgs: ['-lc', `exec ${tmuxService_1.TMUX_BIN} attach -t "${sessionName}"`]
    });
}
function activate(context) {
    const tmuxService = new tmuxService_1.TmuxService();
    const tmuxSessionProvider = new treeProvider_1.TmuxSessionProvider(tmuxService, context.extensionPath);
    vscode.window.registerTreeDataProvider('vscode-tmux-sidebar', tmuxSessionProvider);
    // Resolve which programs exist while the user is still reading the tree, so
    // opening the create form doesn't wait on it.
    (0, programs_1.warmUpPrograms)();
    const attachCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.attach', async (item) => {
        if (!item) {
            vscode.window.showErrorMessage('No item selected for attach');
            return;
        }
        let sessionName;
        let itemType = 'session';
        if (item instanceof treeProvider_1.TmuxSessionTreeItem) {
            if (!item.session || !item.session.name) {
                vscode.window.showErrorMessage('Invalid session data');
                return;
            }
            sessionName = item.session.name;
            itemType = 'session';
        }
        else if (item instanceof treeProvider_1.TmuxWindowTreeItem) {
            if (!item.window || !item.window.sessionName) {
                vscode.window.showErrorMessage('Invalid window data');
                return;
            }
            sessionName = item.window.sessionName;
            itemType = 'window';
        }
        else if (item instanceof treeProvider_1.TmuxPaneTreeItem) {
            if (!item.pane || !item.pane.sessionName) {
                vscode.window.showErrorMessage('Invalid pane data');
                return;
            }
            sessionName = item.pane.sessionName;
            itemType = 'pane';
        }
        else {
            // Fallback for unknown item types
            const fallbackItem = item;
            if (fallbackItem && typeof fallbackItem.label === 'string') {
                sessionName = fallbackItem.label;
            }
            else {
                vscode.window.showErrorMessage('Unknown item type for attach operation');
                return;
            }
        }
        const terminalName = `tmux - ${sessionName}`;
        // Match on the name we assigned at creation, not the current tab title:
        // tmux (with set-titles on) or programs inside the pane can rewrite the
        // visible title via escape sequences. Using creationOptions.name keeps us
        // matching the same terminal instead of spawning a duplicate.
        const existingTerminal = vscode.window.terminals.find(t => t.creationOptions.name === terminalName);
        if (existingTerminal) {
            // Terminal exists, show it and switch to the specific target
            existingTerminal.show();
            // Add a small delay to ensure terminal is focused before sending commands
            await new Promise(resolve => setTimeout(resolve, 100));
            if (itemType === 'window') {
                const windowItem = item;
                await tmuxService.selectWindow(windowItem.window.sessionName, windowItem.window.index);
                vscode.window.showInformationMessage(`Switched to window ${windowItem.window.index}:${windowItem.window.name}`);
            }
            else if (itemType === 'pane') {
                const paneItem = item;
                // First select the window, then the pane
                await tmuxService.selectWindow(paneItem.pane.sessionName, paneItem.pane.windowIndex);
                await tmuxService.selectPane(paneItem.pane.sessionName, paneItem.pane.windowIndex, paneItem.pane.index);
                vscode.window.showInformationMessage(`Switched to pane ${paneItem.pane.index} in window ${paneItem.pane.windowIndex}`);
            }
            else {
                vscode.window.showInformationMessage(`Attached to session "${sessionName}"`);
            }
        }
        else {
            // No existing terminal, create new one and attach
            const terminal = createAttachTerminal(context, terminalName, sessionName);
            terminal.show();
            // Wait a bit for the attach to complete, then switch to specific target
            await new Promise(resolve => setTimeout(resolve, 500));
            if (itemType === 'window') {
                const windowItem = item;
                await tmuxService.selectWindow(windowItem.window.sessionName, windowItem.window.index);
                vscode.window.showInformationMessage(`Attached to session "${sessionName}" and switched to window ${windowItem.window.index}:${windowItem.window.name}`);
            }
            else if (itemType === 'pane') {
                const paneItem = item;
                // First select the window, then the pane
                await tmuxService.selectWindow(paneItem.pane.sessionName, paneItem.pane.windowIndex);
                await tmuxService.selectPane(paneItem.pane.sessionName, paneItem.pane.windowIndex, paneItem.pane.index);
                vscode.window.showInformationMessage(`Attached to session "${sessionName}" and switched to pane ${paneItem.pane.index} in window ${paneItem.pane.windowIndex}`);
            }
            else {
                vscode.window.showInformationMessage(`Attached to session "${sessionName}"`);
            }
        }
    });
    const refreshCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.refresh', async () => {
        // Force fresh data by clearing cache
        await tmuxService.getTmuxTreeFresh();
        tmuxSessionProvider.refresh();
    });
    const settingsCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.settings', () => {
        (0, settingsPanel_1.openSettingsPanel)(context.extensionUri);
    });
    const renameCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.rename', async (item) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for rename operation');
            return;
        }
        const oldName = item.session.name;
        const newName = await vscode.window.showInputBox({
            prompt: `Rename tmux session "${oldName}"`,
            value: oldName,
            validateInput: value => value ? null : 'Session name cannot be empty.'
        });
        if (newName && newName !== oldName) {
            await tmuxService.renameSession(oldName, newName);
            tmuxSessionProvider.refresh();
        }
    });
    const renameWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.renameWindow', async (item) => {
        if (!item || !item.window || !item.window.sessionName || !item.window.index) {
            vscode.window.showErrorMessage('Invalid window data for rename operation');
            return;
        }
        const { sessionName, index, name } = item.window;
        const oldName = name;
        const newName = await vscode.window.showInputBox({
            prompt: `Rename window "${index}:${oldName}" in session "${sessionName}"`,
            value: oldName,
            validateInput: value => {
                if (!value || value.trim() === '') {
                    return 'Window name cannot be empty.';
                }
                if (value === oldName) {
                    return null; // Same name is ok, just won't do anything
                }
                return null;
            }
        });
        if (newName && newName !== oldName) {
            try {
                await tmuxService.renameWindow(sessionName, index, newName);
                tmuxSessionProvider.refresh();
            }
            catch (error) {
                // Error is already shown by the service
            }
        }
    });
    const newCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.new', async () => {
        const sessions = await tmuxService.getSessions();
        let nextId = 0;
        while (sessions.includes(String(nextId))) {
            nextId++;
        }
        const choice = await (0, launchWizard_1.runLaunchWizard)('session', context.extensionUri, String(nextId), value => {
            if (!value.trim()) {
                return 'Session name cannot be empty.';
            }
            if (sessions.includes(value.trim())) {
                return `Session name "${value.trim()}" already exists.`;
            }
            return undefined;
        });
        if (!choice || !choice.name) {
            return;
        }
        const newName = choice.name;
        try {
            await tmuxService.newSession(newName, choice);
            tmuxSessionProvider.refresh();
            const terminal = createAttachTerminal(context, `tmux - ${newName}`, newName, choice.location);
            terminal.show();
        }
        catch (error) {
            // Error is already shown by the service
        }
    });
    const deleteCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.delete', async (item) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for delete operation');
            return;
        }
        const sessionName = item.session.name;
        const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to delete the tmux session "${sessionName}"?`, { modal: true }, 'Delete');
        if (confirmation === 'Delete') {
            await tmuxService.deleteSession(sessionName);
            tmuxSessionProvider.refresh();
        }
    });
    const killWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.kill-window', async (item) => {
        if (!item || !item.window) {
            vscode.window.showErrorMessage('Invalid window data for kill operation');
            return;
        }
        const { sessionName, index, name } = item.window;
        if (!sessionName || !index) {
            vscode.window.showErrorMessage('Missing window information');
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to kill window "${index}:${name}"?`, { modal: true }, 'Kill Window');
        if (confirmation === 'Kill Window') {
            await tmuxService.killWindow(sessionName, index);
            tmuxSessionProvider.refresh();
        }
    });
    const killPaneCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.kill-pane', async (item) => {
        if (!item || !item.pane) {
            vscode.window.showErrorMessage('Invalid pane data for kill operation');
            return;
        }
        const { sessionName, windowIndex, index, command } = item.pane;
        if (!sessionName || !windowIndex || !index) {
            vscode.window.showErrorMessage('Missing pane information');
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to kill pane "${index}: ${command || 'unknown'}"?`, { modal: true }, 'Kill Pane');
        if (confirmation === 'Kill Pane') {
            await tmuxService.killPane(sessionName, windowIndex, index);
            tmuxSessionProvider.refresh();
        }
    });
    const newWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.newWindow', async (item) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for new window operation');
            return;
        }
        const sessionName = item.session.name;
        const choice = await (0, launchWizard_1.runLaunchWizard)('window', context.extensionUri);
        if (!choice) {
            return;
        }
        try {
            await tmuxService.newWindow(sessionName, choice.name, choice);
            tmuxSessionProvider.refresh();
        }
        catch (error) {
            // Error is already shown by the service
        }
    });
    // Resolve the tmux target for a pane tree item, reporting why if it can't.
    const targetOf = (item) => {
        if (!item || !item.pane) {
            vscode.window.showErrorMessage('Invalid pane data for split operation');
            return undefined;
        }
        const { sessionName, windowIndex, index } = item.pane;
        if (!sessionName || !windowIndex || !index) {
            vscode.window.showErrorMessage('Missing pane information for split');
            return undefined;
        }
        return `${sessionName}:${windowIndex}.${index}`;
    };
    // The inline button: asks for working directory, what to run, and which
    // way to split. The direction is the last step rather than four separate
    // buttons on the tree item.
    const splitPaneCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.splitPane', async (item) => {
        const targetPane = targetOf(item);
        if (!targetPane) {
            return;
        }
        const choice = await (0, launchWizard_1.runLaunchWizard)('split', context.extensionUri);
        if (!choice || !choice.direction) {
            return;
        }
        await tmuxService.splitPane(targetPane, choice.direction, choice);
        tmuxSessionProvider.refresh();
    });
    const inlineNewWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.inline.newWindow', async (item) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for new window operation');
            return;
        }
        const sessionName = item.session.name;
        const choice = await (0, launchWizard_1.runLaunchWizard)('window', context.extensionUri);
        if (!choice) {
            return;
        }
        try {
            await tmuxService.newWindow(sessionName, choice.name, choice);
            tmuxSessionProvider.refresh();
        }
        catch (error) {
            // Error is already shown by the service
        }
    });
    context.subscriptions.push(attachCommand, refreshCommand, settingsCommand, renameCommand, renameWindowCommand, newCommand, deleteCommand, killWindowCommand, killPaneCommand, newWindowCommand, splitPaneCommand, inlineNewWindowCommand, tmuxSessionProvider // Add provider to dispose auto-refresh on deactivation
    );
}
function deactivate() { }
//# sourceMappingURL=extension.js.map