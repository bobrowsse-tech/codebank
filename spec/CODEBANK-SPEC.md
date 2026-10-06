# Codebank — Build Specification

Oct 1, 2026 · @Bob Rowsse

Codebank is a local-first VS Code extension, CLI and MCP server that captures a developer's reusable code, recalls it at the moment of intent, and keeps every copy linked to its source. This is the single directive for coding agents: build milestones M1–M4 in order, each shippable on its own.

## 1. Principles and hard constraints

Every rule below is binding; if a task seems to need breaking one, stop and record it under Open decisions.

1. **Plain files are the source of truth.** Entries are folders of ordinary files; any search index is a cache that can be deleted and rebuilt.
2. **Zero third-party runtime dependencies.** Dev dependencies (TypeScript, esbuild, the VS Code test runner) are allowed. The MCP server is hand-written JSON-RPC over stdio (see section 6), not an SDK.
3. **`packages/core` never imports `vscode`.** It is pure Node, so the CLI, the MCP server and the extension share one implementation.
4. **Trust boundary.** Nothing is written into a project file without an explicit user action (accept, insert, apply). Edits to open documents use targeted range edits through `WorkspaceEdit`, never whole-document replacement.
5. **Local only.** No network calls, no telemetry. Language-model use goes through `vscode.lm` with the user's own models, behind a one-time consent prompt.
6. **Precision over recall in anything ambient.** A wrong suggestion costs more trust than a missed one (thresholds in section 5).
7. **Client-owned code never leaves the machine.** Entries from repos flagged as client-owned are non-exportable and warn on cross-org use (section 8).
8. **Root cause before fixes.** Every pipeline stage (closure, mining, search, recall, lineage) logs inputs and outputs to a `Codebank` output channel at debug level. Add logging before changing logic.
9. **Each milestone ships alone.** M1 must be useful without M2, M3 or M4.
10. **Graceful absence.** No model available, no workspace, no git: features degrade to manual paths and say so; they never throw into the user's face.

## 2. Architecture

&#91;embedded content: architecture · 3 front ends, 1 core, 1 folder\]

The extension, the CLI and the MCP server only call `core`, and `core` is the only code that touches the folder, so all three behave the same. The accent marks the source of truth. Code that needs the editor (language-server closure, CodeLens, tree views, chat tools) lives in `packages/vscode` and hands plain data to `core`.

## 3. Repository layout and toolchain

One npm-workspaces monorepo, TypeScript in strict mode, each package bundled with esbuild.

```text
codebank/
  package.json              workspaces: packages/*
  tsconfig.base.json
  skills/codebank/SKILL.md  agent skill shipped with the extension and CLI
  fixtures/                 small sample repos used by mining and closure tests
  packages/
    core/                   pure Node, never imports vscode
      src/model/            types.ts, validate.ts (hand-written validators)
      src/store/            paths.ts, entries.ts, inbox.ts, usage.ts, lock.ts
      src/search/           tokenize.ts, bm25.ts, index.ts
      src/closure/          extract.ts, normalize.ts, hash.ts
      src/mining/           scan.ts, cluster.ts, rank.ts
      src/recall/           signals.ts, score.ts
      src/lineage/          marker.ts, diff.ts, plan.ts
      src/security/         secrets.ts, ownership.ts
      test/
    cli/                    bin `codebank`
    mcp/                    stdio MCP server, imports core only
    vscode/                 the extension (activation, views, providers, tools)
```

| Concern | Choice |
| --- | --- |
| Package manager | npm workspaces |
| Language / build | TypeScript strict, esbuild bundle per package |
| Unit tests | `node:test` + `node:assert` for core, cli and mcp (no test framework) |
| Extension tests | `@vscode/test-cli` against a fixture workspace |
| Lint | `tsc --noEmit` plus the `Codebank` debug logging rule from section 1 |
| Packaging | `@vscode/vsce` as a dev dependency |
| Runtime targets | Node 20 APIs only in core; VS Code `engines.vscode` ^1.101.0 (needed for the MCP provider API) |
| Git access | `child_process.execFile('git', …)` for repo root, remote URL and HEAD; no git library |

Root scripts agents must provide: `build`, `test`, `test:ext`, `package`, `dev:cli` (run the CLI from source).

## 4. Data model

Everything lives under one home folder, `~/.codebank/` (override with `CODEBANK_HOME` or the `codebank.home` setting). All JSON carries `"schema": 1`; a loader that sees a higher schema refuses to read it and tells the user to update, it never guesses.

