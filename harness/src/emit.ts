// Единственная точка контракта выхода (I8). Меняется только здесь, если документация или проба
// покажут расхождение. Порядок строгости: deny > ask > block > context > silent; unknown
// превращается в ask на pre-событиях и в context (жёлтая строка) на остальных — никогда в silent.
import type { HarnessEvent, Verdict } from './types.ts';

const PRE_EVENTS: ReadonlySet<HarnessEvent> = new Set(['pre-bash', 'pre-agent', 'pre-write']);
const HOOK_EVENT_NAME: Partial<Record<HarnessEvent, string>> = {
  'pre-bash': 'PreToolUse', 'pre-agent': 'PreToolUse', 'pre-write': 'PreToolUse',
  post: 'PostToolUse', 'post-batch': 'PostToolBatch', 'agent-start': 'SubagentStart', 'agent-stop': 'SubagentStop',
  stop: 'Stop', 'session-start': 'SessionStart', 'session-end': 'SessionEnd', prompt: 'UserPromptSubmit',
  precompact: 'PreCompact', 'worktree-create': 'WorktreeCreate', 'worktree-remove': 'WorktreeRemove',
  'contour-changed': 'FileChanged',
};

const RANK: Record<Verdict['kind'], number> = { deny: 5, ask: 4, block: 3, unknown: 2, context: 1, silent: 0 };

export function merge(verdicts: Verdict[], event: HarnessEvent, env: NodeJS.ProcessEnv = process.env): Verdict {
  const normalized = verdicts.map((v) => (v.kind === 'unknown' ? liftUnknown(v, event, env) : v));
  normalized.sort((a, b) => RANK[b.kind] - RANK[a.kind]);
  const top = normalized[0] ?? { kind: 'silent' as const };
  if (top.kind === 'silent') return top;
  // Несколько вердиктов одного ранга — сообщения не теряются (класс `.claude/check.sh:5-7`).
  const same = normalized.filter((v) => v.kind === top.kind);
  if (same.length === 1) return top;
  const texts = same.map((v) => ('reason' in v ? v.reason : 'text' in v ? v.text : '')).filter(Boolean);
  return { ...top, ...(('reason' in top) ? { reason: texts.join('\n') } : { text: texts.join('\n') }) } as Verdict;
}

function liftUnknown(v: Extract<Verdict, { kind: 'unknown' }>, event: HarnessEvent, env: NodeJS.ProcessEnv): Verdict {
  const reason = `unknown(${v.gate}): ${v.reason}`;
  if (PRE_EVENTS.has(event) && env.CLAUDE_HARNESS_UNKNOWN !== 'note') return { kind: 'ask', reason, gate: v.gate };
  return { kind: 'context', text: reason, gate: v.gate };
}

export interface Emitted { rc: number; stdout: string; stderr: string }

export function render(v: Verdict, event: HarnessEvent): Emitted {
  const hookEventName = HOOK_EVENT_NAME[event] ?? 'PostToolUse';
  switch (v.kind) {
    case 'silent': return { rc: 0, stdout: '', stderr: '' };
    case 'deny': return { rc: 2, stdout: '', stderr: `${v.gate}: ${v.reason}\n` };
    case 'ask': return { rc: 0, stderr: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, permissionDecision: 'ask', permissionDecisionReason: `${v.gate}: ${v.reason}` } }) };
    case 'block': return { rc: 0, stderr: '', stdout: JSON.stringify({ decision: 'block', reason: `${v.gate}: ${v.reason}` }) };
    case 'context': return { rc: 0, stderr: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: v.text } }) };
    case 'unknown': return render({ kind: 'context', text: `unknown(${v.gate}): ${v.reason}`, gate: v.gate }, event);
  }
}

export function emit(v: Verdict, event: HarnessEvent): never {
  const out = render(v, event);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}

/** Крах уровня процесса: rc 1 и ровно одна строка stderr — никакого стека в контекст модели. */
export function crash(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: ${msg.split('\n')[0]}\n`);
  process.exit(1);
}
