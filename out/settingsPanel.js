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
exports.openSettingsPanel = openSettingsPanel;
const vscode = __importStar(require("vscode"));
const programs_1 = require("./programs");
function readSettings() {
    const config = vscode.workspace.getConfiguration('tmuxSidebar');
    return {
        autoRefreshEnabled: config.get('autoRefresh.enabled', true),
        autoRefreshInterval: config.get('autoRefresh.intervalSeconds', 3),
        terminalLocation: config.get('newTerminalLocation', 'vscode'),
        programs: (0, programs_1.getProgramSpecs)()
    };
}
let current;
function openSettingsPanel(extensionUri) {
    if (current) {
        current.reveal();
        return;
    }
    const panel = vscode.window.createWebviewPanel('tmuxSidebarSettings', 'Tmux Sidebar Settings', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [extensionUri] });
    current = panel;
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'icon.svg');
    panel.onDidDispose(() => {
        current = undefined;
    });
    const postState = async () => {
        const settings = readSettings();
        const availability = await (0, programs_1.probeBins)((0, programs_1.allBins)(settings.programs));
        void panel.webview.postMessage({ type: 'state', settings, availability });
    };
    panel.webview.html = html();
    void postState();
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'save') {
            const config = vscode.workspace.getConfiguration('tmuxSidebar');
            const programs = (0, programs_1.sanitizeSpecs)(msg.settings?.programs);
            const interval = Number(msg.settings?.autoRefreshInterval);
            try {
                await config.update('autoRefresh.enabled', Boolean(msg.settings?.autoRefreshEnabled), vscode.ConfigurationTarget.Global);
                await config.update('autoRefresh.intervalSeconds', Number.isFinite(interval) && interval >= 1 ? interval : 3, vscode.ConfigurationTarget.Global);
                const location = ['vscode', 'editor', 'panel'].includes(msg.settings?.terminalLocation) ? msg.settings.terminalLocation : 'vscode';
                await config.update('newTerminalLocation', location, vscode.ConfigurationTarget.Global);
                await config.update('programs', programs, vscode.ConfigurationTarget.Global);
                void panel.webview.postMessage({ type: 'saved' });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void panel.webview.postMessage({ type: 'error', message: `Could not save settings: ${message}` });
            }
        }
        else if (msg.type === 'probe') {
            // New binaries typed into the form are checked as they appear;
            // cached ones answer instantly.
            const availability = await (0, programs_1.probeBins)(Array.isArray(msg.bins) ? msg.bins : []);
            void panel.webview.postMessage({ type: 'availability', availability });
        }
        else if (msg.type === 'recheck') {
            // Full re-check: drop every cached result so a tool installed a
            // minute ago is picked up without reloading VS Code.
            (0, programs_1.resetAvailability)();
            const availability = await (0, programs_1.probeBins)(Array.isArray(msg.bins) ? msg.bins : []);
            void panel.webview.postMessage({ type: 'availability', availability, rechecked: true });
        }
        else if (msg.type === 'reset') {
            const answer = await vscode.window.showWarningMessage('Reset Tmux Sidebar settings to their defaults? Your program list customisations will be lost.', { modal: true }, 'Reset');
            if (answer === 'Reset') {
                const config = vscode.workspace.getConfiguration('tmuxSidebar');
                await config.update('autoRefresh.enabled', undefined, vscode.ConfigurationTarget.Global);
                await config.update('autoRefresh.intervalSeconds', undefined, vscode.ConfigurationTarget.Global);
                await config.update('newTerminalLocation', undefined, vscode.ConfigurationTarget.Global);
                await config.update('programs', undefined, vscode.ConfigurationTarget.Global);
                await postState();
            }
        }
    });
}
function nonce() {
    return Buffer.from(`${process.hrtime.bigint()}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
}
function html() {
    const n = nonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .form { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  h1 { font-size: 1.15em; font-weight: 600; margin: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field > label, .section-title { font-weight: 600; }
  input[type=text], input[type=number] {
    padding: 5px 8px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row label { display: flex; gap: 5px; align-items: center; }
  .num { width: 70px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.on { background: var(--vscode-terminal-ansiGreen, #3fb950); }
  .dot.miss { border: 1.5px solid var(--vscode-descriptionForeground); opacity: .7; }
  .card {
    border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px; background: var(--vscode-list-inactiveSelectionBackground, transparent);
  }
  .card-head { display: flex; align-items: center; gap: 8px; }
  .card-head .name { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
  .card-head .status { color: var(--vscode-descriptionForeground); font-size: .9em; flex: 1; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
  .grid label { color: var(--vscode-descriptionForeground); }
  .variant-row { display: flex; gap: 6px; align-items: center; }
  .variant-row input.cmd { flex: 1; font-family: var(--vscode-editor-font-family, monospace); }
  .variant-row input.vbin { width: 110px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: .9em; }
  button.act {
    display: inline-flex; align-items: center; gap: 6px; padding: 6px 13px; border: none; border-radius: 4px; cursor: pointer;
    font-size: 1em; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.act:hover { background: var(--vscode-button-hoverBackground); }
  button.act.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.act.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.small { padding: 3px 9px; font-size: .92em; }
  button.icon { padding: 3px 8px; }
  .footer { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; position: sticky; bottom: 0; padding: 10px 0;
            background: var(--vscode-editor-background, var(--vscode-panel-background)); border-top: 1px solid var(--vscode-panel-border); }
  .flash { color: var(--vscode-terminal-ansiGreen, #3fb950); font-size: .92em; }
  .error { color: var(--vscode-inputValidation-errorForeground, #f14c4c); font-size: .92em; }
</style>
</head>
<body>
<div class="form" id="form"><div class="hint">Loading settings…</div></div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
let model = null;          // { autoRefreshEnabled, autoRefreshInterval, terminalLocation, programs: [] }
let availability = {};
let probeTimer = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

function allFormBins() {
  const bins = [];
  for (const p of model.programs) {
    bins.push(...p.bins);
    for (const v of p.variants) { if (v.bin) bins.push(v.bin); }
  }
  return bins.map(b => b.trim()).filter(Boolean);
}

// Typing a binary name re-checks it shortly after the typing pauses, so a
// freshly added tool gets its green dot without any extra clicks.
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => vscode.postMessage({ type: 'probe', bins: allFormBins() }), 500);
}

function resolvedBin(p) {
  for (const b of p.bins) { const t = b.trim(); if (t && availability[t]) return t; }
  return null;
}

function dot(installed) { return el('span', 'dot ' + (installed ? 'on' : 'miss')); }

// Repaint just the installed/missing indicators from the latest availability —
// no full render, so nothing loses focus.
function paintDots() {
  document.querySelectorAll('[data-head]').forEach(head => {
    const p = model.programs[Number(head.dataset.head)];
    if (!p) return;
    const bin = resolvedBin(p);
    head.querySelector('.dot').className = 'dot ' + (bin ? 'on' : 'miss');
    head.querySelector('.name').textContent = (p.label && p.label.trim()) || bin || (p.bins[0] || '').trim() || 'new program';
    head.querySelector('.status').textContent = bin ? 'installed: ' + bin : 'not installed';
  });
  document.querySelectorAll('[data-vdot]').forEach(node => {
    const [gi, vi] = node.dataset.vdot.split(':').map(Number);
    const v = model.programs[gi] && model.programs[gi].variants[vi];
    if (!v) return;
    const b = (v.bin || '').trim();
    node.style.visibility = b ? 'visible' : 'hidden';
    node.className = 'dot ' + (b && availability[b] ? 'on' : 'miss');
  });
}

function bindText(input, get, set) {
  input.value = get() || '';
  input.oninput = () => { set(input.value); markDirty(); };
}

let dirty = false;
function markDirty() {
  dirty = true;
  const f = document.getElementById('flash'); if (f) f.textContent = '';
}

function programCard(p, index) {
  const card = el('div', 'card');

  const head = el('div', 'card-head'); head.dataset.head = String(index);
  head.appendChild(dot(false));
  head.appendChild(el('span', 'name'));
  head.appendChild(el('span', 'status'));
  const remove = el('button', 'act secondary small', 'Remove');
  remove.onclick = () => { model.programs.splice(index, 1); markDirty(); render(); };
  head.appendChild(remove);
  card.appendChild(head);

  const grid = el('div', 'grid');
  const add = (labelText, input, hint) => {
    grid.appendChild(el('label', null, labelText));
    const wrap = el('div', 'field');
    wrap.appendChild(input);
    if (hint) wrap.appendChild(el('div', 'hint', hint));
    grid.appendChild(wrap);
  };

  const binsInput = el('input'); binsInput.type = 'text'; binsInput.placeholder = 'binary, fallback-binary';
  binsInput.value = p.bins.join(', ');
  binsInput.oninput = () => { p.bins = binsInput.value.split(',').map(s => s.trim()).filter(Boolean); markDirty(); paintDots(); scheduleProbe(); };
  add('Binaries', binsInput, 'Probed in order; the first installed one is used. The group is hidden when none is.');

  const labelInput = el('input'); labelInput.type = 'text'; labelInput.placeholder = 'defaults to the binary';
  bindText(labelInput, () => p.label, v => { p.label = v; paintDots(); });
  add('Label', labelInput);

  const cmdInput = el('input'); cmdInput.type = 'text';
  bindText(cmdInput, () => p.command, v => { p.command = v; });
  add('Command', cmdInput, '{bin} runs the detected binary. Leave empty to start tmux\\'s default shell.');
  card.appendChild(grid);

  // Variants
  const vwrap = el('div', 'field');
  vwrap.appendChild(el('label', null, 'Variants'));
  p.variants.forEach((v, vi) => {
    const row = el('div', 'variant-row');
    const vd = dot(false); vd.dataset.vdot = index + ':' + vi; row.appendChild(vd);
    const cmd = el('input', 'cmd'); cmd.type = 'text'; cmd.placeholder = '{bin} --flag';
    bindText(cmd, () => v.command, x => { v.command = x; });
    row.appendChild(cmd);
    const vbin = el('input', 'vbin'); vbin.type = 'text'; vbin.placeholder = 'only if installed';
    vbin.value = v.bin || '';
    vbin.oninput = () => { v.bin = vbin.value.trim(); markDirty(); paintDots(); scheduleProbe(); };
    row.appendChild(vbin);
    const del = el('button', 'act secondary icon', '−');
    del.onclick = () => { p.variants.splice(vi, 1); markDirty(); render(); };
    row.appendChild(del);
    vwrap.appendChild(row);
  });
  const addVar = el('button', 'act secondary small', '+ Add variant');
  addVar.onclick = () => { p.variants.push({ command: '', bin: '' }); markDirty(); render(); };
  vwrap.appendChild(addVar);
  card.appendChild(vwrap);

  // Custom model input
  const crow = el('div', 'row');
  const ctoggle = el('label');
  const cbox = document.createElement('input'); cbox.type = 'checkbox'; cbox.checked = Boolean(p.custom);
  cbox.onchange = () => { p.custom = cbox.checked ? { prefix: '{bin} --model', hint: '' } : null; markDirty(); render(); };
  ctoggle.appendChild(cbox); ctoggle.appendChild(document.createTextNode('Free-text input'));
  crow.appendChild(ctoggle);
  if (p.custom) {
    const prefix = el('input'); prefix.type = 'text'; prefix.placeholder = '{bin} --model';
    bindText(prefix, () => p.custom.prefix, v => { p.custom.prefix = v; });
    const hint = el('input'); hint.type = 'text'; hint.placeholder = 'placeholder shown in the field';
    bindText(hint, () => p.custom.hint, v => { p.custom.hint = v; });
    crow.appendChild(el('span', 'hint', 'prefix:')); crow.appendChild(prefix);
    crow.appendChild(el('span', 'hint', 'hint:')); crow.appendChild(hint);
  } else {
    crow.appendChild(el('span', 'hint', '— a typed value appended to a prefix, e.g. a model name'));
  }
  card.appendChild(crow);

  return card;
}

function render() {
  const root = document.getElementById('form');
  root.innerHTML = '';
  root.appendChild(el('h1', null, 'Tmux Sidebar Settings'));

  // Auto refresh
  const ar = el('div', 'field');
  ar.appendChild(el('div', 'section-title', 'Auto refresh'));
  const arRow = el('div', 'row');
  const arLabel = el('label');
  const arBox = document.createElement('input'); arBox.type = 'checkbox'; arBox.checked = model.autoRefreshEnabled;
  const interval = el('input', 'num'); interval.type = 'number'; interval.min = '1'; interval.value = String(model.autoRefreshInterval);
  arBox.onchange = () => { model.autoRefreshEnabled = arBox.checked; interval.disabled = !arBox.checked; markDirty(); };
  interval.disabled = !model.autoRefreshEnabled;
  interval.oninput = () => { model.autoRefreshInterval = Number(interval.value); markDirty(); };
  arLabel.appendChild(arBox); arLabel.appendChild(document.createTextNode('Refresh the session tree automatically, every'));
  arRow.appendChild(arLabel); arRow.appendChild(interval); arRow.appendChild(el('span', 'hint', 'seconds'));
  ar.appendChild(arRow);
  root.appendChild(ar);

  // Terminal location
  const loc = el('div', 'field');
  loc.appendChild(el('div', 'section-title', 'New terminals open in'));
  const options = [
    ['vscode', 'VS Code default', 'follows terminal.integrated.defaultLocation, read each time'],
    ['editor', 'Editor area', ''],
    ['panel', 'Panel', '']
  ];
  for (const [value, name, hint] of options) {
    const row = el('div', 'row');
    const label = el('label');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'loc'; radio.checked = model.terminalLocation === value;
    radio.onchange = () => { model.terminalLocation = value; markDirty(); };
    label.appendChild(radio); label.appendChild(document.createTextNode(name));
    row.appendChild(label);
    if (hint) row.appendChild(el('span', 'hint', hint));
    loc.appendChild(row);
  }
  root.appendChild(loc);

  // Programs
  const ps = el('div', 'field');
  const psHead = el('div', 'row');
  psHead.appendChild(el('div', 'section-title', 'Programs'));
  psHead.appendChild(el('span', 'hint', 'what the create form offers to run'));
  ps.appendChild(psHead);
  model.programs.forEach((p, i) => ps.appendChild(programCard(p, i)));
  const addProgram = el('button', 'act secondary small', '+ Add program');
  addProgram.onclick = () => { model.programs.push({ label: '', bins: [], command: undefined, variants: [], custom: null }); markDirty(); render(); };
  ps.appendChild(addProgram);
  root.appendChild(ps);

  // Footer
  const footer = el('div', 'footer');
  const save = el('button', 'act', 'Save');
  save.onclick = () => {
    const bad = model.programs.findIndex(p => p.bins.length === 0);
    const err = document.getElementById('err');
    if (bad >= 0) { err.textContent = 'Program ' + (bad + 1) + ' has no binaries — every program needs at least one.'; return; }
    err.textContent = '';
    vscode.postMessage({ type: 'save', settings: serialize() });
  };
  const recheck = el('button', 'act secondary', 'Re-check installed tools');
  recheck.onclick = () => { recheck.disabled = true; vscode.postMessage({ type: 'recheck', bins: allFormBins() }); };
  recheck.id = 'recheck';
  const reset = el('button', 'act secondary', 'Reset to defaults');
  reset.onclick = () => vscode.postMessage({ type: 'reset' });
  footer.appendChild(save); footer.appendChild(recheck); footer.appendChild(reset);
  footer.appendChild(el('span', 'flash', '')).id = 'flash';
  footer.appendChild(el('span', 'error', '')).id = 'err';
  root.appendChild(footer);

  paintDots();
}

function serialize() {
  return {
    autoRefreshEnabled: model.autoRefreshEnabled,
    autoRefreshInterval: model.autoRefreshInterval,
    terminalLocation: model.terminalLocation,
    programs: model.programs.map(p => {
      const spec = { bins: p.bins.slice() };
      if (p.label && p.label.trim()) spec.label = p.label.trim();
      if (p.command !== undefined && p.command !== '{bin}') spec.command = p.command;
      const variants = p.variants
        .filter(v => v.command && v.command.trim())
        .map(v => (v.bin && v.bin.trim() ? { command: v.command, bin: v.bin.trim() } : { command: v.command }));
      if (variants.length) spec.variants = variants;
      if (p.custom && p.custom.prefix && p.custom.prefix.trim()) {
        spec.custom = p.custom.hint && p.custom.hint.trim() ? { prefix: p.custom.prefix, hint: p.custom.hint } : { prefix: p.custom.prefix };
      }
      return spec;
    })
  };
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'state') {
    availability = m.availability || {};
    const s = m.settings;
    model = {
      autoRefreshEnabled: s.autoRefreshEnabled,
      autoRefreshInterval: s.autoRefreshInterval,
      terminalLocation: s.terminalLocation,
      // Normalise for editing: every program gets concrete fields.
      programs: (s.programs || []).map(p => ({
        label: p.label || '',
        bins: (p.bins || []).slice(),
        command: p.command !== undefined ? p.command : '{bin}',
        variants: (p.variants || []).map(v => ({ command: v.command, bin: v.bin || '' })),
        custom: p.custom ? { prefix: p.custom.prefix, hint: p.custom.hint || '' } : null
      }))
    };
    dirty = false;
    render();
  } else if (m.type === 'availability') {
    availability = Object.assign({}, availability, m.availability);
    paintDots();
    const btn = document.getElementById('recheck');
    if (btn) btn.disabled = false;
    if (m.rechecked) { const f = document.getElementById('flash'); if (f) f.textContent = 'Tools re-checked.'; }
  } else if (m.type === 'saved') {
    dirty = false;
    const f = document.getElementById('flash'); if (f) f.textContent = 'Saved.';
  } else if (m.type === 'error') {
    const err = document.getElementById('err'); if (err) err.textContent = m.message;
  }
});
</script>
</body>
</html>`;
}
//# sourceMappingURL=settingsPanel.js.map