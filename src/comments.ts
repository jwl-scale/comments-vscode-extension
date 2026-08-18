import * as vscode from 'vscode';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { captureAnchorV2, resolveAnchorV2 } from './anchor';
import { Actor, AnchorV2, ThreadState, liveClaim } from './threadLog';
import { baselineContent, captureBaseline, headSha } from './baseline';
import { Store } from './store';
import { renderBody } from './links';
import { formatSessionRef, parseSessionRef } from './refs';

export class MComment implements vscode.Comment {
  contextValue = 'mdComment';
  mode = vscode.CommentMode.Preview;
  body: vscode.MarkdownString;
  label?: string;

  constructor(
    public id: string,
    public raw: string,
    public author: vscode.CommentAuthorInformation,
    public timestamp: Date,
    public thread: vscode.CommentThread,
    render: (raw: string) => vscode.MarkdownString,
  ) {
    this.body = render(raw);
  }
  savedRaw = '';
}

interface ThreadMeta {
  id: string;
  status: 'open' | 'resolved';
  severity?: 'normal' | 'blocking';
  claimedBy?: string;
  hasOpenSuggestion?: boolean;
  orphanedAnchor?: AnchorV2;
  /** Set when the displayed range came from fuzzy matching — badged in the label. */
  fuzzy?: boolean;
}

/**
 * Owns the vscode CommentController and thread lifecycle. All persistence is
 * event appends to the v2 store; displayed ranges live in memory (VS Code
 * tracks them across edits) and are only written back as explicit
 * `reanchored` events with a fresh baseline (spec "Resolution algorithm").
 */
