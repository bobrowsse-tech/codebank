import * as vscode from "vscode";
import { appendUsage, applyInsert, describeRepo, noteAccepted, planInsert, readEntry, readEntryFiles, recordUse, searchBank } from "../../core/src/index.ts";
import { languageFromFile } from "../../core/src/closure/extract.ts";

export async function insertCommand(homeOf: () => string): Promise<void> {
  const home = homeOf();
  const query = await vscode.window.showInputBox({ prompt: "Which entry should be inserted?" });
  if (!query) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cards = searchBank(home, query, 8, { targetOrg: folder ? describeRepo(folder.uri.fsPath).org : undefined });
  const picked = await vscode.window.showQuickPick(cards.map((card) => ({ label: card.title, description: card.slug, slug: card.slug })));
  if (!picked) return;
  await insertSlug(home, picked.slug);
}

export async function insertSlug(home: string, slug: string, repoId?: string): Promise<void> {
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
  const insertDir = vscode.workspace.getConfiguration("codebank").get<string>("insertDir") || "src/codebank";
  let confirmed = false;
  const files = readEntryFiles(home, slug);
  const planned = {
    entry,
    files,
    mode: mode.mode,
    targetLanguage,
    targetPackageJson: packageJson,
    targetOrg: repo.org,
    fromFile: editor?.document.fileName,
    projectDir: folder.uri.fsPath,
    insertDir,
  };
  let plan = planInsert({ ...planned, confirmedCrossOrg: confirmed });
  if (plan.blocked === "cross-org") {
    const choice = await vscode.window.showWarningMessage(
      `This entry is from ${entry.origin.org ?? "an unknown org"}.`,
      "Insert anyway",
      "Cancel",
    );
    if (choice !== "Insert anyway") return;
    confirmed = true;
    plan = planInsert({ ...planned, confirmedCrossOrg: confirmed });
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
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showWarningMessage("The editor rejected the insert.");
      return;
    }
  } else {
    try {
      applyInsert(folder.uri.fsPath, insertDir, plan);
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : "Insert path was rejected.");
      return;
    }
    if (editor && plan.importLine) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(editor.document.uri, editor.selection.active, `${plan.importLine}\n`);
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showWarningMessage("The editor rejected the insert.");
        return;
      }
    }
  }
  await recordUse(home, slug, plan.verbatim);
  if (repoId) await noteAccepted(home, repoId, slug);
  appendUsage(home, { t: new Date().toISOString(), kind: "inserted", surface: repoId ? "codelens" : "quickpick", slug, verbatim: plan.verbatim });
  if (plan.installCommand) {
    const install = await vscode.window.showInformationMessage(`Missing ${plan.missingDeps.map((dep) => dep.name).join(", ")}.`, "Show install command");
    if (install) {
      const terminal = vscode.window.createTerminal("Codebank");
      terminal.show();
      terminal.sendText(plan.installCommand, false);
    }
  }
}
