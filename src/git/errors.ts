/**
 * Classification of git failures into user-facing categories.
 * git runs with LC_ALL=C (see git-env.ts) so its messages are in English.
 */

export type GitErrorKind =
	| 'git-not-found'
	| 'not-repo'
	| 'dubious-ownership'
	| 'identity'
	| 'lock'
	| 'timeout'
	| 'host-key'
	| 'auth'
	| 'network'
	| 'unmerged'
	| 'local-changes'
	| 'unrelated-histories'
	| 'diverged'
	| 'rejected'
	| 'no-upstream'
	| 'no-remote'
	| 'unknown';

interface Rule {
	kind: GitErrorKind;
	patterns: RegExp[];
}

// Order matters: the first matching rule wins.
const RULES: Rule[] = [
	{ kind: 'git-not-found', patterns: [/\bENOENT\b/, /spawn .*git.* ENOENT/i] },
	{ kind: 'dubious-ownership', patterns: [/detected dubious ownership/i, /safe\.directory/i] },
	{ kind: 'not-repo', patterns: [/not a git repository/i] },
	{
		kind: 'identity',
		patterns: [
			/please tell me who you are/i,
			/author identity unknown/i,
			/committer identity unknown/i,
			/unable to auto-detect email address/i,
			/empty ident name/i,
		],
	},
	{ kind: 'lock', patterns: [/\.lock'?: file exists/i, /unable to create '.*\.lock'/i] },
	{ kind: 'timeout', patterns: [/block timeout reached/i] },
	{ kind: 'host-key', patterns: [/host key verification failed/i] },
	{
		kind: 'auth',
		patterns: [
			/permission denied \(publickey/i,
			/permission denied, please try again/i,
			/could not read (username|password)/i,
			/terminal prompts disabled/i,
			/authentication failed/i,
			/http basic: access denied/i,
			/invalid username or password/i,
			/invalid credentials/i,
			/the requested url returned error: 40[13]/i,
			/support for password authentication was removed/i,
			/permission to .+ denied/i,
			/repository not found/i,
			/\baccess denied\b/i,
			/no supported authentication methods available/i,
		],
	},
	{
		kind: 'network',
		patterns: [
			/could not resolve host/i,
			/could not resolve hostname/i,
			/failed to connect to/i,
			/connection (refused|timed out|reset|closed)/i,
			/network is unreachable/i,
			/operation timed out/i,
			/no route to host/i,
			/temporary failure in name resolution/i,
			/ssl (certificate problem|connect error)/i,
			/the remote end hung up unexpectedly/i,
		],
	},
	{
		kind: 'unmerged',
		patterns: [
			/you have not concluded your merge/i,
			/merge_head exists/i,
			/you have unmerged files/i,
			/unmerged files/i,
			/resolve your current index first/i,
			/is not possible because you have unmerged files/i,
		],
	},
	{
		kind: 'local-changes',
		patterns: [
			/would be overwritten by merge/i,
			/untracked working tree files would be (overwritten|removed)/i,
			/please commit your changes or stash them/i,
		],
	},
	{ kind: 'unrelated-histories', patterns: [/refusing to merge unrelated histories/i] },
	{
		kind: 'diverged',
		patterns: [/not possible to fast-forward/i, /need to specify how to reconcile divergent/i],
	},
	{
		kind: 'rejected',
		patterns: [
			/\[rejected\]/i,
			/non-fast-forward/i,
			/fetch first/i,
			/updates were rejected/i,
			/failed to push some refs/i,
		],
	},
	{
		kind: 'no-upstream',
		patterns: [/no tracking information/i, /has no upstream branch/i, /no upstream configured/i],
	},
	{
		kind: 'no-remote',
		patterns: [
			/no configured push destination/i,
			/does not appear to be a git repository/i,
			/no such remote/i,
		],
	},
];

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function classifyGitError(error: unknown): GitErrorKind {
	const text = errorText(error);
	for (const rule of RULES) {
		if (rule.patterns.some((pattern) => pattern.test(text))) return rule.kind;
	}
	return 'unknown';
}

/**
 * Picks the most informative line of git's output (the `fatal:` / `error:` line),
 * skipping progress meters and hints.
 */
export function gitErrorDetail(error: unknown, maxLength = 300): string {
	const lines = errorText(error)
		.split(/\r?\n|\r/)
		.map((line) => line.trim())
		.filter((line) => line && !/^(hint:|remote: (counting|compressing|enumerating|total))/i.test(line))
		.filter((line) => !/\d+% \(\d+\/\d+\)/.test(line));
	const important =
		lines.find((line) => /^(fatal|error):/i.test(line)) ??
		lines.find((line) => /^(ERROR|remote: error|remote: fatal)/.test(line)) ??
		lines.find((line) => /^(ssh|Permission denied|Host key)/i.test(line)) ??
		lines[lines.length - 1] ??
		'';
	return important.length > maxLength ? `${important.slice(0, maxLength - 1)}…` : important;
}
