import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  describeRepo,
  findUpdates,
  linkedContentHash,
  linkedSource,
  markDrift,
  markerBody,
  noteLocalEdit,
  parseMarkers,
  planUpdate,
  promoteEntry,
  readEntry,
  readEntryFiles,
  readLinks,
  readVersionFiles,
  rememberedRepos,
  rememberRepo,
  updateReplacement,
  upsertLink,
  type UpdateNotice,
} from "../../core/src/index.ts";

const pending = new Map<string, string>();

export async function workspaceUpdates(home: string): Promise<UpdateNotice[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const notices: UpdateNotice[] = [];
  for (const folder of folders) {
    const repo = describeRepo(folder.uri.fsPath);
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.{ts,tsx,js,jsx,css,scss,html,md}"),
      "**/{node_modules,dist,.git}/**",
      500,
    );
    const files: { relPath: string; content: string }[] = [];
    for (const uri of uris) {
      try {
        files.push({ relPath: relative(folder.uri.fsPath, uri.fsPath), content: fs.readFileSync(uri.fsPath, "utf8") });
      } catch {
        continue;
      }
    }
    notices.push(...findUpdates(home, repo.repoId, files));
  }
  return notices;
}

export async function reviewUpdate(home: string, slug: string, relPath: string, repoId: string): Promise<void> {
  const entry = readEntry(home, slug);
  const folder = folderFor(repoId);
  if (!entry || !folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, ...relPath.split("/"));
  let local = "";
  try {
    local = fs.readFileSync(uri.fsPath, "utf8");
  } catch {
    void vscode.window.showWarningMessage("The inserted copy is not in this folder.");
    return;
  }
  const stored = readLinks(home, repoId).find((link) => link.slug === slug && link.relPath === relPath);
  const sourceRelPath = linkedSource(entry.entryFile, stored);
  const version = parseMarkers(local).find((marker) => marker.slug === slug)?.version ?? stored?.version ?? 1;
  if (entry.status === "stale" && version >= entry.version) {
    void vscode.window.showInformationMessage(staleMessage(entry.title, entry.staleReason));
    return;
  }
  const base = readVersionFiles(home, slug, version).find((file) => file.relPath === sourceRelPath)?.content ?? "";
  const upstream = readEntryFiles(home, slug).find((file) => file.relPath === sourceRelPath)?.content ?? "";
  const localBody = markerBody(local, slug) ?? local;
  const plan = planUpdate(base, localBody, upstream);
  pending.set(keyOf(slug, entry.version), upstream);
  const upstreamUri = vscode.Uri.parse(`codebank-update:${slug}/v${entry.version}`);
  await vscode.commands.executeCommand("vscode.diff", uri, upstreamUri, `${entry.title}: local ↔ v${entry.version}`);
  if (plan.kind === "conflict") {
    const choice = await vscode.window.showWarningMessage(`Both copies of ${entry.title} changed. Nothing was applied.`, "Promote mine", "Keep mine");
    if (choice === "Promote mine") await promoteCopy(home, entry.slug, sourceRelPath, localBody, repoId, relPath, stored?.mode);
    return;
  }
  if (plan.kind === "promote") {
    const choice = await vscode.window.showInformationMessage(`You changed ${entry.title} and the bank copy is unchanged.`, "Promote mine", "Keep mine");
    if (choice === "Promote mine") await promoteCopy(home, entry.slug, sourceRelPath, localBody, repoId, relPath, stored?.mode);
    return;
  }
  const choice = await vscode.window.showInformationMessage(`${entry.title} v${entry.version} is available.`, "Take update", "Keep mine");
  if (choice !== "Take update") return;
  const replacement = updateReplacement(local, plan.result, entry.language, entry.slug, entry.version, entry.contentHash, sourceRelPath);
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end)), replacement.text);
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showWarningMessage("The editor rejected the update.");
    return;
  }
  const nextBody = markerBody(replacement.text, entry.slug) ?? plan.result;
  const hash = linkedContentHash(sourceRelPath, nextBody);
  await upsertLink(home, {
    slug: entry.slug,
    version: entry.version,
    baseHash: hash,
    repoId,
    relPath,
    sourceRelPath,
    mode: stored?.mode ?? "marker",
    localHash: hash,
    insertedAt: stored?.insertedAt ?? new Date().toISOString(),
  });
}

export async function noteSavedCopy(home: string, document: vscode.TextDocument): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return;
  const relPath = relative(folder.uri.fsPath, document.uri.fsPath);
  const repo = describeRepo(folder.uri.fsPath);
  const result = await noteLocalEdit(home, repo.repoId, relPath, document.getText());
  if (!result.prompt || !result.slug || !result.title) return;
  const choice = await vscode.window.showInformationMessage(`You changed ${result.title} after inserting it. Promote the change?`, "Promote");
  if (choice !== "Promote") return;
  const entry = readEntry(home, result.slug);
  if (!entry) return;
  const stored = readLinks(home, repo.repoId).find((link) => link.relPath === relPath);
  const sourceRelPath = linkedSource(entry.entryFile, stored);
  const body = markerBody(document.getText(), result.slug) ?? document.getText();
  await promoteCopy(home, result.slug, sourceRelPath, body, repo.repoId, relPath, stored?.mode);
}

export async function noteWorkspaceDrift(home: string): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const repo = describeRepo(folder.uri.fsPath);
    await rememberRepo(home, repo.repoId, repo.root);
  }
  const repos = rememberedRepos(home);
  if (repos.length === 0) return;
  await markDrift(home, repos);
}

export function updateText(uri: vscode.Uri): string {
  return pending.get(uri.path.replace(/^\//, "")) ?? "";
}

function keyOf(slug: string, version: number): string {
  return `${slug}/v${version}`;
}

function staleMessage(title: string, reason: string | undefined): string {
  return reason ? `${title} is stale because ${reason} moved ahead in other repositories.` : `${title} is stale.`;
}

async function promoteCopy(
  home: string,
  slug: string,
  entryFile: string,
  content: string,
  repoId: string,
  relPath: string,
  mode: "marker" | "external" | undefined,
): Promise<void> {
  const files = readEntryFiles(home, slug).map((file) => (file.relPath === entryFile ? { relPath: file.relPath, content } : file));
  const outcome = await promoteEntry(home, slug, files.length > 0 ? files : [{ relPath: entryFile, content }], { repoId, relPath, mode, sourceRelPath: entryFile });
  if (!outcome.ok) void vscode.window.showWarningMessage("The change was not promoted.");
  else void vscode.window.showInformationMessage(`Promoted ${slug} to v${outcome.entry.version}.`);
}

function folderFor(repoId: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => describeRepo(folder.uri.fsPath).repoId === repoId);
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
