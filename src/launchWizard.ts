import * as vscode from 'vscode';
import * as cp from 'child_process';
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

// --- Program discovery -----------------------------------------------------

interface Variant {
    label: string;   // shown on the row — the command itself
    command: string; // '' means "let tmux start the default shell"
}

interface ProgramData {
    label: string;
    command: string;             // plain command run when the program is picked
    variants: Variant[] | null;  // shown inline under the selection
    custom: { prefix: string; hint: string } | null; // a typed value (model name)
}

const ALT_SHELLS = ['zsh', 'fish', 'sh', 'nu', 'ksh', 'dash'];
const ALT_REPLS = ['node', 'ipython', 'irb', 'ghci', 'deno', 'bun'];
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

// Every binary the form can offer. Probing these one at a time meant ~25
// sequential process spawns, which is what made the first open slow.
const PROGRAM_BINS = ['bash', 'python3', 'python', 'claude', 'codex', 'gemini', 'agy', 'aider', 'opencode', 'goose', 'crush', 'lazygit', 'tig', 'gitui'];
const ALL_BINS = [...PROGRAM_BINS, ...ALT_SHELLS, ...ALT_REPLS];

/**
 * Resolve every binary at once. On Unix that is a single shell that reports
 * which ones exist, rather than one process per binary; Windows has no cheap
 * equivalent, so the individual checks run concurrently there. Results are
 * cached, so this costs nothing after the first call.
 */
async function probeAll(): Promise<void> {
    const missing = ALL_BINS.filter(bin => !availability.has(bin));
    if (missing.length === 0) {
        return;
    }

    const individually = async () => {
        await Promise.all(missing.map(async bin => {
            availability.set(bin, await isInstalled(bin));
        }));
    };

    if (process.platform === 'win32') {
        await individually();
        return;
    }

    // The names come from the constants above, so nothing user-supplied is
    // interpolated. The trailing `true` keeps a missing last entry from making
    // the whole script exit non-zero.
    const script = `${missing.map(bin => `command -v ${bin} >/dev/null 2>&1 && echo ${bin}`).join('; ')}; true`;
    try {
        const { stdout } = await exec(script);
        const found = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
        for (const bin of missing) {
            availability.set(bin, found.has(bin));
        }
    } catch {
        await individually();
    }
}

