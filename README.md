# Vault Git Sync

Plugin per Obsidian **desktop** (Windows, macOS, Linux) che versiona il vault con git, tramite [simple-git](https://github.com/steveukx/git-js).

- Comandi **Commit**, **Commit con messaggio personalizzato…**, **Pull**, **Push**, **Sync** (commit + pull + push) e **Inizializza repository**.
- **Barra di stato** con il numero di file modificati, aggiornata ogni 30 secondi e dopo ogni operazione (più `↑n` / `↓n` per i commit da inviare / scaricare). Un clic apre il menu con i comandi.
- **Backup automatico** opzionale a intervalli in minuti.
- **Mai credenziali richieste in modo interattivo**: si usano SSH (chiave in `ssh-agent`) o il credential helper già configurato.
- In caso di **conflitti dopo un pull** l'operazione si interrompe e viene mostrato un avviso: nessuna risoluzione automatica, nessun push.

Il plugin è solo desktop (`isDesktopOnly: true`): su mobile non viene caricato.

## Requisiti

- Obsidian 1.4.4 o successivo, desktop.
- [Git](https://git-scm.com/downloads) installato (versione 2.13 o successiva; consigliata ≥ 2.28).

## Installazione manuale

```bash
npm install
npm run build
```

Copia `main.js`, `manifest.json` e `styles.css` in `<vault>/.obsidian/plugins/vault-git-sync/`, poi riavvia Obsidian e attiva il plugin in **Impostazioni → Plugin della community**.

## Comandi

| Comando | Cosa fa |
| --- | --- |
| **Commit** | `git add` di tutte le modifiche del vault e commit con il messaggio generato dal formato impostato (con timestamp). |
| **Commit con messaggio personalizzato…** | Come sopra, ma apre una finestra con il messaggio precompilato, modificabile. **Invio** conferma. |
| **Pull** | `git pull --no-rebase` dal branch upstream. |
| **Push** | Invia il branch corrente. Al primo push imposta l'upstream (`origin`, oppure l'unico remote presente). |
| **Sync** | Commit, poi pull, poi push. Si ferma senza fare push se il pull produce conflitti. |
| **Inizializza repository** | `git init` nel vault (branch `main` se non hai configurato `init.defaultBranch`) e crea un `.gitignore` adatto a Obsidian. |

Il remote si aggiunge da terminale, una volta sola:

```bash
cd /percorso/del/vault
git remote add origin git@github.com:utente/vault.git
```

Se il vault non è un repository git, all'avvio compare un avviso con il pulsante **Inizializza repository**.

## Impostazioni

- **Percorso dell'eseguibile Git** – vuoto = ricerca automatica (vedi sotto). La riga **Git in uso** mostra quale eseguibile è stato trovato; **Verifica** ripete la ricerca.
- **Formato del messaggio** – segnaposto `{{date}}`, `{{hostname}}`, `{{numFiles}}`. Predefinito: `vault backup: {{date}}`.
- **Formato della data** – sintassi [moment.js](https://momentjs.com/docs/#/displaying/format/), predefinito `YYYY-MM-DD HH:mm:ss`. Un'anteprima mostra il messaggio risultante.
- **Backup automatico** – attivazione, **intervallo in minuti** (minimo 1) e **Includi pull e push**: se attivo il backup è un Sync completo, altrimenti solo un commit locale. Il backup automatico è silenzioso: avvisa solo in caso di errori o conflitti (una volta, senza ripetere lo stesso avviso a ogni intervallo).

## Git non nel PATH

Avviando Obsidian dal Dock di macOS (o da un launcher grafico su Linux) il PATH della shell non viene ereditato, quindi `git` installato con Homebrew & co. non risulta "nel PATH". Il plugin cerca git in quest'ordine:

1. il percorso indicato nelle impostazioni (se impostato, deve funzionare: niente ripieghi silenziosi);
2. le cartelle del PATH;
3. i percorsi di installazione comuni:
   - **macOS**: `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` (MacPorts), Nix, Xcode / Command Line Tools. `/usr/bin/git` viene usato solo se gli strumenti per sviluppatori sono installati, per non far comparire la finestra di installazione di Xcode;
   - **Windows**: `Program Files\Git\cmd`, `Program Files (x86)\Git\cmd`, `%LOCALAPPDATA%\Programs\Git\cmd`, Scoop;
   - **Linux**: `/usr/bin`, `/usr/local/bin`, `/snap/bin`, Nix, Linuxbrew, `~/.local/bin`;
4. su macOS e Linux, il PATH di una shell di login (`$SHELL -lc 'command -v git'`).

Ai processi avviati da git vengono aggiunte in coda al PATH la cartella di git e i percorsi comuni esistenti, così funzionano anche `git-lfs`, `gh auth git-credential` e simili.

## Credenziali: mai interattive

Il plugin non mostra mai richieste di username, password o passphrase, e impedisce che lo facciano git, ssh o il credential helper:

- `GIT_TERMINAL_PROMPT=0` e `-c core.askPass=` (vuoto): git non chiede nulla, nemmeno tramite programmi grafici `SSH_ASKPASS`;
- `GCM_INTERACTIVE=never` e `-c credential.interactive=false`: Git Credential Manager usa solo credenziali già salvate;
- se non hai configurato un tuo comando SSH (`core.sshCommand`, `GIT_SSH`, `GIT_SSH_COMMAND`), ssh viene eseguito con `-o BatchMode=yes` (niente passphrase né conferma della chiave host); se l'hai configurato viene rispettato così com'è;
- le operazioni di rete che restano senza output per 2 minuti vengono interrotte.

Quindi le credenziali devono essere già disponibili:

- **SSH**: chiave caricata in `ssh-agent` (su macOS `ssh-add --apple-use-keychain`, su Windows il servizio *OpenSSH Authentication Agent*) e host già presente in `known_hosts` (collegati una volta da terminale, es. `ssh -T git@github.com`);
- **HTTPS**: un credential helper con le credenziali salvate (Git Credential Manager su Windows/macOS/Linux, `osxkeychain`, `libsecret`, …). Fai un `git pull` da terminale una volta per salvarle.

Se l'autenticazione fallisce compare un avviso che spiega cosa configurare, con il dettaglio dell'errore di git.

## Conflitti

Il pull usa sempre il merge (`--no-rebase`), indipendentemente da `pull.rebase`. Se produce conflitti:

- l'operazione si interrompe, **il push non viene eseguito** e non si tenta alcuna risoluzione automatica;
- un avviso elenca i file in conflitto (con pulsanti per aprirli); nella barra di stato compare `Git: N in conflitto`;
- i marcatori `<<<<<<<` / `=======` / `>>>>>>>` restano nei file: scegli il contenuto corretto, elimina i marcatori e poi esegui **Commit** (o **Sync**) per concludere il merge. Il commit viene rifiutato finché nei file restano marcatori;
- pull, push e backup automatico restano sospesi finché il merge non è concluso; il backup automatico non conclude mai un merge da solo.

Per annullare il merge e tornare allo stato precedente al pull: `git merge --abort` da terminale.

Nota: nei file binari (immagini, PDF) git non può inserire marcatori; rimane la versione locale, a meno che tu non la sostituisca prima del commit.

## Altri dettagli

- Messaggi di git in inglese (`LC_ALL=C`) per riconoscere gli errori in modo affidabile; gli avvisi del plugin sono in italiano.
- Il controllo periodico usa `GIT_OPTIONAL_LOCKS=0`: non blocca `index.lock` e non disturba altri programmi git aperti sullo stesso repository.
- Le operazioni sono serializzate: se una è in corso, le altre vengono rifiutate con un avviso (il backup automatico salta il turno).
- Se il vault è una sottocartella di un repository più grande, conteggio, `add` e commit sono limitati al vault (il repository trovato è indicato nelle impostazioni).
- Problemi specifici segnalati con un avviso dedicato: identità git non configurata (`user.name` / `user.email`), `index.lock` presente, repository con proprietario diverso (`safe.directory`), remote irraggiungibile, push rifiutato perché il remote ha nuovi commit, HEAD staccato.

### Limiti noti

- Obsidian installato come **Flatpak** non vede il git del sistema: usa il pacchetto ufficiale (AppImage/deb/rpm) o un git disponibile nella sandbox.
- Firma dei commit con GPG: l'eventuale richiesta della passphrase dipende da `gpg-agent`/pinentry, non dal plugin.

## Sviluppo

```bash
npm install
npm run dev     # build in watch mode
npm run build   # typecheck + build di produzione (main.js)
npm run lint    # ESLint con eslint-plugin-obsidianmd
npm test        # test unitari e d'integrazione con git reale
```

Struttura:

```
src/
  main.ts              ciclo di vita del plugin, timer
  commands.ts          registrazione dei comandi
  git-controller.ts    collega il servizio git a Obsidian: lock, avvisi, barra di stato, backup automatico
  settings.ts          scheda impostazioni
  settings-data.ts     modello delle impostazioni e validazione
  commit-message.ts    formato del messaggio di commit
  messages.ts          testi per l'utente
  git/
    git-service.ts     commit / pull / push / sync / init con simple-git (senza dipendenze da Obsidian)
    git-env.ts         ambiente non interattivo per git e ssh
    locate-git.ts      ricerca dell'eseguibile git
    errors.ts          classificazione degli errori di git
  ui/                  avvisi, finestra del commit, barra di stato
test/                  node:test + tsx
```

I test d'integrazione creano repository temporanei con un remote locale e verificano, tra l'altro: conflitti dopo il pull (nessun push, marcatori lasciati nei file, merge concluso solo a mano), nessuna richiesta di credenziali contro un server HTTP che risponde 401 (anche con un programma `SSH_ASKPASS` configurato), ssh in `BatchMode` e rispetto di `core.sshCommand`, timeout delle operazioni di rete, ricerca di git con PATH vuoto, caricamento del bundle di produzione con un modulo `obsidian` simulato. La CI li esegue su Linux, macOS e Windows.

## Licenza

0BSD, vedi [LICENSE](LICENSE). Basato su [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin).
