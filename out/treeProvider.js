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
exports.TmuxPaneTreeItem = exports.TmuxWindowTreeItem = exports.TmuxSessionTreeItem = exports.TmuxSessionProvider = void 0;
const vscode = __importStar(require("vscode"));
class TmuxSessionProvider {
    constructor(tmuxService, extensionPath) {
        this.tmuxService = tmuxService;
        this.extensionPath = extensionPath;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.visible = true;
        // What the view currently shows, serialized — the auto-refresh tick only
        // repaints when the tmux state actually differs, so an idle sidebar
        // doesn't flicker every few seconds.
        this.lastSnapshot = '';
        this.applyAutoRefreshSettings();
        // The settings page (or settings.json) is where auto refresh is
        // controlled; the timer follows the configuration.
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('tmuxSidebar.autoRefresh')) {
                this.applyAutoRefreshSettings();
            }
        });
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    // Fetch fresh data and repaint only if it changed. Used by the periodic
    // and manual refreshes; after a known mutation, plain refresh() is right.
    async refreshIfChanged() {
        const sessions = await this.tmuxService.getTmuxTreeFresh();
        const snapshot = JSON.stringify(sessions);
        if (snapshot !== this.lastSnapshot) {
            this.refresh();
        }
    }
    // The auto-refresh timer only runs while the view is on screen — polling
    // tmux every few seconds behind a hidden panel is pure waste.
    setVisible(visible) {
        if (this.visible === visible) {
            return;
        }
        this.visible = visible;
        this.applyAutoRefreshSettings();
        if (visible) {
            void this.refreshIfChanged();
        }
    }
    applyAutoRefreshSettings() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = undefined;
        }
        const config = vscode.workspace.getConfiguration('tmuxSidebar.autoRefresh');
        if (!this.visible || !config.get('enabled', true)) {
            return;
        }
        const seconds = Math.max(1, config.get('intervalSeconds', 3));
        this.autoRefreshInterval = setInterval(() => void this.refreshIfChanged(), seconds * 1000);
    }
    dispose() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = undefined;
        }
        this.configListener.dispose();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (element) {
            if (element instanceof TmuxSessionTreeItem) {
                if (!element.session || !element.session.windows) {
                    return [];
                }
                return element.session.windows.map(win => new TmuxWindowTreeItem(win, this.extensionPath, element.session.isAttached));
            }
            if (element instanceof TmuxWindowTreeItem) {
                if (!element.window || !element.window.panes) {
                    return [];
                }
                return element.window.panes.map(pane => new TmuxPaneTreeItem(pane, this.extensionPath, element.sessionAttached, element.window.isActive));
            }
            return [];
        }
        // With no sessions the tree must be genuinely empty: only then does
        // VS Code show the viewsWelcome content with its New Session button.
        const sessions = await this.tmuxService.getTmuxTree();
        this.lastSnapshot = JSON.stringify(sessions);
        return sessions.map(session => new TmuxSessionTreeItem(session));
    }
}
exports.TmuxSessionProvider = TmuxSessionProvider;
class TmuxSessionTreeItem extends vscode.TreeItem {
    constructor(session) {
        const label = session.name;
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.session = session;
        // Stable ids let VS Code match items across repaints, keeping the
        // selection and expansion state instead of visibly rebuilding rows.
        this.id = `s:${session.name}`;
        this.contextValue = 'tmuxSession';
        this.iconPath = new vscode.ThemeIcon('server');
        // Use icon color to show attached status
        if (session.isAttached) {
            this.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('terminal.ansiGreen'));
        }
        // Add tooltip with session info
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**Session:** ${session.name}\n\n`);
        tooltip.appendMarkdown(`**Status:** ${session.isAttached ? 'Attached' : 'Detached'}\n\n`);
        if (session.created) {
            tooltip.appendMarkdown(`**Created:** ${new Date(parseInt(session.created) * 1000).toLocaleString()}\n\n`);
        }
        if (session.lastActivity) {
            tooltip.appendMarkdown(`**Last Activity:** ${new Date(parseInt(session.lastActivity) * 1000).toLocaleString()}\n\n`);
        }
        tooltip.appendMarkdown(`**Windows:** ${session.windows.length}`);
        this.tooltip = tooltip;
    }
}
exports.TmuxSessionTreeItem = TmuxSessionTreeItem;
class TmuxWindowTreeItem extends vscode.TreeItem {
    constructor(window, extensionPath, sessionAttached) {
        const label = `${window.index}:${window.name}`;
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.window = window;
        this.sessionAttached = sessionAttached;
        this.id = `w:${window.sessionName}:${window.index}`;
        this.contextValue = 'tmuxWindow';
        this.iconPath = new vscode.ThemeIcon('window');
        // Use description and icon color to show status
        if (window.isActive && sessionAttached) {
            // this.description = '🔵';
            this.description = '';
            this.iconPath = new vscode.ThemeIcon('window', new vscode.ThemeColor('terminal.ansiGreen'));
        }
        else if (window.isActive) {
            // this.description = '🔵';
            this.description = '';
        }
        // Add tooltip with window info
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**Window:** ${window.index}:${window.name}\n\n`);
        tooltip.appendMarkdown(`**Status:** ${window.isActive ? 'Active' : 'Inactive'}\n\n`);
        tooltip.appendMarkdown(`**Session:** ${window.sessionName}\n\n`);
        tooltip.appendMarkdown(`**Panes:** ${window.panes.length}`);
        this.tooltip = tooltip;
    }
}
exports.TmuxWindowTreeItem = TmuxWindowTreeItem;
class TmuxPaneTreeItem extends vscode.TreeItem {
    constructor(pane, extensionPath, sessionAttached, windowActive) {
        const label = `${pane.index}: ${pane.command}`;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.pane = pane;
        this.id = `p:${pane.sessionName}:${pane.windowIndex}.${pane.index}`;
        this.contextValue = 'tmuxPane';
        const iconName = TmuxPaneTreeItem.getCommandIconName(pane.command);
        this.iconPath = new vscode.ThemeIcon(iconName);
        // Use description and icon color to show status
        if (pane.isActive && windowActive && sessionAttached) {
            this.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('terminal.ansiGreen'));
            // Don't add description for panes to keep it clean, the green icon is sufficient
        }
        else if (pane.isActive) {
            // Show that pane is active but not fully connected
        }
        // Add tooltip with pane info
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**Pane:** ${pane.index}\n\n`);
        tooltip.appendMarkdown(`**Command:** ${pane.command}\n\n`);
        tooltip.appendMarkdown(`**Status:** ${pane.isActive ? 'Active' : 'Inactive'}\n\n`);
        tooltip.appendMarkdown(`**Current Path:** ${pane.currentPath}\n\n`);
        if (pane.pid > 0) {
            tooltip.appendMarkdown(`**PID:** ${pane.pid}\n\n`);
        }
        tooltip.appendMarkdown(`**Session:** ${pane.sessionName}\n\n`);
        tooltip.appendMarkdown(`**Window:** ${pane.windowIndex}`);
        this.tooltip = tooltip;
        // Add description to show path
        this.description = pane.currentPath !== '~' ? pane.currentPath : undefined;
    }
    static getCommandIconName(command) {
        const cmd = command.toLowerCase();
        if (cmd.includes('vim') || cmd.includes('nvim'))
            return 'edit';
        if (cmd.includes('ssh'))
            return 'remote';
        if (cmd.includes('bash') || cmd.includes('zsh') || cmd.includes('sh'))
            return 'terminal-bash';
        if (cmd.includes('python') || cmd.includes('py'))
            return 'symbol-method';
        if (cmd.includes('node') || cmd.includes('npm'))
            return 'nodejs';
        if (cmd.includes('git'))
            return 'git-branch';
        if (cmd.includes('docker'))
            return 'server-environment';
        if (cmd.includes('htop') || cmd.includes('top'))
            return 'pulse';
        if (cmd.includes('tail') || cmd.includes('less') || cmd.includes('more'))
            return 'output';
        if (cmd.includes('mysql') || cmd.includes('psql'))
            return 'database';
        return 'terminal'; // Default icon
    }
}
exports.TmuxPaneTreeItem = TmuxPaneTreeItem;
//# sourceMappingURL=treeProvider.js.map