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
// Every entry's label is its command, so nothing needs a secondary hint. A
// free-text entry lets a model name that isn't listed still get through.
function pickFlat(title, commands, freeText) {
    const toItem = (command) => ({ label: command, command });
    const entries = commands.map(toItem);
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = title;
        quickPick.items = entries;
        if (freeText) {
            quickPick.placeholder = 'Type a model name and press Enter, or pick one below';
            quickPick.onDidChangeValue(value => {
                const typed = value.trim();
                quickPick.items = typed
                    ? [...entries, { label: `${freeText} ${typed}`, command: `${freeText} ${typed}`, alwaysShow: true }]
                    : entries;
            });
        }
        let settled = false;
        quickPick.onDidAccept(() => {
            const item = quickPick.selectedItems[0];
            settled = true;
            resolve(item?.command === undefined ? undefined : { label: item.label, command: item.command });
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
    return pickFlat('Claude', [bin, `${bin} --resume`, `${bin} --resume --fork-session`, ...CLAUDE_MODELS.map(m => `${bin} --model ${m}`)], bin);
}
function codexMenu(bin) {
    return pickFlat('Codex', [bin, `${bin} resume`], `${bin} -m`);
}
function geminiMenu(bin) {
    // The gemini CLI's --resume loads the most recent session rather than
    // opening a picker, so it is left out; the model aliases are verified.
    return pickFlat('Gemini', [bin, ...GEMINI_MODELS.map(m => `${bin} -m ${m}`)], `${bin} -m`);
}
// Antigravity (agy), gemini's successor, has its own flags: --model takes a
// full model name (spaces and all), not the -m aliases, and its resume forms
// (--continue / --conversation <id>) are either not a picker or need an id, so
// only the plain command and a free-text model are offered.
function agyMenu(bin) {
    return pickFlat('Antigravity', [bin], `${bin} --model`);
}
function aiderMenu(bin) {
    return pickFlat('Aider', [bin, `${bin} --restore-chat-history`], `${bin} --model`);
}
async function shellMenu(bin) {
    const shells = await installedFrom(ALT_SHELLS);
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
    }
    return pickFlat('Shell', [bin, ...shells]);
}
async function replMenu(bin) {
    const repls = await installedFrom(ALT_REPLS);
    if (repls.length === 0) {
        vscode.window.showInformationMessage('No other REPLs found on this system.');
    }
    return pickFlat('REPL', [bin, ...repls]);
}
const PROGRAMS = [
    { label: 'bash', bins: ['bash'], submenu: shellMenu },
    { label: 'python3', bins: ['python3', 'python'], submenu: replMenu },
    { label: 'claude', bins: ['claude'], submenu: claudeMenu },
    { label: 'codex', bins: ['codex'], submenu: codexMenu },
    { label: 'gemini', bins: ['gemini'], submenu: geminiMenu },
    { label: 'agy', bins: ['agy'], submenu: agyMenu },
    { label: 'aider', bins: ['aider'], submenu: aiderMenu },
    { label: 'opencode', bins: ['opencode'] },
    { label: 'goose', bins: ['goose'] },
    { label: 'crush', bins: ['crush'] },
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
// The plain form of a program: its own binary as the command. bash keeps an
// empty command so tmux starts the session's default shell.
function basePick(resolved) {
    const command = resolved.program.label === 'bash' ? '' : resolved.bin;
    return { label: resolved.bin, command };
}
/**
 * Path entry and the project folders in one window: the text box holds the
 * path, each root is one click, and a Browse button on the title bar opens the
 * native folder dialog. `ignoreFocusOut` keeps this window alive while that
 * dialog has focus.
 */
function pickWorkingDirectory(current) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = folders.map((folder, index) => ({
        label: `$(folder) ${folder.name}`,
        description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
        path: folder.uri.fsPath,
        alwaysShow: true
    }));
    const heading = { label: 'Project folders', kind: vscode.QuickPickItemKind.Separator };
    const build = (typed) => {
        const value = typed.trim();
        const matchesRoot = folders.some(folder => folder.uri.fsPath === value);
        const rows = [];
        if (value && !matchesRoot) {
            rows.push({ label: '$(check) Use this path', description: value, path: value, alwaysShow: true });
        }
        if (roots.length > 0) {
            rows.push(heading, ...roots);
        }
        return rows;
    };
    const browseButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Browse…' };
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Working directory';
        quickPick.placeholder = 'Type a path, pick a project folder, or Browse…';
        quickPick.buttons = [browseButton];
        quickPick.value = current ?? '';
        quickPick.items = build(quickPick.value);
        quickPick.onDidChangeValue(value => {
            quickPick.items = build(value);
        });
        let settled = false;
        // On a remote (WSL/SSH) showOpenDialog is itself a quick pick, so it
        // can't coexist with this one. Hide this window for the dialog and bring
        // it back if the dialog was dismissed.
        let browsing = false;
        const finish = (value) => {
            settled = true;
            resolve(value);
            quickPick.hide();
        };
        quickPick.onDidTriggerButton(async () => {
            browsing = true;
            quickPick.hide();
            const chosen = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: current ? vscode.Uri.file(current) : undefined,
                openLabel: 'Use this folder'
            });
            browsing = false;
            if (chosen?.[0]) {
                finish(chosen[0].fsPath);
            }
            else {
                quickPick.show();
            }
        });
        quickPick.onDidAccept(() => {
            const item = quickPick.activeItems[0];
            finish(item?.path ?? (quickPick.value.trim() || undefined));
        });
        quickPick.onDidHide(() => {
            if (browsing) {
                return;
            }
            if (!settled) {
                resolve(undefined);
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
}
// Where a new terminal opens, defaulting to whatever VS Code itself is set to
// rather than assuming the panel. Only used to order the two create rows.
function defaultTerminalLocation() {
    const configured = vscode.workspace.getConfiguration('terminal.integrated').get('defaultLocation');
    return configured === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
}
const DIRECTIONS = [
    { label: 'Split right', direction: 'right', icon: 'right' },
    { label: 'Split left', direction: 'left', icon: 'left' },
    { label: 'Split down', direction: 'down', icon: 'down' },
    { label: 'Split up', direction: 'up', icon: 'up' }
];
function effectivePick(draft, resolved) {
    return draft.overrides.get(resolved.program.label) ?? basePick(resolved);
}
// A flat list — no separators, since a quick pick hides them the moment the
// name field has text, which it usually does. The leading icon on every row
// carries the grouping instead: green circles mark the programs. Every real row
// sets alwaysShow so typing a name never filters the list out of view.
function buildRows(mode, draft, programs, preferred, splitIcon, dotIcon, optionsButton) {
    const rows = [];
    rows.push({
        act: 'folder',
        iconPath: new vscode.ThemeIcon('folder-opened'),
        label: draft.cwd ? path.basename(draft.cwd) : 'Default',
        description: draft.cwd,
        alwaysShow: true
    });
    for (const resolved of programs) {
        const pick = effectivePick(draft, resolved);
        const selected = resolved.program.label === draft.selectedProgram;
        rows.push({
            act: 'program',
            resolved,
            iconPath: dotIcon(selected),
            label: pick.label,
            // A filled button opens the variants. Item buttons reveal on hover,
            // but the selected row always shows its button — and the selected
            // program is exactly the one being configured.
            buttons: resolved.program.submenu ? [optionsButton] : undefined,
            alwaysShow: true
        });
    }
    if (mode === 'split') {
        for (const entry of DIRECTIONS) {
            rows.push({
                act: 'direction',
                direction: entry.direction,
                label: entry.label,
                iconPath: splitIcon(entry.icon),
                alwaysShow: true
            });
        }
        return rows;
    }
    if (mode === 'window') {
        // A window belongs to a session already attached somewhere, so there
        // is no terminal placement to choose.
        rows.push({ act: 'create', iconPath: new vscode.ThemeIcon('add'), label: 'Create window', alwaysShow: true });
        return rows;
    }
    // Editor first, panel second, with the location VS Code itself defaults to
    // tagged rather than reordered.
    const tag = (location) => (location === preferred ? 'default' : undefined);
    rows.push({
        act: 'create',
        location: vscode.TerminalLocation.Editor,
        iconPath: new vscode.ThemeIcon('window'),
        label: 'Create in editor area',
        description: tag(vscode.TerminalLocation.Editor),
        alwaysShow: true
    });
    rows.push({
        act: 'create',
        location: vscode.TerminalLocation.Panel,
        iconPath: new vscode.ThemeIcon('layout-panel'),
        label: 'Create in panel',
        description: tag(vscode.TerminalLocation.Panel),
        alwaysShow: true
    });
    return rows;
}
/**
 * One window holding every choice. The text box is the name field; the folder
 * row and program rows change a setting and keep the window open; the rows
 * under Create (or Split) are the actions. The highlight sits on the chosen
 * program so it is clear what will run; creating is a click on a Create row.
 */
function showMainWindow(mode, draft, programs, extensionUri, suggestedName, validate) {
    const preferred = defaultTerminalLocation();
    const themedIcon = (dir, name) => ({
        light: vscode.Uri.joinPath(extensionUri, 'resources', dir, `${name}-light.svg`),
        dark: vscode.Uri.joinPath(extensionUri, 'resources', dir, `${name}-dark.svg`)
    });
    const splitIcon = (d) => themedIcon('split', d);
    const dotIcon = (selected) => themedIcon('dot', selected ? 'filled' : 'outline');
    const optionsButton = { iconPath: themedIcon('more', 'options'), tooltip: 'Options' };
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? 'Session name'
                : mode === 'window' ? 'Window name (optional)'
                    : 'Pick where the new pane goes';
        // Pre-fill the suggested session name so pressing Enter straight away
        // creates it; the box is empty (and separators are gone) so nothing is
        // hidden by having text in it.
        quickPick.value = mode === 'session' ? suggestedName : '';
        // The row Enter should trigger by default: the create location VS Code
        // prefers, or the first split direction — never a program row, so the
        // "type a name and press Enter" path always creates.
        const defaultActive = (rows) => rows.find(row => row.act === 'create' && (row.location === undefined || row.location === preferred)) ??
            rows.find(row => row.act === 'create' || row.act === 'direction');
        // The text box is really the name field, but a quick pick always
        // filters its list by it and moves the highlight onto whatever label
        // matches. Re-pinning the highlight on every keystroke keeps typing a
        // name from disturbing the selection. Label matching itself can't be
        // turned off — there is no matchOnLabel — so this is the way.
        let pinned;
        // `keepProgram` holds the highlight on a just-clicked program instead;
        // otherwise it rests on the default action.
        const render = (keepProgram) => {
            const rows = buildRows(mode, draft, programs, preferred, splitIcon, dotIcon, optionsButton);
            quickPick.items = rows;
            pinned = keepProgram
                ? rows.find(row => row.act === 'program' && row.resolved?.program.label === keepProgram)
                : defaultActive(rows);
            if (pinned) {
                quickPick.activeItems = [pinned];
            }
        };
        quickPick.matchOnDescription = false;
        quickPick.matchOnDetail = false;
        quickPick.onDidChangeValue(() => {
            if (pinned && quickPick.items.includes(pinned)) {
                quickPick.activeItems = [pinned];
            }
        });
        let suspended = false;
        let settled = false;
        const finish = (choice) => {
            settled = true;
            resolve(choice);
            quickPick.hide();
        };
        // Run a sub-picker with this window hidden, then bring it back. QuickPick
        // is a single overlay, so the sub-picker replaces rather than stacks —
        // the API offers no way to layer one over another.
        const suspend = async (action) => {
            suspended = true;
            quickPick.hide();
            await action();
            suspended = false;
            render();
            quickPick.show();
        };
        const selectProgram = (resolved, pick) => {
            draft.selectedProgram = resolved.program.label;
            draft.command = pick.command || undefined;
        };
        const openOptions = async (resolved) => {
            if (!resolved.program.submenu) {
                vscode.window.showInformationMessage(`${resolved.bin} has no extra options.`);
                return;
            }
            await suspend(async () => {
                const picked = await resolved.program.submenu(resolved.bin);
                if (picked) {
                    draft.overrides.set(resolved.program.label, picked);
                    selectProgram(resolved, picked);
                }
            });
        };
        quickPick.onDidTriggerItemButton(async (event) => {
            const resolved = event.item.resolved;
            if (resolved) {
                await openOptions(resolved);
            }
        });
        quickPick.onDidAccept(async () => {
            const row = quickPick.activeItems[0];
            if (!row || !row.act) {
                return;
            }
            if (row.act === 'create') {
                const name = mode === 'session' ? (quickPick.value.trim() || suggestedName) : (quickPick.value.trim() || undefined);
                const error = name !== undefined ? validate?.(name) : undefined;
                if (error) {
                    vscode.window.showWarningMessage(error);
                    return;
                }
                finish({ cwd: draft.cwd, command: draft.command, name, location: row.location });
            }
            else if (row.act === 'direction') {
                finish({ cwd: draft.cwd, command: draft.command, direction: row.direction });
            }
            else if (row.act === 'program' && row.resolved) {
                // Clicking a program only records it and keeps the highlight
                // there; the filled button opens its variants. Neither launches.
                selectProgram(row.resolved, effectivePick(draft, row.resolved));
                render(row.resolved.program.label);
            }
            else if (row.act === 'folder') {
                await suspend(async () => {
                    const cwd = await pickWorkingDirectory(draft.cwd);
                    if (cwd) {
                        draft.cwd = cwd;
                    }
                });
            }
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
async function runLaunchWizard(mode, extensionUri, suggestedName, validate) {
    const programs = await resolvePrograms();
    const draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        selectedProgram: programs[0]?.program.label ?? 'bash',
        overrides: new Map()
    };
    return showMainWindow(mode, draft, programs, extensionUri, suggestedName ?? '', validate);
}
//# sourceMappingURL=launchWizard.js.map