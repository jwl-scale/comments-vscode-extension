import * as vscode from 'vscode';
import { blameLine } from './lineHistory';
import { Store } from './store';

/**
 * Phase 4 blame chips: hovering a line whose last-touch commit carries
 * Comments trailers shows the reasoning behind it — provenance badge,
 * thread links, session link, brief link. Lines with no recorded reasoning
 * produce no hover (zero noise).
 */
export class BlameReasoningHoverProvider implements vscode.HoverProvider {
  private readonly cache = new Map<string, vscode.Hover | null>();

  constructor(private readonly store: Store) {}

  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    if (doc.uri.scheme !== 'file' || doc.isDirty) return null;
    const rel = this.store.relPath(doc.uri);
    const root = this.store.liveRoot();
    if (!rel || !root || rel.startsWith('.comments/')) return null;

    const key = `${doc.uri.toString()}:${position.line}:${doc.version}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (this.cache.size > 2000) this.cache.clear();

    const blame = blameLine(root, rel, position.line + 1);
    const t = blame?.trailers;
    const hasReasoning = !!t && (t.threads.length > 0 || t.resolves.length > 0 || !!t.session || !!t.provenance);
    let hover: vscode.Hover | null = null;
    if (blame && hasReasoning) {
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['mdComments.openConversation', 'mdComments.openThread', 'mdComments.lineHistory'] };
      const prov = t!.provenance ? ` · \`Provenance: ${t!.provenance}\`` : '';
      md.appendMarkdown(`$(git-commit) **${blame.subject}** — \`${blame.sha.slice(0, 8)}\`${prov}\n\n`);
      for (const id of [...t!.resolves, ...t!.threads]) {
        const state = this.store.getThread(id);
        const label = state
          ? `${state.file} · “${state.comments[0]?.body.slice(0, 50) ?? ''}”`
          : `${id.slice(0, 14)} (in history)`;
        md.appendMarkdown(
          `$(comment-discussion) [${label.replace(/([[\]])/g, '\\$1')}](command:mdComments.openThread?${encodeURIComponent(JSON.stringify([id, null]))})\n\n`,
        );
      }
      if (t!.session) {
        const [sid] = t!.session.split('#');
        const focus = t!.session.includes('#')
          ? (() => {
              const seg = t!.session.split('#')[1];
              const [from, to] = seg.split('..');
              return to ? { kind: 'range', from, to } : { kind: 'msg', uuid: from };
            })()
          : null;
        md.appendMarkdown(
          `✳ [conversation ${sid.slice(0, 8)}${t!.session.includes('#') ? ' (segment)' : ''}](command:mdComments.openConversation?${encodeURIComponent(JSON.stringify([sid, focus]))})\n\n`,
        );
      }
      md.appendMarkdown(`$(history) [line history…](command:mdComments.lineHistory)`);
      hover = new vscode.Hover(md);
    }
    this.cache.set(key, hover);
    return hover;
  }
}