```text
~/.codebank/
  config.json
  entries/<slug>/
    entry.json              machine record (type Entry)
    card.md                 human-readable intent card, same text as entry.intent + whenNot
    code/<relative paths>   the dependency closure, original relative structure kept
    example.<ext>           optional usage example
    versions/<n>/           full copy of code/ + entry.json for each older version (from M3)
  inbox/<id>.json          pending candidates (type Candidate)
  lineage/<repoId>.json     external lineage links (type Link[])
  state/usage.jsonl         append-only usage events
  state/dismissed.json      suppressed recall suggestions
  cache/index.json          rebuildable search index; safe to delete
  lock                      lockfile for writers
```

```ts
type Slug = string;                         // kebab-case, unique, max 48 chars

interface Entry {
  schema: 1;
  slug: Slug;
  title: string;
  version: number;                          // integer, starts at 1
  contentHash: string;                      // first 12 hex of sha256 over the normalized closure
  language: 'ts' | 'tsx' | 'js' | 'jsx' | 'css' | 'scss' | 'other';
  entryFile: string;                        // path inside code/ of the primary symbol's file
  symbols: string[];                        // primary exported symbol names
  tags: string[];                           // lowercase, max 8
  intent: string;                           // what it does, max 280 chars
  whenNot?: string;                         // when not to use it, max 280 chars
  deps: { name: string; range: string }[];  // npm packages with the versions seen at capture
  origin: Origin;
  ownership: 'personal' | 'client' | 'unknown';
  createdAt: string; updatedAt: string;     // ISO 8601
  stats: { uses: number; verbatimInserts: number; lastUsedAt?: string };
  status: 'active' | 'stale' | 'retired';
  staleReason?: string;
  variantOf?: { slug: Slug; version: number };
}

interface Origin {
  repoId: string;                           // sha1 of the git remote URL, else of the absolute root path
  repoName: string; remote?: string; org?: string;
  commit?: string; relPath: string;
  range: { startLine: number; endLine: number };
  capturedBy: 'manual' | 'mining' | 'agent';
}

interface Candidate {
  schema: 1; id: string;
  draft: Omit<Entry, 'stats' | 'createdAt' | 'updatedAt' | 'status'>;
  files: { relPath: string; content: string }[];
  score: number;                            // 0..1, see mining rank
  reasons: string[];                        // e.g. ['seen in 3 repos', 'has a test file']
  sources: Origin[];
  proposedBy: 'mining' | 'agent' | 'duplicate';
  createdAt: string;
}

interface Link {                             // where a withdrawn copy lives
  slug: Slug; version: number;
  baseHash: string;                         // contentHash at the moment of withdrawal
  repoId: string; relPath: string;
  mode: 'marker' | 'external';
  localHash: string;                        // hash of the copy as last seen
  insertedAt: string;
}

interface UsageEvent {
  t: string;
  kind: 'search' | 'shown' | 'inserted' | 'dismissed' | 'edited-after' | 'promoted' | 'update-applied';
  surface: 'quickpick' | 'codelens' | 'chat' | 'cli' | 'mcp';
  slug?: Slug; query?: string; verbatim?: boolean;
}

interface Card {                             // what search returns to humans and agents, about 50 tokens
  slug: Slug; title: string; intent: string; whenNot?: string;
  language: Entry['language']; tags: string[];
  deps: string[];                           // 'name@range'
  lines: number; version: number; uses: number; lastUsedAt?: string;
  status: Entry['status']; ownership: Entry['ownership']; origin: string; // 'repoName · relPath'
}
```

```json
{
  "schema": 1,
  "scan": { "roots": ["~/code"], "ignore": ["node_modules", ".git", "dist", "build", ".next"], "maxFileKB": 200 },
  "orgs": { "client": ["example-client-org"], "personal": ["my-github-user"] },
  "lineage": { "mode": "marker", "externalForClient": true },
  "recall": { "enabled": true, "threshold": 0.72, "cooldownMinutes": 10 },
  "model": { "consented": false, "family": null }
}
```

Writers take the `lock` file with the exclusive-create flag, write each file to a temp name and rename it into place, and release the lock in `finally`. A lock older than 10 seconds is treated as stale and removed. Readers never lock.

## 5. Algorithms

Thresholds are defaults, all in `config.json` or constants in one `tuning.ts` so they can change without touching logic.

### 5.1 Deposit: dependency closure (extension, needs the language server)

Input: a document and a selection. Output: `ClosureResult { files, deps, warnings, truncated }`.

