/** Kinds of change shown in the Git panel. Untracked files count as `added`. */
export type ChangeKind = 'conflicted' | 'modified' | 'added' | 'renamed' | 'deleted';

export interface ChangedFile {
	/** Path relative to the repository root. */
	path: string;
	kind: ChangeKind;
	/** Previous path of a renamed file. */
	from?: string;
}

export interface ChangeGroup {
	kind: ChangeKind;
	title: string;
	/** One-letter badge, as in `git status`. */
	letter: string;
	files: ChangedFile[];
}

const GROUPS: Omit<ChangeGroup, 'files'>[] = [
	{ kind: 'conflicted', title: 'Conflicts', letter: 'U' },
	{ kind: 'modified', title: 'Modified', letter: 'M' },
	{ kind: 'added', title: 'New', letter: 'A' },
	{ kind: 'renamed', title: 'Renamed', letter: 'R' },
	{ kind: 'deleted', title: 'Deleted', letter: 'D' },
];

/** Kind of change from the two status letters of `git status --porcelain` (XY). */
export function changeKind(index: string, workingDir: string): ChangeKind {
	const codes = `${index}${workingDir}`;
	if (codes.includes('U') || codes === 'AA' || codes === 'DD') return 'conflicted';
	if (codes === '??') return 'added';
	if (codes.includes('R')) return 'renamed';
	if (codes.includes('D')) return 'deleted';
	if (index === 'A') return 'added';
	return 'modified';
}

/** Non-empty groups in a fixed order (conflicts first), files sorted by path. */
export function groupChanges(files: ChangedFile[]): ChangeGroup[] {
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	return GROUPS.map((group) => ({
		...group,
		files: files.filter((file) => file.kind === group.kind).sort((a, b) => collator.compare(a.path, b.path)),
	})).filter((group) => group.files.length > 0);
}
