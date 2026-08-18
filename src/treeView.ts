import * as vscode from 'vscode';
import { Store } from './store';
import { ThreadState } from './threadLog';

type Node = FileNode | ThreadNode;

interface FileNode {
  kind: 'file';
  docUri: vscode.Uri;
  file: string;
  threads: ThreadState[];
}

interface ThreadNode {
  kind: 'thread';
  docUri: vscode.Uri;
  thread: ThreadState;
}

/**
 * "Comments" sidebar view: every thread across the repo, folded straight from
 * `.comments/threads/` so files never have to be opened to be discovered.
 */
export class CommentsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  showResolved = true;

  constructor(private readonly store: Store) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.store
        .listByFile()
        .map(({ docUri, file, threads }) => ({ kind: 'file', docUri, file, threads }) as FileNode)
        .filter((n) => this.visibleThreads(n.threads).length > 0)
        .sort((a, b) => a.file.localeCompare(b.file));
    }
    if (element.kind === 'file') {
      return this.visibleThreads(element.threads).map(
        (thread) => ({ kind: 'thread', docUri: element.docUri, thread }) as ThreadNode,
      );
    }
    return [];
  }

  private visibleThreads(threads: ThreadState[]): ThreadState[] {
    return threads.filter((t) => this.showResolved || t.status === 'open');
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const open = node.threads.filter((t) => t.status === 'open').length;
      const total = this.visibleThreads(node.threads).length;
      const item = new vscode.TreeItem(node.file, vscode.TreeItemCollapsibleState.Expanded);
      item.description = open > 0 ? `${open} open` : `${total} resolved`;
      item.resourceUri = node.docUri;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const t = node.thread;
    const visible = t.comments.filter((c) => !c.deleted);
    const first = visible[0];
    const snippet = t.anchor.text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const item = new vscode.TreeItem(
      first ? first.body.replace(/\s+/g, ' ').slice(0, 80) : '(empty thread)',
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${visible.length > 1 ? `+${visible.length - 1} · ` : ''}L${t.anchor.start.line + 1}`;
    item.tooltip = new vscode.MarkdownString(
      `**${first?.author ?? ''}** on \`${snippet}\`\n\n` +
        visible.map((c) => `- **${c.author}**: ${c.body}`).join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(
      t.status === 'resolved' ? 'pass' : 'comment-discussion',
      t.status === 'resolved' ? new vscode.ThemeColor('charts.green') : undefined,
    );
    item.command = {
      command: 'mdComments.revealThread',
      title: 'Reveal',
      arguments: [node.docUri, t.anchor.start.line],
    };
    return item;
  }
}

/** Badge on files (and their parent dirs) that carry open comment threads. */
export class CommentsDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changeEmitter.event;
  private counts = new Map<string, number>();

  constructor(private readonly store: Store) {
    this.rebuild();
  }

  rebuild(): void {
    this.counts = new Map();
    for (const { docUri, threads } of this.store.listByFile()) {
      const open = threads.filter((t) => t.status === 'open').length;
      if (open > 0) this.counts.set(docUri.toString(), open);
    }
    this.changeEmitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const n = this.counts.get(uri.toString());
    if (!n) return undefined;
    return new vscode.FileDecoration(
      String(Math.min(n, 99)),
      `${n} open comment thread${n === 1 ? '' : 's'}`,
      new vscode.ThemeColor('charts.yellow'),
    );
  }
}
