import path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import type { MineProgress, MineResult } from "../../core/src/mining/scan.ts";

export function scanFolders(homeOf: () => string, onDone: () => void): void {
  const configured = vscode.workspace.getConfiguration("codebank").get<string[]>("scan.roots") ?? [];
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const roots = (configured.length > 0 ? configured : folders).map((root) => root.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
  const panel = vscode.window.createWebviewPanel("codebank.scan", "Codebank: Scan", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const nonce = Math.random().toString(36).slice(2);
  let worker: Worker | undefined;
  const render = (state: string, detail: string) => {
    panel.webview.html = scanHtml(panel.webview, nonce, state, detail);
  };
  if (roots.length === 0) {
    render("setup", "Add folders in codebank.scan.roots.");
    return;
  }
  render("scanning", `Looking through ${roots.length} roots.`);
  const inspected = vscode.workspace.getConfiguration("codebank").inspect<string[]>("scan.ignore");
  const ignore = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  worker = new Worker(path.join(__dirname, "mine-worker.js"), { workerData: { home: homeOf(), roots, ignore } });
  worker.on("message", (message: { type: string; progress?: MineProgress; result?: MineResult; message?: string }) => {
    if (message.type === "progress" && message.progress) {
      const progress = message.progress;
      render("scanning", `${progress.reposDone} of ${progress.reposTotal} repos · ${progress.files} files · ${progress.repo}`);
    }
    if (message.type === "done" && message.result) {
      const result = message.result;
      const found = result.candidates.length;
      render(result.cancelled ? "cancelled" : found === 0 ? "nothing found" : "done", `${found} new candidates from ${result.files} files.`);
      onDone();
    }
    if (message.type === "error") render("error", message.message ?? "The scan failed.");
  });
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    if (message.type === "cancel") worker?.postMessage({ type: "cancel" });
  });
  panel.onDidDispose(() => {
    void worker?.terminate();
  });
}

function scanHtml(webview: vscode.Webview, nonce: string, state: string, detail: string): string {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Scan</title>
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 20px 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  h1 { font-size: 1.15rem; font-weight: 600; }
  p { color: var(--vscode-descriptionForeground); }
  button { font: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 2px; padding: 4px 14px; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  progress { width: 100%; accent-color: var(--vscode-textLink-foreground); }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
</style>
</head>
<body>
<main>
  <h1>Scan for code you already wrote</h1>
  <p>${escapeHtml(state)}</p>
  ${state === "scanning" ? '<progress max="1"></progress>' : state === "setup" ? "" : '<progress value="1" max="1"></progress>'}
  <p>${escapeHtml(detail)}</p>
  ${state === "scanning" ? '<button id="cancel" type="button">Cancel</button>' : ""}
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById("cancel")?.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
