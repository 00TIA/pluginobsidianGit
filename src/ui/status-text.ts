import type { RepoStatus } from '../git/git-service';

export type StatusBarState =
	| { kind: 'checking' }
	| { kind: 'busy'; label: string }
	| { kind: 'no-git' }
	| { kind: 'not-repo' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; status: RepoStatus; updatedAt: Date };

function changedFilesText(count: number): string {
	return count === 1 ? '1 modified file' : `${count} modified files`;
}

function timeText(date: Date): string {
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Text and tooltip for each state; exported for tests. */
export function describeStatusBar(state: StatusBarState): { text: string; tooltip: string } {
	switch (state.kind) {
		case 'checking':
			return { text: 'Git: …', tooltip: 'Checking the repository' };
		case 'busy':
			return { text: `Git: ${state.label}…`, tooltip: `Running: ${state.label}` };
		case 'no-git':
			return {
				text: 'Git: not found',
				tooltip: 'Git executable not found: set its path in the plugin settings',
			};
		case 'not-repo':
			return {
				text: 'Git: no repository',
				tooltip: 'This vault is not a Git repository: click to initialize it',
			};
		case 'error':
			return { text: 'Git: error', tooltip: state.message };
		case 'ready': {
			const { status } = state;
			let text = status.conflicted.length
				? `Git: ${status.conflicted.length} conflicted`
				: `Git: ${changedFilesText(status.changedFiles)}`;
			if (status.ahead) text += ` ↑${status.ahead}`;
			if (status.behind) text += ` ↓${status.behind}`;
			const branch = status.branch ?? 'detached HEAD';
			const tooltip = [
				`Branch: ${branch}${status.upstream ? ` → ${status.upstream}` : ' (no upstream)'}`,
				status.merging ? 'Merge in progress' : null,
				status.ahead ? `Commits to push: ${status.ahead}` : null,
				status.behind ? `Commits to pull: ${status.behind}` : null,
				`Updated at ${timeText(state.updatedAt)}`,
			]
				.filter(Boolean)
				.join('\n');
			return { text, tooltip };
		}
	}
}
