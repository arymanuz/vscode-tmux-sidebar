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

// A program offered in the Run section. `bins` are probed in order and the
// first one present is used, which is how Python resolves python3 before
// python. An empty command means "let tmux start its default shell".
interface Program {
    label: string;
    bins: string[];
    submenu?: (bin: string) => Promise<Picked | undefined>;
}

// A chosen command plus how to name it in the list.
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

// A program that is actually present, with the binary that satisfied it.
interface ResolvedProgram {
    program: Program;
    bin: string;
}

async function resolvePrograms(): Promise<ResolvedProgram[]> {
    const resolved: ResolvedProgram[] = [];
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
function pickWorkingDirectory(current?: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots: (vscode.QuickPickItem & { path?: string })[] = folders.map((folder, index) => ({
        label: `$(folder) ${folder.name}`,
        description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
        path: folder.uri.fsPath,
        alwaysShow: true
    }));
    const heading: vscode.QuickPickItem = {
        label: 'Project folders',
        kind: vscode.QuickPickItemKind.Separator
    };

    const build = (typed: string): (vscode.QuickPickItem & { path?: string })[] => {
        const value = typed.trim();
        const matchesRoot = folders.some(folder => folder.uri.fsPath === value);
        const rows: (vscode.QuickPickItem & { path?: string })[] = [];
        if (value && !matchesRoot) {
            rows.push({ label: `$(check) Use this path`, description: value, path: value, alwaysShow: true });
        }
        if (roots.length > 0) {
            rows.push(heading, ...roots);
        }
        return rows;
    };

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { path?: string }>();
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
function defaultTerminalLocation(): vscode.TerminalLocation {
    const configured = vscode.workspace.getConfiguration('terminal.integrated').get<string>('defaultLocation');
    return configured === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
}

interface Draft {
    cwd?: string;
    command?: string;
    commandLabel: string;
}

// Each direction shows where the new pane lands: a strip on the matching edge
// of the layout, rather than an arrow that only says which way.
const DIRECTIONS: { label: string; icon: string; direction: SplitDirection }[] = [
    { label: 'Split right', icon: 'layout-sidebar-right', direction: 'right' },
    { label: 'Split left', icon: 'layout-sidebar-left', direction: 'left' },
    { label: 'Split down', icon: 'layout-statusbar', direction: 'down' },
    { label: 'Split up', icon: 'layout-menubar', direction: 'up' }
];

type RowAction = 'create' | 'direction' | 'folder' | 'program';

interface Row extends vscode.QuickPickItem {
    action?: RowAction;
    location?: vscode.TerminalLocation;
    direction?: SplitDirection;
    resolved?: ResolvedProgram;
    invalid?: boolean;
}

const MORE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('ellipsis'),
    tooltip: 'More options'
};

function separator(label: string): Row {
    return { label, kind: vscode.QuickPickItemKind.Separator };
}

// Reads top to bottom the way the task does: name, folder, what to run, then
// the action. Every row sets alwaysShow so typing a name never filters the
// list out of view.
function buildRows(mode: LaunchMode, draft: Draft, programs: ResolvedProgram[], typed: string, validate?: NameValidator): Row[] {
    const rows: Row[] = [];

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
function showMainWindow(
    mode: LaunchMode,
    draft: Draft,
    programs: ResolvedProgram[],
    initialValue: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<Row>();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? 'Session name' : mode === 'window' ? 'Window name (optional)' : 'Pick where the new pane goes';
        quickPick.value = initialValue;

        const preferred = defaultTerminalLocation();
        // Enter should do the expected thing straight after typing a name, so
        // preselect the action matching VS Code's own terminal location.
        const defaultRow = (rows: Row[]): Row | undefined =>
            rows.find(row => row.action === 'create' && (row.location === undefined || row.location === preferred)) ??
            rows.find(row => row.action === 'direction' || row.action === 'create');

        const render = (keep?: (row: Row) => boolean) => {
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
        const finish = (choice: LaunchChoice | undefined) => {
            settled = true;
            resolve(choice);
            quickPick.hide();
        };

        const suspend = async (action: () => Promise<void>, keep?: (row: Row) => boolean) => {
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

        quickPick.onDidTriggerItemButton(async event => {
            const resolved = event.item.resolved;
            if (!resolved?.program.submenu) {
                return;
            }
            await suspend(async () => {
                const picked = await resolved.program.submenu!(resolved.bin);
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

export async function runLaunchWizard(
    mode: LaunchMode,
    defaultName?: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const programs = await resolvePrograms();
    const draft: Draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        commandLabel: 'Shell'
    };
    return showMainWindow(mode, draft, programs, defaultName ?? '', validate);
}
