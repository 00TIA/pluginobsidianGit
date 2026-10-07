# Vault Git Sync

An Obsidian **desktop** plugin (Windows, macOS, Linux) that keeps your vault under Git, built on [simple-git](https://github.com/steveukx/git-js).

- Commands: **Commit**, **Commit with custom message…**, **Pull**, **Push**, **Sync** (commit + pull + push), **Abort merge** and **Initialize repository**.
- A **status bar** item with the number of modified files, refreshed every 30 seconds and after every operation (plus `↑n` / `↓n` for commits to push / pull). Click it for a menu with the commands.
- **Remote URL and commit author** can be set from the plugin settings: no terminal needed.
- Optional **pull on startup** and **automatic backup** every N minutes.
- **Never asks for credentials interactively**: it relies on SSH (a key loaded in `ssh-agent`) or on your configured credential helper.
- **Conflicts after a pull** stop the operation with a clear notice: no automatic resolution, nothing pushed.

The plugin is desktop-only (`isDesktopOnly: true`).

## Requirements

- Obsidian 1.4.4 or later, desktop.
- [Git](https://git-scm.com/downloads) 2.13 or later (2.28+ recommended).

## Manual installation

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/vault-git-sync/`, restart Obsidian and enable the plugin in **Settings → Community plugins**.

## Getting started

1. If the vault is not a Git repository, the plugin shows a notice with an **Initialize repository** button (also available as a command). It runs `git init` (branch `main` unless you configured `init.defaultBranch`) and creates:
   - a `.gitignore` for Obsidian (workspace layout files, `.trash/`, OS files);
   - a `.gitattributes` with `* text=auto eol=lf`: Obsidian writes LF line endings on every OS, so notes keep LF in the repository and in the vault, also on Windows with `core.autocrlf=true`.
2. In **Settings → Vault Git Sync → Repository**, set the **Remote URL** (copy the SSH or HTTPS address from GitHub/GitLab/…) and, if Git does not know you yet, the **Commit author**.
3. Run **Sync**. The first push sets the upstream branch.

## Commands

| Command | What it does |
| --- | --- |
| **Commit** | Stages every change in the vault and commits it with the message built from the configured format (with a timestamp). |
| **Commit with custom message…** | Same, but opens a dialog with the generated message, which you can edit. **Enter** confirms. |
| **Pull** | `git pull --no-rebase` from the upstream branch. |
| **Push** | Pushes the current branch; the first time it sets the upstream (`origin`, or the only remote). |
| **Sync** | Commit, then pull, then push. Stops before pushing if the pull produces conflicts. |
| **Abort merge** | After a conflicting pull, goes back to the state before the pull (`git merge --abort`), after confirmation. Your commits are kept. |
| **Initialize repository** | See *Getting started*. |

## Settings

- **Git executable** – path of the Git executable; empty means automatic detection (see below). **Git in use** shows which executable was found; **Check** searches again.
- **Repository**
  - **Remote URL** – URL of the remote used by pull/push (`origin`, or the remote of the current upstream branch). Adds `origin` if there is no remote yet.
  - **Commit author** – name and email saved in this repository's config only (`git config --local`); your global Git configuration is never modified. Leave empty to use the global values, which are shown as hints.
- **Commit message** – format with the placeholders `{{date}}`, `{{hostname}}`, `{{numFiles}}` (default `vault backup: {{date}}`), date format in [Moment.js](https://momentjs.com/docs/#/displaying/format/) syntax (default `YYYY-MM-DD HH:mm:ss`) and a preview.
- **Large files** – **Size limit in megabytes** (default 50, 0 turns the check off). See *Large files and Git LFS*.
- **Automation**
  - **Pull on startup** – pulls when Obsidian starts. Quiet when there is nothing new; notices for pulled files, conflicts and errors.
  - **Automatic backup**, **Interval in minutes** (at least 1) and **Include pull and push** – the backup is a full sync, or a local commit only. It is quiet: it reports only errors and conflicts, once, without repeating the same notice at every run.

## Git not in PATH

When Obsidian is started from the macOS Dock (or from a desktop launcher on Linux) it does not get your shell's PATH, so Git installed with Homebrew & co. is "not in PATH". The plugin looks for Git in this order:

1. the path set in the settings (if set, it must work: no silent fallback);
2. the folders in PATH;
3. the common install locations:
   - **macOS**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` (MacPorts), Nix, Xcode / Command Line Tools. `/usr/bin/git` is used only when the developer tools are installed, so the "install Xcode tools" dialog never pops up;
   - **Windows**: `Program Files\Git\cmd`, `Program Files (x86)\Git\cmd`, `%LOCALAPPDATA%\Programs\Git\cmd`, Scoop;
   - **Linux**: `/usr/bin`, `/usr/local/bin`, `/snap/bin`, Nix, Linuxbrew, `~/.local/bin`;
4. on macOS and Linux, the PATH of a login shell (`$SHELL -lc 'command -v git'`).

Git's folder and the existing common locations are appended to the PATH of the processes started by Git, so `git-lfs`, `gh auth git-credential` and similar tools work too.

## Credentials: never interactive

The plugin never shows username, password or passphrase prompts, and prevents Git, ssh and credential helpers from doing so:

- `GIT_TERMINAL_PROMPT=0` and `-c core.askPass=` (empty): Git asks nothing, not even through graphical `SSH_ASKPASS` programs;
- `GCM_INTERACTIVE=never` and `-c credential.interactive=false`: Git Credential Manager (and Git 2.46+) only use saved credentials;
- unless you configured your own SSH command (`core.sshCommand`, `GIT_SSH`, `GIT_SSH_COMMAND`), ssh runs with `-o BatchMode=yes` (no passphrase, no host key confirmation); your own command is used as is;
- network operations that produce no output for 2 minutes are stopped.

So credentials must already be available:

- **SSH**: a key loaded in `ssh-agent` (on macOS `ssh-add --apple-use-keychain`, on Windows the *OpenSSH Authentication Agent* service) and the host already in `known_hosts` (connect once from a terminal, e.g. `ssh -T git@github.com`);
- **HTTPS**: a credential helper with saved credentials (Git Credential Manager on Windows/macOS/Linux, `osxkeychain`, `libsecret`, …). Pull once from a terminal to save them.

When authentication fails, a notice explains what to configure, with Git's error message.

## Conflicts

Pull always merges (`--no-rebase`), whatever `pull.rebase` says. If the merge produces conflicts:

- the operation stops, **nothing is pushed** and no automatic resolution is attempted;
- a notice lists the conflicted files, with buttons to open them and to **Abort merge**; the status bar shows `Git: N conflicted`;
- the `<<<<<<<` / `=======` / `>>>>>>>` markers stay in the files: keep the right content, remove the markers, then run **Commit** (or **Sync**) to conclude the merge. The commit is refused while markers remain;
- or run **Abort merge** to go back to the state before the pull (changes made while resolving are lost; your commits are kept and the remote changes will be merged again at the next pull);
- pull, push and the automatic backup stay paused until the merge is concluded or aborted; the automatic backup never concludes a merge by itself.

Note: Git cannot put markers in binary files (images, PDFs); the local version stays unless you replace it before committing.

## Large files and Git LFS

Before a commit, the plugin looks for new or modified files of at least the size limit (50 MB by default) that Git LFS does not handle:

- **Commit**, **Commit with custom message…** and **Sync** show the list with their sizes and ask: **Commit without them** (the files stay in the vault, uncommitted), **Commit anyway** or **Cancel**;
- the **automatic backup** cannot ask, so it commits everything else and leaves those files out, with a notice shown once (not at every run) until the list changes.

Once committed, a file stays in the history for good (removing it means rewriting history), and GitHub rejects files over 100 MB. Files tracked by Git LFS are never reported.

Git LFS itself is **not** applied automatically by file size: it stores in LFS only the files matching the patterns in `.gitattributes`. To use it:

```bash
git lfs install                       # once per computer (e.g. after brew install git-lfs)
cd /path/to/vault
git lfs track "*.pdf" "*.mp4" "*.zip" # once per vault: writes .gitattributes
```

Then commit `.gitattributes` (Commit / Sync). From then on the plugin handles LFS transparently: matching files are stored as LFS pointers on commit and uploaded on push, also when Obsidian is started from the Dock (the folder of `git-lfs` is added to the PATH). LFS authentication follows the same non-interactive rules as Git.

Keep in mind:

- files committed before `git lfs track` stay in the normal Git history (moving them needs `git lfs migrate`, which rewrites history);
- GitHub rejects files larger than 100 MB that are not in LFS, and LFS storage and bandwidth have quotas on most hosts.

## Other details

- Git runs with English messages (`LC_ALL=C`) so errors are recognised reliably.
- The periodic status check uses `GIT_OPTIONAL_LOCKS=0`: it never takes `index.lock` and does not disturb other Git programs working on the same repository.
- Operations are serialised: while one runs, the others are refused with a notice (the automatic backup skips its turn).
- If the vault is a sub-folder of a larger repository, counting, staging and committing are limited to the vault (the repository found is shown in the settings).
- Specific notices for: unknown author (`user.name` / `user.email`), existing `index.lock`, repository owned by another user (`safe.directory`), unreachable remote, push rejected because the remote has new commits, detached HEAD.

### Known limitations

- Obsidian installed as a **Flatpak** cannot see the system Git: use the official AppImage/deb/rpm or a Git available inside the sandbox.
- GPG commit signing: a passphrase prompt, if any, comes from `gpg-agent`/pinentry, not from the plugin.

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # typecheck + production build (main.js)
npm run lint    # ESLint with eslint-plugin-obsidianmd
npm test        # unit and integration tests with real Git
```

Layout:

```
src/
  main.ts              plugin lifecycle, timers
  commands.ts          command registration
  git-controller.ts    connects the Git service to Obsidian: locking, notices, status bar, automation
  settings.ts          settings tab
  settings-data.ts     settings model and validation
  commit-message.ts    commit message format
  messages.ts          user-facing texts
  git/
    git-service.ts     commit / pull / push / sync / init / remote / author / abort merge (no Obsidian dependency)
    git-env.ts         non-interactive environment for Git and ssh
    locate-git.ts      Git executable lookup
    errors.ts          classification of Git errors
  ui/                  notices, commit and confirmation dialogs, status bar
test/                  node:test + tsx
```

The integration tests create temporary repositories with a local remote and check, among other things: conflicts after a pull (nothing pushed, markers left in the files, merge concluded only by hand or aborted), no credential prompt against an HTTP server answering 401 (even with an `SSH_ASKPASS` program configured), ssh in `BatchMode` and `core.sshCommand` respected, timeouts of network operations, Git lookup with an empty PATH, remote and author settings, Git LFS commit and push, and the production bundle loaded with a fake `obsidian` module. CI runs them on Linux, macOS and Windows.

## License

0BSD, see [LICENSE](LICENSE). Based on [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin).
