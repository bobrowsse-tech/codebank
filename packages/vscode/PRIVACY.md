# Privacy

Codebank keeps your bank on this machine, as plain files under `~/.codebank/` (or the folder in `codebank.home`).

- Codebank does not send telemetry. Usage events stay in the local bank and are deleted by `codebank doctor --purge-usage`.
- Codebank does not open its own network connections. There is no account, no sync, and no remote registry.
- If you allow it on the deposit screen, the selected code is sent to the editor's language model to draft a title and description. That model may be remote. Declining keeps the draft on this machine.
- A project file is written only after you insert, accept, or apply an update.
- Install commands are typed into a terminal and are not run.
- Secret findings are stored as hashes, never as the secret text.
