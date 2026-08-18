import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * "Comments: Verify MCP Setup" — preflight for the Claude Code integration.
 * Checks the bundled server exists, does a real initialize/tools roundtrip
 * against the current repo, and inspects `claude mcp list` for a missing or
 * stale registration (the install path changes on every extension update).
 * Returns a structured report so integration tests can assert on it.
 */

export interface McpDiagnostics {
  serverPath: string;
  serverExists: boolean;
  serverResponds: boolean;
  toolCount: number;
  claudeCliFound: boolean;
  registration: 'ok' | 'missing' | 'stale-path' | 'unknown';
  registeredPath?: string;
  messages: string[];
}

export async function runMcpDoctor(serverPath: string, workspaceRoot: string): Promise<McpDiagnostics> {
  const diag: McpDiagnostics = {
    serverPath,
    serverExists: fs.existsSync(serverPath),
    serverResponds: false,
    toolCount: 0,
    claudeCliFound: false,
    registration: 'unknown',
    messages: [],
  };

  if (!diag.serverExists) {
    diag.messages.push(`✗ server not found at ${serverPath}`);
    return diag;
  }
  diag.messages.push(`✓ server present: ${serverPath}`);

  // Live roundtrip: initialize + tools/list over stdio, 5s budget.
  try {
    const tools = await roundtrip(serverPath, workspaceRoot);
    diag.serverResponds = true;
    diag.toolCount = tools.length;
    diag.messages.push(`✓ server responds (${tools.length} tools: ${tools.join(', ')})`);
  } catch (err) {
    diag.messages.push(`✗ server failed the stdio roundtrip: ${(err as Error).message}`);
    return diag;
  }

  // Registration check (best-effort, async — `claude mcp list` pings every
  // configured server and can take a while; never block the extension host).
  const stdout = await execCapture('claude', ['mcp', 'list'], workspaceRoot, 15000);
  if (stdout === null) {
    diag.messages.push('· claude CLI not found (or `claude mcp list` failed) — skipping registration check');
    return diag;
  }
  diag.claudeCliFound = true;
  const line = stdout.split('\n').find((l) => /(^|\s)comments\b/.test(l));
  if (!line) {
    diag.registration = 'missing';
    diag.messages.push('✗ no "comments" MCP server registered — run "Comments: Copy Claude Code MCP Setup Command"');
    return diag;
  }
  const pathMatch = line.match(/(\/\S+mcp-comments\.js)/);
  diag.registeredPath = pathMatch?.[1];
  if (diag.registeredPath && path.resolve(diag.registeredPath) !== path.resolve(serverPath)) {
    diag.registration = 'stale-path';
    diag.messages.push(
      `✗ registration points at a stale path (${diag.registeredPath}) — the extension moved on update; re-run the setup command`,
    );
  } else {
    diag.registration = 'ok';
    diag.messages.push('✓ registered with Claude Code');
  }
  return diag;
}

/** Run a command, capture stdout; null on missing binary, non-zero exit, or timeout. */
function execCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

function roundtrip(serverPath: string, root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, MD_COMMENTS_ROOT: root },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('timed out after 5s'));
    }, 5000);
    let buf = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (msg.id === 2) {
            clearTimeout(timer);
            proc.kill();
            resolve((msg.result?.tools ?? []).map((t: { name: string }) => t.name));
          }
        } catch {
          /* ignore */
        }
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n',
    );
  });
}
