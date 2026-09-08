// Детерминированный префильтр старения открытых решений (0 токенов). Порт scripts/friction-prefilter.sh.
//   node scripts/friction-prefilter.ts [--root <brain>] [--registry graph|chips|all]
//   graph (дефолт)  узлы графа + журналы — вход /friction-review
//   chips           находки чипов эпика — домен WMS, у /friction-review другой предмет
//   all             оба реестра под своими заголовками (SessionStart), по 5 строк на реестр
// Печатает открытое старше порога и невыполненные date-обязательства; пустой вывод = эскалировать нечего.
// Порог в днях: FRICTION_AGE_DAYS (14). Отсутствующий каталог реестра — unknown, не тишина (расхождение с bash).
// Regex здесь — над YAML-шапкой заметок и датами в markdown-журналах: у этих строк грамматики нет,
// разбирается только `ключ: значение` и `YYYY-MM-DD`; тело заметок не читается (первые 4000 символов шапки).
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate, daysBetween } from './due.ts';
import type { Gate, GateContext, Verdict } from '../src/types.ts';

export type Registry = 'graph' | 'chips' | 'all';
export interface PrefilterOptions { root: string; ageDays?: number; now?: () => number; env?: NodeJS.ProcessEnv }
export interface Aged { rows: Array<[number, string, string, string]>; noAnchor: string[]; noClose: string[] }
export interface Result { lines: string[]; missing: string[] }
export interface Outcome { rc: number; stdout: string; stderr: string }

export const KILL_SWITCH = 'CLAUDE_SKIP_PREFILTER';
export const GATE_NAME = 'friction-prefilter';
export const DEFAULT_AGE_DAYS = 14;
const REGISTRIES = new Set<string>(['graph', 'chips', 'all']);
const HEAD_BYTES = 4000;
const CAP_IN_ALL = 5;

export function frontmatter(path: string): Record<string, string> | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  let head: string;
  try { const buf = Buffer.alloc(HEAD_BYTES * 4); const n = readSync(fd, buf, 0, buf.length, 0); head = buf.subarray(0, n).toString('utf8').slice(0, HEAD_BYTES); } finally { closeSync(fd); }
  const m = /^---\n([\s\S]*?)\n---/.exec(head);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const l of m[1].split('\n')) {
    const kv = /^(\w[\w_]*):\s*(.*)$/.exec(l);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^"+|"+$/g, '');
  }
  return fm;
}

function mdFiles(dir: string): string[] {
  try { return readdirSync(dir).filter((n) => n.endsWith('.md') && statSync(join(dir, n)).isFile()).sort().map((n) => join(dir, n)); } catch { return []; }
}

/** Общая функция старения: одна на все реестры, чтобы словарь полей не разъезжался. */
export function aged(dir: string, statuses: string[], dateFields: string[], today: string, ageDays: number): Aged {
  const rows: Aged['rows'] = []; const noAnchor: string[] = []; const noClose: string[] = [];
  for (const f of mdFiles(dir)) {
    const fm = frontmatter(f);
    if (fm === null || !statuses.includes(fm.status ?? '')) continue;
    const nid = fm.id || fm.name || basename(f);
    const raw = dateFields.map((k) => fm[k]).find((v) => v) ?? null;
    const a = daysBetween(today, raw);
    if (a === null) { noAnchor.push(nid); continue; }
    if (!fm.close_when) noClose.push(nid);
    if (a >= ageDays) rows.push([a, fm.status as string, nid, fm.close_when || '—']);
  }
  return { rows, noAnchor, noClose };
}

function pad(n: number, w: number): string { return String(n).padStart(w); }

/** Строки одного реестра. В режиме all список подрезан: SessionStart — сводка, не отчёт. */
export function render(title: string, key: 'graph' | 'chips', a: Aged, reg: Registry, ageDays: number): string[] {
  const out: string[] = [];
  // Порядок python `sorted(rows, reverse=True)`: по возрасту, при равенстве — по статусу и id в обратном порядке.
  const ordered = [...a.rows].sort((x, y) => y[0] - x[0] || (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0) || (y[2] > x[2] ? 1 : y[2] < x[2] ? -1 : 0));
  const cap = reg === 'all' ? CAP_IN_ALL : ordered.length;
  for (const [age, st, nid, cw] of ordered.slice(0, cap)) out.push(`${pad(age, 4)}д  ${st.padEnd(10)} ${nid}  close_when: ${cw.slice(0, 110)}`);
  if (ordered.length > cap) out.push(`      …и ещё ${ordered.length - cap} старше ${ageDays}д (harness/scripts/friction-prefilter.ts --registry ${key})`);
  if (a.noAnchor.length) out.push(`      без даты  ${title}: ${a.noAnchor.length} шт — состарить нечем (${a.noAnchor.slice(0, 3).join(', ')}${a.noAnchor.length > 3 ? '…' : ''})`);
  if (a.noClose.length) out.push(`      без close_when  ${title}: ${a.noClose.length} шт — условие закрытия не задано, закрыть будет нечем`);
  return out;
}

function readText(path: string): string | null { try { return readFileSync(path, 'utf8'); } catch { return null; } }

