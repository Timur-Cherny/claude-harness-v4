// SessionStart: свежесть детерминированных проверок репозитория — коротко в контекст сессии.
// (1) Инвентарь README между маркерами inventory:begin/end пересчитывается из файлов и сравнивается
//     с записанным: дрейф → строка «обновить --sync». README не правится (только --check оригинала).
// (2) Расписание обязательных прогонов (specs/schedule.json + $CLAUDE_STATE_DIR/schedule-state.json) —
//     ТОЛЬКО чтение: статусы due/held/unknown печатаются, состояние не сеется и не отмечается
//     (--done/--notify — за CLI harness/scripts/due.ts). Нет отметки о прогоне → unknown, не ok.
// Корень проекта — $CLAUDE_PROJECT_DIR, иначе toplevel(cwd). Репозиторий без маркеров и без спеки — тишина.
// Regex — по строкам без грамматики: путь хука в строке settings.json, строка `status: open` в шапке чипа.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { register } from '../gates/registry.ts';
import { toplevel } from '../git.ts';
import { lineCount, localDate, daysBetween } from './common.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'session-start';
export const KILL = 'CLAUDE_SKIP_SESSION_START';

// ---------- инвентарь README ----------

function listDir(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
function walkMd(dir: string): number {
  let n = 0;
  for (const e of listDir(dir)) { const p = join(dir, e); if (isDir(p)) n += walkMd(p); else if (e.endsWith('.md') && isFile(p)) n++; }
  return n;
}
function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => jsonStrings(x, out));
  return out;
}

/** Пять строк блока «Проверенный состав» — те же формулировки, что в scripts/readme-inventory.sh. */
export function inventoryData(root: string): string[] {
  const hooks = listDir(join(root, 'hooks')).filter((f) => f.endsWith('.sh') && isFile(join(root, 'hooks', f))).sort();
  let settings: unknown = null;
  try { settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')); } catch { settings = null; }
  const wired = new Set<string>();
  for (const s of jsonStrings(settings)) if (/hooks\/[^ ]+\.sh/.test(s)) for (const m of s.matchAll(/[^/ ]+\.sh/g)) wired.add(m[0]);
  const unwired = hooks.filter((h) => !wired.has(h)).map((h) => `\`${h}\``).join(', ');
  const agents = listDir(join(root, 'agents')).filter((f) => f.endsWith('.md') && isFile(join(root, 'agents', f))).length;
  const skills = listDir(join(root, 'skills')).filter((d) => isDir(join(root, 'skills', d)) && !d.endsWith('-workspace')).length;
  const memRoots = listDir(join(root, 'memory')).filter((d) => isDir(join(root, 'memory', d))).length;
  const memFiles = walkMd(join(root, 'memory'));
  return [
    `- \`hooks/*.sh\`: ${hooks.length}; из них ${wired.size} подключены в \`settings.json\`;`,
    `- не зарегистрированы как lifecycle hooks: ${unwired || '—'};`,
    `- \`agents/*.md\`: ${agents};`,
    `- верхнеуровневых authored skills: ${skills};`,
    `- project-memory roots: ${memRoots}, файлов памяти: ${memFiles}.`,
  ];
}

export type ReadmeDrift = { status: 'absent' } | { status: 'ok' } | { status: 'drift'; was: string[]; now: string[] };

export function readmeDrift(root: string): ReadmeDrift {
  let readme: string;
  try { readme = readFileSync(join(root, 'README.md'), 'utf8'); } catch { return { status: 'absent' }; }
  const lines = readme.split('\n');
  const b = lines.findIndex((l) => l.includes('<!-- inventory:begin')); const e = lines.findIndex((l) => l.includes('<!-- inventory:end'));
  if (b < 0 || e < 0 || e <= b) return { status: 'absent' };
  const was = lines.slice(b + 1, e).filter((l) => l !== '' && !l.startsWith('Снимок'));
  const now = inventoryData(root);
  return was.join('\n') === now.join('\n') ? { status: 'ok' } : { status: 'drift', was, now };
}

// ---------- расписание (только чтение) ----------

interface Rule { id: string; command: string; signal: string; trigger: { delta: number }; min_interval_days: number; max_interval_days: number }
interface Entry { last_run?: string | null; first_seen?: string | null; signals?: Record<string, number> }
export type RowStatus = 'due' | 'held' | 'unknown' | 'ok';
export interface ScheduleRow { status: RowStatus; rule: Rule; note: string }
export type Schedule = { kind: 'absent' } | { kind: 'unreadable'; error: string } | { kind: 'rows'; rows: ScheduleRow[] };

export function signals(root: string, stateDir: string): Record<string, number | null> {
  let notes = 0;
  for (const r of listDir(join(root, 'memory'))) { const d = join(root, 'memory', r); if (!isDir(d)) continue; notes += listDir(d).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && isFile(join(d, f))).length; }
  const chipsDir = join(root, 'epics', 'chips');
  const chips = listDir(chipsDir).filter((f) => f.endsWith('.md') && isFile(join(chipsDir, f)));
  let open = 0;
  for (const c of chips) { try { if (readFileSync(join(chipsDir, c), 'utf8').slice(0, 1500).split('\n').some((l) => l.trim() === 'status: open')) open++; } catch { /* нечитаемый чип — не открытый */ } }
  return {
    memory_notes: notes || null,
    friction_events: lineCount(join(stateDir, 'personal-friction.jsonl')),
    ai_usage_events: lineCount(join(root, 'ai-usage-raw.jsonl')),
    commits_logged: lineCount(join(root, 'worklog-commits.jsonl')),
    open_chips: chips.length ? open : null,
  };
}

