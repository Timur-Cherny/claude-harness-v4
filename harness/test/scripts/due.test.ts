// Порт hooks/spec/due-schedule.test.sh: каждое правило расписания проверяется с ОБЕИХ сторон.
// INVARIANT: отсутствие отметки о прогоне или источника сигнала даёт unknown, а не ok (I1);
// параллельные --done не теряют друг друга (I6 — замок БД, не удача).
// REGRESSION: первый запуск подхватывает прежний schedule-state.json, второй его не переимпортирует.
// Молча ломалось бы: расписание, считавшее «не отмечено» за «в норме», никогда не будило прогон.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, payload, NODE_BIN, HARNESS_ROOT } from '../_env.ts';
import { run, schedule, localDate, daysBetween, countLines, SCHEDULE_GATE, KILL_SWITCH, ScheduleStore } from '../../scripts/due.ts';
import { route } from '../../src/main.ts';
import { GATES, register } from '../../src/gates/registry.ts';
import { State } from '../../src/state.ts';

const BRAIN_ROOT = join(HARNESS_ROOT, '..');
const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime(); // локальный полдень: сдвиг DST не меняет дату
const today = localDate(NOW);
const ago = (d: number) => localDate(NOW - d * 86400000);
const NOTES = 40;

interface Fixture { root: string; stateDir: string; opts: { root: string; stateDir: string; now: () => number; env: Record<string, string> } }

/** Герметичный корень мозга: настоящая спека каденции, синтетические сигналы. */
function fixture(sb: ReturnType<typeof sandbox>, name: string, o: { jsonl?: boolean; notes?: number; env?: Record<string, string> } = {}): Fixture {
  const root = join(sb.dir, name); const stateDir = join(sb.dir, `${name}-state`);
  mkdirSync(join(root, 'specs'), { recursive: true }); mkdirSync(join(root, 'memory', 'x'), { recursive: true });
  mkdirSync(join(root, 'epics', 'chips'), { recursive: true }); mkdirSync(stateDir, { recursive: true });
  copyFileSync(join(BRAIN_ROOT, 'specs', 'schedule.json'), join(root, 'specs', 'schedule.json'));
  for (let i = 0; i < (o.notes ?? NOTES); i++) writeFileSync(join(root, 'memory', 'x', `n${i}.md`), '');
  writeFileSync(join(root, 'memory', 'x', 'MEMORY.md'), '');
  writeFileSync(join(root, 'epics', 'chips', 'c.md'), '---\nstatus: open\n---\n');
  if (o.jsonl !== false) {
    writeFileSync(join(root, 'ai-usage-raw.jsonl'), '{}\n{}\n'); writeFileSync(join(root, 'worklog-commits.jsonl'), '{}\n');
    writeFileSync(join(stateDir, 'personal-friction.jsonl'), '{}\n{}\n{}');
  }
  return { root, stateDir, opts: { root, stateDir, now: () => NOW, env: o.env ?? {} } };
}

/** Прежнее состояние в формате bash-оригинала — подхватывается импортом при первом запуске. */
function legacyState(stateDir: string, rule: string, lastRun: string | null, signals: Record<string, number>): void {
  writeFileSync(join(stateDir, 'schedule-state.json'), JSON.stringify({ [rule]: { last_run: lastRun, first_seen: ago(90), signals } }));
}

const line = (out: string, re: RegExp) => out.split('\n').find((l) => re.test(l));

