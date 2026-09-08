// Типы пейлоада хуков Claude Code 2.1.259 — по пробе на живой сессии 05.09.2026, не по документации:
// у PostToolUse(Bash) нет exit_code, неуспех приходит отдельным событием PostToolUseFailure.
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';

export interface HookCommon {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  scratchpad_dir?: string;
  permission_mode?: PermissionMode;
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
}

export interface ToolCall { tool_name: string; tool_input: Record<string, unknown>; tool_use_id?: string }

export interface PreToolUsePayload extends HookCommon, ToolCall { hook_event_name: 'PreToolUse' }
export interface PostToolUsePayload extends HookCommon, ToolCall {
  hook_event_name: 'PostToolUse';
  tool_response?: { stdout?: string; stderr?: string; interrupted?: boolean } & Record<string, unknown>;
  duration_ms?: number;
}
export interface PostToolUseFailurePayload extends HookCommon, ToolCall {
  hook_event_name: 'PostToolUseFailure';
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}
export interface PostToolBatchPayload extends HookCommon { hook_event_name: 'PostToolBatch'; tool_calls: ToolCall[] }
export interface SubagentStartPayload extends HookCommon { hook_event_name: 'SubagentStart'; agent_id: string; agent_type: string }
export interface SubagentStopPayload extends HookCommon {
  hook_event_name: 'SubagentStop';
  agent_id: string; agent_type: string;
  agent_transcript_path?: string;
  last_assistant_message?: string; // не читается: I3 (флаг friction.read_section выключен)
  stop_hook_active?: boolean;
}
export interface StopPayload extends HookCommon { hook_event_name: 'Stop'; stop_hook_active?: boolean }
export interface SessionPayload extends HookCommon { hook_event_name: 'SessionStart' | 'SessionEnd' | 'PreCompact' | 'UserPromptSubmit' | 'WorktreeCreate' | 'WorktreeRemove' | 'FileChanged' | 'ConfigChange'; source?: string; prompt?: string }

export type HookPayload =
  | PreToolUsePayload | PostToolUsePayload | PostToolUseFailurePayload | PostToolBatchPayload
  | SubagentStartPayload | SubagentStopPayload | StopPayload | SessionPayload;

/** Внутренние имена событий = аргумент bin/hook <event>. */
export type HarnessEvent =
  | 'pre-bash' | 'pre-agent' | 'pre-write' | 'post' | 'post-batch'
  | 'agent-start' | 'agent-stop' | 'stop' | 'session-start' | 'session-end' | 'prompt'
  | 'precompact' | 'worktree-create' | 'worktree-remove' | 'contour-changed' | 'install-warmup';

/** Вердикт гейта. `unknown` — отсутствие данных, никогда не схлопывается в silent (I1). */
export type Verdict =
  | { kind: 'silent' }
  | { kind: 'deny'; reason: string; gate: string }
  | { kind: 'ask'; reason: string; gate: string }
  | { kind: 'context'; text: string; gate: string }
  | { kind: 'block'; reason: string; gate: string }
  | { kind: 'unknown'; reason: string; gate: string };

export interface GateContext {
  event: HarnessEvent;
  payload: HookPayload;
  env: NodeJS.ProcessEnv;
  root: string;        // HARNESS_ROOT
  stateDir: string;    // CLAUDE_STATE_DIR
  now: () => number;
}

export interface Gate {
  name: string;
  events: HarnessEvent[];
  killSwitch: string;   // имя env-переменной, `=1` гасит гейт ДО любой записи (I4)
  run: (ctx: GateContext) => Verdict | Promise<Verdict>;
}
