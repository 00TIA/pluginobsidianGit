import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { GitService } from '../src/git/git-service';
import {
	candidateGitPaths,
	expandHome,
	GitNotFoundError,
	knownGitDirs,
	locateGit,
} from '../src/git/locate-git';
import { isWindows, removeDir, tempDir } from './helpers';

describe('candidateGitPaths', () => {
	it('macOS: PATH first, then Homebrew/MacPorts/Nix/Xcode; /usr/bin/git last', () => {
		const candidates = candidateGitPaths('darwin', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, '/Users/me').map(
			(c) => c.path,
		);
		assert.deepEqual(candidates.slice(0, 4), ['/usr/bin/git', '/bin/git', '/usr/sbin/git', '/sbin/git']);
		assert.ok(candidates.includes('/opt/homebrew/bin/git'));
		assert.ok(candidates.includes('/usr/local/bin/git'));
		assert.ok(candidates.includes('/opt/local/bin/git'));
		assert.ok(candidates.includes('/Users/me/.nix-profile/bin/git'));
		// no duplicates
		assert.equal(new Set(candidates).size, candidates.length);
	});

	it('Windows: git.exe, Git for Windows locations, case-insensitive de-duplication', () => {
		const env = {
			Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows',
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
			USERPROFILE: 'C:\\Users\\me',
		};
		const candidates = candidateGitPaths('win32', env, 'C:\\Users\\me');
		assert.deepEqual(candidates[0], { path: 'C:\\Program Files\\Git\\cmd\\git.exe', source: 'path' });
		const paths = candidates.map((c) => c.path.toLowerCase());
		assert.equal(new Set(paths).size, paths.length);
		assert.ok(paths.includes('c:\\program files (x86)\\git\\cmd\\git.exe'));
		assert.ok(paths.includes('c:\\users\\me\\appdata\\local\\programs\\git\\cmd\\git.exe'));
		assert.ok(paths.includes('c:\\users\\me\\scoop\\shims\\git.exe'));
	});

	it('Linux: ignores relative PATH entries', () => {
		const candidates = candidateGitPaths('linux', { PATH: 'bin:/usr/bin' }, '/home/me');
		assert.equal(candidates[0]?.path, '/usr/bin/git');
		assert.ok(!candidates.some((c) => c.path === 'bin/git'));
		assert.ok(knownGitDirs('linux', {}, '/home/me').includes('/snap/bin'));
	});

	it('expands ~ in the configured path', () => {
		assert.equal(expandHome('~/bin/git', '/home/me'), path.join('/home/me', 'bin/git'));
		assert.equal(expandHome('/usr/bin/git', '/home/me'), '/usr/bin/git');
	});
});

describe('locateGit (real system)', () => {
	const dirs: string[] = [];
	after(() => dirs.forEach(removeDir));

	it('finds git through PATH', async () => {
		const location = await locateGit();
		assert.match(location.version, /^git version /);
		assert.ok(path.isAbsolute(location.path));
	});

	it('finds git in a well-known location when PATH is empty (Obsidian started from the Dock)', async () => {
		const env = { ...process.env, PATH: '', Path: '' };
		const location = await locateGit({ env, useLoginShell: false });
		assert.equal(location.source, 'known-location');
		assert.match(location.version, /^git version /);
	});

	it('uses the configured path, also when it contains spaces', async () => {
		const real = await locateGit();
		let configured = real.path;
		if (!isWindows) {
			const dir = path.join(tempDir(), 'my tools');
			dirs.push(path.dirname(dir));
			fs.mkdirSync(dir);
			configured = path.join(dir, 'git');
			fs.symlinkSync(real.path, configured);
		}
		const location = await locateGit({ configuredPath: configured });
		assert.equal(location.source, 'settings');
		assert.equal(location.path, configured);
		// simple-git accepts the binary even with spaces in its path
		const vault = tempDir();
		dirs.push(vault);
		const service = new GitService({ vaultPath: vault, gitPath: configured });
		assert.match(await service.version(), /^git version /);
	});

	it('reports a configured path that does not work', async () => {
		const missing = path.join(tempDir(), 'no-git-here', isWindows ? 'git.exe' : 'git');
		dirs.push(path.dirname(path.dirname(missing)));
		await assert.rejects(locateGit({ configuredPath: missing }), (error: unknown) => {
			assert.ok(error instanceof GitNotFoundError);
			assert.equal(error.configuredPath, missing);
			return true;
		});
	});
});
