// prompt: свежесть чекаутов — локальный сдвиг HEAD с прошлого хода (другая сессия/чип, без сети),
// результат ФОНОВОГО fetch с прошлого раза (докладывается один раз на изменение), mtime трекера вольта.
// stop: «печать» отпечатков после собственного хода — свой коммит не выдаётся за чужой.
// Репозитории — из env (WMS_VAULT, WMS_ENGINE, WMS_FE, WMS_CONN); при пустом env — из ~/.claude/env/wms-paths.sh
// через `sh` (spawnTool). Явно заданный путь, который не git-репозиторий, → unknown с причиной; не задан → пропуск.
//
// ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ ИЗ spawnTool В КОНТУРЕ: фоновый fetch запускается detached-процессом
// `spawn(process.execPath, [этот файл, '--fetch', root, stateDir], { detached, stdio: 'ignore' }).unref()` —
// ни один ход не ждёт сеть, результат читается на следующем. Внутри детского процесса сам `git fetch` идёт
// через spawnTool('git', …): это единственный не-read глагол git в контуре, git.ts его не предоставляет.
// Состояние — своя таблица git_freshness поверх State.db; throttle fetch (600 с) берётся в транзакции,
// чтобы две одновременные сессии не запускали два fetch.
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from '../gates/registry.ts';
import { State } from '../state.ts';
import { git, toplevel } from '../git.ts';
import { spawnTool } from '../platform.ts';
import { fileMtime } from './common.ts';
import { loadConfig } from '../config.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'git-freshness';
export const KILL = 'CLAUDE_SKIP_GIT_FRESHNESS';
export const FETCH_EVERY_MS = 600_000;
const TRACKER_REL = join('work-docs', 'TRACKER_WMS.md');
const TRACKER_MARKER = 'git-freshness:tracker.mtime';
// Путь вольта по умолчанию — свойство площадки, а не контура: он приходит из конфига (`vaultRel`).
// Не задан — дефолтного вольта нет, и остаются только явные env.
const ENV_VARS = ['WMS_VAULT', 'WMS_ENGINE', 'WMS_FE', 'WMS_CONN'] as const;

const TABLE = `CREATE TABLE IF NOT EXISTS git_freshness(repo TEXT PRIMARY KEY, head_seen TEXT, fetch_started_at INTEGER DEFAULT 0, behind TEXT DEFAULT '', behind_said TEXT DEFAULT '', updated_at INTEGER)`;

export interface RepoSpec { source: string; path: string; explicit: boolean }
export interface Deps { spawnFetch?: (root: string, stateDir: string) => void }

function ensureTable(st: State): void { st.db.exec(TABLE); }

/** Пути репозиториев: env → wms-paths.sh → дефолт вольта. Явность решает, чем считать пропажу каталога. */
export function resolveRepos(env: NodeJS.ProcessEnv): { specs: RepoSpec[]; vault: string | null } {
  const home = env.HOME ?? '';
  let vals: Record<string, string | undefined> = Object.fromEntries(ENV_VARS.map((k) => [k, env[k]]));
  if (ENV_VARS.every((k) => !vals[k]) && home) {
    const file = join(home, '.claude', 'env', 'wms-paths.sh');
    if (existsSync(file)) {
      const r = spawnTool('sh', ['-c', 'unset WMS_VAULT WMS_ENGINE WMS_FE WMS_CONN; . "$0" >/dev/null 2>&1; printf "%s\\n%s\\n%s\\n%s\\n" "$WMS_VAULT" "$WMS_ENGINE" "$WMS_FE" "$WMS_CONN"', file], { timeoutMs: 3000 });
      if (r.rc === 0) { const [v, e, f, c] = r.stdout.split('\n'); vals = { WMS_VAULT: v, WMS_ENGINE: e, WMS_FE: f, WMS_CONN: c }; }
    }
  }
  const specs: RepoSpec[] = [];
  let vault: string | null = null;
  if (vals.WMS_VAULT) { vault = vals.WMS_VAULT; specs.push({ source: 'WMS_VAULT', path: vault, explicit: true }); }
  else if (home) {
    const rel = loadConfig(env).vaultRel;
    if (rel) { vault = join(home, rel); specs.push({ source: 'WMS_VAULT(default)', path: vault, explicit: false }); }
  }
  for (const k of ['WMS_ENGINE', 'WMS_FE', 'WMS_CONN'] as const) if (vals[k]) specs.push({ source: k, path: vals[k]!, explicit: true });
  return { specs, vault };
}

/** Корни без дублей (два env могут смотреть в один репозиторий) + проблемы явных путей. */
export function resolveRoots(env: NodeJS.ProcessEnv): { roots: string[]; problems: string[]; vault: string | null } {
  const { specs, vault } = resolveRepos(env);
  const roots: string[] = []; const problems: string[] = [];
  for (const s of specs) {
    const root = toplevel(s.path);
    if (root === null) { if (s.explicit) problems.push(`${s.source}: каталог исчез или не git-репозиторий`); continue; }
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots, problems, vault };
}

interface Row { repo: string; head_seen: string | null; fetch_started_at: number; behind: string; behind_said: string }

function shortHead(root: string): string | null {
  const r = git(root, ['rev-parse', '--short', 'HEAD'], 3000);
  return r.rc === 0 ? r.stdout.trim() : null;
}

export function spawnFetchDetached(root: string, stateDir: string): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--fetch', root, stateDir], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '30' },
  });
  child.unref();
}

