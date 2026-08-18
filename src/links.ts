import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AGENT_REF, AgentScheme, ConversationFocus, FILE_REF, THREAD_REF, focusFromMatch } from './refs';

export { ConversationFocus } from './refs';

/**
 * Rich rendering of comment bodies:
 *  - `src/foo.ts:12` / `foo.ts:12-34` → command link that opens the file at that range
 *  - `claude:<sessionId>` / `codex:<sessionId>#<msgUuid>` → chip opening the conversation graph
 *  - `thread:<threadId>[#<commentId>]` → chip revealing another comment thread
 */

export function renderBody(
  raw: string,
  sessionTitle: (sessionId: string) => string | undefined,
  threadLabel?: (threadId: string) => string | undefined,
): vscode.MarkdownString {
  let text = escapeExisting(raw);

  text = text.replace(THREAD_REF, (_m, threadId: string, commentId?: string) => {
    const args = encodeURIComponent(JSON.stringify([threadId, commentId ?? null]));
    const name = threadLabel?.(threadId);
    const label = `💬 ${name ?? threadId.slice(0, 11)}${commentId ? ` · comment ${commentId.slice(2, 8)}` : ''}`;
    return `[**${label.replace(/([[\]])/g, '\\$1')}**](command:mdComments.openThread?${args} "Open comment thread")`;
  });

  text = text.replace(
    AGENT_REF,
    (_m, scheme: string, sessionId: string, msgUuid?: string, rangeEnd?: string, agentId?: string) => {
      const focus: ConversationFocus = focusFromMatch(msgUuid, rangeEnd, agentId);
      const args = encodeURIComponent(JSON.stringify([sessionId, focus, scheme]));
      const title = sessionTitle(sessionId);
      const suffix = title ? ` · ${title}` : '';
      const mark = scheme === 'codex' ? '◈' : '✳';
      const label = agentId
        ? `${mark} agent ${agentId.slice(0, 8)}${suffix}`
        : msgUuid && rangeEnd
          ? `${mark} msgs #${msgUuid.slice(0, 8)}..${rangeEnd.slice(0, 8)}${suffix}`
          : msgUuid
            ? `${mark} msg #${msgUuid.slice(0, 8)}${suffix}`
            : `${mark} ${title ?? sessionId}`;
      const provider = scheme === 'codex' ? 'Codex' : 'Claude';
      return `[**${label.replace(/([[\]])/g, '\\$1')}**](command:mdComments.openConversation?${args} "Open ${provider} conversation")`;
    },
  );

  text = text.replace(FILE_REF, (_m, file: string, start: string, end?: string) => {
    const args = encodeURIComponent(JSON.stringify([file, Number(start), end ? Number(end) : null]));
    const label = `${file}:${start}${end ? `-${end}` : ''}`;
    return `[\`${label}\`](command:mdComments.openFileLink?${args} "Go to ${label}")`;
  });

  const md = new vscode.MarkdownString(text);
  md.isTrusted = {
    enabledCommands: ['mdComments.openFileLink', 'mdComments.openConversation', 'mdComments.openThread'],
  };
  return md;
}

/** Leave user markdown intact but avoid double-linking refs already inside links/code spans. */
function escapeExisting(raw: string): string {
  return raw;
}

/** Copy a `path/to/file.ts:12-34` ref for the active selection to the clipboard. */
export async function copySelectionRef(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
  const sel = editor.selection;
  const start = sel.start.line + 1;
  const end = sel.end.line + 1;
  const ref = end > start ? `${rel}:${start}-${end}` : `${rel}:${start}`;
  await vscode.env.clipboard.writeText(ref);
  vscode.window.setStatusBarMessage(`Copied ${ref}`, 3000);
}

export async function openFileLink(file: string, start: number, end: number | null): Promise<void> {
  const target = await resolveWorkspaceFile(file);
  if (!target) {
    vscode.window.showWarningMessage(`Comments: could not find "${file}" in the workspace.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(doc, { preview: true });
  const startLine = Math.min(Math.max(start - 1, 0), doc.lineCount - 1);
  const endLine = Math.min(Math.max((end ?? start) - 1, startLine), doc.lineCount - 1);
  const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function resolveWorkspaceFile(file: string): Promise<vscode.Uri | undefined> {
  if (path.isAbsolute(file)) {
    return fs.existsSync(file) ? vscode.Uri.file(file) : undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, file);
    if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
  }
  // Fall back to a filename search anywhere in the workspace.
  const base = path.posix.basename(file);
  const hits = await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 5);
  const suffixHit = hits.find((h) => h.path.endsWith('/' + file));
  return suffixHit ?? hits[0];
}
