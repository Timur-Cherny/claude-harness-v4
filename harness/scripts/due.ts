// Планировщик обязательных прогонов (0 токенов). Порт scripts/due.sh: триггер — накопление
// данных, часы служат потолком (max_interval_days) и полом (min_interval_days).
//   node scripts/due.ts [--root <brain>]            печатает назревшее и неизвестное; всё ok → тишина
//   node scripts/due.ts [--root <brain>] --all      все правила со статусами
//   node scripts/due.ts [--root <brain>] --notify   одна строка для уведомления; пусто = будить не за чем
//   node scripts/due.ts [--root <brain>] --done <rule-id>  отмечает прогон: дата + снимок сигналов
// Спека каденции: <brain>/specs/schedule.json. Состояние — таблица `schedule` в harness.db
// (CLAUDE_STATE_DIR); при первом запуске импортируется прежний schedule-state.json из того же каталога.
// Сигналы считаются по именам файлов и числу строк журналов — содержимое памяти и отчётов не читается;
// единственное исключение — строка `status: open` в шапке чипа (как в bash-оригинале).
// Время: локальные date-only метки (YYYY-MM-DD); UTC-штампы телеметрии сюда не смешиваются.
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from '../src/state.ts';
import type { Gate, GateContext, Verdict } from '../src/types.ts';

export interface Rule {
  id: string; command: string; signal: string;
  trigger: { delta: number }; min_interval_days: number; max_interval_days: number; why?: string;
}
export type Signals = Record<string, number | null>;
export interface Entry { last_run: string | null; first_seen: string | null; signals: Record<string, number> }
export type Status = 'due' | 'unknown' | 'held' | 'ok';
export interface Row { status: Status; rule: Rule; note: string; age: number | null }
export interface Outcome { rc: number; stdout: string; stderr: string }
export interface DueOptions { root: string; stateDir: string; env?: NodeJS.ProcessEnv; now?: () => number }

export const KILL_SWITCH = 'CLAUDE_SKIP_SCHEDULE';
export const GATE_NAME = 'schedule';
export const HEADER = '[расписание] назрело (harness/scripts/due.ts --all · отметить: --done <id>):';
const ORDER: Record<Status, number> = { due: 0, unknown: 1, held: 2, ok: 3 };
const MARK: Record<Status, string> = { due: '▶', unknown: '?', held: '·', ok: '✓' };

/** Локальная дата YYYY-MM-DD (аналог `date +%F`). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Целое число дней от iso до today; null, если метка не разбирается (как в оригинале). */
export function daysBetween(today: string, iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m || !t) return null;
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); const b = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  // Календарная проверка: 2026-02-30 у Date.UTC перетекает в март — оригинал такое отвергает.
  const back = new Date(a);
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return Math.round((b - a) / 86400000);
}

/** Число строк файла или null, если источника нет (null ⇒ unknown, не 0). Считает как python `for _ in fh`. */
export function countLines(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(1 << 16); let n = 0; let last = 0x0a; let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) n++;
      last = buf[read - 1];
    }
    return last === 0x0a ? n : n + 1;
  } finally { closeSync(fd); }
}

function listFiles(dir: string, ext: string): string[] {
  try { return readdirSync(dir).filter((n) => n.endsWith(ext) && statSync(join(dir, n)).isFile()).sort(); } catch { return []; }
}

function chipIsOpen(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(1500); const n = readSync(fd, buf, 0, 1500, 0);
    return buf.subarray(0, n).toString('utf8').split('\n').some((l) => l.trim() === 'status: open');
  } finally { closeSync(fd); }
}