1. Expand the selection to whole top-level declarations using `vscode.executeDocumentSymbolProvider`. If the selection cuts a symbol, expand to it and say so in the preview.
2. Tokenize the selected text (`core/closure/extract.ts`) and collect identifiers that are not declared inside the selection.
3. For each, call `vscode.executeDefinitionProvider` at its first use. Accept a definition only if the file is inside a workspace folder, not under `node_modules`, and not a `.d.ts`. Expand it to its enclosing top-level declaration and queue it at depth + 1.
4. Stop at depth 3, 30 files or 60 KB, set `truncated: true` and show it in the preview.
5. Include whole files up to 200 lines. Longer files contribute only the needed declarations plus the import lines they use, with a warning.
6. For every bare import specifier in the included files, record the package name and the range from the nearest `package.json` (`dependencies`, then `devDependencies`). Ignore `@types/*`. A relative import to a file that is not included produces a warning.
7. No language server for the file's language: save the selection alone and warn "closure unavailable".

Milestone note: M1 supports TypeScript, TSX, JavaScript and JSX only.

### 5.2 Normalization and content hash (`core/closure/normalize.ts`)

Strip comments, collapse whitespace outside string literals, keep identifiers and literals. `contentHash` = first 12 hex of sha256 over files sorted by `relPath`, each as `relPath + "\n" + normalized`. Used for duplicate detection at deposit, drift and lineage.

### 5.3 Intent card generation

If `config.model.consented` is false, ask once ("Codebank will send the selected code to your editor's language model to draft a description") and store the answer. With consent, call `vscode.lm.selectChatModels` and prompt with the closure truncated to about 6,000 tokens. Require JSON `{ title, intent, whenNot, tags }`, validate against the length limits in section 4, and retry once on invalid output. Without a model, prefill `title` from the primary symbol, `tags` from dependency names and symbol words, and leave `intent` empty for the user. The card is always shown editable; nothing saves without the user pressing Save.

Duplicate check at save: if any active entry has the same `contentHash`, offer "open existing"; if a search for the new title and symbols returns a score above 0.8, offer "save as variant of \<slug>" (`variantOf`) or "replace as new version".

### 5.4 Search (`core/search`)

No database and no embeddings. The index is built in memory from `entry.json` files and cached in `cache/index.json` keyed by file mtime.

- **Tokenize:** split camelCase, snake\_case and kebab-case, lowercase, drop a 40-word stop list.
- **Fields and weights:** title 4, symbols 4, tags 3, intent 2, dependency names 1.5, code identifiers 1, whenNot 0.5.
- **Score:** BM25 per field (k1 1.2, b 0.75), weighted sum, normalized to 0..1 against the best score of the query.
- **Adjust:** multiply by 1 + 0.05 × min(uses, 10); by 1.1 if used within 30 days; by 0.6 if `stale`. Exclude `retired`.
- **Fallback:** if the best normalized score is below 0.3, rank by trigram Jaccard over title plus symbols.
- **Result size:** 3 cards for agents and ambient recall, 8 for quick pick. Each result is a `Card`.
- **Rebuild:** a file watcher on `entries/` invalidates changed entries only.

### 5.5 Mining (`core/mining`, runs in a child process, cancellable, reports progress)

Goal: on day one, find code the developer has already written more than once. Targets 20 repos and 50,000 files in under 60 seconds.

1. **Discover repos:** walk `scan.roots` to depth 4 looking for `.git`. List files with `git ls-files -z` so `.gitignore` is honored; skip files over `maxFileKB`, tests, `.d.ts`, minified and generated output.
2. **Extract units** from TS, TSX, JS and JSX with a brace-matching tokenizer: function declarations, exported `const` arrow or function expressions, classes. Keep units of 8 to 200 lines.
3. **Fingerprint:** normalize (strip comments, collapse whitespace, replace string and number literals with placeholders, keep identifiers), cut into 5-token shingles, build a 64-permutation MinHash, find candidates with LSH (16 bands of 4 rows), then verify exact Jaccard of at least 0.8 and cluster with union-find.
4. **Admit a cluster** if its copies span 2 or more repos, or if a single unit is exported, has a sibling test file and is 20 to 150 lines.
5. **Rank:** `score = 0.45·min(repos/3, 1) + 0.15·hasTest + 0.15·recency + 0.15·sizeFit + 0.10·exported`, where recency is 1 for a file touched within 12 months falling to 0 at 36 months, and sizeFit peaks between 20 and 120 lines. Subtract 0.3 for secret-like tokens or hard-coded internal hostnames.
6. **Representative:** the newest copy that has a test, else the newest copy.
7. **Closure without the language server:** resolve relative imports by path (`./x`, `./x/index`, known extensions) to depth 2, whole files up to 200 lines; bare imports become `deps`.
8. **Emit** `Candidate` files to `inbox/`. Ownership comes from the remote's org matched against `config.orgs`; otherwise `unknown`.

