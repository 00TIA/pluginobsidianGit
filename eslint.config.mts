import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Type-aware rules also run by the Obsidian community directory review.
		files: ['**/*.ts'],
		extends: [tseslint.configs.recommendedTypeChecked],
	},
	{
		// Tests run in plain Node, not in an Obsidian window.
		files: ['test/**/*.ts'],
		rules: {
			// node:test runs the promises returned by describe()/it() itself
			'@typescript-eslint/no-floating-promises': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
		},
	},
);
