# Codebank

Codebank keeps a bank of reusable code on your machine and recalls it in any project. The bank is plain files under `~/.codebank/`. The same bank is available in VS Code, in the terminal, and to an agent over MCP.

Nothing is written into a project until you accept, insert, or apply it.

- Extension: [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=bobrowsse-tech.codebank) and [Open VSX](https://open-vsx.org/extension/bobrowsse-tech/codebank), id `bobrowsse-tech.codebank`
- CLI: `npm install -g @bobrowsse-tech/codebank` (Node.js 20 or newer)
- Source: [github.com/bobrowsse-tech/codebank](https://github.com/bobrowsse-tech/codebank)

## Use it in VS Code

Install the extension, then run **Codebank: Open Walkthrough**. These are the same steps.

### 1. Scan this machine

Run **Codebank: Scan This Machine**. A panel shows progress and **Cancel**. Codebank reads local git repositories and puts repeated code in the Inbox. The scan does not change your projects, and nothing is saved until you accept a candidate.

![Scan design. The extension panel shows progress and Cancel, and finished candidates go to the Inbox.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/scan.png)

### 2. Accept candidates from the Inbox

Open **Codebank: Open Inbox**. Each row is a candidate, either found by the scan or proposed by an agent. Accept the ones you want to keep. Dismiss the rest. An accepted candidate becomes an entry in the bank. A dismissed one is not suggested again.

![Inbox. Accept or dismiss candidates. Nothing is saved until you accept it.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/inbox.png)

### 3. Search and insert

Run **Codebank: Search** (`Cmd+Alt+Shift+B` on macOS, `Ctrl+Alt+Shift+B` elsewhere). Choose a result. Codebank then asks you to **Add to project** or **Insert at cursor**. Add to project writes the files under `src/codebank` (change that with `codebank.insertDir`). If the entry needs a package, Codebank types the install command into a terminal and does not run it.

An insert in marker mode starts each file with an `@codebank` comment so a later version can be found. External mode stores that link and adds no marker text.

![Search. Choosing a result inserts it, either as files in the project or at the cursor.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/search.png)

### 4. Deposit a selection

Select a function and run **Codebank: Deposit Selection** (`Cmd+Alt+B` on macOS, `Ctrl+Alt+B` elsewhere). Codebank expands the selection to the function and the helpers it needs, then opens a card: title, what it does, when not to use it, tags, and ownership. The files in that closure are listed above the card. Edit the card, then choose **Save to bank**. Packages the code imports are stored with the entry.

A selection that contains a secret cannot be saved. If you allow a draft, the selected code is sent to the editor's language model, which may be remote. You can fill the card yourself when no model is available.

![Deposit. The selection is expanded into a card. Save to bank stores it. A secret blocks the save.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/deposit.png)

### 5. Recall while you type

In a short TypeScript or JavaScript file, Codebank can offer a banked entry when the file name matches one, when a comment asks to implement something, or when you paste a large block that is already in the bank. The suggestion is a CodeLens: the entry title inserts it, and Preview, Not now, and Mute here are next to it. **Not now** keeps that file quiet for 10 minutes. **Mute here** stops that suggestion. Three dismissals mute it as well.

![Recall. An empty file offers a banked entry. Insert writes the files and does not run an install.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/recall.png)

### 6. Browse the bank

The Codebank view lists entries, the Inbox, and Updates. Click an entry to insert it. **Retire Entry** removes it from suggestions.

![Bank. The view lists entries. Clicking one inserts it.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/bank.png)

### 7. Take an update

When the bank copy is newer than a copy you inserted, it shows up under Updates. **Take update** applies one editor edit, so one undo restores your copy. **Keep mine** leaves the project file as it is. **Promote mine** snapshots the previous code and makes the next version in the bank. A conflict is opened for you to resolve and is not applied on its own.

![Update review. Your inserted copy is compared with the newer bank version.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/update.png)

### 8. Ask in chat

In chat, type `#codebank` and what you need, for example `#codebank filtering`. The agent searches the bank and can insert a match. If nothing fits, it can propose the new code to your Inbox. A proposal stays there until you accept it.

![Chat. #codebank finds a banked entry. An agent proposal waits in the Inbox.](https://github.com/bobrowsse-tech/codebank/raw/main/packages/cli/media/chat.png)

## Use it from the terminal

```bash
npm install -g @bobrowsse-tech/codebank
codebank doctor
```

`codebank doctor` prints the bank folder, the schema, and how many entries are indexed. Add `--purge-usage` to delete the local usage log.

### Search, read, and copy an entry

```bash
codebank search "filter table rows"
codebank search "filter table rows" --limit 5 --json
codebank get filtering
codebank get filtering --out ./tmp/filtering
codebank list
codebank retire filtering
```

`search` prints the slug, title, and intent. `get` prints the card and the files. `--out` writes those files into a directory you choose. `list` skips retired entries.

### Add code from a file

```bash
codebank add src/filterRows.ts --range 13:20 --title "Filter table rows"
```

The range is `start:end`, and the first line of the file is line 1. Codebank saves that function and the helpers it can see from the file. A secret blocks the save.

### Scan and the Inbox

```bash
codebank mine
codebank mine --roots ~/code,~/work --json
codebank inbox list
codebank inbox accept <id>
codebank inbox dismiss <id>
```

`mine` walks the folders in your Codebank config, or the folders you pass with `--roots`. Candidates stay in the inbox until you accept one.

### Let an agent propose an entry

```bash
codebank propose --title "Retry a request" --intent "Retry a failed HTTP call with a limit." --files src/retry.ts
```

The proposal stays in the inbox until you accept it. Do not include secrets or names that belong to one client.

### Agents

```bash
codebank mcp
codebank skill install --target claude
codebank skill install --target copilot
codebank skill install --target agents --agents-md
```

`codebank mcp` speaks newline-delimited JSON-RPC on standard input. The tools are `codebank_search`, `codebank_get`, and `codebank_propose`. `skill install` copies the agent skill into the target you name.

## Settings

| Setting | What it does |
| --- | --- |
| `codebank.home` | Bank folder. Empty uses `~/.codebank`. |
| `codebank.insertDir` | Folder inside the project for an inserted entry. Default `src/codebank`. |
| `codebank.recall.enabled` | Show a suggestion on an empty file. |
| `codebank.recall.threshold` | How close a suggestion must be, from 0 to 1. |
| `codebank.lineage.mode` | `marker` writes a comment. `external` stores the link and adds no text. |
| `codebank.scan.roots` | Folders to scan. Empty uses the open workspace. |
| `codebank.scan.ignore` | Folder names skipped by a scan. |

## Privacy

Codebank does not send telemetry and does not open its own network connections. If you allow a deposit draft, the selected code goes to the editor's language model, which may be remote.

## License

MIT. Copyright Bob Rowsse Walakira.
