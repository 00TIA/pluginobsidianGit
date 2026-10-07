import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COMMIT_TEMPLATE, renderCommitMessage } from '../src/commit-message';
import { changeKind, groupChanges } from '../src/git/changes';
import { nextStep, parseStepText, SETUP_STEPS, setupCompletion, stepParagraphs } from '../src/setup-guide';
import {
	conflictNoticeLines,
	describeCommit,
	describePull,
	describePush,
	errorMessage,
	fileList,
	formatSize,
	largeFilesLines,
} from '../src/messages';
import { DEFAULT_SETTINGS, normalizeSettings, parseInterval, parseLargeFileLimit } from '../src/settings-data';
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

describe('changed files', () => {
	it('maps git status codes to kinds of change', () => {
		assert.equal(changeKind(' ', 'M'), 'modified');
		assert.equal(changeKind('M', 'M'), 'modified');
		assert.equal(changeKind('?', '?'), 'added');
		assert.equal(changeKind('A', ' '), 'added');
		assert.equal(changeKind(' ', 'D'), 'deleted');
		assert.equal(changeKind('R', ' '), 'renamed');
		assert.equal(changeKind('U', 'U'), 'conflicted');
		assert.equal(changeKind('A', 'A'), 'conflicted');
	});

	it('groups changes (conflicts first) and sorts them naturally', () => {
		const groups = groupChanges([
			{ path: 'b/note 10.md', kind: 'modified' },
			{ path: 'b/note 2.md', kind: 'modified' },
			{ path: 'old.md', kind: 'deleted' },
			{ path: 'Zeta.md', kind: 'added' },
			{ path: 'alpha.md', kind: 'added' },
			{ path: 'clash.md', kind: 'conflicted' },
		]);
		assert.deepEqual(
			groups.map((group) => [group.title, group.letter, group.files.map((file) => file.path)]),
			[
				['Conflicts', 'U', ['clash.md']],
				['Modified', 'M', ['b/note 2.md', 'b/note 10.md']],
				['New', 'A', ['alpha.md', 'Zeta.md']],
				['Deleted', 'D', ['old.md']],
			],
		);
	});
});

