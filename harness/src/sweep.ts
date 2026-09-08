// Сверка состояния рабочего дерева (класс К4): истина о правке — дерево, не имя инструмента.
// На каждом пишущем событии: git status по корням сессии → sha256 изменённых файлов → сравнение с
// verified → дешёвые проверки тут же (дедлайн), дорогие — задача воркеру, результат — следующим
// событием. Окно уязвимости — одно событие вместо сессии (v3: только Stop, hooks/tree-sweep.sh).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process'; // единственное исключение: detached-воркер (см. spawnWorker)
import { fileURLToPath } from 'node:url';
import type { GateContext, HookPayload, PostToolBatchPayload, ToolCall } from './types.ts';
import type { ChangedFile, CheckResult } from './checks/types.ts';
import { CHECKERS } from './checks/registry.ts';
import { State } from './state.ts';
import { generation } from './contour.ts';
import { diffNames, gitDirMtime, head, status, toplevel } from './git.ts';
import { tokenize } from './parsers/shell.ts';

export const MAX_FILES = 200;
export const MAX_HASH_BYTES = 4 * 1024 * 1024;
export const SYNC_DEADLINE_MS = 1500;
const WRITING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Workflow']);

export interface Finding { repo: string; path: string; checker: string; level: 'fail' | 'unknown'; message: string }
export interface SweepOutcome {
  roots: string[]; changed: number; checked: number; skippedVerified: number;
  findings: Finding[]; pending: number; truncated: boolean; unknownReasons: string[];
  files: ChangedFile[];
}
export interface SweepOptions { maxFiles?: number; syncDeadlineMs?: number; spawnWorker?: boolean; checkerFilter?: (name: string) => boolean }

export function digestOf(absPath: string): string {
  const st = statSync(absPath);
  if (st.size > MAX_HASH_BYTES) return `large:${st.size}`;
  return createHash('sha256').update(readFileSync(absPath)).digest('hex').slice(0, 16);
}

/** Корень репозитория для cwd с кэшем по mtime .git (−6–7 мс на событие). */
export function repoOf(state: State, dir: string): string | null {
  const row = state.db.prepare('SELECT repo, git_mtime FROM cwd_top WHERE cwd = ?').get(dir) as { repo: string; git_mtime: number } | undefined;
  if (row && existsSync(row.repo) && gitDirMtime(row.repo) === row.git_mtime) return row.repo;
  const top = toplevel(dir);
  if (top) state.db.prepare('INSERT INTO cwd_top(cwd, repo, git_mtime) VALUES(?,?,?) ON CONFLICT(cwd) DO UPDATE SET repo = excluded.repo, git_mtime = excluded.git_mtime').run(dir, top, gitDirMtime(top));
  return top;
}

function pathsFromToolCall(call: ToolCall, cwd: string): string[] {
  const out: string[] = [];
  const inp = call.tool_input ?? {};
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof inp[k] === 'string') out.push(resolve(cwd, inp[k] as string));
  if (call.tool_name === 'Bash' && typeof inp.command === 'string') {
    const parse = tokenize(inp.command);
    for (const seg of parse.segments) {
      for (let i = 0; i < seg.argv.length; i++) {
        const t = seg.argv[i];
        if (isAbsolute(t)) out.push(t);
        if ((t === 'cd' || t === '-C') && seg.argv[i + 1] && !seg.argv[i + 1].startsWith('-')) out.push(resolve(cwd, seg.argv[i + 1]));
      }
    }
  }
  return out;
}

// Каталог упомянут, а не является объектом работы. Список зависит от того, ОТКУДА взят путь.
// Живой случай 05.09: `~/.nvm/versions/node/v24.20.0/bin/node` в команде зарегистрировал репозиторий nvm корнем сессии.
// Путь из токенов Bash — упоминание: сверх MANAGED отсекаются системные каталоги и собственный конфиг (MENTIONED).
// cwd сессии и file_path пишущего инструмента — не упоминание, а место работы: исключается только MANAGED.
// Временный каталог не отсекается ни там, ни там: в контейнере и рабочее дерево, и вторая репозитория, названная
// в команде, законно лежат под /tmp, а от мусорного корня защищает правило «слабый корень — только с изменениями».
const MANAGED = ['/.nvm/', '/.pyenv/', '/.rbenv/', '/.cargo/', '/.rustup/', '/.cache/', '/node_modules/'];
const MENTIONED = [...MANAGED, '/Library/', '/usr/', '/.claude/'];
function inDirs(p: string, dirs: readonly string[]): boolean { const h = process.env.HOME ?? ''; const rel = h && p.startsWith(h) ? p.slice(h.length) : p; return dirs.some((d) => (rel + '/').includes(d)); }
export function isToolPath(p: string, strength: 'strong' | 'weak' = 'weak'): boolean { return inDirs(p, strength === 'weak' ? MENTIONED : MANAGED); }

