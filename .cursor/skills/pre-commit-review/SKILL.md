---
name: pre-commit-review
description: >-
  Reviews the staged diff before git commit and the outgoing diff before git
  push. Use before every git commit or git push, and whenever the review gate
  denies a git command until a review stamp exists.
---

# Pre-commit review

A separate review has to finish before `git commit` or `git push`. The author of the change does not count as that review.

## When

- The next command is `git commit` or `git push`.
- `.cursor/hooks/review-gate.mjs` denied the command.

## Steps

1. Stage only the files that belong in the commit. Leave local notes such as `TODO.md` unstaged. Do this in its own command. Do not use `git commit -a`, `--all`, or pathspecs, and do not commit and push in one command.
2. Read the diff the gate will hash. Before a commit, that is `git diff --cached`. Before `git commit --amend`, that is the whole resulting commit, not only the staged delta. Before a push, that is `git log -p @{u}..HEAD`, or `git log -p origin/main..HEAD` when the branch has no upstream. A push to another ref is the commits that ref will receive. `cd` and `pushd` count only before `&&`, `;`, or a newline. Each `git -C` is relative to the previous one. `GIT_DIR` and `GIT_WORK_TREE` select the repository.
3. Launch a review subagent with the Task tool. It may only read and report. It must not edit files or run git commit or git push. Give it the diff and this checklist.
4. Treat a finding as blocking when it is a real bug, a test that passes without exercising the behavior, a command that fails on a clean tree, or a committed claim that is broader than the code.
5. Fix every blocking finding, then repeat from step 2. A new diff needs a new review.
6. When the review reports no blocking findings, stamp and retry:
   - commit: `node .cursor/hooks/stamp-review.mjs staged`
   - push: `node .cursor/hooks/stamp-review.mjs outgoing`

Do not stamp a review you performed yourself.

## Checklist

- A script or npm command that imports `dist/` or another gitignored build output builds that output first.
- A test that reuses a bank, home directory, or other persistent state uses new content each run, or starts from an empty directory.
- Temporary directories are removed on success and on failure.
- A check that a file was not written compares paths and contents.
- Privacy, changelog, and listing text match the code. Telemetry stays off. A consented language-model draft is not described as never leaving the machine.
- Local publishing notes and Actions secret instructions stay out of committed files.
- New behavior has a test that runs it. Activation timing includes the work that happens before `activate` returns.
- No project file is written without a user action, and no new runtime dependency is added.
