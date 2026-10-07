import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Finds a working git executable.
 *
 * Obsidian started from the macOS Dock (or from a desktop launcher on Linux) does not
 * inherit the PATH of the user's shell, so `git` installed with Homebrew, MacPorts, Nix
 * etc. is not found by a plain PATH lookup. The search order is:
 *   1. the path configured in the settings (no fallback: an explicit choice must work);
 *   2. the folders in PATH;
 *   3. well-known install locations for the current OS;
 *   4. (macOS/Linux) the PATH of a login shell.
 */

export type GitSource = 'settings' | 'path' | 'known-location' | 'login-shell';

export interface GitLocation {
	path: string;
	version: string;
	source: GitSource;
}

export interface LocateGitOptions {
	configuredPath?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homedir?: string;
	/** Disable the login shell lookup (tests). */
	useLoginShell?: boolean;
}

export class GitNotFoundError extends Error {
	constructor(
		message: string,
		readonly tried: string[],
		readonly configuredPath?: string,
	) {
		super(message);
		this.name = 'GitNotFoundError';
	}
}

const VERSION_TIMEOUT_MS = 5000;
const SHELL_TIMEOUT_MS = 5000;

function pathModule(platform: NodeJS.Platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

/** Well-known folders containing git for each OS (they may not exist). */
export function knownGitDirs(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	homedir: string = os.homedir(),
): string[] {
	const p = pathModule(platform);
	if (platform === 'win32') {
		const roots = [
			envValue(env, 'ProgramFiles'),
			envValue(env, 'ProgramW6432'),
			envValue(env, 'ProgramFiles(x86)'),
			'C:\\Program Files',
		].filter((root): root is string => !!root);
		const localAppData = envValue(env, 'LOCALAPPDATA') ?? p.join(homedir, 'AppData', 'Local');
		const userProfile = envValue(env, 'USERPROFILE') ?? homedir;
		return [
			...roots.map((root) => p.join(root, 'Git', 'cmd')),
			p.join(localAppData, 'Programs', 'Git', 'cmd'),
			p.join(userProfile, 'scoop', 'shims'),
			p.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd'),
		];
	}
	const nix = [
		p.join(homedir, '.nix-profile', 'bin'),
		'/nix/var/nix/profiles/default/bin',
		'/run/current-system/sw/bin',
	];
	if (platform === 'darwin') {
		return [
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/opt/local/bin',
			...nix,
			'/Library/Developer/CommandLineTools/usr/bin',
			'/Applications/Xcode.app/Contents/Developer/usr/bin',
			'/usr/bin',
		];
	}
	return [
		'/usr/bin',
		'/usr/local/bin',
		'/bin',
		'/snap/bin',
		...nix,
		'/home/linuxbrew/.linuxbrew/bin',
		p.join(homedir, '.linuxbrew', 'bin'),
		p.join(homedir, '.local', 'bin'),
	];
}

export function gitExecutableName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'git.exe' : 'git';
}

/** Ordered, de-duplicated list of candidate executables (PATH first, then known folders). */
export function candidateGitPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	homedir: string = os.homedir(),
): { path: string; source: GitSource }[] {
	const p = pathModule(platform);
	const exe = gitExecutableName(platform);
	const delimiter = platform === 'win32' ? ';' : ':';
	const seen = new Set<string>();
	const result: { path: string; source: GitSource }[] = [];
	const add = (dir: string, source: GitSource) => {
		if (!dir || !p.isAbsolute(dir)) return;
		const candidate = p.join(dir, exe);
		const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
		if (seen.has(key)) return;
		seen.add(key);
		result.push({ path: candidate, source });
	};
	(envValue(env, 'PATH') ?? '').split(delimiter).forEach((dir) => add(dir.trim(), 'path'));
	knownGitDirs(platform, env, homedir).forEach((dir) => add(dir, 'known-location'));
	return result;
}