First run shows the top 50. Later runs add only candidates whose cluster hash is new and whose slug is not already banked or dismissed. `codebank mine` and the extension call the same function.

### 5.6 Ambient recall (extension only)

Signals, each producing text to search with and a weight:

| Signal | Trigger | Weight |
| --- | --- | --- |
| File name | A file with fewer than 5 lines is opened or created and its basename tokens match an entry | 0.5 |
| Intent comment | A line comment with a verb (implement, add, write, need, todo) plus nouns | 0.4 |
| Large paste | One insertion of 12 or more lines with shingle Jaccard of at least 0.5 against an entry | 0.6 |

Final score = min(1, 0.6 × normalized search score + 0.4 × signal weight) + 0.05 × min(uses, 4). Show a suggestion only if all hold: score at least `recall.threshold` (0.72), entry `active`, not muted for this repo, ownership rules pass, and the 10-minute per-file cooldown has elapsed. Show at most one suggestion.

Adaptive precision: after every 20 shown suggestions, if fewer than 25% were accepted, raise the threshold by 0.05 (maximum 0.9) and log it. Three dismissals of the same entry in the same repo mute it there.

### 5.7 Withdraw (insert)

1. **Add to project:** write the closure under `<dir>/<slug>/` (default `src/codebank/`, a setting) keeping its internal folder structure so relative imports stay valid, then insert `import { symbol } from '…'` at the cursor with a range edit.
2. **Insert at cursor:** only for single-file entries; insert the entry file's text at the cursor.
3. **Dependencies:** compare `entry.deps` with the target `package.json`. Missing ones are listed with a button that sends the install command to a terminal without executing it (`terminal.sendText(cmd, false)`).
4. **Verbatim or adapt:** verbatim when the language matches and every dependency exists with the same major version. Otherwise the result is marked `adapt` and carries an `adaptHint` for the agent or the user.
5. **Origin marker:** the first line of each written file is `<comment> @codebank <slug> v<version> <baseHash>` using the language's comment syntax. A cursor insertion is wrapped in `@codebank` and `@codebank-end` lines. In `external` mode no text is added; only a `Link` is stored in `lineage/<repoId>.json` and relocated later by content hash.
6. Log a `UsageEvent` of kind `inserted` and increment `stats`.

### 5.8 Lineage updates and drift (M3)

- **Detect:** on workspace open and when `entries/` changes, scan for `@codebank` markers and read `Link`s. A link whose version is behind its entry is `update-available`.
- **Diff:** hand-written Myers line diff (`core/lineage/diff.ts`) between base (`versions/<link.version>/`), local (the file now) and upstream (the entry now).
- **Plan:** local equals base means fast-forward; upstream equals base means local-only change, offer Promote; otherwise conflict, open the editor's diff view with temp files. Never auto-apply; apply the accepted result as range edits through `WorkspaceEdit`.
- **Promote:** copy `code/` and `entry.json` to `versions/<n>/`, write the new code as version n + 1, update `contentHash`, and mark other links `update-available`.
- **Edited after insert:** on the first save after insertion where the copy differs from base, show one non-modal message: "You changed \<title> after inserting it. Promote the change?" Ask once per `localHash`.
- **Drift:** an entry becomes `stale` when, in 2 or more of the last 5 repos it was inserted into, a dependency has a higher installed major version than the entry's range (read locally from each repo's `package.json`; no network). Set `staleReason` to the package name.

## 6. Surfaces

### 6.1 VS Code contributions

| Command id | Title | Default key | Also available |
| --- | --- | --- | --- |
| `codebank.deposit` | Codebank: Deposit Selection | Ctrl/Cmd+Alt+B | Editor context menu when text is selected |
| `codebank.search` | Codebank: Search | Ctrl/Cmd+Alt+Shift+B | Status bar item, tree title button |
| `codebank.insert` | Codebank: Insert… | none | Tree item inline button, quick pick, CodeLens |
| `codebank.mine` | Codebank: Scan This Machine | none | First-run welcome view |
| `codebank.openInbox` | Codebank: Open Inbox | none | Status bar badge |
| `codebank.reviewUpdate` | Codebank: Review Update | none | Updates view, CodeLens on a marker |
| `codebank.promote` | Codebank: Promote My Changes | none | Message button, CodeLens on a marker |
| `codebank.retire` / `codebank.mute` | Retire Entry / Mute Suggestions Here | none | Tree item context menu |
| `codebank.rebuildIndex` / `codebank.openHome` | Rebuild Index / Reveal Bank Folder | none | Command palette |

