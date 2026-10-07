import { App, Modal, Setting, TextComponent } from 'obsidian';

/** Asks for a commit message, pre-filled with the message generated from the template. */
export class CommitMessageModal extends Modal {
	private value: string;
	private submitted = false;

	constructor(
		app: App,
		initialMessage: string,
		private readonly changedFiles: number,
		private readonly onSubmit: (message: string) => void,
	) {
		super(app);
		this.value = initialMessage;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Commit');
		contentEl.createEl('p', {
			text:
				this.changedFiles === 1
					? '1 file modificato verrà incluso nel commit.'
					: `${this.changedFiles} file modificati verranno inclusi nel commit.`,
		});

		let input: TextComponent | undefined;
		new Setting(contentEl).setName('Messaggio').addText((text) => {
			input = text;
			text.setValue(this.value).onChange((value) => (this.value = value));
			text.inputEl.addClass('vault-git-commit-input');
			text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter' && !event.isComposing) {
					event.preventDefault();
					this.submit();
				}
			});
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Annulla').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Commit')
					.setCta()
					.onClick(() => this.submit()),
			);

		window.setTimeout(() => {
			input?.inputEl.focus();
			input?.inputEl.select();
		}, 0);
	}

	private submit(): void {
		const message = this.value.trim();
		if (!message || this.submitted) return;
		this.submitted = true;
		this.close();
		this.onSubmit(message);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
