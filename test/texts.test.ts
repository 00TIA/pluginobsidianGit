import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COMMIT_TEMPLATE, renderCommitMessage } from '../src/commit-message';
import {
	conflictNoticeLines,
	describeCommit,
	describePull,
	describePush,
	errorMessage,
	fileList,
} from '../src/messages';
import { DEFAULT_SETTINGS, normalizeSettings, parseInterval } from '../src/settings-data';
import { describeStatusBar } from '../src/ui/status-text';

const values = { date: '2026-10-07 14:30:00', hostname: 'laptop', numFiles: 3 };

describe('renderCommitMessage', () => {
	it('replaces the placeholders', () => {
		assert.equal(
			renderCommitMessage('backup {{date}} da {{ hostname }} ({{numFiles}} file)', values),
			'backup 2026-10-07 14:30:00 da laptop (3 file)',
		);
	});

	it('keeps unknown placeholders and falls back to the default template', () => {
		assert.equal(renderCommitMessage('{{foo}} {{date}}', values), '{{foo}} 2026-10-07 14:30:00');
		assert.equal(renderCommitMessage('   ', values), DEFAULT_COMMIT_TEMPLATE.replace('{{date}}', values.date));
	});
});

describe('settings', () => {
	it('parses the interval', () => {
		assert.equal(parseInterval('15'), 15);
		assert.equal(parseInterval(' 5 '), 5);
		assert.equal(parseInterval('0'), null);
		assert.equal(parseInterval('-3'), null);
		assert.equal(parseInterval('2.5'), null);
		assert.equal(parseInterval('abc'), null);
	});

	it('normalises saved data', () => {
		assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
		assert.deepEqual(
			normalizeSettings({
				gitPath: ' /opt/homebrew/bin/git ',
				autoBackup: 'yes',
				autoBackupInterval: 0,
				autoBackupSync: false,
				commitMessage: 42,
			}),
			{
				...DEFAULT_SETTINGS,
				gitPath: '/opt/homebrew/bin/git',
				autoBackupSync: false,
			},
		);
		assert.equal(normalizeSettings({ autoBackupInterval: '30' }).autoBackupInterval, 30);
	});
});

describe('messages', () => {
	it('lists files with a limit', () => {
		assert.equal(fileList(['a', 'b']), 'a, b');
		assert.equal(fileList(['a', 'b', 'c', 'd'], 2), 'a, b e altri 2');
	});

	it('describes outcomes', () => {
		assert.equal(describeCommit({ kind: 'committed', files: 1, message: 'm' }), 'Commit eseguito (1 file).');
		assert.equal(describePull({ kind: 'pulled', files: 4 }), 'Pull completato: 4 file aggiornati.');
		assert.match(
			describePush({ kind: 'pushed', commits: null, remote: 'origin', branch: 'main', setUpstream: true }),
			/«main» pubblicato su origin/,
		);
		assert.match(describePush({ kind: 'no-remote' }), /git remote add origin/);
	});

	it('explains that conflicts are not resolved automatically and nothing was pushed', () => {
		const text = conflictNoticeLines(['note.md']).join(' ');
		assert.match(text, /note\.md/);
		assert.match(text, /nessuna risoluzione automatica/);
		assert.match(text, /push non è stato eseguito/);
	});

	it('mentions SSH and the credential helper on authentication errors', () => {
		const text = errorMessage('auth', '/vault');
		assert.match(text, /non chiede mai credenziali/);
		assert.match(text, /SSH/);
		assert.match(text, /credential helper/);
	});
});

describe('status bar text', () => {
	const status = {
		branch: 'main',
		upstream: 'origin/main',
		ahead: 0,
		behind: 0,
		changedFiles: 3,
		conflicted: [],
		merging: false,
	};
	const updatedAt = new Date(2026, 9, 7, 14, 30, 0);

	it('shows the number of modified files', () => {
		assert.equal(describeStatusBar({ kind: 'ready', status, updatedAt }).text, 'Git: 3 file modificati');
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, changedFiles: 1 }, updatedAt }).text,
			'Git: 1 file modificato',
		);
	});

	it('shows commits to push/pull and conflicts', () => {
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, ahead: 2, behind: 1 }, updatedAt }).text,
			'Git: 3 file modificati ↑2 ↓1',
		);
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, conflicted: ['a.md', 'b.md'] }, updatedAt }).text,
			'Git: 2 in conflitto',
		);
	});

	it('shows the other states', () => {
		assert.equal(describeStatusBar({ kind: 'no-git' }).text, 'Git: non trovato');
		assert.equal(describeStatusBar({ kind: 'not-repo' }).text, 'Git: nessun repository');
		assert.equal(describeStatusBar({ kind: 'busy', label: 'sync in corso' }).text, 'Git: sync in corso…');
	});
});
