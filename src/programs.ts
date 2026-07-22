import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { TMUX_BIN } from './tmuxService';

const exec = util.promisify(cp.exec);

/**
 * The configurable program list. A program is a group of commands; the command
 * string is both what runs and what the row shows, so there is nothing else to
 * configure per entry. The defaults live in package.json (tmuxSidebar.programs)
 * — the configuration IS the list, and getConfiguration falls back to the
 * manifest default when the user hasn't overridden it.
 */

export const DEFAULT_SHELL_TOKEN = '{default-shell}';

export interface CustomSpec {
    prefix: string;
    hint?: string;
}

export interface ProgramSpec {
    commands: string[];
    custom?: CustomSpec;
}

// What the create form works with (unchanged shape): the group's first
// available command carries its row, the rest are the variants.
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

// An entry written by the earlier model — bins with optional variants and a
// {bin} placeholder — converted to a command list. Settings saved by that
// model's page persist in the user's configuration, so they must keep working.
function migrateLegacyEntry(e: Record<string, unknown>): string[] {
    const bins = Array.isArray(e.bins)
        ? e.bins.filter((b): b is string => typeof b === 'string' && b.trim() !== '').map(b => b.trim())
        : [];
    if (bins.length === 0) {
        return [];
    }
    const first = bins[0];
    const substLegacy = (s: string) => s.split('{bin}').join(first);

    const commands: string[] = [];
    const command = asString(e.command);
    if (command === '') {
        // An empty command meant "tmux's default shell", which is now the token;
        // the binaries themselves stay as explicit entries after it.
        commands.push(DEFAULT_SHELL_TOKEN, ...bins);
    } else if (command === undefined || command === '{bin}') {
        // Fallback binaries become plain entries — the new model's in-group
        // fallback does the same job.
        commands.push(...bins);
    } else {
        commands.push(substLegacy(command));
    }
    if (Array.isArray(e.variants)) {
        for (const v of e.variants) {
            const c = typeof v === 'object' && v !== null ? asString((v as Record<string, unknown>).command) : undefined;
            if (c && c.trim() !== '') {
                commands.push(substLegacy(c.trim()));
            }
        }
    }
    return commands;
}

// Configuration content is user-editable JSON, so nothing about its shape can
// be assumed. Entries without any usable command are dropped; entries in the
// earlier bins/variants shape are migrated.
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
        let commands = Array.isArray(e.commands)
            ? e.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map(c => c.trim())
            : [];
        let legacyFirstBin: string | undefined;
        if (commands.length === 0 && Array.isArray(e.bins)) {
            commands = migrateLegacyEntry(e);
            legacyFirstBin = commands.length > 0 ? asString((e.bins as unknown[])[0])?.trim() : undefined;
        }
        // Deduplicate here as well as at resolve time, so a migrated list
        // doesn't carry doubles into the settings editor.
        commands = [...new Set(commands)];
        if (commands.length === 0) {
            continue;
        }
        const spec: ProgramSpec = { commands };
        if (typeof e.custom === 'object' && e.custom !== null) {
            const prefix = asString((e.custom as Record<string, unknown>).prefix);
            if (prefix && prefix.trim() !== '') {
                const resolved = legacyFirstBin ? prefix.split('{bin}').join(legacyFirstBin) : prefix;
                const hint = asString((e.custom as Record<string, unknown>).hint);
                spec.custom = hint ? { prefix: resolved, hint } : { prefix: resolved };
            }
        }
        specs.push(spec);
    }
    return specs;
}

export function getProgramSpecs(): ProgramSpec[] {
    const config = vscode.workspace.getConfiguration('tmuxSidebar');
    const inspected = config.inspect<unknown>('programs');
    let specs = sanitizeSpecs(config.get<unknown>('programs'));

    // An override so broken that nothing survives would leave the create form
    // empty — fall back to the manifest default rather than offer nothing.
    if (specs.length === 0) {
        specs = sanitizeSpecs(inspected?.defaultValue);
    }

    // The default lists shells for every platform — powershell and cmd next
    // to the Unix ones. User settings are shared between a Windows window and
    // its WSL/SSH remotes, so one list serves them all: whatever isn't
    // installed on the machine at hand is simply not offered.
    return specs;
}

