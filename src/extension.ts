import * as vscode from 'vscode';
import { TmuxSessionProvider, TmuxSessionTreeItem, TmuxWindowTreeItem, TmuxPaneTreeItem } from './treeProvider';
import { TmuxService, TMUX_BIN } from './tmuxService';
import { runLaunchWizard, warmUpPrograms } from './launchWizard';

// Create a terminal that attaches to a tmux/psmux session, making the
// multiplexer the terminal's main process so that exiting it closes the tab
// (instead of dropping back into a shell).
function createAttachTerminal(
    context: vscode.ExtensionContext,
    terminalName: string,
    sessionName: string,
    location?: vscode.TerminalLocation
): vscode.Terminal {
    const iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');

    if (process.platform === 'win32') {
        // psmux is a native binary and doesn't rely on a shell to set up the
        // environment, so run it directly as the terminal process.
        return vscode.window.createTerminal({
            name: terminalName,
            iconPath,
            location,
            shellPath: TMUX_BIN,
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
        shellArgs: ['-lc', `exec ${TMUX_BIN} attach -t "${sessionName}"`]
    });
}

export function activate(context: vscode.ExtensionContext) {
    const tmuxService = new TmuxService();
    const tmuxSessionProvider = new TmuxSessionProvider(tmuxService, context.extensionPath);

    vscode.window.registerTreeDataProvider('vscode-tmux-sidebar', tmuxSessionProvider);

    // Resolve which programs exist while the user is still reading the tree, so
    // opening the create form doesn't wait on it.
    warmUpPrograms();

    const attachCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.attach', async (item: TmuxSessionTreeItem | TmuxWindowTreeItem | TmuxPaneTreeItem) => {
        if (!item) {
            vscode.window.showErrorMessage('No item selected for attach');
            return;
        }

        let sessionName: string;
        let itemType: 'session' | 'window' | 'pane' = 'session';

        if (item instanceof TmuxSessionTreeItem) {
            if (!item.session || !item.session.name) {
                vscode.window.showErrorMessage('Invalid session data');
                return;
            }
            sessionName = item.session.name;
            itemType = 'session';
        } else if (item instanceof TmuxWindowTreeItem) {
            if (!item.window || !item.window.sessionName) {
                vscode.window.showErrorMessage('Invalid window data');
                return;
            }
            sessionName = item.window.sessionName;
            itemType = 'window';
        } else if (item instanceof TmuxPaneTreeItem) {
            if (!item.pane || !item.pane.sessionName) {
                vscode.window.showErrorMessage('Invalid pane data');
                return;
            }
            sessionName = item.pane.sessionName;
            itemType = 'pane';
        } else {
            // Fallback for unknown item types
            const fallbackItem = item as any;
            if (fallbackItem && typeof fallbackItem.label === 'string') {
                sessionName = fallbackItem.label;
            } else {
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
                const windowItem = item as TmuxWindowTreeItem;
                await tmuxService.selectWindow(windowItem.window.sessionName, windowItem.window.index);
                vscode.window.showInformationMessage(`Switched to window ${windowItem.window.index}:${windowItem.window.name}`);
            } else if (itemType === 'pane') {
                const paneItem = item as TmuxPaneTreeItem;
                // First select the window, then the pane
                await tmuxService.selectWindow(paneItem.pane.sessionName, paneItem.pane.windowIndex);
                await tmuxService.selectPane(paneItem.pane.sessionName, paneItem.pane.windowIndex, paneItem.pane.index);
                vscode.window.showInformationMessage(`Switched to pane ${paneItem.pane.index} in window ${paneItem.pane.windowIndex}`);
            } else {
                vscode.window.showInformationMessage(`Attached to session "${sessionName}"`);
            }
        } else {
            // No existing terminal, create new one and attach
            const terminal = createAttachTerminal(context, terminalName, sessionName);
            terminal.show();
            
            // Wait a bit for the attach to complete, then switch to specific target
            await new Promise(resolve => setTimeout(resolve, 500));
            
            if (itemType === 'window') {
                const windowItem = item as TmuxWindowTreeItem;
                await tmuxService.selectWindow(windowItem.window.sessionName, windowItem.window.index);
                vscode.window.showInformationMessage(`Attached to session "${sessionName}" and switched to window ${windowItem.window.index}:${windowItem.window.name}`);
            } else if (itemType === 'pane') {
                const paneItem = item as TmuxPaneTreeItem;
                // First select the window, then the pane
                await tmuxService.selectWindow(paneItem.pane.sessionName, paneItem.pane.windowIndex);
                await tmuxService.selectPane(paneItem.pane.sessionName, paneItem.pane.windowIndex, paneItem.pane.index);
                vscode.window.showInformationMessage(`Attached to session "${sessionName}" and switched to pane ${paneItem.pane.index} in window ${paneItem.pane.windowIndex}`);
            } else {
                vscode.window.showInformationMessage(`Attached to session "${sessionName}"`);
            }
        }
    });

    const refreshCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.refresh', async () => {
        // Force fresh data by clearing cache
        await tmuxService.getTmuxTreeFresh();
        tmuxSessionProvider.refresh();
    });

    const toggleAutoRefreshCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.toggleAutoRefresh', () => {
        tmuxSessionProvider.toggleAutoRefresh();
    });

    const renameCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.rename', async (item: TmuxSessionTreeItem) => {
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

    const renameWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.renameWindow', async (item: TmuxWindowTreeItem) => {
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
            } catch (error) {
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

        const choice = await runLaunchWizard('session', context.extensionUri, String(nextId), value => {
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
        } catch (error) {
            // Error is already shown by the service
        }
    });

    const deleteCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.delete', async (item: TmuxSessionTreeItem) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for delete operation');
            return;
        }
        
        const sessionName = item.session.name;

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the tmux session "${sessionName}"?`,
            { modal: true },
            'Delete'
        );

        if (confirmation === 'Delete') {
            await tmuxService.deleteSession(sessionName);
            tmuxSessionProvider.refresh();
        }
    });

    const killWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.kill-window', async (item: TmuxWindowTreeItem) => {
        if (!item || !item.window) {
            vscode.window.showErrorMessage('Invalid window data for kill operation');
            return;
        }
        
        const { sessionName, index, name } = item.window;
        
        if (!sessionName || !index) {
            vscode.window.showErrorMessage('Missing window information');
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to kill window "${index}:${name}"?`,
            { modal: true },
            'Kill Window'
        );

        if (confirmation === 'Kill Window') {
            await tmuxService.killWindow(sessionName, index);
            tmuxSessionProvider.refresh();
        }
    });

    const killPaneCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.kill-pane', async (item: TmuxPaneTreeItem) => {
        if (!item || !item.pane) {
            vscode.window.showErrorMessage('Invalid pane data for kill operation');
            return;
        }

        const { sessionName, windowIndex, index, command } = item.pane;
        
        if (!sessionName || !windowIndex || !index) {
            vscode.window.showErrorMessage('Missing pane information');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to kill pane "${index}: ${command || 'unknown'}"?`,
            { modal: true },
            'Kill Pane'
        );

        if (confirmation === 'Kill Pane') {
            await tmuxService.killPane(sessionName, windowIndex, index);
            tmuxSessionProvider.refresh();
        }
    });

    const newWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.newWindow', async (item: TmuxSessionTreeItem) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for new window operation');
            return;
        }
        
        const sessionName = item.session.name;
        const choice = await runLaunchWizard('window', context.extensionUri);
        if (!choice) {
            return;
        }

        try {
            await tmuxService.newWindow(sessionName, choice.name, choice);
            tmuxSessionProvider.refresh();
        } catch (error) {
            // Error is already shown by the service
        }
    });

    // Resolve the tmux target for a pane tree item, reporting why if it can't.
    const targetOf = (item: TmuxPaneTreeItem): string | undefined => {
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
    const splitPaneCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.splitPane', async (item: TmuxPaneTreeItem) => {
        const targetPane = targetOf(item);
        if (!targetPane) {
            return;
        }

        const choice = await runLaunchWizard('split', context.extensionUri);
        if (!choice || !choice.direction) {
            return;
        }

        await tmuxService.splitPane(targetPane, choice.direction, choice);
        tmuxSessionProvider.refresh();
    });


    const inlineNewWindowCommand = vscode.commands.registerCommand('vscode-tmux-sidebar.inline.newWindow', async (item: TmuxSessionTreeItem) => {
        if (!item || !item.session || !item.session.name) {
            vscode.window.showErrorMessage('Invalid session data for new window operation');
            return;
        }
        
        const sessionName = item.session.name;
        const choice = await runLaunchWizard('window', context.extensionUri);
        if (!choice) {
            return;
        }

        try {
            await tmuxService.newWindow(sessionName, choice.name, choice);
            tmuxSessionProvider.refresh();
        } catch (error) {
            // Error is already shown by the service
        }
    });

    context.subscriptions.push(
        attachCommand,
        refreshCommand,
        toggleAutoRefreshCommand,
        renameCommand,
        renameWindowCommand,
        newCommand,
        deleteCommand,
        killWindowCommand,
        killPaneCommand,
        newWindowCommand,
        splitPaneCommand,
        inlineNewWindowCommand,
        tmuxSessionProvider // Add provider to dispose auto-refresh on deactivation
    );
}

export function deactivate() {}