import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyGitError, GitErrorKind, gitErrorDetail } from '../src/git/errors';

const SAMPLES: [GitErrorKind, string][] = [
	['git-not-found', 'Error: spawn /usr/local/bin/git ENOENT'],
	['not-repo', 'fatal: not a git repository (or any of the parent directories): .git'],
	[
		'dubious-ownership',
		"fatal: detected dubious ownership in repository at 'D:/Vault'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/Vault",
	],
	[
		'identity',
		'Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
	],
	[
		'lock',
		"fatal: Unable to create '/vault/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
	],
	['timeout', 'GitPluginError: block timeout reached'],
	[
		'host-key',
		'No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.',
	],
	[
		'auth',
		'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights',
	],
	['auth', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
	['auth', 'fatal: unable to get password from user'],
	["auth", "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/me/vault.git/'"],
	['auth', "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/me/vault.git/'"],
	[
		'auth',
		"fatal: unable to access 'https://github.com/me/vault.git/': The requested URL returned error: 403",
	],
	['auth', 'ERROR: Repository not found.\nfatal: Could not read from remote repository.'],
	[
		'network',
		"fatal: unable to access 'https://github.com/me/vault.git/': Could not resolve host: github.com",
	],
	['network', 'ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.'],
	['network', 'ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known'],
	[
		'unmerged',
		'error: You have not concluded your merge (MERGE_HEAD exists).\nhint: Please, commit your changes before merging.\nfatal: Exiting because of unfinished merge.',
	],
	[
		'unmerged',
		"error: Pulling is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'",
	],
	[
		'local-changes',
		'error: Your local changes to the following files would be overwritten by merge:\n\tnote.md\nPlease commit your changes or stash them before you merge.\nAborting',
	],
	[
		'local-changes',
		'error: The following untracked working tree files would be overwritten by merge:\n\tnew.md',
	],
	['unrelated-histories', 'fatal: refusing to merge unrelated histories'],
	['diverged', 'fatal: Not possible to fast-forward, aborting.'],
	[
		'rejected',
		"To github.com:me/vault.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:me/vault.git'\nhint: Updates were rejected because the remote contains work that you do not",
	],
	[
		'no-upstream',
		'There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.',
	],
	[
		'no-remote',
		"fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
	],
	['unknown', 'fatal: something completely different happened'],
];

describe('classifyGitError', () => {
	for (const [kind, message] of SAMPLES) {
		it(`${kind}: ${message.split('\n')[0]}`, () => {
			assert.equal(classifyGitError(new Error(message)), kind);
		});
	}

	it('accepts non-Error values', () => {
		assert.equal(classifyGitError('fatal: not a git repository'), 'not-repo');
	});
});

describe('gitErrorDetail', () => {
	it('prefers the fatal/error line and skips progress output', () => {
		const output = [
			'Enumerating objects: 5, done.',
			'Counting objects: 100% (5/5), done.\rWriting objects:  50% (1/2)\rWriting objects: 100% (2/2)',
			'hint: Updates were rejected because the tip of your current branch is behind',
			"error: failed to push some refs to 'origin'",
		].join('\n');
		assert.equal(gitErrorDetail(new Error(output)), "error: failed to push some refs to 'origin'");
	});

	it('falls back to the last meaningful line and truncates long lines', () => {
		assert.equal(gitErrorDetail(new Error('first\nsecond\n')), 'second');
		const long = gitErrorDetail(new Error(`fatal: ${'x'.repeat(500)}`), 50);
		assert.equal(long.length, 50);
		assert.ok(long.endsWith('…'));
	});
});
