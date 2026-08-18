import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CommentManager, MComment } from './comments';
import { ConversationPanel } from './graphPanel';
import { MarkdownPreviewPanel } from './previewPanel';
import { ConversationFocus, copySelectionRef, openFileLink } from './links';
import { Store } from './store';
import { collectThreadSessions } from './threadSessions';
import { lastSessionId } from './agentArgs';
import { agentCommand, agentProvider, configureRun, defaultRunOptions } from './agentConfig';
import { findAgentDefinitions, runAgentOnThread } from './agentRun';
import { applyPatch } from './baseline';
import { runMcpDoctor } from './mcpDoctor';
import { CommentsDecorationProvider, CommentsTreeProvider } from './treeView';
import { AgentSessionsProvider } from './runsView';
import { BlameReasoningHoverProvider } from './blameHover';
import { lineHistory, readBrief } from './lineHistory';
import {
  findLocalSessions,
  findReplySegment,
  loadSessionGraph,
  vendorSession,
  vendoredSessionPath,
} from './sessions';
import { cursorChatNames, resolveCursorRequestId } from './sessionProviders';

/** Returned from activate() for extension-host integration tests. */
export interface MdCommentsApi {
  store: Store;
  comments: CommentManager;
}

export function activate(context: vscode.ExtensionContext): MdCommentsApi {
  const store = new Store();
  const comments = new CommentManager(store);

  // Session titles for chip rendering: read lazily from vendored sessions.
  const titleCache = new Map<string, string>();
  comments.sessionTitle = (sessionId: string) => {
    if (titleCache.has(sessionId)) return titleCache.get(sessionId);
    const dir = store.defaultSessionsDir();
    if (!dir) return undefined;
    const graph = fs.existsSync(vendoredSessionPath(dir, sessionId))
      ? loadSessionGraph(dir, sessionId)
      : undefined;
    const title = graph?.title;
    if (title) titleCache.set(sessionId, title);
    return title;
  };

  // ---- discovery: tree view + explorer badges ----
  const tree = new CommentsTreeProvider(store);
  const decorations = new CommentsDecorationProvider(store);
  const agentSessions = new AgentSessionsProvider(store);
  context.subscriptions.push(
    vscode.window.createTreeView('mdCommentsThreads', { treeDataProvider: tree }),
    vscode.window.createTreeView('mdCommentsAgentSessions', { treeDataProvider: agentSessions }),
    agentSessions,
    vscode.window.registerFileDecorationProvider(decorations),
    comments.onDidChangeThreads(() => {
      tree.refresh();
      decorations.rebuild();
    }),
  );

  const userActor = () => {
    const configured = vscode.workspace.getConfiguration('mdComments').get<string>('authorName');
    let name = configured;
    if (!name) {
      try {
        name = os.userInfo().username;
      } catch {
        name = 'user';
      }
    }
    return { name, kind: 'human' as const };
  };

  // ---- external thread-log changes (git pull, MCP server, worktree agents) ----
  const watcher = vscode.workspace.createFileSystemWatcher('**/.comments/threads/*.jsonl');
  const onThreadLogChange = (uri: vscode.Uri) => {
    if (uri.fsPath.endsWith('.lock') || store.wasSelfWrite(uri.fsPath)) return;
    const threadId = path.basename(uri.fsPath, '.jsonl');
    const file = store.getThread(threadId)?.file;
    const docUri = file ? store.docUri(file) : undefined;
    if (docUri) comments.reloadFromDisk(docUri);
    else comments.reloadAllLoaded();
    tree.refresh();
    decorations.rebuild();
  };
  watcher.onDidChange(onThreadLogChange);
  watcher.onDidCreate(onThreadLogChange);
  watcher.onDidDelete(onThreadLogChange);
  context.subscriptions.push(watcher);

  // ---- record renames/deletes on affected threads (events, not file moves) ----
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) {
        comments.unloadDocument(oldUri);
        const oldRel = store.relPath(oldUri);
        const newRel = store.relPath(newUri);
        if (oldRel && newRel) store.renameFile(oldRel, newRel, userActor());
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === newUri.toString(),
        );
        if (doc) comments.loadForDocument(doc);
      }
      tree.refresh();
      decorations.rebuild();
    }),
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) {
        comments.unloadDocument(uri);
        const rel = store.relPath(uri);
        if (rel) store.markFileDeleted(rel, userActor());
      }
      tree.refresh();
      decorations.rebuild();
    }),
  );

  // ---- v1 → v2 sidecar migration ----
  const migrate = () => {
    const n = store.migrateV1();
    comments.reloadAllLoaded();
    tree.refresh();
    decorations.rebuild();
    vscode.window.showInformationMessage(
      n > 0 ? `Comments: migrated ${n} thread${n === 1 ? '' : 's'} to the v2 event-log format.`
            : 'Comments: no v1 sidecars found.',
    );
  };
  if (store.hasV1Sidecars()) {
    vscode.window
      .showInformationMessage(
        'Comments: this repo has v1 comment sidecars. Migrate them to the v2 event-log format?',
        'Migrate',
      )
      .then((choice) => {
        if (choice === 'Migrate') migrate();
      });
  }

  const cmd = (name: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, fn));

  // v0.11 command ids, kept registered so user keybindings survive the rename
  // to provider-neutral names. Not contributed in package.json — invisible in
  // the palette, but still dispatchable.
  const LEGACY_COMMAND_IDS: Record<string, string> = {
    'mdComments.assignToClaude': 'mdComments.assignToAgent',
    'mdComments.configureAssignToClaude': 'mdComments.configureAssignToAgent',
    'mdComments.askClaudeFollowUp': 'mdComments.askAgentFollowUp',
    'mdComments.attachClaudeSession': 'mdComments.attachAgentSession',
  };
  for (const [legacy, current] of Object.entries(LEGACY_COMMAND_IDS)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(legacy, (...args: any[]) =>
        vscode.commands.executeCommand(current, ...args),
      ),
    );
  }

  // ---- comment lifecycle ----
  cmd('mdComments.addComment', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) comments.addCommentOnSelection(editor);
  });
  cmd('mdComments.createComment', (reply: vscode.CommentReply) => comments.createComment(reply));
  cmd('mdComments.resolveThread', (thread: vscode.CommentThread) => comments.setStatus(thread, 'resolved'));
  cmd('mdComments.unresolveThread', (thread: vscode.CommentThread) => comments.setStatus(thread, 'open'));
  cmd('mdComments.deleteThread', async (thread: vscode.CommentThread) => {
    const n = thread.comments.length;
    const choice = await vscode.window.showWarningMessage(
      `Delete this thread${n > 1 ? ` and its ${n} comments` : ''}? This cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (choice === 'Delete') comments.deleteThread(thread);
  });
  cmd('mdComments.deleteComment', (comment: MComment) => comments.deleteComment(comment));
  cmd('mdComments.editComment', (comment: MComment) => comments.editComment(comment));
  cmd('mdComments.saveComment', (comment: MComment) => comments.saveComment(comment));
  cmd('mdComments.cancelEditComment', (comment: MComment) => comments.cancelEditComment(comment));
  cmd('mdComments.reattachThread', (thread: vscode.CommentThread) => comments.reattachThread(thread));
  cmd('mdComments.expandAllComments', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) comments.setAllExpanded(editor.document.uri, true);
  });
  cmd('mdComments.collapseAllComments', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) comments.setAllExpanded(editor.document.uri, false);
  });
  cmd('mdComments.toggleThreadAtCursor', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) comments.toggleAtCursor(editor);
  });
  cmd('mdComments.migrateSidecars', migrate);

  // ---- agent loop: assign a thread to Claude ----
  // Thread commands accept the widget (from the comment UI) or {threadId}
  // (programmatic callers: tests, tree view, other extensions).
  type ThreadArg = vscode.CommentThread | { threadId: string } | undefined;
  const threadIdOf = (arg: ThreadArg): string | undefined =>
    arg && ('threadId' in arg ? arg.threadId : comments.idFor(arg));
  const agentOutput = vscode.window.createOutputChannel('Comments Agent');
  cmd('mdComments.assignToAgent', async (thread?: ThreadArg & { options?: object }) => {
    const id = threadIdOf(thread);
    if (!id) {
      vscode.window.showWarningMessage('Comments: submit the comment first, then assign the thread.');
      return;
    }
    const state = store.getThread(id);
    if (!state) return;
    // Programmatic callers may pass options; otherwise use the workspace's
    // remembered ⚙ configuration on top of mdComments.agent.* settings.
    const options =
      (thread && 'options' in thread! && (thread as { options?: object }).options) ||
      defaultRunOptions(context);
    const server = path.join(context.extensionPath, 'bin', 'mcp-comments.js');
    agentOutput.show(true);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Comments: agent working on ${state.file}…`,
        cancellable: true,
      },
      (progress, token) =>
        runAgentOnThread(store, state, server, token, (line) => {
          agentOutput.appendLine(line);
          progress.report({ message: line });
        }, options),
    );
    if (!result.ok && result.error !== 'cancelled') {
      vscode.window.showErrorMessage(`Comments: agent run failed — ${result.error}`);
    }
    return result;
  });

  // 💬 one-gesture follow-up: type the message, choose session handling, dispatch.
  cmd('mdComments.askAgentFollowUp', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    if (!id) return;
    const state = store.getThread(id);
    if (!state) return;
    const body = await vscode.window.showInputBox({
      prompt: 'Follow-up for the agent — posted as your reply, then dispatched',
      placeHolder: 'e.g. what about the error path? / @security-reviewer take a second look',
    });
    if (!body) return;

    let sessionMode: 'auto' | 'fresh' | 'continue' | 'fork' = 'auto';
    const priorSession = lastSessionId(state.events);
    if (priorSession) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `$(history) Continue session ${priorSession.slice(0, 8)}`,
            description: 'same conversation, full memory of earlier turns',
            mode: 'continue' as const,
          },
          {
            label: '$(git-branch) Fork the session',
            description: 'inherit its context, but branch off — the original stays untouched',
            mode: 'fork' as const,
          },
          {
            label: '$(sparkle) Fresh session',
            description: 'clean start (mentions in your reply still steer it)',
            mode: 'fresh' as const,
          },
        ],
        { placeHolder: 'This thread already has an agent session — how should the follow-up run?' },
      );
      if (!choice) return;
      sessionMode = choice.mode;
    }

    store.append(id, userActor(), 'replied', { commentId: `c_${randomUUID()}`, body });
    comments.reloadAllLoaded();
    const options = { ...defaultRunOptions(context), sessionMode };
    return vscode.commands.executeCommand('mdComments.assignToAgent', { threadId: id, options });
  });

  // 🗂 all Claude sessions related to a thread, grouped by relationship.
  cmd('mdComments.showThreadSessions', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    const state = id ? store.getThread(id) : undefined;
    if (!state) return;
    const sessions = collectThreadSessions(state);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(
        'Comments: no Claude sessions on this thread yet — assign it to Claude or attach a session.',
      );
      return;
    }
    const dir = store.sessionsDir();
    const snippet = (s: string, n = 60) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const copyButton = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy session ref' };
    type Item = vscode.QuickPickItem & { open?: { sessionId: string; focus: unknown }; ref?: string };
    const items: Item[] = [];
    for (const s of sessions) {
      const title = dir ? loadSessionGraph(dir, s.sessionId)?.title : undefined;
      const roles = [
        s.isCurrent ? '▶ continues on assign' : '',
        s.comments.length ? `${s.comments.length} comment${s.comments.length === 1 ? '' : 's'}` : '',
        s.refs.length ? 'referenced' : '',
      ].filter(Boolean).join(' · ');
      items.push({ label: roles, kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: `$(${s.isCurrent ? 'play-circle' : 'comment-discussion'}) ${title ?? s.sessionId}`,
        detail: `${s.scheme}:${s.sessionId}`,
        ref: `${s.scheme}:${s.sessionId}`,
        buttons: [copyButton],
        open: { sessionId: s.sessionId, focus: null },
      });
      for (const c of s.comments) {
        // The transcript records the MCP call that wrote each comment — link
        // the exact SEGMENT of the session behind this reply (from..to).
        const segment = dir ? findReplySegment(dir, s.sessionId, c.body) : undefined;
        const ref = segment
          ? segment.from === segment.to
            ? `${s.scheme}:${s.sessionId}#${segment.to}`
            : `${s.scheme}:${s.sessionId}#${segment.from}..${segment.to}`
          : `${s.scheme}:${s.sessionId}`;
        const focus = segment
          ? segment.from === segment.to
            ? { kind: 'msg', uuid: segment.to }
            : { kind: 'range', from: segment.from, to: segment.to }
          : null;
        items.push({
          label: `    $(arrow-small-right) “${snippet(c.body)}”`,
          description: `${c.author} · ${new Date(c.createdAt).toLocaleString()}${segment ? '' : ' · (whole session)'}`,
          detail: `    ${ref}`,
          ref,
          buttons: [copyButton],
          open: { sessionId: s.sessionId, focus },
        });
      }
      for (const r of s.refs) {
        items.push({
          label: `    $(link) ${r.raw}`,
          description: 'reference in a comment body',
          ref: r.raw,
          buttons: [copyButton],
          open: { sessionId: s.sessionId, focus: r.focus },
        });
      }
    }

    const picker = vscode.window.createQuickPick<Item>();
    picker.items = items;
    picker.placeholder = 'Agent sessions on this thread — Enter opens, $(copy) copies the ref';
    picker.matchOnDetail = true;
    picker.onDidTriggerItemButton(async (e) => {
      if (e.item.ref) {
        await vscode.env.clipboard.writeText(e.item.ref);
        vscode.window.setStatusBarMessage(`Copied ${e.item.ref}`, 2500);
      }
    });
    picker.onDidAccept(async () => {
      const pick = picker.selectedItems[0];
      picker.hide();
      if (pick?.open) {
        await vscode.commands.executeCommand('mdComments.openConversation', pick.open.sessionId, pick.open.focus);
      }
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
  });

  // ---- Phase 4: blame chips + line history ----
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new BlameReasoningHoverProvider(store)),
  );
  cmd('mdComments.lineHistory', async () => {
    const editor = vscode.window.activeTextEditor;
    const root = store.liveRoot();
    const rel = editor && store.relPath(editor.document.uri);
    if (!editor || !root || !rel) return;
    const start = editor.selection.start.line + 1;
    const end = Math.max(editor.selection.end.line + 1, start);
    const entries = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Comments: walking line ancestry…' },
      async () => lineHistory(root, rel, start, end),
    );
    if (entries.length === 0) {
      vscode.window.showInformationMessage('Comments: no committed history for these lines yet.');
      return;
    }
    type Item = vscode.QuickPickItem & { entry: (typeof entries)[0] };
    const pick = await vscode.window.showQuickPick<Item>(
      entries.map((entry) => ({
        label: `$(git-commit) ${entry.sha.slice(0, 8)}  ${entry.subject}`,
        description: `${entry.author} · ${entry.date.slice(0, 10)}${entry.trailers.provenance ? ` · ${entry.trailers.provenance}` : ''}`,
        detail:
          [
            entry.trailers.resolves.length ? `resolves ${entry.trailers.resolves.length} thread(s)` : '',
            entry.threadsAtCommit.length
              ? `threads on file then: ${entry.threadsAtCommit.map((x) => `L${x.startLine} “${x.firstComment.slice(0, 30)}”`).join(' · ')}`
              : '',
            entry.briefPath ? 'has landing brief' : '',
          ].filter(Boolean).join('  |  ') || undefined,
        entry,
      })),
      { placeHolder: `Every commit that touched ${rel}:${start}${end > start ? `-${end}` : ''} — newest first`, matchOnDetail: true },
    );
    if (!pick) return;
    const e = pick.entry;
    const actions: Array<vscode.QuickPickItem & { run: () => void }> = [];
    if (e.trailers.session) {
      const [sid, seg] = e.trailers.session.split('#');
      const focus = seg ? (seg.includes('..') ? { kind: 'range', from: seg.split('..')[0], to: seg.split('..')[1] } : { kind: 'msg', uuid: seg }) : null;
      actions.push({
        label: '$(comment-discussion) Open the conversation behind this commit',
        run: () => vscode.commands.executeCommand('mdComments.openConversation', sid, focus),
      });
    }
    for (const id of [...e.trailers.resolves, ...e.trailers.threads]) {
      actions.push({
        label: `$(comments-view-icon) Open thread ${id.slice(0, 14)}…`,
        run: () => vscode.commands.executeCommand('mdComments.openThread', id, null),
      });
    }
    if (e.briefPath) {
      actions.push({
        label: '$(book) Show landing brief',
        run: async () => {
          const brief = readBrief(root, e.briefPath!);
          if (brief) {
            const doc = await vscode.workspace.openTextDocument({ content: brief, language: 'markdown' });
            vscode.window.showTextDocument(doc, { preview: true });
          }
        },
      });
    }
    actions.push({
      label: '$(diff) Show this commit’s diff for the file',
      run: async () => {
        const { execFileSync } = require('child_process') as typeof import('child_process');
        const diff = execFileSync('git', ['show', e.sha, '--', rel], { cwd: root, encoding: 'utf8' });
        const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
        vscode.window.showTextDocument(doc, { preview: true });
      },
    });
    const action = actions.length === 1 ? actions[0] : await vscode.window.showQuickPick(actions, { placeHolder: `${e.sha.slice(0, 8)} — ${e.subject}` });
    action?.run();
  });

  // ⚙ next to ▶: edit the run configuration, then dispatch.
  cmd('mdComments.configureAssignToAgent', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    if (!id) {
      vscode.window.showWarningMessage('Comments: submit the comment first, then assign the thread.');
      return;
    }
    const root = store.liveRoot();
    const configured = await configureRun(context, root ? findAgentDefinitions(root) : []);
    if (!configured) return;
    return vscode.commands.executeCommand('mdComments.assignToAgent', { threadId: id, options: configured.options });
  });

  // ---- suggestion accept/reject ----
  const firstOpenSuggestion = (threadId: string) =>
    store.getThread(threadId)?.suggestions.find((s) => s.status === 'open');
  cmd('mdComments.acceptSuggestion', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    const suggestion = id && firstOpenSuggestion(id);
    const root = store.liveRoot();
    if (!id || !suggestion || !root) return;
    const applied = applyPatch(root, suggestion.patch);
    if (!applied.ok) {
      vscode.window.showErrorMessage(`Comments: patch did not apply — ${applied.error}`);
      return;
    }
    store.append(id, userActor(), 'suggestion_accepted', { suggestionId: suggestion.id });
    comments.reloadAllLoaded();
    vscode.window.showInformationMessage('Comments: suggestion applied to the working tree — review and commit.');
  });
  cmd('mdComments.rejectSuggestion', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    const suggestion = id && firstOpenSuggestion(id);
    if (!id || !suggestion) return;
    store.append(id, userActor(), 'suggestion_rejected', { suggestionId: suggestion.id });
    comments.reloadAllLoaded();
  });

  // ---- notary integration: land suggestions / dispatch a fleet ----
  const runQueueCli = (args: string[], title: string): Thenable<any> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) =>
        new Promise((resolve) => {
          const root = store.liveRoot();
          if (!root) return resolve(undefined);
          const queue = path.join(context.extensionPath, 'bin', 'comments-queue.js');
          const { spawn } = require('child_process') as typeof import('child_process');
          const proc = spawn(process.execPath, [queue, ...args], { cwd: root });
          let out = '';
          agentOutput.show(true);
          proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
          proc.stderr.on('data', (c: Buffer) => {
            for (const line of c.toString().split('\n')) {
              if (!line.trim()) continue;
              agentOutput.appendLine(line);
              progress.report({ message: line.replace(/^·\s*/, '') });
            }
          });
          token.onCancellationRequested(() => proc.kill());
          proc.on('close', () => {
            comments.reloadAllLoaded();
            tree.refresh();
            decorations.rebuild();
            try {
              resolve(JSON.parse(out));
            } catch {
              agentOutput.appendLine(out);
              resolve(undefined);
            }
          });
        }),
    );

  cmd('mdComments.acceptAndLand', async (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    if (!id) return;
    const report = await runQueueCli(['land-suggestion', '--thread', id], 'Comments: landing suggestion…');
    if (report?.ok) {
      vscode.window.showInformationMessage(
        `Comments: landed ${String(report.landedSha).slice(0, 8)} (provenance: ${report.provenance}).`,
      );
    } else {
      vscode.window.showErrorMessage('Comments: landing failed — see the "Comments Agent" output.');
    }
    return report;
  });

  cmd('mdComments.dispatchFleet', async (arg?: { threadIds?: string[] }) => {
    let ids = arg?.threadIds;
    if (!ids) {
      const open = store.listThreads().filter((t) => t.status === 'open');
      if (open.length === 0) {
        vscode.window.showInformationMessage('Comments: no open threads to dispatch.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        open.map((t) => ({
          label: t.file,
          description: t.severity === 'blocking' ? '⛔ blocking' : '',
          detail: t.comments.find((c) => !c.deleted)?.body.slice(0, 80),
          id: t.id,
        })),
        { canPickMany: true, placeHolder: 'Threads to dispatch — one fixer agent per thread, landed serially' },
      );
      if (!picks?.length) return;
      ids = picks.map((p) => p.id);
    }
    const claude = agentCommand();
    const report = await runQueueCli(
      ['fleet', '--threads', ids.join(','), '--claude', claude],
      `Comments: fleet on ${ids.length} thread${ids.length === 1 ? '' : 's'}…`,
    );
    if (report) {
      const landed = report.results.filter((r: any) => r.status === 'landed').length;
      const other = report.results.filter((r: any) => r.status !== 'landed');
      vscode.window.showInformationMessage(
        `Comments fleet: ${landed}/${ids.length} landed${other.length ? ` — ${other.map((r: any) => `${r.threadId}: ${r.status}`).join(', ')}` : ''}.`,
      );
    }
    return report;
  });

  // ---- severity toggle ----
  cmd('mdComments.toggleBlocking', (thread?: ThreadArg) => {
    const id = threadIdOf(thread);
    if (!id) return;
    const state = store.getThread(id);
    if (!state) return;
    store.append(id, userActor(), 'severity_changed', {
      severity: state.severity === 'blocking' ? 'normal' : 'blocking',
    });
    comments.reloadAllLoaded();
  });

  // ---- deeplinks ----
  cmd('mdComments.openFileLink', (file: string, start: number, end: number | null) =>
    openFileLink(file, start, end),
  );
  cmd('mdComments.copyRef', () => copySelectionRef());
  cmd('mdComments.openThread', async (threadId: string, _commentId?: string | null) => {
    // Comment-level refs reveal their thread expanded (VS Code's widget has no
    // per-comment scroll target); the ref still records which comment was meant.
    const ok = await comments.revealThreadById(threadId);
    if (!ok) {
      vscode.window.showWarningMessage(
        `Comments: thread ${threadId} was not found (resolved threads may have been pruned — check git history).`,
      );
    }
  });
  const copyRefToClipboard = async (ref: string) => {
    await vscode.env.clipboard.writeText(ref);
    vscode.window.setStatusBarMessage(`Copied ${ref}`, 2500);
  };
  cmd('mdComments.copyThreadRef', (thread?: vscode.CommentThread | { threadId: string }) => {
    const id = thread && ('threadId' in thread ? thread.threadId : comments.idFor(thread));
    if (id) copyRefToClipboard(`thread:${id}`);
  });
  cmd('mdComments.copyCommentRef', (comment?: MComment) => {
    const threadId = comment && comments.idFor(comment.thread);
    if (threadId && comment) copyRefToClipboard(`thread:${threadId}#${comment.id}`);
  });

  cmd(
    'mdComments.openConversation',
    async (sessionId?: string, focus?: ConversationFocus | string | null, scheme?: string) => {
      const dir = store.defaultSessionsDir();
      if (!dir) {
        vscode.window.showWarningMessage('Comments: open a workspace folder to view conversations.');
        return;
      }
      if (!sessionId) {
        // Palette invocation: pick a vendored session.
        const vendored = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length))
          : [];
        if (vendored.length === 0) {
          vscode.window.showInformationMessage('Comments: no vendored sessions in .comments/sessions/ yet.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          vendored.map((id) => ({ label: loadSessionGraph(dir, id)?.title || id, description: id.slice(0, 8), id })),
          { placeHolder: 'Open a vendored agent conversation' },
        );
        if (!pick) return;
        sessionId = pick.id;
      }
      const vendoredPath = vendoredSessionPath(dir, sessionId);
      // Session ids are UUIDs so collisions across providers are vanishingly
      // unlikely, but the caller knows the scheme — prefer an exact match.
      const candidates = findLocalSessions(500).filter((s) => s.sessionId === sessionId);
      const local = candidates.find((s) => s.scheme === scheme) ?? candidates[0];
      // Re-vendor when the LIVE transcript is newer than the vendored copy —
      // this is what makes watching an in-flight session (Agent Sessions view)
      // show current progress on each open.
      if (
        local &&
        (!fs.existsSync(vendoredPath) || fs.statSync(local.jsonlPath).mtimeMs > fs.statSync(vendoredPath).mtimeMs)
      ) {
        vendorSession(local, dir);
      }
      if (!fs.existsSync(vendoredPath)) {
        if (local) {
          vendorSession(local, dir);
        } else {
          vscode.window.showWarningMessage(
            `Comments: session ${sessionId} is not vendored in .comments/sessions/ and was not found locally.`,
          );
          return;
        }
      }
      const graph = loadSessionGraph(dir, sessionId);
      if (!graph) {
        vscode.window.showWarningMessage(`Comments: could not parse session ${sessionId}.`);
        return;
      }
      // Legacy links serialized a bare msgUuid string.
      const normalized: ConversationFocus =
        typeof focus === 'string' ? { kind: 'msg', uuid: focus } : (focus ?? null);
      ConversationPanel.show(context.extensionUri, graph, normalized);
    },
  );

  // ---- tree view helpers ----
  cmd('mdComments.revealThread', async (docUri: vscode.Uri, line: number) => {
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    comments.loadForDocument(doc);
    const l = Math.min(line, doc.lineCount - 1);
    const range = doc.lineAt(l).range;
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  });
  cmd('mdComments.refreshTree', () => {
    tree.refresh();
    decorations.rebuild();
  });
  cmd('mdComments.toggleResolvedInTree', () => {
    tree.showResolved = !tree.showResolved;
    tree.refresh();
  });

  // ---- attach a Claude session to a thread (vendors it for portability) ----
  cmd('mdComments.attachAgentSession', async (thread?: vscode.CommentThread) => {
    const dir = store.defaultSessionsDir();
    if (!dir) {
      vscode.window.showWarningMessage('Comments: open a workspace folder first.');
      return;
    }
    const sessions = findLocalSessions();
    if (sessions.length === 0) {
      vscode.window.showWarningMessage(
        'Comments: no local agent sessions found (~/.claude/projects, $CODEX_HOME/sessions, ~/.cursor/projects).',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.preview || s.sessionId,
        description: `${s.scheme} · ${s.sessionId.slice(0, 8)}`,
        detail: `${s.projectSlug} · ${new Date(s.mtime).toLocaleString()}`,
        session: s,
      })),
      { placeHolder: 'Attach an agent session (it will be copied into .comments/sessions/)', matchOnDetail: true },
    );
    if (!pick) return;
    vendorSession(pick.session, dir);
    const ref = `${pick.session.scheme}:${pick.session.sessionId}`;
    if (thread) {
      comments.appendCommentToThread(thread, `Attached conversation: ${ref}`);
    } else {
      await vscode.env.clipboard.writeText(ref);
      vscode.window.showInformationMessage(`Vendored session and copied "${ref}" — paste it into a comment.`);
    }
  });

  // ---- commentable markdown preview ----
  cmd('mdComments.openPreview', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      vscode.window.showInformationMessage('Comments: open a markdown file first.');
      return;
    }
    MarkdownPreviewPanel.show(context.extensionUri, editor.document, comments);
  });

  // ---- Claude Code MCP integration ----
  /**
   * Cursor's UI offers "Copy Request ID" but never shows the session id, so
   * this is the only bridge from what a user can copy to a ref they can paste.
   */
  cmd('mdComments.cursorRefFromRequestId', async () => {
    const requestId = (
      await vscode.window.showInputBox({
        prompt: 'Cursor request ID (Copy Request ID in the Cursor chat menu)',
        placeHolder: '4dc03317-2f00-4b69-a5d3-a0a23592f934',
        ignoreFocusOut: true,
      })
    )?.trim();
    if (!requestId) return;

    const sessionId = resolveCursorRequestId(requestId);
    if (!sessionId) {
      vscode.window.showWarningMessage(
        `Comments: no Cursor chat found for request ID ${requestId}. It may be from a different machine, or Cursor's state database may be unreadable.`,
      );
      return;
    }
    const ref = `cursor:${sessionId}`; // scheme-literal-ok: this command resolves a Cursor request id
    const name = cursorChatNames().get(sessionId);
    await vscode.env.clipboard.writeText(ref);
    const open = await vscode.window.showInformationMessage(
      `Copied "${ref}"${name ? ` — ${name}` : ''}. Paste it into a comment.`,
      'Open conversation',
    );
    if (open) {
      await vscode.commands.executeCommand('mdComments.openConversation', sessionId, null, 'cursor');
    }
  });

  cmd('mdComments.copyMcpSetup', async () => {
    const server = path.join(context.extensionPath, 'bin', 'mcp-comments.js');
    const provider = agentProvider();
    const command =
      provider === 'codex'
        ? `codex mcp add comments -- node "${server}"`
        : `claude mcp add comments -- node "${server}"`;
    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(
      `Copied MCP setup command — run it in a terminal in your project, then ${
        provider === 'codex' ? 'Codex' : 'Claude Code'
      } can read, reply to, resolve, and create comment threads.`,
    );
  });

  /**
   * The agent loop is only as good as the playbook driving it, so ship the
   * skill and give it a one-click install. Claude reads project-local skills;
   * Codex only discovers them under $CODEX_HOME, hence the two destinations.
   */
  cmd('mdComments.installSkill', async () => {
    const targets = [
      {
        label: '$(sparkle) Claude Code — this workspace',
        detail: '.claude/skills/comment-cycle/',
        skill: 'comment-cycle',
        dest: () => {
          const root = store.liveRoot();
          return root ? path.join(root, '.claude', 'skills', 'comment-cycle') : undefined;
        },
      },
      {
        label: '$(sparkle) Codex — this machine',
        detail: '$CODEX_HOME/skills/comment-cycle/ (~/.codex by default)',
        skill: 'comment-cycle-codex',
        dest: () => {
          const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
          return path.join(home, 'skills', 'comment-cycle');
        },
      },
    ];
    const pick = await vscode.window.showQuickPick(targets, {
      placeHolder: 'Install the comment-cycle playbook for which agent?',
    });
    if (!pick) return;
    const dest = pick.dest();
    if (!dest) {
      vscode.window.showWarningMessage('Comments: open a workspace folder first.');
      return;
    }
    const src = path.join(context.extensionPath, 'skills', pick.skill, 'SKILL.md');
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, 'SKILL.md'));
    } catch (err) {
      vscode.window.showErrorMessage(`Comments: could not install skill — ${(err as Error).message}`);
      return;
    }
    const open = await vscode.window.showInformationMessage(
      `Installed comment-cycle to ${dest}.`,
      'Open it',
    );
    if (open) {
      const doc = await vscode.workspace.openTextDocument(path.join(dest, 'SKILL.md'));
      await vscode.window.showTextDocument(doc);
    }
  });

  cmd('mdComments.verifyMcpSetup', async () => {
    const server = path.join(context.extensionPath, 'bin', 'mcp-comments.js');
    const root = store.liveRoot();
    if (!root) {
      vscode.window.showWarningMessage('Comments: open a workspace folder first.');
      return undefined;
    }
    const diag = await runMcpDoctor(server, root);
    const output = vscode.window.createOutputChannel('Comments MCP');
    output.clear();
    output.appendLine('Comments MCP setup check');
    for (const m of diag.messages) output.appendLine(m);
    output.show(true);
    // Notifications are fire-and-forget: a message with buttons resolves only
    // when dismissed, and this command's result is consumed programmatically.
    const healthy = diag.serverResponds && diag.registration !== 'missing' && diag.registration !== 'stale-path';
    if (healthy) {
      vscode.window.showInformationMessage(`Comments MCP: healthy (${diag.toolCount} tools).`);
    } else if (diag.registration === 'missing' || diag.registration === 'stale-path') {
      vscode.window
        .showWarningMessage(
          `Comments MCP: ${diag.registration === 'missing' ? 'not registered with Claude Code' : 'registered with a stale path'}.`,
          'Copy Setup Command',
        )
        .then((choice) => {
          if (choice) vscode.commands.executeCommand('mdComments.copyMcpSetup');
        });
    } else {
      vscode.window.showErrorMessage('Comments MCP: server check failed — see the "Comments MCP" output.');
    }
    return diag;
  });

  context.subscriptions.push(comments);
  return { store, comments };
}

export function deactivate(): void {}
