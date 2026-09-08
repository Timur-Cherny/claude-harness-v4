// PreToolUse(Agent|Task): любой явный `model` у субагента запрещён — единственный контракт наследование
// от родителя (порт hooks/model-gate.sh; ветка Workflow-скрипта уходит структурной проверке по TS-AST,
// здесь её нет намеренно). Никаких списков разрешённых моделей: список стареет и даёт усилить модель
// «другим именем». Kill-switch читает роутер: CLAUDE_SKIP_MODEL_GATE.
import { register } from './registry.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'model-gate';
const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function decide(ctx: GateContext): Verdict {
  const p = ctx.payload;
  if (!('tool_name' in p) || !AGENT_TOOLS.has(p.tool_name)) return { kind: 'silent' };
  const input = (p as { tool_input?: unknown }).tool_input;
  if (typeof input !== 'object' || input === null) return { kind: 'unknown', gate: NAME, reason: 'tool_input отсутствует или не объект — явную модель не проверить' };
  if (!('model' in input)) return { kind: 'silent' };
  const model = (input as Record<string, unknown>).model;
  if (model === null || model === undefined || model === '') return { kind: 'silent' };
  const shown = typeof model === 'string' ? model : JSON.stringify(model);
  return {
    kind: 'deny', gate: NAME,
    reason: `явная модель субагента запрещена (model=${shown}). Убери model — субагент обязан наследовать модель родителя. Если override действительно нужен, сначала измени сам контракт и его тест.`,
  };
}

const gate: Gate = { name: NAME, events: ['pre-agent'], killSwitch: 'CLAUDE_SKIP_MODEL_GATE', run: decide };
register(gate);