export function signals(root: string, stateDir: string): Signals {
  let notes = 0;
  try {
    for (const sub of readdirSync(join(root, 'memory'))) {
      const d = join(root, 'memory', sub);
      try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
      notes += listFiles(d, '.md').filter((n) => basename(n) !== 'MEMORY.md').length;
    }
  } catch { notes = 0; }
  const chips = listFiles(join(root, 'epics', 'chips'), '.md');
  const openChips = chips.filter((n) => chipIsOpen(join(root, 'epics', 'chips', n))).length;
  return {
    memory_notes: notes ? notes : null,
    friction_events: countLines(join(stateDir, 'personal-friction.jsonl')),
    ai_usage_events: countLines(join(root, 'ai-usage-raw.jsonl')),
    commits_logged: countLines(join(root, 'worklog-commits.jsonl')),
    open_chips: chips.length ? openChips : null,
  };
}

export function loadRules(root: string): { rules: Rule[] } | { error: string } {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'specs', 'schedule.json'), 'utf8')) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) return { error: "ключ 'rules' отсутствует" };
    return { rules: parsed.rules as Rule[] };
  } catch (e) { return { error: (e as Error).message.split('\n')[0] }; }
}

function present(sig: Signals): Record<string, number> {
  return Object.fromEntries(Object.entries(sig).filter(([, v]) => v !== null)) as Record<string, number>;
}

/** Таблица расписания поверх harness.db; объявлена здесь, не в SCHEMA — модуль вне lifecycle. */
export class ScheduleStore {
  readonly state: State;
  private constructor(state: State) { this.state = state; }

  static open(stateDir: string): ScheduleStore {
    const st = State.open(stateDir);
    st.db.exec('CREATE TABLE IF NOT EXISTS schedule(rule_id TEXT PRIMARY KEY, last_run TEXT, first_seen TEXT, signals TEXT NOT NULL DEFAULT \'{}\', updated_at INTEGER)');
    return new ScheduleStore(st);
  }

  /** Первый запуск на пустой таблице подхватывает прежний JSON-файл состояния; повторно не импортируется. */
  importLegacy(stateDir: string, at: number): number {
    const path = join(stateDir, 'schedule-state.json');
    if (!existsSync(path)) return 0;
    return this.state.tx(() => {
      const n = (this.state.db.prepare('SELECT COUNT(*) AS n FROM schedule').get() as { n: number }).n;
      if (n > 0) return 0;
      let legacy: Record<string, Partial<Entry>>;
      try { legacy = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<Entry>>; } catch { return 0; }
      if (typeof legacy !== 'object' || legacy === null) return 0;
      let imported = 0;
      for (const [id, e] of Object.entries(legacy)) {
        if (typeof e !== 'object' || e === null) continue;
        this.put(id, { last_run: typeof e.last_run === 'string' ? e.last_run : null, first_seen: typeof e.first_seen === 'string' ? e.first_seen : null, signals: e.signals && typeof e.signals === 'object' ? e.signals : {} }, at);
        imported++;
      }
      return imported;
    });
  }

  entries(): Map<string, Entry> {
    const rows = this.state.db.prepare('SELECT rule_id, last_run, first_seen, signals FROM schedule').all() as { rule_id: string; last_run: string | null; first_seen: string | null; signals: string }[];
    const out = new Map<string, Entry>();
    for (const r of rows) {
      let s: Record<string, number> = {};
      try { s = JSON.parse(r.signals) as Record<string, number>; } catch { s = {}; }
      out.set(r.rule_id, { last_run: r.last_run, first_seen: r.first_seen, signals: s });
    }
    return out;
  }

  private put(id: string, e: Entry, at: number): void {
    this.state.db.prepare('INSERT INTO schedule(rule_id, last_run, first_seen, signals, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(rule_id) DO UPDATE SET last_run = excluded.last_run, first_seen = excluded.first_seen, signals = excluded.signals, updated_at = excluded.updated_at')
      .run(id, e.last_run, e.first_seen, JSON.stringify(e.signals), at);
  }

  /** Первый показ правила фиксирует якорь, но НЕ выдаёт его за прогон. */
  seed(rules: Rule[], today: string, sig: Signals, at: number): Map<string, Entry> {
    return this.state.tx(() => {
      const have = this.entries();
      for (const r of rules) {
        if (have.has(r.id)) continue;
        this.put(r.id, { last_run: null, first_seen: today, signals: present(sig) }, at);
      }
      return this.entries();
    });
  }

