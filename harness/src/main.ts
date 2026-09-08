// Роутер: читает payload один раз, вызывает гейты события — каждый в своём try/catch,
// провал одного не глушит другие (класс К2) — и отдаёт самый строгий вердикт через emit().
import { readFileSync } from 'node:fs';
import './gates/index.ts';
import { GATES } from './gates/registry.ts';
import { merge, emit, crash } from './emit.ts';
import type { GateContext, HarnessEvent, HookPayload, Verdict } from './types.ts';

const KNOWN_EVENTS = new Set<string>([
  'pre-bash', 'pre-agent', 'pre-write', 'post', 'post-batch', 'agent-start', 'agent-stop', 'stop',
  'session-start', 'session-end', 'prompt', 'precompact', 'worktree-create', 'worktree-remove',
  'contour-changed', 'install-warmup',
]);

export function readPayload(raw: string): HookPayload | null {
  if (!raw.trim()) return null;
  const obj = JSON.parse(raw) as Partial<HookPayload>;
  if (typeof obj !== 'object' || obj === null || typeof obj.hook_event_name !== 'string' || typeof obj.cwd !== 'string') return null;
  return obj as HookPayload;
}

export async function route(event: HarnessEvent, payload: HookPayload | null, env: NodeJS.ProcessEnv): Promise<Verdict> {
  const root = env.HARNESS_ROOT ?? new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const stateDir = env.CLAUDE_STATE_DIR ?? `${env.HOME}/.claude/exec-telemetry`;
  const gates = GATES.filter((g) => g.events.includes(event));
  if (!payload) {
    // Пейлоада нет — данных нет. На pre это ask, на post — жёлтая строка; тишина запрещена (I1).
    return merge([{ kind: 'unknown', reason: 'payload отсутствует или не JSON', gate: 'router' }], event, env);
  }
  const ctx: GateContext = { event, payload, env, root, stateDir, now: Date.now };
  const verdicts: Verdict[] = [];
  for (const gate of gates) {
    if (env[gate.killSwitch] === '1') continue; // выключатель раньше любой записи (I4)
    try {
      verdicts.push(await gate.run(ctx));
    } catch (err) {
      verdicts.push({ kind: 'unknown', reason: err instanceof Error ? err.message.split('\n')[0] : String(err), gate: gate.name });
    }
  }
  return merge(verdicts, event, env);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const event = process.argv[2] ?? '';
  if (!KNOWN_EVENTS.has(event)) crash(new Error(`неизвестное событие «${event}»`));
  let raw = '';
  try { raw = event === 'install-warmup' ? '' : readFileSync(0, 'utf8'); } catch { raw = ''; }
  let payload: HookPayload | null = null;
  try { payload = readPayload(raw); } catch { payload = null; }
  if (event === 'install-warmup') process.exit(0);
  route(event as HarnessEvent, payload, process.env).then((v) => emit(v, event as HarnessEvent), crash);
}
