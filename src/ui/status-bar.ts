import { setTooltip } from 'obsidian';
import { describeStatusBar, StatusBarState } from './status-text';

export class GitStatusBar {
	constructor(private readonly el: HTMLElement) {
		el.addClass('vault-git-status', 'mod-clickable');
	}

	render(state: StatusBarState): void {
		const { text, tooltip } = describeStatusBar(state);
		this.el.setText(text);
		setTooltip(this.el, tooltip, { placement: 'top' });
		this.el.toggleClass('vault-git-status-warning', isWarning(state));
	}
}

function isWarning(state: StatusBarState): boolean {
	return (
		state.kind === 'no-git' ||
		state.kind === 'error' ||
		(state.kind === 'ready' && state.status.conflicted.length > 0)
	);
}