- **View container** `codebank` in the activity bar, with three tree views: **Bank** (entries grouped by tag), **Inbox** (candidates, with a count badge), **Updates** (links that are behind or stale).
- **Status bar:** left item `$(archive) Codebank`, showing the inbox count when above 0; click opens search.
- **Settings:** `codebank.home`, `codebank.insertDir`, `codebank.recall.enabled`, `codebank.recall.threshold`, `codebank.lineage.mode`, `codebank.scan.roots`, `codebank.scan.ignore`.
- **Activation:** `onStartupFinished` plus `onView:codebank.bank`. Do the first index build off the activation path.

### 6.2 Chat tools (Language Model Tools API)

Declare in `contributes.languageModelTools`, register with `vscode.lm.registerTool`. Each has `canBeReferencedInPrompt: true`, tag `codebank`, and `toolReferenceName` as shown, so `#codebank` appears in the chat picker.

| Tool name | `toolReferenceName` | Input | Returns |
| --- | --- | --- | --- |
| `codebank_search` | `codebank` | `query` (string), `limit` (1–8, default 3), `language`? | Up to `limit` cards as compact lines; total capped at 3,000 characters |
| `codebank_get` | `codebankGet` | `slug`, `mode` (`inspect` or `insert-plan`) | Closure files, deps, `adapt` flag with `adaptHint`; capped at 24 KB with a truncation notice; logs a `shown` event |
| `codebank_propose` | `codebankPropose` | `title`, `intent`, `whenNot`?, `tags`, `files[{relPath, content}]`, `deps`? | Writes a `Candidate` to `inbox/` only; never touches the workspace |

Model description for `codebank_search` (use verbatim): "Search the user's personal bank of previously written, reusable solutions. Call this before writing any non-trivial utility, hook, component or helper, and use a match instead of writing new code." An `inserted` event is recorded when a saved file gains an `@codebank` marker, so no confirm tool is needed.

### 6.3 CLI (`codebank`)

| Command | Behavior |
| --- | --- |
| `mine [--roots a,b] [--json]` | Run the scan, write candidates to `inbox/`, print a ranked summary |
| `inbox list \| accept <id> \| dismiss <id>` | Review candidates; `accept` creates an entry, empty intent allowed |
| `search <query> [--limit n] [--json]` | Same ranking as the extension |
| `get <slug> [--out dir]` | Print or write the closure files |
| `add <file> --range 10:40 --title <t>` | Manual deposit with the non-language-server closure |
| `propose --title … --intent … --files a.ts b.ts` | Agent-friendly candidate creation |
| `list`, `retire <slug>`, `doctor` | Inspect, retire, and check home, schema, index and links |
| `mcp` | Start the MCP server on stdio |
| `skill install [--target claude\|copilot\|agents] [--agents-md]` | Copy `SKILL.md` to `~/.claude/skills/codebank`, `~/.copilot/skills/codebank` or `~/.agents/skills/codebank`; `--agents-md` appends a 5-line block to `AGENTS.md` in the current folder. Only on explicit command. |

Exit codes: 0 success, 1 error, 2 not found, 3 stored schema is newer than this build. `--json` output is stable and documented in the CLI README.

### 6.4 MCP server (`packages/mcp`, hand-written)

- **Transport:** newline-delimited JSON-RPC 2.0 over stdin and stdout. Logs go to stderr only; anything else on stdout breaks the protocol.
- **Methods:** `initialize` (reply with a protocol version the client sent if the server supports it, `capabilities: { tools: {} }`, `serverInfo`), `notifications/initialized` (no reply), `ping`, `tools/list`, `tools/call`. Unknown method returns error `-32601`.
- **Tools:** the same three as 6.2, same schemas. Results are `{ content: [{ type: "text", text }], isError? }`.
- **Before coding it,** the agent must read the current MCP specification (use the Context7 docs tool or fetch the spec) and add a conformance test that drives the server with raw JSON lines. If the spec has changed from this section, the spec wins and the difference goes under Open decisions.
- **Scope:** inside VS Code only the language model tools are exposed (no duplicate tools). The MCP server is for Claude Code, Cursor and other agents, started through `codebank mcp`.

### 6.5 Agent skill (`skills/codebank/SKILL.md`, ship verbatim)

