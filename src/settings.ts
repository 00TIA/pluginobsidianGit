import { App, ButtonComponent, debounce, moment, Platform, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import * as os from 'os';
import { DEFAULT_COMMIT_TEMPLATE, DEFAULT_DATE_FORMAT, renderCommitMessage } from './commit-message';
import type { Identity } from './git/git-service';
import type VaultGitPlugin from './main';
import { DEFAULT_SETTINGS, MIN_AUTO_BACKUP_MINUTES, parseInterval, parseLargeFileLimit } from './settings-data';
import {
	GuidePlatform,
	nextStep,
	parseStepText,
	SETUP_STEPS,
	SetupState,
	SetupStep,
	SetupStepId,
	setupCompletion,
	stepParagraphs,
} from './setup-guide';

/** Runs `action` when Enter is pressed in a text field. */
function onEnter(text: TextComponent, action: () => void): void {
	text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			action();
		}
	});
}

function guidePlatform(): GuidePlatform {
	if (Platform.isMacOS) return 'macos';
	return Platform.isWin ? 'windows' : 'linux';
}

/** Appends a paragraph with **bold**, `code` and [links](https://…). */
function renderParagraph(container: HTMLElement, text: string): void {
	const paragraph = container.createEl('p');
	for (const part of parseStepText(text)) {
		if (part.style === 'bold') paragraph.createEl('strong', { text: part.text });
		else if (part.style === 'code') paragraph.createEl('code', { text: part.text });
		else if (part.style === 'link') paragraph.createEl('a', { text: part.text, href: part.href });
		else paragraph.appendText(part.text);
	}
}

function describeAuthor(identity: Identity | undefined): string {
	const base = 'Saved in this repository only. Leave empty to use your global Git configuration.';
	if (!identity?.name || !identity.email) {
		return `${base} Not set yet: commits fail until both name and email are set.`;
	}
	const inherited = !identity.localName || !identity.localEmail;
	return `${base} Current author: ${identity.name} <${identity.email}>${inherited ? ' (from the global configuration)' : ''}.`;
}

export class VaultGitSettingTab extends PluginSettingTab {
	private readonly relocateGit = debounce(() => void this.checkGit(), 800, true);
	private gitInfoEl: HTMLElement | null = null;
	private reloadRepository: (() => Promise<void>) | null = null;
	private guideEl: HTMLElement | null = null;
	/** Steps whose explanation is open; null = only the next step to do. */
	private guideExpanded: Set<SetupStepId> | null = null;
	/** Show all the steps even when the setup is complete. */
	private guideShowAll = false;
	/** Fields the guide can jump to. */
	private readonly guideTargets: Partial<Record<SetupStepId, HTMLElement>> = {};

	constructor(
		app: App,
		private readonly plugin: VaultGitPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.guideExpanded = null;
		this.guideShowAll = false;
		this.displayGuide(containerEl);
		this.displayGit(containerEl);
		this.displayRepository(containerEl);
		this.displayCommitMessage(containerEl);
		this.displayLargeFiles(containerEl);
		this.displayAutomation(containerEl);
	}

	private displayGuide(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Getting started').setHeading();
		this.guideEl = containerEl.createDiv({ cls: 'vault-git-guide' });
		this.guideEl.createDiv({ cls: 'setting-item-description', text: 'Checking the setup…' });
	}

	/** Renders the setup steps: done ones in one line, the next one explained. */
	private async renderGuide(): Promise<void> {
		const guideEl = this.guideEl;
		if (!guideEl) return;
		const state = await this.plugin.controller.setupState();
		const next = nextStep(state);
		const { done, total } = setupCompletion(state);
		const expanded = this.guideExpanded ?? new Set(next ? [next] : []);
		guideEl.empty();

		if (!next && !this.guideShowAll) {
			const complete = guideEl.createDiv({ cls: 'vault-git-guide-complete' });
			complete.createSpan({ cls: 'vault-git-guide-check', text: '✓' });
			complete.createSpan({ text: 'Everything is set up. Use the Git icon in the left ribbon to sync.' });
			const show = complete.createEl('button', { cls: 'mod-muted', text: 'Show the steps' });
			show.addEventListener('click', () => {
				this.guideShowAll = true;
				void this.renderGuide();
			});
			return;
		}

		guideEl.createEl('p', {
			cls: 'vault-git-guide-intro',
			text:
				'Vault Git Sync keeps the history of your notes with Git and can sync them with an online copy, for example on GitHub. ' +
				`Follow these steps once: ${done} of ${total} done.`,
		});
		SETUP_STEPS.forEach((step, index) => {
			const detail = state[step.id];
			const card = guideEl.createDiv({ cls: 'vault-git-step' });
			card.toggleClass('is-done', detail !== null);
			card.toggleClass('is-next', step.id === next);

			const header = card.createDiv({ cls: 'vault-git-step-header' });
			header.createSpan({ cls: 'vault-git-step-marker', text: detail !== null ? '✓' : String(index + 1) });
			const heading = header.createDiv({ cls: 'vault-git-step-heading' });
			heading.createDiv({ cls: 'vault-git-step-title', text: step.title });
			heading.createDiv({ cls: 'vault-git-step-where', text: detail ?? step.where });
			header.addEventListener('click', () => {
				const open = new Set(expanded);
				if (open.has(step.id)) open.delete(step.id);
				else open.add(step.id);
				this.guideExpanded = open;
				void this.renderGuide();
			});

			if (!expanded.has(step.id)) return;
			const body = card.createDiv({ cls: 'vault-git-step-body' });
			for (const paragraph of stepParagraphs(step, guidePlatform())) renderParagraph(body, paragraph);
			this.renderStepActions(body.createDiv({ cls: 'vault-git-step-actions' }), step, state);
		});
	}