/** Warm the cache in the background so the first form open is instant. */
export function warmUpPrograms(): void {
    void probeAll();
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

const variants = (commands: string[]): Variant[] => commands.map(command => ({ label: command, command }));

// Each program's plain command and, where it has them, the variants to list and
// whether a typed value (a model name) applies. Flags are the doc-verified set.
async function buildPrograms(): Promise<ProgramData[]> {
    await probeAll();
    const out: ProgramData[] = [];

    const bash = await firstInstalled(['bash']);
    if (bash) {
        const shells = await installedFrom(ALT_SHELLS);
        out.push({
            label: 'bash',
            command: '',
            // First entry reverts to the session's default shell (empty command).
            variants: [{ label: 'bash', command: '' }, ...variants(shells)],
            custom: null
        });
    }

    const python = await firstInstalled(['python3', 'python']);
    if (python) {
        const repls = await installedFrom(ALT_REPLS);
        out.push({ label: python, command: python, variants: [{ label: python, command: python }, ...variants(repls)], custom: null });
    }

    const claude = await firstInstalled(['claude']);
    if (claude) {
        out.push({
            label: 'claude',
            command: claude,
            variants: variants([claude, `${claude} --resume`, `${claude} --resume --fork-session`, ...CLAUDE_MODELS.map(m => `${claude} --model ${m}`)]),
            custom: { prefix: `${claude} --model`, hint: 'Claude model — an alias like sonnet, or a full id' }
        });
    }

    const codex = await firstInstalled(['codex']);
    if (codex) {
        out.push({ label: 'codex', command: codex, variants: variants([codex, `${codex} resume`]), custom: { prefix: `${codex} -m`, hint: 'Codex model name' } });
    }

    const gemini = await firstInstalled(['gemini']);
    if (gemini) {
        // gemini's --resume loads the most recent session rather than a picker,
        // so it is left out; the -m aliases are verified.
        out.push({ label: 'gemini', command: gemini, variants: variants([gemini, ...GEMINI_MODELS.map(m => `${gemini} -m ${m}`)]), custom: { prefix: `${gemini} -m`, hint: 'Gemini model name' } });
    }

    const agy = await firstInstalled(['agy']);
    if (agy) {
        // Antigravity (gemini's successor): --model takes a full model name.
        out.push({ label: 'agy', command: agy, variants: variants([agy]), custom: { prefix: `${agy} --model`, hint: 'Antigravity model, e.g. Gemini 3 Pro' } });
    }

    const aider = await firstInstalled(['aider']);
    if (aider) {
        out.push({ label: 'aider', command: aider, variants: variants([aider, `${aider} --restore-chat-history`]), custom: { prefix: `${aider} --model`, hint: 'Aider model, e.g. anthropic/claude-sonnet-5' } });
    }

    for (const bin of ['opencode', 'goose', 'crush', 'lazygit', 'tig', 'gitui']) {
        if (await isInstalled(bin)) {
            out.push({ label: bin, command: bin, variants: null, custom: null });
        }
    }

    return out;
}

function defaultTerminalLocation(): 'editor' | 'panel' {
    const configured = vscode.workspace.getConfiguration('terminal.integrated').get<string>('defaultLocation');
    return configured === 'editor' ? 'editor' : 'panel';
}

// --- Webview ---------------------------------------------------------------

interface Payload {
    mode: LaunchMode;
    suggestedName: string;
    folders: { name: string; path: string }[];
    defaultCwd: string;
    // null while the installed programs are still being resolved — the form is
    // shown immediately and this arrives over a message.
    programs: ProgramData[] | null;
    preferred: 'editor' | 'panel';
}

function nonce(): string {
    // No Math.random in this environment; a fixed-length id from the clock is
    // enough for a per-load CSP nonce.
    return Buffer.from(`${process.hrtime.bigint()}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}

function html(payload: Payload): string {
    const n = nonce();
    const data = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  * { box-sizing: border-box; }
  /* Kept tight so it fits a normal screen in one go, but the page still scrolls
     when it can't — a small window, an unusual number of installed tools or of
     project roots. */
  body { margin: 0; padding: 14px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .form { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
  h1 { font-size: 1.15em; font-weight: 600; margin: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field > label { font-weight: 600; }
  input[type=text] {
    width: 100%; padding: 6px 8px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input[type=text] { flex: 1; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 3px 9px; border-radius: 10px; cursor: pointer; font-size: 0.92em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid transparent;
  }
  .chip:hover { outline: 1px solid var(--vscode-focusBorder); }
  .list { display: flex; flex-direction: column; gap: 2px; }
  .item {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; cursor: pointer;
    background: var(--vscode-list-inactiveSelectionBackground, transparent); border: 1px solid transparent;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
  .dot.on { background: var(--vscode-terminal-ansiGreen, #3fb950); }
  .dot.off { border: 1.6px solid var(--vscode-terminal-ansiGreen, #3fb950); }
  .variants { margin: 4px 0 2px 20px; display: flex; flex-direction: column; gap: 3px; border-left: 2px solid var(--vscode-panel-border); padding-left: 10px; }
  .variant { padding: 4px 8px; border-radius: 4px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
  .variant:hover { background: var(--vscode-list-hoverBackground); }
  .variant.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; flex: none; }
  button.act {
    display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 1em; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.act:hover { background: var(--vscode-button-hoverBackground); }
  button.act.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.act.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.act svg { width: 16px; height: 16px; }
  .split-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font-size: 0.95em; align-self: flex-start; }
  .error { color: var(--vscode-inputValidation-errorForeground, #f14c4c); min-height: 1.1em; font-size: 0.92em; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style>
</head>
<body>
<div class="form" id="form"></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const DATA = ${data};
let focused = false;
const state = {
  name: DATA.mode === 'session' ? DATA.suggestedName : '',
  cwd: DATA.defaultCwd || '',
  program: null,
  // Per program: the variant it is currently set to, and whatever was typed in
  // its model box. Each program keeps its own, so its row still reads the way
  // it was left after the selection moves elsewhere and back.
  choice: {},
  typed: {}
};

// What a program currently runs, and the label its row shows for it.
function effective(p) {
  return state.choice[p.label] || { label: p.label, command: p.command };
}

// A plain model name goes in as typed; only one the shell would misread — a
// space, a quote, anything outside this set — gets quoted.
function quoteModel(v) {
  if (/^[A-Za-z0-9._:/@+-]+$/.test(v)) { return v; }
  return "'" + v.split("'").join("'\\\\''") + "'";
}

function dirIcon(dir) {
  const halves = { right: [8.3,3.05,5.15,9.9], left: [2.55,3.05,5.15,9.9], down: [2.55,8.3,10.9,4.65], up: [2.55,3.05,10.9,4.65] };
  const [x,y,w,h] = halves[dir];
  return '<svg viewBox="0 0 16 16" style="width:16px;height:16px">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="1.7" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
    '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="0.8" fill="currentColor"/></svg>';
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

function submit(location, direction) {
  const command = state.program ? effective(state.program).command : '';
  vscode.postMessage({ type:'create', name: state.name, cwd: state.cwd, command, location, direction });
}

// The create buttons — drawn even while the program list is still resolving, so
// the fast path stays available immediately.
function renderActions(root) {
  const actions = el('div', DATA.mode === 'split' ? 'actions split-actions' : 'actions');
  if (DATA.mode === 'split') {
    [['right','Split right'],['left','Split left'],['down','Split down'],['up','Split up']].forEach(([d,label]) => {
      const b = el('button','act secondary', dirIcon(d) + '<span>'+label+'</span>'); b.onclick = () => submit(undefined, d); actions.appendChild(b);
    });
  } else if (DATA.mode === 'window') {
    const b = el('button','act','Create window'); b.onclick = () => submit(); actions.appendChild(b);
  } else {
    const editor = el('button','act' + (DATA.preferred === 'editor' ? '' : ' secondary'), 'Create in editor area'); editor.onclick = () => submit('editor');
    const panel = el('button','act' + (DATA.preferred === 'panel' ? '' : ' secondary'), 'Create in panel'); panel.onclick = () => submit('panel');
    if (DATA.preferred === 'editor') { actions.append(editor, panel); } else { actions.append(panel, editor); }
  }
  root.appendChild(actions);

  const cancel = el('button','link','Cancel'); cancel.onclick = () => vscode.postMessage({ type:'cancel' }); root.appendChild(cancel);
}

function render() {
  const root = document.getElementById('form');
  root.innerHTML = '';
  root.appendChild(el('h1', null, DATA.mode === 'session' ? 'New session' : DATA.mode === 'window' ? 'New window' : 'Split pane'));

  if (DATA.mode !== 'split') {
    const f = el('div','field');
    f.appendChild(el('label', null, 'Name'));
    const inp = el('input'); inp.type='text'; inp.id='name'; inp.value = state.name;
    inp.placeholder = DATA.mode === 'session' ? DATA.suggestedName : 'optional';
    inp.oninput = () => { state.name = inp.value; };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); primary(); } };
    f.appendChild(inp);
    const err = el('div','error'); err.id='err'; f.appendChild(err);
    root.appendChild(f);
    // Only on the first paint — later ones (the program list arriving) must not
    // grab the caret back or reselect what is being typed.
    if (!focused) { focused = true; setTimeout(() => { inp.focus(); inp.select(); }, 0); }
  }

  // Working directory
  const wd = el('div','field');
  wd.appendChild(el('label', null, 'Working directory'));
  const rowW = el('div','row');
  const pathInp = el('input'); pathInp.type='text'; pathInp.value = state.cwd; pathInp.placeholder='Default';
  pathInp.oninput = () => { state.cwd = pathInp.value; };
  rowW.appendChild(pathInp);
  const browse = el('button','act secondary','Browse…'); browse.onclick = () => vscode.postMessage({ type:'browse', cwd: state.cwd });
  rowW.appendChild(browse);
  wd.appendChild(rowW);
  if (DATA.folders.length) {
    const chips = el('div','chips');
    DATA.folders.forEach(fo => { const c = el('div','chip', fo.name); c.title = fo.path; c.onclick = () => { state.cwd = fo.path; render(); }; chips.appendChild(c); });
    wd.appendChild(chips);
  }
  root.appendChild(wd);

  // Run
  const run = el('div','field');
  run.appendChild(el('label', null, 'Run'));
  if (!DATA.programs) {
    run.appendChild(el('div','hint','Detecting installed programs…'));
    root.appendChild(run);
    renderActions(root);
    return;
  }
  const list = el('div','list');
  DATA.programs.forEach(p => {
    const selected = state.program && state.program.label === p.label;
    const item = el('div','item' + (selected ? ' sel' : ''));
    item.appendChild(el('span','dot ' + (selected ? 'on' : 'off')));
    // The row reads as whatever this program is set to run — bash becomes sh,
    // claude becomes claude --resume — so the choice is visible in the list.
    const rowLabel = el('span', null, effective(p).label);
    item.appendChild(rowLabel);
    item.onclick = () => { state.program = p; render(); };
    list.appendChild(item);

    if (selected && (p.variants || p.custom)) {
      const box = el('div','variants');
      const rendered = [];
      (p.variants || []).forEach(v => {
        const vi = el('div','variant', v.label);
        vi.onclick = () => {
          delete state.typed[p.label];
          state.choice[p.label] = { label: v.label, command: v.command };
          render();
        };
        box.appendChild(vi);
        rendered.push({ node: vi, command: v.command });
      });

      // Reflect the current choice without rebuilding the box, which would
      // steal focus from the model field mid-typing.
      const paint = () => {
        const current = effective(p).command;
        rendered.forEach(r => r.node.classList.toggle('sel', r.command === current));
        rowLabel.textContent = effective(p).label;
      };

      if (p.custom) {
        const ci = el('input'); ci.type = 'text'; ci.placeholder = p.custom.hint;
        ci.value = state.typed[p.label] || '';
        ci.oninput = () => {
          state.typed[p.label] = ci.value;
          const value = ci.value.trim();
          // Typing a model takes over from the picked variant, so its highlight
          // clears and the row follows.
          if (value) {
            const command = p.custom.prefix + ' ' + quoteModel(value);
            state.choice[p.label] = { label: command, command };
          } else {
            delete state.choice[p.label];
          }
          paint();
        };
        box.appendChild(ci);
      }

      paint();
      list.appendChild(box);
    }
  });
  run.appendChild(list);
  root.appendChild(run);

  renderActions(root);
}

// The default action for Enter: the preferred create location, or the first split.
function primary() {
  if (DATA.mode === 'split') { submit(undefined, 'right'); }
  else if (DATA.mode === 'window') { submit(); }
  else { submit(DATA.preferred); }
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'browsed') { state.cwd = m.path; render(); }
  else if (m.type === 'error') { const err = document.getElementById('err'); if (err) err.textContent = m.message; }
  else if (m.type === 'programs') {
    DATA.programs = m.programs || [];
    if (!state.program) { state.program = DATA.programs[0] || null; }
    // The list can land mid-word, so put the caret back exactly where it was.
    const before = document.getElementById('name');
    const typing = before && document.activeElement === before;
    const caret = typing ? before.selectionStart : null;
    render();
    if (typing) {
      const after = document.getElementById('name');
      if (after) { after.focus(); const at = caret === null ? after.value.length : caret; after.setSelectionRange(at, at); }
    }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') vscode.postMessage({ type:'cancel' }); });
render();
</script>
</body>
</html>`;
}

export async function runLaunchWizard(
    mode: LaunchMode,
    extensionUri: vscode.Uri,
    suggestedName?: string,
    validate?: NameValidator
): Promise<LaunchChoice | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, path: f.uri.fsPath }));
    // Show the form at once and fill the program list in when it resolves —
    // waiting for it first left the "+" looking unresponsive on a cold start.
    const payload: Payload = {
        mode,
        suggestedName: suggestedName ?? '',
        folders,
        defaultCwd: folders[0]?.path ?? '',
        programs: null,
        preferred: defaultTerminalLocation()
    };

    const panel = vscode.window.createWebviewPanel(
        'tmuxSidebarCreate',
        mode === 'session' ? 'New session' : mode === 'window' ? 'New window' : 'Split pane',
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
    panel.webview.html = html(payload);

    return new Promise<LaunchChoice | undefined>(resolve => {
        let settled = false;
        // Set while the native folder dialog is up, so the panel losing sight of
        // itself for that isn't read as the user walking away.
        let busy = false;

        void buildPrograms().then(programs => {
            if (!settled) {
                panel.webview.postMessage({ type: 'programs', programs });
            }
        });
        const finish = (choice: LaunchChoice | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(choice);
            panel.dispose();
        };

        // Behave like the dialog it is: switching to another tab abandons it,
        // rather than leaving a half-filled form parked in the editor.
        panel.onDidChangeViewState(() => {
            if (!panel.visible && !busy) {
                finish(undefined);
            }
        });

        panel.webview.onDidReceiveMessage(async (msg: any) => {
            if (msg.type === 'create') {
                const raw = typeof msg.name === 'string' ? msg.name.trim() : '';
                const name = mode === 'session' ? (raw || (suggestedName ?? '')) : (raw || undefined);
                const error = name !== undefined ? validate?.(name) : undefined;
                if (error) {
                    panel.webview.postMessage({ type: 'error', message: error });
                    return;
                }
                const location = msg.location === 'editor'
                    ? vscode.TerminalLocation.Editor
                    : msg.location === 'panel'
                        ? vscode.TerminalLocation.Panel
                        : undefined;
                finish({
                    name,
                    cwd: msg.cwd ? String(msg.cwd) : undefined,
                    command: msg.command ? String(msg.command) : undefined,
                    location,
                    direction: msg.direction
                });
            } else if (msg.type === 'cancel') {
                finish(undefined);
            } else if (msg.type === 'browse') {
                busy = true;
                try {
                    const chosen = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        defaultUri: msg.cwd ? vscode.Uri.file(String(msg.cwd)) : undefined,
                        openLabel: 'Use this folder'
                    });
                    if (chosen?.[0]) {
                        panel.webview.postMessage({ type: 'browsed', path: chosen[0].fsPath });
                    }
                } finally {
                    busy = false;
                }
            }
        });

        panel.onDidDispose(() => {
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });
    });
}
