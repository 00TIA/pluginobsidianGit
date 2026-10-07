import type VaultGitPlugin from './main';
import { openGitPanel } from './ui/git-view';

export function registerCommands(plugin: VaultGitPlugin): void {
	const controller = () => plugin.controller;

	plugin.addCommand({
		id: 'open-panel',
		name: 'Open Git panel',
		callback: () => void openGitPanel(plugin.app.workspace),
	});
	plugin.addCommand({
		id: 'commit',
		name: 'Commit',
		callback: () => void controller().commit(),
	});
	plugin.addCommand({
		id: 'commit-with-message',
		name: 'Commit with custom message…',
		callback: () => void controller().commitWithMessage(),
	});
	plugin.addCommand({
		id: 'pull',
		name: 'Pull',
		callback: () => void controller().pull(),
	});
	plugin.addCommand({
		id: 'push',
		name: 'Push',
		callback: () => void controller().push(),
	});
	plugin.addCommand({
		id: 'sync',
		name: 'Sync (commit, pull and push)',
		callback: () => void controller().sync(),
	});
	plugin.addCommand({
		id: 'abort-merge',
		name: 'Abort merge',
		callback: () => void controller().abortMerge(),
	});
	plugin.addCommand({
		id: 'init-repository',
		name: 'Initialize repository',
		callback: () => void controller().initRepository(),
	});
}
