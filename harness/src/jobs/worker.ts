// Detached-воркер дорогих проверок. Задачу берёт по job_id, kill-switch'и читает из строки задачи
// (env постановщика), не из своего окружения; живость — pid + TTL; результат пишет в verified/findings,
// и его заберёт следующее событие сессии (или Stop, который дренирует синхронно).
import os from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../checks/index.ts';
import { CHECKERS } from '../checks/registry.ts';
import { State } from '../state.ts';
import { generation } from '../contour.ts';
import { digestOf, recordResult } from '../sweep.ts';
import type { ChangedFile } from '../checks/types.ts';

export const JOB_TTL_MS = 15 * 60 * 1000;

export async function runJob(state: State, jobId: string, env: NodeJS.ProcessEnv, root: string, now: () => number = Date.now, deadlineMs = Infinity): Promise<'done' | 'failed' | 'missing' | 'taken'> {
  const job = state.db.prepare('SELECT repo, kind, status, skips, pid, started_at FROM jobs WHERE job_id = ?').get(jobId) as { repo: string; kind: string; status: string; skips: string; pid: number | null; started_at: number } | undefined;
  if (!job) return 'missing';
  if (job.status === 'done') return 'taken';
  if (job.status === 'running' && job.pid && alive(job.pid) && now() - job.started_at < JOB_TTL_MS) return 'taken';
  state.db.prepare("UPDATE jobs SET status = 'running', pid = ?, started_at = ? WHERE job_id = ?").run(process.pid, now(), jobId);
  const skips: string[] = JSON.parse(job.skips || '[]');
  const checker = CHECKERS.find((c) => c.name === job.kind);
  const gen = generation(root);
  const files = state.db.prepare('SELECT path, digest FROM job_files WHERE job_id = ?').all(jobId) as Array<{ path: string; digest: string }>;
  let rc = 0;
  for (const f of files) {
    const abs = join(job.repo, f.path);
    if (!existsSync(abs)) continue;
    let digest: string; try { digest = digestOf(abs); } catch { continue; }
    if (digest !== f.digest) continue; // файл ушёл дальше — его проверит следующая сверка
    const file: ChangedFile = { repo: job.repo, path: f.path, absPath: abs, digest, status: 'M' };
    if (!checker) { recordResult(state, file, job.kind, gen, { verdict: 'unknown', missing_reason: `проверка ${job.kind} не зарегистрирована в этом поколении` }, now()); rc = 1; continue; }
    if (skips.includes(checker.killSwitch)) continue;
    let r; try { r = await checker.run(file, { env, stateDir: env.CLAUDE_STATE_DIR ?? '', now, deadlineMs }); } catch (e) { r = { verdict: 'unknown' as const, missing_reason: (e as Error).message.split('\n')[0] }; }
    if (r.verdict !== 'pass') rc = 1;
    recordResult(state, file, checker.name, gen, r, now());
  }
  state.db.prepare("UPDATE jobs SET status = 'done', finished_at = ?, rc = ? WHERE job_id = ?").run(now(), rc, jobId);
  return rc === 0 ? 'done' : 'failed';
}

export function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Задачи репозитория, ещё не завершённые; протухшие (владелец мёртв или TTL) перезахватываются вызывающим. */
export function pendingJobs(state: State, repo: string, now: number): string[] {
  const rows = state.db.prepare("SELECT job_id, status, pid, started_at FROM jobs WHERE repo = ? AND status IN ('claimed','running')").all(repo) as Array<{ job_id: string; status: string; pid: number | null; started_at: number }>;
  void now;
  return rows.map((r) => r.job_id); // живость и TTL решает runJob: живой владелец → 'taken', мёртвый или протухший → перезахват
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { os.setPriority(19); } catch { /* не критично */ }
  const stateDir = process.env.CLAUDE_STATE_DIR ?? join(process.env.HOME ?? '', '.claude', 'exec-telemetry');
  const root = process.env.HARNESS_ROOT ?? fileURLToPath(new URL('../..', import.meta.url));
  const state = State.open(stateDir);
  runJob(state, process.argv[2] ?? '', process.env, root).then((r) => { state.close(); process.exit(r === 'failed' ? 1 : 0); }, () => { state.close(); process.exit(1); });
}
