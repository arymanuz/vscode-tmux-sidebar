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

// A chosen command plus how to show it on its row.
interface Picked {
    label: string;
    description?: string;
    command: string;
}

// A program offered in the Run section. `bins` are probed in order and the
// first one present is used, which is how Python resolves python3 before
// python. `submenu`, when present, lists variants behind the row's button; its
// first entry reverts to the plain program.
interface Program {
    label: string;
    bins: string[];
    submenu?: (bin: string) => Promise<Picked | undefined>;
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
    freeText?: { placeholder: string; build: (value: string) => Picked }
): Promise<Picked | undefined> {
    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & Partial<Picked>>();
        quickPick.title = title;
        quickPick.items = entries;
        if (freeText) {
            quickPick.placeholder = freeText.placeholder;
            quickPick.onDidChangeValue(value => {
                const typed = value.trim();
                quickPick.items = typed
                    ? [...entries, { ...freeText.build(typed), alwaysShow: true }]
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

const MODEL_HINT = 'Type a model name and press Enter, or pick one below';

function claudeMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Claude',
        [
            { label: 'Claude', description: 'default', command: bin },
            { label: 'Claude Resume', description: 'previous conversation', command: `${bin} --resume` },
            ...CLAUDE_MODELS.map(model => ({ label: `Claude ${model}`, description: 'model', command: `${bin} --model ${model}` }))
        ],
        { placeholder: MODEL_HINT, build: value => ({ label: `Claude ${value}`, description: 'model', command: `${bin} --model ${value}` }) }
    );
}

function codexMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Codex',
        [
            { label: 'Codex', description: 'default', command: bin },
            { label: 'Codex Resume', description: 'previous session', command: `${bin} resume` }
        ],
        { placeholder: MODEL_HINT, build: value => ({ label: `Codex ${value}`, description: 'model', command: `${bin} -m ${value}` }) }
    );
}

function geminiMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Gemini',
        [
            { label: 'Gemini', description: 'default', command: bin },
            { label: 'Gemini Resume', description: 'previous session', command: `${bin} --resume` },
            ...GEMINI_MODELS.map(model => ({ label: `Gemini ${model}`, description: 'model', command: `${bin} -m ${model}` }))
        ],
        { placeholder: MODEL_HINT, build: value => ({ label: `Gemini ${value}`, description: 'model', command: `${bin} -m ${value}` }) }
    );
}

function aiderMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Aider',
        [
            { label: 'Aider', description: 'default', command: bin },
            { label: 'Aider Restore', description: 'restore chat history', command: `${bin} --restore-chat-history` }
        ],
        { placeholder: MODEL_HINT, build: value => ({ label: `Aider ${value}`, description: 'model', command: `${bin} --model ${value}` }) }
    );
}

async function shellMenu(): Promise<Picked | undefined> {
    const shells = await installedFrom(ALT_SHELLS);
    // The first entry reverts to the session's default shell (empty command).
    const entries: (vscode.QuickPickItem & Picked)[] = [{ label: 'Shell', description: 'default', command: '' }];
    for (const shell of shells) {
        entries.push({ label: shell, command: shell });
    }
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
    }
    return pickFlat('Shell', entries);
}

function replMenu(bin: string): () => Promise<Picked | undefined> {
    return async () => {
        const repls = await installedFrom(ALT_REPLS);
        const entries: (vscode.QuickPickItem & Picked)[] = [{ label: 'Python', description: 'default', command: bin }];
        for (const repl of repls) {
            entries.push({ label: repl, command: repl });
        }
        if (repls.length === 0) {
            vscode.window.showInformationMessage('No other REPLs found on this system.');
        }
        return pickFlat('REPL', entries);
    };
}