/** The binary a command starts with — what existence is checked against. */
export function binOf(command: string): string {
    return command.trim().split(/\s+/)[0] ?? '';
}

// --- Availability ----------------------------------------------------------

// Per binary: its canonical (symlink-resolved) path, or false when absent.
// The canonical path is what deduplication compares, so python and python3
// pointing at the same interpreter collapse into one entry.
const availability = new Map<string, string | false>();
let defaultShell: string | undefined;
let defaultShellReal: string | undefined;

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// Probing runs through the user's login shell — the same environment the
// attach terminal gets (`$SHELL -lc`) — so a tool whose PATH is set up in the
// profile (nvm and friends) gets its green dot too, not just a working
// terminal. The commands sent through it are POSIX; a login shell that can't
// run one (fish) makes the caller fall back to simpler per-binary checks,
// which fish handles.
function execLogin(command: string): Promise<{ stdout: string; stderr: string }> {
    if (process.platform === 'win32') {
        return exec(command);
    }
    return exec(`${process.env.SHELL || '/bin/bash'} -lc ${shq(command)}`);
}

// A command may name its binary by path rather than by PATH lookup; those are
// checked on the filesystem directly.
function isPathBin(bin: string): boolean {
    return bin.includes('/') || (process.platform === 'win32' && bin.includes('\\'));
}

async function probePathBin(bin: string): Promise<string | false> {
    try {
        if (!fs.existsSync(bin)) {
            return false;
        }
        return process.platform === 'win32' ? bin : await realpathOf(bin);
    } catch {
        return false;
    }
}

/** Resolve symlinks; the input path is returned when realpath can't. */
async function realpathOf(p: string): Promise<string> {
    if (process.platform === 'win32' || !p) {
        return p;
    }
    try {
        const { stdout } = await exec(`realpath ${shq(p)} 2>/dev/null`);
        return stdout.trim() || p;
    } catch {
        return p;
    }
}

async function probeOne(bin: string): Promise<string | false> {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await exec(`where ${bin}`);
            const first = stdout.split('\n')[0]?.trim();
            return first || false;
        }
        const { stdout } = await execLogin(`command -v ${bin}`);
        const p = stdout.trim();
        return p ? await realpathOf(p) : false;
    } catch {
        return false;
    }
}

// A PATH-looked-up binary name goes into a shell command line, so only sane
// names are probed at all; anything else is simply reported as not installed.
// (Binaries named by path bypass this — they are checked on the filesystem.)
const SAFE_BIN = /^[A-Za-z0-9._+-]+$/;

/**
 * Resolve the given binaries against the cache, probing the missing ones. On
 * Unix the missing ones are checked in a single shell pass that also resolves
 * each hit to its canonical path; Windows has no cheap equivalent, so they run
 * concurrently. The value per binary is its canonical path, or false.
 */