  markDone(id: string, today: string, sig: Signals, at: number): void {
    this.state.tx(() => {
      const prev = this.entries().get(id);
      this.put(id, { last_run: today, first_seen: prev?.first_seen ?? null, signals: present(sig) }, at);
    });
  }

  close(): void { this.state.close(); }
}

/** Чистая оценка: статус каждого правила по контракту specs/schedule.json `_contract`. */
export function evaluate(rules: Rule[], entries: Map<string, Entry>, sig: Signals, today: string): Row[] {
  const rows: Row[] = [];
  for (const r of rules) {
    const e = entries.get(r.id) ?? { last_run: null, first_seen: null, signals: {} };
    const name = r.signal; const cur = sig[name] ?? null;
    const base = Object.hasOwn(e.signals, name) ? e.signals[name] : null;
    const anchor = e.last_run ?? e.first_seen;
    const age = daysBetween(today, anchor);
    if (cur === null) { rows.push({ status: 'unknown', rule: r, note: `источник сигнала ${name} отсутствует`, age }); continue; }
    if (e.last_run === null) {
      const d = base === null ? '' : `, +${cur - base} с ${e.first_seen}`;
      rows.push({ status: 'unknown', rule: r, note: `прогон никогда не отмечался${d}`, age }); continue;
    }
    const delta = base === null ? null : cur - base;
    const overDelta = delta !== null && delta >= r.trigger.delta;
    const overTime = age !== null && age >= r.max_interval_days;
    if (overDelta || overTime) {
      const why: string[] = [];
      if (overDelta) why.push(`+${delta} ${name} (порог ${r.trigger.delta})`);
      if (overTime) why.push(`${age}д с прогона (потолок ${r.max_interval_days})`);
      const held = age !== null && age < r.min_interval_days;
      rows.push({ status: held ? 'held' : 'due', rule: r, note: why.join('; ') + (held ? `; придержано до ${r.min_interval_days}д` : ''), age });
    } else {
      const d = delta === null ? '—' : `+${delta}`;
      rows.push({ status: 'ok', rule: r, note: `${d}/${r.trigger.delta} ${name}, ${age}д/${r.max_interval_days}`, age });
    }
  }
  return rows;
}

export function reportLines(rows: Row[], all: boolean): string[] {
  const shown = rows.filter((x) => all || x.status !== 'ok');
  if (!shown.length) return [];
  const out = [HEADER];
  for (const x of [...shown].sort((a, b) => ORDER[a.status] - ORDER[b.status])) {
    out.push(`  ${MARK[x.status]} ${x.status.padEnd(7)} ${x.rule.command.padEnd(16)} ${x.note}`);
  }
  return out;
}

/** Будить вне сессии стоит только тем, на что можно ответить; unknown наружу идёт, лишь когда висит staleDays. */
export function notifyLine(rows: Row[], staleDays: number): string {
  const ready = rows.filter((x) => x.status === 'due').map((x) => x.rule.command);
  const stale = rows.filter((x) => x.status === 'unknown' && x.age !== null && x.age >= staleDays).map((x) => x.rule.command);
  const parts: string[] = [];
  if (ready.length) parts.push('назрело: ' + ready.join(', '));
  if (stale.length) parts.push(`без отметки ${staleDays}д+: ` + stale.join(', '));
  return parts.join('; ');
}

export type Schedule = { rows: Row[]; today: string } | { error: string };

/** Загрузка + импорт + seed + оценка: общий путь для CLI (report/all/notify) и гейта SessionStart. */
export function schedule(opts: DueOptions): Schedule {
  const loaded = loadRules(opts.root);
  if ('error' in loaded) return { error: loaded.error };
  const now = (opts.now ?? Date.now)(); const today = localDate(now);
  const sig = signals(opts.root, opts.stateDir);
  const store = ScheduleStore.open(opts.stateDir);
  try {
    store.importLegacy(opts.stateDir, now);
    const entries = store.seed(loaded.rules, today, sig, now);
    return { rows: evaluate(loaded.rules, entries, sig, today), today };
  } finally { store.close(); }
}