/** Корни сессии: cwd ∪ пути инструмента ∪ абсолютные пути и cd/-C в токенах Bash ∪ уже известные корни (на stop/agent-stop).
 * Корень из токенов Bash (не cwd и не file_path) регистрируется только если в нём СЕЙЧАС есть изменения:
 * упоминание чужой репы в аргументе — не правка в ней. */
export function collectRoots(ctx: GateContext, state: State, opts: { all?: boolean } = {}): string[] {
  const p = ctx.payload as HookPayload & Partial<ToolCall> & Partial<PostToolBatchPayload>;
  const strong = new Set<string>([p.cwd]);
  const weak = new Set<string>();
  const calls: ToolCall[] = p.hook_event_name === 'PostToolBatch' ? (p.tool_calls ?? []) : (p.tool_name ? [{ tool_name: p.tool_name, tool_input: p.tool_input ?? {} }] : []);
  for (const c of calls) {
    if (!(WRITING_TOOLS.has(c.tool_name) || c.tool_name.startsWith('mcp__'))) continue;
    for (const x of pathsFromToolCall(c, p.cwd)) (c.tool_name === 'Bash' ? weak : strong).add(x);
  }
  const roots = new Set<string>();
  const resolveRoot = (c: string, strength: 'strong' | 'weak'): string | null => {
    if (isToolPath(c, strength)) return null;
    let dir = c;
    try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { return null; }
    return repoOf(state, dir);
  };
  for (const c of strong) { const r = resolveRoot(c, 'strong'); if (r) roots.add(r); }
  for (const c of weak) {
    const r = resolveRoot(c, 'weak');
    if (!r || roots.has(r)) continue;
    const known = state.db.prepare('SELECT 1 FROM session_roots WHERE session_id = ? AND repo = ?').get(p.session_id, r);
    if (known || (status(r) ?? []).length > 0) roots.add(r);
  }
  const now = ctx.now();
  state.tx(() => {
    for (const r of roots) state.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(p.session_id, r, now);
    for (const r of roots) state.db.prepare('INSERT OR IGNORE INTO repos(repo, registered_at) VALUES(?,?)').run(r, now);
  });
  if (opts.all) for (const row of state.db.prepare('SELECT repo FROM session_roots WHERE session_id = ?').all(p.session_id) as { repo: string }[]) if (existsSync(row.repo)) roots.add(row.repo);
  return [...roots];
}

export function changedFiles(state: State, repo: string, maxFiles: number): { files: ChangedFile[]; truncated: boolean; unknownReason?: string } {
  const entries = status(repo);
  if (entries === null) return { files: [], truncated: false, unknownReason: `git status не выполнился в ${repo}` };
  const paths = new Map<string, ChangedFile['status']>();
  for (const e of entries) { if (e.xy.includes('D') && !e.xy.includes('M') && !e.xy.includes('A')) continue; paths.set(e.path, (e.xy.trim()[0] ?? 'M') as ChangedFile['status']); }
  // Сдвиг HEAD (правка + commit одним вызовом): файлы коммитов между last_head и HEAD тоже изменены.
  const h = head(repo);
  const row = state.db.prepare('SELECT last_head FROM repos WHERE repo = ?').get(repo) as { last_head: string | null } | undefined;
  if (h && row?.last_head && row.last_head !== h) for (const p of diffNames(repo, row.last_head, h)) if (!paths.has(p)) paths.set(p, 'M');
  if (h) state.db.prepare('UPDATE repos SET last_head = ? WHERE repo = ?').run(h, repo);
  const all = [...paths.entries()];
  const truncated = all.length > maxFiles;
  const files: ChangedFile[] = [];
  for (const [p, st] of all.slice(0, maxFiles)) {
    const abs = join(repo, p);
    try { if (!statSync(abs).isFile()) continue; files.push({ repo, path: p, absPath: abs, digest: digestOf(abs), status: st }); } catch { /* исчез между status и stat */ }
  }
  return { files, truncated };
}

function setDigest(files: ChangedFile[]): string {
  return createHash('sha256').update(files.map((f) => `${f.path}:${f.digest}`).sort().join('\n')).digest('hex').slice(0, 16);
}

