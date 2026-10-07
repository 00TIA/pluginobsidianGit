import { FileSystemAdapter, Menu, moment, TFile } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_DATE_FORMAT, renderCommitMessage } from './commit-message';
import { classifyGitError, errorText, gitErrorDetail } from './git/errors';
import {
	CommitOutcome,
	GitService,
	Identity,
	isValidRemoteUrl,
	LargeFile,
	PullOutcome,
	RemoteInfo,
	RepoStatus,
	SyncError,
	SyncOutcome,
} from './git/git-service';
import { existingKnownGitDirs, GitLocation, GitNotFoundError, locateGit } from './git/locate-git';
import type VaultGitPlugin from './main';
import {
	conflictNoticeLines,
	describeCommit,
	describePull,
	describePush,
	errorMessage,
	fileList,
	largeFilesLines,
	SETTINGS_PATH,
	shouldShowDetail,
	unresolvedConflictsText,
} from './messages';
import { CommitMessageModal } from './ui/commit-modal';
import { choose } from './ui/choice-modal';
import { NOTICE_LONG, NOTICE_SHORT, NOTICE_STICKY, NoticeAction, showNotice } from './ui/notices';
import type { SetupProgress } from './setup-guide';
import type { GitStatusBar } from './ui/status-bar';
import type { StatusBarState } from './ui/status-text';

type ControllerState = 'checking' | 'no-git' | 'not-repo' | 'ready' | 'error';

/**
 * Who started the operation:
 * - `manual`: the user (every outcome gets a notice);
 * - `auto`: the automatic backup (quiet, notices de-duplicated across runs);
 * - `startup`: the pull on startup (quiet unless something happened).
 */
type Mode = 'manual' | 'auto' | 'startup';

interface RunOptions {
	/** The operation needs an existing repository (false only for init). */
	needsRepo?: boolean;
}

export interface RepositorySettings {
	/** False when Git is missing or the vault is not a repository. */
	available: boolean;
	reason?: string;
	remote?: RemoteInfo | null;
	identity?: Identity;
}

/**
 * Connects the Git service to Obsidian: serialises operations, keeps the status bar
 * up to date and turns results and errors into notices.
 */
export class GitController {
	private state: ControllerState = 'checking';
	private stateMessage = '';
	private service: GitService | null = null;
	private location: GitLocation | null = null;
	private locateError: GitNotFoundError | null = null;
	private setupPromise: Promise<void> | null = null;
	private refreshPromise: Promise<void> | null = null;
	private running: string | null = null;
	private lastStatus: RepoStatus | null = null;
	/** Last state shown (never `busy`), for the Git panel. */
	private lastState: StatusBarState = { kind: 'checking' };
	private readonly listeners = new Set<() => void>();
	/** Situation last reported by the automatic backup, to avoid repeating it at every run. */
	private lastAutoNotice: string | null = null;
	/** Large files last reported by the automatic backup (separate from errors and conflicts). */
	private lastLargeFilesNotice: string | null = null;

	constructor(
		private readonly plugin: VaultGitPlugin,
		private readonly statusBar: GitStatusBar,
	) {}

	private get app() {
		return this.plugin.app;
	}

