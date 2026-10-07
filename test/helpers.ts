import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const isWindows = process.platform === 'win32';

/** Creates a temporary folder removed by the returned cleanup function. */
export function tempDir(prefix = 'vault-git-test-'): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Environment isolated from the machine running the tests: no system/global git
 * configuration, no credential helpers, a predictable identity and default branch.
 */
export function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		const lower = key.toLowerCase();
		if (lower.startsWith('git_') || lower.startsWith('ssh_') || lower === 'display') continue;
		env[key] = value;
	}
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(
		path.join(home, '.gitconfig'),
		'[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
	);
	return {
		...env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, '.config'),
		GIT_CONFIG_NOSYSTEM: '1',
		...extra,
	};
}

/** Runs git directly (outside the code under test) to prepare fixtures. */
export function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		env: { ...env, GIT_TERMINAL_PROMPT: '0' },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

export function write(dir: string, file: string, content: string): void {
	const target = path.join(dir, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

export function read(dir: string, file: string): string {
	return fs.readFileSync(path.join(dir, file), 'utf8');
}

/** Writes an executable POSIX shell script. */
export function script(file: string, body: string): string {
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}
