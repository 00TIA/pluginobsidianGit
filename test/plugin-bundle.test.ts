/**
 * Loads the production bundle (main.js) with a minimal fake of the `obsidian` module and
 * drives the plugin against a real git repository: checks that simple-git works once
 * bundled and that commands, notices and the status bar behave as expected.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, isolatedEnv, removeDir, tempDir, write } from './helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAKE_OBSIDIAN = String.raw`
class FakeElement {
	constructor(tag = 'div') { this.tag = tag; this.text = ''; this.children = []; this.classes = new Set(); this.listeners = {}; }
	setText(text) { this.text = String(text); }
	addClass(...names) { names.forEach((n) => this.classes.add(n)); }
	toggleClass(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }
	createDiv(options = {}) { return this.createEl('div', options); }
	createEl(tag, options = {}) { const el = new FakeElement(tag); el.text = options.text ?? ''; this.children.push(el); return el; }
	addEventListener(type, listener) { this.listeners[type] = listener; }
	empty() { this.children = []; this.text = ''; }
	allText() { return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join(' '); }
}
globalThis.createFragment = (build) => { const fragment = new FakeElement('fragment'); build(fragment); return fragment; };

class Notice {
	constructor(message, duration) {
		this.message = typeof message === 'string' ? message : message.allText();
		this.duration = duration;
		this.fragment = typeof message === 'string' ? null : message;
		Notice.shown.push(this);
	}
	setMessage() { return this; }
	hide() {}
}
Notice.shown = [];

class Plugin {
	constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; this.statusBarItems = []; this.intervals = []; this.data = null; }
	addCommand(command) { this.commands.push(command); return command; }
	addStatusBarItem() { const el = new FakeElement('div'); this.statusBarItems.push(el); return el; }
	registerDomEvent(el, type, listener) { el.addEventListener(type, listener); }
	registerInterval(id) { this.intervals.push(id); return id; }
	addSettingTab(tab) { this.settingTab = tab; }
	async loadData() { return this.data; }
	async saveData(data) { this.data = data; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeElement(); } }
class Modal { constructor(app) { this.app = app; this.contentEl = new FakeElement(); this.titleEl = new FakeElement(); } open() { this.onOpen(); } close() { this.onClose(); } }
class FileSystemAdapter { constructor(basePath) { this.basePath = basePath; } getBasePath() { return this.basePath; } }
class TFile {}
class Menu { addItem(build) { const item = { setTitle: () => item, setIcon: () => item, onClick: () => item }; build(item); return this; } addSeparator() { return this; } showAtMouseEvent() {} }
class Setting {
	constructor(containerEl) { this.containerEl = containerEl; }
	addButton(build) {
		const button = {
			text: '',
			buttonEl: new FakeElement('button'),
			setButtonText(text) { this.text = text; return this; },
			onClick(handler) { this.click = handler; return this; },
			setCta() { return this; },
		};
		build(button);
		Setting.buttons.push(button);
		return this;
	}
}
Setting.buttons = [];
const setTooltip = (el, text) => { el.tooltip = text; };
const debounce = (fn) => fn;
const moment = () => ({ format: () => '2026-10-07 12:00:00' });

module.exports = { FakeElement, Notice, Plugin, PluginSettingTab, Modal, FileSystemAdapter, TFile, Menu, Setting, setTooltip, debounce, moment };
`;

interface FakeNotice {
	message: string;
	duration: number;
}
interface FakeElement {
	text: string;
	tooltip?: string;
}
interface FakePlugin {
	intervals: number[];
	commands: { id: string; name: string }[];
	statusBarItems: FakeElement[];
	settings: { gitPath: string; pullOnStartup: boolean; largeFileLimitMb: number };
	controller: {
		start(): Promise<void>;
		setup(): Promise<void>;
		initRepository(): Promise<void>;
		commit(): Promise<void>;
		sync(): Promise<void>;
		push(): Promise<void>;
		autoBackup(): Promise<void>;
		repositorySettings(): Promise<{
			available: boolean;
			remote?: { name: string; url: string | null } | null;
			identity?: { name: string | null; localName: string | null };
		}>;
		setRemoteUrl(url: string): Promise<boolean>;
		setIdentity(values: { name?: string; email?: string }): Promise<boolean>;
		refreshStatus(): Promise<void>;
	};
	onload(): Promise<void>;
}

describe('production bundle', () => {
	let dir = '';
	let vault = '';
	let layoutReady: (() => void) | null = null;
	let plugin: FakePlugin;
	let notices: FakeNotice[];
	let buttons: { text: string; click: () => void }[];
	const originalEnv = { ...process.env };
	const originalDebug = console.debug;

	before(async () => {
		execFileSync(process.execPath, ['esbuild.config.mjs', 'production'], { cwd: ROOT, stdio: 'pipe' });
		dir = tempDir();
		const pluginDir = path.join(dir, 'plugin');
		fs.mkdirSync(path.join(pluginDir, 'node_modules', 'obsidian'), { recursive: true });
		fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(pluginDir, 'main.js'));
		fs.writeFileSync(path.join(pluginDir, 'node_modules', 'obsidian', 'index.js'), FAKE_OBSIDIAN);

		// expected git failures are logged with console.debug (hidden by default in Obsidian)
		console.debug = () => {};
		// the plugin uses process.env: isolate it from the machine's git configuration
		Object.assign(process.env, isolatedEnv(path.join(dir, 'home')));
		(globalThis as { window?: unknown }).window = globalThis;

		vault = path.join(dir, 'vault');
		fs.mkdirSync(vault);
		const requireFromPlugin = createRequire(path.join(pluginDir, 'main.js'));
		const obsidian = requireFromPlugin('obsidian') as {
			Notice: { shown: FakeNotice[] };
			Setting: { buttons: { text: string; click: () => void }[] };
			FileSystemAdapter: new (base: string) => unknown;
		};
		notices = obsidian.Notice.shown;
		buttons = obsidian.Setting.buttons;
		const PluginClass = (requireFromPlugin('./main.js') as { default: new (app: unknown, manifest: unknown) => FakePlugin }).default;
		const app = {
			vault: {
				adapter: new obsidian.FileSystemAdapter(vault),
				configDir: '.obsidian',
				getAbstractFileByPath: () => null,
			},
			workspace: {
				onLayoutReady: (callback: () => void) => (layoutReady = callback),
			},
		};
		plugin = new PluginClass(app, { id: 'vault-git-sync', version: '1.0.0' });
		await plugin.onload();
	});

	after(() => {
		// the fake Plugin does not clear registered intervals on unload
		plugin?.intervals.forEach((id) => clearInterval(id));
		console.debug = originalDebug;
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
		removeDir(dir);
	});

	const statusText = () => plugin.statusBarItems[0]?.text;

	/** Clicks a dialog button as soon as the dialog shows it. */
	async function click(text: string): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			const button = buttons.find((candidate) => candidate.text === text);
			if (button) {
				buttons.length = 0; // the dialog closes
				button.click();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`No "${text}" button`);
	}
	const lastNotice = () => notices[notices.length - 1]?.message ?? '';

	it('registers the commands', () => {
		assert.deepEqual(
			plugin.commands.map((command) => command.id),
			['commit', 'commit-with-message', 'pull', 'push', 'sync', 'abort-merge', 'init-repository'],
		);
	});

	it('warns at startup that the vault is not a repository and offers to initialise it', async () => {
		assert.ok(layoutReady);
		await plugin.controller.start();
		assert.match(lastNotice(), /not a Git repository/);
		assert.match(lastNotice(), /Initialize repository/);
		assert.equal(statusText(), 'Git: no repository');
	});

	it('initialises the repository', async () => {
		await plugin.controller.initRepository();
		assert.match(lastNotice(), /Git repository initialized/);
		assert.ok(fs.existsSync(path.join(vault, '.git')));
		// .gitignore and .gitattributes
		assert.equal(statusText(), 'Git: 2 modified files');
	});

	it('commits and updates the modified files count', async () => {
		write(vault, 'a.md', 'a');
		write(vault, 'b.md', 'b');
		await plugin.controller.refreshStatus();
		assert.equal(statusText(), 'Git: 4 modified files');
		await plugin.controller.commit();
		assert.equal(lastNotice(), 'Committed 4 files.');
		assert.equal(statusText(), 'Git: 0 modified files');
		await plugin.controller.commit();
		assert.equal(lastNotice(), 'Nothing to commit.');
	});

	it('explains that a remote is needed to push', async () => {
		await plugin.controller.push();
		assert.match(lastNotice(), /No remote configured/);
	});

	it('reports a failing automatic backup once, not at every interval', async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="vault"' });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			git(vault, process.env, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/vault.git`);
			const before = notices.length;

			write(vault, 'auto-1.md', 'one');
			await plugin.controller.autoBackup();
			assert.equal(notices.length, before + 1);
			assert.match(lastNotice(), /Automatic backup stopped/);
			assert.match(lastNotice(), /Committed 1 file/);
			assert.match(lastNotice(), /never asks for credentials/);

			write(vault, 'auto-2.md', 'two');
			write(vault, 'auto-3.md', 'three');
			await plugin.controller.autoBackup();
			assert.equal(notices.length, before + 1, 'the same problem is not reported again');
			// the local commits are made anyway
			assert.equal(git(vault, process.env, 'rev-list', '--count', 'HEAD'), '3');
			assert.equal(statusText(), 'Git: 0 modified files');
		} finally {
			git(vault, process.env, 'remote', 'remove', 'origin');
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('sets the commit author and the remote from the settings', async () => {
		let settings = await plugin.controller.repositorySettings();
		assert.equal(settings.available, true);
		assert.equal(settings.remote, null);
		assert.deepEqual(settings.identity && [settings.identity.name, settings.identity.localName], ['Test User', null]);

		assert.equal(await plugin.controller.setIdentity({ name: 'Vault Owner', email: 'owner@example.com' }), true);
		assert.equal(lastNotice(), 'Commits will be authored as Vault Owner <owner@example.com>.');

		assert.equal(await plugin.controller.setRemoteUrl('  '), false);
		assert.match(lastNotice(), /Enter a remote URL/);
		const remote = path.join(dir, 'remote.git');
		git(dir, process.env, 'init', '--bare', remote);
		assert.equal(await plugin.controller.setRemoteUrl(remote), true);
		assert.equal(lastNotice(), `Remote "origin" added: ${remote}`);
		settings = await plugin.controller.repositorySettings();
		assert.deepEqual(settings.remote, { name: 'origin', url: remote });
	});

	it('pulls on startup when enabled', async () => {
		await plugin.controller.push();
		assert.match(lastNotice(), /published to origin/);
		const other = path.join(dir, 'other');
		git(dir, process.env, 'clone', path.join(dir, 'remote.git'), other);
		write(other, 'from-other-device.md', 'hello');
		git(other, process.env, 'add', '-A');
		git(other, process.env, 'commit', '-m', 'other device');
		git(other, process.env, 'push');

		plugin.settings.pullOnStartup = true;
		await plugin.controller.start();
		assert.equal(lastNotice(), 'Pull on startup Pulled: 1 file updated.');
		assert.ok(fs.existsSync(path.join(vault, 'from-other-device.md')));
		plugin.settings.pullOnStartup = false;
	});

	it('asks before committing large files and leaves them out of automatic backups', async () => {
		plugin.settings.largeFileLimitMb = 1;
		try {
			fs.writeFileSync(path.join(vault, 'video.mp4'), Buffer.alloc(2 * 1024 * 1024));
			write(vault, 'notes.md', 'notes');

			// manual commit: the user leaves the large file out
			let pending = plugin.controller.commit();
			await click('Commit without them');
			await pending;
			assert.equal(lastNotice(), 'Committed 1 file. Left out: video.mp4.');
			assert.equal(git(vault, process.env, 'ls-files', 'video.mp4'), '');
			// the large file is still modified; the new commit is not pushed yet
			assert.equal(statusText(), 'Git: 1 modified file ↑1');

			// cancel: nothing happens
			const before = git(vault, process.env, 'rev-parse', 'HEAD');
			pending = plugin.controller.commit();
			await click('Cancel');
			await pending;
			assert.equal(git(vault, process.env, 'rev-parse', 'HEAD'), before);

			// automatic backup: left out and reported once
			const count = notices.length;
			write(vault, 'auto-large-1.md', 'one');
			await plugin.controller.autoBackup();
			assert.equal(notices.length, count + 1);
			assert.match(lastNotice(), /Automatic backup: large files left out\..*video\.mp4 \(2\.0 MB\)/);
			write(vault, 'auto-large-2.md', 'two');
			await plugin.controller.autoBackup();
			assert.equal(notices.length, count + 1, 'the same large file is not reported again');
			assert.equal(git(vault, process.env, 'ls-files', 'video.mp4'), '');
			assert.equal(git(vault, process.env, 'log', '-1', '--format=%s'), 'vault backup: 2026-10-07 12:00:00');

			// sync, committing it anyway
			pending = plugin.controller.sync();
			await click('Commit anyway');
			await pending;
			assert.match(lastNotice(), /^Sync complete\. Committed 1 file\./);
			assert.equal(git(vault, process.env, 'ls-files', 'video.mp4'), 'video.mp4');
		} finally {
			plugin.settings.largeFileLimitMb = 50;
		}
	});

	it('reports a git path that does not work', async () => {
		plugin.settings.gitPath = path.join(dir, 'missing', 'git');
		await plugin.controller.setup();
		assert.equal(statusText(), 'Git: not found');
		await plugin.controller.commit();
		assert.match(lastNotice(), /configured Git path does not work/);
		plugin.settings.gitPath = '';
		await plugin.controller.setup();
		assert.equal(statusText(), 'Git: 0 modified files');
	});
});