```markdown
---
name: codebank
description: Search the user's personal bank of previously written reusable solutions before writing any non-trivial helper, hook, component, utility or config. Also use at the end of a task to propose solutions worth keeping.
---

# Codebank

Before writing anything non-trivial (roughly 20+ lines, or something a developer has probably written before), search the bank. Do not ask the user first.

1. Run `codebank search "<what you need>" --json`, or call the `codebank_search` tool.
2. If a card fits, run `codebank get <slug>` (or `codebank_get`) and use that code. Match its dependency versions. If it says `adapt`, change only what the hint says.
3. Keep the `@codebank` marker comments exactly as they are.
4. If nothing fits, write it. When done, if the new code is general and reusable, run `codebank propose` (or `codebank_propose`) with a one-sentence intent. Never include secrets or client-specific names.
```

## 7. UI spec

The visual design lives in the separate **Codebank UI** design artifact; its artboards are named S1–S8 to match this table. Where the two disagree, the design wins on look and this document wins on behavior.

**Design rules for every screen**

- Use native VS Code surfaces first (tree views, quick pick, CodeLens, status bar, diff editor). Use a webview only where a native surface cannot do the job (S4 card editor, S1 first-run scan).
- Colors come from VS Code theme variables (`--vscode-*`), so light, dark and high-contrast work with no extra code. One accent, taken from `--vscode-textLink-foreground`.
- Codicons only for icons. Body text uses the editor font settings; code uses the editor monospace font.
- Every list is keyboard-navigable and every action has a command id (section 6.1). Every empty state says what to do next in one sentence.
- Copy is short, plain and never apologetic. Numbers are real ("used 4 times"), never estimated.

| Screen | Surface | What it shows | States to build |
| --- | --- | --- | --- |
| S1 First-run scan | Webview in the editor area | Progress by repo, live count of clusters found, then the top 50 candidates | scanning, partial results, done, nothing found, cancelled, error |
| S2 Bank view | Tree view | Entries grouped by tag; each row title, language icon, `v3`, uses; stale entries show a warning icon | empty, populated, filtered, stale, client-owned (lock icon) |
| S3 Search and insert | Native QuickPick, 8 rows; a read-only preview editor opens beside it (TextDocumentContentProvider, preserveFocus) | Row: title, intent, deps, uses, last used; preview shows closure files; footer shows the missing dependencies for this workspace | no results, results, preview loading, adapt needed (shows hint) |
| S4 Deposit | Webview card editor beside the selection | Closure file list with sizes, warnings, editable title, intent, when-not, tags, dependency chips, ownership, secret-scan result, Save | closure running, truncated, model drafting, model unavailable, secrets found (blocks Save until removed or overridden), duplicate found |
| S5 Recall suggestion | CodeLens above line 1 of an empty file, plus a status bar hint | One line: title, version, used in N projects, buttons Insert, Preview, Not now, Mute here | shown, accepted, dismissed, muted |
| S6 Inbox | Tree view plus a detail webview | Candidate with score, reasons, source repos; actions Accept, Edit and accept, Dismiss; batch select | empty, populated, agent-proposed (labeled), mining-proposed |
| S7 Update review | Native diff editor with a header message | Upstream versus local with base shown; actions Take update, Keep mine, Promote mine as new version | update available, conflict, promoted, dependency drift note |
| S8 Chat result | Chat tool output | Compact cards as returned to the model, shown to the user in the tool-call details | hit, no hit, adapt flag |

**Keyboard map:** Cmd/Ctrl+Alt+B deposit; Cmd/Ctrl+Alt+Shift+B search; in quick pick Enter inserts, Tab toggles preview, Ctrl+Enter inserts at cursor instead of adding to project; in Inbox Space toggles selection, Enter accepts.

**Accessibility:** every webview has a labelled landmark structure, visible focus rings, no information by color alone (stale also has a text label), and respects reduced motion (no animations on the scan progress beyond a determinate bar).

## 8. Security and ownership guard

The bank will hold a developer's best code, some of it written for clients. These rules are release blockers.

**Ownership**

| Value | How it is set | Rules |
| --- | --- | --- |
| `personal` | Remote org is listed in `config.orgs.personal` | Full features |
| `client` | Remote org is listed in `config.orgs.client` | Local use only, never exportable, shown only in repos of the same org by default, warns on cross-org insert, lineage in `external` mode when `lineage.externalForClient` is true |
| `unknown` | No remote or org not listed | Treated as `client` for export and cross-org checks, visible everywhere with an "unknown origin" label |

