// PreCompact: дешёвый снимок состояния перед сжатием контекста — только агрегаты репозитория и сессии,
// имена и содержимое файлов не собираются, транскрипт не читается (только размер). Журнала `precompact`
// в белом списке journal.ts нет — снимки живут в своей таблице precompact_snapshots поверх State.db
// (локальное состояние машины, не телеметрия) с самоподрезкой до 200 строк, как cap оригинала.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { register } from '../gates/registry.ts';
import { State } from '../state.ts';
import { git, toplevel, status } from '../git.ts';
import { fileSize } from './common.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'precompact-snapshot';
export const KILL = 'CLAUDE_SKIP_PRECOMPACT';
export const MAX_ROWS = 200;

const TABLE = `CREATE TABLE IF NOT EXISTS precompact_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, session TEXT, trigger TEXT, repo TEXT, branch TEXT, head TEXT, staged INTEGER, unstaged INTEGER, untracked INTEGER, transcript_bytes INTEGER)`;

export interface Dirty { staged: number; unstaged: number; untracked: number }

/** Как в оригинале: `^[MADRC]` — staged, `^.[MD]` — unstaged, `^??` — untracked; строка может попасть в два счётчика. */
export function dirtyCounts(entries: Array<{ xy: string }>): Dirty {
  const d: Dirty = { staged: 0, unstaged: 0, untracked: 0 };
  for (const { xy } of entries) {
    if (xy === '??') { d.untracked++; continue; }
    if ('MADRC'.includes(xy[0] ?? ' ')) d.staged++;
    if ('MD'.includes(xy[1] ?? ' ')) d.unstaged++;
  }
  return d;
}

export function decide(ctx: GateContext): Verdict {
  const cwd = ctx.payload.cwd;
  const root = toplevel(cwd);
  if (root === null) {
    try { statSync(cwd); } catch { return { kind: 'unknown', reason: 'cwd из payload не существует', gate: NAME }; }
    return { kind: 'silent' }; // не репозиторий — снимать нечего (оригинал: exit 0)
  }
  const p = ctx.payload as unknown as Record<string, unknown>;
  const trigger = typeof p.trigger === 'string' ? p.trigger : 'unknown';
  const transcript = typeof p.transcript_path === 'string' ? fileSize(p.transcript_path) ?? 0 : 0;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 3000);
  const head = git(root, ['rev-parse', '--short', 'HEAD'], 3000);
  const entries = status(root);
  if (entries === null) return { kind: 'unknown', reason: 'git status не ответил', gate: NAME };
  const d = dirtyCounts(entries);
  const st = State.open(ctx.stateDir);
  try {
    st.db.exec(TABLE);
    st.tx(() => {
      st.db.prepare('INSERT INTO precompact_snapshots(ts, session, trigger, repo, branch, head, staged, unstaged, untracked, transcript_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(new Date(ctx.now()).toISOString(), ctx.payload.session_id, trigger, basename(root), branch.rc === 0 ? branch.stdout.trim() : '', head.rc === 0 ? head.stdout.trim() : '', d.staged, d.unstaged, d.untracked, transcript);
      st.db.prepare(`DELETE FROM precompact_snapshots WHERE id NOT IN (SELECT id FROM precompact_snapshots ORDER BY id DESC LIMIT ${MAX_ROWS})`).run();
    });
  } finally { st.close(); }
  return { kind: 'silent' };
}

const gate: Gate = { name: NAME, events: ['precompact'], killSwitch: KILL, run: decide };
register(gate);
