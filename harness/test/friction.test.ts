// Порт hooks/spec/friction-classify.test.sh (15 кейсов) + окно агента (H7) + доковые пути (H6).
// Молча ломалось: classify считал `work-docs/sql/sample.sql` с NOT NULL за миграцию с констрейнтом
// (INC-FRICTION-DOC-AS-CONSTRAINT, класс К1 — regex по тексту), а окно диффа было общим для всех
// агентов сессии (INC-FRICTION-UNKNOWN-AGENTS: attribution всегда window).
// INVARIANT: уровень и след — функции диффа с начала окна агента; документ описывает гарантию, а не
// создаёт её; SQL виден только как AST (parseSql), TS — только как AST (compiler API проекта);
// нет парсера → trace_kind unknown + причина, никогда не none и не constraint.
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, appendFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { route } from '../src/main.ts';
import { State } from '../src/state.ts';
import '../src/friction.ts';
import { sandbox, payload } from './_env.ts';
import type { Sandbox } from './_env.ts';

/** Настоящий typescript с этой машины (CLAUDE_HARNESS_TS / worktree WMS / nvm); нет — TS-кейсы пропускаются с пометкой. */
function findTypescript(): string | null {
  const cands: string[] = [];
  if (process.env.CLAUDE_HARNESS_TS) cands.push(dirname(dirname(process.env.CLAUDE_HARNESS_TS)));
  for (const base of [process.env.WMS_TREES].filter((x): x is string => Boolean(x))) {
    try { for (const d of readdirSync(base)) cands.push(join(base, d, 'node_modules', 'typescript')); } catch { /* каталога нет */ }
  }
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  try { for (const v of readdirSync(nvm)) cands.push(join(nvm, v, 'lib', 'node_modules', 'typescript')); } catch { /* nvm нет */ }
  return cands.find((c) => existsSync(join(c, 'package.json'))) ?? null;
}
const TS_LIB = findTypescript();
const itTs = TS_LIB ? it : it.skip;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
let seq = 0;
function mkRepo(sb: Sandbox, withTs = false): string {
  const repo = join(sb.dir, `repo${seq++}`); mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q'); writeFileSync(join(repo, 'README.md'), 'base\n'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'init');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  if (withTs && TS_LIB) { mkdirSync(join(repo, 'node_modules')); symlinkSync(TS_LIB, join(repo, 'node_modules', 'typescript')); }
  return repo;
}
function write(repo: string, rel: string, text: string): void { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); }
// Сосед по событию agent-stop (sweep) выключен своим kill-switch: здесь под тестом только friction.
function env(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> { return { HOME: sb.home, CLAUDE_STATE_DIR: sb.stateDir, CLAUDE_SKIP_TREE_SWEEP: '1', ...extra }; }
// Своя сессия на каждый тест: корни сессии и окна агентов живут в общей базе и иначе перетекают между тестами.
let sessSeq = 0; let session = 'session-0';
const newSession = (): void => { session = `session-${++sessSeq}`; };
let agentSeq = 0;
const agent = (): string => `agent-${++agentSeq}`;
async function start(sb: Sandbox, cwd: string, id: string, extra: Record<string, unknown> = {}) {
  return route('agent-start', payload('SubagentStart', { session_id: session, agent_id: id, agent_type: 'worker', ...extra }, cwd) as never, env(sb));
}
async function stop(sb: Sandbox, cwd: string, id: string, extra: Record<string, unknown> = {}, e: Record<string, string> = {}) {
  return route('agent-stop', payload('SubagentStop', { session_id: session, agent_id: id, agent_type: 'worker', ...extra }, cwd) as never, env(sb, e));
}
type Ev = Record<string, unknown>;
function events(sb: Sandbox): Ev[] {
  const p = join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev) : [];
}
function last(sb: Sandbox): Ev { const e = events(sb); assert.ok(e.length, 'no friction event written'); return e[e.length - 1]; }

