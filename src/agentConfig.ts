import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { DEFAULT_MCP_TOOLS, RunOptions } from './agentArgs';
import { AgentDefinition } from './agentRun';

/**
 * ⚙ Assign to Agent (Configured): one quick-pick menu over the run options.
 * Selections persist per-workspace (workspaceState) on top of the
 * `mdComments.agent.*` settings, so the gear remembers your last setup.
 */

const STATE_KEY = 'mdComments.agentRunOptions';

export type AgentProvider = 'claude' | 'codex';

/** Which provider the workspace dispatches to. */
export function agentProvider(): AgentProvider {
  const v = vscode.workspace.getConfiguration('mdComments.agent').get<string>('provider');
  return v === 'codex' ? 'codex' : 'claude';
}

/**
 * The executable to run. One resolver so the deprecated `mdComments.claudeCommand`
 * fallback lives in exactly one place: new setting → old setting → provider default.
 */
export function agentCommand(provider: AgentProvider = agentProvider()): string {
  const cfg = vscode.workspace.getConfiguration('mdComments');
  return (
    cfg.get<string>('agent.command') ||
    cfg.get<string>('claudeCommand') ||
    (provider === 'codex' ? 'codex' : 'claude')
  );
}

export interface ConfiguredRun {
  options: RunOptions & { agentName?: string };
}

export function defaultRunOptions(context: vscode.ExtensionContext): RunOptions & { agentName?: string } {
  const cfg = vscode.workspace.getConfiguration('mdComments.agent');
  const fromSettings: RunOptions & { agentName?: string } = {
    model: cfg.get<string>('model') || undefined,
    permissionMode: (cfg.get<string>('permissionMode') as RunOptions['permissionMode']) || undefined,
    effort: cfg.get<string>('effort') || undefined,
    allowedTools: cfg.get<string[]>('allowedTools')?.length ? cfg.get<string[]>('allowedTools') : undefined,
    replaceSystemPrompt: cfg.get<string>('systemPrompt') || undefined,
    appendSystemPrompt: cfg.get<string>('appendSystemPrompt') || undefined,
    maxTurns: cfg.get<number>('maxTurns') || undefined,
    extraArgs: cfg.get<string[]>('extraArgs')?.length ? cfg.get<string[]>('extraArgs') : undefined,
    sessionMode: 'auto',
  };
  const remembered = context.workspaceState.get<RunOptions & { agentName?: string }>(STATE_KEY);
  return { ...fromSettings, ...remembered };
}

const EXTRA_TOOL_CHOICES = ['Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'];

/**
 * Convenience aliases only — everything passes straight through to the CLI's
 * --model flag, and "custom…" accepts any id, so a stale list here can never
 * block a user from selecting a newer model.
 */
const CLAUDE_MODEL_CHOICES: Array<{ label: string; description: string }> = [
  { label: 'fable', description: 'Claude Fable 5 — most capable' },
  { label: 'opus', description: 'Claude Opus 5' },
  { label: 'sonnet', description: 'Claude Sonnet 5' },
  { label: 'sonnet[1m]', description: 'Sonnet with 1M-token context' },
  { label: 'haiku', description: 'Claude Haiku 4.5 — fastest' },
  { label: 'opusplan', description: 'Opus plans, Sonnet executes' },
];

/**
 * Codex has no stable alias vocabulary — ids are concrete and rotate, and the
 * user's own default lives in their config.toml. So offer the CLI default
 * prominently and let "custom…" carry anything; we do not hardcode a roster
 * that would rot.
 */
const CODEX_MODEL_CHOICES: Array<{ label: string; description: string }> = [];

function modelChoices(provider: AgentProvider): Array<{ label: string; description: string }> {
  return provider === 'codex' ? CODEX_MODEL_CHOICES : CLAUDE_MODEL_CHOICES;
}

/** Does the installed claude CLI understand --effort? Probed once per command. */
const effortSupport = new Map<string, Promise<boolean>>();
function supportsEffort(command: string): Promise<boolean> {
  let probe = effortSupport.get(command);
  if (!probe) {
    probe = new Promise<boolean>((resolve) => {
      try {
        const proc = spawn(command, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => {
          proc.kill();
          resolve(false);
        }, 4000);
        proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        proc.on('close', () => {
          clearTimeout(timer);
          resolve(out.includes('--effort'));
        });
      } catch {
        resolve(false);
      }
    });
    effortSupport.set(command, probe);
  }
  return probe;
}

