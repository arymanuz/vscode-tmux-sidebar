import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import { LaunchOptions, SplitDirection } from './tmuxService';

const exec = util.promisify(cp.exec);

export type LaunchMode = 'session' | 'window' | 'split';

export interface LaunchChoice extends LaunchOptions {
    name?: string;
    direction?: SplitDirection;
    location?: vscode.TerminalLocation;
}

// A program offered on the "what to run" step. `bins` are probed in order and
// the first one present is used, which is how Python resolves python3 before
// python. An empty command means "let tmux start its default shell".
interface Program {
    label: string;
    bins: string[];
    detail?: string;
    submenu?: (bin: string) => Promise<Picked | undefined>;
}

// A chosen command plus how to name it in the summary line.
interface Picked {
    command: string;
    label: string;
}

const ALT_SHELLS = ['zsh', 'fish', 'sh', 'nu', 'ksh', 'dash'];
const ALT_REPLS = ['node', 'ipython', 'irb', 'ghci', 'deno', 'bun'];

// Model aliases rather than versioned ids: an alias always resolves to the
// current model of that tier, so this list does not go stale. The free-text
// entry covers anything not listed.
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const GEMINI_MODELS = ['auto', 'pro', 'flash', 'flash-lite'];

const availability = new Map<string, boolean>();

async function isInstalled(bin: string): Promise<boolean> {
    const cached = availability.get(bin);
    if (cached !== undefined) {
        return cached;
    }

    const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    let found: boolean;
    try {
        await exec(probe);
        found = true;
    } catch {
        found = false;
    }
    availability.set(bin, found);
    return found;
}

async function firstInstalled(bins: string[]): Promise<string | undefined> {
    for (const bin of bins) {
        if (await isInstalled(bin)) {
            return bin;
        }
    }
    return undefined;
}

async function installedFrom(bins: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const bin of bins) {
        if (await isInstalled(bin)) {
            found.push(bin);
        }
    }
    return found;
}

// A flat list plus a free-text entry built from whatever the user types, which
// is how a model name that isn't listed still gets through.
function pickFlat(
    title: string,
    entries: (vscode.QuickPickItem & Picked)[],
    freeText?: (value: string) => Picked
): Promise<Picked | undefined> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & Partial<Picked>>();
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

function claudeMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Claude',
        [
            { label: 'Resume…', command: `${bin} --resume`, detail: 'Pick a previous conversation' },
            ...CLAUDE_MODELS.map(model => ({ label: model, command: `${bin} --model ${model}`, detail: `Latest ${model} model` }))
        ],
        value => ({ label: value, command: `${bin} --model ${value}` })
    );
}

function codexMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Codex',
        [{ label: 'Resume…', command: `${bin} resume`, detail: 'Pick a previous session' }],
        value => ({ label: value, command: `${bin} -m ${value}` })
    );
}

function geminiMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Gemini',
        [
            { label: 'Resume…', command: `${bin} --resume`, detail: 'Load a previous session' },
            ...GEMINI_MODELS.map(model => ({ label: model, command: `${bin} -m ${model}` }))
        ],
        value => ({ label: value, command: `${bin} -m ${value}` })
    );
}

function aiderMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Aider',
        [{ label: 'Restore chat history', command: `${bin} --restore-chat-history`, detail: 'Continue the last conversation' }],
        value => ({ label: value, command: `${bin} --model ${value}` })
    );
}

async function shellMenu(): Promise<Picked | undefined> {
    const shells = await installedFrom(ALT_SHELLS);
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
        return undefined;
    }
    return pickFlat('Shell', shells.map(shell => ({ label: shell, command: shell })));
}

async function replMenu(): Promise<Picked | undefined> {
    const repls = await installedFrom(ALT_REPLS);
    if (repls.length === 0) {
        vscode.window.showInformationMessage('No other REPLs found on this system.');
        return undefined;
    }
    return pickFlat('REPL', repls.map(repl => ({ label: repl, command: repl })));
}

