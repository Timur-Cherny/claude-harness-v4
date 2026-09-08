// Контур трения: порт hooks/capture-friction.sh + hooks/friction-classify.sh на события agent-start/agent-stop.
// Уровень (scope) и след (trace_kind) — свойства ДИФФА с начала окна агента, не текста отчёта:
// last_assistant_message и транскрипт не читаются (ADR, решение 1; I3). Наружу — только метки и счётчики
// через appendJsonl('friction'); пути и содержимое остаются в состоянии на машине (agent_window, friction_window).
// SQL виден только как AST (parseSql), TS — только как AST compiler API проекта; нет парсера → trace_kind unknown.
// Regex здесь применяется только к именам файлов и заголовкам hunk'ов git diff (строки без грамматики).
// Документация (*.md, work-docs/**, любой путь вне src/**) описывает гарантию, а не создаёт её:
// не даёт ни domain, ни constraint (INC-FRICTION-DOC-AS-CONSTRAINT).
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname } from 'node:path';
import { register } from './gates/registry.ts';
import { State } from './state.ts';
import { appendJsonl } from './journal.ts';
import { toplevel, status, git } from './git.ts';
import { parseSql, walk } from './parsers/sql.ts';
import type { GateContext, Verdict, SubagentStartPayload, SubagentStopPayload } from './types.ts';

export const NAME = 'friction';
export const KILL = 'CLAUDE_SKIP_FRICTION';
const ADAPTER = 'claude-friction-2'; // «/» в метке журнал отвергает как путь; bash писал claude-friction/1
const MAX_FILES = 200;
const MAX_BYTES = 400_000;

export type Scope = 'none' | 'function' | 'module' | 'domain';
export type TraceKind = 'constraint' | 'assertion' | 'guard' | 'rule' | 'none' | 'unknown';
export type Attribution = 'agent' | 'agent_overlapping' | 'window';

/** Снимок: repo → (путь → digest). Хранится в состоянии, никогда не уходит в журнал. */
type Snapshot = Record<string, Record<string, string>>;
interface Changed { repo: string; path: string; untracked: boolean }

// ── имена файлов (строки без грамматики — regex допустим) ───────────────────────────────────────
const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst']);
const DOC_DIRS = new Set(['work-docs', 'docs', 'graph', 'specs', 'context-packs', 'comms', 'sessions', 'epics']);
const DOMAIN_SEGMENT = new Set(['migration', 'migrations', 'schema', 'contract', 'contracts']);
const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);
const TESTISH = /\.(spec|test)\.[a-z0-9]+$|(^|\/)(tests?|spec|__tests__)\/|(^|\/)test_[^/]+\.py$/i;
const GUARD = /(^|\/)hooks\//i;
const RULE = /(^|\/)(skills|specs)\/|(^|\/)CLAUDE\.md$/i;

const segments = (p: string): string[] => p.split('/');
export function isDoc(p: string): boolean { return DOC_EXT.has(extname(p).toLowerCase()) || DOC_DIRS.has(segments(p)[0]); }
/** Кодовый путь: только под src/** — единственное место, где миграция или схема что-то создаёт. */
export function isCode(p: string): boolean { return !isDoc(p) && segments(p).slice(0, -1).includes('src'); }
export function isDomainPath(p: string): boolean {
  if (!isCode(p)) return false;
  const segs = segments(p); const file = segs[segs.length - 1].toLowerCase();
  return segs.slice(0, -1).some((s) => DOMAIN_SEGMENT.has(s.toLowerCase())) || ['.sql', '.proto'].includes(extname(file)) || file.includes('openapi');
}
const isMigrationTs = (p: string): boolean => isCode(p) && TS_EXT.has(extname(p).toLowerCase()) && segments(p).slice(0, -1).some((s) => s.toLowerCase().startsWith('migration'));
const isSqlFile = (p: string): boolean => isCode(p) && extname(p).toLowerCase() === '.sql';

// ── состояние ───────────────────────────────────────────────────────────────────────────────────
function openState(ctx: GateContext): State {
  const st = State.open(ctx.stateDir);
  st.db.exec('CREATE TABLE IF NOT EXISTS friction_window(repo TEXT PRIMARY KEY, snapshot TEXT, at INTEGER)');
  return st;
}

