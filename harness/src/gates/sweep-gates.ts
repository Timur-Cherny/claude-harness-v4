// Гейты сверки: post/post-batch/agent-stop — контекст (additionalContext) с находками; stop — блок один
// раз на подпись per-session и синхронный дренаж фоновых задач (Stop не проходит, пока pending не пуст).
import { register } from './registry.ts';
import { State } from '../state.ts';
import { deliver, formatFindings, signature, sweep } from '../sweep.ts';
import { pendingJobs, runJob } from '../jobs/worker.ts';
import type { GateContext, Verdict } from '../types.ts';

export const STOP_DRAIN_MS = 150_000;

/** Наблюдаемость бюджета R5: последние 50 замеров сверки (мс, изменено, проверено) — в markers, не в телеметрии. */
export function recordTiming(state: State, ms: number, changed: number, checked: number): void {
  const prev = state.marker('sweep:timings');
  const arr: Array<[number, number, number]> = prev ? JSON.parse(prev) : [];
  arr.push([Math.round(ms), changed, checked]);
  state.setMarker('sweep:timings', JSON.stringify(arr.slice(-50)));
}

export async function sweepPost(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as { session_id: string; tool_use_id?: string; tool_name?: string; prompt_id?: string };
  const state = State.open(ctx.stateDir);
  try {
    const key = p.tool_use_id ?? `${p.prompt_id ?? 'p'}:${ctx.event}`;
    if (p.tool_use_id && !state.claim(p.session_id, ctx.event, key, ctx.now())) return { kind: 'silent' }; // второй хук того же события (user + repo-level)
    const t0 = ctx.now();
    const out = await sweep(ctx, state);
    const found = deliver(state, p.session_id, out.roots, ctx.now(), out.findings, out.files);
    recordTiming(state, ctx.now() - t0, out.changed, out.checked);
    // Повтор той же находки на каждом событии исключён уже тем, что неизменившийся файл не перепроверяется
    // (verified) и доставка per-session однократна; подавление по подписи здесь глушило бы повторную поломку после починки.
    if (!found.length && !out.unknownReasons.length) return out.pending ? { kind: 'context', text: `harness sweep: ${out.pending} проверок в фоне`, gate: 'sweep' } : { kind: 'silent' };
    return { kind: 'context', text: formatFindings(found, out), gate: 'sweep' };
  } finally { state.close(); }
}

export async function sweepStop(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as { session_id: string };
  const state = State.open(ctx.stateDir);
  try {
    const out = await sweep(ctx, state, { spawnWorker: false });
    const deadline = ctx.now() + STOP_DRAIN_MS;
    let leftPending = 0;
    for (const repo of out.roots) {
      for (const jobId of pendingJobs(state, repo, ctx.now())) {
        if (ctx.now() >= deadline) { leftPending++; continue; }
        const r = await runJob(state, jobId, ctx.env, ctx.root, ctx.now, deadline - ctx.now());
        if (r === 'taken') leftPending++;
      }
    }
    const found = deliver(state, p.session_id, out.roots, ctx.now(), out.findings, out.files);
    const parts: string[] = [];
    if (found.length || out.unknownReasons.length) parts.push(formatFindings(found, { ...out, pending: leftPending }));
    if (leftPending) parts.push(`не дренировано фоновых проверок: ${leftPending} — Stop блокируется до результата`);
    if (!parts.length) return { kind: 'silent' };
    const sig = `stop:${signature(found)}:${leftPending}`;
    const seen = state.db.prepare('SELECT 1 FROM stop_blocks WHERE session_id = ? AND signature = ?').get(p.session_id, sig);
    if (seen && !leftPending) return { kind: 'context', text: parts.join('\n'), gate: 'sweep' }; // не чинится — не запирает сессию
    state.db.prepare('INSERT OR IGNORE INTO stop_blocks(session_id, signature, blocked_at) VALUES(?,?,?)').run(p.session_id, sig, ctx.now());
    return { kind: 'block', reason: parts.join('\n'), gate: 'sweep' };
  } finally { state.close(); }
}

register({ name: 'sweep', events: ['post', 'post-batch', 'agent-stop'], killSwitch: 'CLAUDE_SKIP_TREE_SWEEP', run: sweepPost });
register({ name: 'sweep-stop', events: ['stop'], killSwitch: 'CLAUDE_SKIP_TREE_SWEEP', run: sweepStop });
