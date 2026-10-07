import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { classifyGitError, errorText } from './errors';
import { BATCH_SSH_COMMAND, buildGitEnv, hasUserSshCommand, NON_INTERACTIVE_CONFIG } from './git-env';

/**
 * Git operations on the vault, built on simple-git.
 * This module has no dependency on the Obsidian API so it can be tested with plain Node.
 */

export interface GitServiceOptions {
	vaultPath: string;
	/** Path (or name) of the git executable. */
	gitPath: string;
	/** Environment to start from, defaults to `process.env`. */
	baseEnv?: NodeJS.ProcessEnv;
	/** Folders appended to PATH for the processes started by git. */
	extraPathDirs?: string[];
	/** A network command is killed after this many ms without output. */
	networkTimeoutMs?: number;
	/** A local command is killed after this many ms without output. */
	localTimeoutMs?: number;
}

export interface RepoInfo {
	root: string;
	gitDir: string;
	/** False when the vault is a sub-folder of a larger repository. */
	vaultIsRoot: boolean;
}

export interface RepoStatus {
	/** Current branch, null when HEAD is detached. */
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	/** Changed, added, deleted and untracked files inside the vault. */
	changedFiles: number;
	conflicted: string[];
	/** A merge is in progress (MERGE_HEAD exists). */
	merging: boolean;
}

export type CommitOutcome =
	| { kind: 'committed'; files: number; message: string }
	| { kind: 'nothing-to-commit' }
	| { kind: 'merge-in-progress'; files: string[] }
	| { kind: 'unresolved-conflicts'; files: string[] };

export type PullOutcome =
	| { kind: 'pulled'; files: number }
	| { kind: 'up-to-date' }
	| { kind: 'conflicts'; files: string[] }
	| { kind: 'unresolved-conflicts'; files: string[] }
	| { kind: 'no-remote' }
	| { kind: 'no-upstream'; branch: string }
	| { kind: 'detached' };

export type PushOutcome =
	| { kind: 'pushed'; commits: number | null; remote: string; branch: string; setUpstream: boolean }
	| { kind: 'up-to-date' }
	| { kind: 'unresolved-conflicts'; files: string[] }
	| { kind: 'no-remote' }
	| { kind: 'no-commits' }
	| { kind: 'detached' };

export interface SyncOutcome {
	commit: CommitOutcome;
	pull?: PullOutcome;
	push?: PushOutcome;
}

/**
 * A sync step failed after the previous ones succeeded (e.g. the commit was created but the
 * pull failed). Keeps git's message, so the error can still be classified.
 */
export class SyncError extends Error {
	constructor(
		readonly step: 'pull' | 'push',
		readonly completed: SyncOutcome,
		readonly cause: unknown,
	) {
		super(errorText(cause));
		this.name = 'SyncError';
	}
}

export interface CommitOptions {
	/**
	 * Allow concluding a merge whose conflicts were resolved by hand.
	 * Automatic backups never do it.
	 */
	concludeMerge?: boolean;
}

interface RemoteTarget {
	remote: string;
	branch: string;
	/** The branch already has an upstream configured. */
	tracking: boolean;
}

export type CommitMessage = string | ((changedFiles: number) => string);

const DEFAULT_NETWORK_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_LOCAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MARKER_SCAN_BYTES = 5 * 1024 * 1024;

/** .gitignore created by `init`; `configDir` is Obsidian's configuration folder (`Vault#configDir`). */
export function defaultGitignore(configDir: string): string {
	return [
		'# Obsidian: stato dell\'interfaccia, cambia di continuo',
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		'',
		'# Cestino di Obsidian',
		'.trash/',
		'',
		'# File di sistema',
		'.DS_Store',
		'Thumbs.db',
		'',
	].join('\n');
}

/** True when a file still contains git conflict markers. */
export function hasConflictMarkers(content: string): boolean {
	return /^(<{7}|>{7})( |\r?$)/m.test(content);
}

function realPath(target: string): string {
	try {
		return fs.realpathSync.native(target);
	} catch {
		return path.resolve(target);
	}
}

export function samePath(a: string, b: string): boolean {
	const left = realPath(a);
	const right = realPath(b);
	return process.platform === 'win32' || process.platform === 'darwin'
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}

