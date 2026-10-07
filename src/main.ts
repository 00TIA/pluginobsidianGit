import { Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { GitController } from './git-controller';
import { VaultGitSettingTab } from './settings';
import { MIN_AUTO_BACKUP_MINUTES, normalizeSettings, VaultGitSettings } from './settings-data';
import { GitStatusBar } from './ui/status-bar';

const STATUS_REFRESH_MS = 30 * 1000;

export default class VaultGitPlugin extends Plugin {
	settings!: VaultGitSettings;
	controller!: GitController;
	private autoBackupTimer: number | null = null;

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());

		const statusBarEl = this.addStatusBarItem();
		this.controller = new GitController(this, new GitStatusBar(statusBarEl));
		this.registerDomEvent(statusBarEl, 'click', (event) => this.controller.showMenu(event));

		registerCommands(this);
		this.addSettingTab(new VaultGitSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => void this.controller.start());
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
