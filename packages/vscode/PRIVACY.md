# Privacy

Codebank keeps your bank on this machine, as plain files under `~/.codebank/` (or the folder in `codebank.home`).

- Nothing is sent over the network. There is no account, no sync, and no remote registry.
- There is no telemetry. Usage events stay in the local bank and are deleted by `codebank doctor --purge-usage`.
- A project file is written only after you insert, accept, or apply an update.
- Install commands are typed into a terminal and are not run.
- Secret findings are stored as hashes, never as the secret text.
