import * as vscode from "vscode";
import { listCandidates, listEntries, type Entry } from "../../core/src/index.ts";

export class BankView implements vscode.TreeDataProvider<BankNode> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly home: () => string) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(element: BankNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BankNode): BankNode[] {
    const entries = listEntries(this.home()).filter((entry) => entry.status !== "retired");
    if (!element) {
      if (entries.length === 0) return [new BankNode("Deposit a selection to start the bank.", "empty")];
      const tags = [...new Set(entries.flatMap((entry) => (entry.tags.length > 0 ? entry.tags : ["untagged"])))].sort();
      return tags.map((tag) => new BankNode(tag, "tag"));
    }
    if (element.kind !== "tag") return [];
    return entries
      .filter((entry) => (entry.tags.length > 0 ? entry.tags : ["untagged"]).includes(element.labelText))
      .map((entry) => entryNode(entry));
  }
}

export class InboxView implements vscode.TreeDataProvider<BankNode> {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private readonly home: () => string) {}

  refresh(): void {
    this.change.fire();
  }

  getTreeItem(element: BankNode): vscode.TreeItem {
    return element;
  }

  getChildren(): BankNode[] {
    const candidates = listCandidates(this.home());
    if (candidates.length === 0) return [new BankNode("Candidates from a scan show up here.", "empty")];
    return candidates.map((candidate) => {
      const label = candidate.proposedBy === "agent" ? `${candidate.draft.title} · agent-proposed` : candidate.draft.title;
      const node = new BankNode(label, "candidate", candidate.id);
      node.description = candidate.reasons[0] ?? candidate.proposedBy;
      return node;
    });
  }
}

export class UpdatesView implements vscode.TreeDataProvider<BankNode> {
  readonly onDidChangeTreeData = new vscode.EventEmitter<void>().event;
  getTreeItem(element: BankNode): vscode.TreeItem {
    return element;
  }
  getChildren(): BankNode[] {
    return [new BankNode("Insert an entry to track updates.", "empty")];
  }
}

class BankNode extends vscode.TreeItem {
  constructor(
    readonly labelText: string,
    readonly kind: "tag" | "entry" | "candidate" | "empty",
    readonly slug?: string,
  ) {
    super(labelText, kind === "tag" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = kind === "entry" ? "entry" : kind;
  }
}

function entryNode(entry: Entry): BankNode {
  const node = new BankNode(entry.title, "entry", entry.slug);
  const stale = entry.status === "stale" ? " · stale" : "";
  node.description = `${entry.language} · v${entry.version} · used ${entry.stats.uses} times${stale}`;
  node.iconPath = new vscode.ThemeIcon(entry.ownership === "personal" ? "file-code" : "lock");
  if (entry.status === "stale") node.iconPath = new vscode.ThemeIcon("warning");
  node.command = { command: "codebank.insert", title: "Insert", arguments: [entry.slug] };
  return node;
}