export function recordResult(state: State, f: ChangedFile, checker: string, gen: string, r: CheckResult, now: number): Finding | null {
  state.db.prepare(`INSERT INTO verified(repo, path, checker, digest, verdict, checker_gen, missing_reason, at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(repo, path, checker) DO UPDATE SET digest = excluded.digest, verdict = excluded.verdict, checker_gen = excluded.checker_gen, missing_reason = excluded.missing_reason, at = excluded.at`)
    .run(f.repo, f.path, checker, f.digest, r.verdict, gen, r.missing_reason ?? null, now);
  if (r.verdict === 'pass') return null;
  const message = (r.verdict === 'fail' ? (r.message ?? 'провал без сообщения') : (r.missing_reason ?? 'причина не названа')).slice(0, 4096);
  state.db.prepare('INSERT INTO findings(repo, path, digest, checker, level, message, created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repo, path, digest, checker) DO UPDATE SET level = excluded.level, message = excluded.message').run(f.repo, f.path, f.digest, checker, r.verdict, message, now);
  return { repo: f.repo, path: f.path, checker, level: r.verdict, message };
}

export function spawnWorker(root: string, jobId: string, env: NodeJS.ProcessEnv, stateDir: string): void {
  const worker = join(root, 'src', 'jobs', 'worker.ts');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', worker, jobId], {
    detached: true, stdio: 'ignore',
    env: { ...env, CLAUDE_STATE_DIR: stateDir, HARNESS_ROOT: root, NODE_COMPILE_CACHE: env.NODE_COMPILE_CACHE ?? join(stateDir, 'compile-cache') },
  });
  child.unref();
}

export async function sweep(ctx: GateContext, state: State, opts: SweepOptions = {}): Promise<SweepOutcome> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const deadline = ctx.now() + (opts.syncDeadlineMs ?? SYNC_DEADLINE_MS);
  const gen = generation(ctx.root);
  const roots = collectRoots(ctx, state, { all: ctx.event === 'stop' || ctx.event === 'agent-stop' });
  const out: SweepOutcome = { roots, changed: 0, checked: 0, skippedVerified: 0, findings: [], pending: 0, truncated: false, unknownReasons: [], files: [] };
  const checkers = CHECKERS.filter((c) => ctx.env[c.killSwitch] !== '1' && (opts.checkerFilter?.(c.name) ?? true));
  for (const repo of roots) {
    const { files, truncated, unknownReason } = changedFiles(state, repo, maxFiles);
    if (unknownReason) out.unknownReasons.push(unknownReason);
    out.truncated ||= truncated;
    out.changed += files.length;
    out.files.push(...files);
    state.db.prepare('UPDATE repos SET last_sweep_at = ? WHERE repo = ?').run(ctx.now(), repo);
    const workerSets = new Map<string, ChangedFile[]>();
    for (const c of checkers) {
      for (const f of files) {
        if (!c.applies(f)) continue;
        const v = state.db.prepare('SELECT digest, verdict, checker_gen FROM verified WHERE repo = ? AND path = ? AND checker = ?').get(repo, f.path, c.name) as { digest: string; verdict: string; checker_gen: string } | undefined;
        if (v && v.digest === f.digest && v.checker_gen === gen) { out.skippedVerified++; continue; }
        if (c.tier === 'worker') { (workerSets.get(c.name) ?? workerSets.set(c.name, []).get(c.name)!).push(f); continue; }
        const left = deadline - ctx.now();
        if (left <= 0) { out.findings.push(recordResult(state, f, c.name, gen, { verdict: 'unknown', missing_reason: 'дедлайн синхронного яруса исчерпан' }, ctx.now())!); continue; }
        let r: CheckResult;
        try { r = await c.run(f, { env: ctx.env, stateDir: ctx.stateDir, now: ctx.now, deadlineMs: left }); }
        catch (e) { r = { verdict: 'unknown', missing_reason: `${c.name}: ${(e as Error).message.split('\n')[0]}` }; }
        out.checked++;
        const fnd = recordResult(state, f, c.name, gen, r, ctx.now());
        if (fnd) out.findings.push(fnd);
      }
    }
    for (const [kind, set] of workerSets) {
      const jobId = createHash('sha256').update(`${repo}|${kind}|${setDigest(set)}`).digest('hex').slice(0, 24);
      const skips = Object.keys(ctx.env).filter((k) => k.startsWith('CLAUDE_SKIP_') && ctx.env[k] === '1');
      const claimed = state.tx(() => {
        const r = state.db.prepare('INSERT OR IGNORE INTO jobs(job_id, repo, kind, status, owner_session, skips, started_at) VALUES(?,?,?,?,?,?,?)').run(jobId, repo, kind, 'claimed', ctx.payload.session_id, JSON.stringify(skips), ctx.now());
        if (Number(r.changes) === 1) for (const f of set) state.db.prepare('INSERT OR IGNORE INTO job_files(job_id, repo, path, digest) VALUES(?,?,?,?)').run(jobId, repo, f.path, f.digest);
        return Number(r.changes) === 1;
      });
      if (claimed && (opts.spawnWorker ?? true)) spawnWorker(ctx.root, jobId, ctx.env, ctx.stateDir);
    }
    out.pending += (state.db.prepare("SELECT count(*) c FROM jobs WHERE repo = ? AND status IN ('claimed','running')").get(repo) as { c: number }).c;
  }
  return out;
}

