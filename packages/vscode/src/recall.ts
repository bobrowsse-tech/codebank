import * as vscode from "vscode";
import { describeRepo, pastedText, suggestRecall } from "../../core/src/index.ts";
import { muteRecall, noteDismissed, noteShown } from "../../core/src/recall/state.ts";
import { previewEntry } from "./search.ts";

const recentPastes = new Map<string, string>();

export function registerRecall(context: vscode.ExtensionContext, homeOf: () => string): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const key = event.document.uri.toString();
      const pasted = pastedText(event.contentChanges.map((change) => change.text));
      if (pasted) recentPastes.set(key, pasted);
      else recentPastes.delete(key);
    }),
    vscode.languages.registerCodeLensProvider([{ language: "typescript" }, { language: "javascript" }, { language: "typescriptreact" }, { language: "javascriptreact" }], {
      provideCodeLenses(document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const repo = folder ? describeRepo(folder.uri.fsPath) : undefined;
        const recall = vscode.workspace.getConfiguration("codebank");
        const enabled = recall.inspect<boolean>("recall.enabled");
        const threshold = recall.inspect<number>("recall.threshold");
        const suggestion = suggestRecall(homeOf(), {
          filePath: document.uri.fsPath,
          text: document.getText(),
          repoId: repo?.repoId ?? "workspace",
          targetOrg: repo?.org,
          enabled: enabled?.workspaceFolderValue ?? enabled?.workspaceValue ?? enabled?.globalValue,
          threshold: threshold?.workspaceFolderValue ?? threshold?.workspaceValue ?? threshold?.globalValue,
          pasted: recentPastes.get(document.uri.toString()),
        });
        if (!suggestion) return [];
        void noteShown(homeOf(), repo?.repoId ?? "workspace", document.uri.fsPath, suggestion.slug);
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
    vscode.commands.registerCommand("codebank.recallDismiss", async (repoId: string, slug: string, filePath: string) => {
      await noteDismissed(homeOf(), repoId, slug, filePath);
    }),
    vscode.commands.registerCommand("codebank.mute", async (repoId: string, slug: string) => {
      await muteRecall(homeOf(), repoId, slug);
    }),
  );
}
