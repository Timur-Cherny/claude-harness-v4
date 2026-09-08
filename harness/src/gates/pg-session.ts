// pg-session — порт hooks/pg-session-state-guard.sh на AST (класс К1: INC-PG-READONLY-BYPASS).
// Барьер и лимит к Postgres нельзя держать СОСТОЯНИЕМ СОЕДИНЕНИЯ: за пулером в transaction-режиме
// серверный бэкенд уходит в пул к чужим клиентам вместе с настройкой (прод 28.08 — 20 минут отказов
// записи), а startup-параметр options=-c пулер отбивает как FATAL 08P01. Правила — над узлами parseSql,
// не над текстом: SET в комментарии и строковом литерале узлом не является и не считается.
//
// Regex в модуле объявлен и ограничен строками БЕЗ SQL-грамматики:
//   · позиция ключевого слова в чужом документе (YAML/JSON/TS/shell), чтобы вырезать кандидата —
//     вердикт по кандидату выносит только AST, нераспарсенный кандидат вердикта не даёт;
//   · ключ options / PGOPTIONS в конфиге вида key: value и в conninfo key=value;
//   · имена файлов (расширение, каталоги спек).
import { readFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { register } from './registry.ts';
import { tokenize } from '../parsers/shell.ts';
import { parseSql, stmtKind, stmtNode, walk } from '../parsers/sql.ts';
import type { Node, RawStmt } from '../parsers/sql.ts';
import type { GateContext, PreToolUsePayload, Verdict } from '../types.ts';

export const NAME = 'pg-session';
export const KILL = 'CLAUDE_SKIP_PG_SESSION_GUARD';

/** GUC, которые за пулером держат барьер или лимит состоянием сессии. */
export const GUCS: ReadonlySet<string> = new Set([
  'default_transaction_read_only', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
]);

export type Judgement = { kind: 'clean' } | { kind: 'deny'; reason: string } | { kind: 'unknown'; reason: string };
const CLEAN: Judgement = { kind: 'clean' };
const deny = (reason: string): Judgement => ({ kind: 'deny', reason });
const unknown = (reason: string): Judgement => ({ kind: 'unknown', reason });
const RANK = { clean: 0, unknown: 1, deny: 2 } as const;
export function worst(a: Judgement, b: Judgement): Judgement { return RANK[b.kind] > RANK[a.kind] ? b : a; }

export const HINT = [
  'Чем держать вместо этого:',
  '  • только чтение   → права роли: GRANT SELECT без INSERT/UPDATE/DELETE (каталог прав, не протекает)',
  '  • разовая сессия  → BEGIN TRANSACTION READ ONLY + SET LOCAL (умирает на ROLLBACK)',
  '  • таймаут запроса → на стороне клиента (jsonData.queryTimeout у датасорса Grafana)',
  `Осознанное изменение прод-роли выполняет владелец базы. Kill-switch: ${KILL}=1`,
].join('\n');

// ───────────────────────────── правила над AST ─────────────────────────────

interface SetNode { kind?: string; name?: string; is_local?: boolean }

function judgeSet(set: SetNode): Judgement {
  if (!set.name || !GUCS.has(set.name)) return CLEAN;
  if (set.is_local) return CLEAN;
  if (set.kind === 'VAR_RESET' || set.kind === 'VAR_RESET_ALL' || set.kind === 'VAR_SET_DEFAULT') return CLEAN;
  return deny(`сессионный SET ${set.name} без LOCAL: настройка остаётся на серверном бэкенде и уезжает за пулер`);
}

function judgeCatalogSet(kind: string, node: Node): Judgement {
  const set = (node.setstmt ?? {}) as SetNode;
  if (set.kind === 'VAR_SET_VALUE' || set.kind === 'VAR_SET_CURRENT') {
    return deny(`ALTER ${kind === 'AlterRoleSetStmt' ? 'ROLE' : 'DATABASE'} … SET ${set.name ?? ''}: сессионный GUC в каталоге pg_db_role_setting, применяется на старте каждого соединения`);
  }
  return CLEAN; // RESET / RESET ALL / SET … TO DEFAULT снимают настройку
}

function literalString(arg: unknown): string | null {
  const c = (arg as { A_Const?: { sval?: { sval?: string } } })?.A_Const;
  return typeof c?.sval?.sval === 'string' ? c.sval.sval : null;
}
function literalBool(arg: unknown): boolean | null {
  const c = (arg as { A_Const?: { boolval?: { boolval?: boolean } } })?.A_Const;
  return typeof c?.boolval === 'object' && c.boolval !== null ? Boolean(c.boolval.boolval) : null;
}

/** set_config(guc, value, is_local) в любом месте дерева: is_local=true умирает с транзакцией, остальное — сессия. */
function judgeFuncCalls(root: unknown): Judgement {
  let out: Judgement = CLEAN;
  for (const n of walk(root)) {
    if (!('FuncCall' in n)) continue;
    const fc = n.FuncCall as { funcname?: Array<{ String?: { sval?: string } }>; args?: unknown[] };
    const fname = fc.funcname?.at(-1)?.String?.sval?.toLowerCase();
    if (fname !== 'set_config') continue;
    const args = fc.args ?? [];
    if (literalBool(args[2]) === true) continue;
    const guc = literalString(args[0]);
    if (guc === null) { out = worst(out, unknown('set_config с нелитеральным именем GUC — доказать безопасность нельзя')); continue; }
    if (!GUCS.has(guc)) continue;
    const how = literalBool(args[2]) === false ? 'is_local=false' : 'is_local не литерал';
    out = worst(out, deny(`set_config('${guc}', …, ${how}): сессионный GUC через функцию`));
  }
  return out;
}

export function judgeStmts(stmts: RawStmt[]): Judgement {
  let out: Judgement = CLEAN;
  const prepared = new Set<string>();
  for (const s of stmts) {
    const kind = stmtKind(s);
    const node = stmtNode<Node>(s) ?? {};
    switch (kind) {
      case 'VariableSetStmt': out = worst(out, judgeSet(node as SetNode)); break;
      case 'AlterRoleSetStmt': case 'AlterDatabaseSetStmt': out = worst(out, judgeCatalogSet(kind, node)); break;
      case 'DoStmt': out = worst(out, deny('DO-блок: тело непрозрачно для парсера (внутри может быть EXECUTE с SET)')); break;
      case 'PrepareStmt': prepared.add(String(node.name ?? '')); break;
      case 'ExecuteStmt':
        // PREPARE из того же пакета уже проверен на set_config; чужой — тело непрозрачно.
        if (!prepared.has(String(node.name ?? ''))) out = worst(out, deny(`EXECUTE ${String(node.name ?? '')}: тело подготовленного запроса непрозрачно (PREPARE вне видимого пакета)`));
        break;
      default: break;
    }
    out = worst(out, judgeFuncCalls(s.stmt));
  }
  return out;
}

export async function judgeSql(sql: string): Promise<Judgement> {
  const p = await parseSql(sql);
  if (p.error) return unknown(`SQL не разобран (${p.error.split('\n')[0]}) — доказать безопасность нельзя`);
  return judgeStmts(p.stmts);
}

// ───────────────────────────── строка подключения ─────────────────────────────

const URL_SCHEMES = ['postgresql://', 'postgres://'];

/** Значение ключа в conninfo `k=v k2='v 2'` (libpq keyword/value form). */
export function conninfoValue(s: string, key: string): string | null {
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const eq = s.indexOf('=', i);
    if (eq < 0) return null;
    const k = s.slice(i, eq).trim();
    i = eq + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
    let v = '';
    if (s[i] === "'") {
      i++;
      while (i < s.length && s[i] !== "'") { if (s[i] === '\\' && i + 1 < s.length) i++; v += s[i]; i++; }
      i++;
    } else { while (i < s.length && !/\s/.test(s[i])) { v += s[i]; i++; } }
    if (k === key) return v;
  }
  return null;
}

