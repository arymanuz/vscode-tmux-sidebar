import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';

const exec = util.promisify(cp.exec);

/**
 * The configurable program list. The defaults live in package.json
 * (tmuxSidebar.programs) — there is no hard-coded list in code any more; the
 * configuration IS the list, and getConfiguration falls back to the manifest
 * default when the user hasn't overridden it.
 */

// A variant as configured: an alternative command for a program. `bin`, when
// set, hides the variant unless that binary is installed (how the alternative
// shells and REPLs behave).
export interface VariantSpec {
    command: string;
    bin?: string;
}

export interface CustomSpec {
    prefix: string;
    hint?: string;
}

// A program as configured. `bins` are probed in order and the first installed
// one is used — the group is hidden when none is. In `command`,
// `variants[].command` and `custom.prefix`, the placeholder {bin} is replaced
// by the resolved binary. An empty `command` starts tmux's default shell; an
// omitted one runs the resolved binary itself.
export interface ProgramSpec {
    label?: string;
    bins: string[];
    command?: string;
    variants?: VariantSpec[];
    custom?: CustomSpec;
}

// What the create form works with: only installed programs, placeholders
// resolved.
export interface Variant {
    label: string;
    command: string;
}

export interface ProgramData {
    label: string;
    command: string;
    variants: Variant[] | null;
    custom: { prefix: string; hint: string } | null;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// Configuration content is user-editable JSON, so nothing about its shape can
// be assumed. Entries without a usable `bins` are dropped.
export function sanitizeSpecs(raw: unknown): ProgramSpec[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const specs: ProgramSpec[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const e = entry as Record<string, unknown>;
        const bins = Array.isArray(e.bins) ? e.bins.filter((b): b is string => typeof b === 'string' && b.trim() !== '').map(b => b.trim()) : [];
        if (bins.length === 0) {
            continue;
        }
        const spec: ProgramSpec = { bins };
        const label = asString(e.label)?.trim();
        if (label) {
            spec.label = label;
        }
        if (typeof e.command === 'string') {
            spec.command = e.command;
        }
        if (Array.isArray(e.variants)) {
            const variants: VariantSpec[] = [];
            for (const v of e.variants) {
                if (typeof v !== 'object' || v === null) {
                    continue;
                }
                const command = asString((v as Record<string, unknown>).command);
                if (command === undefined || command.trim() === '') {
                    continue;
                }
                const bin = asString((v as Record<string, unknown>).bin)?.trim();
                variants.push(bin ? { command, bin } : { command });
            }
            if (variants.length > 0) {
                spec.variants = variants;
            }
        }
        if (typeof e.custom === 'object' && e.custom !== null) {
            const prefix = asString((e.custom as Record<string, unknown>).prefix);
            if (prefix && prefix.trim() !== '') {
                const hint = asString((e.custom as Record<string, unknown>).hint);
                spec.custom = hint ? { prefix, hint } : { prefix };
            }
        }
        specs.push(spec);
    }
    return specs;
}

export function getProgramSpecs(): ProgramSpec[] {
    const raw = vscode.workspace.getConfiguration('tmuxSidebar').get<unknown>('programs');
    return sanitizeSpecs(raw);
}

// --- Availability ----------------------------------------------------------

const availability = new Map<string, boolean>();

async function probeOne(bin: string): Promise<boolean> {
    const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    try {
        await exec(probe);
        return true;
    } catch {
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
export async function probeBins(bins: string[]): Promise<Record<string, boolean>> {
    const unique = [...new Set(bins.map(b => b.trim()).filter(Boolean))];
    const missing = unique.filter(bin => !availability.has(bin));
    const unsafe = missing.filter(bin => !SAFE_BIN.test(bin));
    for (const bin of unsafe) {
        availability.set(bin, false);
    }
    const toProbe = missing.filter(bin => SAFE_BIN.test(bin));

    if (toProbe.length > 0) {
        if (process.platform === 'win32') {
            await Promise.all(toProbe.map(async bin => {
                availability.set(bin, await probeOne(bin));
            }));
        } else {
            const script = `${toProbe.map(bin => `command -v ${bin} >/dev/null 2>&1 && echo ${bin}`).join('; ')}; true`;
            try {
                const { stdout } = await exec(script);
                const found = new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean));
                for (const bin of toProbe) {
                    availability.set(bin, found.has(bin));
                }
            } catch {
                await Promise.all(toProbe.map(async bin => {
                    availability.set(bin, await probeOne(bin));
                }));
            }
        }
    }

    const result: Record<string, boolean> = {};
    for (const bin of unique) {
        result[bin] = availability.get(bin) ?? false;
    }
    return result;
}

/** Forget every probe result, so the next check hits the system again. */
export function resetAvailability(): void {
    availability.clear();
}

/** Every binary a spec list mentions: group bins and per-variant bins. */
export function allBins(specs: ProgramSpec[]): string[] {
    const bins: string[] = [];
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
export function warmUpPrograms(): void {
    void probeBins(allBins(getProgramSpecs()));
}

// --- Resolution for the create form ----------------------------------------

const subst = (s: string, bin: string): string => s.split('{bin}').join(bin);

/**
 * Turn the configured specs into what the create form shows: groups whose
 * binaries are installed, with {bin} substituted, hidden variants filtered
 * out, and the plain command prepended as the first variant (the "revert"
 * entry) whenever a group has variants or a custom field at all.
 */
export async function resolvePrograms(specs: ProgramSpec[]): Promise<ProgramData[]> {
    const installed = await probeBins(allBins(specs));

    const out: ProgramData[] = [];
    for (const spec of specs) {
        const bin = spec.bins.find(b => installed[b]);
        if (!bin) {
            continue;
        }
        const label = spec.label ?? bin;
        const command = spec.command !== undefined ? subst(spec.command, bin) : bin;

        let variants: Variant[] | null = null;
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
