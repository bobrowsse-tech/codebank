import * as vscode from "vscode";
import {
  ensureHome,
  loadConfig,
  originFor,
  readEntry,
  resolveOwnership,
  saveConfig,
  saveEntry,
  scanSecrets,
  searchScored,
  toSlug,
  type ClosureResult,
} from "../../core/src/index.ts";
import { closeSelection } from "./closure.ts";
import { previewEntry } from "./search.ts";

export async function depositSelection(homeOf: () => string, onSaved: () => void): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select the code to deposit.");
    return;
  }
  const closure = await closeSelection(editor.document, editor.selection);
  const home = homeOf();
  const config = ensureHome(home);
  const origin = originFor(
    editor.document.fileName,
    closure.entryFile,
    { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 },
    "manual",
  );
  const ownership = resolveOwnership(origin.org, config);
  const scanned = scanSecrets(closure.files.map((file) => file.content).join("\n"));
  const findings = scanned.filter((finding) => finding.severity === "block");
  const warnings = scanned.filter((finding) => finding.severity === "warn");
  const findingHashes = findings.map((finding) => finding.hash);
  const draft = await draftCard(closure, home, ownership === "personal" && findings.length === 0);
  const panel = vscode.window.createWebviewPanel("codebank.deposit", "Codebank: Deposit", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const nonce = Math.random().toString(36).slice(2);
  panel.webview.html = depositHtml(panel.webview, nonce, closure, draft, findings.map((finding) => finding.kind), warnings.map((finding) => finding.kind), findingHashes, ownership);
  panel.webview.onDidReceiveMessage(async (message: DepositMessage) => {
    if (message.type === "cancel") {
      panel.dispose();
      return;
    }
    if (message.type !== "save") return;
    const similar = searchScored(home, `${message.title} ${closure.symbols.join(" ")}`, 1, { targetOrg: origin.org })[0];
    const outcome = await saveEntry(
      home,
      {
        slug: toSlug(message.title),
        title: message.title,
        language: closure.language,
        entryFile: closure.entryFile,
        symbols: closure.symbols,
        tags: message.tags,
        intent: message.intent,
        whenNot: message.whenNot || undefined,
        deps: closure.deps,
        origin,
        ownership: message.ownership,
        secretOverrides: message.overrides,
      },
      closure.files,
      similar && similar.score > 0.8 && similar.card.slug !== toSlug(message.title)
        ? { similarSlug: similar.card.slug, similarScore: similar.score }
        : {},
    );
    if (!outcome.ok && outcome.reason === "secrets") {
      void vscode.window.showWarningMessage("Save is blocked until the secret is removed or marked as a false positive.");
      return;
    }
    if (!outcome.ok && (outcome.reason === "duplicate" || outcome.reason === "similar")) {
      const choice = await vscode.window.showInformationMessage(
        outcome.reason === "duplicate" ? `Open existing ${outcome.slug}` : `Similar to ${outcome.slug}`,
        "Open existing",
        "Save as variant",
        "Replace as new version",
      );
      if (choice === "Open existing") {
        await previewEntry(home, outcome.slug);
        return;
      }
      if (choice === "Save as variant" || choice === "Replace as new version") {
        const again = await saveEntry(
          home,
          {
            slug: choice === "Replace as new version" ? outcome.slug : freeSlug(home, message.title),
            title: message.title,
            language: closure.language,
            entryFile: closure.entryFile,
            symbols: closure.symbols,
            tags: message.tags,
            intent: message.intent,
            whenNot: message.whenNot || undefined,
            deps: closure.deps,
            origin,
            ownership: message.ownership,
            variantOf: { slug: outcome.slug, version: readEntry(home, outcome.slug)?.version ?? 1 },
            secretOverrides: message.overrides,
          },
          closure.files,
          { mode: choice === "Replace as new version" ? "replace" : "variant" },
        );
        if (again.ok) {
          onSaved();
          panel.dispose();
        }
      }
      return;
    }
    if (!outcome.ok) {
      void vscode.window.showWarningMessage(outcome.problems.join(" "));
      return;
    }
    onSaved();
    panel.dispose();
  });
}

async function draftCard(closure: ClosureResult, home: string, allowModel: boolean): Promise<{ title: string; intent: string; whenNot: string; tags: string[] }> {
  const fallback = {
    title: closure.symbols[0] ?? "entry",
    intent: "",
    whenNot: "",
    tags: [...closure.deps.map((dep) => dep.name.split("/").pop() ?? dep.name), ...closure.symbols.map((symbol) => symbol.toLowerCase())].slice(0, 8),
  };
  if (!allowModel) return fallback;
  const config = loadConfig(home);
  if (!config.model.consented && config.model.family !== "declined") {
    const answer = await vscode.window.showInformationMessage(
      "Codebank will send the selected code to your editor's language model to draft a description",
      "Allow",
      "Not now",
    );
    config.model.consented = answer === "Allow";
    config.model.family = answer === "Allow" ? "editor" : "declined";
    saveConfig(home, config);
  }
  if (!config.model.consented) return fallback;
  try {
    const models = await vscode.lm.selectChatModels();
    const model = models[0];
    if (!model) return fallback;
    const prompt = `Return JSON {"title","intent","whenNot","tags"} for this code. intent and whenNot are at most 280 characters. tags has at most 8 lowercase words.\n\n${closure.files.map((file) => file.content).join("\n").slice(0, 24_000)}`;
    const parsed = await askModel(model, prompt);
    return parsed ?? (await askModel(model, prompt)) ?? fallback;
  } catch {
    return fallback;
  }
}

