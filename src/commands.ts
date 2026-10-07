import type VaultGitPlugin from './main';

export function registerCommands(plugin: VaultGitPlugin): void {
	const controller = () => plugin.controller;

	plugin.addCommand({
		id: 'commit',
		name: 'Commit',
		callback: () => void controller().commit(),
	});
	plugin.addCommand({
		id: 'commit-with-message',
		name: 'Commit con messaggio personalizzato…',
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
		name: 'Sync (commit, pull e push)',
		callback: () => void controller().sync(),
	});
	plugin.addCommand({
		id: 'init-repository',
		name: 'Inizializza repository',
		callback: () => void controller().initRepository(),
	});
}