function sessionRoots(st: State, sessionId: string, cwd: string): string[] {
  const rows = st.db.prepare('SELECT repo FROM session_roots WHERE session_id = ?').all(sessionId) as { repo: string }[];
  // Каждый корень нормализуется через git (realpath): /var/… и /private/var/… — один репозиторий.
  const roots = new Set<string>();
  for (const c of [cwd, ...rows.map((r) => r.repo)]) { const top = toplevel(c); if (top) roots.add(top); }
  return [...roots];
}

function digest(abs: string): string | null {
  try {
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES); const n = readSync(fd, buf, 0, MAX_BYTES, 0);
      return createHash('sha256').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** Текущие digest'ы изменённых и неотслеживаемых файлов корня (удалённые не считаются, -uall внутри status()). */
function snapshotRepo(repo: string): { files: Record<string, string>; untracked: Set<string>; capped: boolean } | null {
  const entries = status(repo); if (entries === null) return null;
  const live = entries.filter((e) => e.xy[0] !== 'D' && e.xy[1] !== 'D');
  const files: Record<string, string> = {}; const untracked = new Set<string>();
  let taken = 0;
  for (const e of live) {
    const abs = join(repo, e.path);
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    if (taken >= MAX_FILES) return { files, untracked, capped: true };
    const d = digest(abs); if (d === null) continue;
    files[e.path] = d; taken++;
    if (e.xy === '??' || e.xy[0] === 'A') untracked.add(e.path);
  }
  return { files, untracked, capped: false };
}

// ── добавленные строки: git diff -U0 HEAD, регэксп только по заголовку hunk'а ────────────────────
function addedLines(repo: string, path: string, untracked: boolean, totalLines: number): Set<number> | 'all' {
  if (untracked) return 'all';
  const r = git(repo, ['diff', '-U0', 'HEAD', '--', path], 8000);
  if (r.rc !== 0) return 'all';
  const added = new Set<number>();
  for (const line of r.stdout.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const from = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count && added.size <= totalLines; i++) added.add(from + i);
  }
  return added;
}
const inAdded = (added: Set<number> | 'all', line: number): boolean => added === 'all' || added.has(line);