	private renderStepActions(container: HTMLElement, step: SetupStep, state: SetupState): void {
		const controller = this.plugin.controller;
		const addButton = (text: string, run: () => Promise<unknown> | void, cta = true) => {
			const button = container.createEl('button', { text });
			if (cta) button.addClass('mod-cta');
			button.addEventListener('click', () => {
				button.disabled = true;
				void Promise.resolve(run()).finally(() => this.reloadRepository?.());
			});
		};
		const jumpTo = (target: HTMLElement | undefined) => {
			target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			target?.focus();
		};

		switch (step.id) {
			case 'git':
				if (!state.git) addButton('Check again', () => this.checkGit());
				break;
			case 'repo':
				if (state.git && !state.repo) addButton('Initialize repository', () => controller.initRepository());
				break;
			case 'author':
			case 'remote': {
				const button = container.createEl('button', {
					text: step.id === 'author' ? 'Go to Commit author' : 'Go to Remote URL',
				});
				button.disabled = !state.repo;
				button.addEventListener('click', () => jumpTo(this.guideTargets[step.id]));
				break;
			}
			case 'sync':
				if (state.remote) addButton('Sync now', () => controller.sync());
				else container.createSpan({ cls: 'vault-git-step-note', text: 'Connect an online copy first (step 4).' });
				break;
		}
	}

	private displayGit(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Git executable').setHeading();

		new Setting(containerEl)
			.setName('Path to the Git executable')
			.setDesc(
				'Leave empty to find it automatically (PATH, then the common install locations). ' +
					'Examples: /opt/homebrew/bin/git (macOS), /usr/bin/git (Linux), C:\\Program Files\\Git\\cmd\\git.exe (Windows).',
			)
			.addText((text) =>
				text
					.setPlaceholder('Automatic')
					.setValue(this.plugin.settings.gitPath)
					.onChange(async (value) => {
						this.plugin.settings.gitPath = value.trim();
						await this.plugin.saveSettings();
						this.relocateGit();
					}),
			);

		const info = new Setting(containerEl).setName('Git in use').addButton((button) =>
			button.setButtonText('Check').onClick(async () => {
				button.setDisabled(true);
				await this.checkGit();
				button.setDisabled(false);
			}),
		);
		this.gitInfoEl = info.descEl;
		this.renderGitInfo();
	}

	private async checkGit(): Promise<void> {
		if (this.gitInfoEl) this.gitInfoEl.setText('Looking for Git…');
		await this.plugin.controller.setup();
		this.renderGitInfo();
		await this.reloadRepository?.();
	}

	private renderGitInfo(): void {
		if (!this.gitInfoEl) return;
		const info = this.plugin.controller.describeGit();
		this.gitInfoEl.empty();
		for (const line of info.lines) this.gitInfoEl.createDiv({ text: line });
		this.gitInfoEl.toggleClass('mod-warning', info.warning);
	}

