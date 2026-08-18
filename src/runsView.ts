import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { gitCommonDir } from './baseline';
import { Store } from './store';

/**
 * "Agent Sessions" view: live presence for working sessions (main
 * orchestrators, reviewers, implementers — autonomous or human-driven),
 * registered via the register_session MCP tool into <git-common-dir>/
 * comments-runs/. Presence, not history: machine-local, never committed.
 * Liveness is derived from transcript mtime — no heartbeat protocol.
 */

export interface RegisteredRun {
  sessionId: string;
  role: string;
  mission: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  transcriptPath: string | null;
  root: string;
}

const ACTIVE_MS = 2 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

export function listRuns(store: Store): Array<RegisteredRun & { activity: 'active' | 'idle' | 'done'; lastSeen: number }> {
  const root = store.liveRoot();
  const common = root ? gitCommonDir(root) : null;
  if (!common) return [];
  const dir = path.join(common, 'comments-runs');
  if (!fs.existsSync(dir)) return [];
  const out: Array<RegisteredRun & { activity: 'active' | 'idle' | 'done'; lastSeen: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as RegisteredRun;
      let lastSeen = Date.parse(run.updatedAt) || 0;
      if (run.transcriptPath && fs.existsSync(run.transcriptPath)) {
        lastSeen = Math.max(lastSeen, fs.statSync(run.transcriptPath).mtimeMs);
      }
      if (Date.now() - lastSeen > STALE_MS) continue; // day-old runs age out of the view
      const activity = Date.now() - lastSeen < ACTIVE_MS ? 'active' : 'idle';
      out.push({ ...run, activity, lastSeen });
    } catch {
      /* skip unreadable run file */
    }
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

export class AgentSessionsProvider implements vscode.TreeDataProvider<RegisteredRun & { activity: string; lastSeen: number }> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly store: Store) {
    this.timer = setInterval(() => this.changeEmitter.fire(), 15_000);
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(): Array<RegisteredRun & { activity: string; lastSeen: number }> {
    return listRuns(this.store);
  }

  getTreeItem(run: RegisteredRun & { activity: string; lastSeen: number }): vscode.TreeItem {
    const icon =
      run.activity === 'active'
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('circle-outline');
    const item = new vscode.TreeItem(`${run.role}: ${run.mission || run.sessionId.slice(0, 8)}`);
    item.iconPath = icon;
    item.description = `${run.status ? run.status + ' · ' : ''}${run.activity} · ${new Date(run.lastSeen).toLocaleTimeString()}`;
    item.tooltip = new vscode.MarkdownString(
      `**${run.role}** — ${run.mission}\n\n` +
        `session \`${run.sessionId}\`\n\n` +
        `started ${new Date(run.startedAt).toLocaleString()} · last activity ${new Date(run.lastSeen).toLocaleString()}\n\n` +
        (run.status ? `status: ${run.status}\n\n` : '') +
        'Click to open the conversation (re-vendored fresh each open).',
    );
    item.command = {
      command: 'mdComments.openConversation',
      title: 'Open Conversation',
      arguments: [run.sessionId, null],
    };
    return item;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
