/**
 * Setup guide shown at the top of the settings tab.
 * No Obsidian imports, so the content and the logic can be tested.
 */

export type SetupStepId = 'git' | 'repo' | 'author' | 'remote' | 'sync';

/** For each step: a short detail when it is done (e.g. the Git path found), null when not. */
export type SetupState = Record<SetupStepId, string | null>;

export type GuidePlatform = 'macos' | 'windows' | 'linux';

export interface SetupStep {
	id: SetupStepId;
	title: string;
	/** Where the step is done, shown next to the title. */
	where: string;
	/** Paragraphs with **bold** labels, `code` and [links](https://…). */
	body: string[];
	/** Extra paragraph for the operating system in use. */
	byPlatform?: Record<GuidePlatform, string>;
	/** Paragraph shown after the platform-specific one. */
	after?: string;
}

const SSH_GUIDE = 'https://docs.github.com/en/authentication/connecting-to-github-with-ssh';

export const SETUP_STEPS: SetupStep[] = [
	{
		id: 'git',
		title: 'Install Git',
		where: 'on your computer',
		body: [
			'Git is a separate program installed on your computer, not inside Obsidian. The plugin uses it to save the history of your notes and to sync them.',
		],
		byPlatform: {
			macos: 'Open the **Terminal** app (Applications → Utilities), type `xcode-select --install`, press Return and confirm the window that appears. With Homebrew, `brew install git` works too.',
			windows: 'Download **Git for Windows** from [git-scm.com](https://git-scm.com/download/win) and run the installer, keeping the default options.',
			linux: 'Install the **git** package with your package manager, e.g. `sudo apt install git` (Debian, Ubuntu) or `sudo dnf install git` (Fedora).',
		},
		after: 'When the installation is done, select **Check again**. If Git is installed but not found, set its path in **Path to the Git executable** below.',
	},
	{
		id: 'repo',
		title: 'Turn the vault into a Git repository',
		where: 'here in Obsidian',
		body: [
			'This creates a hidden .git folder inside the vault, where the history is kept. Nothing is sent online.',
		],
	},
	{
		id: 'author',
		title: 'Tell Git who you are',
		where: 'here in Obsidian',
		body: [
			'Every saved version records its author. Fill in your name and email in **Commit author** below and select **Save**.',
		],
	},
	{
		id: 'remote',
		title: 'Connect an online copy',
		where: 'on GitHub, then here',
		body: [
			'Needed to back up the vault online and to sync it between computers. On GitHub (or GitLab), create a new **private** repository and leave it empty: no README, no .gitignore.',
			'On the repository page select the green **Code** button, choose **SSH** and copy the address (like `git@github.com:name/vault.git`). Paste it in **Remote URL** below and select **Save**.',
			`The plugin never asks for passwords: your computer needs an SSH key added to your GitHub account ([GitHub guide](${SSH_GUIDE})). To check it, run \`ssh -T git@github.com\` in a terminal: it must answer with your user name.`,
		],
	},
	{
		id: 'sync',
		title: 'Sync for the first time',
		where: 'here in Obsidian',
		body: [
			'Select **Sync now**: your notes are saved and sent to the online copy. From then on use the Git icon in the left ribbon, which opens the Git panel with all the commands.',
			'Optionally, turn on **Pull on startup** and **Automatic backup** below to do it without thinking about it.',
		],
	},
];

/** The first step not done yet, or null when the setup is complete. */
export function nextStep(state: SetupState): SetupStepId | null {
	return SETUP_STEPS.find((step) => !state[step.id])?.id ?? null;
}

export function setupCompletion(state: SetupState): { done: number; total: number } {
	return {
		done: SETUP_STEPS.filter((step) => state[step.id]).length,
		total: SETUP_STEPS.length,
	};
}

/** The paragraphs of a step for the operating system in use. */
export function stepParagraphs(step: SetupStep, platform: GuidePlatform): string[] {
	return [...step.body, ...(step.byPlatform ? [step.byPlatform[platform]] : []), ...(step.after ? [step.after] : [])];
}

export interface TextPart {
	text: string;
	style: 'plain' | 'bold' | 'code' | 'link';
	href?: string;
}

/** Splits a paragraph into plain text, **bold**, `code` and [links](https://…). */
export function parseStepText(text: string): TextPart[] {
	return text
		.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\))/)
		.filter((part) => part.length > 0)
		.map((part): TextPart => {
			const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(part);
			if (link) return { text: link[1]!, style: 'link', href: link[2]! };
			if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
				return { text: part.slice(2, -2), style: 'bold' };
			}
			if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
				return { text: part.slice(1, -1), style: 'code' };
			}
			return { text: part, style: 'plain' };
		});
}
