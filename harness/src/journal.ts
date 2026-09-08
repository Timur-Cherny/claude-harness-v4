// Журналы JSONL — только метаданные (I3). Каждая запись проверяется белым списком ключей
// СВОЕГО журнала: новое поле обязано быть объявлено здесь осознанно, иначе запись отвергается.
// Одна строка — один writeSync на O_APPEND-дескриптор: параллельные сессии не рвут строки (I6).
import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const WHITELIST = {
  friction: new Set([
    'ts', 'adapter', 'executor', 'source_class', 'session', 'agent_id', 'agent_type', 'outcome',
    'verification_state', 'narrative_friction_state', 'narrative_missing_reason', 'friction_state',
    'missing_reason', 'attribution', 'concurrent_agents', 'scope', 'trace_kind', 'safeguard_sufficient',
    'files_changed', 'roots_touched', 'duration_s', 'window_s',
  ]),
  commits: new Set(['ts', 'adapter', 'session', 'repo_hash', 'commit_hash', 'files', 'insertions', 'deletions', 'branch_class']),
  telemetry: new Set(['ts', 'adapter', 'executor', 'session', 'event', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'duration_s', 'tool_calls', 'outcome']),
} as const;

export type JournalName = keyof typeof WHITELIST;

export class JournalError extends Error {}

export function assertWhitelisted(journal: JournalName, record: Record<string, unknown>): void {
  const allowed = WHITELIST[journal];
  const extra = Object.keys(record).filter((k) => !allowed.has(k));
  if (extra.length) throw new JournalError(`журнал ${journal}: поля вне белого списка — ${extra.join(', ')}`);
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && (v.includes('/') || v.length > 200)) {
      // Путь или длинный текст в метаданных — признак утечки содержимого.
      throw new JournalError(`журнал ${journal}: поле ${k} похоже на путь или текст, а не на метку`);
    }
  }
}

export function appendJsonl(path: string, journal: JournalName, record: Record<string, unknown>): void {
  assertWhitelisted(journal, record);
  const line = JSON.stringify(record) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600); // O_APPEND: одна запись — одна атомарная строка (< PIPE_BUF гарантированно, длиннее — best effort)
  try { writeSync(fd, line); } finally { closeSync(fd); }
}
