// Молча ломалось: capture-commits.sh без замка писал журнал и снимал чужой lock; журнал нёс `date`
// и имя репозитория; дедуп — grep по файлу, гонка двух сессий давала дубль.
// INVARIANT I3/I6: в журнале commits только поля белого списка (без темы/email/пути); каждый коммит —
// ровно одна строка при любом числе параллельных Stop; сосед без замка не пишет и не «снимает» чужой замок.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, payload, NODE_BIN, HARNESS_ROOT, onlyGate } from '../_env.ts';
import { initRepo, commit } from './_git.ts';
import { decide, parseLog, branchClass, journalPath, KILL, NAME } from '../../src/session/capture-commits.ts';
import { State } from '../../src/state.ts';
import { route } from '../../src/main.ts';
import { WHITELIST } from '../../src/journal.ts';
import type { GateContext } from '../../src/types.ts';

// I7: git внутри гейта наследует окружение процесса — глобальный ~/.gitconfig владельца не должен
// подсказывать user.email временному репозиторию.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

function ctxFor(sb: ReturnType<typeof sandbox>, cwd: string, extraEnv: Record<string, string> = {}): GateContext {
  return { event: 'stop', payload: payload('Stop', {}, cwd) as never, env: { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, ...extraEnv }, root: HARNESS_ROOT, stateDir: sb.stateDir, now: () => 1_800_000_000_000 };
}
function lines(p: string): Record<string, unknown>[] { return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []; }

