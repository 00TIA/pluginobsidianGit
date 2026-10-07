import * as path from 'path';

/**
 * Environment handling for the git child processes.
 *
 * Goals:
 * - git (and ssh, and credential helpers) must never ask anything interactively:
 *   credentials come from ssh-agent / SSH keys or from the configured credential helper;
 * - git must be reachable even when Obsidian was started with a minimal PATH
 *   (macOS Dock / Finder), together with the tools git itself spawns (git-lfs, gh, ...);
 * - git messages must be in English so errors can be classified reliably.
 *
 * simple-git (v4+) strips ambient `GIT_*` variables and rejects guarded keys supplied
 * through `.env()` unless they are explicitly allowed, so the environment is filtered
 * here and the allowed keys are reported back to the caller.
 */

/** Ambient variables that could start an editor, a pager or a password prompt. */
const DROPPED_KEYS = new Set([
	'git_askpass',
	'ssh_askpass',
	'editor',
	'visual',
	'git_editor',
	'git_sequence_editor',
	'pager',
	'git_pager',
	'prefix',
	'language',
	'lc_all',
	'gcm_interactive',
	'ssh_askpass_require',
]);

/** `GIT_*` variables describing the user's own setup that are safe to forward. */
const FORWARDED_GIT_KEYS = new Set([
	'git_ssh',
	'git_ssh_command',
	'git_ssh_variant',
	'git_config_global',
	'git_config_system',
	'git_config_nosystem',
	'git_author_name',
	'git_author_email',
	'git_committer_name',
	'git_committer_email',
	'git_ssl_cainfo',
	'git_ssl_capath',
	'git_ssl_cert',
	'git_ssl_key',
	'git_ssl_no_verify',
]);

/** SSH command used when the user has not configured one: never prompt for passphrases or host keys. */
export const BATCH_SSH_COMMAND = 'ssh -o BatchMode=yes';

/**
 * `-c` options added to every git invocation.
 * An empty `core.askPass` stops git from falling back to `SSH_ASKPASS` (a GUI prompt on many
 * Linux desktops); `credential.interactive=false` is honoured by git >= 2.46 and by
 * Git Credential Manager.
 */
export const NON_INTERACTIVE_CONFIG = [
	'core.askPass=',
	'credential.interactive=false',
	'core.quotePath=false',
];

export interface GitEnvOptions {
	/** Absolute path of the git executable, its folder is appended to PATH. */
	gitPath?: string;
	/** Extra folders to append to PATH (well-known install locations). */
	extraPathDirs?: string[];
	/** Force `GIT_SSH_COMMAND` (used when the user has no SSH command of their own). */
	sshCommand?: string;
	platform?: NodeJS.Platform;
}

export interface GitEnv {
	env: Record<string, string>;
	/** Keys that simple-git must be told to accept. */
	allowEnvironment: string[];
}

function isGuardedBySimpleGit(lowerKey: string): boolean {
	return (
		lowerKey.startsWith('git_') ||
		['editor', 'pager', 'prefix', 'ssh_askpass', 'visual'].includes(lowerKey)
	);
}

export function hasUserSshCommand(baseEnv: NodeJS.ProcessEnv): boolean {
	return Object.keys(baseEnv).some((key) => {
		const lower = key.toLowerCase();
		return (lower === 'git_ssh' || lower === 'git_ssh_command') && !!baseEnv[key];
	});
}

/** Finds the PATH key preserving its original casing (`Path` on Windows). */
function pathKeyOf(env: Record<string, string>, platform: NodeJS.Platform): string {
	if (platform === 'win32') {
		return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
	}
	return 'PATH';
}

/** Appends folders to a PATH value, dropping empty and duplicate entries. */
export function augmentPath(
	currentPath: string | undefined,
	append: string[],
	platform: NodeJS.Platform,
): string {
	const delimiter = platform === 'win32' ? ';' : ':';
	const seen = new Set<string>();
	const result: string[] = [];
	const add = (dir: string) => {
		const trimmed = dir.trim();
		if (!trimmed) return;
		const key = platform === 'win32' ? trimmed.toLowerCase() : trimmed;
		if (seen.has(key)) return;
		seen.add(key);
		result.push(trimmed);
	};
	(currentPath ?? '').split(delimiter).forEach(add);
	append.forEach(add);
	return result.join(delimiter);
}

export function buildGitEnv(baseEnv: NodeJS.ProcessEnv, options: GitEnvOptions = {}): GitEnv {
	const platform = options.platform ?? process.platform;
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(baseEnv)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (DROPPED_KEYS.has(lower)) continue;
		if (isGuardedBySimpleGit(lower) && !FORWARDED_GIT_KEYS.has(lower)) continue;
		env[key] = value;
	}

	const pathKey = pathKeyOf(env, platform);
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const gitDir =
		options.gitPath && pathApi.isAbsolute(options.gitPath) ? [pathApi.dirname(options.gitPath)] : [];
	// Appended, not prepended: the user's PATH order wins, the extra folders only fill the gaps
	// (e.g. /opt/homebrew/bin missing when Obsidian is started from the macOS Dock).
	env[pathKey] = augmentPath(env[pathKey], [...gitDir, ...(options.extraPathDirs ?? [])], platform);

	Object.assign(env, {
		// git: never read credentials from the terminal
		GIT_TERMINAL_PROMPT: '0',
		// Git Credential Manager: only use stored credentials, never open a window
		GCM_INTERACTIVE: 'never',
		// OpenSSH >= 8.4: never use an askpass program
		SSH_ASKPASS_REQUIRE: 'never',
		// English messages, so errors can be recognised
		LC_ALL: 'C',
		// The periodic `git status` must not take index.lock and break concurrent git commands
		GIT_OPTIONAL_LOCKS: '0',
	});
	if (options.sshCommand) {
		env.GIT_SSH_COMMAND = options.sshCommand;
	}

	const allowEnvironment = Object.keys(env).filter((key) =>
		isGuardedBySimpleGit(key.toLowerCase()),
	);
	return { env, allowEnvironment };
}