const PROGRAMS: Program[] = [
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

interface ProgramItem extends vscode.QuickPickItem {
    program: Program;
    bin: string;
}

// Selecting an entry runs it with no arguments; the button on the right opens
// that entry's options instead, so the common case stays a single click.
async function pickProgram(): Promise<Picked | undefined> {
    const moreButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('ellipsis'),
        tooltip: 'More options'
    };

    const items: ProgramItem[] = [];
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
        const quickPick = vscode.window.createQuickPick<ProgramItem>();
        quickPick.title = 'Run';
        quickPick.placeholder = 'Select to run it directly, or use ⋯ for options';
        quickPick.items = items;

        let settled = false;
        const finish = (value: Picked | undefined) => {
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

        quickPick.onDidTriggerItemButton(async event => {
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

async function pickWorkingDirectory(current?: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const items: (vscode.QuickPickItem & { path?: string; action?: 'browse' | 'enter' })[] = [
        ...folders.map((folder, index) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            detail: index === 0 ? 'Project folder (default)' : undefined,
            path: folder.uri.fsPath
        })),
        { label: 'Browse…', detail: 'Pick a folder', action: 'browse' as const },
        { label: 'Enter path…', detail: 'Type a path', action: 'enter' as const }
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

async function pickLocation(): Promise<vscode.TerminalLocation | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            { label: 'Panel', detail: 'Bottom panel (default)', location: vscode.TerminalLocation.Panel },
            { label: 'Editor area', detail: 'As an editor tab', location: vscode.TerminalLocation.Editor }
        ],
        { title: 'Open the terminal in' }
    );
    return picked?.location;
}

// Everything that isn't the primary input, carried across re-shows of the one
// window and rendered into its summary line.
interface Draft {
    cwd?: string;
    command?: string;
    commandLabel: string;
    location: vscode.TerminalLocation;
}

const FOLDER_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Working directory' };
const RUN_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'What to run' };
const LOCATION_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('layout'), tooltip: 'Where to open the terminal' };

function summarise(draft: Draft, mode: LaunchMode): string {
    const folder = draft.cwd ? path.basename(draft.cwd) : 'default';
    const parts = [`Folder: ${folder}`, `Run: ${draft.commandLabel}`];
    if (mode !== 'split') {
        parts.push(`Terminal: ${draft.location === vscode.TerminalLocation.Editor ? 'Editor area' : 'Panel'}`);
    }
    return `${parts.join('   ·   ')}   ·   change with the buttons above`;
}

// Runs the sub-picker behind a title button. Returns false when the user backed
// out of it, so the caller knows nothing changed.
async function applyButton(button: vscode.QuickInputButton, draft: Draft, mode: LaunchMode): Promise<void> {
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

export type NameValidator = (value: string) => string | undefined;

type NameResult =
    | { type: 'accept'; value: string }
    | { type: 'button'; value: string; button: vscode.QuickInputButton }
    | { type: 'cancel' };

function showNameInput(mode: LaunchMode, value: string, draft: Draft, validate?: NameValidator): Promise<NameResult> {
    return new Promise(resolve => {
        const input = vscode.window.createInputBox();
        input.title = mode === 'session' ? 'New session' : 'New window';
        input.value = value;
        input.prompt = summarise(draft, mode);
        input.placeholder = mode === 'window' ? 'Window name (optional)' : 'Session name';
        input.buttons = mode === 'session' ? [FOLDER_BUTTON, RUN_BUTTON, LOCATION_BUTTON] : [FOLDER_BUTTON, RUN_BUTTON];
        input.validationMessage = validate?.(value);

        let settled = false;
        const finish = (result: NameResult) => {
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

const DIRECTIONS: { label: string; icon: string; direction: SplitDirection }[] = [
    { label: 'Right', icon: 'arrow-right', direction: 'right' },
    { label: 'Left', icon: 'arrow-left', direction: 'left' },
    { label: 'Down', icon: 'arrow-down', direction: 'down' },
    { label: 'Up', icon: 'arrow-up', direction: 'up' }
];

type DirectionResult =
    | { type: 'accept'; direction: SplitDirection }
    | { type: 'button'; button: vscode.QuickInputButton }
    | { type: 'cancel' };

function showDirectionPick(draft: Draft): Promise<DirectionResult> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { direction: SplitDirection }>();
        quickPick.title = 'Split pane';
        quickPick.placeholder = summarise(draft, 'split');
        quickPick.items = DIRECTIONS.map(entry => ({
            label: `$(${entry.icon}) ${entry.label}`,
            direction: entry.direction
        }));
        quickPick.buttons = [FOLDER_BUTTON, RUN_BUTTON];

        let settled = false;
        const finish = (result: DirectionResult) => {
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
export async function runLaunchWizard(
    mode: LaunchMode,
    defaultName?: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const draft: Draft = {
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
