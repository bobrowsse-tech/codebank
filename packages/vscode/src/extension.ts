import * as vscode from "vscode";
import { acceptCandidate, dismissCandidate, ensureHome, listCandidates, loadIndex, resolveHome, retireEntry, setLogger } from "../../core/src/index.ts";
import { BankView, InboxView, UpdatesView } from "./bank.ts";
import { depositSelection } from "./deposit.ts";
import { insertCommand, insertSlug } from "./insert.ts";
import { previewCandidate, searchCommand } from "./search.ts";
import { registerRecall } from "./recall.ts";
import { scanFolders } from "./scan.ts";
import { registerTools } from "./tools.ts";

export function bankHome(): string {
  const configured = vscode.workspace.getConfiguration("codebank").get<string>("home")?.trim();
  return resolveHome(configured || undefined);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Codebank", { log: true });
  setLogger((stage, direction, data) => {
    output.debug(`${stage} ${direction} ${JSON.stringify(data)}`);
  });
  const home = bankHome();
  ensureHome(home);
  setTimeout(() => {
    try {
      loadIndex(bankHome());
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
    }
  }, 0);

  const bank = new BankView(() => bankHome());
  const inbox = new InboxView(bankHome);
  const updates = new UpdatesView();
  const inboxView = vscode.window.createTreeView("codebank.inbox", { treeDataProvider: inbox });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const refreshStatus = () => {
    const waiting = listCandidates(bankHome()).length;
    status.text = waiting > 0 ? `$(archive) Codebank ${waiting}` : "$(archive) Codebank";
    inboxView.badge = waiting > 0 ? { value: waiting, tooltip: `${waiting} waiting` } : undefined;
  };
  const refreshInbox = () => {
    inbox.refresh();
    refreshStatus();
  };
  context.subscriptions.push(
    output,
    inboxView,
    vscode.window.registerTreeDataProvider("codebank.bank", bank),
    vscode.window.registerTreeDataProvider("codebank.updates", updates),
    vscode.commands.registerCommand("codebank.deposit", () => depositSelection(bankHome, () => bank.refresh())),
    vscode.commands.registerCommand("codebank.search", () => searchCommand(bankHome)),
    vscode.commands.registerCommand("codebank.insert", (item?: unknown, repoId?: string, projectPath?: string) => {
      const slug = treeId(item);
      return slug ? insertSlug(bankHome(), slug, repoId, projectPath) : insertCommand(bankHome);
    }),
    vscode.commands.registerCommand("codebank.openInbox", () => {
      void vscode.commands.executeCommand("codebank.inbox.focus");
    }),
    vscode.commands.registerCommand("codebank.retire", (item?: unknown) => retire(bankHome(), treeId(item), bank)),
    vscode.commands.registerCommand("codebank.rebuildIndex", () => {
      loadIndex(bankHome());
      bank.refresh();
    }),
    vscode.commands.registerCommand("codebank.openHome", () => {
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(bankHome()));
    }),
    vscode.commands.registerCommand("codebank.mine", () => scanFolders(bankHome, refreshInbox)),
    vscode.commands.registerCommand("codebank.previewCandidate", (item?: unknown) => {
      const id = treeId(item);
      if (id) return previewCandidate(bankHome(), id);
    }),
    vscode.commands.registerCommand("codebank.accept", async (item?: unknown) => {
      const id = treeId(item);
      if (!id) return;
      const outcome = await acceptCandidate(bankHome(), id);
      if (!outcome.ok) void vscode.window.showWarningMessage(outcome.reason === "missing" ? "That candidate is gone." : `Not accepted: ${outcome.reason}.`);
      refreshInbox();
      bank.refresh();
    }),
    vscode.commands.registerCommand("codebank.dismiss", async (item?: unknown) => {
      const id = treeId(item);
      if (!id) return;
      await dismissCandidate(bankHome(), id);
      refreshInbox();
    }),
    ...registerTools(bankHome, refreshInbox),
  );
  registerRecall(context, bankHome);

  refreshStatus();
  if (!context.globalState.get<boolean>("codebank.firstScan")) {
    void context.globalState.update("codebank.firstScan", true);
    setTimeout(() => scanFolders(bankHome, refreshInbox), 0);
  }
  status.command = "codebank.search";
  status.tooltip = "Search the bank";
  status.show();
  context.subscriptions.push(status);

  const homeUri = vscode.Uri.file(bankHome());
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(homeUri, "entries/**"));
  watcher.onDidChange(() => bank.refresh());
  watcher.onDidCreate(() => bank.refresh());
  watcher.onDidDelete(() => bank.refresh());
  const inboxWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(homeUri, "inbox/**"));
  inboxWatcher.onDidChange(refreshInbox);
  inboxWatcher.onDidCreate(refreshInbox);
  inboxWatcher.onDidDelete(refreshInbox);
  context.subscriptions.push(watcher, inboxWatcher);
}

function treeId(item: unknown): string | undefined {
  if (typeof item === "string" && item) return item;
  if (!item || typeof item !== "object") return undefined;
  const node = item as { slug?: unknown; command?: { arguments?: unknown[] } };
  const argument = node.command?.arguments?.[0];
  if (typeof argument === "string" && argument) return argument;
  return typeof node.slug === "string" && node.slug ? node.slug : undefined;
}

async function retire(home: string, slug: string | undefined, bank: BankView): Promise<void> {
  if (!slug) return;
  const retired = await retireEntry(home, slug);
  if (!retired) {
    void vscode.window.showWarningMessage(`No entry named ${slug}.`);
    return;
  }
  bank.refresh();
}

export function deactivate(): void {}
