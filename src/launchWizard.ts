import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';
import { LaunchOptions, SplitDirection } from './tmuxService';

const exec = util.promisify(cp.exec);

export type LaunchMode = 'session' | 'window' | 'split';
export type NameValidator = (value: string) => string | undefined;

export interface LaunchChoice extends LaunchOptions {
    name?: string;
    direction?: SplitDirection;
    location?: vscode.TerminalLocation;
}

// A program offered on the "run" row. `bins` are probed in order and the first
// one present is used, which is how Python resolves python3 before python. An
// empty command means "let tmux start its default shell".
interface Program {
    label: string;
    bins: string[];
    submenu?: (bin: string) => Promise<Picked | undefined>;
}

// A chosen command plus how to name it on the run row.
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

function claudeMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Claude',
        [
            { label: 'Resume…', description: 'previous conversation', command: `${bin} --resume` },
            ...CLAUDE_MODELS.map(model => ({ label: model, command: `${bin} --model ${model}` }))
        ],
        value => ({ label: value, command: `${bin} --model ${value}` })
    );
}

function codexMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Codex',
        [{ label: 'Resume…', description: 'previous session', command: `${bin} resume` }],
        value => ({ label: value, command: `${bin} -m ${value}` })
    );
}

function geminiMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Gemini',
        [
            { label: 'Resume…', description: 'previous session', command: `${bin} --resume` },
            ...GEMINI_MODELS.map(model => ({ label: model, command: `${bin} -m ${model}` }))
        ],
        value => ({ label: value, command: `${bin} -m ${value}` })
    );
}

function aiderMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Aider',
        [{ label: 'Restore chat history', command: `${bin} --restore-chat-history` }],
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

interface ProgramItem extends vscode.QuickPickItem {
    program: Program;
    bin: string;
}

// Selecting an entry runs it with no arguments; the button on the right opens
// that entry's options instead, so the common case stays a single click. Every
// row is one line: the resolved binary goes in `description`, which renders
// beside the label rather than under it.
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
            description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
            path: folder.uri.fsPath
        })),
        { label: 'Browse…', action: 'browse' as const },
        { label: 'Enter path…', action: 'enter' as const }
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
            { label: 'Panel', description: 'bottom panel — default', location: vscode.TerminalLocation.Panel },
            { label: 'Editor area', description: 'as an editor tab', location: vscode.TerminalLocation.Editor }
        ],
        { title: 'Open the terminal in' }
    );
    return picked?.location;
}

// Everything the main window carries between re-shows.
interface Draft {
    cwd?: string;
    command?: string;
    commandLabel: string;
    location: vscode.TerminalLocation;
}

const DIRECTIONS: { label: string; icon: string; direction: SplitDirection }[] = [
    { label: 'Split Right', icon: 'arrow-right', direction: 'right' },
    { label: 'Split Left', icon: 'arrow-left', direction: 'left' },
    { label: 'Split Down', icon: 'arrow-down', direction: 'down' },
    { label: 'Split Up', icon: 'arrow-up', direction: 'up' }
];

type RowAction = 'create' | 'direction' | 'folder' | 'run' | 'location';

interface Row extends vscode.QuickPickItem {
    action: RowAction;
    direction?: SplitDirection;
    invalid?: boolean;
}

function locationLabel(location: vscode.TerminalLocation): string {
    return location === vscode.TerminalLocation.Editor ? 'Editor area' : 'Panel';
}

// Every row sets alwaysShow so typing a name never filters the settings out of
// view — the text box acts as the name field while the settings stay listed.
function buildRows(mode: LaunchMode, draft: Draft, typed: string, validate?: NameValidator): Row[] {
    const rows: Row[] = [];

    if (mode === 'split') {
        for (const entry of DIRECTIONS) {
            rows.push({
                action: 'direction',
                direction: entry.direction,
                label: `$(${entry.icon}) ${entry.label}`,
                alwaysShow: true
            });
        }
    } else {
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

type MainResult =
    | { type: 'create'; value: string }
    | { type: 'direction'; direction: SplitDirection }
    | { type: 'edit'; action: RowAction; value: string }
    | { type: 'cancel' };

function showMainWindow(mode: LaunchMode, draft: Draft, value: string, validate?: NameValidator): Promise<MainResult> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<Row>();
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
        const finish = (result: MainResult) => {
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
            } else if (row.action === 'direction' && row.direction) {
                finish({ type: 'direction', direction: row.direction });
            } else {
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

async function applyEdit(action: RowAction, draft: Draft): Promise<void> {
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
