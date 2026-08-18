import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { CommentManager } from './comments';

/**
 * Commentable rendered-Markdown preview. We render with markdown-it and stamp
 * every block element with data-line/data-line-end (source line mapping), so
 * selections in the rendered view map back to source ranges and share the
 * exact same anchored threads as the text editor.
 */
export class MarkdownPreviewPanel {
  private static panels = new Map<string, MarkdownPreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;

  static show(extensionUri: vscode.Uri, doc: vscode.TextDocument, comments: CommentManager): void {
    const key = doc.uri.toString();
    const existing = MarkdownPreviewPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(undefined, true);
      existing.update();
      return;
    }
    MarkdownPreviewPanel.panels.set(key, new MarkdownPreviewPanel(extensionUri, doc, comments));
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly doc: vscode.TextDocument,
    private readonly comments: CommentManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mdCommentsPreview',
      `Preview: ${doc.uri.path.split('/').pop()}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    );
    this.panel.onDidDispose(() => {
      MarkdownPreviewPanel.panels.delete(this.doc.uri.toString());
      for (const d of this.disposables) d.dispose();
      clearTimeout(this.renderTimer);
    });

    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.doc.uri.toString()) this.scheduleUpdate();
      }),
      this.comments.onDidChangeThreads((uri) => {
        if (uri.toString() === this.doc.uri.toString()) this.scheduleUpdate();
      }),
    );

    this.panel.webview.html = this.html(extensionUri);
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case 'ready':
        this.update();
        break;
      case 'addComment': {
        const range = this.mapToSourceRange(msg.startLine, msg.endLine, msg.selectedText);
        this.comments.addThreadWithComment(this.doc, range, msg.body);
        break;
      }
      case 'reply':
        this.comments.replyToThreadById(this.doc.uri, msg.threadId, msg.body);
        break;
      case 'resolve':
        this.comments.setThreadStatusById(this.doc.uri, msg.threadId, 'resolved');
        break;
      case 'openRef': {
        const ref: string = msg.ref || '';
        const claude = ref.match(/^claude:([A-Za-z0-9\-_]+)(?:#([A-Za-z0-9\-_]+)(?:\.\.([A-Za-z0-9\-_]+))?|@([A-Za-z0-9\-_]+))?$/);
        if (claude) {
          const focus = claude[4]
            ? { kind: 'agent', agentId: claude[4] }
            : claude[2] && claude[3]
              ? { kind: 'range', from: claude[2], to: claude[3] }
              : claude[2]
                ? { kind: 'msg', uuid: claude[2] }
                : null;
          vscode.commands.executeCommand('mdComments.openConversation', claude[1], focus);
        } else if (/^thread:th_/.test(ref)) {
          const t = ref.match(/^thread:(th_[A-Za-z0-9-]+)(?:#(c_[A-Za-z0-9-]+))?$/);
          if (t) vscode.commands.executeCommand('mdComments.openThread', t[1], t[2] ?? null);
        } else {
          const file = ref.match(/^(.*):(\d+)(?:-(\d+))?$/);
          if (file) {
            vscode.commands.executeCommand(
              'mdComments.openFileLink',
              file[1],
              Number(file[2]),
              file[3] ? Number(file[3]) : null,
            );
          }
        }
        break;
      }
      case 'openInEditor': {
        vscode.window
          .showTextDocument(this.doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
          .then((editor) => {
            const line = Math.min(msg.line ?? 0, this.doc.lineCount - 1);
            const r = this.doc.lineAt(line).range;
            editor.selection = new vscode.Selection(r.start, r.end);
            editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
          });
        break;
      }
    }
  }

  /**
   * Best-effort: locate the rendered selection's text within the source block
   * lines. Rendered text loses markdown syntax, so fall back to whole lines
   * when the literal text isn't found.
   */
  private mapToSourceRange(startLine: number, endLine: number, selectedText: string): vscode.Range {
    const s = Math.min(Math.max(startLine, 0), this.doc.lineCount - 1);
    const e = Math.min(Math.max(endLine, s), this.doc.lineCount - 1);
    const sliceStart = new vscode.Position(s, 0);
    const sliceEnd = this.doc.lineAt(e).range.end;
    const slice = this.doc.getText(new vscode.Range(sliceStart, sliceEnd));
    const needle = (selectedText || '').trim();
    if (needle) {
      const idx = slice.indexOf(needle);
      if (idx !== -1) {
        const startOff = this.doc.offsetAt(sliceStart) + idx;
        return new vscode.Range(this.doc.positionAt(startOff), this.doc.positionAt(startOff + needle.length));
      }
    }
    return new vscode.Range(sliceStart, sliceEnd);
  }

  private scheduleUpdate(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.update(), 250);
  }

  private update(): void {
    const md = new MarkdownIt({ html: false, linkify: true });
    md.core.ruler.push('source_lines', (state) => {
      for (const token of state.tokens) {
        if (token.map && (token.type.endsWith('_open') || ['fence', 'code_block', 'html_block', 'hr'].includes(token.type))) {
          token.attrSet('data-line', String(token.map[0]));
          token.attrSet('data-line-end', String(token.map[1]));
        }
      }
    });
    const html = md.render(this.doc.getText());
    const threads = this.comments.threadsForDocument(this.doc.uri).map((t) => ({
      id: t.id,
      status: t.status,
      startLine: t.range.start.line,
      endLine: t.range.end.line,
      anchorText: t.anchorText,
      comments: t.comments,
    }));
    this.panel.webview.postMessage({ type: 'render', html, threads });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'));
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="content"></div>
<div id="overlay"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