describe('friction: level by diff (port of friction-classify.test.sh)', () => {
  const sb = sandbox('harction-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('reports no_change with scope none on a clean tree instead of inventing a level, and stays silent', async () => {
    const repo = mkRepo(sb);
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent');
    const e = last(sb);
    assert.equal(e.friction_state, 'no_change'); assert.equal(e.scope, 'none'); assert.equal(e.trace_kind, 'none'); assert.equal(e.files_changed, 0);
  });
  it('rates one file in one root as function', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function');
  });
  it('rates more than three files as module', async () => {
    const repo = mkRepo(sb); for (let i = 1; i <= 5; i++) write(repo, `src/f${i}.py`, `x=${i}\n`);
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'module');
  });
  it('rates a migration under src/ as domain, but a migration that only adds a column carries no trace and is not sufficient', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/001.sql', 'ALTER TABLE t ADD COLUMN c int;\n');
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'domain');
    assert.notEqual(e.trace_kind, 'constraint');
    assert.equal(e.trace_kind, 'none');
    assert.equal(e.safeguard_sufficient, false);
  });
  it('rates a migration with ADD CONSTRAINT UNIQUE as domain/constraint and a sufficient safeguard', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/002.sql', 'ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b);\n');
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent');
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'constraint'); assert.equal(e.safeguard_sufficient, true);
  });
  it('does not take a NOT NULL column for a constraint trace — a new column is not a guarantee (SPEC: CHECK/UNIQUE/INDEX/FK)', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/003.sql', 'ALTER TABLE t ADD COLUMN c int NOT NULL DEFAULT 0;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not take SQL words inside a code string for a constraint — the classifier no longer measures its own source (К1)', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'CONSTRAINT = "add constraint|unique|not null"\n');
    await stop(sb, repo, agent());
    assert.notEqual(last(sb).trace_kind, 'constraint'); assert.equal(last(sb).scope, 'function');
  });
  it('does not take a SQL string in a non-migration TS file for a constraint — only queryRunner.query literals inside migrations count', async () => {
    const repo = mkRepo(sb); write(repo, 'src/repo.ts', "export const q = 'ALTER TABLE t ADD CONSTRAINT u UNIQUE (a)';\n");
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none'); assert.equal(last(sb).scope, 'function');
  });
  itTs('reads CREATE UNIQUE INDEX out of a queryRunner.query literal in a TS migration via the TS-AST and SQL-AST — domain/constraint', async () => {
    const repo = mkRepo(sb, true);
    write(repo, 'src/migrations/1725000000000-serial-unique.ts', [
      "import { MigrationInterface, QueryRunner } from 'typeorm';",
      'export class SerialUnique1725000000000 implements MigrationInterface {',
      '  public async up(queryRunner: QueryRunner): Promise<void> {',
      '    await queryRunner.query(`CREATE UNIQUE INDEX "units_serial_uniq" ON "units" ("serial_id") WHERE quantity > 0`);',
      '  }',
      '  public async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`DROP INDEX "units_serial_uniq"`); }',
      '}', ''].join('\n'));
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'silent', JSON.stringify(v));
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'constraint'); assert.equal(e.safeguard_sufficient, true);
  });
  itTs('ignores a constraint that lives only in a comment of a TS migration — a comment is not a statement', async () => {
    const repo = mkRepo(sb, true);
    write(repo, 'src/migrations/1725000000001-note.ts', [
      '// ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b) — сделать в следующей миграции',
      'export class Note1725000000001 { public async up(queryRunner: { query(s: string): Promise<void> }): Promise<void> { await queryRunner.query(`ALTER TABLE t ADD COLUMN c int`); } }', ''].join('\n'));
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'domain'); assert.equal(last(sb).trace_kind, 'none');
  });
  itTs('rates a spec file whose added lines carry a live expect() as assertion', async () => {
    const repo = mkRepo(sb, true); write(repo, 'src/a.spec.ts', 'expect(1).toBe(1);\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'assertion');
  });
  itTs('does not rate a spec file with the assert commented out as assertion — the path is not the trace', async () => {
    const repo = mkRepo(sb, true); write(repo, 'src/a.spec.ts', '// expect(1).toBe(1);\nexport const x = 1;\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('rates a file under hooks/ as guard', async () => {
    const repo = mkRepo(sb); write(repo, 'hooks/g.sh', 'echo guard\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'guard');
  });
  it('rates a skill file under skills/ as rule', async () => {
    const repo = mkRepo(sb); write(repo, 'skills/x/SKILL.md', 'правило\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'rule');
  });
  it('rates a plain edit without a safeguard as none', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'y = 2\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'none');
  });
  it('moves the window: a second stop without edits reports no_change', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'y = 2\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).friction_state, 'derived_from_diff');
    await stop(sb, repo, agent());
    assert.equal(last(sb).friction_state, 'no_change');
  });
  it('answers unknown with not_a_git_repo outside git and writes an event without a made-up level', async () => {
    const dir = join(sb.dir, 'nogit'); mkdirSync(dir, { recursive: true });
    const v = await stop(sb, dir, agent());
    assert.equal(v.kind, 'context', JSON.stringify(v)); assert.match((v as { text: string }).text, /unknown\(friction\).*not_a_git_repo/);
    const e = last(sb);
    assert.equal(e.friction_state, 'unavailable'); assert.equal(e.missing_reason, 'not_a_git_repo'); assert.equal('scope' in e, false);
  });
  it('sees a new file inside a new directory (-uall) — files_changed 1', async () => {
    const repo = mkRepo(sb); write(repo, 'brand/new/dir/f.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).files_changed, 1);
  });
  it('writes every event as one valid JSON line', () => {
    const p = join(sb.home, '.claude', 'exec-telemetry', 'personal-friction.jsonl');
    for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l), l.slice(0, 80));
  });
});