/** Журналы с date-обязательством: пустые плейсхолдеры либо просроченный «Следующий замер»; спека в статусе «ждёт». */
export function journalLines(root: string, today: string, ageDays: number): string[] {
  const buf: string[] = [];
  const ev = readText(join(root, 'graph', 'EVAL.md'));
  if (ev !== null) {
    const m = /\*\*Обязательство:\*\*[\s\S]*?от (\d{4}-\d{2}-\d{2})/.exec(ev);
    if (m && /^\|\s*—\s*\|/m.test(ev)) {
      const a = daysBetween(today, m[1]);
      if (a !== null && a >= ageDays) buf.push(`${pad(a, 4)}д  журнал     graph/EVAL.md  baseline/прогоны не сняты (обязательство от ${m[1]})`);
    }
    const n = /\*\*Следующий замер: (\d{4}-\d{2}-\d{2})\*\*/.exec(ev);
    if (n) {
      const a = daysBetween(today, n[1]);
      if (a !== null && a > 0) buf.push(`${pad(a, 4)}д  журнал     graph/EVAL.md  «Следующий замер» просрочен (был назначен на ${n[1]})`);
    }
  }
  const sp = readText(join(root, 'specs', 'SPEC_FRICTION_LEDGER.md'));
  if (sp !== null) {
    const m = /\*\*Дата:\*\*\s*(\d{4}-\d{2}-\d{2})\s*·\s*\*\*Статус:\*\*\s*([^·\n]+)/.exec(sp);
    if (m && (m[2].includes('ждёт') || m[2].includes('🟡'))) {
      const a = daysBetween(today, m[1]);
      if (a !== null && a >= ageDays) buf.push(`${pad(a, 4)}д  спека      SPEC_FRICTION_LEDGER.md  статус «${m[2].trim()}» не пересматривался`);
    }
  }
  return buf;
}

export function prefilter(reg: Registry, opts: PrefilterOptions): Result {
  const today = localDate((opts.now ?? Date.now)());
  const env = opts.env ?? process.env;
  const fromEnv = Number(env.FRICTION_AGE_DAYS ?? NaN);
  const ageDays = opts.ageDays ?? (Number.isInteger(fromEnv) ? fromEnv : DEFAULT_AGE_DAYS);
  const lines: string[] = []; const missing: string[] = [];
  if (reg === 'graph' || reg === 'all') {
    const dir = join(root(opts), 'graph', 'incidents');
    if (!existsSync(dir)) missing.push('graph/incidents');
    else {
      const buf = render('граф', 'graph', aged(dir, ['open', 'candidate'], ['last_verified', 'discovered'], today, ageDays), reg, ageDays);
      buf.push(...journalLines(root(opts), today, ageDays));
      if (buf.length) { if (reg === 'all') lines.push('— граф инцидентов —'); lines.push(...buf); }
    }
  }
  if (reg === 'chips' || reg === 'all') {
    const dir = join(root(opts), 'epics', 'chips');
    if (!existsSync(dir)) missing.push('epics/chips');
    else {
      const buf = render('чипы', 'chips', aged(dir, ['open'], ['discovered'], today, ageDays), reg, ageDays);
      if (buf.length) { if (reg === 'all') lines.push('— чипы эпика (домен WMS) —'); lines.push(...buf); }
    }
  }
  return { lines, missing };
}
const root = (o: PrefilterOptions) => o.root;

export function run(argv: string[], opts: PrefilterOptions): Outcome {
  const args = [...argv]; let r = opts.root;
  if (args[0] === '--root') { if (!args[1]) return { rc: 2, stdout: '', stderr: 'prefilter: --root требует каталог\n' }; r = args[1]; args.splice(0, 2); }
  let reg = 'graph';
  if (args.length) {
    if (args[0] !== '--registry') return { rc: 2, stdout: '', stderr: `prefilter: неизвестный аргумент ${args[0]}\n` };
    if (!args[1]) return { rc: 2, stdout: '', stderr: 'prefilter: --registry без значения\n' };
    reg = args[1];
  }
  if (!REGISTRIES.has(reg)) return { rc: 2, stdout: '', stderr: `prefilter: неизвестный реестр ${reg}\n` };
  const res = prefilter(reg as Registry, { ...opts, root: r });
  const stderr = res.missing.map((m) => `prefilter: реестр ${m} отсутствует — старение неизвестно\n`).join('');
  return { rc: 0, stdout: res.lines.length ? res.lines.join('\n') + '\n' : '', stderr };
}

/** Гейт SessionStart для интегратора (не регистрируется здесь): сводка `all` — context; нет каталога реестра — unknown. */
export function decide(ctx: GateContext): Verdict {
  const res = prefilter('all', { root: dirname(ctx.root), env: ctx.env, now: ctx.now });
  if (res.missing.length) return { kind: 'unknown', reason: `реестр отсутствует: ${res.missing.join(', ')}`, gate: GATE_NAME };
  return res.lines.length ? { kind: 'context', text: res.lines.join('\n'), gate: GATE_NAME } : { kind: 'silent' };
}
export const PREFILTER_GATE: Gate = { name: GATE_NAME, events: ['session-start'], killSwitch: KILL_SWITCH, run: decide };

const isMain = (() => { try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; } })();
if (isMain) {
  const out = run(process.argv.slice(2), { root: join(dirname(fileURLToPath(import.meta.url)), '..', '..'), env: process.env });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.rc);
}
