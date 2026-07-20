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
// Selecting an entry runs it with no arguments; the button on the right opens
// that entry's options instead, so the common case stays a single click. Every
// row is one line: the resolved binary goes in `description`, which renders
// beside the label rather than under it.
async function pickProgram() {
    const moreButton = {
        iconPath: new vscode.ThemeIcon('ellipsis'),
        tooltip: 'More options'
    };
    const items = [];
    for (const program of PROGRAMS) {
        const bin = await firstInstalled(program.bins);
        if (!bin) {
            continue; // not installed — stay out of the menu entirely
        }
        items.push({
            label: program.label,
            description: program.label.toLowerCase() === bin ? undefined : bin,
            buttons: program.submenu ? [moreButton] : undefined,
            program,
            bin
        });
    }
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Run';
        quickPick.placeholder = 'Select to run it directly, or use ⋯ for options';
        quickPick.items = items;
        let settled = false;
        const finish = (value) => {
            settled = true;
            resolve(value);
            quickPick.hide();
        };
        quickPick.onDidAccept(() => {
            const item = quickPick.selectedItems[0];
            if (!item) {
                finish(undefined);
                return;
            }
            // "Shell" carries no command: tmux then starts its default shell.
            finish({ command: item.program.label === 'Shell' ? '' : item.bin, label: item.program.label });
        });
        quickPick.onDidTriggerItemButton(async (event) => {
            const item = event.item;
            if (!item.program.submenu) {
                return;
            }
            quickPick.hide();
            finish(await item.program.submenu(item.bin));
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
async function pickWorkingDirectory(current) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items = [
        ...folders.map((folder, index) => ({
            label: folder.name,
            description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
            path: folder.uri.fsPath
        })),
        { label: 'Browse…', action: 'browse' },
        { label: 'Enter path…', action: 'enter' }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Working directory' });
    if (!picked) {
        return undefined;
    }
    if (picked.path) {
        return picked.path;
    }
    if (picked.action === 'browse') {
        const chosen = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Use this folder'
        });
        return chosen?.[0]?.fsPath;
    }
    return vscode.window.showInputBox({
        title: 'Working directory',
        value: current ?? folders[0]?.uri.fsPath,
        prompt: 'Path the new pane should start in'
    });
}
async function pickLocation() {
    const picked = await vscode.window.showQuickPick([
        { label: 'Panel', description: 'bottom panel — default', location: vscode.TerminalLocation.Panel },
        { label: 'Editor area', description: 'as an editor tab', location: vscode.TerminalLocation.Editor }
    ], { title: 'Open the terminal in' });
    return picked?.location;
}
const DIRECTIONS = [
    { label: 'Split Right', icon: 'arrow-right', direction: 'right' },
    { label: 'Split Left', icon: 'arrow-left', direction: 'left' },
    { label: 'Split Down', icon: 'arrow-down', direction: 'down' },
    { label: 'Split Up', icon: 'arrow-up', direction: 'up' }
];
function locationLabel(location) {
    return location === vscode.TerminalLocation.Editor ? 'Editor area' : 'Panel';
}
// Every row sets alwaysShow so typing a name never filters the settings out of
// view — the text box acts as the name field while the settings stay listed.
function buildRows(mode, draft, typed, validate) {
    const rows = [];
    if (mode === 'split') {
        for (const entry of DIRECTIONS) {
            rows.push({
                action: 'direction',
                direction: entry.direction,
                label: `$(${entry.icon}) ${entry.label}`,
                alwaysShow: true
            });
        }
    }
    else {
        const name = typed.trim();
        const error = validate?.(typed);
        rows.push({
            action: 'create',
            label: error
                ? `$(error) ${error}`
                : name
                    ? `$(add) Create "${name}"`
                    : `$(add) Create`,
            invalid: Boolean(error),
            alwaysShow: true
        });
    }
    rows.push({
        action: 'folder',
        label: '$(folder) Folder',
        description: draft.cwd ? path.basename(draft.cwd) : 'default',
        alwaysShow: true
    });
    rows.push({
        action: 'run',
        label: '$(play) Run',
        description: draft.commandLabel,
        alwaysShow: true
    });
    if (mode !== 'split') {
        rows.push({
            action: 'location',
            label: '$(window) Terminal',
            description: locationLabel(draft.location),
            alwaysShow: true
        });
    }
    return rows;
}
function showMainWindow(mode, draft, value, validate) {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? 'Session name' : mode === 'window' ? 'Window name (optional)' : 'Pick a direction';
        quickPick.value = value;
        quickPick.items = buildRows(mode, draft, value, validate);
        // Keep the primary action selected so Enter creates straight away.
        quickPick.activeItems = [quickPick.items[0]];
        quickPick.onDidChangeValue(current => {
            quickPick.items = buildRows(mode, draft, current, validate);
            quickPick.activeItems = [quickPick.items[0]];
        });
        let settled = false;
        const finish = (result) => {
            settled = true;
            resolve(result);
            quickPick.hide();
        };
        quickPick.onDidAccept(() => {
            const row = quickPick.selectedItems[0];
            if (!row || row.invalid) {
                return; // the name is rejected — leave the window open on it
            }
            if (row.action === 'create') {
                finish({ type: 'create', value: quickPick.value });
            }
            else if (row.action === 'direction' && row.direction) {
                finish({ type: 'direction', direction: row.direction });
            }
            else {
                finish({ type: 'edit', action: row.action, value: quickPick.value });
            }
        });
        quickPick.onDidHide(() => {
            if (!settled) {
                resolve({ type: 'cancel' });
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
}
async function applyEdit(action, draft) {
    if (action === 'folder') {
        const cwd = await pickWorkingDirectory(draft.cwd);
        if (cwd) {
            draft.cwd = cwd;
        }
        return;
    }
    if (action === 'run') {
        const picked = await pickProgram();
        if (picked) {
            draft.command = picked.command || undefined;
            draft.commandLabel = picked.label;
        }
        return;
    }
    if (action === 'location') {
        const location = await pickLocation();
        if (location !== undefined) {
            draft.location = location;
        }
    }
}
/**
 * One window listing every choice at once. The text box doubles as the name
 * field, and because each row is marked alwaysShow, typing never hides the
 * settings. Pressing Enter runs the top row, so naming a session and creating
 * it stays two keystrokes; the remaining rows only need touching to change a
 * default, and re-open this window with the typed name intact.
 */
async function runLaunchWizard(mode, defaultName, validate) {
    const draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        commandLabel: 'Shell',
        location: vscode.TerminalLocation.Panel
    };
    let value = defaultName ?? '';
    for (;;) {
        const result = await showMainWindow(mode, draft, value, validate);
        if (result.type === 'cancel') {
            return undefined;
        }
        if (result.type === 'direction') {
            return { ...draft, direction: result.direction };
        }
        if (result.type === 'create') {
            return { ...draft, name: result.value.trim() || undefined };
        }
        value = result.value;
        await applyEdit(result.action, draft);
    }
}
//# sourceMappingURL=launchWizard.js.map