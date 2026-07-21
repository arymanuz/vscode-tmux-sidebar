import * as vscode from 'vscode';
import { LaunchOptions, SplitDirection } from './tmuxService';
import { ProgramData, getProgramSpecs, resolvePrograms } from './programs';

export type LaunchMode = 'session' | 'window' | 'split';
export type NameValidator = (value: string) => string | undefined;

export interface LaunchChoice extends LaunchOptions {
    name?: string;
    direction?: SplitDirection;
    location?: vscode.TerminalLocation;
}

/**
 * Where a new terminal opens. The extension's own setting decides: "editor" and
 * "panel" are fixed choices, while "vscode" defers to VS Code's
 * terminal.integrated.defaultLocation — read here, at form-open time, so a
 * change to either setting is picked up by the next "+".
 */
function preferredLocation(): 'editor' | 'panel' {
    const own = vscode.workspace.getConfiguration('tmuxSidebar').get<string>('newTerminalLocation');
    if (own === 'editor' || own === 'panel') {
        return own;
    }
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
  input.manual { font-family: var(--vscode-editor-font-family, monospace); }
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
  typed: {},
  // A hand-typed command that overrides the program selection entirely.
  manual: ''
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
  const manual = state.manual.trim();
  const command = manual ? manual : (state.program ? effective(state.program).command : '');
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

  // The free command field sits after the groups: typing there overrides the
  // selection, clearing it hands control back. Present even while the list is
  // still resolving, and mirrored by syncRun without re-rendering so typing in
  // it never loses focus.
  const programNodes = [];
  const manualInput = el('input','manual');
  manualInput.type = 'text';
  manualInput.placeholder = 'custom command — runs instead of the selection';
  manualInput.value = state.manual;
  const syncRun = () => {
    const manualActive = state.manual.trim() !== '';
    for (const node of programNodes) {
      const on = !manualActive && state.program === node.p;
      node.item.classList.toggle('sel', on);
      node.dotEl.className = 'dot ' + (on ? 'on' : 'off');
    }
  };
  manualInput.oninput = () => { state.manual = manualInput.value; syncRun(); };
  manualInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); primary(); } };

  if (!DATA.programs) {
    run.appendChild(el('div','hint','Detecting installed programs…'));
    run.appendChild(manualInput);
    root.appendChild(run);
    renderActions(root);
    return;
  }
  const list = el('div','list');
  DATA.programs.forEach(p => {
    const selected = state.program && state.program.label === p.label && !state.manual.trim();
    const item = el('div','item' + (selected ? ' sel' : ''));
    const dotEl = el('span','dot ' + (selected ? 'on' : 'off'));
    item.appendChild(dotEl);
    // The row reads as whatever this program is set to run — bash becomes sh,
    // claude becomes claude --resume — so the choice is visible in the list.
    const rowLabel = el('span', null, effective(p).label);
    item.appendChild(rowLabel);
    item.onclick = () => { state.manual = ''; state.program = p; render(); };
    programNodes.push({ item, dotEl, p });
    list.appendChild(item);

    if (selected && (p.variants || p.custom)) {
      const box = el('div','variants');
      const rendered = [];
      (p.variants || []).forEach(v => {
        const vi = el('div','variant', v.label);
        vi.onclick = () => {
          delete state.typed[p.label];
          state.choice[p.label] = { label: v.label, command: v.command };
          state.manual = '';
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
          state.manual = '';
          manualInput.value = '';
          syncRun();
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
  run.appendChild(manualInput);
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
        preferred: preferredLocation()
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

        void resolvePrograms(getProgramSpecs()).then(programs => {
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
