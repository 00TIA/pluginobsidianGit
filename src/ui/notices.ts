import { Notice } from 'obsidian';

export interface NoticeAction {
	label: string;
	run: () => void;
}

export interface NoticeOptions {
	/** Milliseconds; 0 keeps the notice open until it is clicked. */
	duration?: number;
	actions?: NoticeAction[];
}

export const NOTICE_SHORT = 5000;
export const NOTICE_LONG = 15000;
export const NOTICE_STICKY = 0;

/** Shows a notice made of one paragraph per line, with optional buttons. */
export function showNotice(lines: string | string[], options: NoticeOptions = {}): Notice {
	const fragment = createFragment((frag) => {
		for (const line of Array.isArray(lines) ? lines : [lines]) {
			frag.createDiv({ text: line, cls: 'vault-git-notice-line' });
		}
		const actions = options.actions ?? [];
		if (actions.length) {
			const bar = frag.createDiv({ cls: 'vault-git-notice-actions' });
			for (const action of actions) {
				const button = bar.createEl('button', { text: action.label });
				// The click also reaches the notice, which then closes.
				button.addEventListener('click', () => action.run());
			}
		}
	});
	return new Notice(fragment, options.duration ?? NOTICE_SHORT);
}
