import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { classifyGitError } from '../src/git/errors';
import { GitService, GitServiceOptions, hasConflictMarkers, SyncError } from '../src/git/git-service';
import { locateGit } from '../src/git/locate-git';
import { git, isolatedEnv, isWindows, read, removeDir, script, tempDir, write } from './helpers';

const CONFIG_DIR = '.config-dir';

let gitPath = 'git';
const cleanup: string[] = [];

before(async () => {
	gitPath = (await locateGit()).path;
});
after(() => cleanup.forEach(removeDir));

interface Fixture {
	root: string;
	env: NodeJS.ProcessEnv;
	remote: string;
	service(vault: string, options?: Partial<GitServiceOptions>): GitService;
	clone(name: string): string;
}

/** A bare "remote" plus helpers to create clones and services on top of it. */
function fixture(extraEnv: NodeJS.ProcessEnv = {}): Fixture {
	const root = tempDir();
	cleanup.push(root);
	const env = isolatedEnv(path.join(root, 'home'), extraEnv);
	const remote = path.join(root, 'remote.git');
	git(root, env, 'init', '--bare', remote);
	return {
		root,
		env,
		remote,
		service: (vault, options = {}) => new GitService({ vaultPath: vault, gitPath, baseEnv: env, ...options }),
		clone: (name) => {
			const dir = path.join(root, name);
			git(root, env, 'clone', remote, dir);
			return dir;
		},
	};
}

/** Creates a vault with one committed note, pushed to the remote with upstream. */
async function publishedVault(f: Fixture, name = 'vault') {
	const vault = path.join(f.root, name);
	fs.mkdirSync(vault);
	const service = f.service(vault);
	await service.init(CONFIG_DIR);
	write(vault, 'note.md', 'line 1\nline 2\nline 3\n');
	await service.commit('first');
	git(vault, f.env, 'remote', 'add', 'origin', f.remote);
	const push = await service.push();
	assert.equal(push.kind, 'pushed');
	return { vault, service };
}

describe('repository detection and init', () => {
	it('detects a folder that is not a repository and initialises it', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		assert.equal(await service.detectRepository(), null);

		const repo = await service.init(CONFIG_DIR);
		assert.equal(repo.vaultIsRoot, true);
		assert.ok(fs.existsSync(path.join(vault, '.git')));
		const gitignore = read(vault, '.gitignore');
		assert.match(gitignore, /^\.config-dir\/workspace\.json$/m);
		assert.match(gitignore, /^\.trash\/$/m);
		assert.match(read(vault, '.gitattributes'), /^\* text=auto$/m);
		assert.equal((await service.status()).branch, 'main');
	});

	it('does not overwrite an existing .gitignore', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		write(vault, '.gitignore', 'private/\n');
		await f.service(vault).init(CONFIG_DIR);
		assert.equal(read(vault, '.gitignore'), 'private/\n');
	});
});

describe('remote and author settings', () => {
	it('adds the origin remote, then changes its URL', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		await service.init(CONFIG_DIR);
		assert.equal(await service.remote(), null);

		assert.deepEqual(await service.setRemoteUrl(` ${f.remote} `), { name: 'origin', added: true });
		assert.deepEqual(await service.remote(), { name: 'origin', url: f.remote });

		const other = path.join(f.root, 'other.git');
		assert.deepEqual(await service.setRemoteUrl(other), { name: 'origin', added: false });
		assert.equal(git(vault, f.env, 'remote', 'get-url', 'origin'), other);

		await assert.rejects(service.setRemoteUrl('   '));
		await assert.rejects(service.setRemoteUrl('--upload-pack=touch /tmp/x'));
	});

	it('uses the remote of the upstream branch when it is not called origin', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		git(vault, f.env, 'remote', 'rename', 'origin', 'github');
		assert.deepEqual(await service.remote(), { name: 'github', url: f.remote });
	});

	it('sets the author in the repository only, and falls back to the global one', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		await service.init(CONFIG_DIR);
		const globalConfig = read(path.join(f.root, 'home'), '.gitconfig');

		assert.deepEqual(await service.identity(), {
			name: 'Test User',
			email: 'test@example.com',
			localName: null,
			localEmail: null,
		});

		await service.setIdentity({ name: ' Vault Owner ', email: 'owner@example.com' });
		assert.deepEqual(await service.identity(), {
			name: 'Vault Owner',
			email: 'owner@example.com',
			localName: 'Vault Owner',
			localEmail: 'owner@example.com',
		});
		write(vault, 'a.md', 'a');
		await service.commit('authored');
		assert.equal(git(vault, f.env, 'log', '-1', '--format=%an <%ae>'), 'Vault Owner <owner@example.com>');

		await service.setIdentity({ name: '', email: '' });
		assert.equal((await service.identity()).name, 'Test User');
		// unsetting twice is not an error
		await service.setIdentity({ name: '' });
		assert.equal(read(path.join(f.root, 'home'), '.gitconfig'), globalConfig);
	});
});

