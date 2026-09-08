// INVARIANT I6: 8 сессий на одной базе не теряют и не двоят записи; claim атомарен; порядок PRAGMA
// (busy_timeout первым) даёт 0 «database is locked» при параллельном открытии свежей базы.
// Молча ломалось: capture-commits без замка писал журнал и снимал чужой lock (capture-commits-lock.test.sh).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { State } from '../src/state.ts';
import { sandbox, NODE_BIN, HARNESS_ROOT } from './_env.ts';

describe('State', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('opens a fresh database with the schema and an explicit user_version', () => {
    const st = State.open(sb.stateDir);
    const ver = (st.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(ver, 1);
    const tables = (st.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['verified', 'jobs', 'findings', 'claims', 'stop_blocks', 'agent_window', 'markers']) assert.ok(tables.includes(t), t);
    st.close();
  });

  it('grants a claim to exactly one of two claimants for the same (session, event, tool_use_id)', () => {
    const a = State.open(sb.stateDir); const b = State.open(sb.stateDir);
    const first = a.claim('s1', 'post', 'toolu_x'); const second = b.claim('s1', 'post', 'toolu_x');
    assert.deepEqual([first, second], [true, false]);
    assert.equal(a.claim('s1', 'post', 'toolu_y'), true);
    a.close(); b.close();
  });

  it('survives 16 processes opening a fresh database at once — zero "database is locked" (busy_timeout before WAL)', () => {
    const sb2 = sandbox(); const script = join(sb2.dir, 'open.ts');
    writeFileSync(script, `import { State } from '${HARNESS_ROOT}/src/state.ts';\nconst st = State.open(process.argv[2]);\nst.tx(() => st.db.prepare('INSERT INTO markers(key,value,at) VALUES(?,?,?)').run('p' + process.pid, 'x', 1));\nst.close();\nconsole.log('ok');`);
    const procs = Array.from({ length: 16 }, () => spawnSync(NODE_BIN, ['--disable-warning=ExperimentalWarning', script, sb2.stateDir], { encoding: 'utf8' }));
    // spawnSync последовательный; настоящую параллельность даёт sh с &:
    const par = spawnSync('sh', ['-c', `for i in $(seq 1 16); do "${NODE_BIN}" --disable-warning=ExperimentalWarning "${script}" "${sb2.stateDir}_par" & done; wait`], { encoding: 'utf8', timeout: 60000 });
    assert.equal(procs.filter((p) => p.status === 0).length, 16, procs.map((p) => p.stderr).join('\n'));
    assert.equal((par.stdout.match(/ok/g) ?? []).length, 16, par.stderr);
    const st = State.open(sb2.stateDir + '_par');
    assert.equal((st.db.prepare('SELECT count(*) c FROM markers').get() as { c: number }).c, 16);
    st.close(); sb2.cleanup();
  });

  it('moves a corrupt file aside and starts empty — everything becomes unverified, never silently verified', () => {
    const sb3 = sandbox();
    writeFileSync(join(sb3.stateDir, 'harness.db'), 'this is not a database, definitely not');
    const st = State.open(sb3.stateDir);
    assert.equal((st.db.prepare('SELECT count(*) c FROM verified').get() as { c: number }).c, 0);
    st.close();
    assert.ok(readdirSync(sb3.stateDir).some((f) => f.startsWith('harness.db.corrupt-')), 'повреждённая база не отложена в сторону');
    assert.ok(existsSync(join(sb3.stateDir, 'harness.db')));
    sb3.cleanup();
  });

  it('rolls a failed transaction back completely', () => {
    const st = State.open(sb.stateDir);
    assert.throws(() => st.tx(() => { st.setMarker('k', 'v'); throw new Error('mid'); }), /mid/);
    assert.equal(st.marker('k'), null);
    st.close();
  });
});