const PROGRAMS: Program[] = [
    { label: 'Shell', bins: ['bash'], submenu: () => shellMenu() },
    { label: 'Python', bins: ['python3', 'python'], submenu: bin => replMenu(bin)() },
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

// The plain form of a program, used as the row label until a submenu variant
// replaces it. Shell's base command is empty so tmux starts the default shell.
function basePick(resolved: ResolvedProgram): Picked {
    return { label: resolved.program.label, command: resolved.program.label === 'Shell' ? '' : resolved.bin };
}

/**
 * Path entry and the project folders in one window: the text box holds the
 * path, and each root is one click. A Browse button on the title bar opens the
 * native folder dialog. Typing a path that isn't a root surfaces a confirm row
 * at the top so Enter uses what was typed.
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
            rows.push({ label: '$(check) Use this path', description: value, path: value, alwaysShow: true });
        }
        if (roots.length > 0) {
            rows.push(heading, ...roots);
        }
        return rows;
    };

    const browseButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('folder-opened'),
        tooltip: 'Browse…'
    };

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { path?: string }>();
        quickPick.title = 'Working directory';
        quickPick.placeholder = 'Type a path, pick a project folder, or Browse…';
        quickPick.buttons = [browseButton];
        quickPick.value = current ?? '';
        quickPick.items = build(quickPick.value);

        quickPick.onDidChangeValue(value => {
            quickPick.items = build(value);
        });

        let settled = false;
        const finish = (value: string | undefined) => {
            settled = true;
            resolve(value);
            quickPick.hide();
        };

        quickPick.onDidTriggerButton(async () => {
            const chosen = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: current ? vscode.Uri.file(current) : undefined,
                openLabel: 'Use this folder'
            });
            if (chosen?.[0]) {
                finish(chosen[0].fsPath);
            }
        });

        quickPick.onDidAccept(() => {
            const item = quickPick.activeItems[0];
            finish(item?.path ?? (quickPick.value.trim() || undefined));
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
    selectedProgram: string;
    // A program keeps its last submenu variant, so its row still reads e.g.
    // "Claude Resume" after the selection moves elsewhere and back.
    overrides: Map<string, Picked>;
}

const DIRECTIONS: { label: string; direction: SplitDirection; icon: string }[] = [
    { label: 'Split right', direction: 'right', icon: 'right' },
    { label: 'Split left', direction: 'left', icon: 'left' },
    { label: 'Split down', direction: 'down', icon: 'down' },
    { label: 'Split up', direction: 'up', icon: 'up' }
];

type RowAction = 'create' | 'direction' | 'folder' | 'program';

interface Row extends vscode.QuickPickItem {
    act?: RowAction;
    location?: vscode.TerminalLocation;
    direction?: SplitDirection;
    resolved?: ResolvedProgram;
    invalid?: boolean;
}

// A chevron reads as "opens more" far better than a dim ellipsis did.
const MORE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('chevron-right'),
    tooltip: 'More options'
};

function separator(label: string): Row {
    return { label, kind: vscode.QuickPickItemKind.Separator };
}

function effectivePick(draft: Draft, resolved: ResolvedProgram): Picked {
    return draft.overrides.get(resolved.program.label) ?? basePick(resolved);
}

// Reads top to bottom the way the task does: name, folder, what to run, then
// the action. Every row sets alwaysShow so typing a name never filters the
// list out of view.
function buildRows(
    mode: LaunchMode,
    draft: Draft,
    programs: ResolvedProgram[],
    typed: string,
    preferred: vscode.TerminalLocation,
    splitIcon: (dir: string) => vscode.IconPath,
    validate?: NameValidator
): Row[] {
    const rows: Row[] = [];

    rows.push(separator('Folder'));
    rows.push({
        act: 'folder',
        label: `$(folder-opened) ${draft.cwd ? path.basename(draft.cwd) : 'Default'}`,
        description: draft.cwd,
        alwaysShow: true
    });

    rows.push(separator('Run'));
    for (const resolved of programs) {
        const pick = effectivePick(draft, resolved);
        const selected = resolved.program.label === draft.selectedProgram;
        rows.push({
            act: 'program',
            resolved,
            label: `$(${selected ? 'circle-filled' : 'circle-outline'}) ${pick.label}`,
            description: pick.description ?? (pick.label.toLowerCase() === resolved.bin ? undefined : resolved.bin),
            buttons: resolved.program.submenu ? [MORE_BUTTON] : undefined,
            alwaysShow: true
        });
    }

    if (mode === 'split') {
        rows.push(separator('Create'));
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

    const error = validate?.(typed);
    rows.push(separator('Create'));
    if (error) {
        rows.push({ label: `$(error) ${error}`, invalid: true, alwaysShow: true });
        return rows;
    }

    if (mode === 'window') {
        // A window belongs to a session already attached somewhere, so there
        // is no terminal placement to choose.
        rows.push({ act: 'create', label: '$(add) Create window', alwaysShow: true });
        return rows;
    }

    const isDefault = (location: vscode.TerminalLocation) => (location === preferred ? 'default' : undefined);
    rows.push({
        act: 'create',
        location: vscode.TerminalLocation.Panel,
        label: '$(layout-panel) Create in panel',
        description: isDefault(vscode.TerminalLocation.Panel),
        alwaysShow: true
    });
    rows.push({
        act: 'create',
        location: vscode.TerminalLocation.Editor,
        label: '$(window) Create in editor area',
        description: isDefault(vscode.TerminalLocation.Editor),
        alwaysShow: true
    });
    return rows;
}

/**
 * One window holding every choice. The text box is the name field; folder and
 * program rows change a setting and keep the window open; the rows under Create
 * (or Split) are the actions. Selecting a program only records it and returns
 * the highlight to the default action, so Enter after typing a name always
 * creates.
 */
function showMainWindow(
    mode: LaunchMode,
    draft: Draft,
    programs: ResolvedProgram[],
    extensionUri: vscode.Uri,
    initialValue: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const preferred = defaultTerminalLocation();
    const splitIcon = (dir: string): vscode.IconPath => ({
        light: vscode.Uri.joinPath(extensionUri, 'resources', 'split', `${dir}-light.svg`),
        dark: vscode.Uri.joinPath(extensionUri, 'resources', 'split', `${dir}-dark.svg`)
    });

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<Row>();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? 'Session name' : mode === 'window' ? 'Window name (optional)' : 'Pick where the new pane goes';
        quickPick.value = initialValue;

        // The row Enter should trigger: the preferred create location, the lone
        // create row, or the first direction. Never a program row, so recording
        // a program never steals Enter from creating.
        const defaultRow = (rows: Row[]): Row | undefined =>
            rows.find(row => row.act === 'create' && (row.location === undefined || row.location === preferred)) ??
            rows.find(row => row.act === 'create' || row.act === 'direction');

        const render = () => {
            const rows = buildRows(mode, draft, programs, quickPick.value, preferred, splitIcon, validate);
            quickPick.items = rows;
            const active = defaultRow(rows);
            if (active) {
                quickPick.activeItems = [active];
            }
        };

        let suspended = false;
        let settled = false;
        const finish = (choice: LaunchChoice | undefined) => {
            settled = true;
            resolve(choice);
            quickPick.hide();
        };

        // Run a sub-picker with this window hidden, then bring it back. QuickPick
        // is a single overlay, so the sub-picker replaces rather than stacks.
        const suspend = async (action: () => Promise<void>) => {
            suspended = true;
            quickPick.hide();
            await action();
            suspended = false;
            render();
            quickPick.show();
        };

        const selectProgram = (resolved: ResolvedProgram, pick: Picked) => {
            draft.selectedProgram = resolved.program.label;
            draft.command = pick.command || undefined;
            draft.commandLabel = pick.label;
        };

        quickPick.onDidChangeValue(() => render());

        quickPick.onDidAccept(async () => {
            const row = quickPick.activeItems[0];
            if (!row || row.invalid || !row.act) {
                return;
            }
            if (row.act === 'create') {
                finish({ cwd: draft.cwd, command: draft.command, name: quickPick.value.trim() || undefined, location: row.location });
            } else if (row.act === 'direction') {
                finish({ cwd: draft.cwd, command: draft.command, direction: row.direction });
            } else if (row.act === 'program' && row.resolved) {
                // Selecting a program only records it; Enter returns to the
                // default action so it never launches on the spot.
                selectProgram(row.resolved, effectivePick(draft, row.resolved));
                render();
            } else if (row.act === 'folder') {
                await suspend(async () => {
                    const cwd = await pickWorkingDirectory(draft.cwd);
                    if (cwd) {
                        draft.cwd = cwd;
                    }
                });
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
                    draft.overrides.set(resolved.program.label, picked);
                    selectProgram(resolved, picked);
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
    extensionUri: vscode.Uri,
    defaultName?: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const programs = await resolvePrograms();
    const draft: Draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        commandLabel: 'Shell',
        selectedProgram: 'Shell',
        overrides: new Map()
    };
    return showMainWindow(mode, draft, programs, extensionUri, defaultName ?? '', validate);
}
