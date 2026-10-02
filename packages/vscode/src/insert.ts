import * as vscode from "vscode";
import { appendUsage, applyInsert, describeRepo, planInsert, readEntry, readEntryFiles, recordUse, searchBank } from "../../core/src/index.ts";
import { languageFromFile } from "../../core/src/closure/extract.ts";

export async function insertCommand(homeOf: () => string): Promise<void> {
  const home = homeOf();
  const query = await vscode.window.showInputBox({ prompt: "Which entry should be inserted?" });
  if (!query) return;
  const cards = searchBank(home, query, 8);
  const picked = await vscode.window.showQuickPick(cards.map((card) => ({ label: card.title, description: card.slug, slug: card.slug })));
  if (!picked) return;
  await insertSlug(home, picked.slug);
}

export async function insertSlug(home: string, slug: string): Promise<void> {
  const entry = readEntry(home, slug);
  if (!entry) {
    void vscode.window.showWarningMessage(`No entry named ${slug}.`);
    return;
  }
  const mode = await vscode.window.showQuickPick(
    [
      { label: "Add to project", mode: "add" as const },
      { label: "Insert at cursor", mode: "cursor" as const },
    ],
    { placeHolder: "How should this entry be inserted?" },
  );
  if (!mode) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage("Open a folder before inserting.");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const targetLanguage = editor ? languageFromFile(editor.document.fileName) : entry.language;
  const packageJson = vscode.Uri.joinPath(folder.uri, "package.json").fsPath;
  const repo = describeRepo(folder.uri.fsPath);
  let confirmed = false;
  const files = readEntryFiles(home, slug);
  let plan = planInsert({
    entry,
    files,
    mode: mode.mode,
    targetLanguage,
    targetPackageJson: packageJson,
    targetOrg: repo.org,
    confirmedCrossOrg: confirmed,
  });
  if (plan.blocked === "cross-org") {
    const choice = await vscode.window.showWarningMessage(
      `This entry is from ${entry.origin.org ?? "an unknown org"}.`,
      "Insert anyway",
      "Cancel",
    );
    if (choice !== "Insert anyway") return;
    confirmed = true;
    plan = planInsert({ entry, files, mode: mode.mode, targetLanguage, targetPackageJson: packageJson, targetOrg: repo.org, confirmedCrossOrg: confirmed });
  }
  if (mode.mode === "cursor") {
    if (!editor) {
      void vscode.window.showInformationMessage("Open a file to insert at the cursor.");
      return;
    }
    if (files.length !== 1) {
      void vscode.window.showInformationMessage("Insert at cursor is only for a single-file entry.");
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(editor.document.uri, editor.selection.active, `${plan.files[0].content}\n`);
    await vscode.workspace.applyEdit(edit);
  } else {
    const insertDir = vscode.workspace.getConfiguration("codebank").get<string>("insertDir") || "src/codebank";
    applyInsert(folder.uri.fsPath, insertDir, plan);
    if (editor && plan.importLine) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(editor.document.uri, editor.selection.active, `${plan.importLine}\n`);
      await vscode.workspace.applyEdit(edit);
    }
  }
  await recordUse(home, slug, plan.verbatim);
  appendUsage(home, { t: new Date().toISOString(), kind: "inserted", surface: "quickpick", slug, verbatim: plan.verbatim });
  if (plan.installCommand) {
    const install = await vscode.window.showInformationMessage(`Missing ${plan.missingDeps.map((dep) => dep.name).join(", ")}.`, "Show install command");
    if (install) {
      const terminal = vscode.window.createTerminal("Codebank");
      terminal.show();
      terminal.sendText(plan.installCommand, false);
    }
  }
}
