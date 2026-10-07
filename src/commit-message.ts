export const DEFAULT_COMMIT_TEMPLATE = 'vault backup: {{date}}';
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm:ss';

export interface CommitMessageValues {
	/** Already formatted date. */
	date: string;
	hostname: string;
	numFiles: number;
}

/**
 * Renders the commit message template. Supported placeholders:
 * `{{date}}`, `{{hostname}}`, `{{numFiles}}` (spaces inside the braces are allowed).
 * Unknown placeholders are left untouched.
 */
export function renderCommitMessage(template: string, values: CommitMessageValues): string {
	const source = template.trim() ? template : DEFAULT_COMMIT_TEMPLATE;
	const rendered = source.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
		switch (key) {
			case 'date':
				return values.date;
			case 'hostname':
				return values.hostname;
			case 'numFiles':
				return String(values.numFiles);
			default:
				return match;
		}
	});
	return rendered.trim() || values.date;
}
