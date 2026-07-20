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
exports.runLaunchWizard = runLaunchWizard;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
const exec = util.promisify(cp.exec);
const ALT_SHELLS = ['zsh', 'fish', 'sh', 'nu', 'ksh', 'dash'];
const ALT_REPLS = ['node', 'ipython', 'irb', 'ghci', 'deno', 'bun'];
// Model aliases rather than versioned ids: an alias always resolves to the
// current model of that tier, so this list does not go stale. The free-text
// entry covers anything not listed.
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const GEMINI_MODELS = ['auto', 'pro', 'flash', 'flash-lite'];
const availability = new Map();
async function isInstalled(bin) {
    const cached = availability.get(bin);
    if (cached !== undefined) {
        return cached;
    }
    const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    let found;
    try {
        await exec(probe);
        found = true;
    }
    catch {
        found = false;
    }
    availability.set(bin, found);
    return found;
}
async function firstInstalled(bins) {
    for (const bin of bins) {
        if (await isInstalled(bin)) {
            return bin;
        }
    }
    return undefined;
}
async function installedFrom(bins) {
    const found = [];
    for (const bin of bins) {
        if (await isInstalled(bin)) {
            found.push(bin);
        }
    }
    return found;
}
// A flat list plus a free-text entry built from whatever the user types, which
// is how a model name that isn't listed still gets through.
function pickFlat(title, entries, freeText) {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = title;
        quickPick.items = entries;
        if (freeText) {
            quickPick.placeholder = 'Pick one, or type a value and press Enter';
            quickPick.onDidChangeValue(value => {
                const typed = value.trim();
                quickPick.items = typed ? [...entries, { ...freeText(typed), alwaysShow: true }] : entries;
            });
        }
        let settled = false;
        quickPick.onDidAccept(() => {
            const item = quickPick.selectedItems[0];
            settled = true;
            resolve(item?.command === undefined ? undefined : { command: item.command, label: item.label });
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            if (!settled) {
                resolve(undefined);
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
}
function claudeMenu(bin) {
    return pickFlat('Claude', [
        { label: 'Resume…', description: 'previous conversation', command: `${bin} --resume` },
        ...CLAUDE_MODELS.map(model => ({ label: model, command: `${bin} --model ${model}` }))
    ], value => ({ label: value, command: `${bin} --model ${value}` }));
}
function codexMenu(bin) {
    return pickFlat('Codex', [{ label: 'Resume…', description: 'previous session', command: `${bin} resume` }], value => ({ label: value, command: `${bin} -m ${value}` }));
}
function geminiMenu(bin) {
    return pickFlat('Gemini', [
        { label: 'Resume…', description: 'previous session', command: `${bin} --resume` },
        ...GEMINI_MODELS.map(model => ({ label: model, command: `${bin} -m ${model}` }))
    ], value => ({ label: value, command: `${bin} -m ${value}` }));
}
function aiderMenu(bin) {
    return pickFlat('Aider', [{ label: 'Restore chat history', command: `${bin} --restore-chat-history` }], value => ({ label: value, command: `${bin} --model ${value}` }));
}
async function shellMenu() {
    const shells = await installedFrom(ALT_SHELLS);
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
        return undefined;
    }
    return pickFlat('Shell', shells.map(shell => ({ label: shell, command: shell })));
}
async function replMenu() {
    const repls = await installedFrom(ALT_REPLS);
    if (repls.length === 0) {
        vscode.window.showInformationMessage('No other REPLs found on this system.');
        return undefined;
    }
    return pickFlat('REPL', repls.map(repl => ({ label: repl, command: repl })));
}
const PROGRAMS = [
    { label: 'Shell', bins: ['bash'], submenu: shellMenu },
    { label: 'Python', bins: ['python3', 'python'], submenu: replMenu },
    { label: 'Claude', bins: ['claude'], submenu: claudeMenu },
    { label: 'Codex', bins: ['codex'], submenu: codexMenu },
    { label: 'Gemini', bins: ['gemini', 'agy'], submenu: geminiMenu },
    { label: 'Aider', bins: ['aider'], submenu: aiderMenu },
    { label: 'opencode', bins: ['opencode'] },
    { label: 'Goose', bins: ['goose'] },
    { label: 'Crush', bins: ['crush'] },
    { label: 'lazygit', bins: ['lazygit'] },
    { label: 'tig', bins: ['tig'] },
    { label: 'gitui', bins: ['gitui'] }
];
async function resolvePrograms() {
    const resolved = [];
    for (const program of PROGRAMS) {
        const bin = await firstInstalled(program.bins);
        if (bin) {
            resolved.push({ program, bin });
        }
    }
    return resolved;
}
/**
 * Path entry and the project folders in one window: the text box holds the
 * path, and each root is one click. Typing a path that isn't a root surfaces a
 * confirm row at the top so Enter uses what was typed.
 */
function pickWorkingDirectory(current) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder, index) => ({
        label: `$(folder) ${folder.name}`,
        description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
        path: folder.uri.fsPath,
        alwaysShow: true
    }));
    const heading = {
        label: 'Project folders',
        kind: vscode.QuickPickItemKind.Separator
    };
    const build = (typed) => {
        const value = typed.trim();
        const matchesRoot = folders.some(folder => folder.uri.fsPath === value);
        const rows = [];
        if (value && !matchesRoot) {
            rows.push({ label: `$(check) Use this path`, description: value, path: value, alwaysShow: true });
        }
        if (roots.length > 0) {
            rows.push(heading, ...roots);
        }
        return rows;
    };
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Working directory';
        quickPick.placeholder = 'Type a path, or pick a project folder below';
        quickPick.value = current ?? '';
        quickPick.items = build(quickPick.value);
        quickPick.onDidChangeValue(value => {
            quickPick.items = build(value);
        });
        let settled = false;
        quickPick.onDidAccept(() => {
            const item = quickPick.activeItems[0];
            settled = true;
            resolve(item?.path ?? (quickPick.value.trim() || undefined));
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            if (!settled) {
                resolve(undefined);
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
}
// Where a new terminal opens, defaulting to whatever VS Code itself is set to
// rather than assuming the panel.
function defaultTerminalLocation() {
    const configured = vscode.workspace.getConfiguration('terminal.integrated').get('defaultLocation');
    return configured === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
}
// Each direction shows where the new pane lands: a strip on the matching edge
// of the layout, rather than an arrow that only says which way.
const DIRECTIONS = [
    { label: 'Split right', icon: 'layout-sidebar-right', direction: 'right' },
    { label: 'Split left', icon: 'layout-sidebar-left', direction: 'left' },
    { label: 'Split down', icon: 'layout-statusbar', direction: 'down' },
    { label: 'Split up', icon: 'layout-menubar', direction: 'up' }
];
const MORE_BUTTON = {
    iconPath: new vscode.ThemeIcon('ellipsis'),
    tooltip: 'More options'
};
function separator(label) {
    return { label, kind: vscode.QuickPickItemKind.Separator };
}
// Reads top to bottom the way the task does: name, folder, what to run, then
// the action. Every row sets alwaysShow so typing a name never filters the
// list out of view.
function buildRows(mode, draft, programs, typed, validate) {
    const rows = [];
    rows.push(separator('Folder'));
    rows.push({
        action: 'folder',
        label: `$(folder-opened) ${draft.cwd ? path.basename(draft.cwd) : 'Default'}`,
        description: draft.cwd,
        alwaysShow: true
    });
    rows.push(separator('Run'));
    for (const resolved of programs) {
        const selected = resolved.program.label === draft.commandLabel;
        rows.push({
            action: 'program',
            resolved,
            label: `$(${selected ? 'circle-filled' : 'circle-outline'}) ${resolved.program.label}`,
            description: resolved.program.label.toLowerCase() === resolved.bin ? undefined : resolved.bin,
            buttons: resolved.program.submenu ? [MORE_BUTTON] : undefined,
            alwaysShow: true
        });
    }
    // A submenu choice such as "claude --model opus" is not one of the rows
    // above, so show it as its own selected entry.
    if (!programs.some(resolved => resolved.program.label === draft.commandLabel)) {
        rows.push({
            label: `$(circle-filled) ${draft.commandLabel}`,
            description: draft.command,
            alwaysShow: true
        });
    }
    if (mode === 'split') {
        rows.push(separator('Split'));
        for (const entry of DIRECTIONS) {
            rows.push({
                action: 'direction',
                direction: entry.direction,
                label: `$(${entry.icon}) ${entry.label}`,
                alwaysShow: true
            });
        }
        return rows;
    }
    const error = validate?.(typed);
    rows.push(separator('Create'));
    if (error) {
        rows.push({ label: `$(error) ${error}`, invalid: true, alwaysShow: true });
        return rows;
    }
    if (mode === 'window') {
        // A window belongs to a session that is already attached somewhere, so
        // there is no terminal to place.
        rows.push({ action: 'create', label: '$(add) Create window', alwaysShow: true });
        return rows;
    }
    rows.push({
        action: 'create',
        location: vscode.TerminalLocation.Panel,
        label: '$(layout-panel) Create in panel',
        alwaysShow: true
    });
    rows.push({
        action: 'create',
        location: vscode.TerminalLocation.Editor,
        label: '$(layout-centered) Create in editor area',
        alwaysShow: true
    });
    return rows;
}
/**
 * One window holding every choice. The text box is the name field; folder and
 * program rows change a setting and stay put; the rows under Create (or Split)
 * are the actions, so the last click both picks where and creates.
 */
function showMainWindow(mode, draft, programs, initialValue, validate) {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? 'Session name' : mode === 'window' ? 'Window name (optional)' : 'Pick where the new pane goes';
        quickPick.value = initialValue;
        const preferred = defaultTerminalLocation();
        // Enter should do the expected thing straight after typing a name, so
        // preselect the action matching VS Code's own terminal location.
        const defaultRow = (rows) => rows.find(row => row.action === 'create' && (row.location === undefined || row.location === preferred)) ??
            rows.find(row => row.action === 'direction' || row.action === 'create');
        const render = (keep) => {
            const rows = buildRows(mode, draft, programs, quickPick.value, validate);
            quickPick.items = rows;
            const active = (keep && rows.find(keep)) ?? defaultRow(rows);
            if (active) {
                quickPick.activeItems = [active];
            }
        };
        // Set while a sub-picker is open so hiding this window isn't read as
        // the user dismissing it.
        let suspended = false;
        let settled = false;
        const finish = (choice) => {
            settled = true;
            resolve(choice);
            quickPick.hide();
        };
        const suspend = async (action, keep) => {
            suspended = true;
            quickPick.hide();
            await action();
            suspended = false;
            render(keep);
            quickPick.show();
        };
        quickPick.onDidChangeValue(() => render());
        quickPick.onDidAccept(async () => {
            const row = quickPick.activeItems[0];
            if (!row || row.invalid || !row.action) {
                return;
            }
            if (row.action === 'create') {
                finish({ ...draft, name: quickPick.value.trim() || undefined, location: row.location });
                return;
            }
            if (row.action === 'direction') {
                finish({ ...draft, direction: row.direction });
                return;
            }
            if (row.action === 'program' && row.resolved) {
                // Selecting a program only records it; creating is the last step.
                draft.command = row.resolved.program.label === 'Shell' ? undefined : row.resolved.bin;
                draft.commandLabel = row.resolved.program.label;
                render(candidate => candidate.resolved?.program === row.resolved?.program);
                return;
            }
            if (row.action === 'folder') {
                await suspend(async () => {
                    const cwd = await pickWorkingDirectory(draft.cwd);
                    if (cwd) {
                        draft.cwd = cwd;
                    }
                }, candidate => candidate.action === 'folder');
            }
        });
        quickPick.onDidTriggerItemButton(async (event) => {
            const resolved = event.item.resolved;
            if (!resolved?.program.submenu) {
                return;
            }
            await suspend(async () => {
                const picked = await resolved.program.submenu(resolved.bin);
                if (picked) {
                    draft.command = picked.command || undefined;
                    draft.commandLabel = picked.label;
                }
            });
        });
        quickPick.onDidHide(() => {
            if (suspended) {
                return;
            }
            if (!settled) {
                resolve(undefined);
            }
            quickPick.dispose();
        });
        render();
        quickPick.show();
    });
}
async function runLaunchWizard(mode, defaultName, validate) {
    const programs = await resolvePrograms();
    const draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        commandLabel: 'Shell'
    };
    return showMainWindow(mode, draft, programs, defaultName ?? '', validate);
}
//# sourceMappingURL=launchWizard.js.map