export async function probeBins(bins: string[]): Promise<Record<string, string | false>> {
    const unique = [...new Set(bins.map(b => b.trim()).filter(Boolean))];
    const missing = unique.filter(bin => !availability.has(bin));
    for (const bin of missing.filter(isPathBin)) {
        availability.set(bin, await probePathBin(bin));
    }
    const named = missing.filter(bin => !isPathBin(bin));
    for (const bin of named.filter(b => !SAFE_BIN.test(b))) {
        availability.set(bin, false);
    }
    const toProbe = named.filter(bin => SAFE_BIN.test(bin));

    if (toProbe.length > 0) {
        if (process.platform === 'win32') {
            await Promise.all(toProbe.map(async bin => {
                availability.set(bin, await probeOne(bin));
            }));
        } else {
            const script = `${toProbe
                .map(bin => `p=$(command -v ${bin} 2>/dev/null) && echo "${bin}=$(realpath "$p" 2>/dev/null || echo "$p")"`)
                .join('; ')}; true`;
            try {
                const { stdout } = await execLogin(script);
                const found = new Map<string, string>();
                for (const line of stdout.split('\n')) {
                    const at = line.indexOf('=');
                    if (at > 0) {
                        const name = line.slice(0, at).trim();
                        const p = line.slice(at + 1).trim();
                        if (name && p) {
                            found.set(name, p);
                        }
                    }
                }
                for (const bin of toProbe) {
                    availability.set(bin, found.get(bin) ?? false);
                }
            } catch {
                await Promise.all(toProbe.map(async bin => {
                    availability.set(bin, await probeOne(bin));
                }));
            }
        }
    }

    const result: Record<string, string | false> = {};
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
export async function getDefaultShell(): Promise<string> {
    if (defaultShell !== undefined) {
        return defaultShell;
    }
    let shell = '';
    try {
        const { stdout } = await execLogin(`${TMUX_BIN} show-options -gv default-shell`);
        shell = stdout.trim();
    } catch {
        // no server running — fall through
    }
    if (!shell) {
        shell = process.platform === 'win32' ? 'powershell' : (process.env.SHELL || '/bin/bash');
    }
    defaultShell = shell;
    return shell;
}

/** The default shell's canonical path — the dedup key for {default-shell}. */
async function getDefaultShellReal(): Promise<string> {
    if (defaultShellReal === undefined) {
        defaultShellReal = await realpathOf(await getDefaultShell());
    }
    return defaultShellReal;
}

/** Forget every probe result, so the next check hits the system again. */
export function resetAvailability(): void {
    availability.clear();
    defaultShell = undefined;
    defaultShellReal = undefined;
}

/** Every binary a spec list mentions (the default-shell token has none). */
export function allBins(specs: ProgramSpec[]): string[] {
    const bins: string[] = [];
    for (const spec of specs) {
        for (const command of spec.commands) {
            if (command !== DEFAULT_SHELL_TOKEN) {
                bins.push(binOf(command));
            }
        }
    }
    return bins;
}

/** Warm the caches in the background so the first form open is instant. */
export function warmUpPrograms(): void {
    void probeBins(allBins(getProgramSpecs()));
    void getDefaultShell();
}

// --- Resolution for the create form ----------------------------------------

/**
 * Turn the configured specs into what the create form shows. Per group: the
 * default-shell token resolves to the concrete shell tmux would start (shown
 * by name, launched by full path, never probed); every other command is kept
 * only when its binary is installed. Duplicates are dropped by canonical
 * identity — the binary's symlink-resolved path plus the arguments — so when
 * python and python3 are the same interpreter, or the default shell IS bash,
 * the double disappears; visible-label duplicates are dropped too. The first
 * surviving command fronts the group; a group where nothing survives is
 * hidden.
 */
export async function resolvePrograms(specs: ProgramSpec[]): Promise<ProgramData[]> {
    const installed = await probeBins(allBins(specs));
    const shell = await getDefaultShell();
    const shellLabel = path.basename(shell);
    const shellReal = await getDefaultShellReal();

    const out: ProgramData[] = [];
    for (const spec of specs) {
        const variants: Variant[] = [];
        const seen = new Set<string>();
        const seenLabels = new Set<string>();
        for (const command of spec.commands) {
            let variant: Variant;
            let key: string;
            if (command === DEFAULT_SHELL_TOKEN) {
                variant = { label: shellLabel, command: shell };
                key = shellReal;
            } else {
                const real = installed[binOf(command)];
                if (!real) {
                    continue;
                }
                const args = command.trim().slice(binOf(command).length).trim();
                variant = { label: command, command };
                key = args ? `${real} ${args}` : real;
            }
            if (seen.has(key) || seenLabels.has(variant.label)) {
                continue;
            }
            seen.add(key);
            seenLabels.add(variant.label);
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
