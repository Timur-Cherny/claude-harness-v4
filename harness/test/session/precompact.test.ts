// Молча ломалось бы: снимок перед сжатием контекста уносил имена файлов или читал транскрипт.
// INVARIANT I3: в снимке только агрегаты (счётчики грязи, размер транскрипта, ветка, HEAD); cap 200 строк
// держится самоподрезкой; вне репозитория — тишина, несуществующий cwd — unknown.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, payload, HARNESS_ROOT } from '../_env.ts';
import { initRepo, commit, sh } from './_git.ts';
import { decide, dirtyCounts, MAX_ROWS, KILL, NAME } from '../../src/session/precompact.ts';
import { State } from '../../src/state.ts';
import { route } from '../../src/main.ts';
import type { GateContext } from '../../src/types.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

type Sb = ReturnType<typeof sandbox>;
function ctxFor(sb: Sb, cwd: string, extra: Record<string, unknown> = {}): GateContext {
  return { event: 'precompact', payload: payload('PreCompact', { trigger: 'auto', ...extra }, cwd) as never, env: { HOME: sb.home }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 1_800_000_000_000 };
}
function snapshots(sb: Sb): Record<string, unknown>[] {
  const st = State.open(sb.stateDir);
  try {
    if (!st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='precompact_snapshots'").get()) return [];
    return st.db.prepare('SELECT * FROM precompact_snapshots ORDER BY id').all() as Record<string, unknown>[];
  } finally { st.close(); }
}

describe(NAME, () => {
  const sb = sandbox('harness-precompact-');
  after(() => sb.cleanup());

  it('stores one aggregate row: trigger, branch, short head, dirty counts and transcript size — and no file name', () => {
    const repo = initRepo(join(sb.dir, 'repo'), { branch: 'feature/secret-task' }); commit(repo, 'base.txt', '1\n');
    writeFileSync(join(repo, 'staged-secret.txt'), 's\n'); sh(repo, 'git', ['add', 'staged-secret.txt']);
    writeFileSync(join(repo, 'base.txt'), 'changed\n');
    writeFileSync(join(repo, 'untracked-secret.txt'), 'u\n');
    const transcript = join(sb.dir, 'transcript.jsonl'); writeFileSync(transcript, 'x'.repeat(1234));
    assert.equal(decide(ctxFor(sb, repo, { transcript_path: transcript })).kind, 'silent');
    const rows = snapshots(sb);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.trigger, 'auto');
    assert.equal(r.branch, 'feature/secret-task');
    assert.equal(r.repo, 'repo');
    assert.deepEqual([r.staged, r.unstaged, r.untracked, r.transcript_bytes], [1, 1, 1, 1234]);
    assert.match(String(r.head), /^[0-9a-f]{7,}$/);
    const serialized = JSON.stringify(rows);
    for (const leak of ['staged-secret', 'untracked-secret', 'base.txt', sb.dir]) assert.equal(serialized.includes(leak), false, `утечка «${leak}»`);
  });

  it('keeps at most 200 rows, dropping the oldest', () => {
    const repo = join(sb.dir, 'repo');
    const st = State.open(sb.stateDir);
    try { for (let i = 0; i < MAX_ROWS + 4; i++) st.db.prepare("INSERT INTO precompact_snapshots(ts, session) VALUES('t', ?)").run(`s-${i}`); } finally { st.close(); }
    decide(ctxFor(sb, repo, { session_id: 'last' }));
    const rows = snapshots(sb);
    assert.equal(rows.length, MAX_ROWS);
    assert.equal(rows[0].session, 's-5', 'старейшие строки не подрезаны');
    assert.equal(rows.at(-1)?.session, 'last');
  });

  it('counts a line staged and unstaged at once like the original (`MM`), and `??` only as untracked', () => {
    assert.deepEqual(dirtyCounts([{ xy: 'MM' }, { xy: 'A ' }, { xy: ' D' }, { xy: '??' }, { xy: 'R ' }]), { staged: 3, unstaged: 2, untracked: 1 });
  });

  it('is silent outside a repository, unknown for a missing cwd, and a missing transcript is size 0 rather than a crash', () => {
    const plain = join(sb.dir, 'plain'); mkdirSync(plain, { recursive: true });
    assert.equal(decide(ctxFor(sb, plain)).kind, 'silent');
    const v = decide(ctxFor(sb, join(sb.dir, 'absent')));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /не существует/);
    const before = snapshots(sb).length;
    assert.equal(decide(ctxFor(sb, join(sb.dir, 'repo'), { transcript_path: join(sb.dir, 'no-such-transcript') })).kind, 'silent');
    assert.equal(snapshots(sb).at(-1)?.transcript_bytes, 0);
    assert.equal(snapshots(sb).length, Math.min(before + 1, MAX_ROWS));
  });

  it('is skipped by its kill-switch through route(): silent and no snapshot table', async () => {
    const sb2 = sandbox('harness-precompact-kill-');
    const repo = initRepo(join(sb2.dir, 'r')); commit(repo, 'a', '1\n');
    const v = await route('precompact', payload('PreCompact', { trigger: 'manual' }, repo) as never, { HOME: sb2.home, CLAUDE_STATE_DIR: sb2.stateDir, HARNESS_ROOT, [KILL]: '1' });
    assert.equal(v.kind, 'silent');
    assert.deepEqual(snapshots(sb2), []);
    assert.equal(existsSync(join(sb2.home, '.claude', 'precompact-log.jsonl')), false);
    sb2.cleanup();
  });
});