export class CommentManager implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly meta = new Map<vscode.CommentThread, ThreadMeta>();
  private readonly loadedDocs = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  /** Fires when threads for a document change (create/reply/resolve/delete). */
  readonly onDidChangeThreads = this.onDidChangeEmitter.event;

  private readonly highlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    borderStyle: 'none none dotted none',
    borderWidth: '0 0 1.5px 0',
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  /** Injected by extension.ts so bodies can show session titles. */
  sessionTitle: (sessionId: string) => string | undefined = () => undefined;

  constructor(private readonly store: Store) {
    this.controller = vscode.comments.createCommentController('mdComments', 'Comments');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        this.store.relPath(doc.uri) ? [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)] : [],
    };
    this.controller.options = {
      placeHolder: 'Comment… (file.ts:12-34 and claude:<sessionId> auto-link)',
      prompt: 'Comment',
    };

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.loadForDocument(doc)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // VS Code shifts thread ranges with the edit deltas; nothing persists
        // here — persisted positions only change via explicit reanchor events.
        if (this.loadedDocs.has(e.document.uri.toString()) && e.contentChanges.length > 0) {
          this.refreshDecorations();
        }
      }),
    );
    for (const doc of vscode.workspace.textDocuments) this.loadForDocument(doc);
  }

  private userActor(): Actor {
    return { name: this.authorName(), kind: 'human' };
  }

  /** Body markdown with file/claude/thread refs linkified. */
  private renderRaw(raw: string): vscode.MarkdownString {
    return renderBody(raw, this.sessionTitle, (id) => this.threadLabel(id));
  }

  /** Human-readable chip label for a thread: its file + first comment snippet. */
  private threadLabel(threadId: string): string | undefined {
    const t = this.store.getThread(threadId);
    if (!t) return undefined;
    const first = t.comments.find((c) => !c.deleted);
    const snippet = (first?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${t.file}${snippet ? ` · “${snippet}${(first?.body ?? '').length > 30 ? '…' : ''}”` : ''}`;
  }

  /** Open the thread's file, expand its widget, and reveal its anchor. */
  async revealThreadById(threadId: string): Promise<boolean> {
    const state = this.store.getThread(threadId);
    if (!state) return false;
    const docUri = this.store.docUri(state.file);
    if (!docUri) return false;
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    this.loadForDocument(doc);
    let widget: vscode.CommentThread | undefined;
    for (const [thread, m] of this.meta) {
      if (m.id === threadId && thread.uri.toString() === docUri.toString()) widget = thread;
    }
    const pinLine = Math.min(state.anchor.start.line, doc.lineCount - 1);
    const range = widget?.range ?? new vscode.Range(pinLine, 0, pinLine, 0);
    if (widget) widget.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    return true;
  }

  // ---------- loading ----------

  loadForDocument(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') return;
    const key = doc.uri.toString();
    if (this.loadedDocs.has(key)) return;
    const rel = this.store.relPath(doc.uri);
    if (!rel || rel.startsWith('.comments/')) return;
    this.loadedDocs.add(key);

    const root = this.store.liveRoot();
    for (const stored of this.store.threadsForFile(rel)) {
      const baseText = root ? baselineContent(root, stored.file, stored.anchor.baseline) : null;
      const resolved = resolveAnchorV2(doc, stored.anchor, baseText);
      const pinLine = Math.min(stored.anchor.start.line, doc.lineCount - 1);
      const range = resolved?.range ?? new vscode.Range(pinLine, 0, pinLine, 0);
      const thread = this.controller.createCommentThread(doc.uri, range, []);
      thread.comments = this.renderComments(stored, thread);
      this.meta.set(thread, {
        id: stored.id,
        status: stored.status,
        severity: stored.severity,
        claimedBy: liveClaim(stored)?.actor.name,
        hasOpenSuggestion: stored.suggestions.some((s) => s.status === 'open'),
        orphanedAnchor: resolved ? undefined : stored.anchor,
        fuzzy: resolved?.method === 'fuzzy',
      });
      this.applyThreadPresentation(thread, stored.anchor.text, !resolved);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

      // Lazy re-baseline: after a commit, pin deterministic resolutions to the
      // new HEAD so future loads translate from a fresh baseline. Never fuzzy,
      // and never from a buffer that doesn't byte-match the HEAD blob (VS Code
      // can hand back cached documents with stale content).
      if (
        resolved &&
        resolved.method !== 'fuzzy' &&
        root &&
        !doc.isDirty &&
        doc.getText(resolved.range) === stored.anchor.text
      ) {
        const head = headSha(root);
        if (
          head &&
          stored.anchor.baseline?.sha !== head &&
          baselineContent(root, stored.file, { kind: 'commit', sha: head }) === doc.getText()
        ) {
          const anchor = captureAnchorV2(doc, resolved.range, { kind: 'commit', sha: head });
          this.store.append(stored.id, this.userActor(), 'reanchored', { anchor, method: 'diff' });
        }
      }
    }
    this.refreshDecorations();
  }

  private renderComments(stored: ThreadState, thread: vscode.CommentThread): MComment[] {
    const comments = stored.comments
      .filter((c) => !c.deleted)
      .map((c) => {
        const mc = new MComment(c.id, c.body, { name: c.author }, new Date(c.createdAt), thread, (r) =>
          this.renderRaw(r),
        );
        // Agent replies carry their session (actor.session) — render a
        // clickable claude: chip (display only; edits keep the stored body).
        // actor.session is a scheme-qualified ref (a bare legacy value means
        // claude), so prefixing it again would produce `claude:codex:…`.
        const sessionRef = c.session ? formatSessionRef(parseSessionRef(c.session) ?? { scheme: 'claude', sessionId: c.session }) : undefined;
        if (sessionRef && !c.body.includes(sessionRef)) {
          mc.body = this.renderRaw(`${c.body}\n\n⇥ ${sessionRef}`);
        }
        if (c.edited) mc.label = 'edited';
        return mc;
      });
    // Open suggestions render as diff blocks; accept/reject live in the thread menu.
    for (const s of stored.suggestions.filter((x) => x.status === 'open')) {
      const mc = new MComment(
        s.id,
        `**Suggested change** (accept ✓ / reject ✗ in the thread toolbar):\n\n\`\`\`diff\n${s.patch}\n\`\`\``,
        { name: s.author },
        new Date(s.createdAt),
        thread,
        (raw) => {
          const md = new vscode.MarkdownString(raw);
          md.supportHtml = false;
          return md;
        },
      );
      mc.label = 'suggestion';
      comments.push(mc);
    }
    return comments;
  }

  /** Dispose all live threads for a document (e.g. before reloading from disk). */
  unloadDocument(uri: vscode.Uri): void {
    for (const [thread] of [...this.meta]) {
      if (thread.uri.toString() === uri.toString()) {
        this.meta.delete(thread);
        thread.dispose();
      }
    }
    this.loadedDocs.delete(uri.toString());
  }

  /** Reload every document that currently has threads loaded. */
  reloadAllLoaded(): void {
    for (const key of [...this.loadedDocs]) {
      this.reloadFromDisk(vscode.Uri.parse(key));
    }
  }

  /** Re-read a document's threads after an external change (git pull, MCP write…). */
  reloadFromDisk(uri: vscode.Uri): void {
    this.unloadDocument(uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) this.loadForDocument(doc);
    this.refreshDecorations();
    this.onDidChangeEmitter.fire(uri);
  }

  private applyThreadPresentation(thread: vscode.CommentThread, anchorText: string, orphaned: boolean): void {
    const m = this.meta.get(thread);
    const snippet = anchorText.replace(/\s+/g, ' ').trim().slice(0, 60);
    const badges =
      (m?.severity === 'blocking' ? '⛔ blocking · ' : '') + (m?.claimedBy ? `⏳ ${m.claimedBy} · ` : '');
    thread.label = orphaned
      ? `⚠ orphaned (was: “${snippet}”)`
      : badges +
        (m?.fuzzy ? '~ fuzzily re-anchored ' : '') +
        (snippet ? `“${snippet}${anchorText.length > 60 ? '…' : ''}”` : '');
    if (!thread.label) thread.label = undefined;
    thread.contextValue =
      (m?.status === 'resolved' ? 'mdResolved' : 'mdOpen') +
      (orphaned ? 'Orphaned' : '') +
      (m?.hasOpenSuggestion ? 'Suggestion' : '');
    thread.state =
      m?.status === 'resolved'
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
  }

  // ---------- user actions ----------

  /** "Add Comment on Selection" — opens an expanded empty thread on the selection. */
  addCommentOnSelection(editor: vscode.TextEditor): void {
    const sel = editor.selection;
    const range = sel.isEmpty ? editor.document.lineAt(sel.start.line).range : new vscode.Range(sel.start, sel.end);
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
  }

  /** The reply/Comment button (vscode.CommentReply). */
  createComment(reply: vscode.CommentReply): void {
    this.addBodyToThread(reply.thread, reply.text);
  }

  /** Programmatic creation (from the markdown preview surface). */
  addThreadWithComment(doc: vscode.TextDocument, range: vscode.Range, body: string, author?: string): void {
    this.loadForDocument(doc);
    const rel = this.store.relPath(doc.uri);
    if (!rel) return;
    const actor: Actor = { name: author ?? this.authorName(), kind: 'human' };
    const anchor = this.captureFor(doc, range);
    const id = this.store.createThread(rel, anchor, body, actor);
    if (!id) return;
    const thread = this.controller.createCommentThread(doc.uri, range, []);
    this.meta.set(thread, { id, status: 'open' });
    thread.comments = [
      new MComment(id, body, { name: actor.name }, new Date(), thread, (raw) => this.renderRaw(raw)),
    ];
    this.applyThreadPresentation(thread, doc.getText(range), false);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.changed(doc.uri);
  }

  replyToThreadById(uri: vscode.Uri, threadId: string, body: string): void {
    const thread = this.findThread(uri, threadId);
    if (thread) this.addBodyToThread(thread, body);
  }

  setThreadStatusById(uri: vscode.Uri, threadId: string, status: 'open' | 'resolved'): void {
    const thread = this.findThread(uri, threadId);
    if (thread) this.setStatus(thread, status);
  }

  setStatus(thread: vscode.CommentThread, status: 'open' | 'resolved'): void {
    const m = this.meta.get(thread);
    if (!m || m.status === status) return;
    m.status = status;
    if (status === 'resolved') {
      this.store.append(m.id, this.userActor(), 'resolved', { reason: 'fixed' });
    } else {
      this.store.append(m.id, this.userActor(), 'reopened', {});
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    this.applyThreadPresentation(thread, doc ? doc.getText(thread.range) : '', !!m.orphanedAnchor);
    this.changed(thread.uri);
  }

  /** Explicit destructive delete (confirmed in extension.ts). */
  deleteThread(thread: vscode.CommentThread): void {
    const uri = thread.uri;
    const m = this.meta.get(thread);
    if (m) this.store.deleteThreadFile(m.id);
    this.meta.delete(thread);
    thread.dispose();
    this.changed(uri);
  }

  deleteComment(comment: MComment): void {
    const thread = comment.thread;
    const m = this.meta.get(thread);
    thread.comments = thread.comments.filter((c) => (c as MComment).id !== comment.id);
    if (thread.comments.length === 0) {
      this.deleteThread(thread);
      return;
    }
    if (m) this.store.append(m.id, this.userActor(), 'comment_deleted', { commentId: comment.id });
    this.changed(thread.uri);
  }

  editComment(comment: MComment): void {
    comment.savedRaw = comment.raw;
    comment.body = new vscode.MarkdownString(comment.raw);
    comment.mode = vscode.CommentMode.Editing;
    comment.thread.comments = [...comment.thread.comments];
  }

  saveComment(comment: MComment): void {
    // In edit mode VS Code writes the edited text into comment.body.
    const edited = typeof comment.body === 'string' ? comment.body : (comment.body as vscode.MarkdownString).value;
    if (edited !== comment.savedRaw) {
      const m = this.meta.get(comment.thread);
      if (m) this.store.append(m.id, this.userActor(), 'edited', { commentId: comment.id, body: edited });
      comment.label = 'edited';
    }
    comment.raw = edited;
    comment.body = this.renderRaw(comment.raw);
    comment.mode = vscode.CommentMode.Preview;
    comment.thread.comments = [...comment.thread.comments];
    this.changed(comment.thread.uri);
  }

  cancelEditComment(comment: MComment): void {
    comment.raw = comment.savedRaw || comment.raw;
    comment.body = this.renderRaw(comment.raw);
    comment.mode = vscode.CommentMode.Preview;
    comment.thread.comments = [...comment.thread.comments];
  }

  /** Re-anchor an orphaned thread to the current editor selection. */
  reattachThread(thread: vscode.CommentThread): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== thread.uri.toString()) {
      vscode.window.showWarningMessage(
        'Comments: select the new anchor text in the commented file first.',
      );
      return;
    }
    const m = this.meta.get(thread);
    if (!m) return;
    const sel = editor.selection;
    const range = sel.isEmpty
      ? editor.document.lineAt(sel.start.line).range
      : new vscode.Range(sel.start, sel.end);
    thread.range = range;
    m.orphanedAnchor = undefined;
    m.fuzzy = false;
    const anchor = this.captureFor(editor.document, range);
    this.store.append(m.id, this.userActor(), 'reanchored', { anchor, method: 'manual' });
    this.applyThreadPresentation(thread, editor.document.getText(range), false);
    this.changed(thread.uri);
  }

  /** Expand or collapse every thread widget in a document. */
  setAllExpanded(uri: vscode.Uri, expanded: boolean): void {
    for (const [thread] of this.meta) {
      if (thread.uri.toString() !== uri.toString()) continue;
      thread.collapsibleState = expanded
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  /** Toggle the thread(s) whose range touches the cursor (or selection). */
  toggleAtCursor(editor: vscode.TextEditor): void {
    const sel = editor.selection;
    let hit = false;
    for (const [thread] of this.meta) {
      if (thread.uri.toString() !== editor.document.uri.toString() || !thread.range) continue;
      const touches =
        thread.range.intersection(new vscode.Range(sel.start, sel.end)) !== undefined ||
        (sel.start.line >= thread.range.start.line && sel.start.line <= thread.range.end.line);
      if (!touches) continue;
      hit = true;
      thread.collapsibleState =
        thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
    }
    if (!hit) {
      vscode.window.setStatusBarMessage('No comment thread at cursor', 2000);
    }
  }

  appendCommentToThread(thread: vscode.CommentThread, body: string): void {
    this.addBodyToThread(thread, body);
  }

  /** Reply to a registered thread, or turn a fresh widget into a real thread. */
  private addBodyToThread(thread: vscode.CommentThread, body: string): void {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    let m = this.meta.get(thread);
    let commentId: string;
    if (!m) {
      const rel = this.store.relPath(thread.uri);
      if (!rel || !doc || !thread.range) return;
      const anchor = this.captureFor(doc, thread.range);
      const id = this.store.createThread(rel, anchor, body, this.userActor());
      if (!id) return;
      m = { id, status: 'open' };
      this.meta.set(thread, m);
      commentId = this.store.getThread(id)?.comments[0]?.id ?? id;
      this.applyThreadPresentation(thread, doc.getText(thread.range), false);
    } else {
      commentId = `c_${randomUUID()}`;
      this.store.append(m.id, this.userActor(), 'replied', { commentId, body });
    }
    const comment = new MComment(
      commentId, body, { name: this.authorName() }, new Date(), thread,
      (raw) => this.renderRaw(raw),
    );
    thread.comments = [...thread.comments, comment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.changed(thread.uri);
  }

  /** Capture an anchor with a baseline for the document's current buffer. */
  private captureFor(doc: vscode.TextDocument, range: vscode.Range): AnchorV2 {
    const root = this.store.liveRoot();
    const rel = this.store.relPath(doc.uri);
    const baseline = root && rel ? captureBaseline(root, rel, doc.getText()) : null;
    return captureAnchorV2(doc, range, baseline);
  }

  private changed(uri: vscode.Uri): void {
    this.refreshDecorations();
    this.onDidChangeEmitter.fire(uri);
  }

  // ---------- queries ----------

  threadsForDocument(uri: vscode.Uri): Array<{
    id: string;
    status: 'open' | 'resolved';
    range: vscode.Range;
    anchorText: string;
    comments: Array<{ author: string; body: string; createdAt: string }>;
  }> {
    const out: ReturnType<CommentManager['threadsForDocument']> = [];
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    for (const [thread, m] of this.meta) {
      if (thread.uri.toString() !== uri.toString() || thread.comments.length === 0) continue;
      const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
      out.push({
        id: m.id,
        status: m.status,
        range,
        anchorText: doc ? doc.getText(range) : '',
        comments: thread.comments.map((c) => {
          const mc = c as MComment;
          return {
            author: mc.author.name,
            body: mc.raw,
            createdAt: mc.timestamp?.toISOString() ?? '',
          };
        }),
      });
    }
    return out;
  }

  /** Persisted thread id for a live widget (undefined for unsubmitted widgets). */
  idFor(thread: vscode.CommentThread): string | undefined {
    return this.meta.get(thread)?.id;
  }

  private findThread(uri: vscode.Uri, threadId: string): vscode.CommentThread | undefined {
    for (const [thread, m] of this.meta) {
      if (m.id === threadId && thread.uri.toString() === uri.toString()) return thread;
    }
    return undefined;
  }

  // ---------- decorations ----------

  refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges: vscode.DecorationOptions[] = [];
      for (const [thread, m] of this.meta) {
        if (thread.uri.toString() !== editor.document.uri.toString()) continue;
        if (thread.comments.length === 0 || m.status === 'resolved' || !thread.range) continue;
        ranges.push({
          range: thread.range,
          hoverMessage: new vscode.MarkdownString(
            `💬 ${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'}`,
          ),
        });
      }
      editor.setDecorations(this.highlightDecoration, ranges);
    }
  }

  private authorName(): string {
    const configured = vscode.workspace.getConfiguration('mdComments').get<string>('authorName');
    if (configured) return configured;
    try {
      return os.userInfo().username;
    } catch {
      return 'user';
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.highlightDecoration.dispose();
    this.controller.dispose();
  }
}
