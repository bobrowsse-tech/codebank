# Codebank

Bank reusable code on this machine and recall it in any project. Entries are plain files under `~/.codebank/`. Nothing is written into a project until you accept it.

## Getting started

Follow the Codebank walkthrough. It is the only instruction you need:

1. Run **Codebank: Scan This Machine**. Matches land in the Inbox. The scan does not change your projects.
2. Accept three candidates. Each accept saves one entry. Dismiss the rest.
3. In chat, type `#codebank` and what you need, for example `#codebank filtering`. Insert the card you want.

A first insert takes a few minutes. Search is **Codebank: Search** (`Cmd+Alt+Shift+B` on macOS, `Ctrl+Alt+Shift+B` elsewhere). Deposit a selection with **Codebank: Deposit Selection**.

The same bank is available in a terminal as `codebank search`, `codebank get`, and `codebank add`.

## Privacy

Codebank does not send telemetry and does not open its own network connections. If you allow it while depositing, the selected code is sent to the editor's language model, which may be remote. See [PRIVACY.md](PRIVACY.md).

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