export function markDone(id: string, opts: DueOptions): Outcome {
  const loaded = loadRules(opts.root);
  if ('error' in loaded) return { rc: 0, stdout: '', stderr: `due: specs/schedule.json нечитаем (${loaded.error}) — расписание неизвестно\n` };
  if (!loaded.rules.some((r) => r.id === id)) return { rc: 2, stdout: '', stderr: `due: правила «${id}» нет в specs/schedule.json\n` };
  const now = (opts.now ?? Date.now)(); const today = localDate(now);
  const store = ScheduleStore.open(opts.stateDir);
  try { store.importLegacy(opts.stateDir, now); store.markDone(id, today, signals(opts.root, opts.stateDir), now); } finally { store.close(); }
  return { rc: 0, stdout: `due: прогон «${id}» отмечен ${today}\n`, stderr: '' };
}

/** CLI без process.exit: аргументы → результат. Ошибка аргументов rc 2; сбой расчёта — rc 0 и объявление «неизвестно». */
export function run(argv: string[], opts: DueOptions): Outcome {
  const args = [...argv];
  let root = opts.root;
  if (args[0] === '--root') { if (!args[1]) return { rc: 2, stdout: '', stderr: 'due: --root требует каталог\n' }; root = args[1]; args.splice(0, 2); }
  const o = { ...opts, root };
  let mode: 'report' | 'all' | 'notify' | 'done' = 'report'; let target: string | undefined;
  if (args[0] === '--all') mode = 'all';
  else if (args[0] === '--notify') mode = 'notify';
  else if (args[0] === '--done') { mode = 'done'; target = args[1]; if (!target) return { rc: 2, stdout: '', stderr: 'due: --done требует id правила\n' }; }
  else if (args.length) return { rc: 2, stdout: '', stderr: `due: неизвестный аргумент ${args[0]}\n` };
  try {
    if (mode === 'done') return markDone(target as string, o);
    const s = schedule(o);
    if ('error' in s) return { rc: 0, stdout: '', stderr: `due: specs/schedule.json нечитаем (${s.error}) — расписание неизвестно\n` };
    if (mode === 'notify') {
      const staleDays = Number((o.env ?? process.env).DUE_NOTIFY_UNKNOWN_DAYS ?? '7');
      const line = notifyLine(s.rows, Number.isNaN(staleDays) ? 7 : staleDays);
      return { rc: 0, stdout: line ? line + '\n' : '', stderr: '' };
    }
    const lines = reportLines(s.rows, mode === 'all');
    return { rc: 0, stdout: lines.length ? lines.join('\n') + '\n' : '', stderr: '' };
  } catch (e) {
    return { rc: 0, stdout: '', stderr: `[расписание] due.ts упал (${(e as Error).message.split('\n')[0]}) — состояние расписания неизвестно\n` };
  }
}

/** Гейт SessionStart для интегратора (не регистрируется здесь): назревшее — context, спека нечитаема — unknown. */
export function decide(ctx: GateContext): Verdict {
  const s = schedule({ root: dirname(ctx.root), stateDir: ctx.stateDir, env: ctx.env, now: ctx.now });
  if ('error' in s) return { kind: 'unknown', reason: `specs/schedule.json нечитаем (${s.error})`, gate: GATE_NAME };
  const lines = reportLines(s.rows, false);
  return lines.length ? { kind: 'context', text: lines.join('\n'), gate: GATE_NAME } : { kind: 'silent' };
}
export const SCHEDULE_GATE: Gate = { name: GATE_NAME, events: ['session-start'], killSwitch: KILL_SWITCH, run: decide };

const isMain = (() => { try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) {
  const brainRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stateDir = process.env.CLAUDE_STATE_DIR ?? join(process.env.HOME ?? '', '.claude', 'exec-telemetry');
  const out = run(process.argv.slice(2), { root: brainRoot, stateDir, env: process.env });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
