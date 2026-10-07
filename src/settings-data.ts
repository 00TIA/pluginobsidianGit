import { DEFAULT_COMMIT_TEMPLATE, DEFAULT_DATE_FORMAT } from './commit-message';

export interface VaultGitSettings {
	/** Git executable; empty = automatic lookup. */
	gitPath: string;
	/** Commit message template ({{date}}, {{hostname}}, {{numFiles}}). */
	commitMessage: string;
	/** moment.js format used for {{date}}. */
	dateFormat: string;
	autoBackup: boolean;
	/** Minutes between automatic backups. */
	autoBackupInterval: number;
	/** Automatic backup = commit + pull + push (otherwise local commit only). */
	autoBackupSync: boolean;
}

export const DEFAULT_SETTINGS: VaultGitSettings = {
	gitPath: '',
	commitMessage: DEFAULT_COMMIT_TEMPLATE,
	dateFormat: DEFAULT_DATE_FORMAT,
	autoBackup: false,
	autoBackupInterval: 10,
	autoBackupSync: true,
};

export const MIN_AUTO_BACKUP_MINUTES = 1;

/** Parses the interval typed by the user; null when it is not a valid number of minutes. */
export function parseInterval(value: string): number | null {
	if (!/^\s*\d+\s*$/.test(value)) return null;
	const minutes = Number.parseInt(value, 10);
	return minutes >= MIN_AUTO_BACKUP_MINUTES ? minutes : null;
}

/** Merges saved data with the defaults, discarding invalid values. */
export function normalizeSettings(saved: unknown): VaultGitSettings {
	const raw = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof VaultGitSettings, unknown>>;
	const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
	const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
	const savedInterval = raw.autoBackupInterval;
	const interval =
		typeof savedInterval === 'number' || typeof savedInterval === 'string'
			? parseInterval(String(savedInterval))
			: null;
	return {
		gitPath: text(raw.gitPath, DEFAULT_SETTINGS.gitPath).trim(),
		commitMessage: text(raw.commitMessage, DEFAULT_SETTINGS.commitMessage),
		dateFormat: text(raw.dateFormat, DEFAULT_SETTINGS.dateFormat),
		autoBackup: flag(raw.autoBackup, DEFAULT_SETTINGS.autoBackup),
		autoBackupInterval: interval ?? DEFAULT_SETTINGS.autoBackupInterval,
		autoBackupSync: flag(raw.autoBackupSync, DEFAULT_SETTINGS.autoBackupSync),
	};
}
