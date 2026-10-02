import * as vscode from "vscode";
import { appendUsage, readEntryFiles, searchBank, type Card } from "../../core/src/index.ts";
import { insertSlug } from "./insert.ts";

const scheme = "codebank-preview";
const provider = new (class implements vscode.TextDocumentContentProvider {
  private text = new Map<string, string>();
  set(slug: string, text: string): void {
    this.text.set(slug, text);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.text.get(uri.path.replace(/^\//, "")) ?? "";
  }
})();

let registered = false;

export async function searchCommand(homeOf: () => string): Promise<void> {
  if (!registered) {
    vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
    registered = true;
  }
  const query = await vscode.window.showInputBox({ prompt: "Search the bank", placeHolder: "filtering" });
  if (!query) return;
  const home = homeOf();
  const cards = searchBank(home, query, 8);
  appendUsage(home, { t: new Date().toISOString(), kind: "search", surface: "quickpick", query });
  if (cards.length === 0) {
    void vscode.window.showInformationMessage("No matches. Deposit a selection to add one.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    cards.map((card) => ({
      label: card.title,
      description: card.deps.join(" ") || "no dependencies",
      detail: `${card.intent} · used ${card.uses} times`,
      card,
    })),
    { placeHolder: "Enter inserts into the project. Click the item to insert." },
  );
  if (!picked) return;
  await showPreview(home, picked.card);
  await insertSlug(home, picked.card.slug);
}

async function showPreview(home: string, card: Card): Promise<void> {
  const files = readEntryFiles(home, card.slug);
  provider.set(card.slug, files.map((file) => `// ${file.relPath}\n${file.content}`).join("\n\n"));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:/${card.slug}`));
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
}
