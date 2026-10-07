import type { GitErrorKind } from './git/errors';
import type { CommitOutcome, PullOutcome, PushOutcome } from './git/git-service';

/** User-facing texts (Italian). No Obsidian imports, so they can be unit-tested. */

export const AUTH_HELP =
	'Il plugin non chiede mai credenziali: usa una chiave SSH caricata in ssh-agent oppure un credential helper con credenziali già salvate (Git Credential Manager, osxkeychain, libsecret…), poi verifica con un pull o un push da terminale.';

export function errorMessage(kind: GitErrorKind, vaultPath: string): string {
	switch (kind) {
		case 'git-not-found':
			return 'Git non trovato. Installa Git oppure indica il percorso dell\'eseguibile nelle impostazioni del plugin.';
		case 'not-repo':
			return 'Il vault non è un repository Git.';
		case 'dubious-ownership':
			return `Git rifiuta il repository perché appartiene a un altro utente. Da terminale: git config --global --add safe.directory "${vaultPath}"`;
		case 'identity':
			return 'Identità Git non configurata. Da terminale: git config --global user.name "Nome Cognome" e git config --global user.email "nome@esempio.it".';
		case 'lock':
			return 'Un altro processo git sta usando il repository (file .lock presente). Riprova tra poco; se il problema persiste chiudi gli altri programmi git o elimina .git/index.lock.';
		case 'timeout':
			return 'Git non ha risposto in tempo ed è stato interrotto. Controlla la connessione; con SSH verifica che la chiave sia caricata in ssh-agent.';
		case 'host-key':
			return 'Chiave host SSH sconosciuta o cambiata. Collegati una volta da terminale (es. ssh -T git@github.com) per verificarla e accettarla.';
		case 'auth':
			return `Autenticazione con il remote non riuscita. ${AUTH_HELP}`;
		case 'network':
			return 'Remote non raggiungibile. Controlla la connessione di rete e l\'URL del remote.';
		case 'unmerged':
			return 'C\'è un merge in corso con conflitti non risolti. Risolvi i conflitti nei file e poi esegui «Commit».';
		case 'local-changes':
			return 'Il pull sovrascriverebbe modifiche locali non ancora salvate in un commit. Esegui prima «Commit» oppure usa «Sync».';
		case 'unrelated-histories':
			return 'Il branch remoto ha una storia non collegata a quella locale: unisci i due repository da terminale.';
		case 'diverged':
			return 'Branch locale e remoto sono divergenti e la configurazione Git non consente il merge (pull.ff=only).';
		case 'rejected':
			return 'Push rifiutato: il remote contiene commit che non hai in locale. Esegui «Pull» o «Sync» e riprova.';
		case 'no-upstream':
			return 'Il branch corrente non ha un upstream configurato.';
		case 'no-remote':
			return 'Nessun remote configurato. Aggiungilo da terminale: git remote add origin <url>';
		case 'unknown':
			return 'Operazione Git non riuscita.';
	}
}

/** Kinds whose message is enough on its own (git's output adds nothing useful). */
export function shouldShowDetail(kind: GitErrorKind): boolean {
	return !['git-not-found', 'not-repo', 'identity', 'lock', 'timeout'].includes(kind);
}

export function fileList(files: string[], max = 5): string {
	const shown = files.slice(0, max).join(', ');
	return files.length > max ? `${shown} e altri ${files.length - max}` : shown;
}

function files(count: number): string {
	return count === 1 ? '1 file' : `${count} file`;
}

export const NO_REMOTE_TEXT =
	'Nessun remote configurato: aggiungilo da terminale con «git remote add origin <url>».';
export const DETACHED_TEXT =
	'HEAD staccato (detached): passa a un branch per eseguire pull e push.';

export function unresolvedConflictsText(conflicted: string[]): string {
	return conflicted.length
		? `Conflitti ancora da risolvere in: ${fileList(conflicted)}. Elimina i marcatori <<<<<<< / >>>>>>> e poi esegui «Commit».`
		: 'C\'è un merge in corso: esegui «Commit» per concluderlo.';
}

export function conflictNoticeLines(conflicted: string[]): string[] {
	return [
		`Conflitti dopo il pull in ${files(conflicted.length)}: ${fileList(conflicted)}.`,
		'Operazione interrotta: nessuna risoluzione automatica è stata tentata e il push non è stato eseguito.',
		'Apri i file, scegli il contenuto corretto tra i marcatori <<<<<<< e >>>>>>>, elimina i marcatori e poi esegui «Commit» (o «Sync»).',
	];
}

export function describeCommit(outcome: CommitOutcome): string {
	switch (outcome.kind) {
		case 'committed':
			return `Commit eseguito (${files(outcome.files)}).`;
		case 'nothing-to-commit':
			return 'Nessuna modifica da salvare.';
		case 'merge-in-progress':
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
	}
}

export function describePull(outcome: PullOutcome): string {
	switch (outcome.kind) {
		case 'pulled':
			return outcome.files
				? `Pull completato: ${files(outcome.files)} aggiornati.`
				: 'Pull completato.';
		case 'up-to-date':
			return 'Pull: già aggiornato.';
		case 'conflicts':
			return conflictNoticeLines(outcome.files).join(' ');
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
		case 'no-remote':
			return NO_REMOTE_TEXT;
		case 'no-upstream':
			return `Il branch «${outcome.branch}» non esiste ancora sul remote: niente da scaricare.`;
		case 'detached':
			return DETACHED_TEXT;
	}
}

export function describePush(outcome: PushOutcome): string {
	switch (outcome.kind) {
		case 'pushed':
			if (outcome.setUpstream) {
				return `Push completato: branch «${outcome.branch}» pubblicato su ${outcome.remote}.`;
			}
			return outcome.commits
				? `Push completato (${outcome.commits} commit).`
				: 'Push completato.';
		case 'up-to-date':
			return 'Push: niente da inviare.';
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
		case 'no-remote':
			return NO_REMOTE_TEXT;
		case 'no-commits':
			return 'Nessun commit da inviare: esegui prima «Commit».';
		case 'detached':
			return DETACHED_TEXT;
	}
}