export function expandHome(input: string, homedir: string = os.homedir()): string {
	if (input === '~') return homedir;
	if (input.startsWith('~/') || input.startsWith('~\\')) {
		return path.join(homedir, input.slice(2));
	}
	return input;
}

function isExecutableFile(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function run(
	file: string,
	args: string[],
	timeout: number,
	env?: NodeJS.ProcessEnv,
): Promise<string | null> {
	return new Promise((resolve) => {
		try {
			execFile(
				file,
				args,
				{ timeout, windowsHide: true, env, encoding: 'utf8' },
				(error, stdout) => resolve(error ? null : stdout),
			);
		} catch {
			resolve(null);
		}
	});
}

/** Returns the output of `git --version`, or null if the binary does not work. */
export async function gitVersion(binary: string): Promise<string | null> {
	const output = await run(binary, ['--version'], VERSION_TIMEOUT_MS);
	const version = output?.trim();
	return version && /^git version /i.test(version) ? version : null;
}

/**
 * On macOS `/usr/bin/git` is a stub: when the Command Line Tools are missing, running it
 * opens the "install developer tools" dialog. Use it only when the tools are installed.
 */
let macToolsCache: boolean | undefined;
async function macDeveloperToolsInstalled(): Promise<boolean> {
	if (macToolsCache !== undefined) return macToolsCache;
	const output = await run('/usr/bin/xcode-select', ['-p'], VERSION_TIMEOUT_MS);
	const dir = output?.trim();
	macToolsCache = !!dir && isExecutableFile(path.join(dir, 'usr', 'bin', 'git'));
	return macToolsCache;
}

async function isUsableCandidate(file: string, platform: NodeJS.Platform): Promise<boolean> {
	if (!isExecutableFile(file)) return false;
	if (platform === 'darwin' && file === '/usr/bin/git') {
		return macDeveloperToolsInstalled();
	}
	return true;
}

async function gitFromLoginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
	const shell = envValue(env, 'SHELL') || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
	const output = await run(shell, ['-lc', 'command -v git'], SHELL_TIMEOUT_MS, env);
	const lines = (output ?? '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => path.isAbsolute(line));
	return lines[lines.length - 1] ?? null;
}

export async function locateGit(options: LocateGitOptions = {}): Promise<GitLocation> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const homedir = options.homedir ?? os.homedir();
	const configured = options.configuredPath?.trim();

	if (configured) {
		const expanded = expandHome(configured, homedir);
		// A bare name ("git") is resolved through PATH by the OS.
		const usable = !path.isAbsolute(expanded) || (await isUsableCandidate(expanded, platform));
		const version = usable ? await gitVersion(expanded) : null;
		if (version) return { path: expanded, version, source: 'settings' };
		throw new GitNotFoundError(
			`The configured git executable does not work: ${expanded}`,
			[expanded],
			expanded,
		);
	}

	const tried: string[] = [];
	for (const candidate of candidateGitPaths(platform, env, homedir)) {
		if (!(await isUsableCandidate(candidate.path, platform))) continue;
		tried.push(candidate.path);
		const version = await gitVersion(candidate.path);
		if (version) return { path: candidate.path, version, source: candidate.source };
	}

	if (platform !== 'win32' && options.useLoginShell !== false) {
		const fromShell = await gitFromLoginShell(env, platform);
		if (fromShell && !tried.includes(fromShell)) {
			tried.push(fromShell);
			if (await isUsableCandidate(fromShell, platform)) {
				const version = await gitVersion(fromShell);
				if (version) return { path: fromShell, version, source: 'login-shell' };
			}
		}
	}

	throw new GitNotFoundError('No working git executable found', tried);
}

/** Existing well-known folders, appended to PATH for the processes started by git. */
export function existingKnownGitDirs(): string[] {
	return knownGitDirs().filter((dir) => {
		try {
			return fs.statSync(dir).isDirectory();
		} catch {
			return false;
		}
	});
}