export function scheduleReport(root: string, stateDir: string, today: string): Schedule {
  const specPath = join(root, 'specs', 'schedule.json');
  if (!isFile(specPath)) return { kind: 'absent' };
  let rules: Rule[];
  try {
    const parsed = JSON.parse(readFileSync(specPath, 'utf8')) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) throw new Error('нет массива rules');
    rules = parsed.rules as Rule[];
  } catch (e) { return { kind: 'unreadable', error: (e as Error).message.split('\n')[0] }; }
  let state: Record<string, Entry> = {};
  try { const raw = readFileSync(join(stateDir, 'schedule-state.json'), 'utf8'); state = raw.trim() ? JSON.parse(raw) as Record<string, Entry> : {}; } catch { state = {}; }
  const sig = signals(root, stateDir);
  const rows: ScheduleRow[] = [];
  for (const r of rules) {
    const e = state[r.id] ?? {};
    const cur = sig[r.signal] ?? null;
    const base = e.signals?.[r.signal];
    const age = daysBetween(e.last_run ?? e.first_seen ?? null, today);
    if (cur === null) { rows.push({ status: 'unknown', rule: r, note: `источник сигнала ${r.signal} отсутствует` }); continue; }
    if (!e.last_run) { rows.push({ status: 'unknown', rule: r, note: `прогон никогда не отмечался${base === undefined ? '' : `, +${cur - base} с ${e.first_seen ?? '?'}`}` }); continue; }
    const delta = base === undefined ? null : cur - base;
    const overDelta = delta !== null && delta >= r.trigger.delta;
    const overTime = age !== null && age >= r.max_interval_days;
    if (overDelta || overTime) {
      const why: string[] = [];
      if (overDelta) why.push(`+${delta} ${r.signal} (порог ${r.trigger.delta})`);
      if (overTime) why.push(`${age}д с прогона (потолок ${r.max_interval_days})`);
      const held = age !== null && age < r.min_interval_days;
      rows.push({ status: held ? 'held' : 'due', rule: r, note: why.join('; ') + (held ? `; придержано до ${r.min_interval_days}д` : '') });
    } else rows.push({ status: 'ok', rule: r, note: `${delta === null ? '—' : `+${delta}`}/${r.trigger.delta} ${r.signal}, ${age}д/${r.max_interval_days}` });
  }
  return { kind: 'rows', rows };
}

const ORDER: Record<RowStatus, number> = { due: 0, unknown: 1, held: 2, ok: 3 };
const MARK: Record<RowStatus, string> = { due: '▶', unknown: '?', held: '·', ok: '✓' };

export function renderSchedule(rows: ScheduleRow[]): string[] {
  const shown = rows.filter((r) => r.status !== 'ok').sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  if (!shown.length) return [];
  return ['[расписание] назрело (harness/scripts/due.ts --all · отметить: --done <id>):', ...shown.map((r) => `  ${MARK[r.status]} ${r.status.padEnd(7)} ${r.rule.command.padEnd(16)} ${r.note}`)];
}

export function decide(ctx: GateContext): Verdict {
  const root = ctx.env.CLAUDE_PROJECT_DIR || toplevel(ctx.payload.cwd) || ctx.payload.cwd;
  if (!isDir(root)) return { kind: 'unknown', reason: 'корень проекта не существует', gate: NAME };
  const out: string[] = [];
  const drift = readmeDrift(root);
  if (drift.status === 'drift') {
    out.push('readme-inventory: блок «Проверенный состав» разошёлся с фактом. Обновить: scripts/readme-inventory.sh --sync');
    const n = Math.max(drift.was.length, drift.now.length);
    for (let i = 0; i < n && out.length < 13; i++) if (drift.was[i] !== drift.now[i]) { if (drift.was[i] !== undefined) out.push(`< ${drift.was[i]}`); if (drift.now[i] !== undefined) out.push(`> ${drift.now[i]}`); }
  }
  const sched = scheduleReport(root, ctx.stateDir, localDate(ctx.now()));
  if (sched.kind === 'rows') out.push(...renderSchedule(sched.rows));
  if (out.length) {
    if (sched.kind === 'unreadable') out.push(`[расписание] specs/schedule.json нечитаем (${sched.error}) — расписание неизвестно`);
    return { kind: 'context', text: out.join('\n'), gate: NAME };
  }
  if (sched.kind === 'unreadable') return { kind: 'unknown', reason: `specs/schedule.json нечитаем (${sched.error}) — расписание неизвестно`, gate: NAME };
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['session-start'], killSwitch: KILL, run: decide };
register(gate);
