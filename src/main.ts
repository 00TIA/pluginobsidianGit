import { debounce, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { GitController } from './git-controller';
import { VaultGitSettingTab } from './settings';
import { MIN_AUTO_BACKUP_MINUTES, normalizeSettings, VaultGitSettings } from './settings-data';
import { GitPanelView, openGitPanel, VIEW_TYPE_GIT } from './ui/git-view';
import { GitStatusBar } from './ui/status-bar';

const STATUS_REFRESH_MS = 30 * 1000;
/** Delay before refreshing the status after files change in the vault. */
const FILE_CHANGE_REFRESH_MS = 2000;

export default class VaultGitPlugin extends Plugin {
	settings!: VaultGitSettings;
	controller!: GitController;
	private autoBackupTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());

		const statusBarEl = this.addStatusBarItem();
		this.controller = new GitController(this, new GitStatusBar(statusBarEl));
		this.registerDomEvent(statusBarEl, 'click', (event) => this.controller.showMenu(event));

		this.registerView(VIEW_TYPE_GIT, (leaf) => new GitPanelView(leaf, this.controller));
		this.addRibbonIcon('git-branch', 'Open Git panel', () => void openGitPanel(this.app.workspace));

		registerCommands(this);
		this.addSettingTab(new VaultGitSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.controller.start();
			// registered after the layout is ready: Obsidian fires "create" for every file at startup
			const refreshSoon = debounce(() => void this.controller.refreshStatus(), FILE_CHANGE_REFRESH_MS, true);
			this.registerEvent(this.app.vault.on('create', refreshSoon));
			this.registerEvent(this.app.vault.on('modify', refreshSoon));
			this.registerEvent(this.app.vault.on('delete', refreshSoon));
			this.registerEvent(this.app.vault.on('rename', refreshSoon));
		});
		this.registerInterval(
			window.setInterval(() => void this.controller.refreshStatus(), STATUS_REFRESH_MS),
		);
		this.scheduleAutoBackup();
	}

	onunload(): void {
		this.clearAutoBackup();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** (Re)starts the automatic backup timer according to the settings. */
	scheduleAutoBackup(): void {
		this.clearAutoBackup();
		if (!this.settings.autoBackup) return;
		const minutes = Math.max(MIN_AUTO_BACKUP_MINUTES, this.settings.autoBackupInterval);
		this.autoBackupTimer = window.setInterval(
			() => void this.controller.autoBackup(),
			minutes * 60 * 1000,
		);
		this.registerInterval(this.autoBackupTimer);
	}

	private clearAutoBackup(): void {
		if (this.autoBackupTimer !== null) {
			window.clearInterval(this.autoBackupTimer);
			this.autoBackupTimer = null;
		}
	}
}
