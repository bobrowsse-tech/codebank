# Codebank: build package

Codebank is a VS Code extension, CLI and MCP server that banks your reusable code and recalls it in any project.

## Contents
- `spec/CODEBANK-SPEC.md` is the build specification. Start here. Build milestones M1 to M4 in order; each ships on its own.
- `ui/png/` has screenshots of every screen (Main = S1 first-run scan, S2 to S8, Tokens).
- `ui/html/` has the same screens as static HTML you can open in a browser.
- `ui/source/` has the original design files (`*.dc.html`, `canvas.json`) for the design tool. They need the tool's runtime to render, so use `ui/html/` instead.

## Notes for agents
- Section 7 of the spec lists screens S1 to S8; the files in `ui/` are the visual reference. Colors map to VS Code theme variables (see Tokens). Never hard-code hex values in the extension.
- Open decisions are in section 10 of the spec. Repo policy, license, and publisher are decided: public MIT repository, `main` locked to maintainer pull requests, publisher `bobrowsse-tech`, extension id `bobrowsse-tech.codebank`, CLI `@bobrowsse-tech/codebank`. Ask the owner before deciding the remaining rows.
- The spec's architecture diagram is not in this markdown export. It shows three front ends (`packages/cli`, `packages/mcp`, `packages/vscode`) sharing `packages/core` and one folder of plain files at `~/.codebank/`.
