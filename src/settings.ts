import { App, debounce, moment, PluginSettingTab, Setting } from 'obsidian';
import * as os from 'os';
import { DEFAULT_COMMIT_TEMPLATE, DEFAULT_DATE_FORMAT, renderCommitMessage } from './commit-message';
import { DEFAULT_SETTINGS, MIN_AUTO_BACKUP_MINUTES, parseInterval } from './settings-data';
import type VaultGitPlugin from './main';

export class VaultGitSettingTab extends PluginSettingTab {
	private readonly relocateGit = debounce(() => void this.checkGit(), 800, true);
	private gitInfoEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly plugin: VaultGitPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.displayGit(containerEl);
		this.displayCommitMessage(containerEl);
		this.displayAutoBackup(containerEl);
	}

	private displayGit(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Eseguibile Git').setHeading();

		new Setting(containerEl)
			.setName('Percorso dell\'eseguibile Git')
			.setDesc(
				'Lascia vuoto per la ricerca automatica (PATH, poi i percorsi di installazione più comuni). ' +
					'Esempi: /opt/homebrew/bin/git (macOS), /usr/bin/git (Linux), C:\\Program Files\\Git\\cmd\\git.exe (Windows).',
			)
			.addText((text) =>
				text
					.setPlaceholder('Automatico')
					.setValue(this.plugin.settings.gitPath)
					.onChange(async (value) => {
						this.plugin.settings.gitPath = value.trim();
						await this.plugin.saveSettings();
						this.relocateGit();
					}),
			);

		const info = new Setting(containerEl)
			.setName('Git in uso')
			.addButton((button) =>
				button.setButtonText('Verifica').onClick(async () => {
					button.setDisabled(true);
					await this.checkGit();
					button.setDisabled(false);
				}),
			);
		this.gitInfoEl = info.descEl;
		this.renderGitInfo();
	}

	private async checkGit(): Promise<void> {
		if (this.gitInfoEl) this.gitInfoEl.setText('Ricerca in corso…');
		await this.plugin.controller.setup();
		this.renderGitInfo();
	}

	private renderGitInfo(): void {
		if (!this.gitInfoEl) return;
		const info = this.plugin.controller.describeGit();
		this.gitInfoEl.empty();
		for (const line of info.lines) this.gitInfoEl.createDiv({ text: line });
		this.gitInfoEl.toggleClass('mod-warning', info.warning);
	}

	private displayCommitMessage(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Messaggio di commit').setHeading();

		const preview = new Setting(containerEl).setName('Anteprima');
		const updatePreview = () => {
			const settings = this.plugin.settings;
			preview.setDesc(
				renderCommitMessage(settings.commitMessage, {
					date: moment().format(settings.dateFormat || DEFAULT_DATE_FORMAT),
					hostname: os.hostname(),
					numFiles: 3,
				}),
			);
		};

		new Setting(containerEl)
			.setName('Formato del messaggio')
			.setDesc('Segnaposto disponibili: {{date}}, {{hostname}}, {{numFiles}}.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_COMMIT_TEMPLATE)
					.setValue(this.plugin.settings.commitMessage)
					.onChange(async (value) => {
						this.plugin.settings.commitMessage = value;
						await this.plugin.saveSettings();
						updatePreview();
					}),
			);

		new Setting(containerEl)
			.setName('Formato della data')
			.setDesc('Formato moment.js usato per {{date}}.')
			.addMomentFormat((format) =>
				format
					.setDefaultFormat(DEFAULT_DATE_FORMAT)
					.setPlaceholder(DEFAULT_DATE_FORMAT)
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (value) => {
						this.plugin.settings.dateFormat = value;
						await this.plugin.saveSettings();
						updatePreview();
					}),
			);

		// keep the preview below the two fields it depends on
		containerEl.appendChild(preview.settingEl);
		updatePreview();
	}

	private displayAutoBackup(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Backup automatico').setHeading();

		new Setting(containerEl)
			.setName('Attiva il backup automatico')
			.setDesc('Salva periodicamente tutte le modifiche del vault in un commit.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoBackup).onChange(async (value) => {
					this.plugin.settings.autoBackup = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleAutoBackup();
				}),
			);

		const interval = new Setting(containerEl)
			.setName('Intervallo in minuti')
			.setDesc(`Minimo ${MIN_AUTO_BACKUP_MINUTES} minuto.`);
		interval.addText((text) => {
			text.inputEl.type = 'number';
			text.inputEl.min = String(MIN_AUTO_BACKUP_MINUTES);
			text
				.setPlaceholder(String(DEFAULT_SETTINGS.autoBackupInterval))
				.setValue(String(this.plugin.settings.autoBackupInterval))
				.onChange(async (value) => {
					const minutes = parseInterval(value);
					interval.descEl.toggleClass('mod-warning', minutes === null);
					interval.setDesc(
						minutes === null
							? `Inserisci un numero intero di minuti (minimo ${MIN_AUTO_BACKUP_MINUTES}).`
							: `Minimo ${MIN_AUTO_BACKUP_MINUTES} minuto.`,
					);
					if (minutes === null) return;
					this.plugin.settings.autoBackupInterval = minutes;
					await this.plugin.saveSettings();
					this.plugin.scheduleAutoBackup();
				});
		});

		new Setting(containerEl)
			.setName('Includi pull e push')
			.setDesc(
				'Se attivo il backup esegue un sync completo (commit, pull, push); altrimenti solo il commit locale. ' +
					'Senza un remote configurato viene sempre eseguito solo il commit.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoBackupSync).onChange(async (value) => {
					this.plugin.settings.autoBackupSync = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
