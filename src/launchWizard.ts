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

// A chosen command and the label it shows — which is the command string itself,
// so the main list and the submenus read the same.
interface Picked {
    label: string;
    command: string;
}

// A program offered in the Run section. `bins` are probed in order and the
// first present one is used, which is how Python resolves python3 before
// python. `submenu`, when present, lists variants; its first entry reverts to
// the plain program.
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

// Every entry's label is its command, so nothing needs a secondary hint. A
// free-text entry lets a model name that isn't listed still get through.
function pickFlat(title: string, commands: string[], freeText?: string): Promise<Picked | undefined> {
    const toItem = (command: string): vscode.QuickPickItem & Picked => ({ label: command, command });
    const entries = commands.map(toItem);

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & Partial<Picked>>();
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

function claudeMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat(
        'Claude',
        [bin, `${bin} --resume`, `${bin} --resume --fork-session`, ...CLAUDE_MODELS.map(m => `${bin} --model ${m}`)],
        bin
    );
}

function codexMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat('Codex', [bin, `${bin} resume`], `${bin} -m`);
}

function geminiMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat('Gemini', [bin, `${bin} --resume`, ...GEMINI_MODELS.map(m => `${bin} -m ${m}`)], `${bin} -m`);
}

function aiderMenu(bin: string): Promise<Picked | undefined> {
    return pickFlat('Aider', [bin, `${bin} --restore-chat-history`], `${bin} --model`);
}

async function shellMenu(bin: string): Promise<Picked | undefined> {
    const shells = await installedFrom(ALT_SHELLS);
    if (shells.length === 0) {
        vscode.window.showInformationMessage('No other shells found on this system.');
    }
    return pickFlat('Shell', [bin, ...shells]);
}

async function replMenu(bin: string): Promise<Picked | undefined> {
    const repls = await installedFrom(ALT_REPLS);
    if (repls.length === 0) {
        vscode.window.showInformationMessage('No other REPLs found on this system.');
    }
    return pickFlat('REPL', [bin, ...repls]);
}