describe('commit', () => {
	it('counts modified files and commits all of them with the generated message', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		write(vault, 'new.md', 'new');
		write(vault, 'note.md', 'changed');
		write(vault, 'folder/deep.md', 'deep');
		fs.rmSync(path.join(vault, '.gitignore'));

		const status = await service.status();
		assert.equal(status.changedFiles, 4);

		const outcome = await service.commit((files) => `backup (${files} file)`);
		assert.deepEqual(outcome, { kind: 'committed', files: 4, message: 'backup (4 file)' });
		assert.equal(git(vault, f.env, 'log', '-1', '--format=%s'), 'backup (4 file)');
		assert.equal((await service.status()).changedFiles, 0);
		assert.equal((await service.status()).ahead, 1);
		assert.deepEqual(await service.commit('again'), { kind: 'nothing-to-commit' });
	});

	it('commits only the vault when it is a sub-folder of a larger repository', async () => {
		const f = fixture();
		const repoRoot = path.join(f.root, 'project');
		fs.mkdirSync(repoRoot);
		git(repoRoot, f.env, 'init');
		write(repoRoot, 'outside.txt', 'outside');
		write(repoRoot, 'notes/inside.md', 'inside');
		const service = f.service(path.join(repoRoot, 'notes'));

		const repo = await service.detectRepository();
		assert.equal(repo?.vaultIsRoot, false);
		assert.equal((await service.status()).changedFiles, 1);
		assert.equal((await service.commit('vault only')).kind, 'committed');
		assert.equal(git(repoRoot, f.env, 'ls-files'), 'notes/inside.md');
		assert.match(git(repoRoot, f.env, 'status', '--porcelain'), /\?\? outside\.txt/);
	});
});

describe('pull and push', () => {
	it('reports a missing remote', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		await service.init(CONFIG_DIR);
		assert.deepEqual(await service.push(), { kind: 'no-commits' });
		write(vault, 'a.md', 'a');
		await service.commit('a');
		assert.deepEqual(await service.push(), { kind: 'no-remote' });
		assert.deepEqual(await service.pull(), { kind: 'no-remote' });
		const sync = await service.sync('b');
		assert.equal(sync.pull?.kind, 'no-remote');
		assert.equal(sync.push, undefined);
	});

	it('sets the upstream on the first push, then pushes only when needed', async () => {
		const f = fixture();
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		await service.init(CONFIG_DIR);
		write(vault, 'a.md', 'a');
		await service.commit('a');
		git(vault, f.env, 'remote', 'add', 'origin', f.remote);

		assert.deepEqual(await service.pull(), { kind: 'no-upstream', branch: 'main' });
		assert.deepEqual(await service.push(), {
			kind: 'pushed',
			commits: null,
			remote: 'origin',
			branch: 'main',
			setUpstream: true,
		});
		assert.equal((await service.status()).upstream, 'origin/main');
		assert.deepEqual(await service.push(), { kind: 'up-to-date' });

		write(vault, 'b.md', 'b');
		await service.commit('b');
		const push = await service.push();
		assert.equal(push.kind === 'pushed' && push.commits, 1);
	});

	it('pulls the changes made on another device', async () => {
		const f = fixture();
		const { service } = await publishedVault(f);
		const other = f.clone('other');
		write(other, 'from-other.md', 'hello');
		write(other, 'note.md', 'line 1\nline 2 (other)\nline 3\n');
		git(other, f.env, 'add', '-A');
		git(other, f.env, 'commit', '-m', 'other');
		git(other, f.env, 'push');

		assert.deepEqual(await service.pull(), { kind: 'pulled', files: 2 });
		assert.deepEqual(await service.pull(), { kind: 'up-to-date' });
	});

	it('refuses to overwrite uncommitted local changes', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		const other = f.clone('other');
		write(other, 'note.md', 'remote version\n');
		git(other, f.env, 'commit', '-am', 'other');
		git(other, f.env, 'push');

		write(vault, 'note.md', 'local, not committed\n');
		await assert.rejects(service.pull(), (error) => classifyGitError(error) === 'local-changes');
		assert.equal(read(vault, 'note.md'), 'local, not committed\n');
	});

	it('reports a rejected push when the remote has new commits', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		const other = f.clone('other');
		write(other, 'other.md', 'x');
		git(other, f.env, 'add', '-A');
		git(other, f.env, 'commit', '-m', 'other');
		git(other, f.env, 'push');

		write(vault, 'mine.md', 'y');
		await service.commit('mine');
		await assert.rejects(service.push(), (error) => classifyGitError(error) === 'rejected');
	});
});