function lines(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export class GitService {
	private repo: RepoInfo | null = null;

	constructor(private readonly options: GitServiceOptions) {}

	get vaultPath(): string {
		return this.options.vaultPath;
	}

	get gitPath(): string {
		return this.options.gitPath;
	}

	get repository(): RepoInfo | null {
		return this.repo;
	}

	private client(kind: 'local' | 'network' = 'local', sshCommand?: string): SimpleGit {
		const { env, allowEnvironment } = buildGitEnv(this.options.baseEnv ?? process.env, {
			gitPath: this.options.gitPath,
			extraPathDirs: this.options.extraPathDirs,
			sshCommand,
		});
		const block =
			kind === 'network'
				? (this.options.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS)
				: (this.options.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS);
		return simpleGit({
			baseDir: this.options.vaultPath,
			binary: this.options.gitPath,
			maxConcurrentProcesses: 1,
			config: NON_INTERACTIVE_CONFIG,
			allowEnvironment,
			unsafe: {
				// the binary comes from the user's settings or from our own lookup and may contain spaces
				allowUnsafeCustomBinary: true,
				// `core.askPass=` (empty) is how prompts are disabled
				allowUnsafeAskPass: true,
				// forward the user's own GIT_SSH / GIT_SSH_COMMAND / GIT_CONFIG_GLOBAL
				allowUnsafeSshCommand: true,
				allowUnsafeConfigPaths: true,
			},
			timeout: { block },
		}).env(env);
	}

	/**
	 * Client for commands that talk to a remote. When the user has no SSH command of
	 * their own, ssh runs in batch mode: it never asks for passphrases or host keys.
	 */
	private async networkClient(): Promise<SimpleGit> {
		const baseEnv = this.options.baseEnv ?? process.env;
		const userSsh = hasUserSshCommand(baseEnv) || !!(await this.config('core.sshCommand'));
		return this.client('network', userSsh ? undefined : BATCH_SSH_COMMAND);
	}

	private async config(key: string): Promise<string | null> {
		try {
			const value = (await this.client().raw(['config', '--get', key])).trim();
			return value || null;
		} catch {
			return null;
		}
	}

	async version(): Promise<string> {
		return (await this.client().raw(['--version'])).trim();
	}

	/** Detects the repository containing the vault; null when there is none. */
	async detectRepository(): Promise<RepoInfo | null> {
		try {
			const output = await this.client().raw(['rev-parse', '--show-toplevel', '--absolute-git-dir']);
			const [root, gitDir] = lines(output);
			this.repo =
				root && gitDir
					? {
							root: path.resolve(root),
							gitDir: path.resolve(gitDir),
							vaultIsRoot: samePath(root, this.options.vaultPath),
						}
					: null;
		} catch (error) {
			if (classifyGitError(error) !== 'not-repo') throw error;
			this.repo = null;
		}
		return this.repo;
	}

	private async requireRepo(): Promise<RepoInfo> {
		const repo = this.repo ?? (await this.detectRepository());
		if (!repo) throw new Error('fatal: not a git repository');
		return repo;
	}

	/** Creates a repository in the vault, with a .gitignore suited to Obsidian. */
	async init(configDir: string): Promise<RepoInfo> {
		const git = this.client();
		const defaultBranch = await this.config('init.defaultBranch');
		if (defaultBranch) {
			await git.raw(['init']);
		} else {
			try {
				await git.raw(['init', '--initial-branch=main']);
			} catch {
				// git < 2.28 has no --initial-branch
				await git.raw(['init']);
			}
		}
		const gitignore = path.join(this.options.vaultPath, '.gitignore');
		if (!fs.existsSync(gitignore)) {
			await fs.promises.writeFile(gitignore, defaultGitignore(configDir), 'utf8');
		}
		const repo = await this.detectRepository();
		if (!repo) throw new Error('fatal: not a git repository (init failed)');
		return repo;
	}

	async status(): Promise<RepoStatus> {
		const repo = await this.requireRepo();
		const result = await this.client().status(['--', '.']);
		return {
			branch: result.detached ? null : result.current,
			upstream: result.tracking,
			ahead: result.ahead,
			behind: result.behind,
			changedFiles: result.files.length,
			conflicted: result.conflicted,
			merging: fs.existsSync(path.join(repo.gitDir, 'MERGE_HEAD')),
		};
	}

	/** Conflicted files that still contain conflict markers. */
	async filesWithConflictMarkers(files: string[]): Promise<string[]> {
		const repo = await this.requireRepo();
		const result: string[] = [];
		for (const file of files) {
			try {
				const handle = await fs.promises.open(path.join(repo.root, file), 'r');
				try {
					const buffer = Buffer.alloc(MAX_MARKER_SCAN_BYTES);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					if (hasConflictMarkers(buffer.subarray(0, bytesRead).toString('utf8'))) {
						result.push(file);
					}
				} finally {
					await handle.close();
				}
			} catch {
				// deleted on one side: nothing to scan
			}
		}
		return result;
	}

	private async head(): Promise<string | null> {
		const output = await this.client().raw(['rev-parse', '-q', '--verify', 'HEAD']);
		return output.trim() || null;
	}

	/** Stages every change inside the vault and commits it. */
	async commit(message: CommitMessage, options: CommitOptions = {}): Promise<CommitOutcome> {
		const repo = await this.requireRepo();
		const status = await this.status();
		if (status.merging || status.conflicted.length) {
			if (!options.concludeMerge) {
				return { kind: 'merge-in-progress', files: status.conflicted };
			}
			const unresolved = await this.filesWithConflictMarkers(status.conflicted);
			if (unresolved.length) return { kind: 'unresolved-conflicts', files: unresolved };
		}
		if (!status.changedFiles && !status.merging) return { kind: 'nothing-to-commit' };

		const git = this.client();
		await git.raw(['add', '--all', '--', '.']);
		const text = typeof message === 'function' ? message(status.changedFiles) : message;
		const before = await this.head();
		const args = ['commit', '-m', text];
		// In a parent repository commit only the vault (not possible while merging).
		if (!repo.vaultIsRoot && !status.merging) args.push('--', '.');
		await git.raw(args);
		const after = await this.head();
		if (after === before) return { kind: 'nothing-to-commit' };
		return { kind: 'committed', files: status.changedFiles, message: text };
	}

	private async remoteTarget(branch: string): Promise<RemoteTarget | null> {
		const remotes = lines(await this.client().raw(['remote']));
		if (!remotes.length) return null;
		const remote = await this.config(`branch.${branch}.remote`);
		const merge = await this.config(`branch.${branch}.merge`);
		if (remote && remote !== '.' && merge && remotes.includes(remote)) {
			return { remote, branch: merge.replace(/^refs\/heads\//, ''), tracking: true };
		}
		return { remote: remotes.includes('origin') ? 'origin' : remotes[0]!, branch, tracking: false };
	}

	private async remoteBranchExists(git: SimpleGit, target: RemoteTarget): Promise<boolean> {
		const output = await git.raw([
			'ls-remote',
			'--exit-code',
			'--heads',
			target.remote,
			`refs/heads/${target.branch}`,
		]);
		return output.trim().length > 0;
	}

	/** Merges the remote branch (never rebases). Stops at the first conflict. */
	async pull(): Promise<PullOutcome> {
		const status = await this.status();
		if (status.merging || status.conflicted.length) {
			return { kind: 'unresolved-conflicts', files: status.conflicted };
		}
		if (!status.branch) return { kind: 'detached' };
		const target = await this.remoteTarget(status.branch);
		if (!target) return { kind: 'no-remote' };

		const git = await this.networkClient();
		const args = ['pull', '--no-rebase', '--no-edit', '--progress'];
		if (!target.tracking) {
			if (!(await this.remoteBranchExists(git, target))) {
				return { kind: 'no-upstream', branch: status.branch };
			}
			args.push(target.remote, target.branch);
		}

		const before = await this.head();
		try {
			await git.raw(args);
		} catch (error) {
			const after = await this.status();
			if (after.conflicted.length) return { kind: 'conflicts', files: after.conflicted };
			throw error;
		}
		const after = await this.head();
		if (after === before) return { kind: 'up-to-date' };
		const files =
			before && after
				? lines(await this.client().raw(['diff', '--name-only', before, after])).length
				: 0;
		return { kind: 'pulled', files };
	}

	private async commitsAheadOfUpstream(): Promise<number | null> {
		try {
			const output = await this.client().raw(['rev-list', '--count', '@{upstream}..HEAD']);
			const count = Number.parseInt(output.trim(), 10);
			return Number.isNaN(count) ? null : count;
		} catch {
			// upstream configured but not fetched yet, or deleted on the remote
			return null;
		}
	}

	/** Pushes the current branch; sets the upstream the first time. */
	async push(): Promise<PushOutcome> {
		const status = await this.status();
		if (status.merging || status.conflicted.length) {
			return { kind: 'unresolved-conflicts', files: status.conflicted };
		}
		if (!status.branch) return { kind: 'detached' };
		if (!(await this.head())) return { kind: 'no-commits' };
		const target = await this.remoteTarget(status.branch);
		if (!target) return { kind: 'no-remote' };

		let commits: number | null = null;
		if (target.tracking) {
			commits = await this.commitsAheadOfUpstream();
			if (commits === 0) return { kind: 'up-to-date' };
		}
		const git = await this.networkClient();
		const args = ['push', '--progress'];
		if (!target.tracking) args.push('--set-upstream');
		args.push(target.remote, `HEAD:refs/heads/${target.branch}`);
		await git.raw(args);
		return {
			kind: 'pushed',
			commits,
			remote: target.remote,
			branch: target.branch,
			setUpstream: !target.tracking,
		};
	}

	/** Commit + pull + push. Stops without pushing when the pull produces conflicts. */
	async sync(message: CommitMessage, options: CommitOptions = {}): Promise<SyncOutcome> {
		const commit = await this.commit(message, options);
		if (commit.kind === 'merge-in-progress' || commit.kind === 'unresolved-conflicts') {
			return { commit };
		}
		let pull: PullOutcome;
		try {
			pull = await this.pull();
		} catch (error) {
			throw new SyncError('pull', { commit }, error);
		}
		if (pull.kind !== 'pulled' && pull.kind !== 'up-to-date' && pull.kind !== 'no-upstream') {
			return { commit, pull };
		}
		try {
			return { commit, pull, push: await this.push() };
		} catch (error) {
			throw new SyncError('push', { commit, pull }, error);
		}
	}
}
