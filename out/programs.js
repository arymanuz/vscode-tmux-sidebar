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
exports.sanitizeSpecs = sanitizeSpecs;
exports.getProgramSpecs = getProgramSpecs;
exports.probeBins = probeBins;
exports.resetAvailability = resetAvailability;
exports.allBins = allBins;
exports.warmUpPrograms = warmUpPrograms;
exports.resolvePrograms = resolvePrograms;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const util = __importStar(require("util"));
const exec = util.promisify(cp.exec);
const asString = (v) => (typeof v === 'string' ? v : undefined);
// Configuration content is user-editable JSON, so nothing about its shape can
// be assumed. Entries without a usable `bins` are dropped.
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
        const bins = Array.isArray(e.bins) ? e.bins.filter((b) => typeof b === 'string' && b.trim() !== '').map(b => b.trim()) : [];
        if (bins.length === 0) {
            continue;
        }
        const spec = { bins };
        const label = asString(e.label)?.trim();
        if (label) {
            spec.label = label;
        }
        if (typeof e.command === 'string') {
            spec.command = e.command;
        }
        if (Array.isArray(e.variants)) {
            const variants = [];
            for (const v of e.variants) {
                if (typeof v !== 'object' || v === null) {
                    continue;
                }
                const command = asString(v.command);
                if (command === undefined || command.trim() === '') {
                    continue;
                }
                const bin = asString(v.bin)?.trim();
                variants.push(bin ? { command, bin } : { command });
            }
            if (variants.length > 0) {
                spec.variants = variants;
            }
        }
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
    const raw = vscode.workspace.getConfiguration('tmuxSidebar').get('programs');
    return sanitizeSpecs(raw);
}
// --- Availability ----------------------------------------------------------
const availability = new Map();
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
    const unsafe = missing.filter(bin => !SAFE_BIN.test(bin));
    for (const bin of unsafe) {
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
/** Forget every probe result, so the next check hits the system again. */
function resetAvailability() {
    availability.clear();
}
/** Every binary a spec list mentions: group bins and per-variant bins. */
function allBins(specs) {
    const bins = [];
    for (const spec of specs) {
        bins.push(...spec.bins);
        for (const variant of spec.variants ?? []) {
            if (variant.bin) {
                bins.push(variant.bin);
            }
        }
    }
    return bins;
}
/** Warm the cache in the background so the first form open is instant. */
function warmUpPrograms() {
    void probeBins(allBins(getProgramSpecs()));
}
// --- Resolution for the create form ----------------------------------------
const subst = (s, bin) => s.split('{bin}').join(bin);
/**
 * Turn the configured specs into what the create form shows: groups whose
 * binaries are installed, with {bin} substituted, hidden variants filtered
 * out, and the plain command prepended as the first variant (the "revert"
 * entry) whenever a group has variants or a custom field at all.
 */
async function resolvePrograms(specs) {
    const installed = await probeBins(allBins(specs));
    const out = [];
    for (const spec of specs) {
        const bin = spec.bins.find(b => installed[b]);
        if (!bin) {
            continue;
        }
        const label = spec.label ?? bin;
        const command = spec.command !== undefined ? subst(spec.command, bin) : bin;
        let variants = null;
        if ((spec.variants && spec.variants.length > 0) || spec.custom) {
            variants = [{ label: command || label, command }];
            for (const variant of spec.variants ?? []) {
                if (variant.bin && !installed[variant.bin]) {
                    continue;
                }
                const variantCommand = subst(variant.command, bin);
                variants.push({ label: variantCommand, command: variantCommand });
            }
        }
        const custom = spec.custom
            ? { prefix: subst(spec.custom.prefix, bin), hint: spec.custom.hint ?? '' }
            : null;
        out.push({ label, command, variants, custom });
    }
    return out;
}
//# sourceMappingURL=programs.js.map