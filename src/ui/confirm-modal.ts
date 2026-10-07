import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
	title: string;
	lines: string[];
	confirmText: string;
	/** Style the confirm button as a destructive action. */
	warning?: boolean;
}

/** Asks for confirmation before an operation that discards work. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		for (const line of this.options.lines) this.contentEl.createEl('p', { text: line });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) => {
				button.setButtonText(this.options.confirmText).onClick(() => {
					this.close();
					this.onConfirm();
				});
				// same look as setWarning(), which is deprecated (setDestructive() needs Obsidian 1.13)
				if (this.options.warning) button.buttonEl.addClass('mod-warning');
				else button.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
