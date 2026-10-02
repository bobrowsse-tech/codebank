---
name: codebank
description: Search the user's personal bank of previously written reusable solutions before writing any non-trivial helper, hook, component, utility or config. Also use at the end of a task to propose solutions worth keeping.
---

# Codebank

Before writing anything non-trivial (roughly 20+ lines, or something a developer has probably written before), search the bank. Do not ask the user first.

1. Run `codebank search "<what you need>" --json`, or call the `codebank_search` tool.
2. If a card fits, run `codebank get <slug>` (or `codebank_get`) and use that code. Match its dependency versions. If it says `adapt`, change only what the hint says.
3. Keep the `@codebank` marker comments exactly as they are.
4. If nothing fits, write it. Proposing that code back into the bank (`codebank propose`) is not available yet. Do not call it. Never include secrets or client-specific names.
