import * as vscode from "vscode";
import { ensureHome, loadIndex, resolveHome, retireEntry, setLogger } from "../../core/src/index.ts";
import { BankView, InboxView, UpdatesView } from "./bank.ts";
import { depositSelection } from "./deposit.ts";
import { insertCommand, insertSlug } from "./insert.ts";
import { searchCommand } from "./search.ts";
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
  const inbox = new InboxView();
  const updates = new UpdatesView();
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("codebank.bank", bank),
    vscode.window.registerTreeDataProvider("codebank.inbox", inbox),
    vscode.window.registerTreeDataProvider("codebank.updates", updates),
    vscode.commands.registerCommand("codebank.deposit", () => depositSelection(bankHome, () => bank.refresh())),
    vscode.commands.registerCommand("codebank.search", () => searchCommand(bankHome)),
    vscode.commands.registerCommand("codebank.insert", (slug?: string) => (slug ? insertSlug(bankHome(), slug) : insertCommand(bankHome))),
    vscode.commands.registerCommand("codebank.retire", (item?: { slug?: string }) => retire(bankHome(), item?.slug, bank)),
    vscode.commands.registerCommand("codebank.rebuildIndex", () => {
      loadIndex(bankHome());
      bank.refresh();
    }),
    vscode.commands.registerCommand("codebank.openHome", () => {
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(bankHome()));
    }),
    ...registerTools(bankHome),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = "$(archive) Codebank";
  status.command = "codebank.search";
  status.tooltip = "Search the bank";
  status.show();
  context.subscriptions.push(status);

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(bankHome()), "entries/**"));
  watcher.onDidChange(() => bank.refresh());
  watcher.onDidCreate(() => bank.refresh());
  watcher.onDidDelete(() => bank.refresh());
  context.subscriptions.push(watcher);
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