/** Тело детского процесса: fetch, затем отставание от upstream → git_freshness.behind. */
export function runFetch(root: string, stateDir: string): string {
  process.env.GIT_TERMINAL_PROMPT = '0';
  spawnTool('git', ['fetch', '--quiet', '--all'], { cwd: root, timeoutMs: 180_000 });
  let behind = '';
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 3000);
  if (up.rc === 0 && up.stdout.trim()) {
    const upstream = up.stdout.trim();
    const n = git(root, ['rev-list', '--count', `HEAD..${upstream}`], 5000);
    const count = n.rc === 0 ? Number(n.stdout.trim()) : 0;
    if (count > 0) behind = `позади ${upstream} на ${count} коммит(ов) — стянуть до чтения`;
  }
  const st = State.open(stateDir);
  try {
    ensureTable(st);
    st.tx(() => st.db.prepare('INSERT INTO git_freshness(repo, behind, updated_at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET behind = excluded.behind, updated_at = excluded.updated_at').run(root, behind, Date.now()));
  } finally { st.close(); }
  return behind;
}

export function decide(ctx: GateContext, deps: Deps = {}): Verdict {
  if (!ctx.env.HOME) return { kind: 'unknown', reason: 'HOME не задан — пути репозиториев неизвестны', gate: NAME };
  return ctx.event === 'stop' ? seal(ctx) : check(ctx, deps.spawnFetch ?? spawnFetchDetached);
}

function check(ctx: GateContext, spawnFetch: (root: string, stateDir: string) => void): Verdict {
  const { roots, problems, vault } = resolveRoots(ctx.env);
  const notes: string[] = [];
  const now = ctx.now();
  const st = State.open(ctx.stateDir);
  try {
    ensureTable(st);
    for (const root of roots) {
      const headNow = shortHead(root);
      if (headNow === null) continue;
      const name = basename(root);
      let startFetch = false;
      st.tx(() => {
        const row = st.db.prepare('SELECT repo, head_seen, fetch_started_at, behind, behind_said FROM git_freshness WHERE repo = ?').get(root) as Row | undefined;
        if (row?.head_seen && row.head_seen !== headNow) {
          const subj = git(root, ['log', '--format=%s', '-1'], 3000);
          const top = subj.rc === 0 ? subj.stdout.trim().slice(0, 90) : '?';
          notes.push(`${name}: HEAD сдвинулся ${row.head_seen} → ${headNow} (не тобой — другая сессия/чип). Верх: ${top}`);
        }
        let said = row?.behind_said ?? '';
        const behind = row?.behind ?? '';
        if (behind) { if (behind !== said) { notes.push(`${name}: ${behind}`); said = behind; } }
        else said = '';
        let started = row?.fetch_started_at ?? 0;
        if (now - started >= FETCH_EVERY_MS) { started = now; startFetch = true; }
        st.db.prepare('INSERT INTO git_freshness(repo, head_seen, fetch_started_at, behind, behind_said, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo) DO UPDATE SET head_seen = excluded.head_seen, fetch_started_at = excluded.fetch_started_at, behind_said = excluded.behind_said, updated_at = excluded.updated_at')
          .run(root, headNow, started, behind, said, now);
      });
      if (startFetch) spawnFetch(root, ctx.stateDir);
    }
    if (vault) {
      const m = fileMtime(join(vault, TRACKER_REL));
      if (m !== null) {
        const was = st.marker(TRACKER_MARKER);
        if (was !== null && was !== String(m)) notes.push('TRACKER_WMS.md изменён с прошлого хода — перечитать нужные задачи, не полагаться на прочитанное');
        st.setMarker(TRACKER_MARKER, String(m), now);
      }
    }
  } finally { st.close(); }
  if (notes.length) {
    const text = ['СВЕЖЕСТЬ ЧЕКАУТОВ — состояние изменилось не тобой:', ...notes.map((n) => `  · ${n}`), ...problems.map((p) => `  · ${p}`), 'Прочитанное ранее в этой сессии могло устареть. Перечитать перед выводами.'].join('\n');
    return { kind: 'context', text, gate: NAME };
  }
  if (problems.length) return { kind: 'unknown', reason: problems.join('; '), gate: NAME };
  return { kind: 'silent' };
}

function seal(ctx: GateContext): Verdict {
  const { roots, vault } = resolveRoots(ctx.env);
  const now = ctx.now();
  const st = State.open(ctx.stateDir);
  try {
    ensureTable(st);
    for (const root of roots) {
      const h = shortHead(root);
      if (h === null) continue;
      st.tx(() => st.db.prepare('INSERT INTO git_freshness(repo, head_seen, updated_at) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET head_seen = excluded.head_seen, updated_at = excluded.updated_at').run(root, h, now));
    }
    if (vault) { const m = fileMtime(join(vault, TRACKER_REL)); if (m !== null) st.setMarker(TRACKER_MARKER, String(m), now); }
  } finally { st.close(); }
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['prompt', 'stop'], killSwitch: KILL, run: (ctx) => decide(ctx) };
register(gate);

// Детский режим: `node git-freshness.ts --fetch <root> <stateDir>` — только из spawnFetchDetached.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain && process.argv[2] === '--fetch' && process.argv[3] && process.argv[4]) {
  try { runFetch(process.argv[3], process.argv[4]); } catch { /* фон: сбой fetch — отсутствие данных, доложить некому */ }
  process.exit(0);
}
