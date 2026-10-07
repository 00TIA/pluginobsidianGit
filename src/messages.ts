import type { GitErrorKind } from './git/errors';
import type { CommitOutcome, LargeFile, PullOutcome, PushOutcome } from './git/git-service';

/** User-facing texts. No Obsidian imports, so they can be unit-tested. */

export const SETTINGS_PATH = 'Settings → Mercurio Git Sync';

export const AUTH_HELP =
	'This plugin never asks for credentials: use an SSH key loaded in ssh-agent or a credential helper with saved credentials (Git Credential Manager, osxkeychain, libsecret…), then check with a pull or push from a terminal.';

export function errorMessage(kind: GitErrorKind, vaultPath: string): string {
	switch (kind) {
		case 'git-not-found':
			return `Git not found. Install Git or set the path of the executable in ${SETTINGS_PATH}.`;
		case 'not-repo':
			return 'This vault is not a Git repository.';
		case 'dubious-ownership':
			return `Git refuses the repository because it belongs to another user. From a terminal: git config --global --add safe.directory "${vaultPath}"`;
		case 'identity':
			return `Git does not know who you are. Set the author name and email in ${SETTINGS_PATH}, or from a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com".`;
		case 'lock':
			return 'Another Git process is using the repository (a .lock file exists). Try again shortly; if it persists, close the other Git programs or delete .git/index.lock.';
		case 'timeout':
			return 'Git did not answer in time and was stopped. Check the connection; with SSH make sure the key is loaded in ssh-agent.';
		case 'host-key':
			return 'Unknown or changed SSH host key. Connect once from a terminal (e.g. ssh -T git@github.com) to verify and accept it.';
		case 'auth':
			return `Authentication with the remote failed. ${AUTH_HELP}`;
		case 'network':
			return 'The remote cannot be reached. Check the network connection and the remote URL.';
		case 'unmerged':
			return 'A merge with unresolved conflicts is in progress. Resolve the conflicts, then run "Commit" (or "Abort merge").';
		case 'local-changes':
			return 'The pull would overwrite local changes that are not committed yet. Run "Commit" first, or use "Sync".';
		case 'unrelated-histories':
			return 'The remote branch has a history unrelated to the local one: merge the two repositories from a terminal.';
		case 'diverged':
			return 'The local and remote branches have diverged and your Git configuration does not allow a merge (pull.ff=only).';
		case 'rejected':
			return 'Push rejected: the remote has commits you do not have locally. Run "Pull" or "Sync" and try again.';
		case 'no-upstream':
			return 'The current branch has no upstream branch.';
		case 'no-remote':
			return `No remote configured. Set the remote URL in ${SETTINGS_PATH}.`;
		case 'unknown':
			return 'The Git operation failed.';
	}
}

/** Kinds whose message is enough on its own (Git's output adds nothing useful). */
export function shouldShowDetail(kind: GitErrorKind): boolean {
	return !['git-not-found', 'not-repo', 'identity', 'lock', 'timeout'].includes(kind);
}

export function fileList(files: string[], max = 5): string {
	const shown = files.slice(0, max).join(', ');
	return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}

export function filesText(count: number): string {
	return count === 1 ? '1 file' : `${count} files`;
}

export function formatSize(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function largeFilesLines(files: LargeFile[], limitMb: number): string[] {
	const list = fileList(files.map((file) => `${file.path} (${formatSize(file.size)})`));
	return [
		`${files.length === 1 ? 'This file is' : 'These files are'} larger than ${limitMb} MB and not tracked by Git LFS: ${list}.`,
		'Once committed, a file stays in the repository history for good, and GitHub rejects files over 100 MB. Track large files with Git LFS, or add them to .gitignore.',
	];
}

export const NO_REMOTE_TEXT = `No remote configured: set the remote URL in ${SETTINGS_PATH}.`;
export const DETACHED_TEXT = 'Detached HEAD: check out a branch to pull and push.';

export function unresolvedConflictsText(conflicted: string[]): string {
	return conflicted.length
		? `Conflicts still to resolve in: ${fileList(conflicted)}. Remove the <<<<<<< / >>>>>>> markers, then run "Commit" (or "Abort merge").`
		: 'A merge is in progress: run "Commit" to conclude it, or "Abort merge".';
}

export function conflictNoticeLines(conflicted: string[]): string[] {
	return [
		`Conflicts after the pull in ${filesText(conflicted.length)}: ${fileList(conflicted)}.`,
		'Stopped: no automatic resolution was attempted and nothing was pushed.',
		'Open the files, keep the right content between the <<<<<<< and >>>>>>> markers, remove the markers, then run "Commit" (or "Sync"). "Abort merge" goes back to the state before the pull.',
	];
}

export function describeCommit(outcome: CommitOutcome): string {
	switch (outcome.kind) {
		case 'committed':
			return `Committed ${filesText(outcome.files)}.`;
		case 'nothing-to-commit':
			return 'Nothing to commit.';
		case 'merge-in-progress':
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
	}
}

export function describePull(outcome: PullOutcome): string {
	switch (outcome.kind) {
		case 'pulled':
			return outcome.files ? `Pulled: ${filesText(outcome.files)} updated.` : 'Pulled.';
		case 'up-to-date':
			return 'Pull: already up to date.';
		case 'conflicts':
			return conflictNoticeLines(outcome.files).join(' ');
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
		case 'no-remote':
			return NO_REMOTE_TEXT;
		case 'no-upstream':
			return `Branch "${outcome.branch}" does not exist on the remote yet: nothing to pull.`;
		case 'detached':
			return DETACHED_TEXT;
	}
}

export function describePush(outcome: PushOutcome): string {
	switch (outcome.kind) {
		case 'pushed':
			if (outcome.setUpstream) {
				return `Pushed: branch "${outcome.branch}" published to ${outcome.remote}.`;
			}
			return outcome.commits === 1
				? 'Pushed 1 commit.'
				: outcome.commits
					? `Pushed ${outcome.commits} commits.`
					: 'Pushed.';
		case 'up-to-date':
			return 'Push: nothing to push.';
		case 'unresolved-conflicts':
			return unresolvedConflictsText(outcome.files);
		case 'no-remote':
			return NO_REMOTE_TEXT;
		case 'no-commits':
			return 'No commits to push yet: run "Commit" first.';
		case 'detached':
			return DETACHED_TEXT;
	}
}