describe('conflicts', () => {
	it('stops after a conflicting pull: no automatic resolution, no push', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		const other = f.clone('other');
		write(other, 'note.md', 'line 1\nline 2 (other device)\nline 3\n');
		git(other, f.env, 'commit', '-am', 'other');
		git(other, f.env, 'push');
		const remoteHead = git(other, f.env, 'rev-parse', 'HEAD');

		write(vault, 'note.md', 'line 1\nline 2 (this device)\nline 3\n');
		const sync = await service.sync('mine');
		assert.equal(sync.commit.kind, 'committed');
		assert.deepEqual(sync.pull, { kind: 'conflicts', files: ['note.md'] });
		assert.equal(sync.push, undefined);

		// the remote did not receive anything
		assert.equal(git(f.root, f.env, '--git-dir', f.remote, 'rev-parse', 'main'), remoteHead);
		// the conflict is left in the file for the user to resolve
		const content = read(vault, 'note.md');
		assert.ok(hasConflictMarkers(content));
		assert.match(content, /this device/);
		assert.match(content, /other device/);
		const status = await service.status();
		assert.equal(status.merging, true);
		assert.deepEqual(status.conflicted, ['note.md']);

		// nothing proceeds while the conflict is there
		assert.deepEqual(await service.pull(), { kind: 'unresolved-conflicts', files: ['note.md'] });
		assert.deepEqual(await service.push(), { kind: 'unresolved-conflicts', files: ['note.md'] });
		// automatic backups never conclude a merge
		assert.deepEqual(await service.sync('auto'), {
			commit: { kind: 'merge-in-progress', files: ['note.md'] },
		});
		// a manual commit refuses while the markers are still in the file
		assert.deepEqual(await service.commit('manual', { concludeMerge: true }), {
			kind: 'unresolved-conflicts',
			files: ['note.md'],
		});

		// the user resolves the conflict, then Sync concludes the merge and pushes
		write(vault, 'note.md', 'line 1\nline 2 (both devices)\nline 3\n');
		const resolved = await service.sync('resolved', { concludeMerge: true });
		assert.equal(resolved.commit.kind, 'committed');
		assert.equal(resolved.pull?.kind, 'up-to-date');
		assert.equal(resolved.push?.kind, 'pushed');
		assert.equal((await service.status()).merging, false);
		assert.equal(
			git(f.root, f.env, '--git-dir', f.remote, 'show', 'main:note.md'),
			'line 1\nline 2 (both devices)\nline 3',
		);
	});

	it('aborts the merge left by a conflicting pull, keeping the local commit', async () => {
		const f = fixture();
		const { vault, service } = await publishedVault(f);
		const other = f.clone('other');
		write(other, 'note.md', 'remote version\n');
		git(other, f.env, 'commit', '-am', 'other');
		git(other, f.env, 'push');

		write(vault, 'note.md', 'local version\n');
		assert.equal((await service.sync('mine')).pull?.kind, 'conflicts');
		assert.deepEqual(await service.abortMerge(), { kind: 'aborted' });

		const status = await service.status();
		assert.equal(status.merging, false);
		assert.deepEqual(status.conflicted, []);
		assert.equal(read(vault, 'note.md'), 'local version\n');
		assert.equal(git(vault, f.env, 'log', '-1', '--format=%s'), 'mine');
		assert.deepEqual(await service.abortMerge(), { kind: 'no-merge' });
	});

	it('detects conflict markers only at the start of a line', () => {
		assert.equal(hasConflictMarkers('<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\n'), true);
		assert.equal(hasConflictMarkers('Title\n=======\ntext with <<<<<<< inside'), false);
	});
});