// ── TS compiler API проекта: node_modules/typescript ближайшего вверх от файла, иначе $CLAUDE_HARNESS_TS ──
// Минимальный срез API, который здесь нужен (полные типы typescript в харнессе недоступны — node_modules нет).
interface TsNode { kind: number; pos: number; getStart(sf: TsSourceFile): number; text?: string; expression?: TsNode; name?: TsNode; arguments?: TsNode[] }
interface TsSourceFile extends TsNode { getLineAndCharacterOfPosition(pos: number): { line: number } }
interface TsApi {
  createSourceFile(name: string, text: string, target: number, setParents?: boolean, kind?: number): TsSourceFile;
  forEachChild(node: TsNode, cb: (n: TsNode) => void): void;
  isCallExpression(n: TsNode): boolean; isPropertyAccessExpression(n: TsNode): boolean; isIdentifier(n: TsNode): boolean;
  isStringLiteral(n: TsNode): boolean; isNoSubstitutionTemplateLiteral(n: TsNode): boolean; isTemplateExpression(n: TsNode): boolean;
  ScriptTarget: { Latest: number }; ScriptKind: { TS: number; TSX: number; JS: number; JSX: number };
}
function loadTs(absPath: string, env: NodeJS.ProcessEnv): TsApi | null {
  try { return createRequire(absPath)('typescript') as TsApi; } catch { /* у файла нет проекта с typescript */ }
  if (env.CLAUDE_HARNESS_TS) { try { return createRequire(import.meta.url)(env.CLAUDE_HARNESS_TS) as TsApi; } catch { /* пин протух */ } }
  return null;
}
function scriptKind(ts: TsApi, path: string): number {
  const e = extname(path).toLowerCase();
  return e === '.tsx' ? ts.ScriptKind.TSX : e === '.jsx' ? ts.ScriptKind.JSX : ['.js', '.mjs', '.cjs'].includes(e) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function rootIdentifier(ts: TsApi, n: TsNode): string | null {
  let cur = n;
  while (ts.isPropertyAccessExpression(cur) && cur.expression) cur = cur.expression;
  return ts.isIdentifier(cur) ? (cur.text ?? null) : null;
}
function lastName(ts: TsApi, n: TsNode): string | null {
  return ts.isPropertyAccessExpression(n) ? (n.name?.text ?? null) : ts.isIdentifier(n) ? (n.text ?? null) : null;
}
const ASSERT_ROOTS = new Set(['assert', 'expect', 'it', 'test', 'fc']);

type Cand = TraceKind;
interface FileVerdict { cand: Cand; missing?: string }

/** Литералы queryRunner.query(...) в добавленных строках миграции → parseSql → узлы констрейнта. */
async function migrationTs(ts: TsApi, absPath: string, path: string, added: Set<number> | 'all'): Promise<FileVerdict> {
  const text = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  const literals: string[] = []; let opaque = false;
  const visit = (n: TsNode): void => {
    if (ts.isCallExpression(n) && n.expression && lastName(ts, n.expression) === 'query' && ts.isPropertyAccessExpression(n.expression)
      && lastName(ts, n.expression.expression as TsNode) === 'queryRunner' && n.arguments?.length) {
      const arg = n.arguments[0];
      if (inAdded(added, sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1)) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) literals.push(arg.text ?? '');
        else if (ts.isTemplateExpression(arg)) opaque = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  let sawError = false;
  for (const sql of literals) {
    const r = await sqlConstraint(sql);
    if (r === 'constraint') return { cand: 'constraint' };
    if (r === 'error') sawError = true;
  }
  if (sawError) return { cand: 'unknown', missing: 'sql_parse_error' };
  if (opaque) return { cand: 'unknown', missing: 'sql_literal_has_substitutions' };
  return { cand: 'none' };
}

/** Живой ассерт среди добавленных строк: вызов с корнем assert/expect/it/test/fc — комментарий узлом не является. */
function assertionTs(ts: TsApi, absPath: string, path: string, added: Set<number> | 'all'): FileVerdict {
  const text = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path));
  let found = false;
  const visit = (n: TsNode): void => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression) {
      const root = rootIdentifier(ts, n.expression);
      if (root && ASSERT_ROOTS.has(root) && inAdded(added, sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)) { found = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { cand: found ? 'assertion' : 'none' };
}

const CONSTR_KINDS = new Set(['CONSTR_CHECK', 'CONSTR_UNIQUE', 'CONSTR_PRIMARY', 'CONSTR_FOREIGN', 'CONSTR_EXCLUSION']);
/** Констрейнт/индекс как узел AST: Constraint{contype ∈ CHECK/UNIQUE/PK/FK/EXCLUSION} или IndexStmt. NOT NULL и новая колонка — нет. */
async function sqlConstraint(sql: string): Promise<'constraint' | 'none' | 'error'> {
  const p = await parseSql(sql);
  if (p.error) return 'error';
  for (const n of walk(p.stmts)) {
    if ('IndexStmt' in n) return 'constraint';
    const c = n.Constraint as { contype?: string } | undefined;
    if (c && typeof c === 'object' && c.contype && CONSTR_KINDS.has(c.contype)) return 'constraint';
  }
  return 'none';
}

async function sqlFile(repo: string, path: string, untracked: boolean): Promise<FileVerdict> {
  const abs = join(repo, path);
  let text: string;
  try { text = readFileSync(abs, 'utf8').slice(0, MAX_BYTES); } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
  if (!untracked) {
    // Изменённый файл: разбираем только добавленный текст; не разобрался как отдельные операторы — весь файл.
    const r = git(repo, ['diff', '-U0', 'HEAD', '--', path], 8000);
    if (r.rc === 0 && r.stdout.trim()) {
      const addedText = r.stdout.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
      const a = await sqlConstraint(addedText);
      if (a !== 'error') return { cand: a };
    }
  }
  const whole = await sqlConstraint(text);
  return whole === 'error' ? { cand: 'unknown', missing: 'sql_parse_error' } : { cand: whole };
}

const RANK: Record<TraceKind, number> = { none: 0, unknown: 0, rule: 1, guard: 2, assertion: 3, constraint: 4 };

async function classifyFile(f: Changed, env: NodeJS.ProcessEnv): Promise<FileVerdict> {
  const { repo, path, untracked } = f;
  if (RULE.test(path)) return { cand: 'rule' };
  if (isDoc(path)) return { cand: 'none' };
  if (GUARD.test(path)) return { cand: 'guard' };
  if (isSqlFile(path)) return sqlFile(repo, path, untracked);
  const abs = join(repo, path);
  const ext = extname(path).toLowerCase();
  if (isMigrationTs(path)) {
    const ts = loadTs(abs, env); if (!ts) return { cand: 'unknown', missing: 'ts_parser_unavailable' };
    let lines = 0; try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
    return migrationTs(ts, abs, path, addedLines(repo, path, untracked, lines));
  }
  if (TS_EXT.has(ext)) {
    const ts = loadTs(abs, env);
    if (!ts) return TESTISH.test(path) ? { cand: 'unknown', missing: 'ts_parser_unavailable' } : { cand: 'none' };
    let lines = 0; try { lines = readFileSync(abs, 'utf8').split('\n').length; } catch { return { cand: 'unknown', missing: 'file_unreadable' }; }
    return assertionTs(ts, abs, path, addedLines(repo, path, untracked, lines));
  }
  // Файл без парсера в харнессе: для теста это честное unknown, для прочего кода — отсутствие заявленного следа.
  if (TESTISH.test(path)) return { cand: 'unknown', missing: 'no_parser_for_file_kind' };
  return { cand: 'none' };
}

export interface Derived {
  friction_state: 'no_change' | 'derived_from_diff';
  scope: Scope; trace_kind: TraceKind; files_changed: number; roots_touched: number;
  safeguard_sufficient: boolean | null; missing_reason?: string;
}

/** Чистая классификация набора изменённых файлов (пути наружу не выходят). */
export async function classify(changed: Changed[], env: NodeJS.ProcessEnv, capped = false): Promise<Derived> {
  const missing = new Set<string>(); if (capped) missing.add('files_capped');
  if (!changed.length) return { friction_state: 'no_change', scope: 'none', trace_kind: 'none', files_changed: 0, roots_touched: 0, safeguard_sufficient: true, ...(missing.size ? { missing_reason: [...missing].join(',') } : {}) };
  const code = changed.filter((f) => !isDoc(f.path));
  const repos = new Set(code.map((f) => f.repo));
  const roots = new Set(code.map((f) => `${f.repo}/${segments(f.path)[0]}`));
  let scope: Scope = 'function';
  if (code.some((f) => isDomainPath(f.path)) || repos.size > 1) scope = 'domain';
  else if (code.length > 3 || roots.size > 1) scope = 'module';

  let trace: TraceKind = 'none'; let sawUnknown = false;
  for (const f of changed) {
    const v = await classifyFile(f, env);
    if (v.cand === 'unknown') { sawUnknown = true; if (v.missing) missing.add(v.missing); continue; }
    if (RANK[v.cand] > RANK[trace]) trace = v.cand;
  }
  if (trace === 'none' && sawUnknown) trace = 'unknown';
  const sufficient = trace === 'unknown' && scope === 'domain' ? null : scope !== 'domain' || ['constraint', 'assertion', 'guard'].includes(trace);
  return { friction_state: 'derived_from_diff', scope, trace_kind: trace, files_changed: changed.length, roots_touched: roots.size, safeguard_sufficient: sufficient, ...(missing.size ? { missing_reason: [...missing].join(',') } : {}) };
}

// ── события ─────────────────────────────────────────────────────────────────────────────────────
function takeSnapshot(roots: string[]): { snap: Snapshot; untracked: Map<string, Set<string>>; capped: boolean } {
  const snap: Snapshot = {}; const untracked = new Map<string, Set<string>>(); let capped = false;
  for (const repo of roots) {
    const s = snapshotRepo(repo); if (!s) continue;
    snap[repo] = s.files; untracked.set(repo, s.untracked); capped ||= s.capped;
  }
  return { snap, untracked, capped };
}

function onStart(ctx: GateContext): Verdict {
  const p = ctx.payload as SubagentStartPayload;
  const st = openState(ctx);
  try {
    const roots = sessionRoots(st, p.session_id, p.cwd);
    if (!roots.length) return { kind: 'unknown', reason: 'not_a_git_repo: у сессии нет git-корней, окно агента не снято', gate: NAME };
    const { snap } = takeSnapshot(roots);
    st.tx(() => st.db.prepare('INSERT INTO agent_window(session_id, agent_id, agent_type, started_at, stopped_at, snapshot) VALUES(?,?,?,?,NULL,?) ON CONFLICT(session_id, agent_id) DO UPDATE SET agent_type = excluded.agent_type, started_at = excluded.started_at, stopped_at = NULL, snapshot = excluded.snapshot')
      .run(p.session_id, p.agent_id, p.agent_type || null, ctx.now(), JSON.stringify(snap)));
    return { kind: 'silent' };
  } finally { st.close(); }
}

interface WindowRow { agent_type: string | null; started_at: number; stopped_at: number | null; snapshot: string }

async function onStop(ctx: GateContext): Promise<Verdict> {
  const p = ctx.payload as SubagentStopPayload;
  const now = ctx.now();
  const out = ctx.env.FRICTION_OUT || join(ctx.env.HOME ?? '', '.claude', 'exec-telemetry', 'personal-friction.jsonl');
  const base: Record<string, unknown> = {
    ts: new Date(now).toISOString(), adapter: ADAPTER, executor: 'local-agent', source_class: 'subagent-stop',
    session: p.session_id ?? null, agent_id: p.agent_id || null, agent_type: p.agent_type || null,
    outcome: 'completed', verification_state: 'unknown',
    narrative_friction_state: 'unavailable', narrative_missing_reason: 'structured_friction_signal_not_exposed',
  };
  const st = openState(ctx);
  try {
    const roots = sessionRoots(st, p.session_id, p.cwd);
    if (!roots.length) {
      appendJsonl(out, 'friction', { ...base, friction_state: 'unavailable', missing_reason: 'not_a_git_repo' });
      return { kind: 'unknown', reason: 'not_a_git_repo: событие записано без уровня', gate: NAME };
    }
    const { snap, untracked, capped } = takeSnapshot(roots);
    // Окно агента: строка agent_window с открытым stopped_at; иначе — общее окно корня (и событие говорит об этом).
    const row = p.agent_id ? st.db.prepare('SELECT agent_type, started_at, stopped_at, snapshot FROM agent_window WHERE session_id = ? AND agent_id = ?').get(p.session_id, p.agent_id) as WindowRow | undefined : undefined;
    let prev: Snapshot = {}; let attribution: Attribution = 'window'; let concurrent: number | null = null;
    let duration: number | null = null; let windowS: number | null = null;
    if (row && row.stopped_at === null) {
      try { prev = JSON.parse(row.snapshot) as Snapshot; } catch { prev = {}; }
      duration = windowS = Math.round((now - row.started_at) / 1000);
      const others = st.db.prepare('SELECT agent_id, snapshot FROM agent_window WHERE session_id = ? AND agent_id <> ? AND started_at <= ? AND (stopped_at IS NULL OR stopped_at >= ?)')
        .all(p.session_id, p.agent_id, now, row.started_at) as { agent_id: string; snapshot: string }[];
      concurrent = others.filter((o) => { try { return Object.keys(JSON.parse(o.snapshot) as Snapshot).some((r) => roots.includes(r)); } catch { return false; } }).length;
      attribution = concurrent > 0 ? 'agent_overlapping' : 'agent';
      st.tx(() => st.db.prepare('UPDATE agent_window SET stopped_at = ? WHERE session_id = ? AND agent_id = ?').run(now, p.session_id, p.agent_id));
    } else {
      let oldest: number | null = null;
      for (const repo of roots) {
        const w = st.db.prepare('SELECT snapshot, at FROM friction_window WHERE repo = ?').get(repo) as { snapshot: string; at: number } | undefined;
        if (!w) continue;
        try { prev[repo] = JSON.parse(w.snapshot) as Record<string, string>; } catch { /* пустое окно */ }
        oldest = oldest === null ? w.at : Math.min(oldest, w.at);
      }
      if (oldest !== null) windowS = Math.round((now - oldest) / 1000);
    }
    // Общее окно корня сдвигается на каждом стопе — следующий безадресный стоп считает только новое.
    st.tx(() => { for (const repo of roots) st.db.prepare('INSERT INTO friction_window(repo, snapshot, at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET snapshot = excluded.snapshot, at = excluded.at').run(repo, JSON.stringify(snap[repo] ?? {}), now); });

    const changed: Changed[] = [];
    for (const [repo, files] of Object.entries(snap)) {
      for (const [path, d] of Object.entries(files)) if (prev[repo]?.[path] !== d) changed.push({ repo, path, untracked: untracked.get(repo)?.has(path) ?? false });
    }
    const derived = await classify(changed, ctx.env, capped);
    appendJsonl(out, 'friction', { ...base, ...derived, attribution, concurrent_agents: concurrent, duration_s: duration, window_s: windowS });
    if (derived.missing_reason) return { kind: 'unknown', reason: `след не доказан: ${derived.missing_reason} (scope ${derived.scope}, trace ${derived.trace_kind})`, gate: NAME };
    return { kind: 'silent' };
  } finally { st.close(); }
}

export function decide(ctx: GateContext): Verdict | Promise<Verdict> {
  return ctx.event === 'agent-start' ? onStart(ctx) : onStop(ctx);
}

register({ name: NAME, events: ['agent-start', 'agent-stop'], killSwitch: KILL, run: decide });
