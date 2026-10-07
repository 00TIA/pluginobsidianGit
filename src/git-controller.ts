import { FileSystemAdapter, Menu, moment, TFile } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_DATE_FORMAT, renderCommitMessage } from './commit-message';
import { classifyGitError, errorText, gitErrorDetail } from './git/errors';
import {
	CommitOutcome,
	GitService,
	PullOutcome,
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
	shouldShowDetail,
	unresolvedConflictsText,
} from './messages';
import { CommitMessageModal } from './ui/commit-modal';
import { NOTICE_LONG, NOTICE_SHORT, NOTICE_STICKY, NoticeAction, showNotice } from './ui/notices';
import type { GitStatusBar } from './ui/status-bar';

type ControllerState = 'checking' | 'no-git' | 'not-repo' | 'ready' | 'error';

/** `manual` = started by the user; `auto` = automatic backup (quiet, de-duplicated notices). */
type Mode = 'manual' | 'auto';

interface RunOptions {
	/** The operation needs an existing repository (false only for init). */
	needsRepo?: boolean;
}

/**
 * Connects the git service to Obsidian: serialises operations, keeps the status bar
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
	/** Situation last reported by the automatic backup, to avoid repeating it at every run. */
	private lastAutoNotice: string | null = null;

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

	/** First check at startup: warns when git is missing or the vault is not a repository. */
	async start(): Promise<void> {
		await this.setup();
		if (this.state === 'no-git') this.notifyGitMissing();
		else if (this.state === 'not-repo') this.notifyNotRepo();
		else if (this.state === 'error') showNotice(this.stateMessage, { duration: NOTICE_LONG });
	}

	/** (Re)locates git and detects the repository; safe to call concurrently. */
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
			this.stateMessage = 'Il vault non si trova su un file system locale: Git non è utilizzabile.';
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

	/** Lines shown in the settings tab about the git executable in use. */
	describeGit(): { lines: string[]; warning: boolean } {
		if (this.state === 'checking' && !this.location) {
			return { lines: ['Ricerca in corso…'], warning: false };
		}
		if (this.location) {
			const source = {
				settings: 'percorso impostato',
				path: 'trovato nel PATH',
				'known-location': 'trovato in un percorso di installazione comune',
				'login-shell': 'trovato tramite la shell di login',
			}[this.location.source];
			const lines = [`${this.location.path} (${this.location.version.replace(/^git version /i, '')}, ${source})`];
			const repo = this.service?.repository;
			if (repo && !repo.vaultIsRoot) lines.push(`Il vault è dentro il repository ${repo.root}.`);
			if (this.state === 'not-repo') lines.push('Il vault non è ancora un repository Git.');
			if (this.state === 'error') lines.push(this.stateMessage);
			return { lines, warning: this.state === 'error' };
		}
		const configured = this.locateError?.configuredPath;
		return {
			lines: [
				configured
					? `Il percorso impostato non è un eseguibile Git funzionante: ${configured}`
					: 'Git non trovato né nel PATH né nei percorsi di installazione comuni.',
			],
			warning: true,
		};
	}

	// ----- status bar ---------------------------------------------------------

	private renderState(): void {
		if (this.running) return;
		switch (this.state) {
			case 'checking':
				this.statusBar.render({ kind: 'checking' });
				break;
			case 'no-git':
				this.statusBar.render({ kind: 'no-git' });
				break;
			case 'not-repo':
				this.statusBar.render({ kind: 'not-repo' });
				break;
			case 'error':
				this.statusBar.render({ kind: 'error', message: this.stateMessage });
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
			this.renderState();
			return;
		}
		try {
			const status = await this.service.status();
			if (this.running) return;
			this.statusBar.render({ kind: 'ready', status, updatedAt: new Date() });
		} catch (error) {
			if (this.running) return;
			if (classifyGitError(error) === 'not-repo') {
				// the .git folder was removed while Obsidian was running
				this.state = 'not-repo';
				this.renderState();
				return;
			}
			this.statusBar.render({ kind: 'error', message: this.errorLines(error).join(' ') });
		}
	}

	showMenu(event: MouseEvent): void {
		const menu = new Menu();
		if (this.state === 'not-repo') {
			menu.addItem((item) =>
				item.setTitle('Inizializza repository').setIcon('git-branch').onClick(() => void this.initRepository()),
			);
		} else {
			menu.addItem((item) => item.setTitle('Commit').setIcon('git-commit').onClick(() => void this.commit()));
			menu.addItem((item) =>
				item.setTitle('Commit con messaggio…').setIcon('pencil').onClick(() => void this.commitWithMessage()),
			);
			menu.addItem((item) => item.setTitle('Pull').setIcon('download').onClick(() => void this.pull()));
			menu.addItem((item) => item.setTitle('Push').setIcon('upload').onClick(() => void this.push()));
			menu.addItem((item) => item.setTitle('Sync').setIcon('refresh-cw').onClick(() => void this.sync()));
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Aggiorna stato').setIcon('rotate-cw').onClick(() => void this.setup()),
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
		await this.run('commit', 'manual', async (service) => {
			const outcome = await service.commit((n) => this.commitMessage(n), { concludeMerge: true });
			this.notifyCommit(outcome);
		});
	}

	async commitWithMessage(): Promise<void> {
		if (this.notifyIfBusy('manual')) return;
		const service = await this.readyService('manual', true);
		if (!service) return;
		let status: RepoStatus;
		try {
			status = await service.status();
		} catch (error) {
			this.reportError(error, 'manual');
			return;
		}
		if (!status.changedFiles && !status.merging) {
			showNotice('Nessuna modifica da salvare.');
			return;
		}
		new CommitMessageModal(this.app, this.commitMessage(status.changedFiles), status.changedFiles, (message) => {
			void this.run('commit', 'manual', async (current) => {
				const outcome = await current.commit(message, { concludeMerge: true });
				this.notifyCommit(outcome);
			});
		}).open();
	}

	async pull(): Promise<void> {
		await this.run('pull', 'manual', async (service) => {
			const outcome = await service.pull();
			this.notifyPull(outcome, 'manual');
		});
	}

	async push(): Promise<void> {
		await this.run('push', 'manual', async (service) => {
			const outcome = await service.push();
			showNotice(describePush(outcome), { duration: outcome.kind === 'pushed' ? NOTICE_SHORT : NOTICE_LONG });
		});
	}

	async sync(): Promise<void> {
		await this.run('sync', 'manual', async (service) => {
			const outcome = await service.sync((n) => this.commitMessage(n), { concludeMerge: true });
			this.notifySync(outcome, 'manual');
		});
	}

	/** Called by the automatic backup timer. */
	async autoBackup(): Promise<void> {
		if (this.running) return; // try again at the next interval
		await this.run('backup', 'auto', async (service) => {
			const message = (n: number) => this.commitMessage(n);
			if (this.plugin.settings.autoBackupSync) {
				this.notifySync(await service.sync(message), 'auto');
			} else {
				const outcome = await service.commit(message);
				if (outcome.kind === 'merge-in-progress' || outcome.kind === 'unresolved-conflicts') {
					this.notifyAutoSuspended(outcome.files);
				} else {
					this.lastAutoNotice = null;
				}
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
				const lines = ['Repository Git inizializzato nel vault (con un .gitignore per Obsidian).'];
				lines.push('Esegui «Commit» per il primo commit. Per pull e push aggiungi un remote da terminale: git remote add origin <url>');
				if (!repo.vaultIsRoot) lines.push(`Attenzione: il vault risulta dentro ${repo.root}.`);
				showNotice(lines, { duration: NOTICE_LONG });
			},
			{ needsRepo: false },
		);
	}

	private notifyIfBusy(mode: Mode): boolean {
		if (!this.running) return false;
		if (mode === 'manual') showNotice(`Operazione Git già in corso (${this.running}): riprova al termine.`);
		return true;
	}

	/** Returns a service ready for the operation, or null after explaining why not. */
	private async readyService(mode: Mode, needsRepo: boolean): Promise<GitService | null> {
		if (this.setupPromise) await this.setupPromise;
		// git may have been installed, or the repository created, from outside Obsidian
		if (this.state !== 'ready') await this.setup();

		if (this.state === 'ready' && this.service) {
			if (!needsRepo) {
				showNotice('Il vault è già un repository Git.');
				return null;
			}
			return this.service;
		}
		if (this.state === 'not-repo' && this.service) {
			if (!needsRepo) return this.service;
			if (mode === 'manual') this.notifyNotRepo();
			else this.autoNotice('not-repo', ['Backup automatico non eseguito: il vault non è un repository Git.']);
			return null;
		}
		if (this.state === 'no-git') {
			if (mode === 'manual') this.notifyGitMissing();
			else this.autoNotice('no-git', ['Backup automatico non eseguito: Git non trovato.']);
			return null;
		}
		if (mode === 'manual') showNotice(this.stateMessage, { duration: NOTICE_LONG });
		else this.autoNotice(`state:${this.stateMessage}`, [this.stateMessage]);
		return null;
	}

	private async run(
		label: string,
		mode: Mode,
		task: (service: GitService) => Promise<void>,
		options: RunOptions = {},
	): Promise<void> {
		if (this.notifyIfBusy(mode)) return;
		const service = await this.readyService(mode, options.needsRepo ?? true);
		if (!service || this.notifyIfBusy(mode)) return;
		// let an in-flight status refresh finish before touching the repository
		if (this.refreshPromise) await this.refreshPromise;
		if (this.notifyIfBusy(mode)) return;

		this.running = label;
		this.statusBar.render({ kind: 'busy', label: `${label} in corso` });
		try {
			await task(service);
		} catch (error) {
			// expected failures (auth, network, …) are explained in a notice
			if (classifyGitError(error) === 'unknown') console.error(`[vault-git-sync] ${label} failed`, error);
			else console.debug(`[vault-git-sync] ${label} failed`, error);
			this.reportError(error, mode);
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
		if (detail && (shouldShowDetail(kind) || kind === 'unknown')) lines.push(`Dettaglio: ${detail}`);
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
			lines.unshift(`${error.step === 'pull' ? 'Pull' : 'Push'} non riuscito.`, ...done);
		}
		if (mode === 'auto') {
			// keyed on the kind of problem: the details (e.g. number of files) change at every run
			const step = error instanceof SyncError ? error.step : 'commit';
			this.autoNotice(`error:${kind}:${step}`, ['Backup automatico interrotto da un errore.', ...lines]);
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
					? `Il percorso di Git impostato non funziona: ${configured}`
					: 'Git non trovato (né nel PATH né nei percorsi di installazione comuni).',
				'Installa Git oppure indica il percorso dell\'eseguibile in Impostazioni → Vault Git Sync. ' +
					'Su macOS, avviando Obsidian dal Dock il PATH della shell non è disponibile: es. /opt/homebrew/bin/git.',
			],
			{ duration: NOTICE_LONG },
		);
	}

	private notifyNotRepo(): void {
		showNotice(['Il vault non è un repository Git.', 'Puoi crearlo ora oppure con il comando «Inizializza repository».'], {
			duration: NOTICE_LONG,
			actions: [{ label: 'Inizializza repository', run: () => void this.initRepository() }],
		});
	}

	private notifyCommit(outcome: CommitOutcome): void {
		const problem = outcome.kind === 'unresolved-conflicts' || outcome.kind === 'merge-in-progress';
		showNotice(describeCommit(outcome), { duration: problem ? NOTICE_LONG : NOTICE_SHORT });
	}

	private openFileActions(files: string[]): NoticeAction[] {
		const repo = this.service?.repository;
		const vaultPath = this.vaultPath();
		if (!repo || !vaultPath) return [];
		return files.slice(0, 3).flatMap((file) => {
			const vaultRelative = path
				.relative(vaultPath, path.join(repo.root, file))
				.split(path.sep)
				.join('/');
			const target = this.app.vault.getAbstractFileByPath(vaultRelative);
			if (!(target instanceof TFile)) return [];
			return [
				{
					label: `Apri ${target.name}`,
					run: () => void this.app.workspace.getLeaf('tab').openFile(target),
				},
			];
		});
	}

	private notifyConflicts(files: string[], mode: Mode): void {
		const lines = conflictNoticeLines(files);
		const actions = this.openFileActions(files);
		if (mode === 'auto') this.autoNotice('merge', ['Backup automatico interrotto.', ...lines], NOTICE_STICKY, actions);
		else showNotice(lines, { duration: NOTICE_STICKY, actions });
	}

	private notifyAutoSuspended(files: string[]): void {
		// same situation as the conflict notice: do not report it twice
		this.autoNotice('merge', [
			'Backup automatico sospeso: c\'è un merge in corso.',
			unresolvedConflictsText(files),
		]);
	}

	private notifyPull(outcome: PullOutcome, mode: Mode): void {
		if (outcome.kind === 'conflicts') {
			this.notifyConflicts(outcome.files, mode);
			return;
		}
		const ok = outcome.kind === 'pulled' || outcome.kind === 'up-to-date';
		showNotice(describePull(outcome), { duration: ok ? NOTICE_SHORT : NOTICE_LONG });
	}

	private notifySync(outcome: SyncOutcome, mode: Mode): void {
		const { commit, pull, push } = outcome;
		if (commit.kind === 'merge-in-progress' || commit.kind === 'unresolved-conflicts') {
			if (mode === 'auto') this.notifyAutoSuspended(commit.files);
			else this.notifyCommit(commit);
			return;
		}
		if (pull?.kind === 'conflicts') {
			this.notifyConflicts(pull.files, mode);
			return;
		}

		if (mode === 'auto') {
			// quiet unless something needs attention
			const problem = pull && pull.kind === 'detached' ? describePull(pull) : null;
			if (problem) this.autoNotice('detached', ['Backup automatico: sync non possibile.', problem]);
			else this.lastAutoNotice = null;
			return;
		}

		const lines = [describeCommit(commit)];
		if (pull) lines.push(describePull(pull));
		if (push) lines.push(describePush(push));
		const ok =
			(!pull || ['pulled', 'up-to-date', 'no-upstream'].includes(pull.kind)) &&
			(!push || ['pushed', 'up-to-date'].includes(push.kind));
		showNotice([ok ? 'Sync completato.' : 'Sync incompleto.', ...lines], {
			duration: ok ? NOTICE_SHORT : NOTICE_LONG,
		});
	}
}

