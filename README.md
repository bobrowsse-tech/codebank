# Codebank

Codebank is a local-first VS Code extension, CLI, and MCP server that banks reusable code and recalls it in any project. Entries are plain files under `~/.codebank/`. Nothing is sent over the network, and nothing is written into a project until you accept it.

The repository is public and licensed under MIT. Implementation follows `spec/CODEBANK-SPEC.md`, milestones M1 through M4, each shippable on its own.

## Three steps

1. Select a function and run **Codebank: Deposit Selection**.
2. Run **Codebank: Search** and pick a result.
3. Insert it. Codebank writes the files and can type an install command into a terminal without running it.

From a terminal, the same bank is `codebank add`, `codebank search`, and `codebank get`.

## Repository rules

`main` is locked. Changes merge only through pull requests, CI must pass, and force-pushes and branch deletion are blocked. Administrators do not bypass those rules.

Only collaborators with write access can open pull requests. The maintainer account is [bobrowsse-tech](https://github.com/bobrowsse-tech). Add another maintainer from the repository collaborators settings; everyone else can clone and use the code, and cannot open a pull request.

## Publish

Publishing a GitHub Release tagged `vX.Y.Z` (the same version as `packages/vscode/package.json`) runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. Test, package the `.vsix`, and attach it to the release.
2. Publish that package to the Visual Studio Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`).
3. Publish the CLI to npm only when `NPM_TOKEN` is set and the package name is scoped. The unscoped name `codebank` is already taken.

Add the secrets under Settings, Secrets and variables, Actions. The Marketplace publisher id is still an open decision in section 10 of the spec, so do not cut a release until that id is in the extension manifest.

`workflow_dispatch` on the same workflow packages and uploads a build artifact without publishing.

## Contents

- `spec/CODEBANK-SPEC.md` is the build specification.
- `ui/png/` has screenshots of every screen (Main is the S1 first-run scan, then S2 to S8, and Tokens). `ui/html/` is the same screens as static HTML. Colors map to VS Code theme variables. Never hard-code hex values in the extension.
- `ui/source/` has the original design files. They need the design tool's runtime, so use `ui/html/` instead.
