import type { RepoStatus } from '../git/git-service';

export type StatusBarState =
	| { kind: 'checking' }
	| { kind: 'busy'; label: string }
	| { kind: 'no-git' }
	| { kind: 'not-repo' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; status: RepoStatus; updatedAt: Date };

function changedFilesText(count: number): string {
	return count === 1 ? '1 file modificato' : `${count} file modificati`;
}

function timeText(date: Date): string {
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Text and tooltip for each state; exported for tests. */
export function describeStatusBar(state: StatusBarState): { text: string; tooltip: string } {
	switch (state.kind) {
		case 'checking':
			return { text: 'Git: …', tooltip: 'Verifica del repository in corso' };
		case 'busy':
			return { text: `Git: ${state.label}…`, tooltip: `Operazione in corso: ${state.label}` };
		case 'no-git':
			return {
				text: 'Git: non trovato',
				tooltip: 'Eseguibile Git non trovato: imposta il percorso nelle impostazioni del plugin',
			};
		case 'not-repo':
			return {
				text: 'Git: nessun repository',
				tooltip: 'Il vault non è un repository Git: clicca per inizializzarlo',
			};
		case 'error':
			return { text: 'Git: errore', tooltip: state.message };
		case 'ready': {
			const { status } = state;
			let text = status.conflicted.length
				? `Git: ${status.conflicted.length} in conflitto`
				: `Git: ${changedFilesText(status.changedFiles)}`;
			if (status.ahead) text += ` ↑${status.ahead}`;
			if (status.behind) text += ` ↓${status.behind}`;
			const branch = status.branch ?? 'HEAD staccato';
			const tooltip = [
				`Branch: ${branch}${status.upstream ? ` → ${status.upstream}` : ' (nessun upstream)'}`,
				status.merging ? 'Merge in corso' : null,
				status.ahead ? `Commit da inviare: ${status.ahead}` : null,
				status.behind ? `Commit da scaricare: ${status.behind}` : null,
				`Aggiornato alle ${timeText(state.updatedAt)}`,
			]
				.filter(Boolean)
				.join('\n');
			return { text, tooltip };
		}
	}
}