describe('setup guide', () => {
	const none = { git: null, repo: null, author: null, remote: null, sync: null };

	it('lists the steps in order: computer first, then Obsidian, then the online copy', () => {
		assert.deepEqual(
			SETUP_STEPS.map((step) => step.id),
			['git', 'repo', 'author', 'remote', 'sync'],
		);
		assert.equal(SETUP_STEPS[0]?.where, 'on your computer');
	});

	it('explains how to install Git on the operating system in use', () => {
		const git = SETUP_STEPS[0]!;
		const mac = stepParagraphs(git, 'macos').join(' ');
		const windows = stepParagraphs(git, 'windows').join(' ');
		const linux = stepParagraphs(git, 'linux').join(' ');
		assert.match(mac, /Terminal.*xcode-select --install/);
		assert.doesNotMatch(mac, /Git for Windows|apt/);
		assert.match(windows, /Git for Windows.*git-scm\.com/);
		assert.doesNotMatch(windows, /xcode-select/);
		assert.match(linux, /sudo apt install git/);
		for (const text of [mac, windows, linux]) {
			assert.match(text, /not inside Obsidian/);
			assert.match(text, /Check again/);
		}
	});

	it('splits bold labels, code and links from plain text', () => {
		assert.deepEqual(parseStepText('Paste it in **Remote URL**, run `ssh -T git@github.com` ([guide](https://docs.github.com/x)).'), [
			{ text: 'Paste it in ', style: 'plain' },
			{ text: 'Remote URL', style: 'bold' },
			{ text: ', run ', style: 'plain' },
			{ text: 'ssh -T git@github.com', style: 'code' },
			{ text: ' (', style: 'plain' },
			{ text: 'guide', style: 'link', href: 'https://docs.github.com/x' },
			{ text: ').', style: 'plain' },
		]);
		// only https links become links
		assert.deepEqual(parseStepText('[x](javascript:alert(1))'), [{ text: '[x](javascript:alert(1))', style: 'plain' }]);
	});

	it('finds the next step and counts the steps done', () => {
		assert.equal(nextStep(none), 'git');
		const halfway = { ...none, git: '/usr/bin/git (2.43.0)', repo: 'Repository created in the vault' };
		assert.equal(nextStep(halfway), 'author');
		assert.deepEqual(setupCompletion(halfway), { done: 2, total: 5 });
		const complete = { git: 'g', repo: 'r', author: 'a', remote: 'u', sync: 's' };
		assert.equal(nextStep(complete), null);
		assert.deepEqual(setupCompletion(complete), { done: 5, total: 5 });
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
		assert.equal(normalizeSettings({ pullOnStartup: true }).pullOnStartup, true);
		assert.equal(normalizeSettings({ largeFileLimitMb: 0 }).largeFileLimitMb, 0);
		assert.equal(normalizeSettings({ largeFileLimitMb: -5 }).largeFileLimitMb, 50);
		assert.equal(parseLargeFileLimit('100'), 100);
		assert.equal(parseLargeFileLimit('0'), 0);
		assert.equal(parseLargeFileLimit('1.5'), null);
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
		assert.equal(fileList(['a', 'b', 'c', 'd'], 2), 'a, b and 2 more');
	});

	it('describes outcomes', () => {
		assert.equal(describeCommit({ kind: 'committed', files: 1, message: 'm' }), 'Committed 1 file.');
		assert.equal(describePull({ kind: 'pulled', files: 4 }), 'Pulled: 4 files updated.');
		assert.match(
			describePush({ kind: 'pushed', commits: null, remote: 'origin', branch: 'main', setUpstream: true }),
			/"main" published to origin/,
		);
		assert.match(describePush({ kind: 'no-remote' }), /set the remote URL in Settings → Mercurio Git Sync/);
		assert.equal(
			describePush({ kind: 'pushed', commits: 2, remote: 'origin', branch: 'main', setUpstream: false }),
			'Pushed 2 commits.',
		);
	});

	it('explains that conflicts are not resolved automatically and nothing was pushed', () => {
		const text = conflictNoticeLines(['note.md']).join(' ');
		assert.match(text, /note\.md/);
		assert.match(text, /no automatic resolution/);
		assert.match(text, /nothing was pushed/);
		assert.match(text, /Abort merge/);
	});

	it('describes large files with their size', () => {
		assert.equal(formatSize(230 * 1024 * 1024), '230 MB');
		assert.equal(formatSize(1.5 * 1024 * 1024), '1.5 MB');
		assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.0 GB');
		const [first, second] = largeFilesLines([{ path: 'video.mp4', size: 230 * 1024 * 1024 }], 50);
		assert.equal(first, 'This file is larger than 50 MB and not tracked by Git LFS: video.mp4 (230 MB).');
		assert.match(second ?? '', /Git LFS/);
		assert.match(second ?? '', /100 MB/);
	});

	it('mentions SSH and the credential helper on authentication errors', () => {
		const text = errorMessage('auth', '/vault');
		assert.match(text, /never asks for credentials/);
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
		files: [],
		conflicted: [],
		merging: false,
	};
	const updatedAt = new Date(2026, 9, 7, 14, 30, 0);

	it('shows the number of modified files', () => {
		assert.equal(describeStatusBar({ kind: 'ready', status, updatedAt }).text, 'Git: 3 modified files');
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, changedFiles: 1 }, updatedAt }).text,
			'Git: 1 modified file',
		);
	});

	it('shows commits to push/pull and conflicts', () => {
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, ahead: 2, behind: 1 }, updatedAt }).text,
			'Git: 3 modified files ↑2 ↓1',
		);
		assert.equal(
			describeStatusBar({ kind: 'ready', status: { ...status, conflicted: ['a.md', 'b.md'] }, updatedAt }).text,
			'Git: 2 conflicted',
		);
	});

	it('shows the other states', () => {
		assert.equal(describeStatusBar({ kind: 'no-git' }).text, 'Git: not found');
		assert.equal(describeStatusBar({ kind: 'not-repo' }).text, 'Git: no repository');
		assert.equal(describeStatusBar({ kind: 'busy', label: 'sync' }).text, 'Git: sync…');
	});
});
