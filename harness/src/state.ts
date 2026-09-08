// Состояние контура — одна база node:sqlite на машину, общая для всех сессий (I6).
// Порядок PRAGMA обязателен: busy_timeout ПЕРВЫМ (иначе на свежей базе 13/16 параллельных
// открытий получают «database is locked»), потом WAL, потом synchronous=NORMAL.
// Ключи таблиц — локальные пути: это состояние на машине владельца, не телеметрия (I3 — про события).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, cwd TEXT, permission_mode TEXT, started_at INTEGER, last_event_at INTEGER, ended_at INTEGER, runtime TEXT);
CREATE TABLE IF NOT EXISTS session_roots(session_id TEXT, repo TEXT, first_seen INTEGER, PRIMARY KEY(session_id, repo));
CREATE TABLE IF NOT EXISTS repos(repo TEXT PRIMARY KEY, registered_at INTEGER, last_head TEXT, last_sweep_at INTEGER, sweep_slow INTEGER DEFAULT 0, slow_streak INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cwd_top(cwd TEXT PRIMARY KEY, repo TEXT, git_mtime INTEGER);
CREATE TABLE IF NOT EXISTS verified(repo TEXT, path TEXT, checker TEXT, digest TEXT, verdict TEXT CHECK(verdict IN ('pass','fail','unknown')), checker_gen TEXT, missing_reason TEXT, at INTEGER, PRIMARY KEY(repo, path, checker));
CREATE TABLE IF NOT EXISTS check_memo(project TEXT, set_digest TEXT, result TEXT, at INTEGER, PRIMARY KEY(project, set_digest));
CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY, repo TEXT, kind TEXT, status TEXT CHECK(status IN ('claimed','running','done','failed','stale')), pid INTEGER, owner_session TEXT, skips TEXT, started_at INTEGER, finished_at INTEGER, rc INTEGER, summary TEXT);
CREATE TABLE IF NOT EXISTS job_files(job_id TEXT, repo TEXT, path TEXT, digest TEXT, PRIMARY KEY(job_id, repo, path));
CREATE TABLE IF NOT EXISTS findings(id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT, path TEXT, digest TEXT, checker TEXT, level TEXT CHECK(level IN ('fail','unknown')), message TEXT, created_at INTEGER, UNIQUE(repo, path, digest, checker));
CREATE TABLE IF NOT EXISTS deliveries(finding_id INTEGER, session_id TEXT, at INTEGER, PRIMARY KEY(finding_id, session_id));
CREATE TABLE IF NOT EXISTS stop_blocks(session_id TEXT, signature TEXT, blocked_at INTEGER, PRIMARY KEY(session_id, signature));
CREATE TABLE IF NOT EXISTS claims(session_id TEXT, event TEXT, tool_use_id TEXT, at INTEGER, PRIMARY KEY(session_id, event, tool_use_id));
CREATE TABLE IF NOT EXISTS agent_window(session_id TEXT, agent_id TEXT, agent_type TEXT, started_at INTEGER, stopped_at INTEGER, snapshot TEXT, PRIMARY KEY(session_id, agent_id));
CREATE TABLE IF NOT EXISTS contour(generation TEXT PRIMARY KEY, result TEXT, verified_at INTEGER);
CREATE TABLE IF NOT EXISTS freshness(repo TEXT PRIMARY KEY, fetched_at INTEGER, head_before TEXT, head_after TEXT);
CREATE TABLE IF NOT EXISTS journal_index(journal TEXT, key TEXT, PRIMARY KEY(journal, key));
CREATE TABLE IF NOT EXISTS telemetry_offsets(transcript_hash TEXT PRIMARY KEY, offset INTEGER);
CREATE TABLE IF NOT EXISTS markers(key TEXT PRIMARY KEY, value TEXT, at INTEGER);
`;

export class State {
  readonly db: DatabaseSync;
  readonly path: string;

  private constructor(db: DatabaseSync, path: string) { this.db = db; this.path = path; }

  static open(stateDir: string, opts: { busyTimeoutMs?: number } = {}): State {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'harness.db');
    let db: DatabaseSync;
    try {
      db = openWithPragmas(path, opts.busyTimeoutMs ?? 3000);
      db.exec(SCHEMA);
      const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (ver === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      else if (ver > SCHEMA_VERSION) { /* новая база под старым кодом: читаем, что знаем — миграции только вперёд-совместимые */ }
    } catch (err) {
      // Повреждённая база → в сторону; всё становится неподтверждённым (проверок больше, не меньше).
      if (existsSync(path) && isCorruption(err)) {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
        db = openWithPragmas(path, opts.busyTimeoutMs ?? 3000);
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else throw err;
    }
    return new State(db, path);
  }

  /** Read-modify-write только внутри BEGIN IMMEDIATE: писатели сериализуются замком, не удачей. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* уже откатилось */ } throw e; }
  }

  marker(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM markers WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMarker(key: string, value: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO markers(key, value, at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').run(key, value, at);
  }

  /** Атомарный claim: true — этот процесс первый; false — событие уже взято другим хуком того же события. */
  claim(sessionId: string, event: string, toolUseId: string, at = Date.now()): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO claims(session_id, event, tool_use_id, at) VALUES(?,?,?,?)').run(sessionId, event, toolUseId, at);
    return Number(r.changes) === 1;
  }

  close(): void { this.db.close(); }
}

function openWithPragmas(path: string, busyTimeoutMs: number): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

function isCorruption(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /malformed|not a database|corrupt/i.test(m);
}