describe('friction: documentation is not a guarantee (INC-FRICTION-DOC-AS-CONSTRAINT, H6)', () => {
  const sb = sandbox('harction-doc-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('rates work-docs/sql/sample.sql with NOT NULL and CONSTRAINT as function/none — a documented query creates nothing in a database', async () => {
    const repo = mkRepo(sb); write(repo, 'work-docs/sql/sample.sql', 'CREATE TABLE sample (id int NOT NULL, CONSTRAINT sample_uniq UNIQUE (id));\n');
    await stop(sb, repo, agent());
    const e = last(sb);
    assert.equal(e.scope, 'function'); assert.equal(e.trace_kind, 'none'); assert.equal(e.files_changed, 1);
  });
  it('rates a migration path outside src/ as neither domain nor constraint — only src/** is code', async () => {
    const repo = mkRepo(sb); write(repo, 'migrations/001.sql', 'ALTER TABLE t ADD CONSTRAINT t_uniq UNIQUE (a, b);\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).trace_kind, 'none');
  });
  it('does not lift two documentation edits in two roots to module', async () => {
    const repo = mkRepo(sb); write(repo, 'docs/a.md', 'a\n'); write(repo, 'epics/b.md', 'b\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).files_changed, 2);
  });
  it('rates edits in two repositories of the session as domain, unless both are documentation', async () => {
    const a = mkRepo(sb); const b = mkRepo(sb);
    const st = State.open(sb.stateDir);
    st.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(session, a, 1);
    st.db.prepare('INSERT OR IGNORE INTO session_roots(session_id, repo, first_seen) VALUES(?,?,?)').run(session, b, 1);
    st.close();
    write(a, 'src/a.py', 'x=1\n'); write(b, 'src/b.py', 'x=1\n');
    await stop(sb, a, agent());
    assert.equal(last(sb).scope, 'domain');
    write(a, 'notes/a.md', 'x\n'); write(b, 'notes/b.md', 'x\n');
    await stop(sb, a, agent());
    assert.equal(last(sb).scope, 'function'); assert.equal(last(sb).files_changed, 2);
  });
});

describe('friction: agent window and attribution (INC-FRICTION-UNKNOWN-AGENTS, H7)', () => {
  const sb = sandbox('harction-win-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('attributes the diff since SubagentStart to the agent and does not credit edits made before the start', async () => {
    const repo = mkRepo(sb); write(repo, 'src/before.py', 'x=1\n');
    const id = agent();
    assert.equal((await start(sb, repo, id)).kind, 'silent');
    await stop(sb, repo, id);
    const e = last(sb);
    assert.equal(e.attribution, 'agent'); assert.equal(e.files_changed, 0); assert.equal(e.friction_state, 'no_change'); assert.equal(e.concurrent_agents, 0);
    assert.equal(typeof e.duration_s, 'number');
  });
  it('credits the agent with a file changed inside its window', async () => {
    const repo = mkRepo(sb); const id = agent();
    await start(sb, repo, id); write(repo, 'src/inside.py', 'x=1\n');
    await stop(sb, repo, id);
    assert.equal(last(sb).attribution, 'agent'); assert.equal(last(sb).files_changed, 1);
  });
  it('marks agent_overlapping with concurrent_agents when another open agent shares the root', async () => {
    const repo = mkRepo(sb); const a = agent(); const b = agent();
    await start(sb, repo, a); await start(sb, repo, b); write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, a);
    assert.equal(last(sb).attribution, 'agent_overlapping'); assert.equal(last(sb).concurrent_agents, 1);
    await stop(sb, repo, b);
    assert.equal(last(sb).attribution, 'agent_overlapping');
  });
  it('falls back to attribution window when no SubagentStart was recorded — and says so instead of pretending', async () => {
    const repo = mkRepo(sb); write(repo, 'src/x.py', 'x=1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).attribution, 'window'); assert.equal(last(sb).concurrent_agents, null);
  });
  it('keeps an open agent of another root out of the concurrency count', async () => {
    const a = mkRepo(sb); const b = mkRepo(sb); const ida = agent(); const idb = agent();
    await start(sb, a, ida); await start(sb, b, idb); write(a, 'src/x.py', 'x=1\n');
    await stop(sb, a, ida);
    assert.equal(last(sb).attribution, 'agent'); assert.equal(last(sb).concurrent_agents, 0);
  });
  it('records an empty agent_type as null, not as an empty label', async () => {
    const repo = mkRepo(sb);
    await stop(sb, repo, agent(), { agent_type: '' });
    assert.equal(last(sb).agent_type, null);
  });
});