const PROGRAMS: Program[] = [
    { label: 'bash', bins: ['bash'], submenu: shellMenu },
    { label: 'python3', bins: ['python3', 'python'], submenu: replMenu },
    { label: 'claude', bins: ['claude'], submenu: claudeMenu },
    { label: 'codex', bins: ['codex'], submenu: codexMenu },
    { label: 'gemini', bins: ['gemini', 'agy'], submenu: geminiMenu },
    { label: 'aider', bins: ['aider'], submenu: aiderMenu },
    { label: 'opencode', bins: ['opencode'] },
    { label: 'goose', bins: ['goose'] },
    { label: 'crush', bins: ['crush'] },
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

// The plain form of a program: its own binary as the command. bash keeps an
// empty command so tmux starts the session's default shell.
function basePick(resolved: ResolvedProgram): Picked {
    const command = resolved.program.label === 'bash' ? '' : resolved.bin;
    return { label: resolved.bin, command };
}

/**
 * Path entry and the project folders in one window: the text box holds the
 * path, each root is one click, and a Browse button on the title bar opens the
 * native folder dialog. `ignoreFocusOut` keeps this window alive while that
 * dialog has focus.
 */
function pickWorkingDirectory(current?: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots: (vscode.QuickPickItem & { path?: string })[] = folders.map((folder, index) => ({
        label: `$(folder) ${folder.name}`,
        description: index === 0 ? `${folder.uri.fsPath} — default` : folder.uri.fsPath,
        path: folder.uri.fsPath,
        alwaysShow: true
    }));
    const heading: vscode.QuickPickItem = { label: 'Project folders', kind: vscode.QuickPickItemKind.Separator };

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

    const browseButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Browse…' };

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { path?: string }>();
        quickPick.title = 'Working directory';
        quickPick.placeholder = 'Type a path, pick a project folder, or Browse…';
        quickPick.buttons = [browseButton];
        quickPick.ignoreFocusOut = true;
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
                finish(chosen[0].fsPath); // dismissing the dialog just leaves this window open
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
// rather than assuming the panel. Only used to order the two create rows.
function defaultTerminalLocation(): vscode.TerminalLocation {
    const configured = vscode.workspace.getConfiguration('terminal.integrated').get<string>('defaultLocation');
    return configured === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel;
}

interface Draft {
    cwd?: string;
    command?: string;
    selectedProgram: string;
    // A program remembers its last submenu variant, so its row still reads e.g.
    // "claude --resume" after the selection moves elsewhere and back.
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
}

function effectivePick(draft: Draft, resolved: ResolvedProgram): Picked {
    return draft.overrides.get(resolved.program.label) ?? basePick(resolved);
}

// A flat list — no separators, since a quick pick hides them the moment the
// name field has text, which it usually does. The leading icon on every row
// carries the grouping instead: green circles mark the programs. Every real row
// sets alwaysShow so typing a name never filters the list out of view.
function buildRows(
    mode: LaunchMode,
    draft: Draft,
    programs: ResolvedProgram[],
    preferred: vscode.TerminalLocation,
    splitIcon: (dir: string) => vscode.IconPath,
    dotIcon: (selected: boolean) => vscode.IconPath
): Row[] {
    const rows: Row[] = [];

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
            // Programs with variants open their list on click, so signal it —
            // per-row buttons only show on hover, which is easy to miss.
            description: resolved.program.submenu ? '›' : undefined,
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
    const tag = (location: vscode.TerminalLocation) => (location === preferred ? 'default' : undefined);
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
function showMainWindow(
    mode: LaunchMode,
    draft: Draft,
    programs: ResolvedProgram[],
    extensionUri: vscode.Uri,
    suggestedName: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const preferred = defaultTerminalLocation();
    const themedIcon = (dir: string, name: string): vscode.IconPath => ({
        light: vscode.Uri.joinPath(extensionUri, 'resources', dir, `${name}-light.svg`),
        dark: vscode.Uri.joinPath(extensionUri, 'resources', dir, `${name}-dark.svg`)
    });
    const splitIcon = (d: string): vscode.IconPath => themedIcon('split', d);
    const dotIcon = (selected: boolean): vscode.IconPath => themedIcon('dot', selected ? 'filled' : 'outline');

    return new Promise(resolve => {
        const quickPick = vscode.window.createQuickPick<Row>();
        quickPick.title = mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane';
        quickPick.placeholder =
            mode === 'session' ? `Session name (default: ${suggestedName})`
                : mode === 'window' ? 'Window name (optional)'
                    : 'Pick where the new pane goes';

        const selectedRow = (rows: Row[]): Row | undefined =>
            rows.find(row => row.act === 'program' && row.resolved?.program.label === draft.selectedProgram);

        const render = () => {
            const rows = buildRows(mode, draft, programs, preferred, splitIcon, dotIcon);
            quickPick.items = rows;
            const active = selectedRow(rows);
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
        // is a single overlay, so the sub-picker replaces rather than stacks —
        // the API offers no way to layer one over another.
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
        };

        const openOptions = async (resolved: ResolvedProgram) => {
            if (!resolved.program.submenu) {
                vscode.window.showInformationMessage(`${resolved.bin} has no extra options.`);
                return;
            }
            await suspend(async () => {
                const picked = await resolved.program.submenu!(resolved.bin);
                if (picked) {
                    draft.overrides.set(resolved.program.label, picked);
                    selectProgram(resolved, picked);
                }
            });
        };

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
            } else if (row.act === 'direction') {
                finish({ cwd: draft.cwd, command: draft.command, direction: row.direction });
            } else if (row.act === 'program' && row.resolved) {
                // A program with variants opens its own list on click — this is
                // the per-command options, always reachable, no hover needed. One
                // without variants is simply recorded. Neither launches.
                if (row.resolved.program.submenu) {
                    await openOptions(row.resolved);
                } else {
                    selectProgram(row.resolved, effectivePick(draft, row.resolved));
                    render();
                }
            } else if (row.act === 'folder') {
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

export async function runLaunchWizard(
    mode: LaunchMode,
    extensionUri: vscode.Uri,
    suggestedName?: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const programs = await resolvePrograms();
    const draft: Draft = {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        command: undefined,
        selectedProgram: programs[0]?.program.label ?? 'bash',
        overrides: new Map()
    };
    return showMainWindow(mode, draft, programs, extensionUri, suggestedName ?? '', validate);
}
