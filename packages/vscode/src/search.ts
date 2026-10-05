import * as vscode from "vscode";
import { appendUsage, describeRepo, readCandidate, readEntryFiles, searchBank } from "../../core/src/index.ts";
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

function ensurePreview(): void {
  if (registered) return;
  vscode.workspace.registerTextDocumentContentProvider(scheme, provider);
  registered = true;
}

export async function previewEntry(home: string, slug: string): Promise<void> {
  ensurePreview();
  const files = readEntryFiles(home, slug);
  provider.set(slug, files.map((file) => `// ${file.relPath}\n${file.content}`).join("\n\n"));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:/${slug}`));
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
}

export async function previewCandidate(home: string, id: string): Promise<void> {
  ensurePreview();
  const candidate = readCandidate(home, id);
  if (!candidate) return;
  const sources = candidate.sources.map((source) => `${source.repoName} ${source.relPath}`).join("\n") || "no source repos";
  const header = [`score ${candidate.score.toFixed(2)}`, candidate.reasons.join("; ") || candidate.proposedBy, sources].join("\n");
  const body = candidate.files.map((file) => `// ${file.relPath}\n${file.content}`).join("\n\n");
  provider.set(`candidate-${id}`, `${header}\n\n${body}`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:/candidate-${id}`));
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
}

export async function searchCommand(homeOf: () => string): Promise<void> {
  ensurePreview();
  const query = await vscode.window.showInputBox({ prompt: "Search the bank", placeHolder: "filtering" });
  if (!query) return;
  const home = homeOf();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cards = searchBank(home, query, 8, { targetOrg: folder ? describeRepo(folder.uri.fsPath).org : undefined });
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
  await previewEntry(home, picked.card.slug);
  await insertSlug(home, picked.card.slug);
}