A cross-org insert shows a confirmation with the entry's org and two buttons, Insert anyway and Cancel. It is never skipped, including for agents: `codebank_get` for such an entry returns the card with `blocked: "cross-org"` and no code until the user confirms in the editor.

**Secrets scan (`core/security/secrets.ts`)**, run at deposit, on mining candidates and on `codebank_propose`:

- Private key blocks (`-----BEGIN … PRIVATE KEY-----`), AWS access key ids (`AKIA` plus 16 characters), GitHub tokens (`gh[pousr]_` plus 36 or more), JWTs (three base64url parts starting `eyJ`).
- Credentials in URLs (`scheme://user:password@host`).
- Assignments to names containing `key`, `secret`, `token` or `password` with a quoted literal of 8 or more characters.
- Any quoted string of 32 or more characters with Shannon entropy above 4.2.

A finding blocks Save until the user removes it or marks that finding a false positive (stored per entry as a hash, never the value). Hard-coded internal hostnames and non-public URLs are warnings.

**Other rules**

- **Paths and slugs:** slugs match `^[a-z0-9][a-z0-9-]{0,47}$`. Every `relPath` read from a candidate, entry or tool input is rejected if it is absolute, contains `..`, or resolves outside its target folder after symlink resolution.
- **Agent input is untrusted:** `codebank_propose` is capped at 20 files and 200 KB, always lands in the inbox, and is labeled as agent-proposed. Tool results wrap bank content with a one-line note that it is data, not instructions.
- **No execution:** Codebank never runs bank code, install commands or scripts. Install commands are typed into a terminal without pressing Enter.
- **Model use:** only the closure text is sent, only after consent, and the deposit screen states how many files and kilobytes will be sent.
- **Markers** contain slug, version and hash only, never paths, org or repo names.
- **Usage log** is local; `codebank doctor --purge-usage` deletes it. There is no telemetry and no network code in any package; a test greps the bundles for `http`, `https`, `net` and `fetch` imports and fails on any.

## 9. Milestones, task checklists and acceptance tests

**Definition of done for every task:** unit or integration test added, debug logging in place (section 1), no new runtime dependency, no file written to a project without a user action, README or CLI help updated. Build fixtures first: `fixtures/` needs three small repos with planted clones, one workspace with a helper chain two files deep, and one with a fake secret.

### M1 — Deposit, search, insert (useful on its own)

- [ ] `core`: types and hand-written validators from section 4; store with lock, atomic writes and schema refusal; tests
- [ ] `core`: tokenizer, normalize, hash, BM25 index with the field weights and adjustments from 5.4; tests with 20 fixture entries
- [ ] `core`: secrets scanner and ownership resolver (section 8); tests with positive and negative samples
- [ ] `core`: heuristic closure by relative imports, for the CLI
- [ ] `vscode`: activation, `Codebank` output channel, home folder bootstrap, `config.json` load
- [ ] `vscode`: deposit flow: closure through the language server (5.1), card editor S4, consent and model draft (5.3), duplicate check, Save
- [ ] `vscode`: Bank view S2, search quick pick S3, insert as add-to-project and at-cursor (5.7), markers, dependency list with unexecuted terminal text
- [ ] `vscode`: tools `codebank_search` and `codebank_get`, `#codebank` working in chat
- [ ] `cli`: `search`, `get`, `add`, `list`, `doctor`
- [ ] Package a `.vsix`; README with the three-step story

**Acceptance M1**

1. Depositing a function with two helper files and one npm package from the fixture workspace produces an entry with 3 files and the package with its range.
2. Searching "filtering" returns that entry at rank 1; search over 500 generated entries takes under 50 ms after warm-up.
3. Inserting into a second fixture project writes the files with a marker line and shows an install command that has not been executed.
4. A file-write spy shows zero writes to any project file before an explicit user click.
5. A selection containing a fake secret cannot be saved.
6. Manual: `#codebank filtering` in Copilot chat returns cards.

### M2 — Mining, inbox, ambient recall, agent surface

- [ ] `core/mining` stages A to E (5.5) against the fixture repos
- [ ] CLI `mine` and `inbox`; extension S1 first-run scan and S6 inbox
- [ ] Recall signals, scoring, CodeLens S5, adaptive threshold, mute (5.6)
- [ ] `codebank_propose`, MCP server with conformance test (6.4), `skill install`
- [ ] Usage log and events (section 4)

**Acceptance M2**