describe('scripts/due', () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it('reports unknown for every rule on an empty state and never prints ok', () => {
    const f = fixture(sb, 'empty');
    const out = run(['--all'], f.opts).stdout;
    assert.ok(line(out, /\? unknown .*\/memory-review/), out);
    assert.equal(line(out, /✓ ok/), undefined, out);
  });

  it('closes unknown into ok after --done', () => {
    const f = fixture(sb, 'done');
    const d = run(['--done', 'memory-review'], f.opts);
    assert.equal(d.rc, 0); assert.match(d.stdout, new RegExp(`отмечен ${today}`));
    assert.ok(line(run(['--all'], f.opts).stdout, /✓ ok\s+\/memory-review/));
  });

  it('turns due when the signal grew by the threshold (memory-review: +25)', () => {
    const f = fixture(sb, 'delta'); legacyState(f.stateDir, 'memory-review', ago(10), { memory_notes: NOTES - 25 });
    assert.ok(line(run([], f.opts).stdout, /▶ due .*\/memory-review.*\+25 memory_notes \(порог 25\)/));
  });

  it('stays ok when the growth is one below the threshold (+24) — the other side of the delta', () => {
    const f = fixture(sb, 'delta-below'); legacyState(f.stateDir, 'memory-review', ago(10), { memory_notes: NOTES - 24 });
    const out = run(['--all'], f.opts).stdout;
    assert.ok(line(out, /✓ ok\s+\/memory-review.*\+24\/25 memory_notes, 10д\/21/), out);
    assert.equal(line(run([], f.opts).stdout, /memory-review/), undefined, 'без --all здоровое правило не показывается');
  });

  it('turns due without any growth once the run is older than max_interval_days (21)', () => {
    const f = fixture(sb, 'ceiling'); legacyState(f.stateDir, 'memory-review', ago(30), { memory_notes: NOTES });
    assert.ok(line(run([], f.opts).stdout, /▶ due .*\/memory-review.*30д с прогона \(потолок 21\)/));
  });

  it('holds instead of due when the delta is over but the run is fresher than min_interval_days (5)', () => {
    const f = fixture(sb, 'floor'); legacyState(f.stateDir, 'memory-review', today, { memory_notes: NOTES - 100 });
    const out = run([], f.opts).stdout;
    assert.ok(line(out, /· held\s+\/memory-review.*придержано до 5д/), out);
    assert.equal(line(out, /▶ due .*\/memory-review/), undefined);
  });

  it('reports unknown with «источник» when the signal source is missing, even after --done — a missing file is not 0', () => {
    const f = fixture(sb, 'nosrc', { jsonl: false });
    run(['--done', 'friction-review'], f.opts);
    const out = run(['--all'], f.opts).stdout;
    assert.ok(line(out, /\? unknown \/friction-review источник сигнала friction_events отсутствует/), out);
  });

  it('keeps all three rows when three --done run in parallel through the CLI — no lost update', () => {
    const f = fixture(sb, 'par');
    const cmd = (id: string) => `"${NODE_BIN}" --disable-warning=ExperimentalWarning "${join(HARNESS_ROOT, 'scripts', 'due.ts')}" --root "${f.root}" --done ${id}`;
    const r = spawnSync('sh', ['-c', `${cmd('memory-review')} & ${cmd('worklog')} & ${cmd('ai-usage')} & wait`], { encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_STATE_DIR: f.stateDir, HOME: sb.home } });
    assert.equal(r.status, 0, r.stderr);
    const st = State.open(f.stateDir);
    const n = (st.db.prepare('SELECT COUNT(*) AS n FROM schedule WHERE last_run IS NOT NULL').get() as { n: number }).n;
    st.close();
    assert.equal(n, 3, r.stdout + r.stderr);
  });

  it('rejects --done for a rule missing from the spec, --done without an id, and an unknown argument — each with rc 2 and no state write', () => {
    const f = fixture(sb, 'badargs');
    for (const argv of [['--done', 'nonexistent-rule'], ['--done'], ['--bogus'], ['--root']]) {
      const r = run(argv, f.opts);
      assert.equal(r.rc, 2, argv.join(' ')); assert.match(r.stderr, /^due: /); assert.equal(r.stdout, '');
    }
    assert.equal(existsSync(join(f.stateDir, 'harness.db')), false, 'ошибка аргументов не открывает базу');
  });

  it('keeps --notify silent when every rule is healthy', () => {
    const f = fixture(sb, 'quiet'); legacyState(f.stateDir, 'memory-review', today, { memory_notes: NOTES });
    for (const id of ['friction-review', 'ai-usage', 'worklog']) run(['--done', id], f.opts);
    assert.deepEqual(run(['--notify'], f.opts), { rc: 0, stdout: '', stderr: '' });
  });

  it('prints the due command in --notify', () => {
    const f = fixture(sb, 'notify'); legacyState(f.stateDir, 'memory-review', ago(30), { memory_notes: NOTES });
    assert.match(run(['--notify'], f.opts).stdout, /назрело:.*\/memory-review/);
  });

  it('wakes on a stale unknown only past DUE_NOTIFY_UNKNOWN_DAYS — fresh unknown stays quiet (both sides)', () => {
    const f = fixture(sb, 'stale');
    assert.equal(run(['--notify'], f.opts).stdout, '');
    assert.match(run(['--notify'], { ...f.opts, env: { DUE_NOTIFY_UNKNOWN_DAYS: '0' } }).stdout, /без отметки 0д\+:/);
  });

  it('imports the legacy schedule-state.json once: rows survive, later --done updates the row, the file is not re-read', () => {
    const f = fixture(sb, 'legacy'); legacyState(f.stateDir, 'worklog', ago(3), { commits_logged: 1 });
    const first = schedule(f.opts);
    assert.ok(!('error' in first));
    const worklog = first.rows.find((r) => r.rule.id === 'worklog');
    assert.equal(worklog?.status, 'ok'); assert.match(worklog?.note ?? '', /^\+0\/60 commits_logged, 3д\/31$/);
    run(['--done', 'memory-review'], f.opts);
    writeFileSync(join(f.stateDir, 'schedule-state.json'), JSON.stringify({ worklog: { last_run: ago(300), first_seen: ago(300), signals: {} } }));
    const again = schedule(f.opts);
    assert.ok(!('error' in again));
    assert.equal(again.rows.find((r) => r.rule.id === 'worklog')?.status, 'ok', 'второй запуск не переимпортирует файл');
    assert.equal(again.rows.find((r) => r.rule.id === 'memory-review')?.status, 'ok');
  });

  it('declares the schedule unknown (rc 0, stderr) when specs/schedule.json is unreadable, and the gate returns unknown', () => {
    const f = fixture(sb, 'nospec'); writeFileSync(join(f.root, 'specs', 'schedule.json'), '{ not json');
    const r = run(['--all'], f.opts);
    assert.deepEqual([r.rc, r.stdout], [0, '']); assert.match(r.stderr, /schedule\.json нечитаем .* расписание неизвестно/);
    const v = SCHEDULE_GATE.run({ event: 'session-start', payload: payload('SessionStart') as never, env: {}, root: join(f.root, 'harness'), stateDir: f.stateDir, now: () => NOW });
    assert.equal((v as { kind: string }).kind, 'unknown');
  });

  it('is silenced by CLAUDE_SKIP_SCHEDULE=1 through route() before any state write, and reports through context without it', async () => {
    const f = fixture(sb, 'kill');
    if (!GATES.some((g) => g.name === SCHEDULE_GATE.name)) register(SCHEDULE_GATE);
    const others = Object.fromEntries(GATES.filter((g) => g.name !== SCHEDULE_GATE.name).map((g) => [g.killSwitch, '1']));
    const env = { ...others, HOME: sb.home, HARNESS_ROOT: join(f.root, 'harness'), CLAUDE_STATE_DIR: f.stateDir };
    const off = await route('session-start', payload('SessionStart') as never, { ...env, [KILL_SWITCH]: '1' });
    assert.equal(off.kind, 'silent');
    assert.deepEqual(readdirSync(f.stateDir).filter((n) => n !== 'personal-friction.jsonl'), [], 'выключатель не оставил следов в состоянии');
    const on = await route('session-start', payload('SessionStart') as never, env);
    assert.equal(on.kind, 'context');
    assert.match((on as { text: string }).text, /\? unknown .*\/memory-review/);
    assert.ok(existsSync(join(f.stateDir, 'harness.db')));
  });

  it('counts lines like the original: a trailing line without newline counts, a missing file is null', () => {
    const p = join(sb.dir, 'lines.jsonl'); writeFileSync(p, 'a\nb\nc');
    assert.equal(countLines(p), 3); writeFileSync(p, 'a\nb\n'); assert.equal(countLines(p), 2);
    assert.equal(countLines(join(sb.dir, 'absent.jsonl')), null);
    assert.equal(daysBetween('2026-09-05', '2026-08-06'), 30); assert.equal(daysBetween('2026-09-05', '2026-02-30'), null); assert.equal(daysBetween('2026-09-05', null), null);
  });

  it('opens the schedule table on a plain harness.db without touching SCHEMA (CREATE TABLE IF NOT EXISTS in the module)', () => {
    const dir = join(sb.dir, 'tbl-state');
    const store = ScheduleStore.open(dir);
    const tables = (store.state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule'").all() as { name: string }[]).map((r) => r.name);
    store.close();
    assert.deepEqual(tables, ['schedule']);
  });
});
