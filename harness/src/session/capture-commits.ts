// Stop: новые коммиты ЭТОГО git-пользователя в репозитории cwd → журнал `commits`
// (~/.claude/worklog-commits.jsonl) через appendJsonl — только метаданные, без темы и email.
// Дедуп — таблица journal_index(journal='commits', key=<hash>) внутри одной транзакции State:
// замок BEGIN IMMEDIATE заменяет mkdir-lock оригинала (hooks/spec/capture-commits-lock.test.sh):
// сосед, не получивший замок, ждёт busy_timeout и получает unknown — журнал не трогает.
// Быстрый путь: HEAD не сдвинулся с прошлого снимка (маркер) → один rev-parse и тишина.
// Regex здесь только по строкам без грамматики: имя ветки (класс) и строка `--shortstat`.
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { register } from '../gates/registry.ts';
import { State } from '../state.ts';
import { appendJsonl } from '../journal.ts';
import { git, toplevel, head } from '../git.ts';
import { shortHash } from './common.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';

export const NAME = 'capture-commits';
export const KILL = 'CLAUDE_SKIP_CAPTURE_COMMITS';
export const ADAPTER = 'harness-v4';
const SINCE = '30 days ago';
const LIMIT = 30;

export interface CommitMeta { hash: string; ts: string; files: number; insertions: number; deletions: number }

export function journalPath(home: string): string { return join(home, '.claude', 'worklog-commits.jsonl'); }

/** Класс ветки — метка вместо имени (имя ветки может нести путь/тему задачи). */
export function branchClass(name: string): string {
  if (name === 'HEAD') return 'detached';
  if (/^(main|master)$/.test(name)) return 'main';
  const m = /^(release|hotfix|feature|fix|feat|chore|docs|refactor|test)\//.exec(name);
  return m ? m[1] : 'other';
}

/** Разбор `git log --pretty=format:%x1e%H%x1f%cI --shortstat`: тема и автор не запрашиваются вовсе. */
export function parseLog(out: string): CommitMeta[] {
  const res: CommitMeta[] = [];
  for (const chunk of out.split('\x1e')) {
    const t = chunk.trim();
    if (!t) continue;
    const [headLine, ...rest] = t.split('\n');
    const [hash, ts] = headLine.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(hash ?? '')) continue;
    const stat = rest.join('\n');
    const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    res.push({ hash, ts: ts ?? '', files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) });
  }
  return res;
}

export function decide(ctx: GateContext, opts: { busyTimeoutMs?: number } = {}): Verdict {
  const home = ctx.env.HOME;
  if (!home) return { kind: 'unknown', reason: 'HOME не задан — путь журнала неизвестен', gate: NAME };
  const cwd = ctx.payload.cwd;
  const root = toplevel(cwd);
  if (root === null) {
    // Каталога нет — данных нет; каталог есть, но не репозиторий — коммитов здесь быть не может.
    try { statSync(cwd); } catch { return { kind: 'unknown', reason: 'cwd из payload не существует', gate: NAME }; }
    return { kind: 'silent' };
  }
  const email = git(root, ['config', '--get', 'user.email'], 3000);
  if (email.rc !== 0 || !email.stdout.trim()) return { kind: 'unknown', reason: 'git user.email не настроен — коммиты не атрибутировать', gate: NAME };
  const h = head(root);
  if (h === null) return { kind: 'silent' }; // пустой репозиторий без коммитов — нечего собирать
  const repoHash = shortHash(root);
  const markerKey = `capture-commits:head:${repoHash}`;

  const st = State.open(ctx.stateDir, { busyTimeoutMs: opts.busyTimeoutMs });
  try {
    if (st.marker(markerKey) === h) return { kind: 'silent' };
    const log = git(root, ['log', `--since=${SINCE}`, '-n', String(LIMIT), `--author=${email.stdout.trim()}`, '--pretty=format:%x1e%H%x1f%cI', '--shortstat', 'HEAD'], 8000);
    if (log.rc !== 0) return { kind: 'unknown', reason: `git log не ответил: ${log.stderr.split('\n')[0]}`, gate: NAME };
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 3000);
    const bclass = branch.rc === 0 ? branchClass(branch.stdout.trim()) : 'unknown';
    const commits = parseLog(log.stdout);
    const path = journalPath(home);
    const session = ctx.payload.session_id;
    try {
      st.tx(() => {
        const ins = st.db.prepare("INSERT OR IGNORE INTO journal_index(journal, key) VALUES('commits', ?)");
        for (const c of commits) {
          if (Number(ins.run(c.hash).changes) !== 1) continue; // уже в журнале — чужой сессией или прошлым ходом
          appendJsonl(path, 'commits', { ts: c.ts, adapter: ADAPTER, session, repo_hash: repoHash, commit_hash: c.hash, files: c.files, insertions: c.insertions, deletions: c.deletions, branch_class: bclass });
        }
        st.setMarker(markerKey, h, ctx.now());
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // SQLITE_BUSY: замок у соседа дольше busy_timeout — журнал не тронут, маркер не сдвинут.
      return { kind: 'unknown', reason: `запись отложена: ${msg.split('\n')[0]}`, gate: NAME };
    }
    return { kind: 'silent' };
  } finally { st.close(); }
}

const gate: Gate = { name: NAME, events: ['stop'], killSwitch: KILL, run: (ctx) => decide(ctx) };
register(gate);
