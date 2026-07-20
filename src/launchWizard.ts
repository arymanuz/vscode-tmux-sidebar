import * as vscode from 'vscode';
import * as cp from 'child_process';
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
// python. An empty `command` means "let tmux start its default shell".
interface Program {
    label: string;
    bins: string[];
    detail?: string;
    submenu?: (bin: string) => Promise<string | undefined>;
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
// is how a model name that isn't listed still gets through. Returns the chosen
// command, or undefined when dismissed.
function pickFlat(
    title: string,
    entries: { label: string; command: string; detail?: string }[],
    freeText?: { label: (value: string) => string; command: (value: string) => string }
): Promise<string | undefined> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { command?: string }>();
        quickPick.title = title;
        quickPick.items = entries;
        if (freeText) {
            quickPick.placeholder = 'Pick one, or type a value and press Enter';
            quickPick.onDidChangeValue(value => {
                const typed = value.trim();
                quickPick.items = typed
                    ? [...entries, { label: freeText.label(typed), command: freeText.command(typed) }]
                    : entries;
            });
        }

        let settled = false;
        quickPick.onDidAccept(() => {
            settled = true;
            resolve(quickPick.selectedItems[0]?.command);
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

function claudeMenu(bin: string): Promise<string | undefined> {
    return pickFlat(
        'Claude',
        [
            { label: 'Resume…', command: `${bin} --resume`, detail: 'Pick a previous conversation' },
            ...CLAUDE_MODELS.map(model => ({ label: model, command: `${bin} --model ${model}`, detail: `Latest ${model} model` }))
        ],
        { label: value => `Model: ${value}`, command: value => `${bin} --model ${value}` }
    );
}

function codexMenu(bin: string): Promise<string | undefined> {
    return pickFlat(
        'Codex',
        [{ label: 'Resume…', command: `${bin} resume`, detail: 'Pick a previous session' }],
        { label: value => `Model: ${value}`, command: value => `${bin} -m ${value}` }
    );
}

function geminiMenu(bin: string): Promise<string | undefined> {
    return pickFlat(
        'Gemini',
        [
            { label: 'Resume…', command: `${bin} --resume`, detail: 'Load a previous session' },
            ...GEMINI_MODELS.map(model => ({ label: model, command: `${bin} -m ${model}` }))
        ],
        { label: value => `Model: ${value}`, command: value => `${bin} -m ${value}` }
    );
}

function aiderMenu(bin: string): Promise<string | undefined> {
    return pickFlat(
        'Aider',
        [{ label: 'Restore chat history', command: `${bin} --restore-chat-history`, detail: 'Continue the last conversation' }],
        { label: value => `Model: ${value}`, command: value => `${bin} --model ${value}` }
    );
}

async function shellMenu(): Promise<string | undefined> {
    const shells = await installedFrom(ALT_SHELLS);
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
        return undefined;
    }
    return pickFlat('Shell', shells.map(shell => ({ label: shell, command: shell })));
}

async function replMenu(): Promise<string | undefined> {
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
async function pickProgram(): Promise<string | undefined> {
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
        quickPick.title = 'Run in the new pane';
        quickPick.placeholder = 'Select to run it directly, or use ⋯ for options';
        quickPick.items = items;

        let settled = false;
        const finish = (value: string | undefined) => {
            settled = true;
            resolve(value);
            quickPick.hide();
        };

        quickPick.onDidAccept(() => {
            const item = quickPick.selectedItems[0];
            // "Shell" carries no command: tmux then starts its default shell.
            finish(item ? (item.program.label === 'Shell' ? '' : item.bin) : undefined);
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

async function pickWorkingDirectory(): Promise<string | undefined> {
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
        value: folders[0]?.uri.fsPath,
        prompt: 'Path the new pane should start in'
    });
}

const DIRECTIONS: { label: string; icon: string; direction: SplitDirection }[] = [
    { label: 'Split Right', icon: 'arrow-right', direction: 'right' },
    { label: 'Split Left', icon: 'arrow-left', direction: 'left' },
    { label: 'Split Down', icon: 'arrow-down', direction: 'down' },
    { label: 'Split Up', icon: 'arrow-up', direction: 'up' }
];

async function pickDirection(): Promise<SplitDirection | undefined> {
    const picked = await vscode.window.showQuickPick(
        DIRECTIONS.map(entry => ({
            label: `$(${entry.icon}) ${entry.label}`,
            direction: entry.direction
        })),
        { title: 'Create' }
    );
    return picked?.direction;
}

async function pickLocation(): Promise<vscode.TerminalLocation | undefined | null> {
    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(add) Create', detail: 'In the panel (default)', location: vscode.TerminalLocation.Panel },
            { label: '$(split-horizontal) Create in editor area', location: vscode.TerminalLocation.Editor }
        ],
        { title: 'Create' }
    );
    return picked ? picked.location : null;
}

/**
 * Walks the shared creation flow. Steps that don't apply to the mode are
 * skipped: a split has no name, and only a split picks a direction. Returns
 * undefined if the user dismisses any step.
 */
export async function runLaunchWizard(mode: LaunchMode, defaultName?: string): Promise<LaunchChoice | undefined> {
    const choice: LaunchChoice = {};

    if (mode !== 'split') {
        const name = await vscode.window.showInputBox({
            title: mode === 'session' ? 'New session' : 'New window',
            prompt: mode === 'session' ? 'Session name' : 'Window name (leave empty for the default)',
            value: defaultName
        });
        if (name === undefined) {
            return undefined;
        }
        choice.name = name.trim() || undefined;
    }

    const cwd = await pickWorkingDirectory();
    if (cwd === undefined) {
        return undefined;
    }
    choice.cwd = cwd;

    const command = await pickProgram();
    if (command === undefined) {
        return undefined;
    }
    choice.command = command || undefined;

    if (mode === 'split') {
        const direction = await pickDirection();
        if (!direction) {
            return undefined;
        }
        choice.direction = direction;
    } else {
        const location = await pickLocation();
        if (location === null) {
            return undefined;
        }
        choice.location = location;
    }

    return choice;
}