/** Находки по ТЕКУЩИМ digest'ам корней, ещё не доставленные ЭТОЙ сессии. verified общая для всех сессий
 * (файл с тем же digest не перепроверяется), доставка — per-session: вторая сессия в том же дереве узнаёт о сломанном файле. */
export function deliver(state: State, sessionId: string, roots: string[], now: number, fresh: Finding[] = [], current: ChangedFile[] = []): Finding[] {
  const out: Finding[] = [...fresh]; // проверка выполнилась в этом событии → её результат уходит всегда, даже если тот же digest уже видели
  const freshKeys = new Set(fresh.map((f) => `${f.repo}|${f.path}|${f.checker}`));
  state.tx(() => {
    // Файл вернулся к чистому состоянию (его нет среди изменённых) → его доставки этой сессии забываются:
    // следующая поломка, даже тем же содержимым, будет сообщена заново. Иначе «починил → сломал так же» проходит молча.
    for (const repo of roots) {
      const changedPaths = new Set(current.filter((f) => f.repo === repo).map((f) => f.path));
      const rows = state.db.prepare('SELECT d.finding_id, f.path FROM deliveries d JOIN findings f ON f.id = d.finding_id WHERE d.session_id = ? AND f.repo = ?').all(sessionId, repo) as Array<{ finding_id: number; path: string }>;
      for (const r of rows) if (!changedPaths.has(r.path)) state.db.prepare('DELETE FROM deliveries WHERE finding_id = ? AND session_id = ?').run(r.finding_id, sessionId);
    }
    for (const f of fresh) state.db.prepare('INSERT OR IGNORE INTO deliveries(finding_id, session_id, at) SELECT id, ?, ? FROM findings WHERE repo = ? AND path = ? AND digest = ? AND checker = ?').run(sessionId, now, f.repo, f.path, digestSafe(join(f.repo, f.path)), f.checker);
    for (const repo of roots) {
      const rows = state.db.prepare('SELECT f.id, f.path, f.digest, f.checker, f.level, f.message FROM findings f WHERE f.repo = ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.finding_id = f.id AND d.session_id = ?) ORDER BY f.id').all(repo, sessionId) as Array<{ id: number; path: string; digest: string; checker: string; level: 'fail' | 'unknown'; message: string }>;
      // «Текущая» находка — файл среди ИЗМЕНЁННЫХ с тем же digest. Закоммиченный сломанный файл чист для сверки:
      // о нём сообщили при сдвиге HEAD, дальше это забота тестов/CI проекта, не харнесса.
      const currentDigest = new Map(current.filter((f) => f.repo === repo).map((f) => [f.path, f.digest]));
      for (const r of rows) {
        if (currentDigest.get(r.path) !== r.digest) continue; // устаревшая находка: файл ушёл дальше или чист
        state.db.prepare('INSERT OR IGNORE INTO deliveries(finding_id, session_id, at) VALUES(?,?,?)').run(r.id, sessionId, now);
        if (!freshKeys.has(`${repo}|${r.path}|${r.checker}`)) out.push({ repo, path: r.path, checker: r.checker, level: r.level, message: r.message });
      }
    }
  });
  return out;
}

function digestSafe(abs: string): string { try { return digestOf(abs); } catch { return ''; } }

export function signature(findings: Finding[]): string {
  return createHash('sha256').update(findings.map((f) => `${f.repo}|${f.path}|${f.checker}|${f.level}|${f.message}`).sort().join('\n')).digest('hex').slice(0, 16);
}

export function formatFindings(f: Finding[], out: SweepOutcome): string {
  const head = `harness sweep: изменено ${out.changed}, проверено сейчас ${out.checked}, уже подтверждено ${out.skippedVerified}, в фоне ${out.pending}${out.truncated ? `, список обрезан до ${MAX_FILES}` : ''}`;
  const lines = f.map((x) => `- ${x.path} [${x.checker}] ${x.level}: ${x.message.split('\n').slice(0, 4).join(' | ')}`);
  const unk = out.unknownReasons.map((r) => `- unknown: ${r}`);
  return [head, ...lines, ...unk].join('\n').slice(0, 8000);
}

export const WORKER_PATH = fileURLToPath(new URL('./jobs/worker.ts', import.meta.url));