	/** Remote URL and commit author, read from and written to the repository's Git config. */
	private displayRepository(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Repository').setHeading();
		const controller = this.plugin.controller;
		const unavailable = new Setting(containerEl).setDesc('Loading…');

		let urlText!: TextComponent;
		let urlButton!: ButtonComponent;
		let nameText!: TextComponent;
		let emailText!: TextComponent;
		let authorButton!: ButtonComponent;

		const setEnabled = (enabled: boolean) => {
			for (const component of [urlText, urlButton, nameText, emailText, authorButton]) {
				component.setDisabled(!enabled);
			}
		};

		const remote = new Setting(containerEl)
			.setName('Remote URL')
			.setDesc(
				'Used by pull, push and sync. Both SSH and HTTPS addresses work: copy the one shown by your Git host.',
			)
			.addText((text) => {
				urlText = text.setPlaceholder('git@github.com:user/vault.git');
				urlText.inputEl.addClass('vault-git-wide-input');
				this.guideTargets.remote = urlText.inputEl;
				onEnter(text, () => void saveUrl());
			})
			.addButton((button) => {
				urlButton = button.setButtonText('Save').onClick(() => void saveUrl());
			});

		const author = new Setting(containerEl)
			.setName('Commit author')
			.addText((text) => {
				nameText = text.setPlaceholder('Name');
				this.guideTargets.author = nameText.inputEl;
				onEnter(text, () => void saveAuthor());
			})
			.addText((text) => {
				emailText = text.setPlaceholder('Email');
				onEnter(text, () => void saveAuthor());
			})
			.addButton((button) => {
				authorButton = button.setButtonText('Save').onClick(() => void saveAuthor());
			});

		const load = async () => {
			try {
				await fill();
			} finally {
				// the guide shows which steps are done
				await this.renderGuide();
			}
		};
		const fill = async () => {
			setEnabled(false);
			const settings = await controller.repositorySettings();
			unavailable.settingEl.toggle(!settings.available);
			unavailable.setDesc(settings.reason ?? '');
			if (!settings.available) return;

			urlText.setValue(settings.remote?.url ?? '');
			remote.setName(settings.remote ? `Remote URL (${settings.remote.name})` : 'Remote URL');

			const identity = settings.identity;
			nameText.setValue(identity?.localName ?? '');
			emailText.setValue(identity?.localEmail ?? '');
			// show the inherited global values as hints
			nameText.setPlaceholder(identity?.name && !identity.localName ? identity.name : 'Name');
			emailText.setPlaceholder(identity?.email && !identity.localEmail ? identity.email : 'Email');
			author.setDesc(describeAuthor(identity));
			setEnabled(true);
		};

		const saveUrl = async () => {
			setEnabled(false);
			await controller.setRemoteUrl(urlText.getValue());
			await load();
		};
		const saveAuthor = async () => {
			setEnabled(false);
			await controller.setIdentity({ name: nameText.getValue(), email: emailText.getValue() });
			await load();
		};

		this.reloadRepository = load;
		void load();
	}

	private displayCommitMessage(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Commit message').setHeading();

		const preview = new Setting(containerEl).setName('Preview');
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
			.setName('Message format')
			.setDesc('Placeholders: {{date}}, {{hostname}}, {{numFiles}}.')
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
			.setName('Date format')
			.setDesc('Moment.js format used for {{date}}.')
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

	private displayLargeFiles(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Large files').setHeading();

		const description =
			'Files of at least this size not tracked by Git LFS need a confirmation before a commit, ' +
			'and the automatic backup leaves them out. 0 turns the check off.';
		const limit = new Setting(containerEl).setName('Size limit in megabytes').setDesc(description);
		limit.addText((text) => {
			text.inputEl.type = 'number';
			text.inputEl.min = '0';
			text
				.setPlaceholder(String(DEFAULT_SETTINGS.largeFileLimitMb))
				.setValue(String(this.plugin.settings.largeFileLimitMb))
				.onChange(async (value) => {
					const megabytes = parseLargeFileLimit(value);
					limit.descEl.toggleClass('mod-warning', megabytes === null);
					limit.setDesc(megabytes === null ? `Enter a whole number of MB. ${description}` : description);
					if (megabytes === null) return;
					this.plugin.settings.largeFileLimitMb = megabytes;
					await this.plugin.saveSettings();
				});
		});
	}

	private displayAutomation(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Automation').setHeading();

		new Setting(containerEl)
			.setName('Pull on startup')
			.setDesc('Pull the remote changes when Obsidian starts, so you begin from the latest version.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pullOnStartup).onChange(async (value) => {
					this.plugin.settings.pullOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Automatic backup')
			.setDesc('Periodically commit all the changes in the vault.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoBackup).onChange(async (value) => {
					this.plugin.settings.autoBackup = value;
					await this.plugin.saveSettings();
					this.plugin.scheduleAutoBackup();
				}),
			);

		const minimum = `At least ${MIN_AUTO_BACKUP_MINUTES} minute.`;
		const interval = new Setting(containerEl).setName('Interval in minutes').setDesc(minimum);
		interval.addText((text) => {
			text.inputEl.type = 'number';
			text.inputEl.min = String(MIN_AUTO_BACKUP_MINUTES);
			text
				.setPlaceholder(String(DEFAULT_SETTINGS.autoBackupInterval))
				.setValue(String(this.plugin.settings.autoBackupInterval))
				.onChange(async (value) => {
					const minutes = parseInterval(value);
					interval.descEl.toggleClass('mod-warning', minutes === null);
					interval.setDesc(minutes === null ? `Enter a whole number of minutes. ${minimum}` : minimum);
					if (minutes === null) return;
					this.plugin.settings.autoBackupInterval = minutes;
					await this.plugin.saveSettings();
					this.plugin.scheduleAutoBackup();
				});
		});

		new Setting(containerEl)
			.setName('Include pull and push')
			.setDesc(
				'When on, the backup is a full sync (commit, pull, push); otherwise only a local commit. ' +
					'Without a remote only the commit is made.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoBackupSync).onChange(async (value) => {
					this.plugin.settings.autoBackupSync = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
