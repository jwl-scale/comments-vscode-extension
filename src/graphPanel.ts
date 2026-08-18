import * as vscode from 'vscode';
import { CURSOR_OPEN_CHAT_COMMAND } from './sessionProviders';
import { SessionGraph } from './model';
import { ConversationFocus } from './links';

/**
 * Side webview visualizing a Claude Code conversation as a graph:
 * main spine (vertical or horizontal timeline), abandoned forks
 * (collapsed by default), subagent fan-outs, plus a linear
 * scrolling transcript view. Deeplinks focus a specific message.
 */
export class ConversationPanel {
  private static current: ConversationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private graph: SessionGraph | undefined;
  private pendingFocus: ConversationFocus = null;
  private ready = false;

  static show(extensionUri: vscode.Uri, graph: SessionGraph, focus: ConversationFocus): void {
    if (ConversationPanel.current) {
      ConversationPanel.current.load(graph, focus);
      ConversationPanel.current.panel.reveal(undefined, true);
      return;
    }
    ConversationPanel.current = new ConversationPanel(extensionUri, graph, focus);
  }

  private constructor(extensionUri: vscode.Uri, graph: SessionGraph, focus: ConversationFocus) {
    this.panel = vscode.window.createWebviewPanel(
      'mdCommentsConversation',
      'Claude Conversation',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    );
    this.panel.onDidDispose(() => {
      ConversationPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        this.ready = true;
        this.push();
      } else if (msg.type === 'copyLink' && this.graph) {
        const ref = msg.agentId
          ? `${this.graph.scheme}:${this.graph.sessionId}@${msg.agentId}`
          : msg.rangeEnd && msg.uuid
            ? `${this.graph.scheme}:${this.graph.sessionId}#${msg.uuid}..${msg.rangeEnd}`
            : msg.uuid
              ? `${this.graph.scheme}:${this.graph.sessionId}#${msg.uuid}`
              : `${this.graph.scheme}:${this.graph.sessionId}`;
        await vscode.env.clipboard.writeText(ref);
        vscode.window.showInformationMessage(`Copied ${ref} — paste it into any comment.`);
      } else if (msg.type === 'openInCursor' && this.graph) {
        await vscode.commands.executeCommand('mdComments.openCursorChat', this.graph.sessionId);
      }
    });
    this.panel.webview.html = this.html(extensionUri);
    this.load(graph, focus);
  }

  private load(graph: SessionGraph, focus: ConversationFocus): void {
    this.graph = graph;
    this.pendingFocus = focus;
    this.panel.title = `✳ ${graph.title.slice(0, 40) || graph.sessionId}`;
    if (this.ready) this.push();
  }

  private push(): void {
    if (!this.graph) return;
    const cfg = vscode.workspace.getConfiguration('mdComments');
    // Only offer "open in Cursor" for a Cursor conversation viewed inside
    // Cursor — the command does not exist in other hosts, and a dead button is
    // worse than no button.
    void vscode.commands.getCommands(true).then((all) => {
      this.panel.webview.postMessage({
        type: 'load',
        graph: this.graph,
        focus: this.pendingFocus,
        orientation: cfg.get<string>('graphOrientation', 'vertical'),
        view: cfg.get<string>('conversationView', 'graph'),
        canOpenInCursor: this.graph?.scheme === 'cursor' && all.includes(CURSOR_OPEN_CHAT_COMMAND),
      });
    });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'graph.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