1. On the fixtures, mining finds every planted cluster and at most one false cluster.
2. Scan of 20 repos and 50,000 files finishes within 60 seconds on the reference machine (record its specs in the test output).
3. An empty `useFilters.ts` with a banked filtering entry shows the CodeLens; 30 minutes of scripted unrelated edits produce zero suggestions.
4. The MCP conformance test passes using raw JSON lines only.
5. Agent proposals appear in the inbox labeled as agent-proposed and are never accepted automatically.

### M3 — Lineage

- [ ] Marker parse and write for `//`, `#`, `/* */` and `<!-- -->` languages; `Link` store; `external` mode
- [ ] `versions/` snapshots, Promote, update-available detection (5.8)
- [ ] Myers diff and three-way plan; S7 review in the diff editor; range-edit apply
- [ ] Edited-after-insert message; drift and `stale`; Updates view

**Acceptance M3**

1. After inserting one entry into two fixture repos and changing the entry, both repos show an update; taking it applies as range edits and one undo reverts it.
2. Editing a copy and promoting it makes entry v2, and the other repo then shows an update.
3. A conflict is never applied automatically.
4. `external` mode adds no text to the repository.

### M4 — Onboarding and release

- [ ] VS Code walkthrough: scan, accept three candidates, try `#codebank`
- [ ] Settings review, CHANGELOG, privacy statement (no network, no telemetry)
- [ ] Performance pass: idle within 150 ms of activation; index build off the activation path
- [ ] Marketplace and Open VSX listings, icon, packaged `.vsix`
- [ ] Bug-bash script covering the ten flows: deposit, search, insert, scan, inbox, recall, propose, update, promote, retire

**Acceptance M4:** a new user on a clean machine goes from install to a first successful insert in under 3 minutes, following only the walkthrough.

## 10. Open decisions for you

Decided on 2 October 2026: Codebank is open source under MIT. The GitHub repository is public, and `main` accepts changes only through pull requests from accounts with write access. Agents use the Choice column for anything still open. None of the open rows block M1.

Publishing runs from `.github/workflows/publish.yml` when a maintainer publishes a GitHub Release. The workflow attaches the `.vsix` to that release and publishes the extension and the scoped CLI.

| Decision | Choice | Note |
| --- | --- | --- |
| Repo policy | Public repo `bobrowsse-tech/codebank`. `main` is locked: a pull request is required, CI is required, force-push and deletion are blocked, and admins do not bypass the rules. Only collaborators with write access can open pull requests. | Decided 2 Oct 2026 |
| License | MIT | Decided 2 Oct 2026 with the open-source choice |
| Names and publisher | Publisher `bobrowsse-tech`. Extension id `bobrowsse-tech.codebank`. CLI `@bobrowsse-tech/codebank`. Author `Bob Rowsse Walakira <hello@bobrowsse.com>` | Decided from the owner identity. Unscoped npm `codebank` stays refused |
| MCP implementation | Hand-written, per the zero-dependency rule | If the spec drifts, the official SDK is the single allowed exception, recorded here |
| jsrepo compatibility | Own format | Evaluate in M3 only if jsrepo supports a purely local registry; not verified |
| Minimum VS Code | `^1.101.0` | Required for the MCP provider API listing; lower is possible if that API is dropped |
| Languages | TS, TSX, JS, JSX | CSS, SCSS and Python after M4 |
| Ghost-text Tab insert for S5 | CodeLens only | Stretch goal after M2 through the inline completion API |
| Chat syntax | `#codebank <query>` | A colon form such as `#bank:filtering` is not a native syntax; the query follows in the prompt |

## 11. Sources

Looked up on 1 October 2026. Only the npm registry pages were opened in full; the rest rest on search excerpts, so agents should read the linked page before relying on an API detail.

- [VS Code: Language Model Tools API](https://code.visualstudio.com/api/extension-guides/tools) — `languageModelTools`, `toolReferenceName`, `canBeReferencedInPrompt`
- [VS Code: MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) — `registerMcpServerDefinitionProvider`
- [VS Code: Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) — skill folders and the `~/.copilot`, `~/.claude`, `~/.agents` locations
- [jsrepo](https://www.jsrepo.dev/) and [jsrepo update](https://jsrepo.dev/docs/cli/update) — prior art for copy-in code with update diffs
- [Mondal et al., bug propagation through code cloning](https://clones.usask.ca/pubfiles/articles/MondalICSME2017BugPropagation.pdf) — why copies need lineage
- [npm registry: `codebank`](https://registry.npmjs.org/codebank) and [`bank`](https://registry.npmjs.org/bank) — both taken by dormant packages
