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
                if (!typed) {
                    quickPick.items = entries;
                    return;
                }
                quickPick.items = [...entries, { ...freeText(typed) }];
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
        { label: 'Resume…', command: `${bin} --resume`, detail: 'Pick a previous conversation' },
        ...CLAUDE_MODELS.map(model => ({ label: model, command: `${bin} --model ${model}`, detail: `Latest ${model} model` }))
    ], value => ({ label: value, command: `${bin} --model ${value}` }));
}
function codexMenu(bin) {
    return pickFlat('Codex', [{ label: 'Resume…', command: `${bin} resume`, detail: 'Pick a previous session' }], value => ({ label: value, command: `${bin} -m ${value}` }));
}
function geminiMenu(bin) {
    return pickFlat('Gemini', [
        { label: 'Resume…', command: `${bin} --resume`, detail: 'Load a previous session' },
        ...GEMINI_MODELS.map(model => ({ label: model, command: `${bin} -m ${model}` }))
    ], value => ({ label: value, command: `${bin} -m ${value}` }));
}
function aiderMenu(bin) {
    return pickFlat('Aider', [{ label: 'Restore chat history', command: `${bin} --restore-chat-history`, detail: 'Continue the last conversation' }], value => ({ label: value, command: `${bin} --model ${value}` }));
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
    { label: 'Shell', bins: ['bash'], detail: 'Default shell', submenu: shellMenu },
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
// that entry's options instead, so the common case stays a single click.
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
            detail: program.detail,
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
            description: folder.uri.fsPath,
            detail: index === 0 ? 'Project folder (default)' : undefined,
            path: folder.uri.fsPath
        })),
        { label: 'Browse…', detail: 'Pick a folder', action: 'browse' },
        { label: 'Enter path…', detail: 'Type a path', action: 'enter' }
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
        { label: 'Panel', detail: 'Bottom panel (default)', location: vscode.TerminalLocation.Panel },
        { label: 'Editor area', detail: 'As an editor tab', location: vscode.TerminalLocation.Editor }
    ], { title: 'Open the terminal in' });
    return picked?.location;
}
const FOLDER_BUTTON = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Working directory' };
const RUN_BUTTON = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'What to run' };
const LOCATION_BUTTON = { iconPath: new vscode.ThemeIcon('layout'), tooltip: 'Where to open the terminal' };
function summarise(draft, mode) {
    const folder = draft.cwd ? path.basename(draft.cwd) : 'default';
    const parts = [`Folder: ${folder}`, `Run: ${draft.commandLabel}`];
    if (mode !== 'split') {
        parts.push(`Terminal: ${draft.location === vscode.TerminalLocation.Editor ? 'Editor area' : 'Panel'}`);
    }
    return `${parts.join('   ·   ')}   ·   change with the buttons above`;
}
// Runs the sub-picker behind a title button. Returns false when the user backed
// out of it, so the caller knows nothing changed.
async function applyButton(button, draft, mode) {
    if (button === FOLDER_BUTTON) {
        const cwd = await pickWorkingDirectory(draft.cwd);
        if (cwd) {
            draft.cwd = cwd;
        }
        return;
    }
    if (button === RUN_BUTTON) {
        const picked = await pickProgram();
        if (picked) {
            draft.command = picked.command || undefined;
            draft.commandLabel = picked.label;
        }
        return;
    }
    if (button === LOCATION_BUTTON && mode !== 'split') {
        const location = await pickLocation();
        if (location !== undefined) {
            draft.location = location;
        }
    }
}
function showNameInput(mode, value, draft, validate) {
    return new Promise(resolve => {
        const input = vscode.window.createInputBox();
        input.title = mode === 'session' ? 'New session' : 'New window';
        input.value = value;
        input.prompt = summarise(draft, mode);
        input.placeholder = mode === 'window' ? 'Window name (optional)' : 'Session name';
        input.buttons = mode === 'session' ? [FOLDER_BUTTON, RUN_BUTTON, LOCATION_BUTTON] : [FOLDER_BUTTON, RUN_BUTTON];
        input.validationMessage = validate?.(value);
        let settled = false;
        const finish = (result) => {
            settled = true;
            resolve(result);
            input.hide();
        };
        input.onDidChangeValue(current => {
            input.validationMessage = validate?.(current);
        });
        input.onDidAccept(() => {
            // Refuse the name here rather than after the window closes, so the
            // problem is shown next to the field being corrected.
            if (validate?.(input.value)) {
                return;
            }
            finish({ type: 'accept', value: input.value });
        });
        input.onDidTriggerButton(button => finish({ type: 'button', value: input.value, button }));
        input.onDidHide(() => {
            if (!settled) {
                resolve({ type: 'cancel' });
            }
            input.dispose();
        });
        input.show();
    });
}
const DIRECTIONS = [
    { label: 'Right', icon: 'arrow-right', direction: 'right' },
    { label: 'Left', icon: 'arrow-left', direction: 'left' },
    { label: 'Down', icon: 'arrow-down', direction: 'down' },
    { label: 'Up', icon: 'arrow-up', direction: 'up' }
];
function showDirectionPick(draft) {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Split pane';
        quickPick.placeholder = summarise(draft, 'split');
        quickPick.items = DIRECTIONS.map(entry => ({
            label: `$(${entry.icon}) ${entry.label}`,
            direction: entry.direction
        }));
        quickPick.buttons = [FOLDER_BUTTON, RUN_BUTTON];
        let settled = false;
        const finish = (result) => {
            settled = true;
            resolve(result);
            quickPick.hide();
        };
        quickPick.onDidAccept(() => {
            const item = quickPick.selectedItems[0];
            finish(item ? { type: 'accept', direction: item.direction } : { type: 'cancel' });
        });
        quickPick.onDidTriggerButton(button => finish({ type: 'button', button }));
        quickPick.onDidHide(() => {
            if (!settled) {
                resolve({ type: 'cancel' });
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
}
/**
 * One window, not a sequence of steps. Sessions and windows show a name field
 * — typing a name and pressing Enter is the whole interaction — while a split
 * shows the four directions. Working directory, what to run, and where to open
 * the terminal all have defaults, are visible in the summary line, and change
 * through the title buttons only if the user wants them to.
 */
async function runLaunchWizard(mode, defaultName, validate) {
    const draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        commandLabel: 'Shell',
        location: vscode.TerminalLocation.Panel
    };
    if (mode === 'split') {
        for (;;) {
            const result = await showDirectionPick(draft);
            if (result.type === 'cancel') {
                return undefined;
            }
            if (result.type === 'accept') {
                return { ...draft, direction: result.direction };
            }
            await applyButton(result.button, draft, mode);
        }
    }
    let value = defaultName ?? '';
    for (;;) {
        const result = await showNameInput(mode, value, draft, validate);
        if (result.type === 'cancel') {
            return undefined;
        }
        value = result.value;
        if (result.type === 'accept') {
            return { ...draft, name: value.trim() || undefined };
        }
        await applyButton(result.button, draft, mode);
    }
}
//# sourceMappingURL=launchWizard.js.map