	private vaultPath(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	/** First check at startup: warns when Git is missing or the vault is not a repository. */
	async start(): Promise<void> {
		await this.setup();
		if (this.state === 'no-git') this.notifyGitMissing();
		else if (this.state === 'not-repo') this.notifyNotRepo();
		else if (this.state === 'error') showNotice(this.stateMessage, { duration: NOTICE_LONG });
		else if (this.state === 'ready' && this.plugin.settings.pullOnStartup) await this.pullOnStartup();
	}

	/** (Re)locates Git and detects the repository; safe to call concurrently. */
	setup(): Promise<void> {
		this.setupPromise ??= this.doSetup().finally(() => (this.setupPromise = null));
		return this.setupPromise;
	}

	private async doSetup(): Promise<void> {
		this.state = 'checking';
		this.renderState();
		const vaultPath = this.vaultPath();
		if (!vaultPath) {
			this.service = null;
			this.state = 'error';
			this.stateMessage = 'The vault is not on a local file system: Git cannot be used.';
			this.renderState();
			return;
		}

		try {
			this.location = await locateGit({ configuredPath: this.plugin.settings.gitPath });
			this.locateError = null;
		} catch (error) {
			if (!(error instanceof GitNotFoundError)) console.error('[vault-git-sync] git lookup failed', error);
			this.location = null;
			this.service = null;
			this.locateError =
				error instanceof GitNotFoundError ? error : new GitNotFoundError(errorText(error), []);
			this.state = 'no-git';
			this.renderState();
			return;
		}

		this.service = new GitService({
			vaultPath,
			gitPath: this.location.path,
			extraPathDirs: existingKnownGitDirs(),
		});
		try {
			const repo = await this.service.detectRepository();
			this.state = repo ? 'ready' : 'not-repo';
		} catch (error) {
			console.error('[vault-git-sync] repository detection failed', error);
			this.state = 'error';
			this.stateMessage = this.errorLines(error).join(' ');
		}
		this.renderState();
		await this.refreshStatus();
	}

	/** Lines shown in the settings tab about the Git executable in use. */
	describeGit(): { lines: string[]; warning: boolean } {
		if (this.state === 'checking' && !this.location) {
			return { lines: ['Looking for Git…'], warning: false };
		}
		if (this.location) {
			const source = {
				settings: 'configured path',
				path: 'found in PATH',
				'known-location': 'found in a common install location',
				'login-shell': 'found through the login shell',
			}[this.location.source];
			const lines = [`${this.location.path} (${this.location.version.replace(/^git version /i, '')}, ${source})`];
			const repo = this.service?.repository;
			if (repo && !repo.vaultIsRoot) lines.push(`The vault is inside the repository ${repo.root}.`);
			if (this.state === 'not-repo') lines.push('The vault is not a Git repository yet.');
			if (this.state === 'error') lines.push(this.stateMessage);
			return { lines, warning: this.state === 'error' };
		}
		const configured = this.locateError?.configuredPath;
		return {
			lines: [
				configured
					? `The configured path is not a working Git executable: ${configured}`
					: 'Git was found neither in PATH nor in the common install locations.',
			],
			warning: true,
		};
	}

	// ----- status bar and Git panel ---------------------------------------------

	/** Renders the status bar and notifies the Git panel. */
	private show(state: StatusBarState): void {
		if (state.kind !== 'busy') this.lastState = state;
		this.statusBar.render(state);
		for (const listener of this.listeners) listener();
	}

	/** Subscribes to state changes (used by the Git panel); returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Last repository state, plus the operation running now (if any). */
	snapshot(): { state: StatusBarState; running: string | null } {
		return { state: this.lastState, running: this.running };
	}

	/** Vault-relative path of a file reported by Git (relative to the repository root). */
	vaultPathOf(repoPath: string): string | null {
		const repo = this.service?.repository;
		const vaultPath = this.vaultPath();
		if (!repo || !vaultPath) return null;
		const relative = path.relative(vaultPath, path.join(repo.root, repoPath));
		return relative.startsWith('..') ? null : relative.split(path.sep).join('/');
	}

	/** Opens a file reported by Git in the editor; false when it is not in the vault. */
	openFile(repoPath: string, newTab = false): boolean {
		const vaultPath = this.vaultPathOf(repoPath);
		const target = vaultPath ? this.app.vault.getAbstractFileByPath(vaultPath) : null;
		if (!(target instanceof TFile)) return false;
		void this.app.workspace.getLeaf(newTab ? 'tab' : false).openFile(target);
		return true;
	}

	private renderState(): void {
		if (this.running) return;
		switch (this.state) {
			case 'checking':
				this.show({ kind: 'checking' });
				break;
			case 'no-git':
				this.show({ kind: 'no-git' });
				break;
			case 'not-repo':
				this.show({ kind: 'not-repo' });
				break;
			case 'error':
				this.show({ kind: 'error', message: this.stateMessage });
				break;
			case 'ready':
				break;
		}
	}

	/** Updates the number of modified files shown in the status bar. */
	refreshStatus(): Promise<void> {
		this.refreshPromise ??= this.doRefresh().finally(() => (this.refreshPromise = null));
		return this.refreshPromise;
	}

	private async doRefresh(): Promise<void> {
		if (this.running) return;
		if (this.state !== 'ready' || !this.service) {
			this.lastStatus = null;
			this.renderState();
			return;
		}
		try {
			const status = await this.service.status();
			if (this.running) return;
			this.lastStatus = status;
			this.show({ kind: 'ready', status, updatedAt: new Date() });
		} catch (error) {
			if (this.running) return;
			this.lastStatus = null;
			if (classifyGitError(error) === 'not-repo') {
				// the .git folder was removed while Obsidian was running
				this.state = 'not-repo';
				this.renderState();
				return;
			}
			this.show({ kind: 'error', message: this.errorLines(error).join(' ') });
		}
	}

	showMenu(event: MouseEvent): void {
		const menu = new Menu();
		if (this.state === 'not-repo') {
			menu.addItem((item) =>
				item.setTitle('Initialize repository').setIcon('git-branch').onClick(() => void this.initRepository()),
			);
		} else {
			menu.addItem((item) => item.setTitle('Commit').setIcon('git-commit').onClick(() => void this.commit()));
			menu.addItem((item) =>
				item.setTitle('Commit with message…').setIcon('pencil').onClick(() => void this.commitWithMessage()),
			);
			menu.addItem((item) => item.setTitle('Pull').setIcon('download').onClick(() => void this.pull()));
			menu.addItem((item) => item.setTitle('Push').setIcon('upload').onClick(() => void this.push()));
			menu.addItem((item) => item.setTitle('Sync').setIcon('refresh-cw').onClick(() => void this.sync()));
			if (this.lastStatus?.merging) {
				menu.addItem((item) =>
					item.setTitle('Abort merge').setIcon('undo-2').onClick(() => void this.abortMerge()),
				);
			}
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Refresh status').setIcon('rotate-cw').onClick(() => void this.setup()),
		);
		menu.showAtMouseEvent(event);
	}

	// ----- operations ---------------------------------------------------------

	private commitMessage(changedFiles: number): string {
		const settings = this.plugin.settings;
		return renderCommitMessage(settings.commitMessage, {
			date: moment().format(settings.dateFormat || DEFAULT_DATE_FORMAT),
			hostname: os.hostname(),
			numFiles: changedFiles,
		});
	}

	async commit(): Promise<void> {
		const exclude = await this.confirmLargeFiles();
		if (!exclude) return;
		await this.run('commit', 'manual', async (service) => {
			const outcome = await service.commit((n) => this.commitMessage(n), { concludeMerge: true, exclude });
			this.notifyCommit(outcome, exclude);
		});
	}

	async commitWithMessage(): Promise<void> {
		const exclude = await this.confirmLargeFiles();
		if (!exclude) return;
		const status = await this.currentStatus();
		if (!status) return;
		const files = Math.max(0, status.changedFiles - exclude.length);
		if (!files && !status.merging) {
			showNotice('Nothing to commit.');
			return;
		}
		new CommitMessageModal(this.app, this.commitMessage(files), files, (message) => {
			void this.run('commit', 'manual', async (service) => {
				const outcome = await service.commit(message, { concludeMerge: true, exclude });
				this.notifyCommit(outcome, exclude);
			});
		}).open();
	}

	private largeFileLimitBytes(): number {
		return this.plugin.settings.largeFileLimitMb * 1024 * 1024;
	}

	/**
	 * Before a manual commit: asks what to do with large files not tracked by Git LFS.
	 * Returns the files to leave out, or null when the user cancelled (or Git is not ready).
	 */
	private async confirmLargeFiles(): Promise<string[] | null> {
		const limit = this.largeFileLimitBytes();
		if (!limit) return [];
		if (this.notifyIfBusy('manual')) return null;
		const service = await this.readyService('manual', true);
		if (!service) return null;
		let large: LargeFile[];
		try {
			large = await service.largeFiles(limit);
		} catch (error) {
			this.reportError(error, 'manual');
			return null;
		}
		if (!large.length) return [];
		const choice = await choose(this.app, {
			title: 'Large files',
			lines: largeFilesLines(large, this.plugin.settings.largeFileLimitMb),
			choices: [
				{ text: 'Commit anyway', value: 'all' as const, style: 'warning' },
				{ text: 'Commit without them', value: 'exclude' as const, style: 'cta' },
			],
		});
		if (choice === 'all') return [];
		if (choice === 'exclude') return large.map((file) => file.path);
		return null;
	}

	async pull(): Promise<void> {
		await this.run('pull', 'manual', async (service) => {
			this.notifyPull(await service.pull());
		});
	}

	async push(): Promise<void> {
		await this.run('push', 'manual', async (service) => {
			const outcome = await service.push();
			showNotice(describePush(outcome), { duration: outcome.kind === 'pushed' ? NOTICE_SHORT : NOTICE_LONG });
		});
	}

	async sync(): Promise<void> {
		const exclude = await this.confirmLargeFiles();
		if (!exclude) return;
		await this.run('sync', 'manual', async (service) => {
			const outcome = await service.sync((n) => this.commitMessage(n), { concludeMerge: true, exclude });
			this.notifySync(outcome, 'manual', exclude);
		});
	}

	/** Cancels a merge left by a conflicting pull, after confirmation. */
	async abortMerge(): Promise<void> {
		const status = await this.currentStatus();
		if (!status) return;
		if (!status.merging) {
			showNotice('No merge in progress.');
			return;
		}
		const confirmed = await choose(this.app, {
			title: 'Abort merge',
			lines: [
				'The vault goes back to the state before the pull: changes made while resolving the conflicts are lost.',
				'Your commits are kept; the remote changes will be merged again at the next pull or sync.',
			],
			choices: [{ text: 'Abort merge', value: true, style: 'warning' }],
		});
		if (!confirmed) return;
		await this.run('abort merge', 'manual', async (service) => {
			const outcome = await service.abortMerge();
			showNotice(
				outcome.kind === 'aborted'
					? 'Merge aborted: the vault is back to the state before the pull.'
					: 'No merge in progress.',
			);
		});
	}

	/** Called by the automatic backup timer. */
	async autoBackup(): Promise<void> {
		await this.run('backup', 'auto', async (service) => {
			const message = (n: number) => this.commitMessage(n);
			// nobody can confirm: large files not tracked by Git LFS are left out
			const limit = this.largeFileLimitBytes();
			const large = limit ? await service.largeFiles(limit) : [];
			this.notifyLargeFilesLeftOut(large);
			const exclude = large.map((file) => file.path);
			if (this.plugin.settings.autoBackupSync) {
				this.notifySync(await service.sync(message, { exclude }), 'auto');
			} else {
				const outcome = await service.commit(message, { exclude });
				if (outcome.kind === 'merge-in-progress' || outcome.kind === 'unresolved-conflicts') {
					this.notifyAutoPaused(outcome.files);
				} else {
					this.lastAutoNotice = null;
				}
			}
		});
	}

	private async pullOnStartup(): Promise<void> {
		await this.run('pull', 'startup', async (service) => {
			const outcome = await service.pull();
			if (outcome.kind === 'conflicts') {
				this.notifyConflicts(outcome.files, 'manual');
			} else if (outcome.kind === 'pulled') {
				showNotice(['Pull on startup', describePull(outcome)]);
			} else if (outcome.kind !== 'up-to-date' && outcome.kind !== 'no-upstream') {
				showNotice(['Pull on startup skipped.', describePull(outcome)], { duration: NOTICE_LONG });
			}
		});
	}

	async initRepository(): Promise<void> {
		await this.run(
			'init',
			'manual',
			async (service) => {
				const repo = await service.init(this.app.vault.configDir);
				this.state = 'ready';
				const lines = [
					'Git repository initialized in the vault (with a .gitignore and a .gitattributes for Obsidian).',
					`Run "Commit" for the first commit. To pull and push, set the remote URL in ${SETTINGS_PATH}.`,
				];
				if (!repo.vaultIsRoot) lines.push(`Note: the vault is inside ${repo.root}.`);
				showNotice(lines, { duration: NOTICE_LONG });
			},
			{ needsRepo: false },
		);
	}

	// ----- repository settings (remote, author) ------------------------------------

	async repositorySettings(): Promise<RepositorySettings> {
		if (this.setupPromise) await this.setupPromise;
		if (this.state === 'no-git') return { available: false, reason: 'Git not found.' };
		if (this.state !== 'ready' || !this.service) {
			return {
				available: false,
				reason: 'Initialize the repository to set the remote and the author.',
			};
		}
		try {
			return {
				available: true,
				remote: await this.service.remote(),
				identity: await this.service.identity(),
			};
		} catch (error) {
			return { available: false, reason: this.errorLines(error).join(' ') };
		}
	}

	/** Which setup steps are done, for the guide in the settings. */
	async setupProgress(): Promise<SetupProgress> {
		const settings = await this.repositorySettings();
		return {
			git: this.location !== null,
			repo: settings.available,
			remote: !!settings.remote?.url,
			author: !!(settings.identity?.name && settings.identity.email),
		};
	}

	async setRemoteUrl(url: string): Promise<boolean> {
		if (!isValidRemoteUrl(url)) {
			showNotice('Enter a remote URL, e.g. git@github.com:user/vault.git or https://github.com/user/vault.git.');
			return false;
		}
		return this.run('save', 'manual', async (service) => {
			const { name, added } = await service.setRemoteUrl(url);
			showNotice(added ? `Remote "${name}" added: ${url.trim()}` : `Remote "${name}" set to ${url.trim()}`);
		});
	}

	async setIdentity(values: { name?: string; email?: string }): Promise<boolean> {
		return this.run('save', 'manual', async (service) => {
			await service.setIdentity(values);
			const { name, email } = await service.identity();
			showNotice(
				name && email
					? `Commits will be authored as ${name} <${email}>.`
					: 'Author name or email still missing: commits will fail until both are set.',
			);
		});
	}

	// ----- running operations -------------------------------------------------------

	private notifyIfBusy(mode: Mode): boolean {
		if (!this.running) return false;
		if (mode === 'manual') showNotice(`A Git operation is already running (${this.running}): try again when it is done.`);
		return true;
	}

	/** Status of the repository for operations that first ask the user something. */
	private async currentStatus(): Promise<RepoStatus | null> {
		if (this.notifyIfBusy('manual')) return null;
		const service = await this.readyService('manual', true);
		if (!service) return null;
		try {
			return await service.status();
		} catch (error) {
			this.reportError(error, 'manual');
			return null;
		}
	}

	/** Returns a service ready for the operation, or null after explaining why not. */
	private async readyService(mode: Mode, needsRepo: boolean): Promise<GitService | null> {
		if (this.setupPromise) await this.setupPromise;
		// Git may have been installed, or the repository created, from outside Obsidian
		if (this.state !== 'ready') await this.setup();

		if (this.state === 'ready' && this.service) {
			if (!needsRepo) {
				showNotice('This vault is already a Git repository.');
				return null;
			}
			return this.service;
		}
		if (this.state === 'not-repo' && this.service) {
			if (!needsRepo) return this.service;
			if (mode === 'manual') this.notifyNotRepo();
			else if (mode === 'auto') {
				this.autoNotice('not-repo', ['Automatic backup skipped: this vault is not a Git repository.']);
			}
			return null;
		}
		if (this.state === 'no-git') {
			if (mode === 'manual') this.notifyGitMissing();
			else if (mode === 'auto') this.autoNotice('no-git', ['Automatic backup skipped: Git not found.']);
			return null;
		}
		if (mode === 'manual') showNotice(this.stateMessage, { duration: NOTICE_LONG });
		else if (mode === 'auto') this.autoNotice(`state:${this.stateMessage}`, [this.stateMessage]);
		return null;
	}

	/** Runs one operation at a time; returns true when it completed without errors. */
	private async run(
		label: string,
		mode: Mode,
		task: (service: GitService) => Promise<void>,
		options: RunOptions = {},
	): Promise<boolean> {
		if (this.notifyIfBusy(mode)) return false;
		const service = await this.readyService(mode, options.needsRepo ?? true);
		if (!service || this.notifyIfBusy(mode)) return false;
		// let an in-flight status refresh finish before touching the repository
		if (this.refreshPromise) await this.refreshPromise;
		if (this.notifyIfBusy(mode)) return false;

		this.running = label;
		this.show({ kind: 'busy', label });
		try {
			await task(service);
			return true;
		} catch (error) {
			// expected failures (auth, network, …) are explained in a notice
			if (classifyGitError(error) === 'unknown') console.error(`[vault-git-sync] ${label} failed`, error);
			else console.debug(`[vault-git-sync] ${label} failed`, error);
			this.reportError(error, mode);
			return false;
		} finally {
			this.running = null;
			this.renderState();
			await this.refreshStatus();
		}
	}

	// ----- notices ------------------------------------------------------------

	private errorLines(error: unknown): string[] {
		const kind = classifyGitError(error);
		const lines = [errorMessage(kind, this.vaultPath() ?? '')];
		const detail = gitErrorDetail(error);
		if (detail && (shouldShowDetail(kind) || kind === 'unknown')) lines.push(`Details: ${detail}`);
		return lines;
	}

	private reportError(error: unknown, mode: Mode): void {
		const kind = classifyGitError(error);
		if (kind === 'not-repo') this.state = 'not-repo';
		if (kind === 'git-not-found') {
			this.state = 'no-git';
			this.location = null;
		}
		const lines = this.errorLines(error);
		if (error instanceof SyncError) {
			// say what was done before the failing step
			const done = [describeCommit(error.completed.commit)];
			if (error.completed.pull) done.push(describePull(error.completed.pull));
			lines.unshift(`${error.step === 'pull' ? 'Pull' : 'Push'} failed.`, ...done);
		}
		if (mode === 'auto') {
			// keyed on the kind of problem: the details (e.g. number of files) change at every run
			const step = error instanceof SyncError ? error.step : 'commit';
			this.autoNotice(`error:${kind}:${step}`, ['Automatic backup stopped by an error.', ...lines]);
		} else if (mode === 'startup') {
			showNotice(['Pull on startup failed.', ...lines], { duration: NOTICE_LONG });
		} else {
			showNotice(lines, { duration: NOTICE_LONG });
		}
	}

	/** Notice from the automatic backup: shown once until the situation (`key`) changes. */
	private autoNotice(key: string, lines: string[], duration = NOTICE_LONG, actions?: NoticeAction[]): void {
		if (key === this.lastAutoNotice) return;
		this.lastAutoNotice = key;
		showNotice(lines, { duration, actions });
	}

	private notifyGitMissing(): void {
		const configured = this.locateError?.configuredPath;
		showNotice(
			[
				configured
					? `The configured Git path does not work: ${configured}`
					: 'Git not found (neither in PATH nor in the common install locations).',
				`Install Git or set the path of the executable in ${SETTINGS_PATH}. ` +
					'On macOS, Obsidian started from the Dock does not get the shell PATH: e.g. /opt/homebrew/bin/git.',
			],
			{ duration: NOTICE_LONG },
		);
	}

	private notifyNotRepo(): void {
		showNotice(['This vault is not a Git repository.', 'Create it now, or later with the "Initialize repository" command.'], {
			duration: NOTICE_LONG,
			actions: [{ label: 'Initialize repository', run: () => void this.initRepository() }],
		});
	}

	private notifyCommit(outcome: CommitOutcome, excluded: string[] = []): void {
		const problem = outcome.kind === 'unresolved-conflicts' || outcome.kind === 'merge-in-progress';
		showNotice([describeCommit(outcome), ...leftOutLines(excluded)], {
			duration: problem ? NOTICE_LONG : NOTICE_SHORT,
		});
	}

	/** Automatic backup: reports the large files it left out, once per set of files. */
	private notifyLargeFilesLeftOut(large: LargeFile[]): void {
		const key = large.map((file) => file.path).join('\n') || null;
		if (key === this.lastLargeFilesNotice) return;
		this.lastLargeFilesNotice = key;
		if (!large.length) return;
		showNotice(
			[
				'Automatic backup: large files left out.',
				...largeFilesLines(large, this.plugin.settings.largeFileLimitMb),
				'They are committed only when you confirm it from "Commit" or "Sync".',
			],
			{ duration: NOTICE_LONG },
		);
	}

	private openFileActions(files: string[]): NoticeAction[] {
		return files.slice(0, 3).flatMap((file) => {
			const vaultPath = this.vaultPathOf(file);
			if (!vaultPath || !(this.app.vault.getAbstractFileByPath(vaultPath) instanceof TFile)) return [];
			return [{ label: `Open ${path.posix.basename(vaultPath)}`, run: () => void this.openFile(file, true) }];
		});
	}

	private notifyConflicts(files: string[], mode: Mode): void {
		const lines = conflictNoticeLines(files);
		const actions = [
			...this.openFileActions(files),
			{ label: 'Abort merge', run: () => void this.abortMerge() },
		];
		if (mode === 'auto') this.autoNotice('merge', ['Automatic backup stopped.', ...lines], NOTICE_STICKY, actions);
		else showNotice(lines, { duration: NOTICE_STICKY, actions });
	}

	private notifyAutoPaused(files: string[]): void {
		// same situation as the conflict notice: do not report it twice
		this.autoNotice('merge', ['Automatic backup paused: a merge is in progress.', unresolvedConflictsText(files)]);
	}

	private notifyPull(outcome: PullOutcome): void {
		if (outcome.kind === 'conflicts') {
			this.notifyConflicts(outcome.files, 'manual');
			return;
		}
		const ok = outcome.kind === 'pulled' || outcome.kind === 'up-to-date';
		showNotice(describePull(outcome), { duration: ok ? NOTICE_SHORT : NOTICE_LONG });
	}

	private notifySync(outcome: SyncOutcome, mode: Mode, excluded: string[] = []): void {
		const { commit, pull, push } = outcome;
		if (commit.kind === 'merge-in-progress' || commit.kind === 'unresolved-conflicts') {
			if (mode === 'auto') this.notifyAutoPaused(commit.files);
			else this.notifyCommit(commit);
			return;
		}
		if (pull?.kind === 'conflicts') {
			this.notifyConflicts(pull.files, mode);
			return;
		}

		if (mode === 'auto') {
			// quiet unless something needs attention
			if (pull?.kind === 'detached') {
				this.autoNotice('detached', ['Automatic backup: cannot sync.', describePull(pull)]);
			} else {
				this.lastAutoNotice = null;
			}
			return;
		}

		const lines = [describeCommit(commit), ...leftOutLines(excluded)];
		if (pull) lines.push(describePull(pull));
		if (push) lines.push(describePush(push));
		const ok =
			(!pull || ['pulled', 'up-to-date', 'no-upstream'].includes(pull.kind)) &&
			(!push || ['pushed', 'up-to-date'].includes(push.kind));
		showNotice([ok ? 'Sync complete.' : 'Sync incomplete.', ...lines], {
			duration: ok ? NOTICE_SHORT : NOTICE_LONG,
		});
	}
}

function leftOutLines(excluded: string[]): string[] {
	return excluded.length ? [`Left out: ${fileList(excluded)}.`] : [];
}
