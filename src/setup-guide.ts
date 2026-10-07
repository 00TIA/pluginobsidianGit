/** Setup steps shown at the top of the settings tab. No Obsidian imports, so it can be tested. */

export interface SetupProgress {
	git: boolean;
	repo: boolean;
	remote: boolean;
	author: boolean;
}

export interface SetupStep {
	/** Text with **bold** UI labels and `code`. */
	text: string;
	/** Progress flag that marks the step as done; steps without it cannot be checked. */
	done?: keyof SetupProgress;
}

export const SETUP_STEPS: SetupStep[] = [
	{
		done: 'git',
		text: 'Install Git. **Git in use** below shows the executable the plugin found; if it says not found, install Git or set its path.',
	},
	{
		done: 'repo',
		text: 'Turn the vault into a Git repository with **Initialize repository** (Git panel or command palette).',
	},
	{
		done: 'remote',
		text: 'Create an empty, private repository on GitHub, GitLab or similar, and copy its address: green **Code** button → **SSH** (or **HTTPS**).',
	},
	{
		done: 'remote',
		text: 'Paste the address in **Remote URL** below and select **Save**.',
	},
	{
		done: 'author',
		text: 'If Git does not know you yet, fill in **Commit author** and select **Save**.',
	},
	{
		text: 'Make sure Git can authenticate without asking anything: an SSH key loaded in ssh-agent (check with `ssh -T git@github.com` in a terminal), or HTTPS credentials already saved by a credential helper.',
	},
	{
		text: 'Select the Git icon in the left ribbon to open the Git panel, and run **Sync**. Optionally turn on **Pull on startup** and **Automatic backup** below.',
	},
];

export interface TextPart {
	text: string;
	style: 'plain' | 'bold' | 'code';
}

/** Splits a step text into plain, **bold** and `code` parts. */
export function parseStepText(text: string): TextPart[] {
	return text
		.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
		.filter((part) => part.length > 0)
		.map((part): TextPart => {
			if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
				return { text: part.slice(2, -2), style: 'bold' };
			}
			if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
				return { text: part.slice(1, -1), style: 'code' };
			}
			return { text: part, style: 'plain' };
		});
}

/** Number of checkable steps that are done, out of the checkable ones. */
export function setupCompletion(progress: SetupProgress): { done: number; total: number } {
	const checkable = SETUP_STEPS.filter((step) => step.done);
	return {
		done: checkable.filter((step) => step.done && progress[step.done]).length,
		total: checkable.length,
	};
}
