import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	augmentPath,
	BATCH_SSH_COMMAND,
	buildGitEnv,
	hasUserSshCommand,
	NON_INTERACTIVE_CONFIG,
} from '../src/git/git-env';

describe('buildGitEnv', () => {
	const base = {
		PATH: '/usr/bin:/bin',
		HOME: '/home/me',
		HTTPS_PROXY: 'http://proxy:8080',
		GIT_ASKPASS: '/usr/bin/ksshaskpass',
		SSH_ASKPASS: '/usr/bin/ksshaskpass',
		EDITOR: 'vim',
		VISUAL: 'code --wait',
		PAGER: 'less',
		GIT_EDITOR: 'nano',
		GIT_DIR: '/somewhere/else/.git',
		GIT_WORK_TREE: '/somewhere/else',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'core.pager',
		GIT_CONFIG_VALUE_0: 'less',
		GIT_SSH_COMMAND: 'ssh -i ~/.ssh/vault',
		GIT_SSL_CAINFO: '/etc/ssl/corp.pem',
		LANGUAGE: 'it',
		LC_ALL: 'it_IT.UTF-8',
	};

	it('removes everything that could prompt, open an editor or redirect the repository', () => {
		const { env } = buildGitEnv(base, { platform: 'linux' });
		for (const key of [
			'GIT_ASKPASS',
			'SSH_ASKPASS',
			'EDITOR',
			'VISUAL',
			'PAGER',
			'GIT_EDITOR',
			'GIT_DIR',
			'GIT_WORK_TREE',
			'GIT_CONFIG_COUNT',
			'GIT_CONFIG_KEY_0',
			'LANGUAGE',
		]) {
			assert.equal(env[key], undefined, key);
		}
	});

	it('disables interactive prompts and forces English messages', () => {
		const { env } = buildGitEnv(base, { platform: 'linux' });
		assert.equal(env.GIT_TERMINAL_PROMPT, '0');
		assert.equal(env.GCM_INTERACTIVE, 'never');
		assert.equal(env.SSH_ASKPASS_REQUIRE, 'never');
		assert.equal(env.LC_ALL, 'C');
		assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
		assert.ok(NON_INTERACTIVE_CONFIG.includes('core.askPass='));
		assert.ok(NON_INTERACTIVE_CONFIG.includes('credential.interactive=false'));
	});

	it('keeps the user setup (proxy, home, ssh command, certificates)', () => {
		const { env } = buildGitEnv(base, { platform: 'linux' });
		assert.equal(env.HOME, '/home/me');
		assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
		assert.equal(env.GIT_SSH_COMMAND, 'ssh -i ~/.ssh/vault');
		assert.equal(env.GIT_SSL_CAINFO, '/etc/ssl/corp.pem');
	});

	it('reports every guarded key to simple-git', () => {
		const { env, allowEnvironment } = buildGitEnv(base, { platform: 'linux' });
		const guarded = Object.keys(env).filter((key) => key.toLowerCase().startsWith('git_'));
		assert.deepEqual([...allowEnvironment].sort(), guarded.sort());
	});

	it('sets the batch ssh command only when asked', () => {
		const withoutUserSsh = { PATH: '/usr/bin' };
		assert.equal(buildGitEnv(withoutUserSsh, { platform: 'linux' }).env.GIT_SSH_COMMAND, undefined);
		const { env, allowEnvironment } = buildGitEnv(withoutUserSsh, {
			platform: 'linux',
			sshCommand: BATCH_SSH_COMMAND,
		});
		assert.equal(env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
		assert.ok(allowEnvironment.includes('GIT_SSH_COMMAND'));
	});

	it('appends the git folder and the well-known folders to PATH', () => {
		const { env } = buildGitEnv(
			{ PATH: '/usr/bin:/bin' },
			{ platform: 'darwin', gitPath: '/opt/homebrew/bin/git', extraPathDirs: ['/usr/local/bin', '/usr/bin'] },
		);
		assert.equal(env.PATH, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
	});

	it('keeps the Windows "Path" key and uses ";"', () => {
		const { env } = buildGitEnv(
			{ Path: 'C:\\Windows\\system32;C:\\Windows' },
			{
				platform: 'win32',
				gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
				extraPathDirs: ['c:\\windows'],
			},
		);
		assert.equal(env.PATH, undefined);
		assert.equal(env.Path, 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd');
	});
});

describe('augmentPath', () => {
	it('removes empty and duplicate entries', () => {
		assert.equal(augmentPath('/a::/b:/a', ['/c', '/b', ''], 'linux'), '/a:/b:/c');
		assert.equal(augmentPath('C:\\Git;c:\\tools', ['c:\\git', 'D:\\x'], 'win32'), 'C:\\Git;c:\\tools;D:\\x');
	});
});

describe('hasUserSshCommand', () => {
	it('detects GIT_SSH and GIT_SSH_COMMAND', () => {
		assert.equal(hasUserSshCommand({}), false);
		assert.equal(hasUserSshCommand({ GIT_SSH_COMMAND: '' }), false);
		assert.equal(hasUserSshCommand({ GIT_SSH: 'C:\\plink.exe' }), true);
		assert.equal(hasUserSshCommand({ git_ssh_command: 'ssh -i key' }), true);
	});
});