export async function configureRun(
  context: vscode.ExtensionContext,
  agents: AgentDefinition[],
): Promise<ConfiguredRun | undefined> {
  const options = defaultRunOptions(context);
  const show = (v: unknown, fallback = 'default') => (v === undefined || v === '' ? fallback : String(v));
  const provider = agentProvider();
  const command = agentCommand(provider);
  // Claude advertises --effort in --help; codex takes it as a config override,
  // so there is nothing to probe and the option always applies.
  const effortOk = provider === 'codex' ? true : await supportsEffort(command);

  for (;;) {
    const items: Array<vscode.QuickPickItem & { key: string }> = [
      { key: 'run', label: '$(play) Run with these settings', detail: 'Dispatch the agent on this thread' },
      {
        key: 'agent',
        label: `$(hubot) Agent: ${show(options.agentName, 'claude (default)')}`,
        detail: agents.length ? `presets from .claude/agents: ${agents.map((a) => a.name).join(', ')}` : 'no .claude/agents definitions found',
      },
      {
        key: 'session',
        label: `$(history) Session: ${show(options.sessionMode, 'auto')}`,
        detail: 'auto = fork a mentioned session, else continue this thread’s session, else fresh',
      },
      { key: 'model', label: `$(chip) Model: ${show(options.model, 'CLI default')}` },
      {
        key: 'effort',
        label: `$(dashboard) Effort: ${show(options.effort)}`,
        detail: effortOk ? undefined : 'your CLI does not advertise --effort; selection would be ignored',
      },
      { key: 'permissions', label: `$(shield) Permission mode: ${show(options.permissionMode)}` },
      {
        key: 'tools',
        label: `$(tools) Allowed tools: ${options.allowedTools?.length ? `${options.allowedTools.length} selected` : 'comments MCP (default)'}`,
      },
      {
        key: 'system',
        label: `$(note) System prompt: ${
          options.replaceSystemPrompt
            ? `replaced ("${options.replaceSystemPrompt.slice(0, 30)}…")`
            : options.appendSystemPrompt
              ? `default + append ("${options.appendSystemPrompt.slice(0, 30)}…")`
              : 'CLI default'
        }`,
      },
      { key: 'turns', label: `$(watch) Max turns: ${show(options.maxTurns, 'unlimited')}` },
      { key: 'extra', label: `$(terminal) Extra CLI args: ${options.extraArgs?.length ? options.extraArgs.join(' ') : 'none'}`, detail: 'escape hatch: effort, betas, any future flag' },
      { key: 'reset', label: '$(clear-all) Reset to settings defaults' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Assign to Agent (${provider}) — run configuration (persists for this workspace)`,
    });
    if (!pick) return undefined;

    switch (pick.key) {
      case 'run':
        await context.workspaceState.update(STATE_KEY, options);
        return { options };
      case 'agent': {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'claude (default)', description: 'no agent definition', name: undefined as string | undefined },
            ...agents.map((a) => ({ label: a.name, description: a.description, name: a.name as string | undefined })),
          ],
          { placeHolder: 'Agent definition (system prompt preset from .claude/agents)' },
        );
        if (choice) options.agentName = choice.name;
        break;
      }
      case 'session': {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'auto', description: 'fork mention → continue thread session → fresh' },
            { label: 'fresh', description: 'always start a new session' },
            { label: 'continue', description: 'resume this thread’s last agent session (multi-turn follow-ups)' },
            { label: 'fork', description: 'fork the mentioned/last session instead of extending it' },
          ],
          { placeHolder: 'Session mode' },
        );
        if (choice) options.sessionMode = choice.label as RunOptions['sessionMode'];
        break;
      }
      case 'model': {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'CLI default', description: `whatever your ${provider} config selects` },
            ...modelChoices(provider),
            {
              label: 'custom…',
              description:
                provider === 'codex' ? 'full model id (e.g. gpt-5.6-sol)' : 'full model id (e.g. claude-fable-5)',
            },
          ],
          { placeHolder: 'Model for the run (passed through to --model)' },
        );
        if (choice?.label === 'custom…') {
          options.model =
            (await vscode.window.showInputBox({ prompt: 'Model id', value: options.model ?? '' })) || undefined;
        } else if (choice) {
          options.model = choice.label === 'CLI default' ? undefined : choice.label;
        }
        break;
      }
      case 'effort': {
        if (!effortOk) {
          const goExtra = await vscode.window.showQuickPick(
            [
              { label: 'OK', description: 'effort not supported by this CLI build' },
              { label: 'Set via extra args anyway…', description: 'adds --effort <level> verbatim' },
            ],
            { placeHolder: `'${command} --help' does not list --effort` },
          );
          if (goExtra?.label.startsWith('Set via')) {
            const level = await vscode.window.showQuickPick(['low', 'medium', 'high'], { placeHolder: 'Effort level' });
            if (level) options.extraArgs = [...(options.extraArgs ?? []), '--effort', level];
          }
          break;
        }
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'CLI default', description: 'no --effort flag' },
            { label: 'low', description: 'fast, cheap — mechanical tasks' },
            { label: 'medium', description: 'balanced' },
            { label: 'high', description: 'deep reasoning — hard reviews and fixes' },
          ],
          { placeHolder: 'Reasoning effort for the run' },
        );
        if (choice) options.effort = choice.label === 'CLI default' ? undefined : choice.label;
        break;
      }
      case 'permissions': {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'default', description: 'read-only tools + allowed MCP tools (recommended for suggest-only)' },
            { label: 'acceptEdits', description: 'agent may edit files in your working tree' },
            { label: 'plan', description: 'plan mode — no mutations' },
            { label: 'bypassPermissions', description: '⚠ everything allowed — use only in disposable environments' },
          ],
          { placeHolder: 'Permission mode' },
        );
        if (choice) options.permissionMode = choice.label === 'default' ? undefined : (choice.label as RunOptions['permissionMode']);
        break;
      }
      case 'tools': {
        const current = new Set(options.allowedTools ?? DEFAULT_MCP_TOOLS);
        const choices = await vscode.window.showQuickPick(
          [...DEFAULT_MCP_TOOLS, ...EXTRA_TOOL_CHOICES].map((t) => ({ label: t, picked: current.has(t) })),
          { canPickMany: true, placeHolder: 'Tool allowlist for the run' },
        );
        if (choices) options.allowedTools = choices.map((c) => c.label);
        break;
      }
      case 'system': {
        const mode = await vscode.window.showQuickPick(
          [
            { label: 'CLI default', description: 'no system-prompt flags' },
            { label: 'Append', description: 'keep the default prompt, add your text (and any agent definition) on top' },
            { label: 'Replace', description: 'set the base prompt (--system-prompt); agent definition + append still stack' },
          ],
          { placeHolder: 'System prompt mode' },
        );
        if (!mode) break;
        if (mode.label === 'CLI default') {
          options.replaceSystemPrompt = undefined;
          options.appendSystemPrompt = undefined;
        } else if (mode.label === 'Append') {
          const value = await vscode.window.showInputBox({
            prompt: 'Appended to the system prompt (on top of any agent definition)',
            value: options.appendSystemPrompt ?? '',
          });
          if (value !== undefined) {
            options.appendSystemPrompt = value || undefined;
            options.replaceSystemPrompt = undefined;
          }
        } else {
          const value = await vscode.window.showInputBox({
            prompt: 'Base system prompt for the run (replaces the CLI default entirely)',
            value: options.replaceSystemPrompt ?? '',
          });
          if (value !== undefined) options.replaceSystemPrompt = value || undefined;
        }
        break;
      }
      case 'turns': {
        const value = await vscode.window.showInputBox({
          prompt: 'Max agent turns (empty = unlimited)',
          value: options.maxTurns ? String(options.maxTurns) : '',
          validateInput: (v) => (v === '' || /^\d+$/.test(v) ? undefined : 'number or empty'),
        });
        if (value !== undefined) options.maxTurns = value ? Number(value) : undefined;
        break;
      }
      case 'extra': {
        const value = await vscode.window.showInputBox({
          prompt: 'Extra CLI arguments (space-separated; quoting not supported — use a wrapper script for complex flags)',
          value: options.extraArgs?.join(' ') ?? '',
        });
        if (value !== undefined) options.extraArgs = value.trim() ? value.trim().split(/\s+/) : undefined;
        break;
      }
      case 'reset':
        await context.workspaceState.update(STATE_KEY, undefined);
        return configureRun(context, agents);
    }
  }
}
