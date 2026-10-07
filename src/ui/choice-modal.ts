import { App, Modal, Setting } from 'obsidian';

export interface Choice<T> {
	text: string;
	value: T;
	/** `cta` = main action, `warning` = action that can lose work or cause trouble. */
	style?: 'cta' | 'warning';
}

export interface ChoiceOptions<T> {
	title: string;
	lines: string[];
	choices: Choice<T>[];
}

/** Dialog with a "Cancel" button and the given choices. */
class ChoiceModal<T> extends Modal {
	private chosen = false;

	constructor(
		app: App,
		private readonly options: ChoiceOptions<T>,
		private readonly resolve: (value: T | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		for (const line of this.options.lines) this.contentEl.createEl('p', { text: line });
		const buttons = new Setting(this.contentEl).addButton((button) =>
			button.setButtonText('Cancel').onClick(() => this.close()),
		);
		for (const choice of this.options.choices) {
			buttons.addButton((button) => {
				button.setButtonText(choice.text).onClick(() => {
					this.chosen = true;
					this.close();
					this.resolve(choice.value);
				});
				if (choice.style === 'cta') button.setCta();
				// same look as setWarning(), which is deprecated (setDestructive() needs Obsidian 1.13)
				if (choice.style === 'warning') button.buttonEl.addClass('mod-warning');
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.chosen) this.resolve(null);
	}
}

/** Shows the dialog; resolves with the chosen value, or null when cancelled or closed. */
export function choose<T>(app: App, options: ChoiceOptions<T>): Promise<T | null> {
	return new Promise((resolve) => new ChoiceModal(app, options, resolve).open());
}
