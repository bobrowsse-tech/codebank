import * as vscode from "vscode";
import { describeRepo, suggestRecall } from "../../core/src/index.ts";
import { muteRecall, noteDismissed, noteShown } from "../../core/src/recall/state.ts";
import { previewEntry } from "./search.ts";

export function registerRecall(context: vscode.ExtensionContext, homeOf: () => string): void {
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ language: "typescript" }, { language: "javascript" }, { language: "typescriptreact" }, { language: "javascriptreact" }], {
      provideCodeLenses(document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const repo = folder ? describeRepo(folder.uri.fsPath) : undefined;
        const suggestion = suggestRecall(homeOf(), {
          filePath: document.uri.fsPath,
          text: document.getText(),
          repoId: repo?.repoId ?? "workspace",
          targetOrg: repo?.org,
        });
        if (!suggestion) return [];
        noteShown(homeOf(), repo?.repoId ?? "workspace", document.uri.fsPath, suggestion.slug);
        const range = new vscode.Range(0, 0, 0, 0);
        const repoId = repo?.repoId ?? "workspace";
        const filePath = document.uri.fsPath;
        return [
          new vscode.CodeLens(range, {
            title: `${suggestion.title} v${suggestion.version}, used ${suggestion.uses} times`,
            command: "codebank.insert",
            arguments: [suggestion.slug, repoId],
          }),
          new vscode.CodeLens(range, { title: "Preview", command: "codebank.preview", arguments: [suggestion.slug] }),
          new vscode.CodeLens(range, { title: "Not now", command: "codebank.recallDismiss", arguments: [repoId, suggestion.slug, filePath] }),
          new vscode.CodeLens(range, { title: "Mute here", command: "codebank.mute", arguments: [repoId, suggestion.slug] }),
        ];
      },
    }),
    vscode.commands.registerCommand("codebank.preview", (slug: string) => previewEntry(homeOf(), slug)),
    vscode.commands.registerCommand("codebank.recallDismiss", (repoId: string, slug: string, filePath: string) => {
      noteDismissed(homeOf(), repoId, slug, filePath);
    }),
    vscode.commands.registerCommand("codebank.mute", (repoId: string, slug: string) => {
      muteRecall(homeOf(), repoId, slug);
    }),
  );
}