async function askModel(model: vscode.LanguageModelChat, prompt: string): Promise<{ title: string; intent: string; whenNot: string; tags: string[] } | undefined> {
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {});
  let text = "";
  for await (const chunk of response.text) text += chunk;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  const json = JSON.parse(match[0]) as { title?: string; intent?: string; whenNot?: string; tags?: string[] };
  if (!json.title || (json.intent ?? "").length > 280 || (json.whenNot ?? "").length > 280) return undefined;
  return {
    title: json.title,
    intent: json.intent ?? "",
    whenNot: json.whenNot ?? "",
    tags: (json.tags ?? []).map((tag) => tag.toLowerCase()).slice(0, 8),
  };
}

interface DepositMessage {
  type: "save" | "cancel";
  title: string;
  intent: string;
  whenNot: string;
  tags: string[];
  ownership: "personal" | "client" | "unknown";
  overrides: string[];
}

function freeSlug(home: string, title: string): string {
  const base = toSlug(title);
  if (!readEntry(home, base)) return base;
  for (let n = 2; n < 50; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!readEntry(home, candidate)) return candidate;
  }
  return base;
}

function depositHtml(
  webview: vscode.Webview,
  nonce: string,
  closure: ClosureResult,
  draft: { title: string; intent: string; whenNot: string; tags: string[] },
  secrets: string[],
  warnings: string[],
  findingHashes: string[],
  ownership: "personal" | "client" | "unknown",
): string {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
  const files = closure.files.map((file) => `<li>${escapeHtml(file.relPath)}</li>`).join("");
  const closureNotes = closure.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("");
  const blocked = secrets.length > 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Deposit</title>
<style nonce="${nonce}">
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 20px 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0; }
  label, .hint { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
  input, textarea, select, button { font: inherit; color: inherit; }
  input, textarea, select { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 4px 8px; }
  textarea { min-height: 3.2rem; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 2px; padding: 4px 14px; }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, transparent)); }
  button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 14px; }
  .stack { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
  .files { font-family: var(--vscode-editor-font-family); font-size: 0.85rem; }
  a, .accent { color: var(--vscode-textLink-foreground); }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
</style>
</head>
<body>
<main>
  <h1>Deposit to Codebank</h1>
  <p class="hint">Nothing is saved until you press Save.</p>
  <section class="files" aria-label="Closure">
    <p>Closure: ${closure.files.length} files${closure.truncated ? " · truncated" : ""}</p>
    <ul>${files}</ul>
    ${closureNotes}
    ${blocked ? `<p>Secret found: ${secrets.map(escapeHtml).join(", ")}. Save stays disabled until you remove it or mark it a false positive.</p>` : `<p>Secret scan: clean. ${closure.files.length} files checked.</p>`}
    ${warnings.length > 0 ? `<p>Warning: ${warnings.map(escapeHtml).join(", ")}.</p>` : ""}
  </section>
  <form class="stack" id="card">
    <label>Title <input id="title" value="${escapeHtml(draft.title)}" required></label>
    <label>What it does <textarea id="intent" maxlength="280">${escapeHtml(draft.intent)}</textarea></label>
    <label>When not to use it <textarea id="whenNot" maxlength="280">${escapeHtml(draft.whenNot)}</textarea></label>
    <label>Tags <input id="tags" value="${escapeHtml(draft.tags.join(" "))}"></label>
    <label>Ownership
      <select id="ownership">
        ${(["personal", "client", "unknown"] as const).map((value) => `<option value="${value}"${value === ownership ? " selected" : ""}>${value}</option>`).join("")}
      </select>
    </label>
    ${blocked ? `<label><input type="checkbox" id="override"> Mark the finding as a false positive</label>` : ""}
    <div class="row">
      <button type="submit" id="save" ${blocked ? "disabled" : ""}>Save to bank</button>
      <button type="button" class="secondary" id="cancel">Cancel</button>
    </div>
  </form>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const override = document.getElementById("override");
  const save = document.getElementById("save");
  override?.addEventListener("change", () => { if (save) save.disabled = !override.checked; });
  document.getElementById("cancel")?.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  document.getElementById("card")?.addEventListener("submit", (event) => {
    event.preventDefault();
    vscode.postMessage({
      type: "save",
      title: document.getElementById("title").value,
      intent: document.getElementById("intent").value,
      whenNot: document.getElementById("whenNot").value,
      tags: document.getElementById("tags").value.split(/\\s+/).filter(Boolean),
      ownership: document.getElementById("ownership").value,
      overrides: override?.checked ? ${JSON.stringify(findingHashes)} : []
    });
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