describe('credentials are never requested interactively', () => {
	let server: http.Server;
	let url = '';

	before(async () => {
		server = http.createServer((_request, response) => {
			response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="vault"' });
			response.end('authentication required');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vault.git`;
	});
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it('fails fast with an authentication error instead of prompting', async () => {
		const marker = path.join(tempDir(), 'askpass-called');
		cleanup.push(path.dirname(marker));
		const extra: NodeJS.ProcessEnv = {};
		if (!isWindows) {
			// a desktop askpass program that would show a password dialog
			const askpass = script(path.join(path.dirname(marker), 'askpass.sh'), `echo called >> "${marker}"\necho secret`);
			Object.assign(extra, { SSH_ASKPASS: askpass, GIT_ASKPASS: askpass, DISPLAY: ':0' });
		}
		const f = fixture(extra);
		const { vault, service } = await publishedVault(f);
		git(vault, f.env, 'remote', 'set-url', 'origin', url);

		const started = Date.now();
		await assert.rejects(service.pull(), (error) => {
			assert.equal(classifyGitError(error), 'auth', String(error));
			return true;
		});
		assert.ok(Date.now() - started < 30000);
		assert.equal(fs.existsSync(marker), false, 'the askpass program must not be started');

		// in a sync the local commit is kept and reported together with the failure
		write(vault, 'new.md', 'new');
		await assert.rejects(service.sync('local'), (error) => {
			assert.ok(error instanceof SyncError);
			assert.equal(error.step, 'pull');
			assert.equal(error.completed.commit.kind, 'committed');
			assert.equal(classifyGitError(error), 'auth');
			return true;
		});
		assert.equal(git(vault, f.env, 'log', '-1', '--format=%s'), 'local');
	});
});

describe('ssh', { skip: isWindows && 'uses POSIX shell scripts as fake ssh' }, () => {
	function fakeSsh(f: Fixture, body: string) {
		const bin = path.join(f.root, 'bin');
		fs.mkdirSync(bin);
		script(path.join(bin, 'ssh'), body);
		return bin;
	}

	it('runs ssh in batch mode when the user has no ssh command of their own', async () => {
		const f = fixture();
		const argsFile = path.join(f.root, 'ssh-args');
		const bin = fakeSsh(f, `echo "$@" > "${argsFile}"\necho "Permission denied (publickey)." >&2\nexit 255`);
		const { vault } = await publishedVault(f);
		git(vault, f.env, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/vault.git');
		const service = f.service(vault, { baseEnv: { ...f.env, PATH: `${bin}:${f.env.PATH ?? ''}` } });
		write(vault, 'new.md', 'new');
		await service.commit('new');

		await assert.rejects(service.push(), (error) => classifyGitError(error) === 'auth');
		assert.match(read(f.root, 'ssh-args'), /-o BatchMode=yes/);
	});

	it('respects core.sshCommand configured by the user', async () => {
		const f = fixture();
		const argsFile = path.join(f.root, 'custom-args');
		const custom = script(path.join(f.root, 'custom-ssh'), `echo "$@" > "${argsFile}"\nexit 255`);
		const { vault, service } = await publishedVault(f);
		git(vault, f.env, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/vault.git');
		git(vault, f.env, 'config', 'core.sshCommand', custom);
		write(vault, 'new.md', 'new');
		await service.commit('new');

		await assert.rejects(service.push());
		const args = read(f.root, 'custom-args');
		assert.match(args, /git@example\.invalid/);
		assert.doesNotMatch(args, /BatchMode/);
	});

	it('kills a network command that hangs', async () => {
		const f = fixture();
		const bin = fakeSsh(f, 'exec sleep 5');
		const { vault } = await publishedVault(f);
		git(vault, f.env, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/vault.git');
		const service = f.service(vault, {
			baseEnv: { ...f.env, PATH: `${bin}:${f.env.PATH ?? ''}` },
			networkTimeoutMs: 1500,
		});
		write(vault, 'new.md', 'new');
		await service.commit('new');
		await assert.rejects(service.push(), (error) => classifyGitError(error) === 'timeout');
	});
});

function hasGitLfs(): boolean {
	try {
		execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

describe('git LFS', { skip: !hasGitLfs() && 'git-lfs is not installed' }, () => {
	it('stores tracked files in LFS on commit and uploads them on push', async () => {
		const f = fixture();
		git(f.root, f.env, 'lfs', 'install');
		const vault = path.join(f.root, 'vault');
		fs.mkdirSync(vault);
		const service = f.service(vault);
		await service.init(CONFIG_DIR);
		git(vault, f.env, 'lfs', 'track', '*.pdf');
		fs.writeFileSync(path.join(vault, 'big.pdf'), Buffer.alloc(2 * 1024 * 1024, 7));
		assert.equal((await service.commit('with lfs')).kind, 'committed');

		// git stores a pointer, the content goes to LFS
		assert.match(git(vault, f.env, 'show', 'HEAD:big.pdf'), /^version https:\/\/git-lfs\.github\.com\/spec\/v1/);

		git(vault, f.env, 'remote', 'add', 'origin', f.remote);
		assert.equal((await service.push()).kind, 'pushed');
		const other = f.clone('other');
		assert.equal(fs.statSync(path.join(other, 'big.pdf')).size, 2 * 1024 * 1024);
	});
});
