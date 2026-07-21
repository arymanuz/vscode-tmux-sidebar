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
exports.DEFAULT_SHELL_TOKEN = void 0;
exports.sanitizeSpecs = sanitizeSpecs;
exports.getProgramSpecs = getProgramSpecs;
exports.binOf = binOf;
exports.probeBins = probeBins;
exports.getDefaultShell = getDefaultShell;
exports.resetAvailability = resetAvailability;
exports.allBins = allBins;
exports.warmUpPrograms = warmUpPrograms;
exports.resolvePrograms = resolvePrograms;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
const tmuxService_1 = require("./tmuxService");
const exec = util.promisify(cp.exec);
/**
 * The configurable program list. A program is a group of commands; the command
 * string is both what runs and what the row shows, so there is nothing else to
 * configure per entry. The defaults live in package.json (tmuxSidebar.programs)
 * — the configuration IS the list, and getConfiguration falls back to the
 * manifest default when the user hasn't overridden it.
 */
exports.DEFAULT_SHELL_TOKEN = '{default-shell}';
const asString = (v) => (typeof v === 'string' ? v : undefined);
// Configuration content is user-editable JSON, so nothing about its shape can
// be assumed. Entries without any usable command are dropped.
function sanitizeSpecs(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const specs = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const e = entry;
        const commands = Array.isArray(e.commands)
            ? e.commands.filter((c) => typeof c === 'string' && c.trim() !== '').map(c => c.trim())
            : [];
        if (commands.length === 0) {
            continue;
        }
        const spec = { commands };
        if (typeof e.custom === 'object' && e.custom !== null) {
            const prefix = asString(e.custom.prefix);
            if (prefix && prefix.trim() !== '') {
                const hint = asString(e.custom.hint);
                spec.custom = hint ? { prefix, hint } : { prefix };
            }
        }
        specs.push(spec);
    }
    return specs;
}
function getProgramSpecs() {
    const config = vscode.workspace.getConfiguration('tmuxSidebar');
    const inspected = config.inspect('programs');
    const overridden = inspected !== undefined
        && (inspected.globalValue !== undefined || inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined);
    const specs = sanitizeSpecs(config.get('programs'));
    // The manifest default is written for Unix. On Windows, until the user has
    // saved their own list, the shell group additionally offers PowerShell and
    // cmd right after the default shell — declared here rather than as
    // platform toggles in the configuration.
    if (!overridden && process.platform === 'win32') {
        for (const spec of specs) {
            const at = spec.commands.indexOf(exports.DEFAULT_SHELL_TOKEN);
            if (at !== -1) {
                spec.commands.splice(at + 1, 0, 'powershell', 'cmd');
                break;
            }
        }
    }
    return specs;
}
/** The binary a command starts with — what existence is checked against. */
function binOf(command) {
    return command.trim().split(/\s+/)[0] ?? '';
}
// --- Availability ----------------------------------------------------------
const availability = new Map();
let defaultShell;
async function probeOne(bin) {
    const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    try {
        await exec(probe);
        return true;
    }
    catch {
        return false;
    }
}
// A binary name goes into a shell command line, so only sane names are probed
// at all; anything else is simply reported as not installed.
const SAFE_BIN = /^[A-Za-z0-9._+-]+$/;
/**
 * Resolve the given binaries against the cache, probing the missing ones. On
 * Unix the missing ones are checked in a single shell pass rather than one
 * process each; Windows has no cheap equivalent, so they run concurrently.
 */
async function probeBins(bins) {
    const unique = [...new Set(bins.map(b => b.trim()).filter(Boolean))];
    const missing = unique.filter(bin => !availability.has(bin));
    for (const bin of missing.filter(b => !SAFE_BIN.test(b))) {
        availability.set(bin, false);
    }
    const toProbe = missing.filter(bin => SAFE_BIN.test(bin));
    if (toProbe.length > 0) {
        if (process.platform === 'win32') {
            await Promise.all(toProbe.map(async (bin) => {
                availability.set(bin, await probeOne(bin));
            }));
        }
        else {
            const script = `${toProbe.map(bin => `command -v ${bin} >/dev/null 2>&1 && echo ${bin}`).join('; ')}; true`;
            try {
                const { stdout } = await exec(script);
                const found = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
                for (const bin of toProbe) {
                    availability.set(bin, found.has(bin));
                }
            }
            catch {
                await Promise.all(toProbe.map(async (bin) => {
                    availability.set(bin, await probeOne(bin));
                }));
            }
        }
    }
    const result = {};
    for (const bin of unique) {
        result[bin] = availability.get(bin) ?? false;
    }
    return result;
}
/**
 * What tmux itself would start: the global default-shell option (verified
 * against the tmux man page: show-options -g lists global session options, -v
 * prints the value alone). tmux needs a running server to answer, so the value
 * of $SHELL — which is also what default-shell defaults to — is the fallback,
 * then a hard-coded shell.
 */
async function getDefaultShell() {
    if (defaultShell !== undefined) {
        return defaultShell;
    }
    let shell = '';
    try {
        const { stdout } = await exec(`${tmuxService_1.TMUX_BIN} show-options -gv default-shell`);
        shell = stdout.trim();
    }
    catch {
        // no server running — fall through
    }
    if (!shell) {
        shell = process.platform === 'win32' ? 'powershell' : (process.env.SHELL || '/bin/bash');
    }
    defaultShell = shell;
    return shell;
}
/** Forget every probe result, so the next check hits the system again. */
function resetAvailability() {
    availability.clear();
    defaultShell = undefined;
}
/** Every binary a spec list mentions (the default-shell token has none). */
function allBins(specs) {
    const bins = [];
    for (const spec of specs) {
        for (const command of spec.commands) {
            if (command !== exports.DEFAULT_SHELL_TOKEN) {
                bins.push(binOf(command));
            }
        }
    }
    return bins;
}
/** Warm the caches in the background so the first form open is instant. */
function warmUpPrograms() {
    void probeBins(allBins(getProgramSpecs()));
    void getDefaultShell();
}
// --- Resolution for the create form ----------------------------------------
/**
 * Turn the configured specs into what the create form shows. Per group: the
 * default-shell token resolves to the concrete shell tmux would start (shown
 * by name, launched by full path, never probed); every other command is kept
 * only when its binary is installed. Duplicates by visible label are dropped —
 * so when the default shell IS bash, the explicit bash entry disappears. The
 * first surviving command fronts the group; a group where nothing survives is
 * hidden.
 */
async function resolvePrograms(specs) {
    const installed = await probeBins(allBins(specs));
    const shell = await getDefaultShell();
    const shellLabel = path.basename(shell);
    const out = [];
    for (const spec of specs) {
        const variants = [];
        const seen = new Set();
        for (const command of spec.commands) {
            const variant = command === exports.DEFAULT_SHELL_TOKEN
                ? { label: shellLabel, command: shell }
                : { label: command, command };
            if (command !== exports.DEFAULT_SHELL_TOKEN && !installed[binOf(command)]) {
                continue;
            }
            if (seen.has(variant.label)) {
                continue;
            }
            seen.add(variant.label);
            variants.push(variant);
        }
        if (variants.length === 0) {
            continue;
        }
        const custom = spec.custom
            ? { prefix: spec.custom.prefix, hint: spec.custom.hint ?? '' }
            : null;
        out.push({
            label: variants[0].label,
            command: variants[0].command,
            variants: variants.length > 1 || custom ? variants : null,
            custom
        });
    }
    return out;
}
//# sourceMappingURL=programs.js.map