function stripQuotes(v: string): string { return v.replace(/^["']+|["']+$/g, '').trim(); }
const startsWithDashC = (v: string): boolean => /^-c(\s|=|$)/.test(stripQuotes(v));

/** Один токен: URL postgres://, conninfo с options=, PGOPTIONS=… */
export function judgeConnToken(t: string): Judgement {
  if (t.startsWith('PGOPTIONS=')) {
    return startsWithDashC(t.slice('PGOPTIONS='.length)) ? deny('PGOPTIONS=-c: startup-параметр соединения, пулер отбивает как FATAL 08P01') : CLEAN;
  }
  const at = URL_SCHEMES.map((s) => t.indexOf(s)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at !== undefined) {
    let url: URL;
    try { url = new URL(stripQuotes(t.slice(at))); } catch { return unknown('строка подключения postgres:// не разобрана как URL'); }
    if (url.searchParams.getAll('options').some(startsWithDashC)) return deny('options=-c в строке подключения: startup-параметр, пулер отбивает как FATAL 08P01');
    return CLEAN;
  }
  if (t.includes('options=')) {
    const v = conninfoValue(t, 'options');
    if (v !== null && startsWithDashC(v)) return deny("options='-c …' в conninfo: startup-параметр, пулер отбивает как FATAL 08P01");
  }
  return CLEAN;
}

// ───────────────────────────── pre-bash: откуда берётся SQL ─────────────────────────────

const PSQL_LIKE = new Set(['psql', 'pgcli']);
const PG_TOOLS = new Set(['psql', 'pgcli', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pgbench']);
const VALUE_SHORT = new Set(['c', 'd', 'f', 'h', 'p', 'U', 'v', 'F', 'L', 'o', 'P', 'R', 'T']);
const VALUE_LONG = new Set(['command', 'dbname', 'file', 'host', 'port', 'username', 'set', 'variable', 'field-separator', 'log-file', 'output', 'pset', 'record-separator', 'table-attr']);

const base = (t: string): string => t.split('/').pop() ?? t;
function isPgToken(t: string): boolean {
  return PG_TOOLS.has(base(t)) || t.startsWith('PGPASSWORD=') || t.startsWith('PGOPTIONS=') || URL_SCHEMES.some((s) => t.includes(s));
}

function describeUnknown(tags: string[]): string {
  const m: Record<string, string> = {
    'here-doc': 'ограничитель here-doc не разобран — тело недоступно',
    'here-doc-unterminated': 'here-doc без ограничителя — тело неизвестно целиком',
    'here-doc-expansion': 'в теле here-doc подстановка ($…/`…`) — итоговый SQL неизвестен',
    'here-string': 'тело SQL приходит через here-string <<< — недоступно',
    'command-substitution': 'подстановка $(…)/`…` — тело недоступно',
    'nested-shell-depth': 'вложенная оболочка глубже одного уровня',
    'unterminated-single-quote': 'незакрытая одинарная кавычка',
    'unterminated-double-quote': 'незакрытая двойная кавычка',
  };
  return tags.map((t) => m[t] ?? t).join('; ');
}

type SqlSource = { kind: 'inline'; sql: string } | { kind: 'file'; path: string } | { kind: 'stdin' };

/** Аргументы после токена psql/pgcli → источники SQL. */
export function psqlSources(args: string[]): SqlSource[] {
  const out: SqlSource[] = [];
  const opt = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (name === 'c' || name === 'command') out.push({ kind: 'inline', sql: value });
    if (name === 'f' || name === 'file') out.push(value === '-' ? { kind: 'stdin' } : { kind: 'file', path: value });
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') break;
    if (t === '<') { if (args[i + 1] !== undefined) out.push({ kind: 'file', path: args[++i] }); continue; }
    if (t.startsWith('<') && !t.startsWith('<<')) { out.push({ kind: 'file', path: t.slice(1) }); continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (!VALUE_LONG.has(name)) continue;
      opt(name, eq < 0 ? args[++i] : t.slice(eq + 1));
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (!VALUE_SHORT.has(c)) continue;
        const attached = t.slice(k + 1);
        opt(c, attached.length ? attached : args[++i]);
        break;
      }
    }
  }
  return out;
}

export async function judgeCommand(command: string, cwd: string): Promise<Judgement> {
  const parse = tokenize(command);
  if (!parse.segments.some((s) => s.argv.some(isPgToken))) return CLEAN;
  let out: Judgement = CLEAN;
  // Соединение и PGOPTIONS — в любом сегменте и месте, в том числе за `kubectl exec pod -- psql`.
  for (const seg of parse.segments) for (const t of seg.argv) out = worst(out, judgeConnToken(t));
  if (parse.unknown.length) out = worst(out, unknown(describeUnknown(parse.unknown)));
  for (let i = 0; i < parse.segments.length; i++) {
    const seg = parse.segments[i];
    const at = seg.argv.findIndex((t) => PSQL_LIKE.has(base(t)));
    if (at < 0) continue;
    const sources = psqlSources(seg.argv.slice(at + 1));
    const fedByPipe = parse.segments.slice(0, i).some((s) => s.depth === seg.depth);
    // Here-doc — обычная форма вызова psql, и его тело разобрано: судим SQL, а не отвечаем «недоступно».
    // Редирект стоит над каналом, поэтому при своём here-doc труба слева на stdin уже не влияет.
    for (const body of seg.heredocs) out = worst(out, await judgeSql(body));
    if (!sources.length) {
      if (fedByPipe && !seg.heredocs.length) out = worst(out, unknown('SQL приходит на stdin из другой команды — тело недоступно'));
      continue; // psql -l / --version / интерактивный без тела: операторов нет
    }
    for (const src of sources) {
      if (src.kind === 'stdin') {
        if (!seg.heredocs.length) out = worst(out, unknown('psql -f - читает stdin — тело недоступно'));
        continue; // -f - со своим here-doc: тело уже оценено выше
      }
      if (src.kind === 'inline') { out = worst(out, await judgeSql(src.sql)); continue; }
      let text: string;
      try { text = readFileSync(resolve(cwd, src.path), 'utf8'); } catch { out = worst(out, unknown(`файл SQL не прочитан: ${basename(src.path)}`)); continue; }
      out = worst(out, await judgeSql(text));
    }
  }
  return out;
}

// ───────────────────────────── pre-write: SQL внутри записываемого файла ─────────────────────────────

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
/** Текст, описывающий конструкцию, и спеки самого гейта (обязаны содержать нарушение) — не исполнение. */
export function exemptPath(path: string): boolean {
  if (DOC_EXT.has(extname(path).toLowerCase())) return true;
  if (path.includes('/hooks/spec/')) return true;
  return /\.(test|spec)\.(ts|js|mjs|cjs|sh)$/.test(basename(path));
}

const SQL_EXT = new Set(['.sql', '.psql', '.pgsql']);
const STMT_KEYWORD = /\b(with|select|insert|update|delete|merge|create|alter|drop|grant|revoke|set|reset|do|execute|prepare|begin|start|commit|call|truncate|comment)\b/gi;
const OPTIONS_KEY = /(?:^|[^A-Za-z0-9_])["']?(?:pg)?options["']?\s*[:=]\s*["']?\s*-c(?=[\s=]|$)/i;
const TRAILING_JUNK = new Set(["'", '"', '`', ';', ',', ')', ']', '}', '\\']);
const MAX_STRIPS = 8;

async function parseCandidate(text: string): Promise<RawStmt[] | null> {
  let cand = text.trimEnd();
  for (let n = 0; n <= MAX_STRIPS && cand.length; n++) {
    const p = await parseSql(cand);
    if (!p.error && p.stmts.length) return p.stmts;
    if (!TRAILING_JUNK.has(cand[cand.length - 1])) return null;
    cand = cand.slice(0, -1).trimEnd();
  }
  return null;
}

/** DO с dollar-quoted телом может занимать несколько строк: вырезаем по парному тегу. */
function dollarBlock(text: string, from: number): string | null {
  const m = /^do\s*(\$[A-Za-z_]*\$)/i.exec(text.slice(from));
  if (!m) return null;
  const tag = m[1];
  const open = from + m[0].length;
  const close = text.indexOf(tag, open);
  if (close < 0) return null;
  return text.slice(from, close + tag.length);
}

function balancedCall(text: string, open: number): string | null {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')') { depth--; if (depth === 0) return text.slice(open, k + 1); }
  }
  return null;
}

export interface ContentScan { judgement: Judgement; parsed: number }

/** Кандидаты SQL в документе без SQL-грамматики; вердикт — только по распарсенным. */
export async function scanFragments(text: string): Promise<ContentScan> {
  let out: Judgement = CLEAN;
  let parsed = 0;
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (OPTIONS_KEY.test(line)) out = worst(out, deny('startup-параметр options=-c в строке подключения / манифесте'));
    for (const tok of line.split(/[\s"'`]+/)) if (tok && (tok.startsWith('PGOPTIONS=') || URL_SCHEMES.some((s) => tok.includes(s)))) out = worst(out, judgeConnToken(tok));
    let consumedTo = -1;
    STMT_KEYWORD.lastIndex = 0;
    for (let m = STMT_KEYWORD.exec(line); m; m = STMT_KEYWORD.exec(line)) {
      if (m.index < consumedTo) continue;
      let stmts: RawStmt[] | null = null;
      if (m[1].toLowerCase() === 'do') {
        const block = dollarBlock(text, offset + m.index);
        if (block) stmts = await parseCandidate(block);
      }
      if (!stmts) stmts = await parseCandidate(line.slice(m.index));
      if (!stmts) continue;
      parsed++;
      out = worst(out, judgeStmts(stmts));
      consumedTo = line.length;
    }
    if (consumedTo < 0) {
      // set_config вне распознанного оператора (PERFORM в plpgsql, вызов в JS-строке без SELECT)
      const re = /\bset_config\s*\(/gi;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const call = balancedCall(line, m.index + m[0].length - 1);
        if (!call) continue;
        const stmts = await parseCandidate(`SELECT set_config${call}`);
        if (stmts) { parsed++; out = worst(out, judgeStmts(stmts)); }
      }
    }
    offset += line.length + 1;
  }
  return { judgement: out, parsed };
}

export async function judgeContent(text: string, path: string): Promise<Judgement> {
  if (SQL_EXT.has(extname(path).toLowerCase())) {
    const whole = await parseSql(text);
    if (!whole.error) return worst(judgeStmts(whole.stmts), (await scanFragments(text)).judgement);
    const scan = await scanFragments(text);
    if (scan.judgement.kind === 'deny') return scan.judgement;
    if (scan.parsed === 0) return unknown(`SQL-файл не разобран (${whole.error.split('\n')[0]}) — доказать безопасность нельзя`);
    return scan.judgement;
  }
  return (await scanFragments(text)).judgement;
}

// ───────────────────────────── гейт ─────────────────────────────

const SILENT: Verdict = { kind: 'silent' };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function writeTarget(p: PreToolUsePayload): { path: string; text: string } {
  const ti = p.tool_input ?? {};
  switch (p.tool_name) {
    case 'Write': return { path: str(ti.file_path), text: str(ti.content) };
    case 'Edit': return { path: str(ti.file_path), text: str(ti.new_string) };
    case 'NotebookEdit': return { path: str(ti.notebook_path), text: str(ti.new_source) };
    default: return { path: '', text: '' };
  }
}

function toVerdict(j: Judgement): Verdict {
  if (j.kind === 'clean') return SILENT;
  if (j.kind === 'unknown') return { kind: 'unknown', reason: j.reason, gate: NAME };
  return { kind: 'deny', reason: `${j.reason}.\n${HINT}`, gate: NAME };
}

export async function decide(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as PreToolUsePayload;
  if (p.hook_event_name !== 'PreToolUse') return SILENT;
  if (ctx.event === 'pre-bash') {
    if (p.tool_name !== 'Bash') return SILENT;
    const cmd = str(p.tool_input?.command);
    if (!cmd) return SILENT;
    return toVerdict(await judgeCommand(cmd, p.cwd));
  }
  if (ctx.event === 'pre-write') {
    const { path, text } = writeTarget(p);
    if (!path || !text || exemptPath(path)) return SILENT;
    return toVerdict(await judgeContent(text, path));
  }
  return SILENT;
}

register({ name: NAME, events: ['pre-bash', 'pre-write'], killSwitch: KILL, run: decide });