describe('friction: unknown is a verdict, not a silent none', () => {
  const sb = sandbox('harction-unk-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('reports trace_kind unknown with ts_parser_unavailable for a TS migration when no typescript is reachable from the file', async () => {
    const repo = mkRepo(sb, false);
    write(repo, 'src/migrations/1725000000002-x.ts', 'export class X { async up(q: { query(s: string): Promise<void> }) { await q.query(`CREATE UNIQUE INDEX i ON t (a)`); } }\n');
    const v = await stop(sb, repo, agent(), {}, { CLAUDE_HARNESS_TS: join(sb.dir, 'absent', 'typescript.js') });
    assert.equal(v.kind, 'context'); assert.match((v as { text: string }).text, /unknown\(friction\)/);
    const e = last(sb);
    assert.equal(e.scope, 'domain'); assert.equal(e.trace_kind, 'unknown'); assert.equal(e.missing_reason, 'ts_parser_unavailable'); assert.equal(e.safeguard_sufficient, null);
  });
  it('reports trace_kind unknown with sql_parse_error for a migration the SQL parser cannot read', async () => {
    const repo = mkRepo(sb); write(repo, 'src/migrations/bad.sql', 'ALTER TABEL t ADD CONSTRAINTT u UNIQUE (a);\n');
    const v = await stop(sb, repo, agent());
    assert.equal(v.kind, 'context');
    const e = last(sb);
    assert.equal(e.trace_kind, 'unknown'); assert.equal(e.missing_reason, 'sql_parse_error');
  });
  it('reports trace_kind unknown for a spec file that no parser of the harness can read', async () => {
    const repo = mkRepo(sb); write(repo, 'tests/test_a.py', 'assert 1 == 1\n');
    await stop(sb, repo, agent());
    assert.equal(last(sb).trace_kind, 'unknown'); assert.equal(last(sb).missing_reason, 'no_parser_for_file_kind');
  });
});

describe('friction: kill-switch through route()', () => {
  const sb = sandbox('harction-kill-');
  after(() => sb.cleanup());
  beforeEach(newSession);

  it('stays silent under CLAUDE_SKIP_FRICTION=1 and writes nothing to the journal or the state', async () => {
    const repo = mkRepo(sb); write(repo, 'src/a.py', 'x=1\n');
    const id = agent(); const kill = env(sb, { CLAUDE_SKIP_FRICTION: '1' });
    assert.equal((await route('agent-start', payload('SubagentStart', { session_id: session, agent_id: id, agent_type: 'worker' }, repo) as never, kill)).kind, 'silent');
    assert.equal((await route('agent-stop', payload('SubagentStop', { session_id: session, agent_id: id, agent_type: 'worker' }, repo) as never, kill)).kind, 'silent');
    assert.equal(events(sb).length, 0);
    assert.equal(existsSync(join(sb.stateDir, 'harness.db')), false);
  });
});
