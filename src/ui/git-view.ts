import { ItemView, setIcon, setTooltip, Workspace, WorkspaceLeaf } from 'obsidian';
import { ChangedFile, ChangeGroup, groupChanges } from '../git/changes';
import type { RepoStatus } from '../git/git-service';
import type { GitController } from '../git-controller';
import { SETTINGS_PATH } from '../messages';
import type { StatusBarState } from './status-text';

export const VIEW_TYPE_GIT = 'vault-git-sync-panel';

interface PanelAction {
	icon: string;
	label: string;
	run: () => void;
	style?: 'cta' | 'warning';
}

/** Opens the Git panel in the right sidebar, or reveals it when already open. */
export async function openGitPanel(workspace: Workspace): Promise<void> {
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_GIT)[0];
	if (!leaf) {
		const right = workspace.getRightLeaf(false);
		if (!right) return;
		await right.setViewState({ type: VIEW_TYPE_GIT, active: true });
		leaf = right;
	}
	// revealLeaf() would do both, but its current form needs Obsidian 1.7.2
	workspace.rightSplit.expand();
	workspace.setActiveLeaf(leaf, { focus: true });
}

function timeText(date: Date): string {
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Side panel with the commands and the list of modified files. */
export class GitPanelView extends ItemView {
	private unsubscribe: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly controller: GitController,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_GIT;
	}

	getDisplayText(): string {
		return 'Git';
	}

	getIcon(): string {
		return 'git-branch';
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.controller.onChange(() => this.render());
		this.render();
		await this.controller.refreshStatus();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private render(): void {
		const { state, running } = this.controller.snapshot();
		const el = this.contentEl;
		const scroll = el.scrollTop;
		el.empty();
		el.addClass('vault-git-panel');

		this.renderHeader(el.createDiv({ cls: 'vault-git-panel-header' }), state, running);
		this.renderActions(el.createDiv({ cls: 'vault-git-panel-actions' }), state, running !== null);
		if (state.kind === 'ready') {
			this.renderChanges(el.createDiv({ cls: 'vault-git-panel-changes' }), state.status);
			el.createDiv({ cls: 'vault-git-panel-footer', text: `Updated at ${timeText(state.updatedAt)}` });
		}
		el.scrollTop = scroll;
	}

	private renderHeader(header: HTMLElement, state: StatusBarState, running: string | null): void {
		switch (state.kind) {
			case 'ready': {
				const { status } = state;
				const branch = header.createDiv({ cls: 'vault-git-panel-branch' });
				setIcon(branch.createSpan({ cls: 'vault-git-panel-icon' }), 'git-branch');
				branch.createSpan({
					text: `${status.branch ?? 'detached HEAD'}${status.upstream ? ` → ${status.upstream}` : ''}`,
				});
				const details = [
					status.changedFiles === 1 ? '1 modified file' : `${status.changedFiles} modified files`,
					status.ahead ? `↑${status.ahead} to push` : null,
					status.behind ? `↓${status.behind} to pull` : null,
					status.upstream ? null : 'no upstream yet',
					status.merging ? 'merge in progress' : null,
				].filter(Boolean);
				header.createDiv({ cls: 'vault-git-panel-summary', text: details.join(' · ') });
				break;
			}
			case 'checking':
				header.createDiv({ text: 'Checking the repository…' });
				break;
			case 'no-git':
				header.createDiv({ text: `Git not found. Install Git or set its path in ${SETTINGS_PATH}.` });
				break;
			case 'not-repo':
				header.createDiv({ text: 'This vault is not a Git repository yet.' });
				break;
			case 'error':
				header.createDiv({ cls: 'vault-git-panel-error', text: state.message });
				break;
			case 'busy':
				break;
		}
		if (running) header.createDiv({ cls: 'vault-git-panel-running', text: `Running: ${running}…` });
	}

	private renderActions(container: HTMLElement, state: StatusBarState, busy: boolean): void {
		const controller = this.controller;
		const actions: PanelAction[] = [];
		if (state.kind === 'ready') {
			actions.push(
				{ icon: 'refresh-cw', label: 'Sync', run: () => void controller.sync(), style: 'cta' },
				{ icon: 'git-commit', label: 'Commit', run: () => void controller.commit() },
				{ icon: 'pencil', label: 'Commit with message…', run: () => void controller.commitWithMessage() },
				{ icon: 'download', label: 'Pull', run: () => void controller.pull() },
				{ icon: 'upload', label: 'Push', run: () => void controller.push() },
			);
			if (state.status.merging) {
				actions.push({ icon: 'undo-2', label: 'Abort merge', run: () => void controller.abortMerge(), style: 'warning' });
			}
		} else if (state.kind === 'not-repo') {
			actions.push({
				icon: 'git-branch',
				label: 'Initialize repository',
				run: () => void controller.initRepository(),
				style: 'cta',
			});
		}
		actions.push({ icon: 'rotate-cw', label: 'Refresh', run: () => void controller.setup() });

		for (const action of actions) {
			const button = container.createEl('button', { cls: 'vault-git-panel-button' });
			if (action.style === 'cta') button.addClass('mod-cta');
			if (action.style === 'warning') button.addClass('mod-warning');
			setIcon(button.createSpan({ cls: 'vault-git-panel-icon' }), action.icon);
			button.createSpan({ text: action.label });
			button.disabled = busy;
			button.addEventListener('click', () => action.run());
		}
	}

	private renderChanges(container: HTMLElement, status: RepoStatus): void {
		const title = container.createDiv({ cls: 'vault-git-panel-section-title' });
		title.createSpan({ text: 'Changes' });
		title.createSpan({ cls: 'vault-git-panel-count', text: String(status.files.length) });

		if (!status.files.length) {
			container.createDiv({ cls: 'vault-git-panel-empty', text: 'No changes: everything is committed.' });
			return;
		}
		for (const group of groupChanges(status.files)) this.renderGroup(container, group);
	}

	private renderGroup(container: HTMLElement, group: ChangeGroup): void {
		container.createDiv({
			cls: 'vault-git-panel-group-title',
			text: `${group.title} · ${group.files.length}`,
		});
		const list = container.createEl('ul', { cls: 'vault-git-panel-list' });
		for (const file of group.files) this.renderFile(list, group, file);
	}

	private renderFile(list: HTMLElement, group: ChangeGroup, file: ChangedFile): void {
		const shown = this.controller.vaultPathOf(file.path) ?? file.path;
		const slash = shown.lastIndexOf('/');
		const item = list.createEl('li', { cls: `vault-git-panel-file is-${file.kind}` });
		item.createSpan({ cls: 'vault-git-panel-badge', text: group.letter });
		item.createSpan({ cls: 'vault-git-panel-name', text: shown.slice(slash + 1) });
		if (slash > 0) item.createSpan({ cls: 'vault-git-panel-folder', text: shown.slice(0, slash) });
		setTooltip(item, file.from ? `${file.from} → ${shown}` : shown, { placement: 'left' });
		if (file.kind === 'deleted') return;
		item.addClass('is-clickable');
		item.addEventListener('click', (event: MouseEvent) => {
			this.controller.openFile(file.path, event.metaKey || event.ctrlKey);
		});
	}
}