describe(NAME, () => {
  const sb = sandbox('harness-commits-');
  after(() => sb.cleanup());

  it('writes one whitelisted metadata line per new commit of the configured user — no subject, author, email or path', () => {
    const repo = initRepo(join(sb.dir, 'r1'));
    const h = commit(repo, 'a.txt', 'one\ntwo\n', 'secret subject SUBJ-1');
    assert.equal(decide(ctxFor(sb, repo)).kind, 'silent');
    const rows = lines(journalPath(sb.home));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].commit_hash, h);
    assert.deepEqual([rows[0].files, rows[0].insertions, rows[0].deletions, rows[0].branch_class], [1, 2, 0, 'main']);
    for (const k of Object.keys(rows[0])) assert.ok(WHITELIST.commits.has(k as never), `поле вне белого списка: ${k}`);
    const raw = readFileSync(journalPath(sb.home), 'utf8');
    for (const leak of ['SUBJ-1', 'test@example', 'TEST', '/r1', sb.dir]) assert.equal(raw.includes(leak), false, `утечка «${leak}»`);
  });

  it('takes the fast path when HEAD did not move and appends nothing', () => {
    const repo = join(sb.dir, 'r1');
    const before = readFileSync(journalPath(sb.home), 'utf8');
    assert.equal(decide(ctxFor(sb, repo)).kind, 'silent');
    assert.equal(readFileSync(journalPath(sb.home), 'utf8'), before);
  });

  it('logs a new own commit once and skips a commit by another author, without duplicating the earlier one', () => {
    const repo = join(sb.dir, 'r1');
    const mine = commit(repo, 'b.txt', 'x\n', 'mine');
    const foreign = commit(repo, 'c.txt', 'y\n', 'theirs', 'Other <other@example.invalid>');
    assert.equal(decide(ctxFor(sb, repo)).kind, 'silent');
    const hashes = lines(journalPath(sb.home)).map((r) => r.commit_hash);
    assert.equal(hashes.length, 2);
    assert.ok(hashes.includes(mine));
    assert.equal(hashes.includes(foreign), false);
    assert.equal(new Set(hashes).size, hashes.length);
  });

  it('returns unknown and leaves the journal untouched while another writer holds the state lock — the foreign lock is not broken', () => {
    const sb2 = sandbox('harness-commits-lock-');
    const repo = initRepo(join(sb2.dir, 'r')); commit(repo, 'a.txt', '1\n');
    const holder = State.open(sb2.stateDir);
    holder.db.exec('BEGIN IMMEDIATE');
    holder.db.prepare("INSERT INTO markers(key,value,at) VALUES('foreign','1',1)").run();
    const v = decide(ctxFor(sb2, repo), { busyTimeoutMs: 150 });
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /отложена/);
    assert.equal(existsSync(journalPath(sb2.home)), false, 'журнал записан без замка');
    holder.db.exec('COMMIT');
    assert.equal(holder.marker('foreign'), '1', 'чужая транзакция пострадала');
    holder.close();
    // После освобождения замка тот же Stop пишет ровно одну строку.
    assert.equal(decide(ctxFor(sb2, repo)).kind, 'silent');
    assert.equal(lines(journalPath(sb2.home)).length, 1);
    sb2.cleanup();
  });

  it('keeps exactly one line per commit under 6 concurrent Stop processes on a fresh state', () => {
    const sb3 = sandbox('harness-commits-par-');
    const repo = initRepo(join(sb3.dir, 'r'));
    const hashes = [commit(repo, 'a', '1\n'), commit(repo, 'b', '2\n'), commit(repo, 'c', '3\n')];
    const script = join(sb3.dir, 'stop.ts');
    writeFileSync(script, `import { decide } from '${HARNESS_ROOT}/src/session/capture-commits.ts';\nconst v = decide({ event: 'stop', payload: { session_id: 's', cwd: ${JSON.stringify(repo)}, hook_event_name: 'Stop' }, env: { HOME: ${JSON.stringify(sb3.home)} }, root: '', stateDir: ${JSON.stringify(sb3.stateDir)}, now: Date.now });\nconsole.log(v.kind);`);
    const r = spawnSync('sh', ['-c', `for i in 1 2 3 4 5 6; do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/silent/g) ?? []).length, 6, r.stdout + r.stderr);
    const got = lines(journalPath(sb3.home)).map((x) => x.commit_hash).sort();
    assert.deepEqual(got, [...hashes].sort());
    sb3.cleanup();
  });

  it('answers unknown when user.email is not configured — commits cannot be attributed, silence would hide it', () => {
    const repo = initRepo(join(sb.dir, 'noemail'), { email: null }); commit(repo, 'a', '1\n', 'm', 'X <x@example.invalid>');
    const v = decide(ctxFor(sb, repo));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /user\.email/);
  });

  it('stays silent outside a git repository and answers unknown for a cwd that does not exist', () => {
    const plain = join(sb.dir, 'plain'); mkdirSync(plain, { recursive: true });
    assert.equal(decide(ctxFor(sb, plain)).kind, 'silent');
    const v = decide(ctxFor(sb, join(sb.dir, 'nope')));
    assert.equal(v.kind, 'unknown');
    assert.match((v as { reason: string }).reason, /не существует/);
  });

  it('is skipped entirely by its kill-switch through route(): silent, no journal, no state written', async () => {
    const sb4 = sandbox('harness-commits-kill-');
    const repo = initRepo(join(sb4.dir, 'r')); commit(repo, 'a', '1\n');
    const v = await route('stop', payload('Stop', {}, repo) as never, { HOME: sb4.home, CLAUDE_STATE_DIR: sb4.stateDir, HARNESS_ROOT, ...onlyGate('capture-commits'), [KILL]: '1' });
    assert.equal(v.kind, 'silent');
    assert.equal(existsSync(journalPath(sb4.home)), false);
    // Соседние stop-гейты других групп могут открыть базу; след ЭТОГО гейта — индекс журнала и маркер.
    if (existsSync(join(sb4.stateDir, 'harness.db'))) {
      const st = State.open(sb4.stateDir);
      assert.equal((st.db.prepare("SELECT count(*) c FROM journal_index WHERE journal='commits'").get() as { c: number }).c, 0);
      assert.equal((st.db.prepare("SELECT count(*) c FROM markers WHERE key LIKE 'capture-commits:%'").get() as { c: number }).c, 0);
      st.close();
    }
    sb4.cleanup();
  });

  it('parses --shortstat chunks and classifies branch names without keeping the subject', () => {
    const out = '\x1e' + 'a'.repeat(40) + '\x1f2026-09-05T10:00:00+06:00\n\n 2 files changed, 10 insertions(+), 3 deletions(-)\n\x1e' + 'b'.repeat(40) + '\x1f2026-09-04T10:00:00+06:00\n\n 1 file changed, 1 insertion(+)\n\x1e' + 'c'.repeat(40) + '\x1f2026-09-03T10:00:00+06:00\n';
    const p = parseLog(out);
    assert.deepEqual(p.map((c) => [c.files, c.insertions, c.deletions]), [[2, 10, 3], [1, 1, 0], [0, 0, 0]]);
    assert.deepEqual(['main', 'master', 'release/1.2', 'hotfix/x', 'feature/JS-1-secret', 'HEAD', 'tmp'].map(branchClass), ['main', 'main', 'release', 'hotfix', 'feature', 'detached', 'other']);
  });
});
